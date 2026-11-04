'use strict';
// End-to-end test: start de server en simuleer moderator + spelers via WebSocket.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-'));
const PW = 'testpw';
let server;
let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓', m); else { failed++; console.log('  ✗ FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return new Promise((resolve) => {
    server = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR, ADMIN_PASSWORD: PW, QUESTIONS_FILE: path.join(__dirname, 'questions.test.json') } });
    server.stdout.on('data', (d) => { if (String(d).includes('draait op')) resolve(); });
    server.stderr.on('data', (d) => process.stderr.write(d));
  });
}
const stopServer = () => new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); });

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const c = { ws, last: null, msgs: [], waiters: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'sp') { const reply = () => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'sa', i: m.i })); return c.spDelay ? setTimeout(reply, c.spDelay) : reply(); }
    c.msgs.push(m);
    if (m.t === 'state' || m.t === 'admin') c.last = m;
    c.waiters = c.waiters.filter((w) => { if (w.pred(m)) { w.res(m); return false; } return true; });
  });
  c.open = new Promise((r) => ws.on('open', r));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = (pred, ms = 3000) => new Promise((res, rej) => {
    const hit = c.msgs.slice().reverse().find(pred);
    if (hit && pred.fresh !== true) { /* zoek enkel nieuwe berichten */ }
    c.waiters.push({ pred, res });
    setTimeout(() => rej(new Error('timeout')), ms);
  });
  c.state = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (c.last && pred(c.last)) return c.last; await sleep(20); }
    throw new Error('state-timeout: ' + JSON.stringify(c.last).slice(0, 300));
  };
  return c;
}

async function player(name, token) {
  const c = client();
  await c.open;
  await sleep(50);
  c.send(token ? { t: 'join', token } : { t: 'join', name });
  const j = await c.wait((m) => m.t === 'joined' || m.t === 'error');
  c.joined = j;
  return c;
}

(async () => {
  await startServer();
  console.log('Server gestart op poort', PORT);

  // --- moderator
  const admin = client();
  await admin.open;
  admin.send({ t: 'admin_login', password: 'fout' });
  const bad = await admin.wait((m) => m.t === 'error');
  ok(bad.ctx === 'admin', 'verkeerd wachtwoord wordt geweigerd');
  admin.send({ t: 'cmd', cmd: 'startRound' });
  const noauth = await admin.wait((m) => m.t === 'error');
  ok(/moderator/i.test(noauth.message), 'commando zonder login wordt geweigerd');
  admin.send({ t: 'admin_login', password: PW });
  await admin.wait((m) => m.t === 'admin_ok');
  await admin.state((s) => s.t === 'admin');
  const cmd = (o) => admin.send({ t: 'cmd', ...o });

  // --- spelers
  const an = await player('An');
  const bo = await player('Bo');
  const cy = await player('Cy');
  ok(an.joined.t === 'joined' && bo.joined.t === 'joined', 'spelers kunnen joinen');
  const dup = await player('an');
  ok(dup.joined.t === 'error', 'zelfde naam op ander toestel wordt geweigerd');
  await admin.state((s) => s.players.length === 3);
  ok(true, 'moderator ziet 3 spelers');
  an.send({ t: 'ts', c: Date.now() });
  const tr = await an.wait((m) => m.t === 'tr');
  ok(Math.abs(tr.s - Date.now()) < 500 && typeof tr.c === 'number', 'klok-sync: server antwoordt onmiddellijk met servertijd');

  // --- ronde 1 (paced)
  cmd({ cmd: 'selectRound', index: 0 });
  await an.state((s) => s.roundState === 'ready');
  ok(an.last.roundState === 'ready', 'ronde klaargezet, speler ziet "ready"');
  cmd({ cmd: 'startRound' });
  await an.state((s) => s.questions && s.questions.length === 4);
  const qjson = JSON.stringify(an.last.questions);
  ok(!/"correct"|"answers"|"note"/.test(qjson), 'juiste antwoorden lekken niet naar spelers');
  ok(an.last.endsAt > Date.now() + 14 * 60000 - 2000, 'timer staat op ~15 minuten');

  const q = an.last.questions;
  an.send({ t: 'answer', qid: q[0].id, value: 'Ierland' });                 // juist
  an.send({ t: 'answer', qid: q[1].id, value: '50' });                      // juist (number)
  an.send({ t: 'answer', qid: q[3].id, value: 1 });                         // juist (choice)
  an.send({ t: 'answer', qid: q[2].id, value: 'Tarrawa' });                 // tikfout -> fuzzy juist
  bo.send({ t: 'answer', qid: q[0].id, value: 'Frankrijk' });               // fout
  bo.send({ t: 'answer', qid: q[3].id, value: 0 });                         // fout
  bo.send({ t: 'answer', qid: q[3].id, value: 99 });                        // ongeldig, genegeerd
  cy.send({ t: 'answer', qid: q[1].id, value: '50' });                      // juist
  await sleep(200);
  const a1 = await admin.state((s) => s.fullScores.length === 3);
  const sc = Object.fromEntries(a1.fullScores.map((x) => [x.name, x.total]));
  ok(sc.An === 4, `An heeft 4 punten (auto + fuzzy) -> ${sc.An}`);
  ok(sc.Bo === 0, `Bo heeft 0 punten -> ${sc.Bo}`);
  ok(sc.Cy === 1, `Cy heeft 1 punt -> ${sc.Cy}`);

  // --- scorebord is verborgen voor spelers tot de moderator het toont
  ok(an.last.scoreboard === null, 'scorebord verborgen voor spelers');
  cmd({ cmd: 'scoreboard', on: true });
  await an.state((s) => Array.isArray(s.scoreboard));
  ok(an.last.scoreboard[0].name === 'An' && an.last.scoreboard[0].rank === 1, 'scorebord toont An op #1 na toggle');
  cmd({ cmd: 'scoreboard', on: false });

  // --- manueel overschrijven
  cmd({ cmd: 'mark', pid: bo.joined.id, qid: q[0].id, points: 1 });
  await admin.state((s) => s.fullScores.find((x) => x.name === 'Bo').total === 1);
  ok(true, 'moderator kan een antwoord manueel juist zetten');
  cmd({ cmd: 'mark', pid: bo.joined.id, qid: q[0].id, points: null });
  await admin.state((s) => s.fullScores.find((x) => x.name === 'Bo').total === 0);
  ok(true, 'manuele markering terugzetten naar automatisch');

  // --- reconnect behoudt voortgang
  an.ws.close();
  await sleep(100);
  const an2 = await player(null, an.joined.token);
  const st = await an2.state((s) => s.myAnswers && Object.keys(s.myAnswers).length === 4);
  ok(st.me.name === 'An' && st.myAnswers[q[0].id] === 'Ierland', 'reconnect met token herstelt naam en antwoorden');

  // --- tijd is om
  cmd({ cmd: 'closeRound' });
  await an2.state((s) => s.roundState === 'closed');
  an2.send({ t: 'answer', qid: q[2].id, value: 'x' });
  const nack = await an2.wait((m) => m.t === 'nack');
  ok(nack.reason === 'closed', 'antwoord na sluiting wordt geweigerd');
  cmd({ cmd: 'reveal', roundId: 't1', on: true });
  const rv = await an2.state((s) => s.review);
  ok(rv.review.length === 4 && rv.review[0].points === 1, 'speler ziet review na "antwoorden tonen"');

  // --- ronde 2 (vraag per vraag)
  cmd({ cmd: 'selectRound', index: 1 });
  cmd({ cmd: 'startRound' });
  await an2.state((s) => s.roundState === 'running' && s.roundIndex === 1);
  ok(an2.last.question === null, 'stepped: nog geen vraag zichtbaar voor de start');
  an2.send({ t: 'answer', qid: 't2q1', value: 'Canberra' });
  const nack0 = await an2.wait((m) => m.t === 'nack');
  ok(nack0.reason === 'closed', 'stepped: antwoord vóór de vraag opent wordt geweigerd');
  cmd({ cmd: 'gotoQ', index: 0 });
  const sq = await an2.state((s) => s.question && s.qOpen);
  ok(sq.question.text.includes('Australië') && !JSON.stringify(sq).includes('Canberra'), 'stepped: vraag zichtbaar, antwoord niet gelekt');
  ok(sq.endsAt - Date.now() <= 1500, 'stepped: timer per vraag (1 s in test)');
  an2.send({ t: 'answer', qid: sq.question.id, value: 'canberra' });
  bo.send({ t: 'answer', qid: sq.question.id, value: 'Sydney' });
  bo.send({ t: 'answer', qid: 't2q2', value: 1 });
  await an2.state((s) => !s.qOpen, 4000);
  ok(true, 'stepped: vraag sluit automatisch na de timer');
  an2.send({ t: 'answer', qid: sq.question.id, value: 'te laat' });
  const nack1 = await an2.wait((m) => m.t === 'nack');
  ok(nack1.reason === 'closed', 'stepped: te laat antwoord wordt geweigerd');
  ok(!an2.last.revealAnswer, 'stepped: antwoord pas zichtbaar na "Toon antwoord"');
  cmd({ cmd: 'revealQ' });
  const rev1 = await an2.state((s) => s.qRevealed && s.result);
  ok(rev1.result.points === 1 && rev1.revealAnswer === 'Canberra', 'stepped: speler ziet antwoord en eigen punt na reveal');
  const rev2 = await bo.state((s) => s.qRevealed && s.result);
  ok(rev2.result.points === 0, 'stepped: foute speler krijgt 0');
  cmd({ cmd: 'extend', seconds: 5 });
  await an2.state((s) => s.qOpen && !s.qRevealed);
  ok(true, 'stepped: moderator kan de vraag heropenen (+tijd)');
  cmd({ cmd: 'closeQ' });
  await an2.state((s) => !s.qOpen);

  // --- ronde 3 (buzzer)
  cmd({ cmd: 'selectRound', index: 2 });
  cmd({ cmd: 'startRound' });
  await an2.state((s) => s.roundState === 'running' && s.roundIndex === 2);
  cmd({ cmd: 'gotoQ', index: 0 });
  await an2.state((s) => s.question && s.qIndex === 0);
  bo.send({ t: 'buzz' });
  await sleep(100);
  ok(!an2.last.buzz.lockedByName, 'buzz bij gesloten buzzer telt niet');
  cmd({ cmd: 'openBuzzer' });
  await an2.state((s) => s.buzz.open);
  const early = await an2.state((s) => s.buzz.open);
  ok(early.buzz.openAt > Date.now() + 800, 'buzzer opent op een gepland tijdstip (~1,5 s later)');
  bo.send({ t: 'buzz' });
  await sleep(250);
  ok(!admin.last.buzz.lockedBy, 'te vroeg buzzen (voor het openingstijdstip) telt niet');
  await sleep(Math.max(0, early.buzz.openAt - Date.now()) + 80);
  // drie spelers tegelijk
  an2.send({ t: 'buzz' }); bo.send({ t: 'buzz' }); cy.send({ t: 'buzz' });
  const locked = await admin.state((s) => s.buzz.lockedBy);
  await sleep(150);
  ok(!!locked.buzz.lockedByName, `precies één speler gelockt: ${locked.buzz.lockedByName}`);
  const first = admin.last.buzz.lockedBy;
  ok(admin.last.buzz.lockedBy === first && !admin.last.buzz.open, 'buzzer vergrendelt na eerste buzz');
  cmd({ cmd: 'wrong' });
  await admin.state((s) => s.buzz.open && s.buzz.excluded.length === 1);
  await sleep(1700); // heropening is ook gepland
  ok(true, 'fout antwoord: buzzer heropent, speler uitgesloten');
  first === an2.joined.id ? an2.send({ t: 'buzz' }) : null;
  const others = [an2, bo, cy].filter((c) => c.joined.id !== first);
  others[0].send({ t: 'buzz' });
  const second = await admin.state((s) => s.buzz.lockedBy && s.buzz.lockedBy !== first);
  ok(second.buzz.lockedBy === others[0].joined.id, 'uitgesloten speler kan niet meer, de volgende wel');
  const winner = second.buzz.lockedBy;
  cmd({ cmd: 'correct' });
  await admin.state((s) => s.buzz.winner === winner);
  const pts = admin.last.fullScores.find((x) => x.id === winner).perRound[2];
  ok(pts === 1, `juist antwoord geeft punt aan winnaar (ronde 3 = ${pts})`);

  // --- eerlijke buzzer: trage verbinding (hoge ping) die eerder drukt wint van snelle die later drukt
  cmd({ cmd: 'gotoQ', index: 1 });
  await an2.state((s) => s.qIndex === 1);
  an2.spDelay = 160;
  await sleep(4700);
  const rtt = admin.last.rtt && admin.last.rtt[an2.joined.id];
  ok(rtt >= 100, `server meet de ping van de trage speler (${rtt} ms)`);
  cmd({ cmd: 'openBuzzer' });
  await an2.state((s) => s.buzz.open);
  await sleep(1700); // wacht tot de buzzer echt open is (gepland tijdstip)
  setTimeout(() => an2.send({ t: 'buzz' }), 80);   // echte druk op t=0, komt 80 ms later aan
  setTimeout(() => bo.send({ t: 'buzz' }), 40);    // echte druk op t=40, komt meteen aan
  const lk = await admin.state((s) => s.buzz.lockedBy);
  ok(lk.buzz.lockedBy === an2.joined.id, `latency-compensatie: trage maar eerdere buzz wint (${JSON.stringify(lk.buzz.log)})`);
  ok(lk.buzz.log.length === 2 && lk.buzz.log[0].delta === 0, 'moderator ziet de buzzvolgorde met verschillen');

  // --- persistentie over herstart
  await sleep(400);
  await stopServer();
  await startServer();
  const back = await player(null, bo.joined.token);
  const bs = await back.state((s) => s.me);
  ok(bs.me.name === 'Bo' && bs.roundIndex === 2, 'status en spelers overleven een serverherstart');

  // --- spelerslimiet + lock
  const admin2 = client(); await admin2.open;
  const savedTok = admin.msgs.find((m) => m.t === 'admin_ok').token;
  admin2.send({ t: 'admin_resume', token: savedTok });
  await admin2.state((s) => s.t === 'admin');
  admin2.send({ t: 'cmd', cmd: 'settings', locked: true });
  await sleep(150);
  const late = await player('Dirk');
  ok(late.joined.t === 'error', 'inschrijven kan gesloten worden');

  console.log(failed ? `\n${failed} test(s) mislukt` : '\nAlle tests geslaagd');
  await stopServer();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('Test crashte:', e); try { await stopServer(); } catch (x) { /* */ } process.exit(1); });

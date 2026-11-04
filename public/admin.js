'use strict';
const TOKEN_KEY = 'kerstquiz_admin';
let S = null;
let viewRound = null;      // ronde die in het antwoordenpaneel getoond wordt
let lastRoundIndex = -2;
let onlyReview = false;

const sock = createSocket(onMsg, onStatus);

function onStatus(up) {
  $('#banner').hidden = up;
  if (!up) return;
  const t = localStorage.getItem(TOKEN_KEY);
  if (t) sock.send({ t: 'admin_resume', token: t });
  else showLogin('');
}

function onMsg(m) {
  if (m.t === 'admin_ok') {
    localStorage.setItem(TOKEN_KEY, m.token);
  } else if (m.t === 'admin') {
    S = m; syncClock(m.now);
    $('#login').hidden = true; $('#dash').hidden = false;
    render();
  } else if (m.t === 'error' && m.ctx === 'admin') {
    localStorage.removeItem(TOKEN_KEY);
    showLogin(m.message);
  } else if (m.t === 'error' && m.ctx === 'cmd') {
    alert(m.message);
  }
}

function showLogin(msg) {
  $('#dash').hidden = true; $('#login').hidden = false;
  $('#pwErr').textContent = msg || '';
}
const doLogin = () => sock.send({ t: 'admin_login', password: $('#pw').value });
$('#pwGo').onclick = doLogin;
$('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

/* ------------------------------------------------------- generic buttons */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-cmd]');
  if (el) {
    if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
    const msg = { t: 'cmd', cmd: el.dataset.cmd };
    for (const name of el.getAttributeNames()) {
      const m = name.match(/^data-([nbz])-(.+)$/);
      if (m) {
        const key = m[2].replace(/-(\w)/g, (_, c) => c.toUpperCase());
        const v = el.getAttribute(name);
        msg[key] = m[1] === 'n' ? Number(v) : m[1] === 'b' ? v === 'true' : null;
      } else if (name.startsWith('data-') && !['data-cmd', 'data-confirm'].includes(name)) {
        msg[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = el.getAttribute(name);
      }
    }
    sock.send(msg);
    return;
  }
  const vr = e.target.closest('[data-view-round]');
  if (vr) { viewRound = Number(vr.dataset.viewRound); renderAnswers(); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'onlyRev') { onlyReview = e.target.checked; renderAnswers(); }
});
$('#addPlayer').onclick = () => {
  const v = $('#newPlayer').value.trim();
  if (v) { sock.send({ t: 'cmd', cmd: 'addPlayer', name: v }); $('#newPlayer').value = ''; }
};
$('#newPlayer').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#addPlayer').click(); });
$('#setMax').onclick = () => sock.send({ t: 'cmd', cmd: 'settings', maxPlayers: Number($('#maxPlayers').value) });

/* -------------------------------------------------------------- helpers */

function setHTML(el, html) {
  if (el._h !== html) { el._h = html; el.innerHTML = html; }
}
const curRound = () => (S.roundIndex >= 0 ? S.quiz.rounds[S.roundIndex] : null);
const answered = (pid, q) => { const a = (S.answers[pid] || {})[q.id]; return a !== undefined && String(a).trim() !== ''; };
function answerText(q, v) {
  if (v === undefined || v === null || v === '') return '';
  if (q.type === 'choice') return q.options[Number(v)] || '';
  return String(v);
}
function correctText(q) {
  if (q.type === 'choice') return q.correct !== null ? q.options[q.correct] : '(geen vast antwoord)';
  return q.answers.length ? q.answers.join('  /  ') : '(geen vast antwoord)';
}

/* --------------------------------------------------------------- render */

function render() {
  $('#dTitle').textContent = `🎄 ${S.title}`;
  $('#joinUrl').textContent = location.host;
  if (S.roundIndex !== lastRoundIndex) {
    lastRoundIndex = S.roundIndex;
    if (S.roundIndex >= 0) viewRound = S.roundIndex;
  }
  if (viewRound === null || viewRound >= S.quiz.rounds.length) viewRound = Math.max(0, S.roundIndex);
  setHTML($('#sbBtn'), `<button class="${S.showScoreboard ? 'gold' : ''}" data-cmd="scoreboard" data-b-on="${!S.showScoreboard}">🏆 Scorebord ${S.showScoreboard ? 'verbergen' : 'tonen aan spelers'}</button>`);
  setHTML($('#ctl'), ctlHTML());
  setHTML($('#pl'), playersHTML());
  setHTML($('#sbd'), scoresHTML());
  renderAnswers();
  const mp = $('#maxPlayers');
  if (document.activeElement !== mp) mp.value = S.settings.maxPlayers;
  tick();
}

function ctlHTML() {
  const rounds = S.quiz.rounds;
  const r = curRound();
  const st = S.roundState;
  let h = '<div class="tabs">' + rounds.map((x, i) =>
    `<button class="${i === S.roundIndex ? 'act' : ''}" data-cmd="selectRound" data-n-index="${i}" ${st === 'running' && i !== S.roundIndex ? 'data-confirm="Er is een ronde bezig. Toch wisselen?"' : ''}>${i + 1}. ${esc(x.title)}</button>`
  ).join('') + `<button class="ghost" data-cmd="lobby">Lobby</button></div>`;

  if (!r) return h + `<p class="mute">Lobby: ${S.players.filter((p) => p.online).length} van ${S.players.length} spelers online. Kies een ronde om klaar te zetten.</p>`;

  const badge = { ready: ['klaar', 'ready'], running: ['bezig', 'run'], closed: ['afgelopen', 'closed'] }[st] || ['', ''];
  h += `<div class="row wrap-r" style="margin-bottom:10px"><h2 style="margin:0">Ronde ${S.roundIndex + 1}: ${esc(r.title)}</h2><span class="badge ${badge[1]}">${badge[0]}</span>`;
  if (r.mode === 'paced' && st === 'running') h += '<span class="timer" id="adTimer"></span>';
  h += '</div>';

  if (st === 'ready') {
    h += `<button class="primary" data-cmd="startRound" style="font-size:1.2rem;padding:14px 28px">▶ Start ronde${r.mode === 'paced' ? ` (${r.minutes} min)` : ''}</button>`;
  } else if (r.mode === 'paced') {
    const done = S.players.filter((p) => r.questions.length && r.questions.every((q) => answered(p.id, q))).length;
    if (st === 'running') {
      h += `<p>${done} van ${S.players.length} spelers hebben alles ingevuld.</p>
        <div class="row wrap-r"><button data-cmd="extend" data-n-minutes="1">+1 min</button><button data-cmd="extend" data-n-minutes="5">+5 min</button>
        <button class="bad" data-cmd="closeRound" data-confirm="Ronde nu stoppen?">⏹ Stop ronde</button></div>`;
    } else {
      const rev = !!S.reveal[r.id];
      h += `<p class="mute">Controleer de antwoorden hieronder, toon dan de antwoorden en het scorebord.</p>
        <div class="row wrap-r"><button data-cmd="extend" data-n-minutes="2">⏱ Hervat (+2 min)</button>
        <button class="${rev ? 'gold' : ''}" data-cmd="reveal" data-round-id="${esc(r.id)}" data-b-on="${!rev}">👁 Antwoorden ${rev ? 'verbergen' : 'tonen aan spelers'}</button></div>`;
    }
  } else if (r.mode === 'stepped') {
    h += steppedHTML(r, st);
  } else {
    h += buzzerHTML(r, st);
  }
  return h;
}

function steppedHTML(r, st) {
  if (st === 'closed') return '<p class="mute">Ronde afgelopen.</p>';
  const q = r.questions[S.qIndex];
  let h = '<div class="row wrap-r" style="margin-bottom:10px">' +
    r.questions.map((x, i) => `<button class="sm ${i === S.qIndex ? 'gold' : ''}" data-cmd="gotoQ" data-n-index="${i}">${i + 1}</button>`).join('') + '</div>';
  if (!q) {
    return h + `<button class="primary" data-cmd="gotoQ" data-n-index="0" style="font-size:1.2rem;padding:14px 28px">▶ Start vraag 1</button>
      <button class="bad" data-cmd="closeRound" data-confirm="Ronde stoppen?">⏹ Stop ronde</button>`;
  }
  const done = S.players.filter((p) => answered(p.id, q)).length;
  const status = S.qRevealed ? '👁 Antwoord getoond' : S.qOpen ? '🟢 Vraag open' : '🔴 Vraag gesloten';
  const last = S.qIndex + 1 >= r.questions.length;
  h += `<div class="card" style="background:var(--card2)">
    <div class="small mute">Vraag ${S.qIndex + 1} / ${r.questions.length} · ${fmtPts(q.points)} pt</div>
    <div class="bq">${esc(q.text)}</div>
    ${q.image ? `<img class="qimg" style="max-height:200px" src="${esc(q.image)}" alt="">` : ''}
    <div class="hint" style="margin-top:6px">Antwoord: <b>${esc(correctText(q))}</b></div>
    ${q.note ? `<div class="small mute">${esc(q.note)}</div>` : ''}
    <div class="row wrap-r" style="margin-top:10px;font-size:1.1rem;font-weight:700"><span>${status}</span>${S.qOpen && S.endsAt ? '<span class="timer" id="adTimer"></span>' : ''}<span class="mute small">${done} van ${S.players.length} hebben geantwoord</span></div></div>
    <div class="row wrap-r">
      <button data-cmd="closeQ" ${S.qOpen ? '' : 'disabled'}>⏹ Sluit vraag</button>
      <button data-cmd="extend" data-n-seconds="15">+15 s</button>
      <button class="gold" data-cmd="revealQ" ${S.qRevealed ? 'disabled' : ''}>👁 Toon antwoord</button>
      <button class="primary" data-cmd="gotoQ" data-n-index="${S.qIndex + 1}" ${last ? 'disabled' : ''}>Volgende vraag ▶</button>
      <button class="bad" data-cmd="closeRound" data-confirm="Ronde stoppen?">⏹ Stop ronde</button>
    </div>`;
  return h;
}

function buzzerHTML(r, st) {
  if (st === 'closed') return '<p class="mute">Buzzerronde afgelopen.</p>';
  const q = r.questions[S.qIndex];
  const b = S.buzz;
  let h = '<div class="row wrap-r" style="margin-bottom:10px">' +
    r.questions.map((x, i) => `<button class="sm ${i === S.qIndex ? 'gold' : ''}" data-cmd="gotoQ" data-n-index="${i}">${i + 1}</button>`).join('') + '</div>';
  if (!q) return h + '<p class="mute">Kies een vraag om te starten.</p><button data-cmd="gotoQ" data-n-index="0" class="primary">Start met vraag 1</button> <button class="bad" data-cmd="closeRound" data-confirm="Ronde stoppen?">⏹ Stop ronde</button>';

  const mark = b.winner ? (S.points[b.winner] || {})[q.id] : null;
  let status;
  if (b.lockedByName) status = `<span class="hint">🔔 ${esc(b.lockedByName)} heeft gebuzzed!</span>`;
  else if (b.open) status = b.openAt && serverNow() < b.openAt ? '🟡 Buzzer opent zo…' : '🟢 Buzzer is open';
  else if (b.winnerName) status = `✔ Juist: ${esc(b.winnerName)} (+${fmtPts(q.points)})`;
  else status = '🔴 Buzzer is dicht';
  if (b.excludedNames.length) status += ` <span class="mute small">(fout: ${b.excludedNames.map(esc).join(', ')})</span>`;
  if (b.log && b.log.length) {
    status += `<div class="small mute" style="font-weight:400;margin-top:4px">Volgorde: ${b.log.map((x) => `${esc(x.name)} ${x.delta === 0 ? '(eerst)' : '+' + x.delta + ' ms'} · ping ${x.rtt} ms`).join(' | ')}</div>`;
  }

  h += `<div class="card" style="background:var(--card2)">
    <div class="small mute">Vraag ${S.qIndex + 1} / ${r.questions.length} · ${fmtPts(q.points)} pt</div>
    <div class="bq">${esc(q.text)}</div>
    ${q.image ? `<img class="qimg" style="max-height:200px" src="${esc(q.image)}" alt="">` : ''}
    <div class="hint" style="margin-top:6px">Antwoord: <b>${esc(correctText(q))}</b></div>
    ${q.note ? `<div class="small mute">${esc(q.note)}</div>` : ''}
    <div style="margin-top:10px;font-size:1.2rem;font-weight:700">${status}</div></div>
    <div class="row wrap-r">
      <button class="primary" data-cmd="openBuzzer" ${b.open || b.lockedBy ? 'disabled' : ''}>🔔 Open buzzer</button>
      <button class="ok" data-cmd="correct" ${b.lockedBy ? '' : 'disabled'}>✓ Juist</button>
      <button class="bad" data-cmd="wrong" ${b.lockedBy ? '' : 'disabled'}>✗ Fout</button>
      <button data-cmd="closeBuzzer" ${b.open ? '' : 'disabled'}>Sluit buzzer</button>
      <button class="ghost" data-cmd="resetBuzz">Reset vraag</button>
      <button class="ghost" data-cmd="gotoQ" data-n-index="${S.qIndex + 1}" ${S.qIndex + 1 >= r.questions.length ? 'disabled' : ''}>Volgende vraag ▶</button>
      <button class="bad" data-cmd="closeRound" data-confirm="Ronde stoppen?">⏹ Stop ronde</button>
    </div>`;
  return h;
}

function playersHTML() {
  const r = curRound();
  let h = `<h2>Spelers (${S.players.length}/${S.settings.maxPlayers})</h2>`;
  if (!S.players.length) return h + '<p class="mute">Nog niemand binnen.</p>';
  h += '<table><tr><th>Naam</th><th class="num">Ingevuld</th><th class="num">Ping</th><th class="num">Punten</th><th></th></tr>';
  const total = {}; S.fullScores.forEach((s) => { total[s.id] = s.total; });
  S.players.forEach((p) => {
    const prog = r && r.mode === 'paced' ? `${r.questions.filter((q) => answered(p.id, q)).length}/${r.questions.length}` : '–';
    const rtt = S.rtt && S.rtt[p.id];
    const ping = p.online && rtt != null ? `<span style="color:${rtt > 150 ? 'var(--bad)' : 'var(--mute)'}">${rtt} ms</span>` : '–';
    h += `<tr><td><span class="dot ${p.online ? 'on' : ''}"></span>${esc(p.name)}</td><td class="num">${prog}</td><td class="num">${ping}</td><td class="num">${fmtPts(total[p.id] || 0)}</td>
      <td class="num"><button class="sm ghost" data-cmd="kick" data-pid="${p.id}" data-confirm="${esc(p.name)} verwijderen (incl. antwoorden)?">✕</button></td></tr>`;
  });
  h += '</table>';
  h += `<div style="margin-top:10px"><button class="sm ${S.settings.locked ? 'gold' : ''}" data-cmd="settings" data-b-locked="${!S.settings.locked}">${S.settings.locked ? '🔒 Inschrijven gesloten (klik om te openen)' : '🔓 Inschrijven open (klik om te sluiten)'}</button></div>`;
  return h;
}

function scoresHTML() {
  const rounds = S.quiz.rounds;
  let h = '<h2>Scorebord</h2>';
  if (!S.fullScores.length) return h + '<p class="mute">Nog geen spelers.</p>';
  h += '<table><tr><th>#</th><th>Naam</th>' + rounds.map((_, i) => `<th class="num">R${i + 1}</th>`).join('') + '<th class="num">Totaal</th></tr>';
  S.fullScores.forEach((s) => {
    h += `<tr><td>${s.rank}</td><td><b>${esc(s.name)}</b></td>${s.perRound.map((x) => `<td class="num">${fmtPts(x)}</td>`).join('')}<td class="num"><b>${fmtPts(s.total)}</b></td></tr>`;
  });
  return h + '</table>';
}

function renderAnswers() {
  if (!S) return;
  const rounds = S.quiz.rounds;
  const r = rounds[viewRound];
  if (!r) return;
  let h = `<div class="row wrap-r" style="justify-content:space-between"><h2 style="margin:0">Antwoorden &amp; punten</h2>
    <label><input type="checkbox" id="onlyRev" ${onlyReview ? 'checked' : ''}> Alleen te controleren</label></div>
    <div class="tabs" style="margin-top:10px">${rounds.map((x, i) => `<button class="${i === viewRound ? 'act' : ''}" data-view-round="${i}">${i + 1}. ${esc(x.title)}</button>`).join('')}</div>`;
  if (onlyReview) h += '<p class="small mute">Toont ingevulde tekst/getal-antwoorden die automatisch fout werden gerekend. Klik ✓ als ze toch juist zijn.</p>';

  let shown = 0;
  r.questions.forEach((q, qi) => {
    const rows = [];
    S.players.forEach((p) => {
      const a = (S.answers[p.id] || {})[q.id];
      const pt = (S.points[p.id] || {})[q.id] || { points: 0, source: 'auto' };
      const txt = answerText(q, a);
      if (r.mode === 'buzzer' && pt.source !== 'manual') return;
      if (onlyReview && !(q.type !== 'choice' && txt && pt.source === 'auto' && pt.points === 0)) return;
      const cls = !txt && r.mode !== 'buzzer' ? 'empty' : pt.points > 0 ? 'good' : 'wrong';
      rows.push(`<div class="ans ${cls}"><span class="who">${esc(p.name)}</span><span class="val">${txt ? esc(txt) : r.mode !== 'buzzer' ? 'geen antwoord' : ''}</span>
        <span class="pts">${fmtPts(pt.points)}${pt.source === 'manual' ? '<span class="man"> ✎</span>' : ''}</span>
        <button class="sm ok" data-cmd="mark" data-pid="${p.id}" data-qid="${q.id}" data-n-points="${q.points}">✓</button>
        <button class="sm bad" data-cmd="mark" data-pid="${p.id}" data-qid="${q.id}" data-n-points="0">✗</button>
        <button class="sm ghost" title="terug naar automatisch" data-cmd="mark" data-pid="${p.id}" data-qid="${q.id}" data-z-points="">↺</button></div>`);
    });
    if (onlyReview && !rows.length) return;
    shown++;
    h += `<div class="qa"><div class="qh"><div class="small mute">Vraag ${qi + 1} · ${fmtPts(q.points)} pt</div><b>${esc(q.text)}</b>
      <div class="hint small">Antwoord: ${esc(correctText(q))}</div>${q.note ? `<div class="small mute">${esc(q.note)}</div>` : ''}</div>${rows.join('') || '<div class="ans empty"><span class="val">Geen antwoorden</span></div>'}</div>`;
  });
  if (!shown) h += '<p class="mute">Niets te tonen.</p>';
  setHTML($('#ans'), h);
}

function tick() {
  const el = $('#adTimer');
  if (!el || !S || !S.endsAt) return;
  const left = S.endsAt - serverNow();
  el.textContent = fmtTime(left);
  const r = curRound();
  el.classList.toggle('low', left < (r && r.mode === 'stepped' ? 10000 : 60000));
}
setInterval(tick, 250);

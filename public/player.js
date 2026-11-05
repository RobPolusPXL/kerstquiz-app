'use strict';
const TOKEN_KEY = 'kerstquiz_token';
const app = $('#app');

let S = null;
let screen = { key: null, update() {}, destroy() {} };
let resuming = !!localStorage.getItem(TOKEN_KEY);
let joinError = '';
let localAnswers = {};
let qi = 0;
let curQid = null;
const pending = {};

const sock = createSocket(onMsg, onStatus);
startClockSync(sock);
let lastDiagAt = 0;

function onStatus(up) {
  $('#banner').hidden = up;
  if (up) {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) { resuming = true; sock.send({ t: 'join', token: t }); }
  } else {
    const sv = $('#sv');
    if (sv) sv.textContent = 'Offline: wordt opnieuw verstuurd zodra de verbinding terug is.';
  }
}

function onMsg(m) {
  if (m.t === 'state') {
    checkVersion(m.ver); S = m; syncClock(m.now);
    if (S.me && S.buzz && S.buzz.open && S.buzz.openAt && S.buzz.openAt !== lastDiagAt) {
      lastDiagAt = S.buzz.openAt;
      sock.send({ t: 'diag', openAt: S.buzz.openAt, marge: Math.round(S.buzz.openAt - serverNow()) });
    }
    render();
  }
  else if (m.t === 'joined') {
    localStorage.setItem(TOKEN_KEY, m.token);
    resuming = false; joinError = '';
    keepAwake();
    resendAnswers();
  } else if (m.t === 'error' && m.ctx === 'join') {
    localStorage.removeItem(TOKEN_KEY);
    resuming = false; joinError = m.message;
    render();
  } else if (m.t === 'ack') {
    delete pending[m.qid];
    const sv = $('#sv');
    if (sv && curQid === m.qid) sv.textContent = '✓ Opgeslagen';
  } else if (m.t === 'nack') {
    const sv = $('#sv');
    if (sv) sv.textContent = 'Tijd is om: dit antwoord is niet meer opgeslagen.';
  }
}

async function keepAwake() {
  try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S && S.me) keepAwake(); });

function resendAnswers() {
  if (screen.resend) return screen.resend();
  if (!screen.key || !screen.key.startsWith('paced')) return;
  Object.keys(localAnswers).forEach((qid) => sock.send({ t: 'answer', qid, value: localAnswers[qid] }));
}

/* ------------------------------------------------------------ routing */

function render() {
  if (!S) return;
  let key;
  if (!S.me) key = resuming ? 'resuming' : 'join';
  else if (S.roundIndex < 0) key = 'lobby';
  else {
    const r = S.rounds[S.roundIndex];
    if (S.roundState === 'ready') key = 'ready' + S.roundIndex;
    else if (r.mode === 'paced' && S.roundState === 'running') key = 'paced' + S.roundIndex;
    else if (r.mode === 'buzzer' && S.roundState === 'running') key = 'buzz' + S.roundIndex;
    else if (r.mode === 'stepped' && S.roundState === 'running') key = 'step' + S.roundIndex;
    else key = 'closed' + S.roundIndex + (S.review ? 'r' : '');
  }
  if (key !== screen.key) {
    screen.destroy();
    window.scrollTo(0, 0);
    if (key === 'resuming') screen = simple(() => '<p class="mute center">Verbinden…</p>');
    else if (key === 'join') screen = buildJoin();
    else if (key === 'lobby') screen = simple(lobbyHTML);
    else if (key.startsWith('ready')) screen = simple(readyHTML);
    else if (key.startsWith('paced')) screen = buildPaced();
    else if (key.startsWith('buzz')) screen = buildBuzz();
    else if (key.startsWith('step')) screen = buildStepped();
    else screen = simple(closedHTML);
    screen.key = key;
  }
  screen.update();
}

function simple(fn) {
  return { destroy() {}, update() { app.innerHTML = `<div class="wrap">${fn()}</div>`; } };
}

const head = () => `<h1>🎄 ${esc(S.title)}</h1><p class="mute">Hoi <b>${esc(S.me.name)}</b></p>`;
const sbCard = () => (S.scoreboard ? `<div class="card"><h2>🏆 Tussenstand</h2>${scoreboardHTML(S.scoreboard, S.me.id)}</div>` : '');

function lobbyHTML() {
  return `${head()}<div class="card"><h2>Welkom!</h2><p>De quiz begint zo. Hou dit scherm open.</p>
    <p class="small mute">Ook aan het meedoen:</p>
    <div class="chips">${S.names.map((n) => `<span class="chip" style="cursor:default"><span class="dot ${n.online ? 'on' : ''}"></span>${esc(n.name)}</span>`).join('')}</div></div>${sbCard()}
    <p class="center small"><a href="/ranking" style="color:var(--gold)">Ranking over de jaren</a></p>`;
}

function readyHTML() {
  const r = S.rounds[S.roundIndex];
  return `${head()}<div class="card center"><div class="small mute">Ronde ${S.roundIndex + 1} van ${S.rounds.length}</div>
    <h2>${esc(r.title)}</h2>
    <p>${r.mode === 'buzzer' ? 'Buzzerronde: wie het eerst drukt, mag antwoorden.' : r.mode === 'stepped' ? `${r.count} vragen, vraag per vraag` : `${r.count} vragen · ${r.minutes} minuten`}</p>
    ${r.intro ? `<p class="mute">${esc(r.intro)}</p>` : ''}
    <p class="hint">Even wachten tot de moderator start…</p></div>${sbCard()}`;
}

function closedHTML() {
  const r = S.rounds[S.roundIndex];
  let rev = '';
  if (S.review) {
    rev = `<div class="card"><h2>Jouw antwoorden</h2><ul class="review">${S.review.map((x, i) =>
      `<li><div class="small mute">Vraag ${i + 1}</div><div>${esc(x.text)}</div>
       <div>Jij: <b class="${x.points > 0 ? 'good' : 'no'}">${esc(x.mine) || '(leeg)'}</b> · ${fmtPts(x.points)}/${fmtPts(x.max)} pt</div>
       ${x.points < x.max && x.correct ? `<div class="small mute">Juist antwoord: ${esc(x.correct)}</div>` : ''}</li>`).join('')}</ul></div>`;
  }
  return `${head()}<div class="card center"><h2>${esc(r.title)}</h2><p>${r.mode === 'paced' ? '⏰ Tijd is om!' : 'Deze ronde is afgelopen.'}</p>
    <p class="mute">Wacht op de moderator voor de volgende stap.</p></div>${rev}${sbCard()}`;
}

/* --------------------------------------------------------------- join */

function buildJoin() {
  app.innerHTML = `<div class="wrap"><h1>🎄 ${esc(S.title)}</h1>
    <div class="card"><h2>Wie ben jij?</h2>
      <div id="chips" class="chips"></div>
      <div id="newName">
        <p class="mute small">Staat je naam er niet bij? Typ ze hieronder.</p>
        <input id="nm" placeholder="Jouw naam" maxlength="24" autocomplete="off"><br><br>
        <button class="primary" id="go" style="width:100%">Meedoen</button>
      </div>
      <div class="err" id="err"></div>
    </div></div>`;
  const join = (name) => { joinError = ''; $('#err').textContent = ''; sock.send({ t: 'join', name }); };
  $('#go').onclick = () => join($('#nm').value);
  $('#nm').addEventListener('keydown', (e) => { if (e.key === 'Enter') join($('#nm').value); });
  $('#chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (c && !c.classList.contains('off')) join(c.dataset.name);
  });
  return {
    destroy() {},
    update() {
      $('#chips').innerHTML = S.names.map((n) =>
        `<span class="chip ${n.online ? 'off' : ''}" data-name="${esc(n.name)}"><span class="dot ${n.online ? 'on' : ''}"></span>${esc(n.name)}</span>`).join('');
      $('#newName').hidden = S.settings.locked || S.settings.full;
      const msg = joinError || (S.settings.locked ? 'Inschrijven is gesloten. Kies je naam hierboven.' : S.settings.full ? 'De quiz zit vol. Kies je naam hierboven.' : '');
      $('#err').textContent = msg;
    }
  };
}

/* -------------------------------------------------------------- paced */

function buildPaced() {
  const r = S.rounds[S.roundIndex];
  const qs = S.questions;
  localAnswers = Object.assign({}, S.myAnswers);
  const isDone = (q) => localAnswers[q.id] !== undefined && String(localAnswers[q.id]).trim() !== '';
  qi = Math.max(0, qs.findIndex((q) => !isDone(q)));
  const timers = {};

  app.innerHTML = `<div class="wrap">
    <div class="head">
      <div class="row"><div class="grow"><div class="eyebrow">Ronde ${S.roundIndex + 1} · ${esc(r.title)}</div><div class="pname">${esc(S.me.name)}</div></div><div class="pill" id="pill">${ICON_CLOCK}<span class="timer" id="tm"></span></div></div>
      <div class="tbar"><i id="tbar"></i></div>
      <div class="qlab" id="qlab"></div>
      <div class="segs" id="dots"></div><div id="allset"></div>
    </div>
    <div class="card" id="qc"></div>
    <div class="nav"><button id="prev">◀ Vorige</button><button id="next" class="primary">Volgende ▶</button></div>
    <div id="rank"></div>
  </div>`;

  const send = (qid, immediate) => {
    clearTimeout(timers[qid]);
    const go = () => {
      pending[qid] = true;
      const sv = $('#sv');
      if (sv && curQid === qid) sv.textContent = 'Opslaan…';
      if (!sock.send({ t: 'answer', qid, value: localAnswers[qid] }) && sv) sv.textContent = 'Offline: wordt opnieuw verstuurd.';
    };
    if (immediate) go(); else timers[qid] = setTimeout(go, 350);
  };

  function dots() {
    $('#dots').innerHTML = segsHTML(qs.length, qi, (i) => isDone(qs[i]), true);
    $('#qlab').textContent = `Vraag ${qi + 1} van ${qs.length}${qs[qi].points !== 1 ? ` · ${fmtPts(qs[qi].points)} punten` : ''}`;
    const all = qs.every(isDone);
    $('#allset').innerHTML = all ? '<div class="allset">✓ Alles ingevuld! Je kan nog aanpassen tot de tijd om is.</div>' : '';
    $('#next').textContent = qi === qs.length - 1 ? 'Klaar ✓' : 'Volgende ▶';
    $('#prev').disabled = qi === 0;
  }

  function question() {
    const q = qs[qi];
    curQid = q.id;
    const val = localAnswers[q.id];
    let h = `<div class="qtext">${esc(q.text)}</div>`;
    if (q.image) h += `<img class="qimg" src="${esc(q.image)}" alt="">`;
    if (q.type === 'choice') {
      h += '<div class="opts">' + q.options.map((o, i) => `<button class="opt ${val !== undefined && Number(val) === i ? 'sel' : ''}" data-i="${i}">${esc(o)}</button>`).join('') + '</div>';
    } else {
      h += `<input id="inp" type="text" ${q.type === 'number' ? 'inputmode="decimal"' : ''} autocomplete="off" autocapitalize="sentences" placeholder="Jouw antwoord" value="${esc(val == null ? '' : val)}">`;
    }
    h += `<div class="saved" id="sv">${pending[q.id] ? 'Opslaan…' : isDone(q) ? '✓ Opgeslagen' : ''}</div>`;
    $('#qc').innerHTML = h;
    const inp = $('#inp');
    if (inp) {
      inp.addEventListener('input', () => { localAnswers[q.id] = inp.value; dots(); send(q.id, false); });
      inp.addEventListener('blur', () => { if (localAnswers[q.id] !== undefined) send(q.id, true); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { inp.blur(); go(1); } });
    }
    $$('.opt', $('#qc')).forEach((b) => b.addEventListener('click', () => {
      localAnswers[q.id] = Number(b.dataset.i);
      send(q.id, true);
      question(); dots();
    }));
    dots();
  }

  function go(d) {
    const ni = qi + d;
    if (ni >= 0 && ni < qs.length) { qi = ni; question(); window.scrollTo(0, 0); }
    else if (d > 0) {
      const first = qs.findIndex((q) => !isDone(q));
      if (first >= 0) { qi = first; question(); window.scrollTo(0, 0); } else dots();
    }
  }
  $('#prev').onclick = () => go(-1);
  $('#next').onclick = () => go(1);
  $('#dots').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { qi = Number(b.dataset.i); question(); }
  });

  const tm = $('#tm');
  let tTotal = (r.minutes || 0) * 60000;
  const tick = () => {
    if (!S || !S.endsAt) { tm.textContent = ''; return; }
    const left = S.endsAt - serverNow();
    tm.textContent = fmtTime(left);
    tm.classList.toggle('low', left < 60000);
    $('#pill').classList.toggle('low', left < 60000);
    if (left > tTotal) tTotal = left;
    $('#tbar').style.width = (tTotal > 0 ? Math.min(100, Math.max(0, left / tTotal * 100)) : 0) + '%';
    $('#rank').innerHTML = myRankHTML(S.scoreboard, S.me.id);
  };
  const iv = setInterval(tick, 250);

  question();
  return {
    destroy() { clearInterval(iv); Object.values(timers).forEach(clearTimeout); },
    update() { tick(); }
  };
}

/* ------------------------------------------------------------- buzzer */

function buildBuzz() {
  app.innerHTML = `<div class="wrap">
    <div class="head"><div class="row"><div class="grow"><div class="eyebrow" id="bh0"></div><div class="pname">${esc(S.me.name)}</div></div><div class="pill plain" id="bh"></div></div></div>
    <div class="card"><div class="qtext" id="bq"></div><img id="bi" class="qimg" hidden alt=""></div>
    <div class="buzzwrap"><div class="halo"><button class="buzz" id="bz"></button></div><div class="bigstatus" id="bs"></div></div>
    <div id="bsb" style="margin-top:18px"></div></div>`;
  let active = false, waitT = null;
  const press = () => {
    if (!active) return;
    sock.send({ t: 'buzz' });
    if (navigator.vibrate) navigator.vibrate(40);
    active = false;
    $('#bz').className = 'buzz other';
    $('#bz').textContent = '…';
  };
  $('#bz').addEventListener('pointerdown', (e) => { e.preventDefault(); press(); });
  $('#bz').addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); press(); } });

  return {
    destroy() { clearTimeout(waitT); },
    update() {
      clearTimeout(waitT);
      const b = S.buzz, q = S.question;
      $('#bh0').textContent = `Ronde ${S.roundIndex + 1} · ${S.rounds[S.roundIndex].title}`;
      $('#bh').textContent = q ? `Vraag ${S.qIndex + 1} van ${S.qCount}` : 'Zet je schrap';
      $('#bq').textContent = q ? q.text : 'De eerste vraag komt eraan…';
      const img = $('#bi');
      if (q && q.image) { img.src = q.image; img.hidden = false; } else img.hidden = true;
      let cls = 'buzz', label, status;
      active = false;
      if (!q) { label = '⏳'; status = 'Wacht op de moderator'; }
      else if (b.lockedByMe) { cls += ' me'; label = 'JIJ!'; status = 'Jij was eerst! Geef je antwoord.'; }
      else if (b.lockedByName) { cls += ' other'; label = '🔒'; status = `${b.lockedByName} was eerst`; }
      else if (b.open && b.excludedMe) { label = '✋'; status = 'Fout, de anderen mogen nu.'; }
      else if (b.open && b.openAt && serverNow() < b.openAt) {
        cls += ' wait'; label = 'KLAAR…'; status = 'Maak je klaar';
        waitT = setTimeout(() => { if (screen.key && screen.key.startsWith('buzz')) screen.update(); }, Math.max(0, b.openAt - serverNow()));
      }
      else if (b.open) { cls += ' live'; label = 'BUZZ!'; status = ''; active = true; }
      else if (b.winnerName) { cls += b.winnerMe ? ' me' : ''; label = b.winnerMe ? '🎉' : '✔'; status = b.winnerMe ? 'Juist! Punt voor jou!' : `Juist! Punt voor ${b.winnerName}`; }
      else { label = '⏳'; status = 'Wacht tot de buzzer opent'; }
      const btn = $('#bz');
      btn.className = cls;
      btn.textContent = label;
      $('#bs').textContent = status;
      $('#bsb').innerHTML = S.scoreboard ? `<div class="card"><h2>${ICON_TROPHY} Tussenstand</h2>${scoreboardHTML(S.scoreboard, S.me.id)}</div>` : '';
    }
  };
}

/* -------------------------------------------------- vraag per vraag */

function buildStepped() {
  app.innerHTML = `<div class="wrap">
    <div class="head"><div class="row"><div class="grow"><div class="eyebrow" id="sh"></div><div class="pname">${esc(S.me.name)}</div></div><div class="pill" id="pill">${ICON_CLOCK}<span class="timer" id="tm"></span></div></div>
      <div class="tbar"><i id="tbar"></i></div><div class="qlab" id="qlab"></div><div class="segs" id="segs"></div></div>
    <div class="card" id="qc"></div><div id="res"></div><div id="rank"></div><div id="ssb"></div></div>`;
  const tm = $('#tm');
  let key = null, curQ = null, myVal, dirty = false, saveTimer = null;

  const sendNow = () => {
    clearTimeout(saveTimer);
    if (!curQ || myVal === undefined) return;
    dirty = false;
    pending[curQ.id] = true;
    const sv = $('#sv');
    if (sv && curQid === curQ.id) sv.textContent = 'Opslaan…';
    if (!sock.send({ t: 'answer', qid: curQ.id, value: myVal }) && sv) sv.textContent = 'Offline: wordt opnieuw verstuurd.';
  };

  function card() {
    const q = curQ, open = !!S.qOpen;
    curQid = q.id;
    let h = `<div class="qtext">${esc(q.text)}</div>`;
    if (q.image) h += `<img class="qimg" src="${esc(q.image)}" alt="">`;
    if (q.type === 'choice') {
      h += '<div class="opts">' + q.options.map((o, i) => `<button class="opt ${myVal !== undefined && Number(myVal) === i ? 'sel' : ''}" data-i="${i}" ${open ? '' : 'disabled'}>${esc(o)}</button>`).join('') + '</div>';
    } else {
      h += `<input id="inp" type="text" ${q.type === 'number' ? 'inputmode="decimal"' : ''} autocomplete="off" autocapitalize="sentences" placeholder="Jouw antwoord" value="${esc(myVal == null ? '' : myVal)}" ${open ? '' : 'disabled'}>`;
    }
    h += `<div class="saved" id="sv">${pending[q.id] ? 'Opslaan…' : myVal !== undefined && myVal !== '' ? '✓ Opgeslagen' : ''}</div>`;
    $('#qc').innerHTML = h;
    const inp = $('#inp');
    if (inp) {
      inp.addEventListener('input', () => { myVal = inp.value; dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(sendNow, 300); });
      inp.addEventListener('blur', () => { if (dirty) sendNow(); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      if (open && !myVal) inp.focus({ preventScroll: true });
    }
    $$('.opt', $('#qc')).forEach((b) => b.addEventListener('click', () => {
      myVal = Number(b.dataset.i);
      sendNow();
      card();
    }));
  }

  let tTotal = 0, tKey = '';
  const tick = () => {
    const pill = $('#pill'), bar = $('#tbar');
    if (S && S.qOpen && S.endsAt) {
      const left = S.endsAt - serverNow();
      const k = S.roundIndex + ':' + S.qIndex;
      if (k !== tKey) { tKey = k; tTotal = left; }
      if (left > tTotal) tTotal = left;
      tm.textContent = fmtTime(left);
      tm.classList.toggle('low', left < 10000);
      pill.classList.toggle('low', left < 10000);
      pill.hidden = false;
      bar.style.width = (tTotal > 0 ? Math.min(100, Math.max(0, left / tTotal * 100)) : 0) + '%';
    } else { tm.textContent = ''; tm.classList.remove('low'); pill.hidden = true; bar.style.width = '0%'; }
  };
  const iv = setInterval(tick, 250);

  return {
    destroy() { clearInterval(iv); clearTimeout(saveTimer); },
    resend() { if (curQ && S.qOpen && myVal !== undefined) sendNow(); },
    update() {
      const q = S.question;
      $('#sh').textContent = `Ronde ${S.roundIndex + 1} · ${S.rounds[S.roundIndex].title}`;
      $('#segs').innerHTML = segsHTML(S.qCount || 0, q ? S.qIndex : -1, (i) => i < S.qIndex, false);
      $('#qlab').textContent = q ? `Vraag ${S.qIndex + 1} van ${S.qCount}${q.points !== 1 ? ` · ${fmtPts(q.points)} punten` : ''}` : '';
      if (!q) {
        key = null; curQ = null;
        $('#qc').innerHTML = '<div class="qtext center">De eerste vraag komt eraan…</div>';
        $('#res').innerHTML = '';
        tick();
        return;
      }
      const k = q.id + '|' + !!S.qOpen + '|' + !!S.qRevealed;
      if (k !== key) {
        if (dirty) sendNow();
        if (!curQ || curQ.id !== q.id) { myVal = S.myAnswer; dirty = false; }
        key = k; curQ = q;
        card();
      }
      let res = '';
      if (S.qRevealed && S.result) {
        const r = S.result, good = r.points > 0;
        res = `<div class="card result ${good ? 'good' : 'bad'}"><div class="ricon">${good ? ICON_CHECK : ICON_CROSS}</div>
          <div class="rtitle">${good ? 'Juist!' : 'Helaas'}</div>
          <div class="rans">Antwoord: <b>${esc(S.revealAnswer)}</b></div>
          <div class="rpts">${good ? '+' + fmtPts(r.points) + (r.points === 1 ? ' punt' : ' punten') : '0 / ' + fmtPts(r.max) + ' punt'}</div>
          <div class="rmine">${r.mine ? 'Jij: ' + esc(r.mine) : 'Je vulde niets in.'}</div></div>`;
      } else if (!S.qOpen) {
        res = '<div class="card center"><div class="rtitle" style="font-size:1.6rem">Tijd is om!</div><p class="mute">Wacht op het juiste antwoord…</p></div>';
      }
      const rh = res + (S.scoreboard ? `<div class="card"><h2>${ICON_TROPHY} Tussenstand</h2>${scoreboardHTML(S.scoreboard, S.me.id)}</div>` : '');
      if ($('#res')._h !== rh) { $('#res')._h = rh; $('#res').innerHTML = rh; }
      tick();
    }
  };
}

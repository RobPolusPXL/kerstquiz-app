'use strict';
const root = $('#root');
let S = null;

const sock = createSocket((m) => {
  if (m.t === 'state') { checkVersion(m.ver); S = m; syncClock(m.now); render(); }
}, (up) => {
  $('#banner').hidden = up;
  if (up) sock.send({ t: 'hello', role: 'tv' });
});

let last = '';
let tvWait = null;
function set(html) { if (html !== last) { last = html; root.innerHTML = html; } tick(); }

function render() {
  if (!S) return;
  const r = S.roundIndex >= 0 ? S.rounds[S.roundIndex] : null;

  // Scorebord heeft altijd voorrang als de moderator het toont.
  if (S.showScoreboard && S.scoreboard && !(r && r.mode === 'buzzer' && S.roundState === 'running' && S.buzz && (S.buzz.open || S.buzz.lockedByName)) && !(r && r.mode === 'stepped' && S.roundState === 'running' && S.qOpen)) {
    const sb = S.scoreboard.slice(0, 10);
    return set(`<h1>🏆 Tussenstand</h1>${sb.length >= 3 ? podiumHTML(sb) : `<div class="sbtv">${scoreboardHTML(sb, null)}</div>`}`);
  }

  if (!r) {
    return set(`<h1>🎄 ${esc(S.title)}</h1><div class="sub">Doe mee op je gsm</div><div class="url">${esc(location.host)}</div>
      <div class="names">${S.names.map((n) => `<span>${esc(n.name)}</span>`).join('')}</div>`);
  }

  if (S.roundState === 'ready') {
    return set(`<div class="sub">Ronde ${S.roundIndex + 1} van ${S.rounds.length}</div><h1>${esc(r.title)}</h1>
      <div class="sub">${r.mode === 'buzzer' ? 'Wie het eerst buzzt, mag antwoorden' : r.mode === 'stepped' ? `${r.count} vragen, vraag per vraag` : `${r.count} vragen · ${r.minutes} minuten`}</div>`);
  }

  if (r.mode === 'paced' && S.roundState === 'running') {
    const p = S.progress || { done: 0, total: 0 };
    return set(`<div class="tvq"><div class="tvhead"><span class="eyebrow">Ronde ${S.roundIndex + 1} · ${esc(r.title)}</span></div>
      <div class="tvmain center-main">${ringHTML('t')}</div>${barHTML(`${p.done} van ${p.total} spelers zijn klaar`, p)}</div>`);
  }

  if (r.mode === 'stepped' && S.roundState === 'running') {
    const q = S.question;
    if (!q) return set(`<div class="sub">${esc(r.title)}</div><h1>Zet je schrap…</h1>`);
    const p = S.progress || { done: 0, total: 0 };
    let side;
    if (S.qRevealed) side = `<div class="answerbox"><div class="sub">Antwoord</div><div class="who">${esc(S.revealAnswer)}</div></div>`;
    else if (S.qOpen) side = ringHTML('s');
    else side = '<div class="answerbox"><div class="who" style="color:var(--gold)">Tijd is om!</div></div>';
    return set(`<div class="tvq"><div class="tvhead"><span class="eyebrow">Ronde ${S.roundIndex + 1} · ${esc(r.title)}</span><span class="pill">Vraag <b>${S.qIndex + 1}</b> van ${S.qCount}</span></div>
      <div class="tvmain"><div class="q">${esc(q.text)}${q.image ? `<img src="${esc(q.image)}" alt="">` : ''}</div>${side}</div>
      ${S.qRevealed || !S.qOpen ? '' : barHTML(`${p.done} van ${p.total} hebben geantwoord`, p)}</div>`);
  }

  if (r.mode === 'buzzer' && S.roundState === 'running') {
    const q = S.question, b = S.buzz;
    if (!q) return set(`<div class="sub">${esc(r.title)}</div><h1>Zet je schrap…</h1>`);
    let status;
    if (b.lockedByName) status = `<div class="sub">Eerst gebuzzed:</div><div class="who">${esc(b.lockedByName)}</div>`;
    else if (b.open && b.openAt && serverNow() < b.openAt) {
      status = '<div class="who" style="color:var(--gold)">Klaar…</div>';
      clearTimeout(tvWait); tvWait = setTimeout(render, Math.max(0, b.openAt - serverNow()) + 10);
    }
    else if (b.open) status = '<div class="who" style="color:var(--gold)">🔔 BUZZ!</div>';
    else if (b.winnerName) status = `<div class="who">✔ ${esc(b.winnerName)}</div>`;
    else status = '<div class="sub">Even luisteren…</div>';
    return set(`<div class="tvhead" style="width:100%"><span class="eyebrow">Ronde ${S.roundIndex + 1} · ${esc(r.title)}</span><span class="pill">Vraag <b>${S.qIndex + 1}</b> van ${S.qCount}</span></div><div class="q">${esc(q.text)}</div>
      ${q.image ? `<img src="${esc(q.image)}" alt="">` : ''}${status}
      ${b.excludedNames.length ? `<div class="sub">Fout: ${b.excludedNames.map(esc).join(', ')}</div>` : ''}`);
  }

  return set(`<div class="sub">${esc(r.title)}</div><h1>${r.mode === 'paced' ? '⏰ Tijd is om!' : 'Ronde afgelopen'}</h1>`);
}

function barHTML(label, p) {
  const f = p.total ? Math.round(p.done / p.total * 100) : 0;
  return `<div class="tvbar"><span>${label}</span><div class="bar"><i style="width:${f}%"></i></div></div>`;
}
const RING_R = 54, RING_C = 2 * Math.PI * RING_R;
function ringHTML(fmt) {
  return `<div class="ring" data-fmt="${fmt}"><svg viewBox="0 0 128 128" aria-hidden="true"><circle cx="64" cy="64" r="${RING_R}" class="rbg"/><circle cx="64" cy="64" r="${RING_R}" class="rfg" id="tvRing" stroke-dasharray="${RING_C}" stroke-dashoffset="0" transform="rotate(-90 64 64)"/></svg><div class="rtxt"><span id="tvTimer"></span>${fmt === 's' ? '<small>seconden</small>' : ''}</div></div>`;
}
function podiumHTML(rows) {
  const col = (r, cls) => `<div class="pcol ${cls}"><div class="pname">${esc(r.name)}</div><div class="ppts">${fmtPts(r.total)} pt</div><div class="pbar"><span>${r.rank}</span></div></div>`;
  return `<div class="podium">${col(rows[1], 'p2')}${col(rows[0], 'p1')}${col(rows[2], 'p3')}</div>`
    + (rows.length > 3 ? `<div class="names">${rows.slice(3).map((r) => `<span>${r.rank}. ${esc(r.name)} · ${fmtPts(r.total)}</span>`).join('')}</div>` : '');
}
let ringTotal = 0, ringKey = '';
function tick() {
  const el = $('#tvTimer');
  if (!el || !S || !S.endsAt) return;
  const left = S.endsAt - serverNow();
  el.textContent = $('.ring[data-fmt="s"]') ? String(Math.ceil(Math.max(0, left) / 1000)) : fmtTime(left);
  const ring = $('#tvRing');
  if (ring) {
    const key = S.roundIndex + ':' + S.qIndex;
    if (key !== ringKey) { ringKey = key; ringTotal = left; }
    if (left > ringTotal) ringTotal = left;
    const f = ringTotal > 0 ? Math.min(1, Math.max(0, left / ringTotal)) : 0;
    ring.setAttribute('stroke-dashoffset', String(RING_C * (1 - f)));
    ring.classList.toggle('low', left <= 5000);
  }
}
setInterval(tick, 250);

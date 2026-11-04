'use strict';
const root = $('#root');
let S = null;

const sock = createSocket((m) => {
  if (m.t === 'state') { S = m; syncClock(m.now); render(); }
}, (up) => {
  $('#banner').hidden = up;
  if (up) sock.send({ t: 'hello', role: 'tv' });
});

let last = '';
function set(html) { if (html !== last) { last = html; root.innerHTML = html; } tick(); }

function render() {
  if (!S) return;
  const r = S.roundIndex >= 0 ? S.rounds[S.roundIndex] : null;

  // Scorebord heeft altijd voorrang als de moderator het toont.
  if (S.showScoreboard && S.scoreboard && !(r && r.mode === 'buzzer' && S.roundState === 'running' && S.buzz && (S.buzz.open || S.buzz.lockedByName))) {
    return set(`<h1>🏆 Tussenstand</h1><div class="sbtv">${scoreboardHTML(S.scoreboard.slice(0, 10), null)}</div>`);
  }

  if (!r) {
    return set(`<h1>🎄 ${esc(S.title)}</h1><div class="sub">Doe mee op je gsm</div><div class="url">${esc(location.host)}</div>
      <div class="names">${S.names.map((n) => `<span>${esc(n.name)}</span>`).join('')}</div>`);
  }

  if (S.roundState === 'ready') {
    return set(`<div class="sub">Ronde ${S.roundIndex + 1} van ${S.rounds.length}</div><h1>${esc(r.title)}</h1>
      <div class="sub">${r.mode === 'buzzer' ? 'Wie het eerst buzzt, mag antwoorden' : `${r.count} vragen · ${r.minutes} minuten`}</div>`);
  }

  if (r.mode === 'paced' && S.roundState === 'running') {
    const p = S.progress || { done: 0, total: 0 };
    return set(`<div class="sub">${esc(r.title)}</div><div class="big" id="tvTimer"></div>
      <div class="sub">${p.done} van ${p.total} spelers zijn klaar</div>`);
  }

  if (r.mode === 'buzzer' && S.roundState === 'running') {
    const q = S.question, b = S.buzz;
    if (!q) return set(`<div class="sub">${esc(r.title)}</div><h1>Zet je schrap…</h1>`);
    let status;
    if (b.lockedByName) status = `<div class="sub">Eerst gebuzzed:</div><div class="who">${esc(b.lockedByName)}</div>`;
    else if (b.open) status = '<div class="who" style="color:var(--gold)">🔔 BUZZ!</div>';
    else if (b.winnerName) status = `<div class="who">✔ ${esc(b.winnerName)}</div>`;
    else status = '<div class="sub">Even luisteren…</div>';
    return set(`<div class="sub">Vraag ${S.qIndex + 1} / ${S.qCount}</div><div class="q">${esc(q.text)}</div>
      ${q.image ? `<img src="${esc(q.image)}" alt="">` : ''}${status}
      ${b.excludedNames.length ? `<div class="sub">Fout: ${b.excludedNames.map(esc).join(', ')}</div>` : ''}`);
  }

  return set(`<div class="sub">${esc(r.title)}</div><h1>${r.mode === 'paced' ? '⏰ Tijd is om!' : 'Ronde afgelopen'}</h1>`);
}

function tick() {
  const el = $('#tvTimer');
  if (!el || !S || !S.endsAt) return;
  el.textContent = fmtTime(S.endsAt - serverNow());
}
setInterval(tick, 250);

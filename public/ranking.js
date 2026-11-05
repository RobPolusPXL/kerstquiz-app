'use strict';
// Algemene ranking over alle bewaarde jaren (data komt uit /api/ranking).
const app = $('#app');
fetch('/api/ranking').then((r) => r.json()).then((d) => {
  const years = d.years;
  let body;
  if (!d.players.length) {
    body = '<p class="mute">Nog geen standen bewaard. De stand wordt bijgehouden vanaf 2026; van 2025 bestaat hij niet meer.</p>';
  } else {
    body = `<div class="rk-scroll"><table class="rk-table"><thead><tr><th>#</th><th>Naam</th>${years.map((y) => `<th class="num">${y}</th>`).join('')}<th class="num">Totaal</th><th class="num">Winst</th></tr></thead><tbody>` +
      d.players.map((p) => `<tr><td><span class="rk-badge r${p.rank <= 3 ? p.rank : 0}">${p.rank}</span></td><td class="rk-name">${esc(p.name)}</td>` +
        years.map((y) => { const e = p.years[y]; return `<td class="num">${e ? `${fmtPts(e.total)}<small> (${e.rank}e)</small>` : '<span class="mute">–</span>'}</td>`; }).join('') +
        `<td class="num rk-total">${fmtPts(p.total)}</td><td class="num">${p.wins ? p.wins + '×' : '–'}</td></tr>`).join('') + '</tbody></table></div>' +
      '<p class="small mute" style="margin-top:12px">Gerangschikt op totaal aantal punten over alle jaren. "Winst" = aantal keer eerste in een jaar. De stand van 2025 wordt niet bijgehouden.</p>';
  }
  app.innerHTML = `<div class="wrap"><h1>🏆 Ranking over de jaren</h1><div class="card">${body}</div><p class="center small"><a href="/" style="color:var(--gold)">← Terug naar de quiz</a></p></div>`;
}).catch(() => { app.innerHTML = '<div class="wrap"><p class="err">Ranking laden mislukt.</p></div>'; });

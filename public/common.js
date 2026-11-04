'use strict';
// Herlaadt de pagina automatisch als de server een nieuwe versie van de app draait; toont een klein versienummer.
let loadedVer = null;
function checkVersion(ver) {
  if (!ver) return;
  if (loadedVer === null) {
    loadedVer = ver;
    const el = document.createElement('div');
    el.textContent = 'v' + ver;
    el.style.cssText = 'position:fixed;left:6px;bottom:4px;font-size:10px;opacity:.35;pointer-events:none;z-index:5';
    document.body.appendChild(el);
  } else if (loadedVer !== ver) {
    location.reload();
  }
}

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let clockOffset = 0;
let havePingClock = false;
const clockSamples = [];
// Grove schatting uit een state-bericht, tot er nauwkeurige ping-metingen zijn.
const syncClock = (serverTs) => { if (!havePingClock) clockOffset = serverTs - Date.now(); };
// NTP-achtige meting: c0 = verzendtijd (client), s = servertijd bij antwoord, c1 = ontvangsttijd (client).
// De sample met de laagste round-trip heeft de kleinste fout (maximaal rtt/2), dus die gebruiken we.
let clockErr = null;
function clockSample(c0, s, c1) {
  const rtt = c1 - c0;
  if (rtt < 0 || rtt > 3000) return;
  clockSamples.push({ rtt, off: s + rtt / 2 - c1 });
  if (clockSamples.length > 25) clockSamples.shift();
  let best = clockSamples[0];
  for (const x of clockSamples) if (x.rtt < best.rtt) best = x;
  clockOffset = best.off;
  clockErr = best.rtt / 2;
  havePingClock = true;
}
const serverNow = () => Date.now() + clockOffset;
const fmtTime = (ms) => {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};
const fmtPts = (n) => (Math.round(n * 100) / 100).toString().replace('.', ',');

// Spelers meten continu hun klokverschil met de server (4x per seconde) en melden de nauwkeurigheid.
function startClockSync(sock) {
  setInterval(() => sock.send({ t: 'ts', c: Date.now() }), 250);
  setInterval(() => { if (clockErr != null) sock.send({ t: 'clk', err: Math.round(clockErr) }); }, 2000);
}

function createSocket(onMsg, onStatus) {
  let ws, retry = 0;
  const api = {
    send(o) {
      if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; }
      return false;
    }
  };
  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { retry = 0; onStatus(true); };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.t === 'sp') { ws.send('{"t":"sa","i":' + m.i + '}'); return; }
        if (m.t === 'tr') { clockSample(m.c, m.s, Date.now()); return; }
        onMsg(m);
      } catch (err) { console.error(err); }
    };
    ws.onclose = () => { onStatus(false); setTimeout(open, Math.min(4000, 400 + retry++ * 400)); };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  }
  open();
  return api;
}

const ICON_CLOCK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/></svg>';
const ICON_CHECK = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_CROSS = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_TROPHY = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4h8v5a4 4 0 0 1-8 0V4zM8 6H4v1a3 3 0 0 0 4 2.8M16 6h4v1a3 3 0 0 1-4 2.8M12 13v4M8 20h8M10 17h4"/></svg>';
// "Jij staat 3e / 14 pt" voor onderaan de spelersschermen
function myRankHTML(rows, meId) {
  const me = rows && rows.find((r) => r.id === meId);
  if (!me) return '';
  return `<div class="myrank"><span class="mr-l">${ICON_TROPHY}<span>Jij staat ${me.rank}e</span></span><span class="mr-p">${fmtPts(me.total)} pt</span></div>`;
}
// Segmentbalk: done / cur / todo per vraag
function segsHTML(n, curIdx, isDone, clickable) {
  let h = '';
  for (let i = 0; i < n; i++) {
    const c = i === curIdx ? 'cur' : isDone(i) ? 'done' : '';
    h += clickable ? `<button class="seg ${c}" data-i="${i}" aria-label="Vraag ${i + 1}"></button>` : `<span class="seg ${c}"></span>`;
  }
  return h;
}
function scoreboardHTML(rows, meId) {
  if (!rows || !rows.length) return '<p class="mute">Nog geen spelers.</p>';
  return '<ol class="sb" style="list-style:none">' + rows.map((r) =>
    `<li class="${r.id === meId ? 'me' : ''}"><span class="rk">${r.rank}</span><span class="nm">${esc(r.name)}${r.id === meId ? ' (jij)' : ''}</span><span class="pt">${fmtPts(r.total)}</span></li>`
  ).join('') + '</ol>';
}

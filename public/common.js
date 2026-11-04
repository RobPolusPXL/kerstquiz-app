'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let clockOffset = 0;
const syncClock = (serverNow) => { clockOffset = serverNow - Date.now(); };
const serverNow = () => Date.now() + clockOffset;
const fmtTime = (ms) => {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};
const fmtPts = (n) => (Math.round(n * 100) / 100).toString().replace('.', ',');

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
        onMsg(m);
      } catch (err) { console.error(err); }
    };
    ws.onclose = () => { onStatus(false); setTimeout(open, Math.min(4000, 400 + retry++ * 400)); };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  }
  open();
  return api;
}

function scoreboardHTML(rows, meId) {
  if (!rows || !rows.length) return '<p class="mute">Nog geen spelers.</p>';
  return '<ol class="sb" style="list-style:none">' + rows.map((r) =>
    `<li class="${r.id === meId ? 'me' : ''}"><span class="rk">${r.rank}</span><span class="nm">${esc(r.name)}</span><span class="pt">${fmtPts(r.total)}</span></li>`
  ).join('') + '</ol>';
}

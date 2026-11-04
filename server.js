'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const QUESTIONS_FILE = process.env.QUESTIONS_FILE || path.join(__dirname, 'questions.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const GRACE_MS = 1500;

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(3).toString('hex');
  console.log(`[kerstquiz] Geen ADMIN_PASSWORD ingesteld. Tijdelijk moderatorwachtwoord: ${ADMIN_PASSWORD}`);
}

/* ---------------------------------------------------------------- vragen */

let quiz = { title: 'Kerstquiz', rounds: [] };
const qById = new Map();

function loadQuiz() {
  const raw = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  const rounds = (raw.rounds || []).map((r, ri) => {
    const rid = r.id || `r${ri + 1}`;
    return {
      id: rid,
      title: r.title || `Ronde ${ri + 1}`,
      mode: r.mode === 'buzzer' ? 'buzzer' : 'paced',
      minutes: Number(r.minutes) || 15,
      intro: r.intro || '',
      questions: (r.questions || []).map((q, qi) => ({
        id: q.id || `${rid}q${qi + 1}`,
        type: q.type || (Array.isArray(q.options) ? 'choice' : 'text'),
        text: String(q.text || ''),
        image: q.image || null,
        options: Array.isArray(q.options) ? q.options.map(String) : null,
        correct: Number.isInteger(q.correct) ? q.correct : null,
        answers: Array.isArray(q.answers) ? q.answers.map(String) : q.answer ? [String(q.answer)] : [],
        points: q.points === undefined ? 1 : Number(q.points),
        note: q.note || ''
      }))
    };
  });
  quiz = { title: raw.title || 'Kerstquiz', rounds };
  qById.clear();
  rounds.forEach((r, ri) => r.questions.forEach((q) => qById.set(q.id, { q, ri })));
}

/* ------------------------------------------------------------------ state */

const freshBuzz = () => ({ open: false, lockedBy: null, excluded: [], winner: null });
const freshState = () => ({
  roundIndex: -1,
  roundState: 'idle', // idle | ready | running | closed
  endsAt: null,
  qIndex: -1,
  buzz: freshBuzz(),
  players: {},
  answers: {},
  marks: {},
  showScoreboard: false,
  reveal: {},
  settings: { maxPlayers: 12, locked: false },
  adminTokens: []
});

let state = freshState();

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = Object.assign(freshState(), s);
    state.settings = Object.assign(freshState().settings, s.settings);
    state.buzz = Object.assign(freshBuzz(), s.buzz);
  } catch (e) {
    state = freshState();
  }
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 200);
}
function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[kerstquiz] opslaan mislukt:', e.message);
  }
}

/* ---------------------------------------------------------------- scoring */

function norm(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function matches(q, val) {
  const v = String(val == null ? '' : val).trim();
  if (!v) return false;
  if (q.type === 'number') {
    const n = parseFloat(v.replace(',', '.'));
    if (Number.isNaN(n)) return false;
    return q.answers.some((a) => parseFloat(String(a).replace(',', '.')) === n);
  }
  const nv = norm(v);
  if (!nv) return false;
  return q.answers.some((a) => {
    const na = norm(a);
    if (na === nv) return true;
    const tol = na.length >= 12 ? 2 : na.length >= 6 ? 1 : 0;
    return tol > 0 && lev(na, nv) <= tol;
  });
}
function autoPoints(q, ans) {
  if (ans == null || ans === '') return 0;
  if (q.type === 'choice') return q.correct !== null && Number(ans) === q.correct ? q.points : 0;
  return matches(q, ans) ? q.points : 0;
}
function qp(pid, q) {
  const m = state.marks[pid] && state.marks[pid][q.id];
  if (m !== undefined) return { points: m, source: 'manual' };
  const a = state.answers[pid] && state.answers[pid][q.id];
  return { points: autoPoints(q, a), source: 'auto' };
}
const r2 = (n) => Math.round(n * 100) / 100;

function computeScores() {
  const rows = Object.values(state.players).map((p) => {
    const perRound = quiz.rounds.map((r) => r2(r.questions.reduce((s, q) => s + qp(p.id, q).points, 0)));
    return { id: p.id, name: p.name, perRound, total: r2(perRound.reduce((a, b) => a + b, 0)) };
  });
  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  let rank = 0, prev = null;
  rows.forEach((r, i) => {
    if (r.total !== prev) { rank = i + 1; prev = r.total; }
    r.rank = rank;
  });
  return rows;
}

/* ------------------------------------------------------------------ views */

const clients = new Map(); // ws -> { role, pid, admin }

const isOnline = (pid) => { for (const [ws, c] of clients) if (c.pid === pid && ws.readyState === 1) return true; return false; };
const curRound = () => (state.roundIndex >= 0 ? quiz.rounds[state.roundIndex] : null);
const pubQ = (q) => ({ id: q.id, type: q.type, text: q.text, image: q.image, options: q.options, points: q.points });
const nameOf = (pid) => (state.players[pid] ? state.players[pid].name : null);

function answeredAll(pid, r) {
  const a = state.answers[pid] || {};
  return r.questions.length > 0 && r.questions.every((q) => a[q.id] !== undefined && a[q.id] !== '');
}

function baseView() {
  const r = curRound();
  const v = {
    t: 'state',
    now: Date.now(),
    title: quiz.title,
    rounds: quiz.rounds.map((x) => ({ id: x.id, title: x.title, mode: x.mode, minutes: x.minutes, count: x.questions.length, intro: x.intro })),
    roundIndex: state.roundIndex,
    roundState: state.roundState,
    endsAt: state.endsAt,
    showScoreboard: state.showScoreboard,
    scoreboard: state.showScoreboard ? computeScores().map((s) => ({ id: s.id, name: s.name, total: s.total, rank: s.rank })) : null,
    names: Object.values(state.players).map((p) => ({ name: p.name, online: isOnline(p.id) })),
    settings: { locked: state.settings.locked, full: Object.keys(state.players).length >= state.settings.maxPlayers }
  };
  if (r && r.mode === 'buzzer' && state.roundState === 'running') {
    const q = r.questions[state.qIndex];
    v.qIndex = state.qIndex;
    v.qCount = r.questions.length;
    v.question = q ? pubQ(q) : null;
    v.buzz = {
      open: state.buzz.open,
      lockedByName: nameOf(state.buzz.lockedBy),
      winnerName: nameOf(state.buzz.winner),
      excludedNames: state.buzz.excluded.map(nameOf).filter(Boolean)
    };
  }
  return v;
}

function playerView(c) {
  const v = baseView();
  const me = c.pid && state.players[c.pid];
  v.me = me ? { id: me.id, name: me.name } : null;
  if (!me) return v;
  const r = curRound();
  if (r && r.mode === 'paced' && state.roundState === 'running') {
    v.questions = r.questions.map(pubQ);
    v.myAnswers = {};
    r.questions.forEach((q) => {
      const a = state.answers[me.id] && state.answers[me.id][q.id];
      if (a !== undefined) v.myAnswers[q.id] = a;
    });
  }
  if (r && v.buzz) {
    v.buzz.lockedByMe = state.buzz.lockedBy === me.id;
    v.buzz.excludedMe = state.buzz.excluded.includes(me.id);
    v.buzz.winnerMe = state.buzz.winner === me.id;
  }
  if (r && state.roundState === 'closed' && state.reveal[r.id] && r.mode === 'paced') {
    v.review = r.questions.map((q) => {
      const a = state.answers[me.id] && state.answers[me.id][q.id];
      const pts = qp(me.id, q).points;
      let shown = a == null ? '' : String(a);
      if (q.type === 'choice' && a != null && q.options) shown = q.options[Number(a)] || '';
      let correct = '';
      if (q.type === 'choice' && q.correct !== null && q.options) correct = q.options[q.correct];
      else if (q.answers.length) correct = q.answers[0];
      return { text: q.text, mine: shown, correct, points: r2(pts), max: q.points };
    });
  }
  return v;
}

function tvView() {
  const v = baseView();
  const r = curRound();
  if (r && r.mode === 'paced' && state.roundState === 'running') {
    const players = Object.values(state.players);
    v.progress = { done: players.filter((p) => answeredAll(p.id, r)).length, total: players.length };
  }
  return v;
}

function adminView() {
  const v = baseView();
  v.t = 'admin';
  v.quiz = quiz;
  v.qIndex = state.qIndex;
  v.buzz = {
    open: state.buzz.open,
    lockedBy: state.buzz.lockedBy,
    lockedByName: nameOf(state.buzz.lockedBy),
    winner: state.buzz.winner,
    winnerName: nameOf(state.buzz.winner),
    excluded: state.buzz.excluded,
    excludedNames: state.buzz.excluded.map(nameOf).filter(Boolean)
  };
  v.players = Object.values(state.players).map((p) => ({ id: p.id, name: p.name, online: isOnline(p.id) }));
  v.answers = state.answers;
  v.marks = state.marks;
  v.points = {};
  v.players.forEach((p) => {
    v.points[p.id] = {};
    quiz.rounds.forEach((r) => r.questions.forEach((q) => { v.points[p.id][q.id] = qp(p.id, q); }));
  });
  v.fullScores = computeScores();
  v.reveal = state.reveal;
  v.settings = Object.assign({}, state.settings);
  return v;
}

function viewFor(c) {
  if (c.admin) return adminView();
  if (c.role === 'tv') return tvView();
  return playerView(c);
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
let bcQueued = false;
function broadcast() {
  bcQueued = false;
  for (const [ws, c] of clients) send(ws, viewFor(c));
}
function changed() {
  saveSoon();
  if (!bcQueued) { bcQueued = true; setImmediate(broadcast); }
}

/* ----------------------------------------------------------------- timers */

let roundTimer = null;
function armTimer() {
  clearTimeout(roundTimer);
  const r = curRound();
  if (r && r.mode === 'paced' && state.roundState === 'running' && state.endsAt) {
    const ms = Math.max(0, state.endsAt - Date.now()) + 50;
    roundTimer = setTimeout(() => {
      if (state.roundState === 'running' && state.endsAt && Date.now() >= state.endsAt) {
        state.roundState = 'closed';
        changed();
      }
    }, ms);
  }
}

/* --------------------------------------------------------------- commands */

function setMark(pid, qid, val) {
  if (!state.players[pid] || !qById.has(qid)) return;
  state.marks[pid] = state.marks[pid] || {};
  if (val === null) delete state.marks[pid][qid];
  else state.marks[pid][qid] = r2(Number(val));
}

function newPlayer(name) {
  const id = crypto.randomBytes(4).toString('hex');
  const p = { id, name, token: crypto.randomBytes(12).toString('hex'), joinedAt: Date.now() };
  state.players[id] = p;
  return p;
}

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 24);
const findByName = (name) => Object.values(state.players).find((p) => p.name.toLowerCase() === name.toLowerCase());

function adminCmd(msg) {
  const r = curRound();
  const cur = r && r.questions[state.qIndex];
  switch (msg.cmd) {
    case 'selectRound': {
      const i = Number(msg.index);
      if (!Number.isInteger(i) || i < 0 || i >= quiz.rounds.length) return;
      state.roundIndex = i;
      state.roundState = 'ready';
      state.endsAt = null;
      state.qIndex = -1;
      state.buzz = freshBuzz();
      break;
    }
    case 'lobby':
      state.roundIndex = -1; state.roundState = 'idle'; state.endsAt = null; state.qIndex = -1; state.buzz = freshBuzz();
      break;
    case 'startRound':
      if (r && state.roundState === 'ready') {
        state.roundState = 'running';
        state.qIndex = -1;
        state.buzz = freshBuzz();
        state.endsAt = r.mode === 'paced' ? Date.now() + r.minutes * 60000 : null;
      }
      break;
    case 'closeRound':
      if (r && (state.roundState === 'running' || state.roundState === 'ready')) {
        state.roundState = 'closed';
        state.buzz.open = false;
      }
      break;
    case 'extend':
      if (r && r.mode === 'paced' && (state.roundState === 'running' || state.roundState === 'closed')) {
        const min = Number(msg.minutes) || 1;
        const base = state.roundState === 'running' && state.endsAt > Date.now() ? state.endsAt : Date.now();
        state.endsAt = base + min * 60000;
        state.roundState = 'running';
      }
      break;
    case 'scoreboard':
      state.showScoreboard = !!msg.on;
      break;
    case 'reveal':
      if (msg.roundId) state.reveal[msg.roundId] = !!msg.on;
      break;
    case 'mark':
      setMark(msg.pid, msg.qid, msg.points === null || msg.points === undefined || msg.points === '' ? null : Number(msg.points));
      break;
    case 'gotoQ':
      if (r && r.mode === 'buzzer') {
        const i = Number(msg.index);
        if (Number.isInteger(i) && i >= 0 && i < r.questions.length) { state.qIndex = i; state.buzz = freshBuzz(); }
      }
      break;
    case 'openBuzzer':
      if (cur && state.roundState === 'running') { state.buzz.open = true; state.buzz.lockedBy = null; state.buzz.winner = null; }
      break;
    case 'closeBuzzer':
      state.buzz.open = false;
      break;
    case 'resetBuzz':
      state.buzz = freshBuzz();
      break;
    case 'correct':
      if (cur && state.buzz.lockedBy) {
        setMark(state.buzz.lockedBy, cur.id, cur.points);
        state.buzz.winner = state.buzz.lockedBy;
        state.buzz.lockedBy = null;
        state.buzz.open = false;
      }
      break;
    case 'wrong':
      if (cur && state.buzz.lockedBy) {
        state.buzz.excluded.push(state.buzz.lockedBy);
        state.buzz.lockedBy = null;
        state.buzz.open = true;
      }
      break;
    case 'addPlayer': {
      const name = cleanName(msg.name);
      if (name && !findByName(name)) newPlayer(name);
      break;
    }
    case 'kick':
      if (state.players[msg.pid]) {
        delete state.players[msg.pid];
        delete state.answers[msg.pid];
        delete state.marks[msg.pid];
        for (const c of clients.values()) if (c.pid === msg.pid) c.pid = null;
      }
      break;
    case 'settings':
      if (msg.maxPlayers !== undefined) state.settings.maxPlayers = Math.max(1, Math.min(60, Number(msg.maxPlayers) || 12));
      if (msg.locked !== undefined) state.settings.locked = !!msg.locked;
      break;
    case 'reloadQuiz':
      try { loadQuiz(); } catch (e) { return { error: 'questions.json is ongeldig: ' + e.message }; }
      break;
    case 'reset':
      if (msg.what === 'all') {
        state = Object.assign(freshState(), { adminTokens: state.adminTokens });
        for (const c of clients.values()) if (!c.admin) c.pid = null;
      } else {
        state.roundIndex = -1; state.roundState = 'idle'; state.endsAt = null; state.qIndex = -1;
        state.buzz = freshBuzz(); state.answers = {}; state.marks = {}; state.reveal = {}; state.showScoreboard = false;
      }
      break;
    default:
      return { error: 'onbekend commando' };
  }
  armTimer();
  return null;
}

/* ------------------------------------------------------------- websocket */

function onMessage(ws, c, msg) {
  switch (msg.t) {
    case 'hello':
      if (msg.role === 'tv') c.role = 'tv';
      break;

    case 'join': {
      const name = cleanName(msg.name);
      const token = String(msg.token || '');
      let p = token && Object.values(state.players).find((x) => x.token === token);
      if (!p) {
        if (!name) return send(ws, { t: 'error', ctx: 'join', message: token ? 'Sessie verlopen, kies je naam opnieuw.' : 'Vul een naam in.' });
        p = findByName(name);
        if (p) {
          if (isOnline(p.id)) return send(ws, { t: 'error', ctx: 'join', message: `"${p.name}" is al in gebruik op een ander toestel.` });
        } else {
          if (state.settings.locked) return send(ws, { t: 'error', ctx: 'join', message: 'Inschrijven is gesloten. Vraag de moderator.' });
          if (Object.keys(state.players).length >= state.settings.maxPlayers) return send(ws, { t: 'error', ctx: 'join', message: 'De quiz zit vol.' });
          p = newPlayer(name);
        }
      }
      c.role = 'player';
      c.pid = p.id;
      send(ws, { t: 'joined', token: p.token, id: p.id, name: p.name });
      changed();
      break;
    }

    case 'answer': {
      const p = c.pid && state.players[c.pid];
      const r = curRound();
      if (!p || !r || r.mode !== 'paced' || state.roundState !== 'running') return send(ws, { t: 'nack', qid: msg.qid, reason: 'closed' });
      if (state.endsAt && Date.now() > state.endsAt + GRACE_MS) return send(ws, { t: 'nack', qid: msg.qid, reason: 'closed' });
      const q = r.questions.find((x) => x.id === msg.qid);
      if (!q) return;
      let val = msg.value;
      if (q.type === 'choice') {
        val = Number(val);
        if (!Number.isInteger(val) || val < 0 || val >= q.options.length) return;
      } else {
        val = String(val == null ? '' : val).slice(0, 200);
      }
      state.answers[p.id] = state.answers[p.id] || {};
      state.answers[p.id][q.id] = val;
      send(ws, { t: 'ack', qid: q.id });
      changed();
      break;
    }

    case 'buzz': {
      const p = c.pid && state.players[c.pid];
      const r = curRound();
      if (!p || !r || r.mode !== 'buzzer' || state.roundState !== 'running') return;
      const b = state.buzz;
      if (!b.open || b.lockedBy || b.excluded.includes(p.id)) return;
      b.lockedBy = p.id;
      b.open = false;
      b.winner = null;
      changed();
      break;
    }

    case 'admin_login': {
      const a = Buffer.from(String(msg.password || ''));
      const b = Buffer.from(ADMIN_PASSWORD);
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!ok) return setTimeout(() => send(ws, { t: 'error', ctx: 'admin', message: 'Verkeerd wachtwoord.' }), 600);
      const token = crypto.randomBytes(16).toString('hex');
      state.adminTokens.push(token);
      if (state.adminTokens.length > 10) state.adminTokens.shift();
      c.admin = true;
      send(ws, { t: 'admin_ok', token });
      changed();
      break;
    }

    case 'admin_resume':
      if (state.adminTokens.includes(String(msg.token))) {
        c.admin = true;
        send(ws, { t: 'admin_ok', token: msg.token });
        send(ws, adminView());
      } else {
        send(ws, { t: 'error', ctx: 'admin', message: '' });
      }
      break;

    case 'cmd': {
      if (!c.admin) return send(ws, { t: 'error', ctx: 'admin', message: 'Niet aangemeld als moderator.' });
      const res = adminCmd(msg);
      if (res && res.error) send(ws, { t: 'error', ctx: 'cmd', message: res.error });
      changed();
      break;
    }
  }
}

/* ------------------------------------------------------------------- http */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json'
};
const ROUTES = { '/': 'index.html', '/admin': 'admin.html', '/tv': 'tv.html' };

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const rel = ROUTES[url] || url.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Niet gevonden'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  const c = { role: null, pid: null, admin: false };
  clients.set(ws, c);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { onMessage(ws, c, msg); } catch (e) { console.error('[kerstquiz] fout:', e); }
    if (msg.t === 'hello') send(ws, viewFor(c));
  });
  ws.on('close', () => { clients.delete(ws); changed(); });
  ws.on('error', () => {});
  send(ws, viewFor(c));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 20000);

/* ------------------------------------------------------------------ start */

loadQuiz();
loadState();
armTimer();
server.listen(PORT, () => {
  console.log(`[kerstquiz] draait op http://localhost:${PORT}  (spelers: /  moderator: /admin  tv: /tv)`);
});

function shutdown() { saveNow(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

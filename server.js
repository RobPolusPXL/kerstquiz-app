'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const QUIZZES_DIR = path.join(__dirname, 'quizzes');

/* Elk jaar heeft een eigen vragenbestand (quizzes/<jaar>.json) en een eigen spelstatus (data/state-<jaar>.json).
   Actief jaar: QUIZ_YEAR, anders het hoogste jaar in quizzes/. Met QUESTIONS_FILE kan een los bestand gebruikt worden (tests). */
function listYears() {
  try { return fs.readdirSync(QUIZZES_DIR).map((f) => (f.match(/^(\d{4})\.json$/) || [])[1]).filter(Boolean).map(Number).sort((a, b) => a - b); } catch (e) { return []; }
}
let YEAR = null;
let QUESTIONS_FILE = process.env.QUESTIONS_FILE || null;
if (!QUESTIONS_FILE) {
  const years = listYears();
  YEAR = Number(process.env.QUIZ_YEAR) || years[years.length - 1] || null;
  if (!YEAR) { console.error('[kerstquiz] Geen vragenbestand gevonden in quizzes/'); process.exit(1); }
  QUESTIONS_FILE = path.join(QUIZZES_DIR, `${YEAR}.json`);
} else if (process.env.QUIZ_YEAR) YEAR = Number(process.env.QUIZ_YEAR);
const STATE_FILE = path.join(DATA_DIR, YEAR ? `state-${YEAR}.json` : 'state.json');
let ARCHIEF = false; // archiefjaren (zoals 2025) houden geen stand bij
const PUBLIC_DIR = path.join(__dirname, 'public');
const GRACE_MS = 1500;
// De buzzer opent op alle gsm's op hetzelfde geplande tijdstip (nu + lead), zodat netwerkvertraging niemand benadeelt.
const BUZZ_LEAD_MS = Number(process.env.BUZZ_LEAD_MS) || 1500;

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(3).toString('hex');
  console.log(`[kerstquiz] Geen ADMIN_PASSWORD ingesteld. Tijdelijk moderatorwachtwoord: ${ADMIN_PASSWORD}`);
}

/* Versie van de clientbestanden: pagina's herladen zichzelf als die verandert (geen oude JS op open gsm's). */
function buildHash() {
  const h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(PUBLIC_DIR).sort()) {
    const fp = path.join(PUBLIC_DIR, f);
    if (fs.statSync(fp).isFile()) h.update(f).update(fs.readFileSync(fp));
  }
  return h.digest('hex').slice(0, 6);
}
const BUILD = buildHash();

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
      mode: ['buzzer', 'stepped'].includes(r.mode) ? r.mode : 'paced',
      minutes: Number(r.minutes) || 15,
      seconds: r.seconds === undefined ? 45 : Number(r.seconds) || 0,
      intro: r.intro || '',
      questions: (r.questions || []).map((q, qi) => ({
        id: q.id || `${rid}q${qi + 1}`,
        type: q.type || (Array.isArray(q.options) ? 'choice' : 'text'),
        text: String(q.text || ''),
        image: q.image || null,
        options: Array.isArray(q.options) ? q.options.map(String) : null,
        correct: Number.isInteger(q.correct) ? q.correct : null,
        answers: Array.isArray(q.answers) ? q.answers.map(String) : q.answer ? [String(q.answer)] : [],
        parts: Array.isArray(q.parts) && q.parts.length ? q.parts.map((p) => ({ answers: (Array.isArray(p.answers) ? p.answers : [p.answer]).filter((a) => a != null).map(String), points: p.points === undefined ? 1 : Number(p.points) })) : null,
        points: q.points !== undefined ? Number(q.points) : Array.isArray(q.parts) && q.parts.length ? q.parts.reduce((t, p) => t + (p.points === undefined ? 1 : Number(p.points)), 0) : 1,
        note: q.note || ''
      }))
    };
  });
  ARCHIEF = !!raw.archief;
  quiz = { title: raw.title || 'Kerstquiz', rounds };
  qById.clear();
  rounds.forEach((r, ri) => r.questions.forEach((q) => qById.set(q.id, { q, ri })));
}

/* ------------------------------------------------------------------ state */

const freshBuzz = () => ({ open: false, openAt: 0, lockedBy: null, excluded: [], winner: null, log: [], margin: {} });
const freshState = () => ({
  roundIndex: -1,
  roundState: 'idle', // idle | ready | running | closed
  endsAt: null,
  qIndex: -1,
  qOpen: false,
  qRevealed: false,
  buzz: freshBuzz(),
  players: {},
  answers: {},
  locks: {},
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
    writeStandings();
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
  if (q.parts) { // deelpunten: elk deel telt als zijn antwoord ergens in de getypte tekst staat
    const nv = norm(ans);
    return q.parts.reduce((t, p) => t + (p.answers.some((a) => { const na = norm(a); return na && nv.includes(na); }) ? p.points : 0), 0);
  }
  return matches(q, ans) ? q.points : 0;
}
function qp(pid, q) {
  const m = state.marks[pid] && state.marks[pid][q.id];
  if (m !== undefined) return { points: m, source: 'manual' };
  const a = state.answers[pid] && state.answers[pid][q.id];
  return { points: autoPoints(q, a), source: 'auto' };
}
const r2 = (n) => Math.round(n * 100) / 100;

function correctText(q) {
  if (q.type === 'choice') return q.correct !== null && q.options ? q.options[q.correct] : '';
  if (q.parts) return q.parts.map((p) => p.answers[0] || '').join(' ');
  return q.answers.slice(0, 3).join(' / ');
}
function answerText(q, a) {
  if (a === undefined || a === null || a === '') return '';
  if (q.type === 'choice') return (q.options && q.options[Number(a)]) || '';
  return String(a);
}

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

/* ------------------------------------------------ stand per jaar + ranking */

function writeStandings() {
  if (!YEAR || ARCHIEF || !Object.keys(state.players).length) return;
  const players = computeScores().map((s) => ({ name: s.name, total: s.total, rank: s.rank }));
  const file = path.join(DATA_DIR, `standings-${YEAR}.json`);
  fs.writeFileSync(file + '.tmp', JSON.stringify({ year: YEAR, title: quiz.title, updated: new Date().toISOString(), players }));
  fs.renameSync(file + '.tmp', file);
}

// Algemene ranking: voegt de standen van alle bewaarde jaren samen op naam.
function rankingData() {
  const years = [], by = new Map();
  let files = [];
  try { files = fs.readdirSync(DATA_DIR).filter((f) => /^standings-\d{4}\.json$/.test(f)).sort(); } catch (e) { /* geen data */ }
  for (const f of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch (e) { continue; }
    years.push(s.year);
    for (const p of s.players || []) {
      const k = norm(p.name);
      if (!by.has(k)) by.set(k, { name: p.name, total: 0, wins: 0, years: {} });
      const e = by.get(k);
      e.years[s.year] = { total: p.total, rank: p.rank, of: s.players.length };
      e.total = r2(e.total + p.total);
      if (p.rank === 1 && p.total > 0) e.wins++;
    }
  }
  const players = [...by.values()].sort((a, b) => b.total - a.total || b.wins - a.wins || a.name.localeCompare(b.name));
  let rank = 0, prev = null;
  players.forEach((p, i) => { if (p.total !== prev) { rank = i + 1; prev = p.total; } p.rank = rank; p.played = Object.keys(p.years).length; });
  return { years, players };
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
    ver: BUILD,
    now: Date.now(),
    title: quiz.title,
    year: YEAR,
    rounds: quiz.rounds.map((x) => ({ id: x.id, title: x.title, mode: x.mode, minutes: x.minutes, count: x.questions.length, intro: x.intro })),
    roundIndex: state.roundIndex,
    roundState: state.roundState,
    endsAt: state.endsAt,
    showScoreboard: state.showScoreboard,
    scoreboard: state.showScoreboard ? computeScores().map((s) => ({ id: s.id, name: s.name, total: s.total, rank: s.rank })) : null,
    names: Object.values(state.players).map((p) => ({ name: p.name, online: isOnline(p.id) })),
    settings: { locked: state.settings.locked, full: Object.keys(state.players).length >= state.settings.maxPlayers }
  };
  if (r && r.mode === 'stepped' && state.roundState === 'running') {
    const q = r.questions[state.qIndex];
    v.qIndex = state.qIndex;
    v.qCount = r.questions.length;
    v.question = q ? pubQ(q) : null;
    v.qOpen = state.qOpen;
    v.qRevealed = state.qRevealed;
    if (q && state.qRevealed) v.revealAnswer = correctText(q);
  }
  if (r && r.mode === 'buzzer' && state.roundState === 'running') {
    const q = r.questions[state.qIndex];
    v.qIndex = state.qIndex;
    v.qCount = r.questions.length;
    v.question = q ? pubQ(q) : null;
    v.buzz = {
      open: state.buzz.open,
      openAt: state.buzz.openAt,
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
  if (r && r.mode === 'stepped' && state.roundState === 'running' && v.question) {
    const q = r.questions[state.qIndex];
    const a = (state.answers[me.id] || {})[q.id];
    if (a !== undefined) v.myAnswer = a;
    v.myLocked = isLocked(me.id, q);
    if (state.qRevealed) v.result = { mine: answerText(q, a), points: r2(qp(me.id, q).points), max: q.points };
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
  if (r && r.mode === 'stepped' && state.roundState === 'running' && v.question) {
    const players = Object.values(state.players);
    const cq = r.questions[state.qIndex];
    v.progress = { done: players.filter((p) => isLocked(p.id, cq)).length, total: players.length };
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
    openAt: state.buzz.openAt,
    lockedBy: state.buzz.lockedBy,
    lockedByName: nameOf(state.buzz.lockedBy),
    winner: state.buzz.winner,
    winnerName: nameOf(state.buzz.winner),
    log: state.buzz.log,
    margin: Object.fromEntries(Object.entries(state.buzz.margin || {}).map(([pid, m]) => [nameOf(pid), m])),
    excluded: state.buzz.excluded,
    excludedNames: state.buzz.excluded.map(nameOf).filter(Boolean)
  };
  v.players = Object.values(state.players).map((p) => ({ id: p.id, name: p.name, online: isOnline(p.id) }));
  v.rtt = {};
  v.clk = {};
  for (const c of clients.values()) {
    if (c.pid && c.rtt != null) v.rtt[c.pid] = Math.round(c.rtt);
    if (c.pid && c.clkErr != null) v.clk[c.pid] = c.clkErr;
  }
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
/* stepped-ronde: meerkeuze is definitief bij de eerste keuze, tekst/getal na 'vergrendelen'; zodra alle verbonden spelers klaar zijn, sluit de vraag */
function isLocked(pid, q) {
  if (q.type === 'choice') return ((state.answers[pid] || {})[q.id]) !== undefined;
  return !!((state.locks && state.locks[pid]) || {})[q.id];
}
function checkAllLocked() {
  const r = curRound();
  if (!r || r.mode !== 'stepped' || state.roundState !== 'running' || !state.qOpen) return;
  const q = r.questions[state.qIndex];
  if (!q) return;
  const online = Object.values(state.players).filter((p) => isOnline(p.id));
  if (!online.length) return;
  if (online.every((p) => isLocked(p.id, q))) state.qOpen = false;
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
  } else if (r && r.mode === 'stepped' && state.roundState === 'running' && state.qOpen && state.endsAt) {
    const ms = Math.max(0, state.endsAt - Date.now()) + 50;
    roundTimer = setTimeout(() => {
      if (state.roundState === 'running' && state.qOpen && state.endsAt && Date.now() >= state.endsAt) {
        state.qOpen = false;
        changed();
      }
    }, ms);
  }
}

/* buzzer: kort beslissingsvenster, gecorrigeerd voor netwerkvertraging */
const BUZZ_WINDOW_MS = 100;
let buzzPending = [];
let buzzTimer = null;
function clearBuzzPending() { clearTimeout(buzzTimer); buzzTimer = null; buzzPending = []; }
function decideBuzz() {
  const list = buzzPending;
  buzzPending = [];
  buzzTimer = null;
  const b = state.buzz;
  const r = curRound();
  if (!list.length || !r || r.mode !== 'buzzer' || state.roundState !== 'running' || !b.open || b.lockedBy) return;
  list.sort((x, y) => x.est - y.est || x.arrival - y.arrival);
  const win = list[0];
  b.lockedBy = win.pid;
  b.open = false;
  b.winner = null;
  b.log = list.map((x) => ({ pid: x.pid, name: nameOf(x.pid), delta: Math.round(x.est - win.est), arrivalDelta: Math.round(x.arrival - win.arrival), rtt: Math.round(x.rtt) }));
  changed();
}
function resetLive() {
  clearBuzzPending();
  state.qIndex = -1;
  state.qOpen = false;
  state.qRevealed = false;
  state.buzz = freshBuzz();
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
      resetLive();
      break;
    }
    case 'lobby':
      state.roundIndex = -1; state.roundState = 'idle'; state.endsAt = null; resetLive();
      break;
    case 'startRound':
      if (r && state.roundState === 'ready') {
        state.roundState = 'running';
        resetLive();
        state.endsAt = r.mode === 'paced' ? Date.now() + r.minutes * 60000 : null;
      }
      break;
    case 'closeRound':
      if (r && (state.roundState === 'running' || state.roundState === 'ready')) {
        state.roundState = 'closed';
        state.buzz.open = false;
        state.qOpen = false;
        clearBuzzPending();
      }
      break;
    case 'extend':
      if (r && r.mode === 'paced' && (state.roundState === 'running' || state.roundState === 'closed')) {
        const min = Number(msg.minutes) || 1;
        const base = state.roundState === 'running' && state.endsAt > Date.now() ? state.endsAt : Date.now();
        state.endsAt = base + min * 60000;
        state.roundState = 'running';
      } else if (r && r.mode === 'stepped' && state.roundState === 'running' && state.qIndex >= 0) {
        const sec = Number(msg.seconds) || 15;
        const base = state.endsAt > Date.now() ? state.endsAt : Date.now();
        state.endsAt = base + sec * 1000;
        state.qOpen = true;
        state.qRevealed = false;
      }
      break;
    case 'closeQ':
      if (r && r.mode === 'stepped') state.qOpen = false;
      break;
    case 'revealQ':
      if (r && r.mode === 'stepped' && state.qIndex >= 0) { state.qOpen = false; state.qRevealed = true; }
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
    case 'gotoQ': {
      const i = Number(msg.index);
      if (!r || state.roundState !== 'running' || !Number.isInteger(i) || i < 0 || i >= r.questions.length) break;
      if (r.mode === 'buzzer') {
        clearBuzzPending();
        state.qIndex = i;
        state.buzz = freshBuzz();
      } else if (r.mode === 'stepped') {
        state.qIndex = i;
        state.qOpen = true;
        state.qRevealed = false;
        state.endsAt = r.seconds > 0 ? Date.now() + r.seconds * 1000 : null;
      }
      break;
    }
    case 'openBuzzer':
      if (cur && state.roundState === 'running') {
        clearBuzzPending();
        state.buzz.open = true; state.buzz.openAt = Date.now() + BUZZ_LEAD_MS; state.buzz.lockedBy = null; state.buzz.winner = null; state.buzz.log = []; state.buzz.margin = {};
      }
      break;
    case 'closeBuzzer':
      clearBuzzPending();
      state.buzz.open = false;
      break;
    case 'resetBuzz':
      clearBuzzPending();
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
        state.buzz.log = [];
        state.buzz.margin = {};
        state.buzz.open = true;
        state.buzz.openAt = Date.now() + BUZZ_LEAD_MS;
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
        delete state.answers[msg.pid]; if (state.locks) delete state.locks[msg.pid];
        delete state.marks[msg.pid];
        for (const c of clients.values()) if (c.pid === msg.pid) c.pid = null;
      }
      break;
    case 'settings':
      if (msg.maxPlayers !== undefined) state.settings.maxPlayers = Math.max(1, Math.min(60, Number(msg.maxPlayers) || 12));
      if (msg.locked !== undefined) state.settings.locked = !!msg.locked;
      break;
    case 'reloadQuiz':
      try { loadQuiz(); } catch (e) { return { error: path.basename(QUESTIONS_FILE) + ' is ongeldig: ' + e.message }; }
      break;
    case 'reset':
      if (msg.what === 'all') {
        clearBuzzPending();
        state = Object.assign(freshState(), { adminTokens: state.adminTokens });
        for (const c of clients.values()) if (!c.admin) c.pid = null;
      } else {
        state.roundIndex = -1; state.roundState = 'idle'; state.endsAt = null; resetLive();
        state.answers = {}; state.locks = {}; state.marks = {}; state.reveal = {}; state.showScoreboard = false;
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
      const closed = () => send(ws, { t: 'nack', qid: msg.qid, reason: 'closed' });
      if (!p || !r || r.mode === 'buzzer' || state.roundState !== 'running') return closed();
      if (state.endsAt && Date.now() > state.endsAt + GRACE_MS) return closed();
      if (r.mode === 'stepped') {
        const cq = r.questions[state.qIndex];
        if (!state.qOpen || !cq || cq.id !== msg.qid) return closed();
      }
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
      const stepped = r.mode === 'stepped';
      if (!(stepped && isLocked(p.id, q))) { // vergrendeld = definitief
        state.answers[p.id][q.id] = val;
        if (stepped && msg.lock && String(val).trim() !== '') {
          state.locks = state.locks || {};
          state.locks[p.id] = state.locks[p.id] || {};
          state.locks[p.id][q.id] = true;
        }
      }
      send(ws, { t: 'ack', qid: q.id });
      checkAllLocked();
      changed();
      break;
    }

    case 'buzz': {
      const p = c.pid && state.players[c.pid];
      const r = curRound();
      if (!p || !r || r.mode !== 'buzzer' || state.roundState !== 'running') return;
      const b = state.buzz;
      if (!b.open || b.lockedBy || b.excluded.includes(p.id)) return;
      if (buzzPending.some((x) => x.pid === p.id)) return;
      const arrival = Date.now();
      const rtt = c.rtt || 0;
      const est = arrival - rtt / 2;
      if (b.openAt && est < b.openAt - 40) return; // te vroeg gedrukt (voor het geplande openingstijdstip): telt niet, kost niets
      buzzPending.push({ pid: p.id, arrival, rtt, est });
      if (!buzzTimer) buzzTimer = setTimeout(decideBuzz, BUZZ_WINDOW_MS);
      break;
    }

    case 'sa': {
      const t = Number(msg.i);
      const rtt = Date.now() - t;
      if (!t || rtt < 0 || rtt > 5000) return;
      // Laagste recente ping = basisvertraging zonder wachtrij/jitter (nauwkeuriger dan een gemiddelde).
      c.rtts = c.rtts || [];
      c.rtts.push(rtt);
      if (c.rtts.length > 10) c.rtts.shift();
      c.rtt = Math.min(...c.rtts);
      break;
    }

    case 'ts': // klok-synchronisatie: antwoord onmiddellijk met de servertijd
      send(ws, { t: 'tr', c: msg.c, s: Date.now() });
      break;

    case 'clk':
      if (c.pid && Number.isFinite(Number(msg.err))) c.clkErr = Math.round(Number(msg.err));
      break;

    case 'diag': // marge waarmee het 'open'-bericht vóór het openingstijdstip aankwam
      if (c.pid && state.buzz.open && Number(msg.openAt) === state.buzz.openAt && Number.isFinite(Number(msg.marge))) {
        state.buzz.margin[c.pid] = Math.round(Number(msg.marge));
        changed();
      }
      break;

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
const ROUTES = { '/': 'index.html', '/admin': 'admin.html', '/tv': 'tv.html', '/ranking': 'ranking.html' };

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url === '/api/ranking') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(rankingData()));
  }
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
  ws.on('close', () => { clients.delete(ws); checkAllLocked(); changed(); });
  ws.on('error', () => {});
  send(ws, viewFor(c));
});

// Latency-meting: snel tijdens de buzzerronde (houdt ook de wifi-radio van gsm's wakker), anders elke 2s.
let pingTick = 0;
setInterval(() => {
  pingTick++;
  const r = curRound();
  const fast = r && r.mode === 'buzzer' && state.roundState === 'running';
  const slowTurn = pingTick % 10 === 0;
  if (!fast && !slowTurn) return;
  const now = Date.now();
  for (const [ws, c] of clients) if (c.pid && ws.readyState === 1) ws.send(JSON.stringify({ t: 'sp', i: now, r: c.rtt == null ? undefined : Math.round(c.rtt) }));
  if (slowTurn) for (const [ws, c] of clients) if (c.admin) send(ws, adminView());
}, 200);

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

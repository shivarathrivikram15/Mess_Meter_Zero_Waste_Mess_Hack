/* HTTP application: static files, JSON API, authentication and authorisation. Exported as a factory so tests can boot it in-process. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './db.mjs';
import { verifyPassword, signToken, verifyToken, createLimiter } from './auth.mjs';
import { MEALS, MENU, POLL, NGOS } from './data.js';
import * as L from './logic.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
/* Only these files are public. Server code, the database and tests are never reachable over HTTP. */
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/script.js': 'script.js', '/logic.js': 'logic.js', '/data.js': 'data.js' };
const CSP = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status } }
const bad = (m, s = 400) => new HttpError(s, m);

export function createApp({ dbFile = ':memory:', demo = true, tz = 'Asia/Kolkata', studentPassword, supervisorPassword, secret, now = () => new Date(), log = () => {} } = {}) {
  const store = openStore(dbFile, { studentPassword, supervisorPassword });
  const SECRET = secret || store.secret();
  const loginLimiter = createLimiter(8, 5 * 60e3);

  /* ---------- time: the server is the only source of truth ---------- */
  function clock() {
    const real = L.campusClock(now(), tz);
    const demoTime = demo ? L.parseClock(store.setting('demo_clock')) : null;
    if (!demoTime) return { wall: real.wall, dayIdx: real.dayIdx, demo: false };
    const wall = new Date(real.wall); wall.setHours(demoTime.h, demoTime.m, 0, 0);
    return { wall, dayIdx: real.dayIdx, demo: true };
  }
  const startOf = id => MEALS.find(m => m.id === id).start;

  /* ---------- state projection (what a given user may see) ---------- */
  function buildState(user) {
    const c = clock(), tmr = (c.dayIdx + 1) % 7;
    const real = store.realOptCounts(), sim = store.simCounts(), optCounts = {};
    for (let d = 0; d < 7; d++) for (const m of MEALS) { const k = `${d}-${m.id}`; optCounts[k] = L.baseOut(d, m.id, tmr) + (sim[k] || 0) + (real[k] || 0) }
    const sup = user.role === 'supervisor';
    return {
      user: { username: user.username, name: user.name, role: user.role },
      clock: { wall: L.wallToString(c.wall), dayIdx: c.dayIdx, demo: c.demo, demoAvailable: demo, tz },
      me: user.role === 'student' ? store.myOptOuts(user.id) : {},
      optCounts,
      logs: sup ? store.logs(20) : [],
      loggedKg: store.wasteTotal(),
      ratings: store.ratings(),
      comments: store.comments(6),
      votes: store.votes(POLL.length),
      voted: store.myVote(user.id),
      audit: sup ? store.audit(20) : [],
      ngoAlerts: sup ? store.ngoAlerts(8) : [],
      impact: (() => { const t = store.ngoTotals(); return { alerts: t.alerts, kg: t.kg, ...L.rescueImpact(t.kg) } })(),
    };
  }

  /* ---------- request helpers ---------- */
  async function readJson(req) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw bad('Content-Type must be application/json', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 100_000) throw bad('Payload too large', 413); chunks.push(chunk) }
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); if (v === null || typeof v !== 'object' || Array.isArray(v)) throw 0; return v } catch { throw bad('Invalid JSON body') }
  }
  function authenticate(req) {
    const h = req.headers.authorization || '';
    const payload = h.startsWith('Bearer ') ? verifyToken(h.slice(7), SECRET) : null;
    const user = payload && store.userByName(payload.sub);
    if (!user || user.role !== payload.role) throw bad('Sign in required', 401);
    return user;
  }
  const need = (user, role) => { if (user.role !== role) throw bad(`This action needs the ${role} role`, 403) };
  const needDemo = () => { if (!demo) throw bad('Demo tools are disabled on this server', 403) };
  const stamp = () => new Date().toISOString();
  const mealRef = body => { if (!L.isMealRef(body.day, body.meal)) throw bad('Unknown day or meal'); return { day: body.day, meal: body.meal } };

  /* ---------- routes: [method, path] -> handler(ctx) ---------- */
  const routes = {
    'GET /api/health': async () => ({ ok: true, service: 'MessMeter API', demo }),

    'POST /api/login': async ({ req, body }) => {
      const username = String(body.username ?? '').toLowerCase().slice(0, 40), ip = req.socket.remoteAddress;
      if (!loginLimiter.allow(`${ip}|${username}`)) throw bad('Too many attempts. Try again in a few minutes.', 429);
      const user = store.userByName(username);
      /* Always run one scrypt verification so unknown usernames are not distinguishable by timing. */
      const ok = verifyPassword(String(body.password ?? ''), user ? user.pass_hash : 'scrypt$00$00') && !!user;
      if (!ok) throw bad('Invalid username or password', 401);
      loginLimiter.reset(`${ip}|${username}`);
      store.addAudit('LOGIN', user.username, `${user.role} signed in`, stamp());
      return { token: signToken({ sub: user.username, role: user.role }, SECRET), user: { username: user.username, name: user.name, role: user.role } };
    },

    'GET /api/state': async ({ user }) => buildState(user),

    /* Student: toggle an opt-out. The 6-hour rule is evaluated here, against the server clock, never the client's. */
    'POST /api/optout': async ({ user, body }) => {
      need(user, 'student');
      const { day, meal } = mealRef(body), c = clock();
      const info = L.cutoffInfo(c.wall, c.dayIdx, day, startOf(meal));
      if (!info.open) throw bad(`Cutoff passed. Opt-outs close ${L.CUTOFF_HOURS} hours before the meal.`, 409);
      const on = store.toggleOptOut(user.id, day, meal, stamp());
      store.addAudit(on ? 'OPT_OUT' : 'OPT_OUT_UNDONE', user.username, `${MENU[day][meal].t} (${day}-${meal})`, stamp());
      return { on, state: buildState(user) };
    },

    'POST /api/ratings': async ({ user, body }) => {
      need(user, 'student');
      const { day, meal } = mealRef(body), dishes = MENU[day][meal].d;
      if (!body.ratings || typeof body.ratings !== 'object' || Array.isArray(body.ratings)) throw bad('ratings must be an object');
      const entries = Object.entries(body.ratings);
      if (!entries.length) throw bad('Rate at least one dish');
      for (const [dish, s] of entries) if (!dishes.includes(dish) || !Number.isInteger(s) || s < 1 || s > 5) throw bad('Invalid rating');
      const cc = L.cleanComment(body.comment); if (!cc.ok) throw bad(cc.error);
      const avg = Math.round(entries.reduce((a, [, s]) => a + s, 0) / entries.length);
      store.addRatings(Object.fromEntries(entries), cc.text ? { meal: MENU[day][meal].t, stars: '⭐'.repeat(avg), text: cc.text, author: user.username, at: stamp() } : null);
      store.addAudit('FEEDBACK', user.username, `Rated ${entries.length} dish(es) for ${MENU[day][meal].t}`, stamp());
      return { state: buildState(user) };
    },

    'POST /api/vote': async ({ user, body }) => {
      need(user, 'student');
      if (!Number.isInteger(body.option) || body.option < 0 || body.option >= POLL.length) throw bad('Unknown poll option');
      if (!store.castVote(user.id, body.option)) throw bad('You already voted', 409);
      return { state: buildState(user) };
    },

    /* Supervisor: waste + surplus log. Beacon decision and NGO pick are made server-side and recorded. */
    'POST /api/logs': async ({ user, body }) => {
      need(user, 'supervisor');
      const { day, meal } = mealRef(body), dishes = MENU[day][meal].d;
      if (!Array.isArray(body.waste) || body.waste.length !== dishes.length) throw bad(`waste must list ${dishes.length} values`);
      const parsed = body.waste.map((v, i) => ({ n: dishes[i], ...L.parseKg(v, `${dishes[i]} waste`) })), ps = L.parseKg(body.surplus, 'Surplus');
      const err = [...parsed, ps].find(r => !r.ok); if (err) throw bad(err.error);
      const rows = parsed.filter(r => r.value > 0), total = +rows.reduce((a, r) => a + r.value, 0).toFixed(1), surplus = ps.value;
      if (!total && !surplus) throw bad('Enter at least one waste value');
      const label = `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day]} ${MEALS.find(m => m.id === meal).label}`;
      let beacon = null;
      store.tx(() => {
        store.addLog({ meal: label, items: rows.map(r => `${r.n}: ${r.value}kg`).join(', ') || 'No waste', total, surplus, by: user.username, at: stamp() });
        if (L.shouldFireBeacon(surplus)) { beacon = { ngo: NGOS[L.hsh(surplus) % NGOS.length], kg: surplus }; store.addNgo({ ...beacon, meal: label, at: stamp() }) }
        store.addAudit('WASTE_LOG_CREATED', user.username, `${label}: waste ${total.toFixed(1)} kg; surplus ${surplus.toFixed(1)} kg${beacon ? `; NGO ${beacon.ngo} alerted` : ''}`, stamp());
      });
      return { beacon, state: buildState(user) };
    },

    'POST /api/simulate': async ({ user, body }) => {
      need(user, 'supervisor'); needDemo();
      const { day, meal } = mealRef(body), k = `${day}-${meal}`, c = clock();
      const others = L.baseOut(day, meal, (c.dayIdx + 1) % 7) + (store.realOptCounts()[k] || 0);
      store.setSim(day, meal, Math.max(0, 15 - others));
      store.addAudit('SIMULATE_OPT_OUTS', user.username, `Simulated 15 opt-outs for ${MENU[day][meal].t} (${k})`, stamp());
      return { state: buildState(user) };
    },

    'POST /api/reset': async ({ user }) => {
      need(user, 'supervisor'); needDemo();
      store.resetDemo(); store.addAudit('RESET_DEMO', user.username, 'Reset opt-outs and simulation data', stamp());
      return { state: buildState(user) };
    },

    /* Supervisor-only, audited, and switchable off (MESSMETER_DEMO=0). Students cannot move the clock. */
    'PUT /api/demo-clock': async ({ user, body }) => {
      need(user, 'supervisor'); needDemo();
      if (body.time === null) store.setSetting('demo_clock', null);
      else if (L.parseClock(body.time)) store.setSetting('demo_clock', body.time);
      else throw bad('time must be HH:MM or null');
      store.addAudit('DEMO_CLOCK', user.username, body.time === null ? 'Returned to live server time' : `Demo clock frozen at ${body.time}`, stamp());
      return { state: buildState(user) };
    },

    'GET /api/export/logs.csv': async ({ user }) => {
      need(user, 'supervisor');
      const rows = [['id', 'meal', 'items', 'waste_kg', 'surplus_kg', 'logged_by', 'logged_at'], ...store.logs(1000).map(l => [l.id, l.meal, l.items, l.total, l.surplus, l.loggedBy, l.at])];
      return { csv: rows.map(r => r.map(L.csvCell).join(',')).join('\r\n') + '\r\n' };
    },
  };
  const PUBLIC = new Set(['GET /api/health', 'POST /api/login']);

  /* ---------- dispatcher ---------- */
  function send(res, status, data, type = 'application/json; charset=utf-8', extra = {}) {
    res.writeHead(status, { 'Content-Type': type, ...SECURITY, ...extra });
    res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'), sig = `${req.method} ${url.pathname}`;
      if (url.pathname.startsWith('/api/')) {
        const handler = routes[sig];
        if (!handler) { const known = Object.keys(routes).some(r => r.endsWith(' ' + url.pathname)); throw bad(known ? 'Method not allowed' : 'Not found', known ? 405 : 404) }
        const ctx = { req, url, user: PUBLIC.has(sig) ? null : authenticate(req), body: (req.method === 'POST' || req.method === 'PUT') ? await readJson(req) : {} };
        const out = await handler(ctx);
        if (out.csv !== undefined) return send(res, 200, out.csv, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="messmeter-waste-logs.csv"' });
        return send(res, 200, out);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw bad('Method not allowed', 405);
      const file = STATIC[url.pathname];
      if (!file) throw bad('Not found', 404);
      return send(res, 200, await readFile(path.join(ROOT, file)), TYPES[path.extname(file)]);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message }, undefined, err.status === 413 ? { Connection: 'close' } : {});
      log('request_error', err); console.error(new Date().toISOString(), 'request_error', err);
      return send(res, 500, { error: 'Internal server error' });
    }
  });
  return { server, store, close: () => new Promise(r => server.close(() => { store.close(); r() })) };
}

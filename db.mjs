/* SQLite persistence (node:sqlite, built into Node 22+). Every multi-statement change runs in a transaction. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashPassword } from './auth.mjs';
import { POLL_SEED } from './data.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('student','supervisor')), pass_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS opt_outs (user_id INTEGER NOT NULL REFERENCES users(id), day INTEGER NOT NULL CHECK (day BETWEEN 0 AND 6), meal TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, day, meal));
CREATE TABLE IF NOT EXISTS sim_opt_outs (day INTEGER NOT NULL, meal TEXT NOT NULL, count INTEGER NOT NULL CHECK (count BETWEEN 0 AND 50), PRIMARY KEY (day, meal));
CREATE TABLE IF NOT EXISTS waste_logs (id INTEGER PRIMARY KEY, meal TEXT NOT NULL, items TEXT NOT NULL, total REAL NOT NULL, surplus REAL NOT NULL, logged_by TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ngo_alerts (id INTEGER PRIMARY KEY, ngo TEXT NOT NULL, kg REAL NOT NULL, meal TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ratings (dish TEXT PRIMARY KEY, stars INTEGER NOT NULL, votes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, meal TEXT NOT NULL, stars TEXT NOT NULL, text TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS poll_votes (user_id INTEGER PRIMARY KEY REFERENCES users(id), option INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, action TEXT NOT NULL, actor TEXT NOT NULL, details TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export const SEED_USERS = [
  { username: 'aarav', name: 'Aarav Mehta', role: 'student' },
  { username: 'diya', name: 'Diya Nair', role: 'student' },
  { username: 'kabir', name: 'Kabir Singh', role: 'student' },
  { username: 'supervisor', name: 'Mess Supervisor', role: 'supervisor' },
];

export function openStore(file = ':memory:', { studentPassword = 'student123', supervisorPassword = 'supervisor123' } = {}) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    addUser: db.prepare('INSERT INTO users (username, name, role, pass_hash) VALUES (?, ?, ?, ?)'),
    myOpts: db.prepare('SELECT day, meal FROM opt_outs WHERE user_id = ?'),
    hasOpt: db.prepare('SELECT 1 AS x FROM opt_outs WHERE user_id = ? AND day = ? AND meal = ?'),
    addOpt: db.prepare('INSERT INTO opt_outs (user_id, day, meal, created_at) VALUES (?, ?, ?, ?)'),
    delOpt: db.prepare('DELETE FROM opt_outs WHERE user_id = ? AND day = ? AND meal = ?'),
    optTotals: db.prepare('SELECT day, meal, COUNT(*) AS n FROM opt_outs GROUP BY day, meal'),
    clearOpts: db.prepare('DELETE FROM opt_outs'),
    simAll: db.prepare('SELECT day, meal, count FROM sim_opt_outs'),
    simSet: db.prepare('INSERT INTO sim_opt_outs (day, meal, count) VALUES (?, ?, ?) ON CONFLICT(day, meal) DO UPDATE SET count = excluded.count'),
    simClear: db.prepare('DELETE FROM sim_opt_outs'),
    addLog: db.prepare('INSERT INTO waste_logs (meal, items, total, surplus, logged_by, at) VALUES (?, ?, ?, ?, ?, ?)'),
    logs: db.prepare('SELECT id, meal, items, total, surplus, logged_by AS loggedBy, at FROM waste_logs ORDER BY id DESC LIMIT ?'),
    wasteSum: db.prepare('SELECT COALESCE(SUM(total), 0) AS kg FROM waste_logs'),
    addNgo: db.prepare('INSERT INTO ngo_alerts (ngo, kg, meal, at) VALUES (?, ?, ?, ?)'),
    ngos: db.prepare('SELECT id, ngo, kg, meal, at FROM ngo_alerts ORDER BY id DESC LIMIT ?'),
    ngoTotals: db.prepare('SELECT COUNT(*) AS alerts, COALESCE(SUM(kg), 0) AS kg FROM ngo_alerts'),
    rateUp: db.prepare('INSERT INTO ratings (dish, stars, votes) VALUES (?, ?, 1) ON CONFLICT(dish) DO UPDATE SET stars = stars + excluded.stars, votes = votes + 1'),
    rateAll: db.prepare('SELECT dish, stars, votes FROM ratings'),
    addCmt: db.prepare('INSERT INTO comments (meal, stars, text, author, at) VALUES (?, ?, ?, ?, ?)'),
    cmts: db.prepare('SELECT meal, stars, text, author, at FROM comments ORDER BY id DESC LIMIT ?'),
    myVote: db.prepare('SELECT option FROM poll_votes WHERE user_id = ?'),
    addVote: db.prepare('INSERT INTO poll_votes (user_id, option) VALUES (?, ?)'),
    voteTotals: db.prepare('SELECT option, COUNT(*) AS n FROM poll_votes GROUP BY option'),
    addAudit: db.prepare('INSERT INTO audit (action, actor, details, at) VALUES (?, ?, ?, ?)'),
    audit: db.prepare('SELECT action, actor, details, at FROM audit ORDER BY id DESC LIMIT ?'),
    getSet: db.prepare('SELECT value FROM settings WHERE key = ?'),
    putSet: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    delSet: db.prepare('DELETE FROM settings WHERE key = ?'),
  };

  /** Run `fn` atomically; rolls back on any exception. */
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } };

  if (q.userCount.get().n === 0) {
    tx(() => { for (const u of SEED_USERS) q.addUser.run(u.username, u.name, u.role, hashPassword(u.role === 'supervisor' ? supervisorPassword : studentPassword)) });
  }
  if (!q.getSet.get('secret')) q.putSet.run('secret', randomBytes(32).toString('hex'));

  const key = (d, m) => `${d}-${m}`;
  return {
    close: () => db.close(),
    tx,
    secret: () => q.getSet.get('secret').value,
    setting: k => q.getSet.get(k)?.value ?? null,
    setSetting: (k, v) => (v == null ? q.delSet.run(k) : q.putSet.run(k, String(v))),
    userByName: name => q.userByName.get(String(name)) ?? null,

    myOptOuts: uid => Object.fromEntries(q.myOpts.all(uid).map(r => [key(r.day, r.meal), true])),
    /** Toggle in one transaction; returns the new state (true = opted out). */
    toggleOptOut: (uid, day, meal, at) => tx(() => {
      if (q.hasOpt.get(uid, day, meal)) { q.delOpt.run(uid, day, meal); return false }
      q.addOpt.run(uid, day, meal, at); return true;
    }),
    realOptCounts: () => Object.fromEntries(q.optTotals.all().map(r => [key(r.day, r.meal), r.n])),
    simCounts: () => Object.fromEntries(q.simAll.all().map(r => [key(r.day, r.meal), r.count])),
    setSim: (d, m, n) => q.simSet.run(d, m, n),
    resetDemo: () => tx(() => { q.clearOpts.run(); q.simClear.run() }),

    addLog: l => q.addLog.run(l.meal, l.items, l.total, l.surplus, l.by, l.at),
    logs: (n = 20) => q.logs.all(n),
    wasteTotal: () => +q.wasteSum.get().kg.toFixed(1),
    addNgo: a => q.addNgo.run(a.ngo, a.kg, a.meal, a.at),
    ngoAlerts: (n = 10) => q.ngos.all(n),
    ngoTotals: () => q.ngoTotals.get(),

    addRatings: (map, comment) => tx(() => { for (const [dish, s] of Object.entries(map)) q.rateUp.run(dish, s); if (comment) q.addCmt.run(comment.meal, comment.stars, comment.text, comment.author, comment.at) }),
    ratings: () => Object.fromEntries(q.rateAll.all().map(r => [r.dish, [r.stars, r.votes]])),
    comments: (n = 6) => q.cmts.all(n),

    myVote: uid => q.myVote.get(uid)?.option ?? null,
    /** One vote per user, enforced by the primary key. Returns false if already voted. */
    castVote: (uid, option) => tx(() => { if (q.myVote.get(uid)) return false; q.addVote.run(uid, option); return true }),
    votes: n => { const v = [...POLL_SEED].slice(0, n); for (const r of q.voteTotals.all()) if (r.option >= 0 && r.option < n) v[r.option] += r.n; return v },

    addAudit: (action, actor, details, at) => q.addAudit.run(action, actor, String(details).slice(0, 300), at),
    audit: (n = 20) => q.audit.all(n),
  };
}

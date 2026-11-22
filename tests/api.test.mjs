/* End-to-end API tests: boots the real HTTP app in-process on an ephemeral port and talks to it with fetch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { createApp } from '../app.mjs';
import { MENU } from '../data.js';

const MON_NOON_IST = new Date('2026-11-23T06:30:00Z');   // Monday 12:00 campus time

async function boot(opts = {}) {
  const app = createApp({ now: () => MON_NOON_IST, ...opts });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, { token, body, raw } = {}) => {
    const r = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: type.includes('json') ? await r.json() : await r.text() };
  };
  const login = async (username, password) => (await call('POST', '/api/login', { body: { username, password } })).body.token;
  return { app, call, login, base, close: () => app.close() };
}
const withApp = (name, fn, opts) => test(name, async () => { const h = await boot(opts); try { await fn(h) } finally { await h.close() } });

withApp('health is public; everything else needs a token', async ({ call }) => {
  assert.equal((await call('GET', '/api/health')).body.ok, true);
  for (const [m, u] of [['GET', '/api/state'], ['POST', '/api/optout'], ['POST', '/api/logs'], ['GET', '/api/export/logs.csv']]) {
    assert.equal((await call(m, u, m === 'POST' ? { body: {} } : {})).status, 401, `${m} ${u}`);
  }
});

withApp('static whitelist: server code, tests and the database are not downloadable', async ({ call }) => {
  for (const p of ['/', '/script.js', '/logic.js', '/data.js', '/style.css']) assert.equal((await call('GET', p)).status, 200, p);
  for (const p of ['/server.mjs', '/app.mjs', '/db.mjs', '/auth.mjs', '/package.json', '/tests/api.test.mjs', '/data/messmeter.sqlite', '/../server.mjs', '/%2e%2e/server.mjs']) assert.equal((await call('GET', p)).status, 404, p);
});

withApp('responses carry security headers', async ({ call }) => {
  const r = await call('GET', '/');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
});

withApp('login: wrong credentials rejected, throttled after repeated failures', async ({ call }) => {
  assert.equal((await call('POST', '/api/login', { body: { username: 'aarav', password: 'nope' } })).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { username: 'ghost', password: 'nope' } })).status, 401);
  assert.equal((await call('POST', '/api/login', { raw: '{bad', body: undefined })).status, 415);
  let last; for (let i = 0; i < 10; i++) last = await call('POST', '/api/login', { body: { username: 'aarav', password: 'wrong' } });
  assert.equal(last.status, 429);
});

withApp('tampered and forged tokens are refused', async ({ call, login }) => {
  const t = await login('aarav', 'student123');
  assert.equal((await call('GET', '/api/state', { token: t })).status, 200);
  const [h, , s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'supervisor', role: 'supervisor', exp: 9e9 })).toString('base64url');
  assert.equal((await call('GET', '/api/state', { token: `${h}.${forged}.${s}` })).status, 401);
});

withApp('role-based access control', async ({ call, login }) => {
  const stu = await login('aarav', 'student123'), sup = await login('supervisor', 'supervisor123');
  const waste = { day: 0, meal: 'lunch', waste: [1, 0, 0], surplus: 0 };
  assert.equal((await call('POST', '/api/logs', { token: stu, body: waste })).status, 403);
  assert.equal((await call('POST', '/api/simulate', { token: stu, body: { day: 0, meal: 'lunch' } })).status, 403);
  assert.equal((await call('PUT', '/api/demo-clock', { token: stu, body: { time: '23:00' } })).status, 403);
  assert.equal((await call('GET', '/api/export/logs.csv', { token: stu })).status, 403);
  assert.equal((await call('POST', '/api/optout', { token: sup, body: { day: 1, meal: 'lunch' } })).status, 403);
  assert.equal((await call('POST', '/api/vote', { token: sup, body: { option: 0 } })).status, 403);
  const st = (await call('GET', '/api/state', { token: stu })).body;
  assert.deepEqual([st.audit, st.ngoAlerts, st.logs], [[], [], []]);   // supervisor data is not sent to students
});

withApp('opt-out: 6-hour cutoff enforced on the server clock', async ({ call, login }) => {
  const stu = await login('aarav', 'student123'), sup = await login('supervisor', 'supervisor123');
  // Monday 12:00: Monday dinner (20:00) cutoff is 14:00, so still open.
  let r = await call('POST', '/api/optout', { token: stu, body: { day: 0, meal: 'dinner' } });
  assert.equal(r.status, 200); assert.equal(r.body.on, true); assert.equal(r.body.state.me['0-dinner'], true);
  // Supervisor freezes the demo clock at 15:00 -> cutoff has passed for every user.
  assert.equal((await call('PUT', '/api/demo-clock', { token: sup, body: { time: '15:00' } })).status, 200);
  r = await call('POST', '/api/optout', { token: stu, body: { day: 0, meal: 'dinner' } });
  assert.equal(r.status, 409); assert.match(r.body.error, /Cutoff passed/);
  // A student-supplied clock in the body is ignored entirely.
  r = await call('POST', '/api/optout', { token: stu, body: { day: 0, meal: 'dinner', time: '09:00', demoTime: '09:00', now: '2026-11-23T09:00:00' } });
  assert.equal(r.status, 409);
  // Back to live time (12:00) -> allowed again.
  await call('PUT', '/api/demo-clock', { token: sup, body: { time: null } });
  assert.equal((await call('POST', '/api/optout', { token: stu, body: { day: 0, meal: 'dinner' } })).status, 200);
});

withApp('opt-outs are per student and aggregate into the kitchen headcount', async ({ call, login }) => {
  const a = await login('aarav', 'student123'), d = await login('diya', 'student123');
  const before = (await call('GET', '/api/state', { token: a })).body.optCounts['1-lunch'];
  await call('POST', '/api/optout', { token: a, body: { day: 1, meal: 'lunch' } });
  await call('POST', '/api/optout', { token: d, body: { day: 1, meal: 'lunch' } });
  const sa = (await call('GET', '/api/state', { token: a })).body;
  assert.equal(sa.optCounts['1-lunch'], before + 2);
  assert.equal(Object.keys(sa.me).length, 1);                       // aarav only sees his own
  assert.equal((await call('POST', '/api/optout', { token: a, body: { day: 1, meal: 'lunch' } })).body.on, false);   // toggle back
});

withApp('opt-out input validation', async ({ call, login }) => {
  const t = await login('aarav', 'student123');
  for (const body of [{}, { day: 9, meal: 'lunch' }, { day: 0, meal: 'brunch' }, { day: '0', meal: 'lunch' }, { day: 0, meal: '__proto__' }]) {
    assert.equal((await call('POST', '/api/optout', { token: t, body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', '/api/optout', { token: t, raw: '[]', body: undefined })).status, 415);
});

withApp('demo tools can be disabled for production', async ({ call, login }) => {
  const sup = await login('supervisor', 'supervisor123');
  for (const [m, u, b] of [['PUT', '/api/demo-clock', { time: '23:00' }], ['POST', '/api/reset', {}], ['POST', '/api/simulate', { day: 0, meal: 'lunch' }]]) {
    assert.equal((await call(m, u, { token: sup, body: b })).status, 403, u);
  }
  const st = (await call('GET', '/api/state', { token: sup })).body;
  assert.equal(st.clock.demo, false); assert.equal(st.clock.demoAvailable, false);
}, { demo: false });

withApp('waste log: validation, NGO beacon above 15 kg, ledger, audit, impact', async ({ call, login }) => {
  const sup = await login('supervisor', 'supervisor123');
  const post = body => call('POST', '/api/logs', { token: sup, body });
  assert.equal((await post({ day: 0, meal: 'lunch', waste: [1, 2], surplus: 0 })).status, 400);       // wrong length
  assert.equal((await post({ day: 0, meal: 'lunch', waste: [-1, 0, 0], surplus: 0 })).status, 400);   // negative
  assert.equal((await post({ day: 0, meal: 'lunch', waste: [0, 0, 0], surplus: 0 })).status, 400);    // nothing logged
  assert.equal((await post({ day: 0, meal: 'lunch', waste: ['abc', 0, 0], surplus: 0 })).status, 400);
  assert.equal((await post({ day: 0, meal: 'lunch', waste: [1, 0, 0], surplus: 501 })).status, 400);
  let r = await post({ day: 0, meal: 'lunch', waste: [1.5, 0, 0.5], surplus: 15 });
  assert.equal(r.status, 200); assert.equal(r.body.beacon, null);                                        // exactly 15 kg: no beacon
  r = await post({ day: 2, meal: 'dinner', waste: [0, 2, 0], surplus: 20 });
  assert.equal(r.body.beacon.kg, 20); assert.ok(r.body.beacon.ngo);
  const st = r.body.state;
  assert.equal(st.logs.length, 2); assert.equal(st.logs[0].total, 2); assert.equal(st.loggedKg, 4);
  assert.equal(st.ngoAlerts.length, 1);
  assert.deepEqual([st.impact.kg, st.impact.meals, st.impact.co2Kg], [20, 50, 50]);
  assert.ok(st.audit.some(a => a.action === 'WASTE_LOG_CREATED' && a.actor === 'supervisor'));
});

withApp('ratings and comments are validated against the real menu', async ({ call, login }) => {
  const t = await login('aarav', 'student123'), dish = MENU[0].lunch.d[0];
  const post = body => call('POST', '/api/ratings', { token: t, body: { day: 0, meal: 'lunch', ...body } });
  assert.equal((await post({ ratings: { 'Not a dish': 5 } })).status, 400);
  assert.equal((await post({ ratings: { [dish]: 6 } })).status, 400);
  assert.equal((await post({ ratings: { [dish]: 2.5 } })).status, 400);
  assert.equal((await post({ ratings: {} })).status, 400);
  assert.equal((await post({ ratings: { [dish]: 5 }, comment: 'x'.repeat(281) })).status, 400);
  const r = await post({ ratings: { [dish]: 5 }, comment: '  <b>great</b>   dal ' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.state.ratings[dish], [5, 1]);
  assert.equal(r.body.state.comments[0].text, '<b>great</b> dal');   // stored raw; the UI escapes on render
});

withApp('poll: one vote per student, even under concurrent requests', async ({ call, login }) => {
  const t = await login('aarav', 'student123');
  const results = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/api/vote', { token: t, body: { option: 1 } })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 7);
  const st = (await call('GET', '/api/state', { token: t })).body;
  assert.equal(st.voted, 1); assert.equal(st.votes[1], 25);                  // seed 24 + 1
  assert.equal((await call('POST', '/api/vote', { token: await login('diya', 'student123'), body: { option: 7 } })).status, 400);
});

withApp('CSV export neutralises spreadsheet formulas and requires supervisor', async ({ call, login, app }) => {
  const sup = await login('supervisor', 'supervisor123');
  app.store.addLog({ meal: '=cmd|calc', items: 'a,b', total: 1, surplus: 0, by: 'supervisor', at: new Date().toISOString() });
  const r = await call('GET', '/api/export/logs.csv', { token: sup });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.body, /id,meal,items,waste_kg/);
  assert.ok(r.body.includes("'=cmd|calc")); assert.ok(r.body.includes('"a,b"'));
});

test('data survives a restart (SQLite persistence)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mm-')), dbFile = path.join(dir, 'x.sqlite');
  try {
    let h = await boot({ dbFile }); let t = await h.login('aarav', 'student123');
    await h.call('POST', '/api/optout', { token: t, body: { day: 3, meal: 'lunch' } });
    const sup = await h.login('supervisor', 'supervisor123');
    await h.call('POST', '/api/logs', { token: sup, body: { day: 0, meal: 'lunch', waste: [3, 0, 0], surplus: 0 } });
    const token = t; await h.close();
    h = await boot({ dbFile });
    const st = await h.call('GET', '/api/state', { token });                // same signing secret persisted -> old token still valid
    assert.equal(st.body.me['3-lunch'], true); assert.equal(st.body.loggedKg, 3);
    await h.close();
  } finally { rmSync(dir, { recursive: true, force: true }) }
});

withApp('malformed requests never crash the server', async ({ call, login, base }) => {
  const t = await login('supervisor', 'supervisor123');
  assert.equal((await call('POST', '/api/logs', { token: t, raw: '{"day":', body: undefined })).status, 415);
  const r = await fetch(base + '/api/logs', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: '{"day":' });
  assert.equal(r.status, 400);
  const big = await fetch(base + '/api/logs', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ pad: 'x'.repeat(200_000) }) });
  assert.equal(big.status, 413);
  assert.equal((await call('DELETE', '/api/state', { token: t })).status, 405);
  assert.equal((await call('GET', '/api/nope', { token: t })).status, 404);
  assert.equal((await call('GET', '/api/health')).status, 200);
});

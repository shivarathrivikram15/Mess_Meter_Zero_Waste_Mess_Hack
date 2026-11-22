import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, signToken, verifyToken, createLimiter } from '../auth.mjs';

test('password hashing is salted and verifiable', () => {
  const a = hashPassword('secret'), b = hashPassword('secret');
  assert.notEqual(a, b);
  assert.equal(verifyPassword('secret', a), true);
  assert.equal(verifyPassword('Secret', a), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
});
test('tokens verify, expire and resist tampering', () => {
  const t = signToken({ sub: 'aarav', role: 'student' }, 'k', 60, 1_000_000);
  assert.equal(verifyToken(t, 'k', 1_000_000 + 30_000).sub, 'aarav');
  assert.equal(verifyToken(t, 'k', 1_000_000 + 61_000), null);          // expired
  assert.equal(verifyToken(t, 'other-key', 1_000_000), null);           // wrong secret
  const [h, p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'supervisor', role: 'supervisor', exp: 9e9 })).toString('base64url');
  assert.equal(verifyToken(`${h}.${forged}.${s}`, 'k', 1_000_000), null); // payload swapped
  const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  assert.equal(verifyToken(`${none}.${p}.`, 'k', 1_000_000), null);       // alg=none
  assert.equal(verifyToken('a.b', 'k'), null);
  assert.equal(verifyToken(undefined, 'k'), null);
});
test('limiter blocks after max attempts inside the window', () => {
  const l = createLimiter(3, 1000);
  assert.deepEqual([1, 2, 3, 4].map(() => l.allow('ip', 0)), [true, true, true, false]);
  assert.equal(l.allow('ip', 2000), true);       // window slid
  l.reset('ip'); assert.equal(l.allow('ip', 2001), true);
});

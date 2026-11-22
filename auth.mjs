/* Password hashing (scrypt) and signed session tokens (HS256, JWT-compatible) using only node:crypto. */
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `scrypt$${salt}$${scryptSync(String(password), salt, 32).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const a = scryptSync(String(password), salt, 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const sign = (data, secret) => createHmac('sha256', secret).update(data).digest('base64url');

export function signToken(payload, secret, ttlSeconds = 8 * 3600, now = Date.now()) {
  const body = { ...payload, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttlSeconds };
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(body)}`;
  return `${data}.${sign(data, secret)}`;
}

/** Returns the payload, or null if the token is malformed, tampered with, or expired. */
export function verifyToken(token, secret, now = Date.now()) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts, expected = sign(`${h}.${p}`, secret);
  const a = Buffer.from(s), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    if (JSON.parse(Buffer.from(h, 'base64url')).alg !== 'HS256') return null;
    const body = JSON.parse(Buffer.from(p, 'base64url'));
    return typeof body.exp === 'number' && body.exp * 1000 > now ? body : null;
  } catch { return null }
}

/** Small in-memory sliding-window limiter, used to slow down password guessing. */
export function createLimiter(max, windowMs) {
  const hits = new Map();
  return {
    /** Records an attempt for `key`; returns false once the limit is exceeded. */
    allow(key, now = Date.now()) {
      const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
      recent.push(now); hits.set(key, recent);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
      return recent.length <= max;
    },
    reset(key) { hits.delete(key) },
  };
}

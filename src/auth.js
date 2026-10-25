'use strict';
const crypto = require('node:crypto');
const { HttpError, parseCookies } = require('./http');

const COOKIE = 'cg_session';
const SESSION_DAYS = 14;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  return token;
}

function sessionCookie(token, maxAgeSec) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

function currentUser(db, req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db
    .prepare(`SELECT u.id, u.name, u.email, u.role, s.expires_at FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.active = 1`)
    .get(sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role, tokenHash: sha256(token) };
}

function requireUser(db, req) {
  const user = currentUser(db, req);
  if (!user) throw new HttpError(401, 'Please sign in');
  // CSRF defence in depth (cookie is already SameSite=Strict): state-changing requests must be same-origin.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
  }
  return user;
}

function ensureOwner(db) {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) return null;
  const email = process.env.ADMIN_EMAIL || 'owner@chobbargarage.com';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'owner')").run('Owner', email, hashPassword(password));
  return process.env.ADMIN_PASSWORD ? { email } : { email, password };
}

module.exports = { COOKIE, SESSION_DAYS, hashPassword, verifyPassword, createSession, sessionCookie, currentUser, requireUser, ensureOwner, sha256 };

'use strict';

// Strom Fire sign-in: single owner account, zero dependencies.
// - Password lives ONLY in the STROMFIRE_PASSWORD env var (never in code/logs).
// - Verified with scrypt (N=16384, r=8, p=1, 64-byte key) + per-boot salt,
//   compared with timingSafeEqual. Unknown usernames are verified against a
//   dummy hash so success/failure timing doesn't reveal whether an account
//   exists.
// - Sessions are random 256-bit tokens in a server-side Map, carried in an
//   HttpOnly SameSite=Lax cookie. No auth state ever lives in client JS.
// - If STROMFIRE_PASSWORD is unset, auth is DISABLED (dev/test open mode) and
//   the server says so at boot. Set it in production.

const crypto = require('crypto');

const USERNAME = process.env.STROMFIRE_USER || 'admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 h absolute
const SESSION_REFRESH_MS = 6 * 60 * 60 * 1000; // extend when <6 h left
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX = 10; // attempts per IP per minute

const authEnabled = !!process.env.STROMFIRE_PASSWORD;

// In-memory credential (salted scrypt hash). Salt is per-boot; verification
// re-hashes the candidate with the same salt, so no persistence is needed.
let credential = null;
let dummyHash = null;
function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
}
if (authEnabled) {
  const salt = crypto.randomBytes(16);
  credential = { username: USERNAME, salt, hash: scryptHash(process.env.STROMFIRE_PASSWORD, salt) };
  dummyHash = scryptHash(crypto.randomBytes(16).toString('hex'), crypto.randomBytes(16));
}

function verifyPassword(username, password) {
  if (!authEnabled || typeof password !== 'string' || password.length === 0) return false;
  try {
    if (credential && username === credential.username) {
      return crypto.timingSafeEqual(scryptHash(password, credential.salt), credential.hash);
    }
    // Unknown user: same-cost dummy compare (no account oracle via timing).
    crypto.timingSafeEqual(scryptHash(password, crypto.randomBytes(16)), dummyHash);
    return false;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------- sessions
const sessions = new Map(); // token -> { username, createdAt, expiresAt }
function pruneSessions() {
  if (sessions.size < 1000) return;
  const now = Date.now();
  for (const [tok, s] of sessions) {
    if (s.expiresAt <= now) sessions.delete(tok);
  }
}
function createSession(username) {
  pruneSessions();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, { username, createdAt: now, expiresAt: now + SESSION_TTL_MS });
  return token;
}
// Returns { username, refresh:boolean } or null. Refresh extends sliding expiry.
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (s.expiresAt <= now) { sessions.delete(token); return null; }
  let refresh = false;
  if (s.expiresAt - now < SESSION_REFRESH_MS) {
    s.expiresAt = now + SESSION_TTL_MS;
    refresh = true;
  }
  return { username: s.username, refresh };
}
function destroySession(token) {
  if (token) sessions.delete(token);
}

// ------------------------------------------------------------ login throttle
const loginBuckets = new Map(); // ip -> [timestamps]
function loginAllowed(ip) {
  const now = Date.now();
  let arr = loginBuckets.get(ip);
  if (!arr) { arr = []; loginBuckets.set(ip, arr); }
  while (arr.length && now - arr[0] > LOGIN_WINDOW_MS) arr.shift();
  if (arr.length >= LOGIN_MAX) return false;
  arr.push(now);
  return true;
}

// ------------------------------------------------------------------ cookies
function parseCookies(req) {
  const out = {};
  const hdr = req.headers && req.headers.cookie;
  if (!hdr) return out;
  for (const part of String(hdr).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = decodeURIComponent(v);
  }
  return out;
}
const SESSION_COOKIE = 'stromfire_session';
function sessionCookieHeader(token, req, maxAgeSec) {
  // Secure only when the request actually arrived over TLS (or the server
  // runs with TLS certs); otherwise browsers would drop the cookie on http.
  const secure = req && req.socket && req.socket.encrypted;
  let c = `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
  if (secure) c += '; Secure';
  return c;
}
function clearCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
// Session token for this request (null when auth disabled or absent).
function requestSession(req) {
  if (!authEnabled) return { username: USERNAME, devOpen: true, refresh: false };
  const cookies = parseCookies(req);
  const s = getSession(cookies[SESSION_COOKIE]);
  return s ? { username: s.username, refresh: s.refresh } : null;
}

module.exports = {
  authEnabled,
  USERNAME,
  SESSION_TTL_MS,
  SESSION_COOKIE,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  loginAllowed,
  parseCookies,
  sessionCookieHeader,
  clearCookieHeader,
  requestSession,
};

'use strict';
// Auth matrix for Strom Fire sign-in. Spawns its own server on 8799 with a
// known owner password — never touches your real env or data.
// Usage: node scripts/authtest.js (exits non-zero on failure)
const http = require('http');
const { spawn } = require('child_process');

const PORT = 8799;
const USER = 'authtest-admin';
const PASS = 'correct-horse-TEMP-pass-1';
const TOKEN = 'authtest-token-1';

let passed = 0;
let failed = 0;
function ok(name, detail) { passed++; console.log(`  PASS: ${name}${detail ? ' -- ' + detail : ''}`); }
function fail(name, reason) { failed++; console.log(`  FAIL: ${name} -- ${reason}`); }
function check(name, cond, detail) { if (cond) ok(name, detail); else fail(name, detail || 'assertion false'); }

function req(method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, opts.headers || {});
    if (opts.cookie) headers.cookie = opts.cookie;
    let body = null;
    if (opts.json !== undefined) {
      body = typeof opts.json === 'string' ? opts.json : JSON.stringify(opts.json);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const cookieOf = (res) => {
  const sc = res.headers['set-cookie'];
  if (!sc || !sc.length) return null;
  return sc[0].split(';')[0];
};
const noLeak = (body) => !body.includes(PASS);

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await req('GET', '/api/health');
      if (r.status === 200) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const srv = spawn('node', ['server.js'], {
    cwd: __dirname + '/..',
    env: Object.assign({}, process.env, {
      PORT: String(PORT), STROMFIRE_USER: USER, STROMFIRE_PASSWORD: PASS, LOADSTORM_TOKEN: TOKEN,
    }),
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 500));
  try {
    check('server boots with password set', await waitForHealth());

    // --- public surface ---
    let r = await req('GET', '/');
    check('GET / without session redirects to login', r.status === 302 && (r.headers.location || '').includes('/login.html'), `status=${r.status}`);
    r = await req('GET', '/login.html');
    check('login page is public', r.status === 200 && r.body.includes('Sign In'), `status=${r.status}`);
    check('login page leaks no descriptive text', !/Owner access only|Protected area|no sign-up/i.test(r.body), 'page is bare');
    check('login drawer animations present', r.body.includes('conic-gradient') && r.body.includes('data-active') && r.body.includes('Signing in'), 'drawer+spinner wired');
    r = await req('GET', '/api/health');
    check('health stays public', r.status === 200, `status=${r.status}`);
    r = await req('GET', '/api/auth-status');
    let st = JSON.parse(r.body);
    check('auth-status reports enabled+unauthed', st.authEnabled === true && st.authed === false, r.body.slice(0, 80));

    // --- gated surface, no session ---
    r = await req('GET', '/api/status');
    check('status without session is 401', r.status === 401, `status=${r.status}`);
    r = await req('GET', '/api/report');
    check('report without session is 401', r.status === 401, `status=${r.status}`);
    r = await req('GET', '/api/stream');
    check('stream without session is 401', r.status === 401, `status=${r.status}`);
    r = await req('GET', '/demo/fast');
    check('demo without session is 401', r.status === 401, `status=${r.status}`);
    r = await req('GET', '/api/tor-status');
    check('tor-status without session is 401', r.status === 401, `status=${r.status}`);
    r = await req('POST', '/api/start', { json: { url: 'http://127.0.0.1:9/', confirm: true } });
    check('start without session is 401', r.status === 401, `status=${r.status}`);

    // --- login failures: generic, no oracle, no leak ---
    r = await req('POST', '/api/login', { json: { username: USER, password: 'wrong-pass' } });
    check('wrong password is 401 generic', r.status === 401 && r.body.includes('Invalid username or password'), `status=${r.status}`);
    check('wrong password sets no cookie', !r.headers['set-cookie'], 'has set-cookie=' + !!r.headers['set-cookie']);
    check('wrong password leaks nothing', noLeak(r.body));
    r = await req('POST', '/api/login', { json: { username: 'nosuchuser', password: 'wrong-pass' } });
    check('unknown user gets SAME message', r.status === 401 && r.body.includes('Invalid username or password'), `status=${r.status}`);
    r = await req('POST', '/api/login', { json: {} });
    check('empty body is 401, no crash', r.status === 401, `status=${r.status}`);
    r = await req('POST', '/api/login', { json: { username: USER, password: 'x' }, headers: { origin: 'https://evil.example' } });
    check('cross-origin login refused', r.status === 403, `status=${r.status}`);

    // --- login success ---
    r = await req('POST', '/api/login', { json: { username: USER, password: PASS } });
    const sessionCookie = cookieOf(r);
    check('correct login is 200', r.status === 200, `status=${r.status}`);
    check('session cookie issued', !!sessionCookie, sessionCookie);
    const flags = (r.headers['set-cookie'] || []).join(';');
    check('cookie is HttpOnly', /httponly/i.test(flags), flags.slice(0, 120));
    check('cookie is SameSite=Lax', /samesite=lax/i.test(flags), flags.slice(0, 120));
    check('login response leaks nothing', noLeak(r.body) && !r.body.includes('hash'), r.body.slice(0, 80));

    // --- authed surface ---
    r = await req('GET', '/', { cookie: sessionCookie });
    check('dashboard loads with session', r.status === 200 && r.body.includes('Strom Fire'), `status=${r.status}`);
    r = await req('GET', '/api/status', { cookie: sessionCookie });
    check('status works with session', r.status === 200, `status=${r.status}`);
    r = await req('GET', '/api/demo-target', { cookie: sessionCookie });
    check('demo-target works with session', r.status === 200, `status=${r.status}`);
    r = await req('GET', '/api/tor-status', { cookie: sessionCookie });
    let torShape = false;
    try { const t = JSON.parse(r.body); torShape = r.status === 200 && t.ok === true && 'socks' in t && 'control' in t; } catch (_) {}
    check('tor-status works with session', torShape, `status=${r.status}`);
    r = await req('GET', '/api/auth-status', { cookie: sessionCookie });
    st = JSON.parse(r.body);
    check('auth-status shows user', st.authed === true && st.user === USER, r.body.slice(0, 80));
    r = await req('GET', '/api/report', { cookie: 'stromfire_session=tampered' });
    check('tampered cookie is 401', r.status === 401, `status=${r.status}`);

    // --- token still works for automation ---
    r = await req('GET', '/api/status', { headers: { 'x-loadstorm-token': TOKEN } });
    check('API token bypasses session', r.status === 200, `status=${r.status}`);

    // --- logout ---
    r = await req('POST', '/api/logout', { cookie: sessionCookie });
    check('logout is 200 and clears cookie', r.status === 200 && /max-age=0/i.test((r.headers['set-cookie'] || []).join(';')), `status=${r.status}`);
    r = await req('GET', '/api/status', { cookie: sessionCookie });
    check('session dead after logout', r.status === 401, `status=${r.status}`);

    // --- throttle (3 bad attempts above + origin-403s don't count) ---
    let last = null;
    for (let i = 0; i < 8; i++) {
      last = await req('POST', '/api/login', { json: { username: USER, password: 'wrong-again' } });
    }
    check('login throttled after 10/min', last.status === 429, `status=${last.status}`);
  } finally {
    try { srv.kill(); } catch (_) {}
  }

  console.log(`\n============================================================\nSUMMARY: ${passed} passed, ${failed} failed\n============================================================`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('authtest crashed:', e); process.exit(1); });

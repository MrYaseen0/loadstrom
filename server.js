'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { LoadEngine, tlsOptionsForFingerprint } = require('./lib/engine');
const { validateTarget, validateTargetResolved } = require('./lib/safety');
const { redactProxyUrl } = require('./lib/util');
const security = require('./lib/security');
const { pickControlPort } = require('./check-tor-control');
const auth = require('./lib/auth');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const REPORTS_DIR = path.join(__dirname, 'reports');
const MAX_BODY = 64 * 1024; // 64 KB request body cap
const USE_TLS = process.env.USE_TLS === '1' || process.env.HTTPS === '1';
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || path.join(__dirname, 'tls', 'key.pem');
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || path.join(__dirname, 'tls', 'cert.pem');
const API_TOKEN = process.env.LOADSTORM_TOKEN || null;
// Simple in-memory per-IP rate limiter for /api/* (120 req/min sliding window)
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 120;
const rateBuckets = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  let arr = rateBuckets.get(ip);
  if (!arr) { arr = []; rateBuckets.set(ip, arr); }
  while (arr.length && now - arr[0] > RATE_WINDOW_MS) arr.shift();
  if (arr.length === 0 && rateBuckets.size > 1000) {
    // Opportunistic cleanup: drop idle IP buckets to bound memory
    for (const [k, v] of rateBuckets) {
      if (v.length === 0 || now - v[v.length - 1] > RATE_WINDOW_MS) rateBuckets.delete(k);
      if (rateBuckets.size <= 500) break;
    }
  }
  if (arr.length >= RATE_MAX) return true;
  arr.push(now);
  return false;
}
function requireToken(req, res) {
  if (!API_TOKEN) return true;
  const hdr = req.headers['x-loadstorm-token'] || req.headers['x-api-token'];
  const url = new URL(req.url, 'http://localhost');
  if (hdr === API_TOKEN || url.searchParams.get('token') === API_TOKEN) return true;
  sendJson(res, 401, { ok: false, error: 'Missing or invalid API token (set LOADSTORM_TOKEN).' });
  return false;
}
function persistReport(report) {
  try {
    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(REPORTS_DIR, `report-${ts}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(REPORTS_DIR, 'last-report.json'), JSON.stringify(report, null, 2));
    // Prune old reports: keep newest 20 + last-report.json
    const files = fs.readdirSync(REPORTS_DIR).filter((f) => /^report-.*\.json$/.test(f)).sort();
    while (files.length > 20) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(REPORTS_DIR, oldest)); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* persistence is best-effort */ }
}
function loadPersistedReport() {
  try {
    const f = path.join(REPORTS_DIR, 'last-report.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) { /* ignore */ }
  return null;
}

// Bare TCP reachability (same convention as check-tor.js: Tor Browser 9150
// first, then system tor 9050). Fast timeouts so the dashboard button feels
// instant when Tor is down.
function tcpAlive(port, host = '127.0.0.1', ms = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const s = net.createConnection(port, host, () => fin(true));
    function fin(v) {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (_) {}
      resolve(v);
    }
    s.on('error', () => fin(false));
    s.setTimeout(ms, () => fin(false));
  });
}
async function detectTorSocks() {
  if (await tcpAlive(9150)) return 9150;
  if (await tcpAlive(9050)) return 9050;
  return null;
}

function ensureTlsCerts() {
  if (!USE_TLS) return null;
  try {
    fs.accessSync(TLS_KEY_FILE);
    fs.accessSync(TLS_CERT_FILE);
    return { key: fs.readFileSync(TLS_KEY_FILE), cert: fs.readFileSync(TLS_CERT_FILE) };
  } catch (e) {
    // Generate self-signed cert
    const { execSync } = require('child_process');
    const tlsDir = path.dirname(TLS_KEY_FILE);
    if (!fs.existsSync(tlsDir)) fs.mkdirSync(tlsDir, { recursive: true });
    try {
      execSync(
        `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${TLS_KEY_FILE}" -out "${TLS_CERT_FILE}" -subj "/CN=localhost" -days 365`,
        { stdio: 'ignore' }
      );
      return { key: fs.readFileSync(TLS_KEY_FILE), cert: fs.readFileSync(TLS_CERT_FILE) };
    } catch (err) {
      console.warn('Could not generate TLS cert (openssl not found?). Falling back to HTTP.');
      return null;
    }
  }
}

let engine = null;
let lastReport = loadPersistedReport();
const sseClients = new Set();
let sseTimer = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

const REQUEST_TIMEOUT_MS = 5000;

function readBody(req, signal) {
  return new Promise((resolveOuter, rejectOuter) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const resolve = (v) => { if (settled) return; settled = true; cleanup(); resolveOuter(v); };
    const reject = (e) => { if (settled) return; settled = true; cleanup(); rejectOuter(e); };
    const onData = (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // Drain (don't destroy socket) so we can still answer 413
        req.off('data', onData);
        try { req.resume(); } catch (_) { /* ignore */ }
        reject(new Error('Request body too large.'));
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => resolve(Buffer.concat(chunks).toString('utf8'));
    const onError = reject;
    const onAbort = () => reject(new Error('Request timeout'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    if (signal) signal.addEventListener('abort', onAbort);
  });
}

/**
 * Parse a raw HTTP probe response fetched through a proxy.
 * The old code used resp.match(/\{[^}]*\}/) which grabs the first CSS block
 * (e.g. `:root{ --vamtam-... }`) when the target is an HTML page, and then the
 * dashboard displayed CSS as the "IP". Instead:
 *  - split headers/body, decode chunked framing when present (best-effort),
 *  - try real IP-echo JSON shapes first (httpbin {"origin"}, ipify {"ip"}),
 *  - fall back to a bare IPv4 address in the body,
 *  - for HTML targets return status + title + byte count and NO fake IP.
 */
function parseProbeResponse(raw, targetHost) {
  const out = { status: 0, bytes: 0, ip: null, note: null, title: null };
  if (!raw) return out;
  const text = String(raw);
  const headEnd = text.indexOf('\r\n\r\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : '';
  let body = headEnd >= 0 ? text.slice(headEnd + 4) : text;
  const statusLine = head.split('\r\n')[0] || '';
  const sm = statusLine.match(/HTTP\/\S+\s+(\d{3})/);
  if (sm) out.status = Number(sm[1]);
  // Best-effort chunked decoding so JSON bodies survive chunk framing.
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    try {
      let pos = 0;
      let decoded = '';
      while (pos < body.length) {
        const eol = body.indexOf('\r\n', pos);
        if (eol < 0) break;
        const size = parseInt(body.slice(pos, eol).trim(), 16);
        if (!isFinite(size) || size < 0) break;
        if (size === 0) break;
        decoded += body.slice(eol + 2, eol + 2 + size);
        pos = eol + 2 + size + 2;
      }
      if (decoded) body = decoded;
    } catch (_) { /* keep raw body */ }
  }
  out.bytes = Buffer.byteLength(body);
  const trimmed = body.trim();
  // 1) JSON IP-echo services.
  try {
    const start = trimmed.search(/[\[{]/);
    if (start >= 0) {
      const obj = JSON.parse(trimmed.slice(start));
      const cand = (obj && (obj.origin || obj.ip)) || null;
      if (cand) {
        const ip = String(cand).split(',')[0].trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-fA-F:]+$/.test(ip)) {
          out.ip = ip;
          return out;
        }
      }
      // JSON parsed but carries no IP (e.g. an API page) — don't fake one.
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        out.note = `Target ${targetHost} returned JSON without an IP field (status ${out.status}). Use an IP-echo URL (e.g. https://httpbin.org/ip) to see the exit IP.`;
        return out;
      }
    }
  } catch (_) { /* not JSON — continue */ }
  // 2) Bare IPv4 anywhere in a small non-HTML body (api.ipify.org plain text).
  if (!/<html|<!doctype/i.test(body.slice(0, 512)) && out.bytes < 256) {
    const m = body.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
    if (m) {
      out.ip = m[1];
      return out;
    }
  }
  // 3) HTML page — report title, never CSS as "IP".
  const tm = body.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  if (tm) out.title = tm[1].trim();
  out.note = `Target ${targetHost} returned HTTP ${out.status || '?'} ` +
    `${out.title ? `("${out.title}") ` : ''}(${out.bytes.toLocaleString('en-US')} bytes of ` +
    `${/<html|<!doctype/i.test(body.slice(0, 512)) ? 'HTML' : 'content'}). ` +
    `That proves the proxy works, but it is not an IP-echo endpoint — point the probe at ` +
    `https://httpbin.org/ip or https://api.ipify.org?format=json to see the exit IP.`;
  return out;
}

function probeResult(raw, ms, proxyUrl, targetHost) {
  const p = parseProbeResponse(raw, targetHost);
  // Redacted: proxy URLs may embed user:pass credentials.
  const base = { ok: true, ms, proxy: redactProxyUrl(proxyUrl), status: p.status, bytes: p.bytes };
  if (p.ip) {
    base.ip = p.ip;
  } else {
    base.ip = null;
    base.note = p.note;
    if (p.title) base.title = p.title;
  }
  return base;
}

function notifySse(evt) {
  if (sseClients.size === 0) return;
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch (e) {
      /* ignore broken pipe */
    }
  }
}

function buildStreamPayload() {
  if (!engine) return { engineState: 'idle', idle: true, ts: Date.now() };
  const snap = engine.snapshot();
  const tail = snap.timeline.slice(-3);
  delete snap.timeline;
  snap.timelineTail = tail;
  snap.ts = Date.now();
  return snap;
}

function startSseTimer() {
  if (sseTimer) return;
  sseTimer = setInterval(() => {
    if (sseClients.size === 0) return;
    const payload = buildStreamPayload();
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(': heartbeat\n');
        res.write(line);
      } catch (_) { /* ignore */ }
    }
  }, 5000);
  if (sseTimer.unref) sseTimer.unref();
}

function stopSseTimerIfIdle() {
  if (sseClients.size === 0 && sseTimer) {
    clearInterval(sseTimer);
    sseTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Built-in demo target so users can try Strom Fire safely without a real site.
// ---------------------------------------------------------------------------
const DEMO_INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>Strom Fire demo target</title>
<style>body{font:15px/1.6 system-ui,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#e6edf3;background:#0d1117}
code{background:#161b22;padding:2px 6px;border-radius:5px}a{color:#58a6ff}li{margin:6px 0}</style></head><body>
<h1>Strom Fire — built-in demo target</h1>
<p>These endpoints exist so you can test the tool end-to-end without touching a real server. Point Strom Fire at
<code>{{PROTO}}://127.0.0.1:${PORT}/demo/fast</code> and press Start.</p>
<ul>
<li><a href="/demo/fast"><code>/demo/fast</code></a> — tiny 200 response, very cheap</li>
<li><a href="/demo/json"><code>/demo/json</code></a> — 200 with a small JSON body</li>
<li><a href="/demo/slow?ms=200"><code>/demo/slow?ms=200</code></a> — fixed artificial delay</li>
<li><a href="/demo/heavy?ms=50&kb=50"><code>/demo/heavy?ms=50&kb=50</code></a> — delay + payload</li>
<li><a href="/demo/flaky?rate=0.1"><code>/demo/flaky?rate=0.1</code></a> — returns 5xx for a fraction of requests</li>
</ul>
<p>Tip: run Stress mode against <code>/demo/slow?ms=120</code> to watch the tool find a breaking point.</p>
</body></html>`;

function getProto() {
  return tlsCerts ? 'https' : 'http';
}

function handleDemo(req, res, url) {
  const q = url.searchParams;
  const ms = Math.min(5000, Math.max(0, Number(q.get('ms') || 0)));
  const kb = Math.min(2048, Math.max(0, Number(q.get('kb') || 0)));
  const proto = getProto();

  const finish = (code, body, type) => {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(code, {
      'content-type': type || 'text/plain; charset=utf-8',
      'content-length': payload.length,
      'cache-control': 'no-store',
    });
    res.end(payload);
  };

  const respond = () => {
    switch (url.pathname) {
      case '/demo':
      case '/demo/':
        return finish(200, DEMO_INDEX.replace('{{PROTO}}', proto), 'text/html; charset=utf-8');
      case '/demo/fast':
        return finish(200, 'ok');
      case '/demo/json':
        return finish(200, JSON.stringify({ ok: true, ts: Date.now(), rand: Math.random() }), 'application/json');
      case '/demo/slow':
        return finish(200, `slept ${ms}ms`);
      case '/demo/heavy': {
        const pad = kb > 0 ? 'x'.repeat(kb * 1024) : '';
        return finish(200, JSON.stringify({ ok: true, kb, pad }));
      }
      case '/demo/flaky': {
        const rate = Math.min(1, Math.max(0, Number(q.get('rate') || 0.1)));
        return Math.random() < rate ? finish(500, 'boom') : finish(200, 'ok');
      }
      default:
        return finish(404, 'not found');
    }
  };

  if (ms > 0) setTimeout(respond, ms);
  else respond();
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const clientIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
  // Rate-limit only mutating POSTs. Safe GETs (health/status/stream/report)
  // are polled continuously by the dashboard and e2e suites — 429ing them
  // breaks live runs (e2e tests 12-14 failed this way).
  if (req.method === 'POST' && isRateLimited(clientIp)) {
    return sendJson(res, 429, { ok: false, error: 'Rate limited. Slow down.' });
  }
  // Mutating endpoints require token when LOADSTORM_TOKEN is set
  if (req.method === 'POST' && pathname.startsWith('/api/')) {
    if (!auth.authEnabled && !requireToken(req, res)) return;
  }
  // SameSite=Lax is the main CSRF defense; as depth, refuse credentialed
  // POSTs whose Origin/Referer names a different host. Script clients
  // (curl, node, launchers) send no Origin and are unaffected.
  if (req.method === 'POST' && pathname.startsWith('/api/')) {
    const origin = req.headers.origin || req.headers.referer;
    if (origin) {
      try {
        const oHost = new URL(origin).host.toLowerCase();
        const hHost = String(req.headers.host || '').split(',')[0].trim().toLowerCase();
        if (oHost && hHost && oHost !== hHost) {
          return sendJson(res, 403, { ok: false, error: 'Cross-origin request refused.' });
        }
      } catch (_) { /* malformed origin: ignore */ }
    }
  }

  // --- sign-in endpoints (public; must precede the auth gate) ---
  if (pathname === '/api/login' && req.method === 'POST') {
    if (!auth.authEnabled) {
      return sendJson(res, 400, { ok: false, error: 'Sign-in is not configured on this server.' });
    }
    if (!auth.loginAllowed(clientIp)) {
      return sendJson(res, 429, { ok: false, error: 'Too many sign-in attempts. Slow down.' });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: 'Invalid request.' });
    }
    const username = body && typeof body.username === 'string' ? body.username.trim().slice(0, 256) : '';
    const password = body && typeof body.password === 'string' ? body.password : '';
    // One generic message for unknown user AND wrong password (no oracle).
    // The password itself is never logged, echoed, or returned.
    if (!auth.verifyPassword(username, password)) {
      return sendJson(res, 401, { ok: false, error: 'Invalid username or password.' });
    }
    const token = auth.createSession(username);
    const payload = JSON.stringify({ ok: true });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      'set-cookie': auth.sessionCookieHeader(token, req, Math.floor(auth.SESSION_TTL_MS / 1000)),
    });
    return res.end(payload);
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    auth.destroySession(auth.parseCookies(req)[auth.SESSION_COOKIE]);
    const payload = JSON.stringify({ ok: true });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      'set-cookie': auth.clearCookieHeader(),
    });
    return res.end(payload);
  }

  if (pathname === '/api/auth-status' && req.method === 'GET') {
    const s = auth.requestSession(req);
    return sendJson(res, 200, {
      ok: true,
      authEnabled: auth.authEnabled,
      authed: !!s,
      user: s ? s.username : null,
    });
  }

  // --- auth gate: everything except /api/health needs a session (or token) ---
  if (auth.authEnabled && pathname !== '/api/health') {
    const sess = auth.requestSession(req);
    let ok = !!sess;
    if (!ok && API_TOKEN) {
      const hdr = req.headers['x-loadstorm-token'] || req.headers['x-api-token'];
      if (hdr === API_TOKEN || url.searchParams.get('token') === API_TOKEN) ok = true;
    }
    if (!ok) return sendJson(res, 401, { ok: false, error: 'Sign in required.' });
    if (sess && sess.refresh) {
      const tok = auth.parseCookies(req)[auth.SESSION_COOKIE];
      if (tok) res.setHeader('set-cookie', auth.sessionCookieHeader(tok, req, Math.floor(auth.SESSION_TTL_MS / 1000)));
    }
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, service: 'stromfire', version: '1.0.0', time: new Date().toISOString() });
  }

  if (pathname === '/api/demo-target' && req.method === 'GET') {
    const proto = getProto();
    return sendJson(res, 200, { url: `${proto}://127.0.0.1:${PORT}/demo/fast`, slow: `${proto}://127.0.0.1:${PORT}/demo/slow?ms=120` });
  }

  // One-click Tor setup for the dashboard: detect the SOCKS port, then verify
  // the derived control port (with alternate fallback, same as the launchers).
  // Gated like all data APIs (sits below the auth gate).
  if (pathname === '/api/tor-status' && req.method === 'GET') {
    const socks = await detectTorSocks();
    if (!socks) {
      return sendJson(res, 200, {
        ok: true, socks: null, control: null,
        hint: 'No Tor SOCKS port reachable (tried 9150 and 9050). Open Tor Browser and click "Connect", or start system tor.',
      });
    }
    const derived = socks === 9050 ? 9051 : 9151;
    const alternate = socks === 9050 ? 9151 : 9051;
    let control = derived;
    try {
      control = Number(await pickControlPort(derived, alternate));
    } catch (_) { /* keep derived; rotation errors stay specific */ }
    return sendJson(res, 200, {
      ok: true, socks, control,
      proxy: `socks5://127.0.0.1:${socks}`,
      mixed: control !== derived,
    });
  }

  if (pathname === '/api/status' && req.method === 'GET') {
    if (!engine) return sendJson(res, 200, { engineState: 'idle', idle: true });
    return sendJson(res, 200, engine.snapshot());
  }

  if (pathname === '/api/report' && req.method === 'GET') {
    return sendJson(res, 200, { report: lastReport });
  }

  if (pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(buildStreamPayload())}\n\n`);
    sseClients.add(res);
    startSseTimer();
    req.on('close', () => {
      sseClients.delete(res);
      stopSseTimerIfIdle();
    });
    return;
  }

  if (pathname === '/api/test-proxy' && req.method === 'POST') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    req.on('close', () => clearTimeout(timer));
    let body;
    try {
      body = JSON.parse((await readBody(req, ctrl.signal)) || '{}');
    } catch (e) {
      clearTimeout(timer);
      if (e && e.message === 'Request body too large.') return sendJson(res, 413, { ok: false, error: 'Request body too large (max 64KB).' });
      return sendJson(res, 400, { ok: false, error: 'Invalid JSON body.' });
    }
    clearTimeout(timer);

    const proxyUrl = body.proxy;
    if (!proxyUrl) {
      return sendJson(res, 400, { ok: false, error: 'No proxy URL provided.' });
    }

    try {
      const parsed = new URL(proxyUrl);
      // Only SOCKS5 is spoken below (0x05 greeting/auth/connect). SOCKS4 used
      // to be accepted and then fail with a cryptic handshake error.
      if (parsed.protocol === 'socks4:') {
        return sendJson(res, 200, { ok: false, error: 'SOCKS4 is not supported — use a socks5:// proxy URL.' });
      }
      const isSocks = parsed.protocol === 'socks5:';
      const target = body.target || 'https://httpbin.org/ip';
      const targetUrl = new URL(target);
      // Respect the caller's target path instead of hardcoding /ip
      const targetPath = (targetUrl.pathname || '/') + (targetUrl.search || '');
      const start = Date.now();
      const probePath = targetPath;
      // Shared TLS fingerprint options with the engine (lib/engine.js) so the
      // probe presents the same ClientHello as a real generated request.
      const tlsProfile = body.tlsFingerprint || 'chrome120';
      const probeTls = (sock, name) => tlsOptionsForFingerprint(tlsProfile, { socket: sock, servername: name, rejectUnauthorized: false });

      if (isSocks) {
        const net = require('net');
        const tlsMod = require('tls');
        const connectResult = await new Promise((resolve) => {
          let done = false;
          const finish = (v) => { if (done) return; done = true; try { socket.destroy(); } catch (_) {} resolve(v); };
          const socket = net.createConnection({
            host: parsed.hostname,
            port: Number(parsed.port) || 1080,
          }, () => {
            const greeting = Buffer.from([0x05, 0x01, 0x00]);
            socket.write(greeting);
            socket.once('data', (d) => {
              if (!d || d[0] !== 0x05) { finish({ ok: false, error: 'SOCKS5 handshake failed' }); return; }
              const addr = targetUrl.hostname;
              const port = Number(targetUrl.port) || (targetUrl.protocol === 'https:' ? 443 : 80);
              const socksBody = Buffer.alloc(7 + addr.length);
              socksBody[0] = 0x05; socksBody[1] = 0x01; socksBody[2] = 0x00; socksBody[3] = 0x03;
              socksBody[4] = addr.length;
              socksBody.write(addr, 5, 'ascii');
              socksBody.writeUInt16BE(port, 5 + addr.length);
              socket.write(socksBody);
              socket.once('data', (d2) => {
                if (!d2 || d2[1] !== 0x00) { finish({ ok: false, error: 'SOCKS5 connect failed: ' + (d2 && d2[1]) }); return; }
                if (targetUrl.protocol === 'https:') {
                  const tlsSocket = tlsMod.connect(probeTls(socket, addr), () => {
                    const reqStr = `GET ${probePath} HTTP/1.1\r\nHost: ${addr}\r\nConnection: close\r\n\r\n`;
                    tlsSocket.write(reqStr);
                    let resp = '';
                    tlsSocket.on('data', (c) => { resp += c.toString(); });
                    tlsSocket.on('end', () => {
                      const ms = Date.now() - start;
                      finish(probeResult(resp, ms, proxyUrl, addr));
                    });
                  });
                  tlsSocket.on('error', (e) => { finish({ ok: false, error: e.code || e.message, ms: Date.now() - start }); });
                  tlsSocket.setTimeout(8000, () => { finish({ ok: false, error: 'TLS timeout', ms: Date.now() - start }); });
                } else {
                  const reqStr = `GET ${probePath} HTTP/1.1\r\nHost: ${addr}\r\nConnection: close\r\n\r\n`;
                  socket.write(reqStr);
                  let resp = '';
                  socket.on('data', (c) => { resp += c.toString(); });
                  socket.on('end', () => {
                    const ms = Date.now() - start;
                    finish(probeResult(resp, ms, proxyUrl, addr));
                  });
                }
              });
            });
          });
          socket.on('error', (e) => { finish({ ok: false, error: e.code || e.message, ms: Date.now() - start }); });
          socket.setTimeout(5000, () => { finish({ ok: false, error: 'Connection timeout', ms: Date.now() - start }); });
        });
        return sendJson(res, 200, connectResult);
      } else {
        const httpMod = parsed.protocol === 'https:' ? require('https') : require('http');
        const connectResult = await new Promise((resolve) => {
          let done = false;
          const finish = (v) => { if (done) return; done = true; resolve(v); };
          const opts = {
            hostname: parsed.hostname,
            port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
            timeout: 8000,
            method: 'CONNECT',
            path: targetUrl.hostname + ':' + (targetUrl.port || 443),
          };
          if (parsed.username) {
            const auth = Buffer.from(`${parsed.username}:${parsed.password || ''}`).toString('base64');
            opts.headers = { 'Proxy-Authorization': 'Basic ' + auth };
          }
          const req2 = httpMod.request(opts);
          req2.on('connect', (res2, socket2) => {
            if (res2.statusCode !== 200) { try { socket2.destroy(); } catch (_) {} finish({ ok: false, error: 'CONNECT ' + res2.statusCode, ms: Date.now() - start }); return; }
            if (targetUrl.protocol === 'https:') {
              const tlsSocket = require('tls').connect(probeTls(socket2, targetUrl.hostname), () => {
                const reqStr = `GET ${probePath} HTTP/1.1\r\nHost: ${targetUrl.hostname}\r\nConnection: close\r\n\r\n`;
                tlsSocket.write(reqStr);
                let resp = '';
                tlsSocket.on('data', (c) => { resp += c.toString(); });
                tlsSocket.on('end', () => {
                  const ms = Date.now() - start;
                  finish(probeResult(resp, ms, proxyUrl, targetUrl.hostname));
                });
              });
              tlsSocket.on('error', (e) => { finish({ ok: false, error: e.code || e.message, ms: Date.now() - start }); });
              tlsSocket.setTimeout(8000, () => { try { tlsSocket.destroy(); } catch (_) {} finish({ ok: false, error: 'TLS timeout', ms: Date.now() - start }); });
            } else {
              const reqStr = `GET ${probePath} HTTP/1.1\r\nHost: ${targetUrl.hostname}\r\nConnection: close\r\n\r\n`;
              socket2.write(reqStr);
              let resp = '';
              socket2.on('data', (c) => { resp += c.toString(); });
              socket2.on('end', () => {
                const ms = Date.now() - start;
                finish(probeResult(resp, ms, proxyUrl, targetUrl.hostname));
              });
              socket2.on('error', (e) => { finish({ ok: false, error: e.code || e.message, ms: Date.now() - start }); });
            }
          });
          req2.on('error', (e) => { finish({ ok: false, error: e.code || e.message, ms: Date.now() - start }); });
          req2.setTimeout(5000, () => { try { req2.destroy(); } catch (_) {} finish({ ok: false, error: 'Connection timeout', ms: Date.now() - start }); });
          req2.end();
        });
        return sendJson(res, 200, connectResult);
      }
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message || 'Unknown error' });
    }
  }

  if (pathname === '/api/validate' && req.method === 'POST') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    req.on('close', () => clearTimeout(timer));
    let body;
    try {
      body = JSON.parse((await readBody(req, ctrl.signal)) || '{}');
    } catch (e) {
      clearTimeout(timer);
      if (e && e.message === 'Request body too large.') return sendJson(res, 413, { ok: false, error: 'Request body too large (max 64KB).' });
      return sendJson(res, 400, { ok: false, error: 'Invalid JSON body.' });
    }
    clearTimeout(timer);
    if (typeof body !== 'object' || body === null) return sendJson(res, 400, { ok: false, error: 'Invalid JSON body.' });
    const fast = validateTarget(body.url || body.target);
    if (!fast.ok) return sendJson(res, 200, fast);
    try {
      return sendJson(res, 200, await validateTargetResolved(body.url || body.target));
    } catch (e) {
      return sendJson(res, 200, fast);
    }
  }

  // Passive security scan: single read-only GET, no crawling/fuzzing/payloads.
  // Same safety gate as /api/start — only targets you own or may test.
  if (pathname === '/api/security' && req.method === 'POST') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    req.on('close', () => clearTimeout(timer));
    let body;
    try {
      body = JSON.parse((await readBody(req, ctrl.signal)) || '{}');
    } catch (e) {
      clearTimeout(timer);
      return sendJson(res, 400, { ok: false, error: 'Invalid JSON body.' });
    }
    clearTimeout(timer);
    if (body.confirm !== true) {
      return sendJson(res, 400, {
        ok: false,
        error: 'You must tick the authorisation checkbox (confirm=true): you own the target or have written permission to test it.',
      });
    }
    const fastCheck = validateTarget(body.url || body.target);
    if (!fastCheck.ok) return sendJson(res, 400, { ok: false, error: fastCheck.reason, safety: fastCheck });
    try {
      const full = await validateTargetResolved(body.url || body.target);
      if (!full.ok) return sendJson(res, 400, { ok: false, error: full.reason, safety: full });
    } catch (e) { /* fall through with fastCheck */ }
    try {
      const scan = await security.runSecurityScan(body.url || body.target, {
        timeoutMs: 15000,
        tlsVerify: body.tlsVerify !== false,
      });
      return sendJson(res, 200, Object.assign({ ok: true }, scan));
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: (e && e.message) || 'Scan failed.' });
    }
  }

  if (pathname === '/api/start' && req.method === 'POST') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    req.on('close', () => clearTimeout(timer));
    if (engine && (engine.state === 'running' || engine.state === 'stopping')) {
      clearTimeout(timer);
      return sendJson(res, 409, { ok: false, error: 'A test is already running. Stop it before starting another.' });
    }
    let body;
    try {
      body = JSON.parse((await readBody(req, ctrl.signal)) || '{}');
    } catch (e) {
      clearTimeout(timer);
      if (e && e.message === 'Request body too large.') return sendJson(res, 413, { ok: false, error: 'Request body too large (max 64KB).' });
      return sendJson(res, 400, { ok: false, error: 'Invalid JSON body.' });
    }
    clearTimeout(timer);

    // Re-check now that the await has yielded the event loop: two concurrent
    // POSTs must not both reach engine creation (the second would orphan the first).
    if (engine && (engine.state === 'running' || engine.state === 'stopping')) {
      return sendJson(res, 409, { ok: false, error: 'A test is already running. Stop it before starting another.' });
    }

    // --- safety gates (server-side, not just UI) ---
    if (body.confirm !== true) {
      return sendJson(res, 400, {
        ok: false,
        error: 'You must tick the authorisation checkbox (confirm=true): you own the target or have written permission to test it.',
      });
    }
    const fastCheck = validateTarget(body.url || body.target);
    if (!fastCheck.ok) {
      return sendJson(res, 400, { ok: false, error: fastCheck.reason, safety: fastCheck });
    }
    let check = fastCheck;
    try {
      check = await validateTargetResolved(body.url || body.target);
    } catch (e) {
      check = fastCheck;
    }
    if (!check.ok) {
      return sendJson(res, 400, { ok: false, error: check.reason, safety: check });
    }

    // Local demo targets need the caller's session: the engine makes its own
    // server-side requests and never sees the browser cookies, so without this
    // every demo hit would 401 when sign-in is on (dead demo button).
    if (auth.authEnabled) {
      try {
        const t = new URL(body.url || body.target);
        const localHost = t.hostname === '127.0.0.1' || t.hostname === 'localhost' || t.hostname === '::1' || t.hostname === '[::1]';
        const defaultPort = t.protocol === 'https:' ? 443 : 80;
        const isLocalDemo = localHost && Number(t.port || defaultPort) === PORT &&
          (t.pathname === '/demo' || t.pathname.startsWith('/demo/'));
        if (isLocalDemo && auth.requestSession(req)) {
          const m = String(req.headers.cookie || '').match(/(?:^|;\s*)stromfire_session=([^;]+)/);
          if (m) {
            body.headers = Object.assign({}, body.headers, { cookie: `${auth.SESSION_COOKIE}=${m[1]}` });
          }
        }
      } catch (e) { /* not a parseable URL — safety gate already rejected it */ }
    }

    try {
      engine = new LoadEngine(body, {
        onEvent: (e) => {
          if (e.type === 'finished') {
            lastReport = e.summary;
            persistReport(e.summary);
          }
          const ssePayload = { engineState: engine ? engine.state : 'idle', event: e.type, ts: Date.now() };
          if (e.proxy) ssePayload.proxy = e.proxy;
          if (e.rotationCount != null) ssePayload.rotationCount = e.rotationCount;
          if (e.recentTimeouts != null) ssePayload.recentTimeouts = e.recentTimeouts;
          if (e.recentErrors != null) ssePayload.recentErrors = e.recentErrors;
          if (e.error) ssePayload.error = e.error;
          notifySse(ssePayload);
        },
      });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: (e && e.message) || 'Invalid configuration.' });
    }

    lastReport = null;
    const started = engine.run(); // do not await
    started.catch(() => {}); // errors are surfaced via engine.state/error

    return sendJson(res, 202, { ok: true, target: engine.cfg.url, mode: engine.cfg.mode, safety: check });
  }

  if (pathname === '/api/stop' && req.method === 'POST') {
    if (!engine) return sendJson(res, 400, { ok: false, error: 'No test is running.' });
    const stopped = engine.stop();
    return sendJson(res, 200, { ok: stopped, state: engine.state });
  }

  if (pathname === '/api/reset' && req.method === 'POST') {
    if (engine && (engine.state === 'running' || engine.state === 'stopping')) {
      return sendJson(res, 409, { ok: false, error: 'Stop the running test first.' });
    }
    engine = null;
    lastReport = null;
    sseClients.forEach((r) => {
      try {
        r.write(`data: ${JSON.stringify({ engineState: 'idle', idle: true, ts: Date.now() })}\n\n`);
      } catch (e) {
        /* ignore */
      }
    });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: 'Unknown API endpoint.' });
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch (e) {
    // Malformed percent-encoding (e.g. GET /%E0%A4%A) must not crash the server.
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Bad request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  // The dashboard itself requires sign-in (data APIs are gated too, so the
  // page alone is useless without it). Public assets (login page, css/js,
  // logo) stay reachable; direct-URL bypass is impossible.
  if (rel === '/index.html' && auth.authEnabled) {
    let ok = !!auth.requestSession(req);
    if (!ok && API_TOKEN) {
      try {
        const q = new URL(req.url, 'http://localhost').searchParams.get('token');
        if (q === API_TOKEN) ok = true;
      } catch (_) { /* ignore */ }
    }
    if (!ok) {
      res.writeHead(302, { location: '/login.html', 'cache-control': 'no-store' });
      return res.end();
    }
  }
  const publicRoot = path.resolve(PUBLIC_DIR);
  const resolved = path.resolve(path.join(PUBLIC_DIR, rel));
  if (resolved !== publicRoot && !resolved.startsWith(publicRoot + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

const tlsCerts = ensureTlsCerts();
const server = (tlsCerts ? https : http).createServer((req, res) => {
  const proto = tlsCerts ? 'https' : 'http';
  const url = new URL(req.url, `${proto}://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      sendJson(res, 500, { ok: false, error: (e && e.message) || 'Internal error.' });
    });
    return;
  }
  if (url.pathname === '/demo' || url.pathname.startsWith('/demo/')) {
    // Demo endpoints burn server CPU/bandwidth per hit — they count as app
    // surface and require sign-in when auth is on (dashboard sends cookies).
    if (auth.authEnabled && !auth.requestSession(req)) {
      sendJson(res, 401, { ok: false, error: 'Sign in required.' });
      return;
    }
    handleDemo(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

function openBrowser(url) {
  const { spawn } = require('child_process');
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    /* opening the browser is best-effort */
  }
}

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  const proto = tlsCerts ? 'https' : 'http';
  const dashUrl = `${proto}://${shown}:${PORT}/`;
  process.stdout.write(`\n  Strom Fire is running.\n`);
  process.stdout.write(`  Dashboard : ${dashUrl}\n`);
  process.stdout.write(`  Demo target to test: ${proto}://${shown}:${PORT}/demo/fast\n`);
  if (tlsCerts) process.stdout.write(`  TLS: self-signed cert (browser will warn — accept to continue)\n`);
  if (auth.authEnabled) {
    process.stdout.write(`  Auth: sign-in enabled (user "${auth.USERNAME}"). Sessions expire after 12h.\n`);
  } else {
    process.stdout.write(`  Auth: OPEN mode (STROMFIRE_PASSWORD unset) — anyone who can reach this server can drive load. Set STROMFIRE_PASSWORD=... to require sign-in.\n`);
  }
  if ((HOST === '0.0.0.0' || HOST === '::') && !API_TOKEN && !auth.authEnabled) {
    process.stdout.write(`  WARNING: listening on ${HOST} with no sign-in and no LOADSTORM_TOKEN — anyone on the network can drive load.\n`);
  }
  if (API_TOKEN) process.stdout.write(`  Auth: LOADSTORM_TOKEN required for POST /api/*\n`);
  process.stdout.write(`  Press Ctrl+C to stop.\n\n`);
  if (process.env.OPEN_BROWSER === '1') openBrowser(dashUrl);
});

process.on('SIGINT', () => {
  if (engine) engine.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
});

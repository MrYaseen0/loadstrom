'use strict';
// Integration test for the IP-probe path (POST /api/test-proxy) and for
// proxy-based load generation. Fully self-contained — no internet, no Tor.
//
// It spins up on localhost:
//   1) an IP-echo target  (GET /ipecho -> {"origin":"198.51.100.23"})
//   2) an HTML target     (GET /page   -> an HTML page with a <title>)
//   3) a minimal HTTP CONNECT proxy stub that forwards to the targets
//   4) a Strom Fire server (child process, free port)
//
// Then it verifies:
//   A. test-proxy through the stub returns ok:true and the correct exit IP
//   B. an HTML target returns ip:null + the page title (never CSS as "IP")
//   C. a dead proxy returns ok:false with a real error message
//   D. a real load test run THROUGH the proxy completes with zero errors
//
// Usage: node scripts/proxytest.js   (or: npm run proxytest)
// Exits non-zero on failure.
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ECHO_IP = '198.51.100.23'; // TEST-NET-2 documentation address — obviously fake

let passed = 0;
let failed = 0;
function ok(name, detail) { passed++; console.log(`  PASS: ${name}${detail ? ' -- ' + detail : ''}`); }
function fail(name, reason) { failed++; console.log(`  FAIL: ${name}${reason ? ' -- ' + reason : ''}`); }
function check(name, cond, detail) { if (cond) ok(name, detail); else fail(name, detail || 'assertion false'); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function listenOn(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

// --- 1) + 2) targets -------------------------------------------------------
function startTargets() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/ipecho') {
      const body = JSON.stringify({ origin: ECHO_IP });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      return res.end(body);
    }
    if (req.url === '/page') {
      const body = '<!doctype html><html><head><title>Echo Page</title><style>:root{ --x: 1; }</style></head><body>hi</body></html>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      return res.end(body);
    }
    res.writeHead(404);
    res.end('nope');
  });
  return listenOn(srv).then((port) => ({ srv, port }));
}

// --- 3) CONNECT proxy stub -------------------------------------------------
function startProxyStub() {
  const srv = http.createServer();
  srv.on('connect', (req, clientSocket, head) => {
    const [host, port] = (req.url || '').split(':');
    const target = net.createConnection({ host, port: Number(port) || 80 }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) target.write(head);
      target.pipe(clientSocket);
      clientSocket.pipe(target);
    });
    const kill = () => { try { target.destroy(); } catch (_) {} try { clientSocket.destroy(); } catch (_) {} };
    target.on('error', kill);
    clientSocket.on('error', kill);
  });
  // Non-CONNECT requests are not part of the probe path; answer plainly.
  srv.on('request', (req, res) => { res.writeHead(400); res.end('CONNECT only'); });
  return listenOn(srv).then((port) => ({ srv, port }));
}

// --- 4) Strom Fire server --------------------------------------------------
let child = null;
function bootApp(port) {
  return new Promise((resolve, reject) => {
    child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { PORT: String(port) }),
      stdio: 'ignore',
    });
    const deadline = Date.now() + 20000;
    const poll = async () => {
      try {
        const r = await api(port, '/api/health');
        if (r && r.ok === true) return resolve();
      } catch (_) { /* not up yet */ }
      if (Date.now() > deadline) return reject(new Error('app server did not start'));
      setTimeout(poll, 250);
    };
    poll();
  });
}
function shutdownApp() { try { if (child) child.kill(); } catch (_) {} child = null; }

function api(port, p, method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1', port, path: p, method: method || 'GET',
      headers: { 'content-type': 'application/json' },
    };
    if (payload) opts.headers['content-length'] = Buffer.byteLength(payload);
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(d); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForState(port, states, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = await api(port, '/api/status');
      if (s && states.includes(s.engineState)) return s;
    } catch (_) {}
    await sleep(250);
  }
  return null;
}

async function main() {
  let exitCode = 0;
  let targets, proxy;
  try {
    targets = await startTargets();
    proxy = await startProxyStub();
    // Pick a free port for the app server via a temp listener, then close it.
    const tmp = http.createServer();
    const freePort = await listenOn(tmp);
    tmp.close();
    await bootApp(freePort);
    console.log(`  (targets :${targets.port}, proxy stub :${proxy.port}, app :${freePort})`);

    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const echoUrl = `http://127.0.0.1:${targets.port}/ipecho`;
    const pageUrl = `http://127.0.0.1:${targets.port}/page`;

    // A. JSON IP-echo through the proxy -> exit IP parsed correctly
    const a = await api(freePort, '/api/test-proxy', 'POST', { proxy: proxyUrl, target: echoUrl });
    check('A. probe ok through proxy', a && a.ok === true, JSON.stringify(a).slice(0, 120));
    check('A. exit IP parsed', a && a.ip === ECHO_IP, 'ip=' + (a && a.ip));

    // B. HTML page through the proxy -> no fake IP, title reported instead
    const b = await api(freePort, '/api/test-proxy', 'POST', { proxy: proxyUrl, target: pageUrl });
    check('B. probe ok on HTML page', b && b.ok === true, JSON.stringify(b).slice(0, 120));
    check('B. no IP invented for HTML', b && b.ip === null, 'ip=' + (b && b.ip));
    check('B. page title reported', b && b.title === 'Echo Page', 'title=' + (b && b.title));

    // C. dead proxy -> clean failure, not a hang
    const c = await api(freePort, '/api/test-proxy', 'POST', { proxy: 'http://127.0.0.1:1', target: echoUrl });
    check('C. dead proxy fails cleanly', c && c.ok === false && typeof c.error === 'string' && c.error.length > 0, JSON.stringify(c).slice(0, 120));

    // D. real engine run THROUGH the proxy
    const s = await api(freePort, '/api/start', 'POST', {
      url: echoUrl, mode: 'load', method: 'GET',
      concurrency: 3, durationSec: 5, rampUpSec: 1, timeoutMs: 8000,
      proxy: proxyUrl, confirm: true,
      thresholds: { maxErrorRatePct: 100, maxP95Ms: 10000, minRps: 0 },
    });
    check('D. proxied test accepted', s && s.ok === true, JSON.stringify(s).slice(0, 100));
    const fin = await waitForState(freePort, ['finished'], 25000);
    check('D. proxied test finished', fin && fin.engineState === 'finished', 'state=' + (fin && fin.engineState));
    check('D. traffic flowed through proxy', fin && fin.completed > 20, 'completed=' + (fin && fin.completed));
    check('D. zero errors through proxy', fin && fin.failed === 0, 'failed=' + (fin && fin.failed));

    exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('proxytest harness failed:', e && e.message ? e.message : e);
    exitCode = 2;
  } finally {
    shutdownApp();
    try { if (targets) targets.srv.close(); } catch (_) {}
    try { if (proxy) proxy.srv.close(); } catch (_) {}
  }
  console.log('\n============================================================');
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('============================================================');
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(2); });

#!/usr/bin/env node
// Strom Fire Anonymous Launcher (Node.js)
// Usage: node anon-launcher.js "https://target.com" [concurrency] [duration]
// Duration 0 = unlimited (runs until stopped)

const http = require('http');
const net = require('net');
const fs = require('fs');

const TARGET = process.argv[2];
const CONCURRENCY = parseInt(process.argv[3]) || 50;
const DURATION = parseInt(process.argv[4]) || 0; // 0 = unlimited
// Tor Browser listens on 9150/9151, system tor on 9050/9051 — auto-detected
// at startup (was hardcoded to 9150, which broke for system-tor users).
let PROXY = 'socks5://127.0.0.1:9150';
let TOR_CONTROL_PORT = 9151;
const DASHBOARD = 'http://127.0.0.1:8787';
// One Tor circuit carries ~10-20 concurrent users. More than that through a
// single exit node only queues, times out, and trips rotation loops.
const TOR_SAFE_CONCURRENCY = 20;

if (!TARGET) {
  console.log('Usage: node anon-launcher.js "https://target.com" [concurrency] [duration]');
  console.log('  duration 0 = unlimited (runs until stopped)');
  process.exit(1);
}

// Session cookie captured at sign-in (server enforces login when
// STROMFIRE_PASSWORD is set) and attached to every later API call.
let SESSION_COOKIE = '';
function apiCall(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, DASHBOARD);
    const headers = { 'Content-Type': 'application/json' };
    if (SESSION_COOKIE) headers.Cookie = SESSION_COOKIE;
    const opts = { hostname: url.hostname, port: url.port, path: url.pathname, method, headers };
    const req = http.request(opts, res => {
      const sc = res.headers['set-cookie'];
      // stromfire_session=...; Path=/; ... — keep only the pair.
      if (sc && sc.length) SESSION_COOKIE = String(sc[0]).split(';')[0];
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Sign in when the server requires it; no-op in open (dev) mode.
async function ensureAuth() {
  const st = await apiCall('/api/auth-status');
  if (!st || !st.authEnabled || st.authed) return;
  const username = process.env.STROMFIRE_USER || 'admin';
  const password = process.env.STROMFIRE_PASSWORD || '';
  if (!password) {
    console.log('Server requires sign-in but STROMFIRE_PASSWORD is not set. Aborting.');
    process.exit(1);
  }
  const r = await apiCall('/api/login', 'POST', { username, password });
  if (!r || r.ok !== true || !SESSION_COOKIE) {
    console.log('Sign-in failed. Aborting.');
    process.exit(1);
  }
  console.log(`Signed in as ${username}`);
}

function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(3000);
    sock.connect(port, host, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

async function detectTor() {
  // Prefer Tor Browser (9150), fall back to system tor (9050).
  if (await checkPort(9150)) return { proxy: 'socks5://127.0.0.1:9150', controlPort: 9151, label: 'Tor Browser (9150/9151)' };
  if (await checkPort(9050)) return { proxy: 'socks5://127.0.0.1:9050', controlPort: 9051, label: 'system tor (9050/9051)' };
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('');
  console.log('============================================================');
  console.log(' Strom Fire Anonymous Launcher (Node.js)');
  console.log('============================================================');
  console.log(` Target:      ${TARGET}`);
  console.log(` Concurrency: ${CONCURRENCY}`);
  console.log(` Duration:    ${DURATION === 0 ? 'UNLIMITED (stops when you press Ctrl+C)' : DURATION + ' sec'}`);
  console.log(` Proxy:       Tor on 127.0.0.1:9150 or :9050 (auto-detected below)`);
  console.log(` Auto-rotate: Enabled (switches IP when blocked)`);
  console.log('============================================================');
  console.log('');

  // 1. Check Tor (auto-detect Tor Browser vs system tor)
  process.stdout.write('[1/6] Checking Tor on 127.0.0.1 (9150, then 9050)... ');
  const tor = await detectTor();
  if (!tor) {
    console.log('FAILED');
    console.log('');
    console.log('ERROR: No Tor SOCKS port reachable (tried 9150 and 9050).');
    console.log('');
    console.log('To fix:');
    console.log('  1. Open Tor Browser and click "Connect" (SOCKS 9150), OR');
    console.log('     start system tor (SOCKS 9050)');
    console.log('  2. Keep it running');
    console.log('  3. Run this launcher again');
    console.log('');
    process.exit(1);
  }
  PROXY = tor.proxy;
  TOR_CONTROL_PORT = tor.controlPort;
  console.log(`OK (${tor.label})`);
  // Mixed-pair hosts exist (e.g. SOCKS 9050 + control 9151): verify the
  // derived control port answers, else fall back to the alternate.
  try {
    const { pickControlPort } = require('./check-tor-control');
    const alternate = tor.controlPort === 9151 ? 9051 : 9151;
    const chosen = await pickControlPort(tor.controlPort, alternate);
    if (Number(chosen) !== tor.controlPort) {
      console.log(`  NOTE: control ${tor.controlPort} refused, but ${chosen} answers — using ${chosen} (mixed Tor pair).`);
    }
    TOR_CONTROL_PORT = Number(chosen);
  } catch {
    // Probe failed (e.g. file missing) — keep the conventional derived port;
    // the engine surfaces a specific control-port error at rotation time.
  }
  if (CONCURRENCY > TOR_SAFE_CONCURRENCY) {
    console.log(`  WARNING: concurrency ${CONCURRENCY} is far past what one Tor circuit handles (~${TOR_SAFE_CONCURRENCY}). Expect queueing/timeouts. Use <= ${TOR_SAFE_CONCURRENCY} for Tor runs.`);
  }

  // 2. Check Strom Fire server
  process.stdout.write('[2/6] Checking Strom Fire server... ');
  try {
    await apiCall('/api/status');
    console.log('Already running');
  } catch {
    console.log('Starting...');
    const { spawn } = require('child_process');
    spawn('node', ['server.js'], {
      detached: true,
      stdio: 'ignore',
      cwd: __dirname,
      // Tor NEWNYM rotation is gated behind ENABLE_EVASION=1 (engine.js) —
      // without it every rotation fails with "Tor rotation disabled".
      env: { ...process.env, ENABLE_EVASION: '1' }
    }).unref();
    await sleep(3000);
    try {
      await apiCall('/api/status');
      console.log('Server started');
    } catch {
      console.log('ERROR: Server failed to start');
      process.exit(1);
    }
  }

  // 2b. Sign in when required (no-op when auth is off)
  await ensureAuth();

  // 3. Build config
  process.stdout.write('[3/6] Building test config... ');
  const cfg = {
    url: TARGET,
    mode: 'load',
    concurrency: CONCURRENCY,
    durationSec: DURATION,
    rampUpSec: 10,
    proxy: PROXY,
    headerProfile: 'desktop-chrome',
    rotateHeaders: true,
    // Small jitter only: the old 200ms + think-time (500-3500ms/request)
    // throttled Tor runs into self-inflicted queueing and huge p95s.
    requestJitterMs: 25,
    isolateCookies: true,
    simulateUserSession: false,
    httpVersion: '1.1',
    trackPhases: true,
    pacing: 'standard',
    timeoutMs: 30000,
    tlsVerify: true,
    confirm: true,
    // Auto-rotation
    autoRotate: true,
    torControlPort: TOR_CONTROL_PORT,
    blockThresholdPct: 70,
    // Backstop: rotation handles transient blocks, but a dead proxy/path
    // must stop the run instead of piling up tens of thousands of failures.
    abortOnErrorRatePct: 50,
    thresholds: {
      maxErrorRatePct: 5,
      maxP95Ms: 2000,
      minRps: 0
    }
  };
  console.log('OK');

  // 4. Start test
  process.stdout.write('[4/6] Starting anonymous load test...\n');
  const startResp = await apiCall('/api/start', 'POST', cfg);
  console.log(`      ${JSON.stringify(startResp)}`);
  console.log('');

  // 5. Poll for completion
  console.log('[5/6] Running test... (auto-rotation enabled)');
  console.log('');
  console.log('============================================================');
  console.log(' LIVE STATUS');
  console.log('============================================================');

  let lastState = '';
  while (true) {
    await sleep(5000);
    try {
      const status = await apiCall('/api/status');

      if (typeof status === 'string') {
        if (status.includes('finished') || status.includes('error') || status.includes('stopping')) break;
      } else if (status && status.engineState) {
        const state = status.engineState;
        if (['finished', 'error', 'stopping'].includes(state)) break;

        const rps = status.rps || status.attemptedRps || 0;
        const users = status.activeWorkers || 0;
        const errRate = status.errRate ? (status.errRate * 100).toFixed(1) : '0.0';
        const rotations = status.rotationCount || 0;
        const blocked = status.blockedProxies ? status.blockedProxies.length : 0;

        const time = new Date().toTimeString().slice(0, 8);
        console.log(`[${time}] State: ${state} | RPS: ${rps} | Users: ${users} | Errors: ${errRate}% | Rotations: ${rotations} | Blocked: ${blocked}`);

        lastState = state;
      }
    } catch (e) {
      console.log(`[${new Date().toTimeString().slice(0, 8)}] Connection lost...`);
    }
  }

  // 6. Get report
  console.log('');
  console.log('[6/6] Fetching final report...');
  console.log('');

  try {
    const wrapped = await apiCall('/api/report');
    // GET /api/report returns { report: summary } — unwrap with fallback.
    const report = (wrapped && wrapped.report) || wrapped || {};

    console.log('============================================================');
    console.log(' RESULT');
    console.log('============================================================');
    console.log(`Status:   ${report.result?.status || 'unknown'}`);
    console.log(`Headline: ${report.result?.headline || ''}`);
    console.log('');
    console.log(`Requests: ${report.metrics?.attempted || 0}`);
    console.log(`OK:       ${report.metrics?.ok || 0}`);
    console.log(`Failed:   ${report.metrics?.failed || 0}`);
    console.log(`RPS:      ${report.metrics?.rps || report.metrics?.attemptedRps || 0}`);
    console.log(`p95:      ${report.metrics?.latency?.p95?.toFixed(0) || 0} ms`);

    if (report.rotationCount) {
      console.log(`Rotations: ${report.rotationCount}`);
    }

    if (report.result?.reasons) {
      console.log('');
      console.log('Reasons:');
      report.result.reasons.forEach(r => console.log(`  - ${r}`));
    }

    if (report.result?.recommendations) {
      console.log('');
      console.log('Next steps:');
      report.result.recommendations.forEach(r => console.log(`  - ${r}`));
    }
    console.log('============================================================');

    // Save report
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `anon-report-${ts}.json`;
    fs.writeFileSync(filename, JSON.stringify(report, null, 2));
    console.log('');
    console.log(`Report saved: ${filename}`);
  } catch (e) {
    console.log('Error fetching report:', e.message);
  }

  console.log('');
  console.log(`Dashboard still running at: ${DASHBOARD}`);
  console.log('Press Ctrl+C to stop server, or close this window.');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

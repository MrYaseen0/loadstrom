'use strict';
// End-to-end test for Strom Fire. Self-contained: boots its own server on a
// free localhost port, runs all checks, shuts the server down.
// Usage:
//   node scripts/e2e-test.js          (or: npm run e2e)
// Exits non-zero on failure.
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

let PORT = Number(process.env.E2E_PORT || 0); // 0 = pick a free port at runtime
let child = null;

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = require('net').createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function bootServer() {
  if (!PORT) PORT = await pickFreePort();
  child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const s = await api('/api/health');
      if (s && s.ok === true) return;
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('e2e server did not become healthy on port ' + PORT);
}

function shutdownServer() {
  try { if (child) child.kill(); } catch (_) { /* ignore */ }
  child = null;
}

function api(path, method, body) {
  return new Promise((res, rej) => {
    const opts = { hostname: '127.0.0.1', port: PORT, path, method, headers: { 'Content-Type': 'application/json' } };
    const req = http.request(opts, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res(d); } });
    });
    req.on('error', rej);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForIdle(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = await api('/api/status');
      if (s.engineState === 'idle' || s.engineState === 'finished') return s;
    } catch (_) {}
    await sleep(250);
  }
  return null;
}

async function waitForState(targetStates, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = await api('/api/status');
      if (targetStates.includes(s.engineState)) return s;
    } catch (_) {}
    await sleep(250);
  }
  return null;
}

async function stopEngine() {
  try { await api('/api/stop', 'POST'); } catch (_) {}
  await waitForIdle(10000);
}

let passed = 0;
let failed = 0;
const issues = [];

function ok(name, detail) { passed++; console.log(`  PASS: ${name}${detail ? ' -- ' + detail : ''}`); }
function fail(name, reason) { failed++; issues.push({ name, reason }); console.log(`  FAIL: ${name} -- ${reason}`); }

async function runTest(name, fn) {
  console.log(`\n--- ${name} ---`);
  try { await fn(); } catch (e) { fail(name, 'exception: ' + e.message); }
}

const BASE = {
  url: `http://127.0.0.1:${PORT}/`,
  mode: 'load',
  timeoutMs: 5000,
  confirm: true,
  autoRotate: false,
  simulateUserSession: false,
  requestJitterMs: 0,
  thresholds: { maxErrorRatePct: 100, maxP95Ms: 10000, minRps: 0 },
};

async function main() {
  console.log('============================================================');
  console.log('COMPREHENSIVE END-TO-END TEST (sequential)');
  console.log('============================================================');
  let exitCode = 0;
  try {
    await bootServer();
    console.log(`  (test server booted on 127.0.0.1:${PORT})`);
    // BASE was built at module load with a placeholder port — re-point it now.
    BASE.url = `http://127.0.0.1:${PORT}/`;

  await runTest('1. Server Health', async () => {
    const s = await api('/api/status');
    if (s.engineState) ok('Server responds', 'state=' + s.engineState);
    else fail('Server responds', 'no engineState');
  });

  await runTest('2. Basic Load Test', async () => {
    const s = await api('/api/start', 'POST', { ...BASE, concurrency: 5, durationSec: 5, rampUpSec: 1, trackPhases: true });
    if (!s || s.ok === false) return fail('Start', JSON.stringify(s));
    ok('Start test');
    const final = await waitForState(['finished'], 20000);
    if (!final) return fail('Engine completes', 'timeout waiting for finished');
    if (final.engineState === 'finished') ok('Engine completes', 'state=finished');
    else fail('Engine completes', 'state=' + final.engineState);
    if (final.completed > 10) ok('High throughput', final.completed + ' reqs');
    else fail('High throughput', 'completed=' + final.completed);
    if (final.phases && final.phases.dns !== undefined) ok('Phase dns present', 'mean=' + final.phases.dns.mean.toFixed(2) + 'ms (0 expected for localhost)');
    else fail('Phase dns', 'no dns phase');
    if (final.phases && final.phases.ttfb && final.phases.ttfb.mean > 0) ok('Phase ttfb', 'mean=' + final.phases.ttfb.mean.toFixed(2) + 'ms');
    else fail('Phase ttfb', JSON.stringify(final.phases || 'no phases'));
  });

  await waitForIdle(5000);

  await runTest('3. Auto-abort Test', async () => {
    const s = await api('/api/start', 'POST', { ...BASE, url: `http://127.0.0.1:${PORT}/fail`, concurrency: 10, durationSec: 30, rampUpSec: 1, abortOnErrorRatePct: 10 });
    if (!s || s.ok === false) return fail('Start', JSON.stringify(s));
    ok('Start fail test');
    await sleep(3000);
    const status = await api('/api/status');
    if (status.abortReason) ok('Auto-abort fired', status.abortReason.substring(0, 80));
    else fail('Auto-abort', 'no abort reason, state=' + status.engineState);
  });

  await waitForIdle(10000);

  await runTest('4. TLS Fingerprint Config', async () => {
    const s = await api('/api/start', 'POST', { ...BASE, concurrency: 2, durationSec: 3, rampUpSec: 1, tlsFingerprint: 'firefox121' });
    if (!s || s.ok === false) return fail('Start', JSON.stringify(s));
    ok('TLS fingerprint firefox121 accepted');
    const final = await waitForState(['finished'], 10000);
    if (final && final.engineState === 'finished') ok('TLS test completes');
    else fail('TLS test completes', 'state=' + (final ? final.engineState : 'timeout'));
  });

  await waitForIdle(5000);

  await runTest('5. Stop Test', async () => {
    await api('/api/start', 'POST', { ...BASE, concurrency: 5, durationSec: 300, rampUpSec: 1 });
    await sleep(2000);
    const s1 = await api('/api/status');
    if (s1.engineState === 'running') ok('Test running before stop');
    else fail('Test running', 'state=' + s1.engineState);
    await api('/api/stop', 'POST');
    const s2 = await waitForState(['finished'], 10000);
    if (s2 && s2.engineState === 'finished') ok('Test stopped', 'state=finished');
    else fail('Test stopped', 'state=' + (s2 ? s2.engineState : 'timeout'));
  });

  await waitForIdle(5000);

  await runTest('6. Phase Tracking (standalone)', async () => {
    const s = await api('/api/start', 'POST', { ...BASE, concurrency: 3, durationSec: 5, rampUpSec: 1, trackPhases: true });
    if (!s || s.ok === false) return fail('Start', JSON.stringify(s));
    const final = await waitForState(['finished'], 15000);
    if (!final) return fail('Wait', 'timeout');
    if (final.phases) ok('Phase data present');
    else fail('Phase data', 'no phases');
    if (final.phases && final.phases.dns !== undefined) ok('Phase dns present', 'mean=' + final.phases.dns.mean.toFixed(2) + 'ms (0 expected for localhost)');
    else fail('Phase dns', 'no dns phase');
    if (final.phases && final.phases.ttfb && final.phases.ttfb.mean > 0) ok('Phase ttfb', 'mean=' + final.phases.ttfb.mean.toFixed(2) + 'ms');
    else fail('Phase ttfb', JSON.stringify(final.phases || 'no phases'));
  });

  await waitForIdle(5000);

  await runTest('7. Report API', async () => {
    const r = await api('/api/report');
    if (r && r.report) ok('Report API returns data');
    else fail('Report API', 'no report');
  });

  await runTest('8. Validate API', async () => {
    const v = await api('/api/validate', 'POST', { url: `http://127.0.0.1:${PORT}/` });
    if (v && v.ok !== false) ok('Validate API works');
    else fail('Validate API', JSON.stringify(v));
  });

  await runTest('9. SSE Stream + Heartbeat', async () => {
    await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let req = null;
      const done = (fn) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { if (req) req.destroy(); } catch (_) { /* ignore */ }
        if (fn) fn();
        resolve();
      };
      let data = '';
      // Attach the error handler synchronously: if the server is unreachable
      // the request errors before any response callback runs, and without
      // this the process crashes on an unhandled 'error' event.
      req = http.get(`http://127.0.0.1:${PORT}/api/stream`, (res) => {
        res.on('data', (chunk) => {
          if (settled) return;
          data += chunk.toString();
          if (data.includes(': heartbeat') && data.includes('data:')) {
            done(() => {
              ok('SSE stream delivers data');
              ok('SSE heartbeat present');
            });
          }
        });
        res.on('error', () => done());
        res.on('close', () => done());
      });
      req.on('error', (e) => done(() => fail('SSE stream', e.message)));
      timer = setTimeout(() => {
        if (settled) return;
        done(() => {
          if (data.includes('data:')) ok('SSE stream delivers data');
          else fail('SSE stream', 'no data');
          if (data.includes(': heartbeat')) ok('SSE heartbeat present');
          else fail('SSE heartbeat', 'no heartbeat after 10s');
        });
      }, 10000);
    });
  });

  await runTest('10. Paced RPS Test', async () => {
    const s = await api('/api/start', 'POST', { ...BASE, concurrency: 5, rps: 100, durationSec: 10, rampUpSec: 2 });
    if (!s || s.ok === false) return fail('Start', JSON.stringify(s));
    const final = await waitForState(['finished'], 20000);
    if (!final) return fail('Wait', 'timeout');
    if (final.rps > 60 && final.rps < 160) ok('Paced RPS ~100', 'actual: ' + final.rps.toFixed(1));
    else fail('Paced RPS', 'rps=' + final.rps);
  });

  await waitForIdle(5000);

  await runTest('11. Header Profile Config', async () => {
    const s = await api('/api/start', 'POST', { ...BASE, concurrency: 2, durationSec: 3, rampUpSec: 1, headerProfile: 'desktop-firefox' });
    if (!s || s.ok === false) return fail('Start', JSON.stringify(s));
    ok('Header profile accepted');
    await waitForState(['finished'], 10000);
  });

  await waitForIdle(5000);

  await runTest('12. reuseConnections=false', async () => {
    const s = await api('/api/start', 'POST', { ...BASE, concurrency: 2, durationSec: 3, rampUpSec: 1, reuseConnections: false });
    if (!s || s.ok === false) return fail('Start', JSON.stringify(s));
    ok('reuseConnections=false accepted');
    await waitForState(['finished'], 10000);
  });

  await waitForIdle(5000);

  await runTest('13. Max Redirects=0', async () => {
    const s = await api('/api/start', 'POST', { ...BASE, concurrency: 2, durationSec: 3, rampUpSec: 1, maxRedirects: 0 });
    if (!s || s.ok === false) return fail('Start', JSON.stringify(s));
    ok('maxRedirects=0 accepted');
    await waitForState(['finished'], 10000);
  });

  await waitForIdle(5000);

  await runTest('14. Stress Mode', async () => {
    const s = await api('/api/start', 'POST', { ...BASE, mode: 'stress', concurrency: 10, durationSec: 30, rampUpSec: 1, stress: { start: 10, step: 10, max: 30, stepDurationSec: 5 } });
    if (!s || s.ok === false) return fail('Start', JSON.stringify(s));
    ok('Stress mode started');
    const final = await waitForState(['finished'], 45000);
    if (final && final.engineState === 'finished') ok('Stress mode completes', 'state=finished');
    else fail('Stress mode completes', 'state=' + (final ? final.engineState : 'timeout'));
  });

  console.log('\n============================================================');
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('============================================================');
  if (issues.length > 0) {
    console.log('\nFAILED TESTS:');
    issues.forEach(i => console.log(`  - ${i.name}: ${i.reason}`));
  }
  await stopEngine().catch(() => {});
    exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('e2e harness failed:', e && e.message ? e.message : e);
    exitCode = 2;
  } finally {
    shutdownServer();
  }
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(2); });

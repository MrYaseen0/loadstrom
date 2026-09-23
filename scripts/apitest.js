'use strict';

// Integration test: boots the real server, exercises the API end to end against the
// built-in demo target, and checks the safety gates. Run: node scripts/apitest.js

const { spawn } = require('child_process');
const path = require('path');

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForHealth(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

async function post(pathname, body) {
  const r = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', OPEN_BROWSER: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(String(d)));

  let failures = 0;
  const check = (name, cond, detail) => {
    if (!cond) failures++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}`);
  };

  try {
    check('server boots and answers /api/health', await waitForHealth());

    // demo target reachable
    const demo = await fetch(`${BASE}/demo/fast`).then((r) => r.text());
    check('built-in demo target responds', demo === 'ok', demo.slice(0, 20));

    // malformed percent-encoding must not crash the server
    let malformedStatus = 0;
    try {
      malformedStatus = (await fetch(`${BASE}/%E0%A4%A`)).status;
    } catch (e) {
      malformedStatus = -1;
    }
    check('malformed %-path answered without crash (400)', malformedStatus === 400, `status=${malformedStatus}`);
    check('server still healthy after malformed path', await waitForHealth(3000));

    // safety: no confirm
    const noConfirm = await post('/api/start', { url: `${BASE}/demo/fast`, concurrency: 5, durationSec: 2 });
    check('start without confirm is rejected (400)', noConfirm.status === 400, noConfirm.body && noConfirm.body.error);

    // safety: well-known third party blocked
    const blocked = await post('/api/start', { url: 'https://www.google.com', confirm: true });
    check('well-known third-party host is blocked (400)', blocked.status === 400, blocked.body && blocked.body.error);

    // safety: bad scheme
    const badScheme = await post('/api/start', { url: 'ftp://example.com', confirm: true });
    check('non-http scheme is rejected (400)', badScheme.status === 400, badScheme.body && badScheme.body.error);

    // real test run
    const start = await post('/api/start', {
      url: `${BASE}/demo/fast`,
      confirm: true,
      mode: 'load',
      concurrency: 30,
      durationSec: 5,
      rampUpSec: 0,
      timeoutMs: 5000,
      thresholds: { maxErrorRatePct: 1, maxP95Ms: 1000 },
    });
    check('valid start accepted (202)', start.status === 202, JSON.stringify(start.body));

    // running snapshot
    await sleep(1500);
    const status = await fetch(`${BASE}/api/status`).then((r) => r.json());
    check('status shows running with traffic', status.engineState === 'running' && status.attempted > 0, `state=${status.engineState} attempted=${status.attempted}`);

    // double-start guard
    const double = await post('/api/start', { url: `${BASE}/demo/fast`, confirm: true, durationSec: 2 });
    check('second concurrent start rejected (409)', double.status === 409, double.body && double.body.error);

    // wait for finish
    let final = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const s = await fetch(`${BASE}/api/status`).then((r) => r.json());
      if (s.engineState === 'finished' || s.engineState === 'error') { final = s; break; }
    }
    check('test reached finished', final && final.engineState === 'finished', final && final.engineState);
    check('finished: verdict computed', final && final.result && ['pass', 'warn', 'fail'].includes(final.result.status), final && final.result && final.result.status);

    const report = await fetch(`${BASE}/api/report`).then((r) => r.json());
    check('report endpoint returns a report', report && report.report && report.report.metrics, 'ok');
    if (report && report.report) {
      console.log('\n--- report ---');
      console.log(JSON.stringify({
        target: report.report.config.url,
        verdict: report.report.result.status,
        rps: report.report.metrics.rps.toFixed(1),
        p95: report.report.metrics.latency.p95.toFixed(1),
        errPct: (report.report.metrics.errRate * 100).toFixed(2),
        attempted: report.report.metrics.attempted,
      }, null, 2));
    }

    // stress mode quick run
    const stress = await post('/api/start', {
      url: `${BASE}/demo/slow?ms=40`,
      confirm: true,
      mode: 'stress',
      stress: { start: 5, step: 5, max: 15, stepDurationSec: 2 },
      timeoutMs: 5000,
      thresholds: { maxErrorRatePct: 1, maxP95Ms: 100000 },
    });
    check('stress start accepted (202)', stress.status === 202, JSON.stringify(stress.body));
    let stressDone = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const s = await fetch(`${BASE}/api/status`).then((r) => r.json());
      if (s.engineState === 'finished' || s.engineState === 'error') { stressDone = s; break; }
    }
    check('stress produced ramp steps', stressDone && stressDone.steps && stressDone.steps.length >= 1, stressDone && JSON.stringify(stressDone.steps));

    // spike mode quick run via API
    const spike = await post('/api/start', {
      url: `${BASE}/demo/fast`,
      confirm: true,
      mode: 'spike',
      spikeUsers: 10,
      spikeHoldSec: 2,
      timeoutMs: 5000,
      thresholds: { maxErrorRatePct: 50, maxP95Ms: 100000 },
    });
    check('spike start accepted (202)', spike.status === 202, JSON.stringify(spike.body));
    let spikeDone = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const s = await fetch(`${BASE}/api/status`).then((r) => r.json());
      if (s.engineState === 'finished' || s.engineState === 'error') { spikeDone = s; break; }
    }
    check('spike finished and kept its mode', spikeDone && spikeDone.mode === 'spike', spikeDone && String(spikeDone.mode));
    check('spike sent requests', spikeDone && spikeDone.attempted > 10, String(spikeDone && spikeDone.attempted));

    // oversized body rejected with 413 (64KB cap)
    const big = await post('/api/start', { url: `${BASE}/demo/fast`, confirm: true, body: 'x'.repeat(70000) });
    check('oversized body rejected (413)', big.status === 413, `status=${big.status}`);

    // split frontend assets serve
    const fmtJs = await fetch(`${BASE}/format.js`).then((r) => r.status);
    const chartsJs = await fetch(`${BASE}/charts.js`).then((r) => r.status);
    check('split frontend assets serve (format/charts)', fmtJs === 200 && chartsJs === 200, `format=${fmtJs} charts=${chartsJs}`);

    // tor-status shape (no Tor here: socks null + hint; must not crash)
    const tor = await fetch(`${BASE}/api/tor-status`).then((r) => r.json());
    check('tor-status returns shape', tor && tor.ok === true && 'socks' in tor && 'control' in tor, JSON.stringify(tor));

    // reset
    const reset = await post('/api/reset', {});
    check('reset works', reset.status === 200 && reset.body.ok === true, JSON.stringify(reset.body));

    // --- security scan endpoint ---
    const secNoConfirm = await post('/api/security', { url: `${BASE}/demo/fast` });
    check('security scan requires confirm', secNoConfirm.status === 400 && secNoConfirm.body && !secNoConfirm.body.ok,
      `status=${secNoConfirm.status}`);
    const secBlocked = await post('/api/security', { url: 'http://169.254.169.254/', confirm: true });
    check('security scan rejects unsafe target', secBlocked.status === 400, `status=${secBlocked.status}`);
    const secScan = await post('/api/security', { url: `${BASE}/demo/fast`, confirm: true });
    const secFindings = secScan.body && secScan.body.findings;
    check('security scan returns score + findings',
      secScan.status === 200 && secScan.body.ok === true && typeof secScan.body.score === 'number' && Array.isArray(secFindings) && secFindings.length > 0,
      `status=${secScan.status} score=${secScan.body && secScan.body.score} findings=${secFindings && secFindings.length}`);

    // --- target-defense detection via /demo/wall (200s, then 403 wall) ---
    const wallStart = await post('/api/start', { url: `${BASE}/demo/wall`, mode: 'load', concurrency: 4, durationSec: 20, confirm: true });
    check('wall test starts', wallStart.status === 202, `status=${wallStart.status}`);
    let wallRep = null;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const jr = await fetch(`${BASE}/api/report`).then((r) => r.json());
        wallRep = jr && jr.report;
      } catch (e) { /* server busy */ }
      if (wallRep && wallRep.state === 'finished') break;
    }
    check('wall test finished early on defense', !!wallRep && wallRep.state === 'finished' && wallRep.wallClockSec < 15,
      wallRep ? `state=${wallRep.state} wall=${wallRep.wallClockSec}s` : 'no report');
    check('defense detected in report', !!(wallRep && wallRep.defense && wallRep.defense.detected),
      wallRep && wallRep.defense ? `type=${wallRep.defense.type} code=${wallRep.defense.dominantCode}` : 'no defense');
    check('verdict is defended', !!(wallRep && wallRep.result && wallRep.result.status === 'defended'),
      wallRep && wallRep.result && wallRep.result.status);
  } finally {
    server.kill();
  }

  // --- demo target under sign-in: the engine must carry the caller's session
  // to the local /demo/* endpoint, otherwise every hit 401s (dead demo button).
  const APORT = 8898;
  const ABASE = `http://127.0.0.1:${APORT}`;
  const aserver = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(APORT), HOST: '127.0.0.1', OPEN_BROWSER: '0',
      STROMFIRE_PASSWORD: 'apitest-secret',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  aserver.stderr.on('data', (d) => process.stderr.write(String(d)));
  const apost = async (pathname, body, cookie) => {
    const r = await fetch(`${ABASE}${pathname}`, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}),
      body: JSON.stringify(body || {}),
    });
    const setCookie = r.headers.get('set-cookie') || '';
    return { status: r.status, body: await r.json().catch(() => null), setCookie };
  };
  try {
    let up = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      try { const r = await fetch(`${ABASE}/api/health`); if (r.ok) { up = true; break; } } catch (e) {}
      await sleep(200);
    }
    check('auth-enabled server boots', up);
    if (up) {
      const login = await apost('/api/login', { username: 'admin', password: 'apitest-secret' });
      check('login works on auth server', login.status === 200 && login.body.ok === true, `status=${login.status}`);
      const cookie = (login.setCookie.split(';')[0] || '').trim();
      const st = await apost('/api/start', {
        url: `${ABASE}/demo/fast`, mode: 'load', concurrency: 5, durationSec: 3, confirm: true,
      }, cookie);
      check('demo test starts under sign-in', st.status === 202, `status=${st.status}`);
      await sleep(4500);
      const rep = await fetch(`${ABASE}/api/report`, { headers: { cookie } }).then((r) => r.json());
      const m = rep && rep.report && rep.report.metrics;
      check('demo test passes session to engine (no 401s)', !!m && m.ok > 0 && m.failed === 0,
        m ? `ok=${m.ok} failed=${m.failed} codes=${JSON.stringify(m.statusCounts)}` : 'no report');
    }
  } finally {
    aserver.kill();
  }

  console.log(`\n${failures === 0 ? 'ALL API CHECKS PASSED' : failures + ' API CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('api test crashed:', e);
  process.exit(1);
});

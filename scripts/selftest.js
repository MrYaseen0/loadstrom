'use strict';

// Standalone engine self-test: spins up a local throwaway HTTP server and runs a
// short load test against it, then prints the summary. Verifies the engine end to
// end without needing the dashboard.
//
//   node scripts/selftest.js
//
// Exits 0 on success, 1 on failure.

const http = require('http');
const { LoadEngine } = require('../lib/engine');

function startFixtureServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('slow ok');
        }, 30);
      } else if (u.pathname === '/flaky') {
        if (Math.random() < 0.2) {
          res.writeHead(500);
          res.end('boom');
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  const fixture = await startFixtureServer();
  const port = fixture.address().port;
  const base = `http://127.0.0.1:${port}`;

  let failures = 0;
  const check = (name, cond, detail) => {
    const ok = !!cond;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}`);
  };

  // 1) Steady load against a fast endpoint
  const engine1 = new LoadEngine({
    url: `${base}/fast`,
    mode: 'load',
    concurrency: 25,
    rps: 0,
    durationSec: 4,
    rampUpSec: 1,
    timeoutMs: 5000,
    thresholds: { maxErrorRatePct: 1, maxP95Ms: 1000 },
    // Disable anonymity features for baseline performance test
    requestJitterMs: 0,
    simulateUserSession: false,
    isolateCookies: false,
    requestOrderRandomization: false,
    rotateHeaders: false,
  });
  const sum1 = await engine1.run();
  console.log('\n--- steady load summary ---');
  console.log(JSON.stringify({ rps: sum1.metrics.rps, p95: sum1.metrics.latency.p95, errPct: sum1.metrics.errRate * 100, verdict: sum1.result.status }, null, 2));
  check('steady: completed > 100 requests', sum1.metrics.completed > 100, `${sum1.metrics.completed}`);
  check('steady: no failures', sum1.metrics.failed === 0, `failed=${sum1.metrics.failed}`);
  check('steady: verdict is pass', sum1.result.status === 'pass', sum1.result.status);
  check('steady: rps > 0', sum1.metrics.rps > 0, sum1.metrics.rps.toFixed(1));

  // 2) Target-RPS pacing accuracy
  const engine2 = new LoadEngine({
    url: `${base}/fast`,
    mode: 'load',
    concurrency: 50,
    rps: 200,
    durationSec: 5,
    timeoutMs: 5000,
    requestJitterMs: 0,
    simulateUserSession: false,
    isolateCookies: false,
    requestOrderRandomization: false,
    rotateHeaders: false,
    pacing: 'precise',
  });
  const sum2 = await engine2.run();
  const achieved = sum2.metrics.rps;
  console.log('\n--- paced load ---');
  console.log(JSON.stringify({ targetRps: 200, achievedRps: achieved.toFixed(1), completed: sum2.metrics.completed }, null, 2));
  check('paced: achieved rps within +/-25% of 200', achieved > 150 && achieved < 250, achieved.toFixed(1));

  // 3) Flaky endpoint should surface errors
  const engine3 = new LoadEngine({
    url: `${base}/flaky`,
    mode: 'load',
    concurrency: 15,
    durationSec: 4,
    timeoutMs: 5000,
    thresholds: { maxErrorRatePct: 1, maxP95Ms: 1000 },
    requestJitterMs: 0,
    simulateUserSession: false,
    isolateCookies: false,
    requestOrderRandomization: false,
    rotateHeaders: false,
  });
  const sum3 = await engine3.run();
  console.log('\n--- flaky endpoint ---');
  console.log(JSON.stringify({ errPct: (sum3.metrics.errRate * 100).toFixed(1), verdict: sum3.result.status }, null, 2));
  check('flaky: detected errors', sum3.metrics.failed > 0, `failed=${sum3.metrics.failed}`);
  check('flaky: verdict is not pass', sum3.result.status !== 'pass', sum3.result.status);

  // 4) Stop works
  const engine4 = new LoadEngine({ url: `${base}/slow`, mode: 'load', concurrency: 10, durationSec: 60, timeoutMs: 5000,
    requestJitterMs: 0,
    simulateUserSession: false,
    isolateCookies: false,
    requestOrderRandomization: false,
    rotateHeaders: false,
  });
  engine4.run();
  await new Promise((r) => setTimeout(r, 1500));
  engine4.stop();
  await new Promise((r) => setTimeout(r, 1500));
  check('stop: engine reached finished', engine4.state === 'finished' || engine4.state === 'error', engine4.state);

  // 5) Auto-abort safety valve fires on a collapsing target
  //    (fixture fails ~20% of requests; valve is set to 10%)
  //    Note: autoRotate is disabled here so auto-abort can fire
  const engine5 = new LoadEngine({
    url: `${base}/flaky`,
    mode: 'load',
    concurrency: 20,
    durationSec: 30,
    timeoutMs: 5000,
    abortOnErrorRatePct: 10,
    autoRotate: false, // Disable auto-rotate so auto-abort can fire
    requestJitterMs: 0,
    simulateUserSession: false,
    isolateCookies: false,
    requestOrderRandomization: false,
    rotateHeaders: false,
  });
  const sum5 = await engine5.run();
  console.log('\n--- auto-abort ---');
  console.log(JSON.stringify({ abortReason: sum5.abortReason, wallClockSec: sum5.wallClockSec }, null, 2));
  check('auto-abort: reason recorded', typeof sum5.abortReason === 'string' && sum5.abortReason.includes('auto-aborted'), sum5.abortReason);
  check('auto-abort: stopped well before full duration', sum5.wallClockSec < 25, `${sum5.wallClockSec}s`);

  // 6) Config validation: bad URL rejected, oversized API bodies are a
  //    server concern (MAX_BODY=64KB in server.js, covered by apitest.js).
  //    Here we verify normalizeConfig rejects non-http targets locally.
  try {
    const { normalizeConfig } = require('../lib/engine');
    let rejected = false;
    try {
      normalizeConfig({ url: 'ftp://example.com', confirm: true });
    } catch (e) {
      rejected = true;
    }
    check('config-validation: non-http target rejected', rejected === true);
    const okCfg = normalizeConfig({ url: `${base}/`, confirm: true, concurrency: 1, durationSec: 1 });
    check('config-validation: valid target accepted', okCfg.url === `${base}/`, okCfg.url);
  } catch (e) {
    check('config-validation: harness did not crash', false, e.message);
  }

  fixture.close();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('selftest crashed:', e);
  process.exit(1);
});

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

  try { await testHttp2(check); } catch (e) { check("h2: regression harness did not crash", false, e.message); }

  fixture.close();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}


/* ---- HTTP/2 regression: the h2 option must not crash the process ---- */
async function testHttp2(check) {
  const http2 = require('http2');
  const H2_CERT = "-----BEGIN CERTIFICATE-----\nMIIDCTCCAfGgAwIBAgIUdSPsZFGfzTNLrWUCGla8qpXv9NcwDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDkyMzE5MTQzMloXDTM2MDky\nMDE5MTQzMlowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF\nAAOCAQ8AMIIBCgKCAQEAwAECvfPRLdp/QxaCBiDbvUuTLkZ9aXzSUcviX9722CTi\noDnHAbvjs75AeBH7raSG/WjER5m07rO1iwQMW4T2xqh4s2XBoUXn78PsOb7CYpvI\ni6lnRWTvM/24+QJ1MyQPvRkhTSmGkILy4/kMeFO7ug2vpUNRhCpWh8zXpst5Wzra\nE9rTxBmcCyU2fESijVt8Us7bZUr1Db6qGR99OxMKmYP6F4BzAu5oIJ/kN9NjBoaP\n0abx18HgnasmK8SvacjppVCg1jVi3vgXC6ekfN5DbLHzHiDrWb7E87V0Sb4tzPgg\n30m4786GFVtS0YdFeA6wL9FKTUcWZCdWKcTz05/TtQIDAQABo1MwUTAdBgNVHQ4E\nFgQUKRFJMT0vLBxpJK3npa0bJGaPlRcwHwYDVR0jBBgwFoAUKRFJMT0vLBxpJK3n\npa0bJGaPlRcwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAGMGi\n0IdLbNPym595mW0v3iHKT9GeWbmU6qpDa4gEI/3gJ9i64Je//TRyRbVePtpMkVRj\nGtWeFaK9W3VEbuI4DZBtNA8aRJnTl7mvj7w7BINuBaK3/T/SUQrjWcbi46+Q2ioX\nwBEaVsQaC1/EVldNASVNiJCeD9L1PRtr7Ic5GyeBMC6BlRBztBcUyf8c5wNms5TP\n2T+NSSCjZOIpDuijPJqe3LtOIvWh+NOZsw7/q3Nqnm6hEManT+Yc/waeerUTKt+g\nD32p+mgx7Yx9GZxG7PI/WeHt7CqjVYYr8fKVaQTQtxxBWOxt2wtNp5PURtWqMTQL\nTpLYuoViomz1UJNB9w==\n-----END CERTIFICATE-----";
  const H2_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDAAQK989Et2n9D\nFoIGINu9S5MuRn1pfNJRy+Jf3vbYJOKgOccBu+OzvkB4EfutpIb9aMRHmbTus7WL\nBAxbhPbGqHizZcGhRefvw+w5vsJim8iLqWdFZO8z/bj5AnUzJA+9GSFNKYaQgvLj\n+Qx4U7u6Da+lQ1GEKlaHzNemy3lbOtoT2tPEGZwLJTZ8RKKNW3xSzttlSvUNvqoZ\nH307EwqZg/oXgHMC7mggn+Q302MGho/RpvHXweCdqyYrxK9pyOmlUKDWNWLe+BcL\np6R83kNssfMeIOtZvsTztXRJvi3M+CDfSbjvzoYVW1LRh0V4DrAv0UpNRxZkJ1Yp\nxPPTn9O1AgMBAAECggEAD0YlTzIdsl2e4RnhxxYHFQR1lWlTIbilzI8BF6pXjbNF\negSOocMuJobcfxDDKjmb6X3Tm3SNUa3nI8NzLjaiIQSW8YKHSEqU3FyEJsXXlduZ\ntQ6JYhpY8xRciiaZZzOXsu3UWdyTUVyxcNRHmyziErdzAR0dV3u8vXncr+6g3VJq\nY++KFJvo09YunD89NLDPMKkhVRutOe5jdtOncrWauIgXcXahsF24sj2rq6JI60uS\n9uv35IST466pmGv3aBBMvssqJTPwRGVIYwe8S0isoos3Hrew89PxSZWz/wKHnjaH\nEofZmC7TGq43IyWLVhdlf55ko5rIYT5TYUVhl3SLQwKBgQDpSVN+baGH3S+gC5eg\n6nFVfo6Zx/CTjS5PI/jDTgHzbjf1/j37v3ifoHf0s0tKdn3dkXHZEraz3ZaHptBU\nqO4milg8ReRtoeJFkBCKFIAVkU8SPzPxGdaEx3fkzpiq/54R9xWGjQDttVHnGtm0\nOIT8SoB3AEtOJXCDsIQwnJxeIwKBgQDSsreNTuhbSyaYaGJ+lUmp1pFTgEiQg2f/\nXpH6mg4ZP9TRqrl10Kk3QULfhQZcyagyER7i+kwxLnAJMS5nLMxJOfV5Y9leTaFt\n+/CzY1YbCiobYXOV+tL1b68ud4+LEGtzipef9VTPw25DaBRK09GDCYjjgUIALB5T\nagSkb2boRwKBgD8xns17sysTrqgDG+L6PxMywjxEHhZKQ0Yq72MwiXTA4aXgZjgA\n6RMMrBH8U6PrLzNLB/UOjbFxkCpU9NBKJqEIDtjc8gEEvj+rw98zqHKvNyUxO8fP\nAP5c7kxr7o07yz0AmrMlFSBPYs1gx6J7QQL6x4v053FW0QDLWzOz6OPTAoGAX+Oa\nCaN5t+Kxw/btrHJAvhy6sufVHn/PWrctdIGcHP2h23H5SZcXC+CVkKg3xw63j2Gf\nTulet5tMvcI2PhpzNng8MWyxxmtKJoXce6efzlqH40Ismns2eyDC90DOgRmN7V2L\nt+6tFIj6q464fX19Akfalr+CzBVID+pWBof0q40CgYAaX0XFSwlcpQpCwzslWXE/\n+LP3rteNbbdZZO4EWZBxZvjws72SBp9mMLFewmjDqSszgqgXu8gW5PIIjtgyX/v+\nn61Kn8Q1QhbSN9pySv+UZsE21g6gBtYtXssjCZIbKFFJl1kx9zcg0p+lMI7NGTP+\n6p3VPznZL8T4nvfgb5UKjg==\n-----END PRIVATE KEY-----";
  // 1) createConnection against a dead port must not throw / crash
  {
    const eng = new LoadEngine({ url: 'https://127.0.0.1:1/', mode: 'load', concurrency: 1, durationSec: 1, confirm: true, httpVersion: '2', tlsVerify: false, thresholds: { maxErrorRatePct: 100, maxP95Ms: 60000, minRps: 0 } }, {});
    const sess = eng._h2Session('https://127.0.0.1:1');
    await new Promise((r) => setTimeout(r, 800));
    check('h2: session creation on dead host does not crash', sess);
    try { sess.destroy(); } catch (e) {}
  }
  // 2) full h2 run against a real TLS+h2 server
  const srv = http2.createSecureServer({ key: H2_KEY, cert: H2_CERT, allowHTTP1: true });
  srv.on('stream', (stream) => { stream.respond({ ':status': 200 }); stream.end('h2-ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const eng = new LoadEngine({ url: 'https://127.0.0.1:' + port + '/', mode: 'load', concurrency: 5, durationSec: 3, timeoutMs: 8000, confirm: true, httpVersion: '2', tlsVerify: false, thresholds: { maxErrorRatePct: 100, maxP95Ms: 60000, minRps: 0 } }, {});
  await eng.run();
  const m = eng.summary().metrics;
  check('h2: full run over HTTP/2 succeeds', m.ok > 0 && m.failed === 0, m.ok + ' ok / ' + m.failed + ' failed');
  srv.close();
}

main().catch((e) => {
  console.error('selftest crashed:', e);
  process.exit(1);
});

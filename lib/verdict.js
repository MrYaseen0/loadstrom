'use strict';

// Turns a metrics snapshot + user thresholds into a plain-language verdict:
// "did my website handle this load or not?"

/**
 * @param {object} s     metrics snapshot (see Metrics.snapshot)
 * @param {object} thr   thresholds
 * @param {number} [thr.maxErrorRatePct=1]  fail if error rate (%) above this
 * @param {number} [thr.maxP95Ms=1000]      fail if p95 latency (ms) above this
 * @param {number} [thr.minRps=0]           warn/fail if throughput below this
 * @param {object} [ctx]                    run context
 * @param {boolean} [ctx.proxied=false]     true when traffic went through a proxy (engine passes cfg.proxy/proxyList)
 * @param {object} [ctx.defense=null]       target-defense finding from the engine ({detected,type,...})
 * @returns {{status:'pass'|'warn'|'fail'|'defended', headline:string, reasons:string[], recommendations:string[]}}
 */
function evaluate(s, thr = {}, ctx = {}) {
  // Target defended itself: the run measured the target's protection,
  // not its capacity. This is a finding, not a failure.
  if (ctx && ctx.defense && ctx.defense.detected) {
    const d = ctx.defense;
    const typeLabel = d.type === 'rate-limit' ? 'rate limiting'
      : d.type === 'ip-block' ? 'IP/WAF blocking' : 'service protection';
    const when = d.fromStart
      ? 'from the very first requests'
      : `at request #${d.firstSeenRequest} (~${d.rpsAtDetection} rps)`;
    return {
      status: 'defended',
      headline: `Target defended itself with ${typeLabel} (HTTP ${d.dominantCode}) ${when} — ${d.defensivePct}% of recent responses were defensive.`,
      reasons: [
        `${d.defensivePct}% of the last responses were defensive (403: ${d.codes[403]}, 429: ${d.codes[429]}, 503: ${d.codes[503]}).`,
        d.retryAfterHonored > 0
          ? `Honored Retry-After backoff on ${d.retryAfterHonored} rate-limited response(s).`
          : null,
        'The test was stopped at the defense trigger: pushing harder would only hammer the protection layer, not measure server capacity.',
      ].filter(Boolean),
      recommendations: [
        'This is a finding about the target\u2019s protection, not a capacity failure. To measure raw capacity, allow-list the test IP in the WAF / add a test bypass rule, then re-run.',
        'To find the real breaking point, use Stress mode and watch for the request count / RPS where the defense first triggers \u2014 that threshold is the number to report.',
        'If this is your own site and the block was unexpected, check WAF rate-limit rules and bot-management settings for false positives on legitimate traffic patterns.',
      ],
    };
  }

  const maxErr = num(thr.maxErrorRatePct, 1);
  const maxP95 = num(thr.maxP95Ms, 1000);
  const minRps = num(thr.minRps, 0);

  const errPct = (s.errRate || 0) * 100;
  const p95 = (s.latency && s.latency.p95) || 0;
  const p99 = (s.latency && s.latency.p99) || 0;
  const rps = s.rps || 0;

  const reasons = [];
  const recommendations = [];
  let status = 'pass';

  const fail = (m) => { status = 'fail'; reasons.push(m); };
  const warn = (m) => { if (status !== 'fail') status = 'warn'; reasons.push(m); };

  // ---- error rate ----
  if (s.attempted > 0) {
    if (errPct > maxErr) {
      fail(`Error rate ${errPct.toFixed(2)}% exceeds the allowed ${maxErr}%.`);
    } else if (errPct > maxErr * 0.5) {
      warn(`Error rate ${errPct.toFixed(2)}% is close to the ${maxErr}% limit.`);
    }
  } else {
    warn('No requests completed — nothing was measured.');
  }

  if (s.timeouts > 0) {
    const toPct = s.attempted ? (s.timeouts / s.attempted) * 100 : 0;
    // Timeouts already inflate errPct above; don't double-fail when the
    // error-rate gate already fired — add context instead.
    const errAlreadyFailed = status === 'fail';
    if (toPct > 0.5) {
      if (errAlreadyFailed) reasons.push(`${s.timeouts} of those failures were timeouts (${toPct.toFixed(2)}% of traffic).`);
      else fail(`${s.timeouts} requests timed out (${toPct.toFixed(2)}% of traffic).`);
    } else {
      warn(`${s.timeouts} request(s) timed out.`);
    }
  }

  // ---- latency ----
  if (s.attempted > 0) {
    if (p95 > maxP95) {
      fail(`p95 latency ${p95.toFixed(0)} ms exceeds the allowed ${maxP95} ms.`);
    } else if (p95 > maxP95 * 0.7) {
      warn(`p95 latency ${p95.toFixed(0)} ms is approaching the ${maxP95} ms limit.`);
    }
  }

  // ---- throughput ----
  if (minRps > 0 && rps < minRps) {
    warn(`Throughput ${rps.toFixed(0)} rps is below the expected minimum ${minRps} rps.`);
  }

  // Soak degradation: second half of a soak run worse than the first.
  // Slow decay (leaks, queue build-up, connection exhaustion) is exactly
  // what a soak test exists to catch.
  if (ctx && ctx.soak && ctx.soak.checked && ctx.soak.degraded) {
    const sk = ctx.soak;
    const f = sk.firstHalf || {};
    const s = sk.secondHalf || {};
    const e1 = (f.errRate * 100).toFixed(1);
    const e2 = (s.errRate * 100).toFixed(1);
    warn(
      `Soak degradation: the site got worse in the second half — ` +
      `error rate ${e2}% vs ${e1}% first half, ` +
      `avg latency ${s.avgMs}ms vs ${f.avgMs}ms first half. ` +
      `Possible leak, queue build-up, or connection exhaustion.`
    );
    recommendations.push('Run a longer soak and watch server memory/connections during the second half to find the leak or bottleneck.');
  }

  // ---- guidance ----
  // When nothing ever came back (0 completed, 0 bytes, ~all timeouts/conn
  // errors) the failure happened in the client/proxy path — e.g. Tor
  // overloaded or rotating — not on the target server. Say so explicitly
  // instead of advising server capacity work.
  const proxySide = (s.attempted || 0) > 0 && (s.completed || 0) === 0 &&
    ((s.timeouts || 0) + (s.connErrors || 0)) >= (s.attempted || 0) * 0.9;
  // Same 0-response collapse looks different with vs without a proxy:
  // Tor/proxy guidance is wrong (and confusing) for a direct run, where a
  // stall in dns/tcp/tls is the client→server path itself.
  const proxied = !!(ctx && ctx.proxied);
  if (failCount(s)) {
    if (proxySide && !proxied) {
      recommendations.push('No request got a response (0 completed, 0 bytes) — the connection stalled before any HTTP response on the direct client→server path (no proxy configured), so this says nothing about the server\'s capacity.');
      recommendations.push('Check the phase breakdown (dns/tcp/tls/ttfb): instant tcp but a huge tls phase means the TLS handshake never completed — SNI filtering, a WAF challenge, or a handshake stall. Raise timeoutMs and re-run.');
      recommendations.push('If tcp itself never connects, the host/port is unreachable from here (firewall, DNS, or down) — verify with a plain curl before load testing.');
    } else if (proxySide) {
      recommendations.push('No request got a response (0 completed, 0 bytes) — failures happened in the load path (proxy/Tor/network), so this result says nothing about the target server\'s capacity.');
      recommendations.push('Tor carries ~10–20 concurrent users per circuit: drop concurrency to 10–20, raise timeoutMs to 30000+, and re-run. Hundreds of users through one exit node only queue and time out.');
      recommendations.push('Check the rotation log: repeated "Tor control timeout" means the control port is unreachable (Tor Browser 9151 vs system tor 9051), rate-limited (NEWNYM needs ~10s between calls), or needs TOR_CONTROL_PASSWORD. Fix that before re-running.');
      recommendations.push('Prove the proxy first with POST /api/test-proxy against https://httpbin.org/ip (an IP-echo endpoint), not against the target page — an HTML page cannot show the exit IP.');
    } else {
      recommendations.push('The server started failing under this load. Identify the bottleneck before increasing traffic: check CPU/RAM/disk I/O, database connection pools, worker/process counts, timeouts, and upstream rate limits.');
      if (p95 > maxP95) recommendations.push(`High tail latency (p95 ${p95.toFixed(0)} ms, p99 ${p99.toFixed(0)} ms) usually points to queueing — add capacity (horizontal scale) or a cache, and set sane upstream timeouts.`);
      if (errPct > maxErr) recommendations.push(`Errors at ${errPct.toFixed(2)}% often mean exhaustion: connection limits, too few app workers, or 5xx from an overwhelmed dependency. Check server logs for the exact status codes.`);
    }
  } else if (status === 'warn') {
    recommendations.push('The site held up but is nearing its limits. Re-run with higher concurrency to find the real breaking point (use Stress mode).');
  } else {
    recommendations.push('This load was handled cleanly. Push higher: increase concurrency in Stress mode to find where it starts to bend, then provision ~2x that headroom.');
  }
  if (s.sampleSize != null) {
    recommendations.push(`Latency percentiles are estimated from a reservoir sample of ${s.sampleSize.toLocaleString()} requests (exact count/avg/min/max).`);
  }

  // attemptedRps = offered load; rps = completed responses. When nothing
  // completed, the completed-only rate reads "0 rps" and hides the volume.
  const offered = s.attemptedRps != null ? s.attemptedRps : (s.elapsedSec > 0 ? (s.attempted || 0) / s.elapsedSec : 0);
  const headline = status === 'pass'
    ? `Handled it: ${fmtInt(s.ok)} successful requests (of ${fmtInt(s.completed)} completed) at ${rps.toFixed(0)} rps, p95 ${p95.toFixed(0)} ms, error rate ${errPct.toFixed(2)}%.`
    : status === 'warn'
      ? `Mostly handled, with warnings: ${rps.toFixed(0)} rps, p95 ${p95.toFixed(0)} ms, error rate ${errPct.toFixed(2)}%.`
      : ((s.completed || 0) === 0 && (s.attempted || 0) > 0
        ? `Not handled: ${errPct.toFixed(2)}% errors, p95 ${p95.toFixed(0)} ms — 0 responses from ${fmtInt(s.attempted)} attempts (${offered.toFixed(0)} attempts/s offered). Failures happened before any response, so this measures the load path, not the server.`
        : `Not handled: ${errPct.toFixed(2)}% errors, p95 ${p95.toFixed(0)} ms at ${rps.toFixed(0)} rps.`);

  return { status, headline, reasons, recommendations };
}

function failCount(s) {
  return (s.failed || 0) > 0;
}

function num(v, def) {
  const n = Number(v);
  return isFinite(n) ? n : def;
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

module.exports = { evaluate };

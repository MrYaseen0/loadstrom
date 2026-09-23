# Strom Fire Hardening & Capacity Playbook

**Version:** 1.0  
**For:** Strom Fire self-hosted load tester  
**Scope:** Make the tool itself "more high and secured" — higher safe concurrency, stricter guardrails, safer defaults, and a repeatable capacity-testing methodology you can run against your own targets.

---

## 1. Philosophy

| Principle | What it means for Strom Fire |
|-----------|----------------------------|
| **Safe by default** | Demo target pre-filled; real targets require explicit `confirm=true` on every `/api/start`. |
| **Self-limiting** | Auto-abort valve (`abortOnErrorRatePct`, default 10%; extreme backstop at 50% after 500 requests when auto-rotation is on) stops a run before it hammers a collapsing server. |
| **Bounded resources** | Reservoir sampler caps memory; per-second timeline buckets cap chart data; agent `maxSockets` caps open connections. |
| **No secrets in code** | Zero external deps, no telemetry, no config files with credentials. |
| **Audit trail** | Every run emits a JSON report with config, verdict, metrics, timeline, and (if triggered) `abortReason`. |

---

## 2. Hardening Checklist (apply to *your* Strom Fire instance)

### 2.1 Network / Host

- [ ] **Bind to localhost only** — keep `HOST=127.0.0.1` (default). Never `0.0.0.0` unless behind a VPN/SSH tunnel.
- [ ] **Reverse proxy + TLS** — if you expose the dashboard, put Nginx/Caddy in front with real certs, HTTP auth, and rate limiting.
- [ ] **Firewall** — block inbound 8787 from the internet. Only allow your jump host / dev machine.
- [ ] **OS limits** — raise file descriptors and ephemeral ports on the load generator box:
  ```bash
  # /etc/security/limits.d/loadstorm.conf
  * soft nofile 100000
  * hard nofile 100000
  # Linux kernel
  sysctl -w net.ipv4.ip_local_port_range="1024 65535"
  sysctl -w net.core.somaxconn=4096
  ```

### 2.2 Application Hardening (server.js)

| Setting | Current Default | Recommended for "High & Secured" | Where to change |
|---------|----------------|----------------------------------|-----------------|
| `MAX_BODY` | 1 MB | 64 KB (API only accepts JSON) | `server.js:13` |
| `PORT` | 8787 | Random high port + env var only | `server.js:10` |
| Request timeout | none (Node default) | 5 s hard timeout on `/api/*` | add in `handleApi` |
| SSE heartbeat | 1 s | 2 s (less chatter) | `server.js:85` |
| Demo endpoints | enabled | disable in prod (`DISABLE_DEMO=1`) | wrap `handleDemo` |
| CORS | none (same-origin) | keep none — dashboard is same-origin | — |

**Patch example** (apply to `server.js`):
```js
// Top of file
const MAX_BODY = 64 * 1024; // 64 KB
const REQUEST_TIMEOUT_MS = 5000;

// Inside handleApi, before await readBody(req):
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
req.on('close', () => clearTimeout(timer));
// pass { signal: ctrl.signal } to readBody if you adapt it
```

### 2.3 Engine Hardening (engine.js)

| Guard | Current | Hardened | File/Line |
|-------|---------|----------|-----------|
| Max concurrency | 100,000 | 5,000 (per process) | `engine.js:64` |
| Max RPS | 5,000,000 | 200,000 | `engine.js:65` |
| Max stress step | 100,000 | 2,000 | `engine.js:82` |
| Max stress max | 100,000 | 2,000 | `engine.js:82` |
| Sample cap | 200,000 | 100,000 | `engine.js:72` |
| Agent `maxSockets` | `concurrency + 16` | `Math.min(concurrency, 2000) + 16` | `engine.js:120` |
| Auto-abort default | 50% | **10%** (fail fast) | `engine.js:73` / UI default |
| TLS verify | `true` | **force `true`** (remove checkbox) | `engine.js:69` + UI |

**Why lower ceilings?**  
A single Node process cannot sustainably drive >2k–5k concurrent sockets + high RPS without tuning the OS (see §2.1). Keeping config ceilings realistic prevents "it let me type 50,000 but the box OOM'd" surprises.

### 2.4 Safety Gates (safety.js) — Do Not Weaken

- `KNOWN_PUBLIC_HOSTS` blocklist stays.
- Private IP / localhost allowlist stays.
- `validateTarget` runs **server-side** on every `/api/start` — UI checkbox is UX only.

**Optional: add your own allowlist** (e.g., only `staging.mycorp.com`):
```js
// safety.js — add after KNOWN_PUBLIC_HOSTS
const ALLOWED_HOSTS = new Set([
  'staging.mycorp.com',
  'api.dev.internal',
  '10.0.0.0/8',        // CIDR not supported yet — add exact hosts or extend isPrivateIPv4
]);
function validateTarget(target) {
  // ... existing code ...
  if (!ALLOWED_HOSTS.has(host)) {
    return { ok: false, level: 'block', reason: 'Host not in allowlist.' };
  }
  // ...
}
```

---

## 3. Capacity Testing Methodology (the "Strom Fire Way")

Use this repeatable 3-phase loop **against your own staging / pre-prod** to find the real knee and then harden the target.

### Phase 0 — Baseline (5 min)
```bash
# 1. Smoke test — verify the tool + target work
mode: load
concurrency: 5
durationSec: 30
rps: 0
thresholds: { maxErrorRatePct: 0.1, maxP95Ms: 500 }
```
**Pass gate:** 0 errors, p95 < 200 ms. If not, fix the target first.

### Phase 1 — Steady State (10–20 min)
```bash
mode: load
concurrency: 50           # start here
durationSec: 300          # 5 min
rampUpSec: 30
thresholds: { maxErrorRatePct: 1, maxP95Ms: 1000 }
```
- Increase `concurrency` in steps: 50 → 100 → 200 → 400…
- Stop when **any** threshold fails or auto-abort triggers.
- Record: `concurrency`, `rps`, `p95`, `err%`, CPU/RAM on target.

### Phase 2 — Stress Ramp (15–30 min)
```bash
mode: stress
stress: { start: 20, step: 20, max: 500, stepDurationSec: 60 }
thresholds: { maxErrorRatePct: 5, maxP95Ms: 2000 }
```
- Strom Fire emits a `steps[]` array with verdict per step.
- The first `fail` step = **breaking point**.
- Your **safe operating limit** = 50–70% of breaking point concurrency.

### Phase 3 — Soak (1–4 hrs, optional)
Run at **safe operating limit** for hours. Watch for:
- Memory leaks (rising RSS on target)
- GC pauses (latency spikes every N minutes)
- Connection pool exhaustion (sudden error bursts)

---

## 4. Hardening the *Target* (your app/server)

After you find the knee, apply these in order of ROI:

| Layer | Action | Typical Gain |
|-------|--------|--------------|
| **CDN / Edge** | Cache static assets, HTML (stale-while-revalidate), API GETs | 10–100× RPS for cacheable traffic |
| **App Workers** | Nginx `worker_processes auto`; Node `cluster` / PM2 `instances: max`; PHP-FPM `pm.max_children` | 2–8× (CPU-bound) |
| **DB Pool** | Size = `workers × 2–3`; `statement_timeout`; `idle_in_transaction_session_timeout` | Prevents 500s under load |
| **Timeouts** | Upstream (LB → app) < App → DB < Client → LB | Prevents cascade hangs |
| **Rate Limiting** | Per-IP / per-tenant at edge (429 with `Retry-After`) | Protects against abuse |
| **Compression** | Brotli/Gzip on text responses | 30–70% bandwidth ↓ |
| **Keep-Alive** | `keepalive_timeout 65` (Nginx), `agent.keepAlive=true` (Strom Fire default) | 20–40% latency ↓ |
| **Observability** | `prometheus` metrics + structured logs + distributed tracing | MTTR ↓ 10× |

**Re-test after each change** using Phase 1 + 2. The knee should move right.

---

## 5. Running Multiple Generators (Horizontal Scale)

One Strom Fire process ≈ 2k–5k concurrent users (depends on target latency). For higher load:

```bash
# Generator 1
PORT=8787 HOST=127.0.0.1 node server.js &

# Generator 2 (different machine or container)
PORT=8787 HOST=127.0.0.1 node server.js &

# Coordinator script splits concurrency across generators
# Each generator runs its own Stress mode with disjoint step ranges
# Aggregate results manually (sum rps, weighted p95)
```

**Tip:** Use the same `abortOnErrorRatePct` on all generators so they self-abort together.

---

## 6. Secure CI/CD Integration

```yaml
# .github/workflows/load-test.yml
name: Load Test Staging
on:
  workflow_dispatch:
    inputs:
      target:
        description: 'Staging URL'
        required: true
        default: 'https://staging.mycorp.com'
jobs:
  load-test:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: cd loadstorm && npm ci --omit=dev
      - name: Run steady load
        env:
          TARGET: ${{ inputs.target }}
          CONFIRM: 'true'
        run: |
          cd loadstorm
          node scripts/apitest.js \
            --url "$TARGET" \
            --mode load \
            --concurrency 200 \
            --duration 300 \
            --confirm
      - name: Upload report
        uses: actions/upload-artifact@v4
        with:
          name: loadstorm-report
          path: loadstorm/report-*.json
```

**Requirements for CI:**
- Staging must be a dedicated, disposable environment.
- Runner must have network access to staging (VPC peering / VPN).
- `scripts/apitest.js` needs a tiny CLI wrapper (see below).

---

## 7. Minimal CLI Wrapper (add to `scripts/apitest.js`)

```js
#!/usr/bin/env node
'use strict';
// scripts/apitest.js — integration test for Strom Fire API
// This script boots its own server and tests against the built-in demo target.
// For user-facing CLI, use: node anon-launcher.js "https://target.com" 50 0

const http = require('http');
const { URL } = require('url');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => {
    if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
    return a;
  }, [])
);

const base = new URL('http://127.0.0.1:8787');
async function post(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...base, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const cfg = {
    url: args.url,
    mode: args.mode || 'load',
    concurrency: Number(args.concurrency) || 50,
    durationSec: Number(args.duration) || 60,
    confirm: args.confirm === 'true',
  };
  if (!cfg.url || !cfg.confirm) {
    console.error('Usage: --url <URL> --confirm true [--mode load|stress] [--concurrency N] [--duration S]');
    process.exit(2);
  }
  const start = await post('/api/start', cfg);
  if (!start.body.ok) throw new Error(start.body.error);
  console.log('Started:', start.body);
  // Poll /api/status until finished
  while (true) {
    await new Promise(r => setTimeout(r, 2000));
    const st = await post('/api/status', {});
    console.log('State:', st.body.engineState, 'rps:', st.body.rps?.toFixed(1));
    if (st.body.engineState === 'finished' || st.body.engineState === 'error') break;
  }
  const rep = await post('/api/report', {});
  const fs = require('fs');
  const fname = `report-${Date.now()}.json`;
  fs.writeFileSync(fname, JSON.stringify(rep.body.report, null, 2));
  console.log('Report saved to', fname);
  process.exit(rep.body.report?.result?.status === 'pass' ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
```
Make it executable: `chmod +x scripts/apitest.js`

---

## 8. Quick Reference — Config Cheat Sheet

| Parameter | Load Mode | Stress Mode | Notes |
|-----------|-----------|-------------|-------|
| `concurrency` | 50–500 | (ignored) | Virtual users |
| `rps` | 0 = unlimited | (ignored) | Token bucket pacing |
| `durationSec` | 60–300 | (ignored) | Steady phase length |
| `rampUpSec` | 10–60 | 0 | Spread start |
| `stress.start` | — | 10–50 | First step |
| `stress.step` | — | 10–50 | Increment |
| `stress.max` | — | 200–2000 | Ceiling |
| `stress.stepDurationSec` | — | 30–120 | Time per step |
| `abortOnErrorRatePct` | **10** | **10** | Safety valve |
| `thresholds.maxErrorRatePct` | 1 | 5 | Fail criteria |
| `thresholds.maxP95Ms` | 1000 | 2000 | Fail criteria |

---

## 9. What "Done" Looks Like

- [ ] Strom Fire instance binds to `127.0.0.1`, behind auth + TLS if exposed.
- [ ] OS limits raised on generator box (`ulimit -n`, `ip_local_port_range`).
- [ ] Config ceilings lowered in `engine.js` (concurrency ≤ 5k, RPS ≤ 200k).
- [ ] Auto-abort default = 10% (UI + engine).
- [ ] Allowlist added in `safety.js` for your domains only.
- [ ] Phase 0 → 1 → 2 run cleanly against staging; breaking point identified.
- [ ] Target hardened (workers, pools, timeouts, cache, rate limits); knee moves right.
- [ ] CI job runs steady + stress on every release candidate; gate on `pass`.
- [ ] Report artifacts archived; `abortReason` logged for post-mortems.

---

## 10. Disclaimer

> Strom Fire is a **tool for testing systems you own or are explicitly authorised to test**.  
> This playbook does not authorise testing any third-party system.  
> Unauthorised load testing can violate laws (CFAA, GDPR, etc.) and terms of service.  
> The auto-abort valve, blocklist, and confirmation gate are guardrails — **they are not a substitute for your own judgement or written permission.**

---

*Generated for Strom Fire v1.0.0 — copy, adapt, and keep with your runbooks.*
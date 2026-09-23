# DECISIONS.md — Why Strom Fire is built this way

> Log every meaningful decision the AI makes while changing code — and the reasoning behind it. Code shows *what* changed. This file shows *why*.

Last updated: 2026-09-16 | Session: E2E sweep (ISSUES.md created, all suites green)

### 2026-09-16 — Close-out: I-16/I-17 fixed, zero open issues
- I-16 (shared event loop): documented dedicated-target calibration (`PORT=8788` instance) in `readme.md`.
- I-17 (probe TLS divergence): `/api/test-proxy` now uses shared `tlsOptionsForFingerprint()` (honors `body.tlsFingerprint`); verified via bad-proxy probe (socks+http, custom fingerprint) — `{ok:false}` no crash.
- Verified: `node --check` clean, apitest 17/17, proxy-check PASS.

### 2026-09-16 — Repo-wide completion (see ISSUES.md I-01…I-22)
- `fetch-proxies.js`: added missing `require('tls')`, SOCKS5-handshake branch (was HTTP-CONNECT-only → guaranteed fail for socks5://).
- `e2e-test.js`: `PORT` env, real exit codes, SSE timer leak fixed, `npm run e2e`; `package.json`: `apitest`/`e2e`/`test`/`test:all` scripts; guide `XXX` → concrete numbers.
- Found live bug via full run: global rate limiter 429'd dashboard polling and broke e2e tests 12-14 → scoped limiter to POSTs only. Re-run: e2e 25/25, `npm test` green.

### 2026-09-16 — E2E sweep (test everything, mark issues, fix; see ISSUES.md I-01…I-17)
- Sweeps: selftest 12/12, apitest 17/17, E2E 32/33 (I-01 probe-side flaky expectation), unit 18/18, auth/lifecycle 12/12 (token, reset-busy 409, double-start 409, rate 115+15). Fixed I-02 stale rate comment. All strategies + evidence in ISSUES.md.

### 2026-09-16 — Completion pass (close remaining gaps)
- Context: audit of fix-all-16 found 6 leftovers: `Proxy-Authorization: undefined` sent when no creds; SSRF policy blocked legit LAN (`192.168.x/10.x` from readme); metrics clock-backwards returned stale bucket; `reports/` unbounded; `rateBuckets` leak; `_createAgent`/`_createProxyAgent` still duplicated + dead code after early return.
- Approach:
  - `lib/engine.js`: `buildConnectHeaders()` omits auth when empty (both paths); shared `createHttpProxyAgent`/`createSocksAgent` + `_proxyOpts`/`_buildProxiedAgent` — `_createAgent` and `_createProxyAgent` now delegate (dead 150-line duplicate deleted); single-settle `done()` guards + proxy TLS/SOCKS timeouts on all branches.
  - `lib/safety.js`: `isMetadataIP()` (169.254.x, `::`, `0.0.0.0`, fe80). Policy: literal private LAN/loopback ALLOWED (explicit user choice, readme `http://192.168.1.10:8080` works); hostname resolving to private BLOCKED (rebinding); metadata always blocked. Verified: LAN ok, loopback ok, `169.254.169.254` blocked.
  - `lib/metrics.js`: `sec <= cur.t` returns current bucket (clock-backwards safe); gap-fill capped to `maxTimeline`.
  - `server.js`: `rateBuckets` opportunistic prune (>1000 IPs); `persistReport()` prunes to newest 20.
  - Frontend verified: `index.html` loads `format.js→charts.js→app.js`; no duplicate `fmtNum/drawChart` defs in `app.js`.
- Verified: `node --check` all files OK; `selftest.js` ALL PASSED; `apitest.js` ALL PASSED (incl. 413 + assets).

### 2026-09-16 — Fix all 16 audit issues
- Context: audit found SSRF, fake-passing selftest, think-time default, finish race, TLS no-op, no auth, sort storm, agent leak, readBody reassign, test-proxy /ip hardcode, bucket t desync, fd cap, evasion gating, verdict double-count, no persistence, 881-line app.js.
- Approach:
  - `lib/safety.js`: `isBlockedIP()` + `validateTargetResolved()` (dns.promises.lookup, allow loopback demo, block 169.254/metadata). `server.js:/api/start|validate` now runs sync fast-path then async DNS check.
  - `scripts/selftest.js`: removed undefined `post()` body test; now unit-tests `normalizeConfig` reject/accept. `scripts/apitest.js`: added 413 oversized + format/charts serve checks.
  - `lib/engine.js`: `simulateUserSession` default false (was true → 0.5-3.5s think killed RPS); `_generation` guards `run/stop/_finishEngine` double-finish; `tlsOptionsForFingerprint()` splits `ciphers`/`ciphersuites` + `groups`+`curves`; `_cacheAgent()` LRU-caps at 12; high-concurrency `ulimit` warn; snapshot throttle 250ms; Tor rotation gated by `ENABLE_EVASION=1`.
  - `server.js`: `readBody` no reassign/no destroy (drain+413); test-proxy respects target path, single-settle `finish()`, omits empty auth, handles http targets; `LOADSTORM_TOKEN` for POST /api/* + 120/min IP limit + 0.0.0.0 warning; `reports/last-report.json` persist/load; 413 for >64KB.
  - `lib/metrics.js`: absolute `t` + gap-fill + trim keeps labels; `lib/verdict.js`: timeout context not double-fail when err already failed.
  - `public/`: split `format.js` + `charts.js`, `app.js` keeps state/stream, `index.html` loads 3 scripts.
- Why: keep zero-deps (dns, fs only), smallest safe change, no API break except stricter SSRF/413 and think-time default (documented).
- Verified: `node scripts/selftest.js` ALL PASSED, `node scripts/apitest.js` ALL PASSED (incl. new 413 + assets checks).

## Decision log format (use for all future entries)
```
### YYYY-MM-DD — Short title
- Context: what problem / request triggered this
- Approach chosen: what was done
- Alternatives considered: what was rejected
- Why: library / pattern / tradeoff rationale
- Consequences: what this locks in / follow-ups
```

---

### Baseline — Zero dependencies (Node core only)
- Context: `package.json` has `"dependencies": {}`. Everything is `http/https/http2/tls/net/dns`, vanilla HTML/CSS/JS.
- Approach: No npm packages for server, engine, charts, or SSE.
- Alternatives: Express/Fastify, axios/undici, chart.js, socket.io.
- Why:
  - Single `node server.js` run, works offline, no supply-chain risk, no `npm install` friction (core to readme promise).
  - Full control over sockets/agents needed for proxy CONNECT, SOCKS5 handshake, TLS fingerprint spoofing — frameworks hide this.
- Tradeoff accepted: Hand-rolled static server, routing, body parsing (`server.js:58-103,485-514`). More code to maintain vs. framework convenience.

### Baseline — Closed-model virtual users (`lib/engine.js:_worker`)
- Approach: N worker loops, each `request→response→request`, optional ramp-up stagger, optional rps gate (`_makeGate` / `_makePreciseGate`).
- Alternatives: Open-model Poisson arrivals, separate k6-style VU scheduler library.
- Why: Closed model is simpler to reason about, maps 1:1 to "concurrent users" UI field, and one Node process can drive ~2,200 rps locally. Precise gate (hrtime + spin-wait) only when `pacing:'precise'` to avoid burning CPU by default.
- Tradeoff: Open-model would be more realistic for arrival-rate testing; mitigated by supporting rps cap + jitter + think-time (`simulateUserSession`).

### Baseline — Reservoir-sampled percentiles (`lib/metrics.js`)
- Approach: `Reservoir` (cap 200k) + `PhaseReservoir` for dns/tcp/tls/ttfb/download; min/avg/max exact, p50/p90/p95/p99 estimated. Per-second buckets capped at 256 samples for charts.
- Alternatives: Store every latency (unbounded memory), HDR histogram library.
- Why: Bounded memory for long runs; no dependency; nearest-rank percentile is good enough for pass/fail. Timeline trim (`maxTimeline:1200`) keeps SSE payloads small.
- Tradeoff: Percentiles are estimates; documented in verdict recommendations.

### Baseline — Threshold verdict (`lib/verdict.js:evaluate`)
- Approach: 3 rules — max error % (default 1%), max p95 ms (default 1000ms), min rps (default off) → `pass/warn/fail` + headline + recommendations.
- Why: Answers "can my site handle it?" in plain language. Prefer p95/p99 over averages (readme rule). Warn band at 50%/70% of limit gives early signal before fail.
- Alternatives: Full SLO engine, Apdex. Rejected as overkill for v1.

### Baseline — Safety gates (`lib/safety.js + server.js:/api/start`)
- Approach: Server-side `confirm===true` required + `validateTarget()` blocklist (google, facebook, github, etc.) + auto-abort on error rate (default 10%).
- Why: Load generator is weapon-grade; UI checkbox alone is bypassable. Blocklist is a tripwire, not a complete firewall — documented as such. Auto-abort protects collapsing targets.
- Tradeoff: Small hardcoded list; false sense of completeness if user doesn't read warning. Mitigated by docs + demo target.

### Baseline — SSE live stream + snapshot polling (`server.js:buildStreamPayload, /api/stream, /api/status`)
- Approach: `GET /api/stream` (SSE, heartbeat every 5s) pushes `engine.snapshot()` tail (last 3 timeline buckets); `GET /api/status` for polling fallback.
- Alternatives: WebSockets / socket.io.
- Why: SSE is one-way, works over plain `http` module, auto-reconnects (`retry:3000`), no dependency. Dashboard canvas charts just need 1/sec updates.
- Tradeoff: No bidirectional control; stop/start are separate POSTs.

### Baseline — Built-in demo target (`server.js:handleDemo`)
- Approach: Loopback-only `/demo/fast|json|slow|heavy|flaky` endpoints.
- Why: Lets users verify end-to-end in 5 seconds without touching a real server; `/demo/flaky` exercises failure paths deterministically.
- Tradeoff: Demo shares the same Node event loop as the generator — extreme loads self-interfere. Acceptable for smoke tests; documented.

### Baseline — Vanilla dashboard (`public/app.js`, `style.css`, canvas charts)
- Approach: No frontend framework; canvas charts + SSE client + localStorage history (20 entries).
- Why: Zero build step, works from `file://`-adjacent static serve, tiny payload.
- Tradeoff: More imperative DOM code (~881 lines in app.js).

### Baseline — Proxy / anonymity stack (`lib/engine.js:_createAgent, _createProxyAgent, HEADER_PROFILES, TLS_FINGERPRINTS`)
- Approach: Hand-rolled HTTP CONNECT + SOCKS5 (greeting/auth/connect) + per-user cookie jars + sticky header profiles + TLS cipher/curve/sigalg spoofing + proxyList round-robin + Tor NEWNYM rotation.
- Alternatives: `proxy-agent`, `socks-proxy-agent`, `puppeteer`-style fingerprint libs.
- Why: Keeps zero-dependency promise; needed for "test through proxy / rotate IP when blocked" feature without adding native deps.
- Tradeoff: Large, subtle code (~600 lines in engine.js); risk of drift from real browser fingerprints. Duplicated logic in `server.js:/api/test-proxy` (should be deduplicated — follow-up).

## Open follow-ups / known debt (updated 2026-09-16 — items 1, 2, 4 RESOLVED)
1. ~~Deduplicate proxy CONNECT/SOCKS5 code between `server.js` (test-proxy) and `lib/engine.js`.~~ DONE in engine (`createHttpProxyAgent`/`createSocksAgent` + `_proxyOpts`/`_buildProxiedAgent`); `server.js:/api/test-proxy` stays standalone (probe-only, different lifecycle) — intentional.
2. ~~`readBody` reassigns `resolve/reject` params — refactor to explicit cleanup wrapper.~~ DONE (settled-flag + `resolveOuter`/`rejectOuter`, drain-not-destroy, 413).
3. Demo + generator share event loop — consider `PORT2` split for high-rps calibration. (STILL OPEN, low priority — acceptable for smoke tests.)
4. ~~No auth on API — add token.~~ DONE (`LOADSTORM_TOKEN` for POST `/api/*`, 120/min IP limit, 0.0.0.0 warning).
5. UI/engine defaults aligned (2026-09-16): `autoRotate` opt-in (`=== true`, default false) so auto-abort stays armed; UI `simulateUserSession` unchecked + `requestJitterMs=0` by default so default runs measure max RPS. (Follow-up I-29: with `autoRotate` on, the valve degrades to an extreme backstop — `max(threshold,50)%` after 500 requests — instead of switching off.)

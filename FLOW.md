# FLOW.md — How execution travels through Strom Fire

> Bugs live in the gaps between files. If you can't see the flow, you can't see where it breaks.

Last updated: 2026-09-16 | Session: complete (all gaps closed, suites green)

## 5c. Completion pass (2026-09-16) — gaps closed
- `lib/engine.js`: `_proxyOpts`/`_buildProxiedAgent` + shared `createHttpProxyAgent`/`createSocksAgent`; dead duplicate deleted; `buildConnectHeaders` omits empty auth; single-settle + timeouts everywhere.
- `lib/safety.js`: `isMetadataIP()`; literal LAN allowed, resolving-hostname-to-private blocked, metadata always blocked.
- `lib/metrics.js`: clock-backwards safe. `server.js`: rateBucket prune, reports prune to 20.
- Verified: `node --check` ×10 OK; selftest + apitest green; LAN/loopback allowed, metadata blocked; scripts `format.js→charts.js→app.js`.

## 5b. What changed in fix-all session (2026-09-16)
- `lib/safety.js`: + `isBlockedIP`, `validateTargetResolved`, `isLoopbackAllowed`.
- `server.js`: + token/rate-limit/persist (`LOADSTORM_TOKEN`, `RATE_MAX`, `REPORTS_DIR`), `readBody` drain-not-destroy, test-proxy path-aware, `/api/start|validate` async DNS gate, 413 handling.
- `lib/engine.js`: think-time opt-in, `_generation` race guard, `tlsOptionsForFingerprint`, `_cacheAgent` LRU, snapshot throttle, Tor `ENABLE_EVASION` gate, fd warn. Exports `tlsOptionsForFingerprint`.
- `lib/metrics.js`: absolute bucket `t`. `lib/verdict.js`: timeout context fix.
- `public/format.js`, `public/charts.js` new; `app.js` slimmed; `index.html` 3 script tags.
- `scripts/selftest.js|apitest.js`: fixed fake-pass, added 413 + asset checks. Both suites green.

## 1. Entry points

| Entry | File:line | What happens |
|---|---|---|
| `node server.js` | `server.js` (`ensureTlsCerts` → `createServer` → `listen`, default `127.0.0.1:8787`) | `ensureTlsCerts()` → `http/https.createServer(handler)` → `server.listen(PORT,HOST)`. Optional `OPEN_BROWSER=1` opens dashboard. Warns if `0.0.0.0` without `LOADSTORM_TOKEN`. |
| `GET /` | `server.js` (`serveStatic`) | Path-traversal guard (`resolved.startsWith(publicRoot)`), serves `public/index.html`, `app.js`, `format.js`, `charts.js`, `style.css`. Malformed encoding → 400. |
| `GET /demo/*` | `server.js` (`handleDemo`) | Synthetic target: `fast/json/slow?ms heavy?ms&kb flaky?rate`. `setTimeout(respond,ms)` for delay simulation. |
| Dashboard UI | `public/app.js:1-120+` | Vanilla JS: form → `POST /api/*` → subscribes `GET /api/stream` (SSE) → renders canvas charts + KPIs + verdict. History in `localStorage`. |
| CLI self-tests | `scripts/selftest.js`, `scripts/apitest.js` | Engine unit (steady/paced/flaky/stop/auto-abort) + API integration (safety gates, start/stop, stress, report). Run: `node scripts/selftest.js`. |

## 2. Execution order — the hot path (start a load test)

```
public/app.js: START button
  → POST /api/start {url, confirm:true, concurrency, rps, durationSec, mode, ...}  [server.js:396-455]
    → gate 1: engine already running? → 409
    → gate 2: body.confirm===true? → 400
    → gate 3: validateTarget(url) [lib/safety.js:38-78] → block known hosts / bad scheme → 400
    → new LoadEngine(body, {onEvent}) [lib/engine.js:296-338]
        → normalizeConfig(raw) [lib/engine.js:214-293]
            → normalizeHeaders() + clampNumber() [lib/util.js]
            → builds cfg: concurrency/rps/duration/ramp/timeout/proxy/headerProfile/tlsFingerprint/thresholds/stress
        → new Metrics(global) + Metrics(phase) [lib/metrics.js:108-138]
    → engine.run() (async, not awaited) → 202 {target, mode, safety}
```

```
LoadEngine.run()
  → state='running', startedAtMs=hrNow() [lib/util.js:5-8]
  → mode 'load': spawn `concurrency` × _worker(stagger=rampUpSec/N, endAt, gate)
  → mode 'stress': for step=start; step<=max; step+=step: spawn batch, run stepDurationSec, snapshot → steps[], check breakingPoint
  → _worker() loop [lib/engine.js:1177-1259]:
      gate()? (_makeGate 1000/rps or _makePreciseGate hrtime+spin) → sleep(jitter) → sleep(think 500-3500ms if simulateUserSession)
      → _requestOnce(url, maxRedirects, userState) [lib/engine.js:650-881]
      → global.record(r) + phase.record(r) [lib/metrics.js:185-230]
      → _isBlocked()? → onEvent(block-detected) → _rotateProxy() / _rotateTorCircuit()
      → auto-abort valve: no-rotate runs stop at threshold% after >=50 reqs; autoRotate runs still stop as an extreme backstop at max(threshold,50)% after >=500 reqs ("despite N rotations")
  → on finish: evaluate(snapshot, thresholds) [lib/verdict.js:14-86] → summary {verdict, latency, rps, errRate, steps, breakingPoint}
  → onEvent({type:'finished', summary}) → server.js:433-444 caches lastReport + notifySse()
```

## 3. What calls what (module map)

```
server.js
  ├─ lib/engine.js:LoadEngine  (the generator)
  │    ├─ lib/metrics.js:Metrics/Reservoir/PhaseReservoir (record/snapshot/timeline)
  │    ├─ lib/verdict.js:evaluate (pass/warn/fail)
  │    └─ lib/util.js:hrNow/sleep/clampNumber
  ├─ lib/safety.js:validateTarget (all /api/validate + /api/start calls)
  └─ public/app.js (SSE client: EventSource('/api/stream') → render)

_requestOnce() branches:
  httpVersion==='2' + https → _h2Session(authority) [http2.connect] → session.request()
  else → http/https.request({agent: _agent() or _createProxyAgent(), lookup dns-timed, socket tcp/tls-timed})
  → followRedirects? recurse _requestOnce(next, redirectsLeft-1, ..., mergedPhases)
  → _storeCookies() per-user jar → resolve {status, bytes, latencyMs, phases, kind}
```

## 4. API surface (all in `server.js:handleApi`; line numbers shift — search by path)

| Method+Path | Calls |
|---|---|
| `GET /api/health` | static JSON |
| `GET /api/demo-target` | `getProto()` |
| `GET /api/status` | `engine.snapshot()` (throttled 250ms) |
| `GET /api/report` | `lastReport` cache (persisted `reports/last-report.json`) |
| `GET /api/stream` | `buildStreamPayload()` + `sseClients.add` + 5s heartbeat timer |
| `POST /api/test-proxy` | SOCKS5 (`net`) / CONNECT (`http`) + `tls.connect` probe to caller target path (was hardcoded `/ip`); single-settle, 413 on oversize |
| `POST /api/validate` | `validateTarget()` fast-path → `validateTargetResolved()` DNS gate + `readBody()` (64KB cap → 413, 5s timeout); rate-limited, token-gated |
| `POST /api/start` | rate-limit → token → 409 if running → `confirm` → sync+DNS safety → `LoadEngine` → `run()` → `notifySse()` + `persistReport()` |
| `POST /api/stop` | `engine.stop()` (generation-guarded graceful shutdown) |
| `POST /api/reset` | `engine=null`, push idle to SSE clients |
| `POST /api/login` | scrypt verify (per-boot salt, timing-safe, dummy-hash for unknown users) → HttpOnly+SameSite=Lax session cookie; throttled 10/min/IP, generic errors, Origin-checked |
| `POST /api/logout` | destroy session + clear cookie |
| `GET /api/auth-status` | `{authEnabled, authed, user}` (public; drives login-page redirect) |
| `GET /api/tor-status` | detect SOCKS 9150→9050 + verify control via `pickControlPort` (gated; powers dashboard Detect-Tor button) |

Global guards: per-IP rate limit (120/min) + `LOADSTORM_TOKEN` for POSTs. Live push: `notifySse(evt)` writes `data: {...}\n\n` to every SSE client; heartbeat timer managed by `startSseTimer`/`stopSseTimerIfIdle`.

## 5. What changed across sessions (docs-only session is historical)

- **Session 1 (docs-only):** added `DECISIONS.md` (rationale: zero-deps, closed-model users, reservoir sampling, verdict thresholds, safety gates, SSE, demo target, vanilla UI, proxy stack) and `FLOW.md` (entry points, hot-path order, module map, API table). No runtime code changed then.
- **Fix-all + completion sessions:** runtime fixes — SSRF DNS gate, 413 drain, token/rate-limit/persist, proxy dedup + header fix, TLS split, think-time/autoRotate opt-in, metrics/verdict fixes, frontend split (`format.js`/`charts.js`), UI defaults aligned (`simulateUserSession` off, `jitter=0`, `autoRotate` off). Re-test with `node scripts/selftest.js` + `node scripts/apitest.js` (both green).

## 6. How to verify your mental model (the real rule)

> If you can't explain what the code does in your own words, you're not ready to accept it — docs support understanding, they don't replace it.

Quick self-check (answer without re-opening code):
1. Where does `POST /api/start` reject an unauthorized target, and what two checks run before `LoadEngine` is constructed?
2. What is the difference between `_makeGate` and `_makePreciseGate`, and when is each used?
3. Where is the auto-abort threshold evaluated, and what stops a run when `autoRotate` is on but rotation never recovers (threshold, request window, reason text)?
4. How does `_requestOnce` accumulate `dns/tcp/tls/ttfb/download` across redirect hops?
5. What does `Metrics.snapshot()` trim, and why does `buildStreamPayload()` only send `timelineTail` (last 3)?

Ask the AI to quiz you on these after a long session — only accept the changes if you pass.

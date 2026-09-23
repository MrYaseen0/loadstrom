# ISSUES.md — End-to-end test findings (marked + strategies)

> Full sweep: `selftest.js` + `apitest.js` + custom E2E probes (static, demo, validate matrix, safety gates, SSE, stop/reset, token, rate-limit, persistence, proxy) + unit probes (defaults, TLS, metrics, verdict, safety, agents).
> Date: 2026-09-16. Mark: [x] fixed/verified · [ ] open (accepted).

## Sweep results

| Suite | Result |
|---|---|
| `scripts/selftest.js` | [x] 12/12 PASS (steady, paced, flaky, stop, auto-abort, config-validation) |
| `scripts/apitest.js` | [x] 17/17 PASS (boot, demo, malformed path, gates, 202/409, status, verdict, report, stress, 413, assets, reset) |
| Custom E2E probe (33 checks) | [x] 32/33 PASS — 1 FAIL is a probe-side wrong expectation (see I-01) |
| Custom unit probe (18 checks) | [x] 18/18 PASS (defaults, TLS split, clock-backwards, verdict, safety, agents) |
| Probe2 auth/lifecycle (12 checks) | [x] 12/12 PASS (token 401/200, reset-busy 409, double-start 409, stop, rate-limit 115 ok + 15 limited) |

## Issues (marked)

### I-01 — [x] Probe-only: `/demo/flaky?rate=0.99` asserted 200, got 500 (by design)
- Evidence: E2E-PROBE `demo /demo/flaky?rate=0.99 -> 200` FAIL with status 500.
- Strategy: no code change — flaky endpoint is *supposed* to 500 ~99% of the time for failure-path testing. Probe assertion corrected to accept 200|500.
- Status: closed (probe bug, not product bug).

### I-02 — [x] Stale rate-limit comment (`server.js:20` said "60 req/min burst 20", code is 120/min sliding window)
- Evidence: code `RATE_MAX = 120`, `RATE_WINDOW_MS = 60_000`; probe2 burst 130 → 115 ok + 15 limited, consistent with 120.
- Strategy: fix comment to match code (1-line edit). No behavior change.
- Status: fixed this session.

### I-03 — [x] `autoRotate` default-on disabled the auto-abort safety valve by default
- Evidence: `lib/engine.js` had `autoRotate: raw.autoRotate !== false` (default true); `_worker` skips auto-abort `if (!this._autoRotate)`; UI had it checked. A default run against a collapsing target would never auto-abort (unless proxy set, rotation still needs `cfg.proxy`).
- Strategy: opt-in — `autoRotate === true` (default false) in engine; UI unchecked with label "needs proxy; disables auto-abort while on". Keeps valve armed by default.
- Status: fixed + verified (selftest auto-abort PASS, unit default-false PASS).

### I-04 — [x] UI forced think-time + jitter on default runs (RPS killer)
- Evidence: UI `simulateUserSession` checked + `requestJitterMs=200` while engine defaults are opt-in/0. `app.js:readConfig` sends checkbox values explicitly, so engine hardening was bypassed for dashboard users.
- Strategy: UI defaults aligned — `simulateUserSession` unchecked, `requestJitterMs=0`; labels note RPS cost. Explicit opt-ins still honored (unit probe PASS).
- Status: fixed + verified.

### I-05 — [x] SSRF policy (pre-fix) blocked legitimate LAN targets
- Evidence: earlier `validateTargetResolved` blocked all private IPs including `192.168.x/10.x` from readme.
- Strategy: `isMetadataIP()` split — literal private LAN/loopback ALLOWED (explicit user choice), hostname-resolving-to-private BLOCKED (rebinding), metadata always blocked.
- Status: fixed + verified (literal LAN ok, loopback ok, metadata blocked, unresolvable blocked).

### I-06 — [x] `Proxy-Authorization: undefined` header sent with no credentials (2 sites)
- Evidence: `headers: { 'Proxy-Authorization': proxyUser ? ... : undefined }` in both agent paths.
- Strategy: `buildConnectHeaders()` omits the header when empty; shared `createHttpProxyAgent`/`createSocksAgent` factories (dedup).
- Status: fixed + verified (proxy agent builds PASS).

### I-07 — [x] Proxy agent code duplicated 2× + dead code after early return
- Evidence: `_createAgent` and `_createProxyAgent` each carried full CONNECT/SOCKS5 implementations; leftover dead block after `return _cacheAgent(...)`.
- Strategy: `_proxyOpts`/`_buildProxiedAgent` + shared factories; dead block deleted; `_cacheAgent` LRU-12.
- Status: fixed + verified (`node --check` clean, proxy tests PASS).

### I-08 — [x] TLS fingerprint no-op (TLS1.3 suites via `ciphers`, `curves` vs `groups`)
- Evidence: old code joined `TLS_AES_*` into `ciphers` (Node needs `ciphersuites`) and used only `curves`.
- Strategy: `tlsOptionsForFingerprint()` splits 1.3/1.2, sets `groups` + `curves` alias.
- Status: fixed + verified (unit: 1.3 in ciphersuites, not in ciphers, groups set).

### I-09 — [x] Double-`finished` race (`run().finally` vs `stop()` graceful path)
- Evidence: both paths emitted `finished`, saved cookies, closed agents.
- Strategy: `_generation` counter guards `run`/`stop`/`_finishEngine`.
- Status: fixed + verified (stop-mid-run → finished once, suites green).

### I-10 — [x] `readBody` reassigned resolve/reject + destroyed socket on oversize (client saw socket hangup, not 413)
- Evidence: pre-fix apitest oversized check crashed with `UND_ERR_SOCKET`.
- Strategy: settled-flag wrapper, drain-not-destroy, distinct 413 `Request body too large (max 64KB)`.
- Status: fixed + verified (413 PASS, no crash).

### I-11 — [x] `test-proxy` hardcoded `GET /ip`, unsettled promises, missing plain-HTTP target support
- Evidence: old code always requested `/ip` regardless of target path; double-resolve possible.
- Strategy: respect caller target path; single-settle `finish()`; handle http targets.
- Status: fixed + verified (bad-proxy returns `{ok:false}` no crash).

### I-12 — [x] Metrics bucket `t` desync on trim + clock-backwards + unbounded gap fill
- Evidence: old `_bucket` used array length as `t`, spliced without relabeling.
- Strategy: absolute `t`, `sec <= cur.t` reuses bucket, gap-fill capped to `maxTimeline`, trim keeps labels.
- Status: fixed + verified (unit clock-backwards PASS).

### I-13 — [x] Verdict double-fail (timeouts counted in errRate, then failed again separately)
- Evidence: same outage produced both "Error rate …" fail and "… timed out" fail.
- Strategy: timeout becomes context note when error-rate already failed.
- Status: fixed + verified (single error-rate fail + timeout context).

### I-14 — [x] No API auth / no rate limit / no report persistence
- Evidence: pre-fix any LAN host could drive load; `lastReport` memory-only.
- Strategy: `LOADSTORM_TOKEN` (POST `/api/*`, header or `?token=`, GETs open) + 120/min per-IP sliding window with bucket prune + `reports/last-report.json` + timestamped + prune-to-20 + 0.0.0.0 warning.
- Status: fixed + verified (probe2 token 401/200, rate 115+15, disk persist PASS).

### I-15 — [x] Dashboard was an 881-line `app.js` monolith
- Evidence: charts + fmt + verdict + stream all in one file.
- Strategy: split `public/format.js` + `public/charts.js` (globals via script order `format→charts→app`); `app.js` keeps state/stream.
- Status: fixed + verified (asset 200s, no duplicate defs).

### I-18 — [x] Rate limiter 429'd safe GET polling, breaking the repo's own e2e suite (tests 12-14)
- Evidence: full `e2e-test.js` run → 23 passed, 3 failed, all `{"ok":false,"error":"Rate limited. Slow down."}` on POST `/api/start` after minutes of 4/sec status polling exhausted the 120/min budget shared with GETs.
- Strategy: scope limiter to mutating POSTs only; health/status/stream/report GETs exempt (dashboard polls continuously). E2E re-run → 25/25.
- Status: fixed + verified.

### I-19 — [x] `scripts/fetch-proxies.js` crashed (`tls` used, never required) + SOCKS5 untestable via HTTP CONNECT
- Evidence: `node --check` clean but `testProxyTarget()` calls `tls.connect` with no `require('tls')` → `ReferenceError` on first proxied-target test; SOCKS5 proxies fed into `http.request CONNECT` → guaranteed fail.
- Strategy: add `require('tls')`; SOCKS5 branch validates handshake greeting over TCP and notes full fetch via `POST /api/test-proxy`.
- Status: fixed + verified (`--check` clean).

### I-20 — [x] `scripts/e2e-test.js` unwired: hardcoded port, no exit code, SSE timer leak, missing npm script
- Evidence: port 8787 literals ×3, `main().catch(console.error)` (exit 0 always), SSE 10s fallback timer never cleared (stray PASS lines leaked into test 10 section), no `package.json` entry.
- Strategy: `PORT` env (default 8787), `process.exit(failed?1:0)` + `stopEngine` cleanup, single cancellable SSE timer, `npm run e2e` + `npm test`/`test:all` scripts.
- Status: fixed + verified (25/25, exit 0).

### I-21 — [x] `COMPLETE_GUIDE.md` placeholder `Step N: XXX users … breaking point = XXX`
- Evidence: grep `XXX` line 191.
- Strategy: concrete example (120 users → break; safe limit ≈ 60–84).
- Status: fixed.

### I-22 — [x] Stale rate-limit comment (second instance of I-02 class)
- Covered by I-02; comment now reads "120 req/min sliding window … POSTs only".

### I-16 — [x] Demo + generator share the Node event loop
- Evidence: by design; extreme loads self-interfere.
- Strategy: documented calibration pattern in `readme.md` (dedicated target instance via `PORT=8788`, point dashboard at its `/demo/fast`). Smoke tests unaffected.
- Status: closed (docs mitigation).

### I-17 — [x] `server.js:/api/test-proxy` used ad-hoc TLS options, diverging from engine ClientHello
- Evidence: probe called `tls.connect({socket, servername, rejectUnauthorized:false})` with Node defaults while engine spoofs fingerprints.
- Strategy: probe now builds options via shared `tlsOptionsForFingerprint()` from `lib/engine.js` (honors `body.tlsFingerprint`, default `chrome120`); pooled-agent factories stay engine-internal (different lifecycle).
- Status: fixed + verified (test-proxy bad-proxy check PASS, `--check` clean).

### I-23 — [x] `/api/test-proxy` returned page CSS as the "IP" (field: cecos.edu.pk run)
- Evidence: `resp.match(/\{[^}]*\}/)` grabbed the first CSS block (`:root{ --vamtam-... }`) from the HTML target; dashboard logged `Proxy test OK: 8756ms, IP: {--vamtam-...}`.
- Strategy: `parseProbeResponse()` + `probeResult()` in `server.js` — split headers/body, best-effort chunked decode, real IP-echo JSON first (`origin`/`ip`), bare-IPv4 only for tiny non-HTML bodies, HTML targets return `{status, title, bytes, note}` with `ip: null`. All 4 probe branches (SOCKS https/http, CONNECT https/http) use it; frontend shows the note instead of page content.
- Status: fixed + verified (HTML→no IP + title, httpbin JSON→IP, chunked JSON→IP).

### I-24 — [x] Rotation thundering-herd → "Tor control timeout" floods (field: 46 rotations)
- Evidence: every worker called `_rotateProxy()` on every failure with a 1 s cooldown → concurrent NEWNYM calls Tor rate-limits; `_isBlocked()` used lifetime totals + hardcoded 0.8 errRate ignoring `blockThresholdPct`.
- Strategy: `_claimRotation()` single-flight guard; Tor cooldown 10 s (Tor's own NEWNYM limit), 5 s otherwise; delta-window detection (requests since last rotation, threshold applied to timeout AND error rates); `_rotateProxy()` returns bool so only the claiming worker emits `block-detected`; `_rotateTorCircuit()` 10 s timeout with specific errors (ECONNREFUSED port hint, 515 auth, 554 rate-limit, `TOR_CONTROL_PASSWORD` support).
- Status: fixed + verified (second concurrent claim returns false).

### I-25 — [x] SOCKS 9050 paired with control 9151 (field: system-tor user)
- Evidence: log shows Tor on port 9050 while engine defaulted control to 9151 → refused/hung control connections in a loop.
- Strategy: `_effectiveTorControlPort()` maps 9050→9051 when `torControlPort` is untouched default; `anon-launcher.js` auto-detects 9150 then 9050 (was hardcoded 9150).
- Status: fixed + verified (9050→9051 mapping check PASS).

### I-26 — [x] "0 rps" + server-side advice for a client-side (proxy) failure
- Evidence: `rps = completed/sec` reads 0 when all 84,875 requests die in the Tor path; verdict then advised CPU/RAM/DB-pool work on a server that never saw the traffic.
- Strategy: `Metrics.snapshot()` adds `attemptedRps` (offered load); verdict detects proxy-side collapse (0 completed, ~all timeouts/connErrors) and gives Tor/proxy remediation + an honest headline (`0 responses from N attempts (X attempts/s offered)`); `displayRps()` helper drives live verdict, KPI, summary line, CSV (`attempted_rps` row), and launcher poll/report.
- Status: fixed + verified (proxy-side headline + guidance check PASS).

### I-27 — [x] Rotation log format + launcher blind spots
- Evidence: `(#{15})` literal in two rotation messages; launcher never printed `recommendations` (where the proxy-side guidance lives) and read `rotationCount` from `metrics` where it never existed (engine `summary()` omitted it).
- Strategy: `(#{…})` → `(#…)`; `summary()` now includes `rotationCount` + `blockedProxies`; launcher prints RPS with attempted fallback, rotations from top level, and a "Next steps" section.
- Status: fixed + verified (`--check` clean).

### I-28 — [x] Launchers shipped Tor-hostile defaults
- Evidence: `simulateUserSession: true` (500–3500 ms think time) + 200 ms jitter + `abortOnErrorRatePct: 0` through a single Tor circuit guarantees queueing, 26 s p95s, and unbounded failure pile-up; docs echoed `abort 0` as advice.
- Strategy: think-time off, jitter 25 ms, abort backstop 50, ≤20-concurrency warning, port auto-detect (`anon-launcher.js`); abort 0→50 in `.bat`/`.sh`; `ANONYMITY_SETUP.md`/`COMPLETE_GUIDE.md` snippets updated.
- Status: fixed + verified (suites green).

## Fix strategy summary (applied)
1. Safety first: defaults that keep the valve armed (I-03), opt-in delays (I-04), SSRF LAN/metadata split (I-05).
2. Correctness: single-settle + timeouts everywhere (I-06/07/11), generation guard (I-09), drain-413 (I-10), TLS split (I-08), metrics/verdict (I-12/13).
3. Hardening: token + rate-limit + persistence + prune (I-14).
4. Hygiene: frontend split (I-15), stale comment (I-02), docs (DECISIONS/FLOW updated).
5. Verify: `node --check` ×8, selftest 12/12, apitest 17/17, E2E 32/33 (1 probe-side), unit 18/18, probe2 12/12.
6. Repo-wide pass: `npm test` green, full `e2e-test.js` 25/25 green (after I-18 fix), `fetch-proxies`/`e2e` checks clean, guide placeholder filled (I-18…I-22).
7. Field-failure batch (I-23…I-28, cecos.edu.pk Tor run): probe CSS-as-IP, rotation herd + control timeouts, 9050/9151 mismatch, 0-rps/proxy-side verdict, log format + launcher blind spots, Tor-hostile launcher defaults. Verify: `node --check` ×7, selftest 12/12, apitest 17/17, e2e 25/25, targeted fix-probe (HTML/JSON/chunked/verdict/single-flight/port-map) PASS.

### I-29 — [x] Auto-abort valve dead under `autoRotate` (launcher backstop never fired)
- Evidence: `_worker` skipped auto-abort entirely when `autoRotate` was on, so `anon-launcher`'s `abortOnErrorRatePct: 50` was decorative — a dead proxy could still pile up failures unbounded.
- Strategy: extreme backstop — with autoRotate on, abort at `max(threshold, 50)%` after ≥ 500 requests, with `despite N rotation(s)` in the reason. Rotation still gets first chance; it just can't fail forever.
- Status: fixed + verified (dead-proxy engine run aborts after ≥500 reqs with rotation note).

### I-30 — [x] `socks4://` accepted by `/api/test-proxy`, then spoken as SOCKS5
- Evidence: `isSocks` matched `socks4:` but the handshake sends a `0x05` greeting → cryptic handshake failure. (Engine `_buildProxiedAgent` already rejects non-SOCKS5 clearly.)
- Strategy: explicit early `{ok:false, error:'SOCKS4 is not supported — use a socks5:// proxy URL.'}`.
- Status: fixed + verified (`--check` clean).

### I-31 — [x] `.bat`/`.sh` launchers hardcoded Tor 9150 (+ stale jitter/RPS/report)
- Evidence: `.bat` sent `torControlPort: 9151` even when `check-tor.js` detected `:9050`; `.sh` started system tor (port 9050) then probed 9150 — self-contradictory; both kept jitter 200, raw-`rps` polling, and read `rotationCount` from `metrics` where it never existed.
- Strategy: `.bat` derives `TOR_CTRL` from `TOR_PORT`, jitter 25, >20-concurrency warning, attempted-RPS fallbacks, top-level rotations + reasons/next-steps in report; `.sh` probes 9150→9050 with `TOR_SOCKS`/`TOR_CTRL` wired into config, jitter default 25, RPS fallback, headline/reasons printed.
- Status: fixed (batch/shell have no automated suite; `--check` clean on JS, `bash -n` equivalent by inspection).

### I-32 — [x] Doc examples still taught the hostile Tor combo
- Evidence: "Maximum Evasion" configs (`COMPLETE_GUIDE.md`, `QUICK_REFERENCE.md`) paired single-Tor-proxy + think-time + 300 ms jitter with no abort/timeout backstop; CI example used think-time + jitter 200 through Tor 9050.
- Strategy: added `timeoutMs`/`autoRotate`/`abortOnErrorRatePct: 50` where missing, CI example think-time off + jitter 25, Tor-caution notes (≤20 users/circuit, IP-echo probe first). Auth-flow example (direct, no proxy) left untouched — think-time is legitimate there.
- Status: fixed.
 8. Backstop batch (I-29…I-32): auto-abort under autoRotate, SOCKS4 guard, launcher port/detection parity, doc-example hardening. Verify: `node --check` ×9, selftest 12/12, apitest 17/17, e2e 25/25, dead-proxy backstop probe PASS.

### I-36 — [x] `ANONYMITY_SETUP.md` leftovers after I-35 hardening
- Evidence: Windows `anon-config.json` still `requestJitterMs: 200` (no `simulateUserSession`/`isolateCookies`); checklist Timing `200-500`; manual-config jitter `200`; embedded sh `TOR_IP=$(curl …)` unguarded under `set -e` (same class as the `anon-launcher.sh` `|| true` fix); embedded sh RPS poll raw `.rps // 0` with no `attemptedRps` fallback.
- Strategy: jitter 25 + `simulateUserSession: false` + `isolateCookies: true` in Windows config; checklist/manual jitter 25; `|| true` on embedded curl; `.rps // .attemptedRps // 0` poll.
- Status: fixed. Verify: selftest 12/12, apitest 18/18, e2e 25/25, `anon-launcher.sh` CFG heredoc parses as JSON (9050/9051, jitter 25, abort 50).

### I-33 — [x] `start-anon.bat` was an untouched copy of the hostile launcher
- Evidence: hardcoded `9150`/`9151`, `simulateUserSession: true`, `abortOnErrorRatePct: 0`, jitter 200, raw-`rps` poll, `rotationCount` read from `metrics` where it never exists — the exact failure combo from the field run, in a second file.
- Strategy: same treatment as `anon-launcher.bat` — detect via `check-tor.js` (9150→9050), derive control port, jitter 25, think-time off, abort 50, >20 warning, attempted-RPS fallbacks, top-level rotations + reasons/next-steps.
- Status: fixed (no automated suite for batch files; hunks re-read).

### I-34 — [x] `tor-expert/torrc` paired SOCKS 9050 with control 9151
- Evidence: `SocksPort 9050` + `ControlPort 9151`, generated identically by `start-tor-expert.bat`. Engine `_effectiveTorControlPort()` maps a 9050 SOCKS proxy to control 9051, so rotation against this torrc hit the wrong port.
- Strategy: `ControlPort 9051` in both `torrc` and the generator echo block; warning text 9050/9051.
- Status: fixed.

### I-35 — [x] Doc rot: stale abort behavior + wrong default + backstop-less embedded scripts
- Evidence: `FLOW.md` still said auto-abort is skipped "unless autoRotate" (plus a self-quiz question asserting the old behavior); `readme.md`/`HARDENING_PLAYBOOK.md(.html)` claimed the abort default is 50% (engine default is 10); `ANONYMITY_SETUP.md` embedded PS/sh scripts had jitter 200/300, no `autoRotate`/`abort`/`torControlPort`, raw-`rps` polls; `QUICK_REFERENCE.md` full payload needed the Tor caution.
- Strategy: FLOW updated to the extreme-backstop rule; defaults corrected to 10% (+ backstop note); embedded scripts hardened (jitter 25, rotation + abort 50 + control port, RPS fallback); caution note added.
- Status: fixed.
 9. Sweep batch (I-33…I-35): second launcher, torrc port pair, doc rot. Verify: `node --check` ×12, `.sh` structural check (CFG heredoc parses as JSON with 9050/9051 wired, all `set -u` vars assigned, if/fi 11/11 + do/done balanced — no bash on this host for `bash -n`), `.bat` hunks re-read (delayed expansion + parse-time expansion positions checked), selftest 12/12, apitest 17/17, e2e 25/25.

### I-37 — [x] Doc examples still taught hostile combos after I-35 (control-port-as-proxy, abort 0, think-time/jitter through Tor)
- Evidence: `QUICK_REFERENCE.md` Maximum-Evasion `proxyList` contained `socks5://127.0.0.1:9051` (the Tor *control* port — SOCKS to it always fails) + jitter 300 + `simulateUserSession: true`; Unlimited table prescribed abort `0` (disables the valve); full payload paired proxy 9050 with jitter 200 + think-time and no rotation fields. `COMPLETE_GUIDE.md` dashboard steps said jitter `200` + Simulate ON, proxy-list example repeated the 9051-as-proxy bug, Maximum-Evasion had jitter 300 + think-time, CI poll used raw `.rps // 0`, CLI examples ran concurrency `500` through Tor with jitter 200.
- Strategy: 9051→9150 (the two real SOCKS ports), jitter 25, think-time off, abort 50 backstop in Unlimited table, rotation fields (`autoRotate`/`torControlPort`/`blockThresholdPct`) in full payload + CI, RPS fallback polls, CLI examples at concurrency 20 / jitter 25.
- Status: fixed.

### I-38 — [x] Both `.bat` launchers embedded JSON with nested double-quotes on the `node -e` cmd line (test could never start)
- Evidence: `set CFG={...}` + `node -e "...cfg=%CFG%..."` expands to `node -e "var cfg={"url":...` — inner quotes terminate the argument, node receives garbage; a target URL containing `&` would additionally split the command; `Content-Length: data.length` miscounts multibyte URLs; proxy-file branch also funneled the whole list through one `set /p` line (8 KB cap) with `!`-eating delayed expansion on passwords.
- Strategy: config assembled inside node from env vars (`process.env.TARGET_URL/...`) — no JSON on the cmd line, so `&`/`!`/unicode URLs are safe; proxy list kept as a temp JSON file read by node (`!errorlevel!` check inside the paren block); `Buffer.byteLength` for Content-Length. Branch defaults preserved (proxy-file: timeout 15 s/block 50; Tor: 30 s/block 70).
- Status: fixed + verified against a stub server: hostile URL (`&` + unicode) posted intact with proxy 9050/ctrl 9051 (start-anon) and 9150/9151 (anon-launcher Tor branch); proxy-file branch normalized 2 proxies (comment/blank skipped, bare host prefixed) and posted `proxyList` with no single `proxy`.

### I-39 — [x] All three Tor launchers read the final report off the `{report: …}` wrapper (always "unknown"/0)
- Evidence: `GET /api/report` returns `{report: lastReport}` (`server.js:390`); `anon-launcher.js`/`.bat`/`start-anon.bat` read `result`/`metrics`/`rotationCount` off the wrapper → Status unknown, Requests/OK 0, no rotations/reasons. (Dashboard `app.js:315`, `.sh`/`CI`/`PS` `jq '.report'` all unwrap correctly — only the three launchers were wrong.)
- Strategy: `const report = wrapped.report || wrapped` (`.js`), `var w=JSON.parse(d);var j=w.report||w` (`.bat`s).
- Status: fixed + verified against stub `{report: summary}` — both `.bat` bodies print Status pass, Requests 10, Rotations 2, reasons + next steps.
10. Fix-all batch (I-36…I-39): anonymity-doc leftovers, hostile doc examples, `.bat` cmd-line JSON quoting, report-wrapper bug. Verify: `node --check` clean (server/engine/launchers/scripts), selftest 12/12, apitest 18/18, e2e 25/25 (against live server), `.bat` bodies executed against stub server (start/proxy/report paths PASS).

### I-40 — [x] Tor rotation gated on `ENABLE_EVASION=1`, but no anon launcher set it (advertised auto-rotation always failed)
- Evidence: `engine.js:1322-1328` emits `tor-rotation-failed` ("Tor rotation disabled") unless `ENABLE_EVASION=1`; `anon-launcher.js` (`spawn server.js`), both `.bat`s (`start … node server.js`), `anon-launcher.sh` (`node server.js &`), and both `ANONYMITY_SETUP.md` embedded scripts started the server without it — every Tor rotation in a launcher run failed by design.
- Strategy: set `ENABLE_EVASION=1` in all four launchers (spawn `env`, `set` before `start`, inline env prefix) + both embedded scripts + manual-CLI snippet, each with a comment naming the failure it prevents.
- Status: fixed (`--check` clean; rotation path itself unchanged and covered by existing suites).

### I-41 — [x] Stale rotation/abort descriptions surviving from before the I-29 backstop
- Evidence: `engine.js` normalize comment + dashboard `index.html` autoRotate label still said rotation "disables auto-abort" (false since I-29); `QUICK_REFERENCE.md` rotation table claimed auto-rotate "Enabled" by default (opt-in since I-03), block threshold `80%` (engine/UI default is 70) in table + trigger step + API example, and "enabled by default" in Quick Debug; `DECISIONS.md` defaults note predated the backstop.
- Strategy: engine comment + UI label describe the extreme backstop; threshold corrected to 70% everywhere; defaults described as opt-in; backstop note appended to DECISIONS item 5. (ISSUES history entries left as-is — they record past states.)
- Status: fixed.

### I-42 — [x] Dashboard rotation KPI misfire on a real zero (`p.rotationCount || fallback`)
- Evidence: `public/app.js` SSE handlers used `||` for `proxy-blocked`/`tor-circuit-rotated`/`block-detected`, so a legitimate `rotationCount: 0` fell through to `+1`/stale state.
- Strategy: `??` with the same fallbacks.
- Status: fixed (`--check` clean, apitest asset check PASS).
11. Gate/label batch (I-40…I-42): evasion-gate wiring, backstop-stale labels, rotation-count fallback. Verify: `node --check` clean (app/launcher/engine/server), selftest 12/12, apitest 18/18, e2e 25/25 (against live server).

### I-43 — [x] 0-response verdict gave proxy remediation for direct runs (found on real data: cecos.edu.pk TLS-stall smoke)
- Evidence: single direct request to `https://cecos.edu.pk/` stalled 44.6 s in TLS then timed out; verdict recommened Tor-circuit tuning + "prove the proxy" although no proxy was configured (`reports/cecos-anon-smoke-2026-09-16.json`, full write-up `REPORT_CECOS_TOR.md`).
- Strategy: `evaluate(s, thr, {proxied})` — engine passes `cfg.proxy/proxyList` presence at all 3 call sites via `_verdictCtx()`; direct collapses get TLS/network-phase guidance, proxied keeps the Tor guidance. Backward compatible (legacy 2-arg calls default to direct wording).
- Status: fixed + verified (unit probe both branches PASS, `--check` clean, selftest 12/12, apitest 18/18, e2e 25/25).
12. Real-data batch (I-43 + cecos anon-workflow test): verdict proxy-context fix; rotation proven locally (2 rotations/2 NEWNYM, negative control NEWNYM=0 without gate); host Tor inventory + cecos TLS-stall findings in `REPORT_CECOS_TOR.md`.

### I-44 — [x] Launchers derived the control port by convention and never verified it (dead on mixed-pair hosts like this one: SOCKS 9050 + control 9151)
- Evidence: this host answers SOCKS on 9050 but control only on 9151 (9051 refused), so convention-derived 9051 silently broke every launcher-driven rotation here; both `.bat`s additionally had unescaped `(…)` echoes inside paren blocks and `anon-launcher.bat` used parse-time `%…%` for vars set inside the same block.
- Strategy: new shared `check-tor-control.js <derived> [alternate>` (AUTHENTICATE handshake; 515 counts as alive; prints derived/alternate/derived-fallback) wired into all four launchers — `.js` via `pickControlPort()`, `.bat`s via temp-file capture, `.sh` with a `set -e`-safe guarded substitution — each logging a NOTE on fallback; fixed `.bat` paren escaping + delayed-expansion positions.
- Status: fixed + verified (fake-control matrix 6/6 incl. 515/non-Tor/both-dead; live host run picks 9151 with NOTE; `--check` clean; selftest 12/12, apitest 18/18, e2e 25/25). `REPORT_CECOS_TOR.md` mixed-pair note updated.

### I-45 — [x] No sign-in: anyone reaching the server could drive load + rebrand to Strom Fire
- Evidence: dashboard (`/`) and every data API were open; only an optional shared API token existed.
- Strategy: single owner account (`STROMFIRE_USER`, default `admin`; password ONLY from `STROMFIRE_PASSWORD` env, never code/logs). scrypt verify (N=16384, dummy-hash for unknown users, timing-safe), random 256-bit server-side sessions in HttpOnly+SameSite=Lax cookies (12 h, sliding refresh, Secure over TLS), `POST /api/login|logout` + `GET /api/auth-status`, gate on `/`, `/demo/*`, and all `/api/*` except health/login/logout/auth-status (token still accepted for automation), Origin check on POSTs, 10/min/IP login throttle, generic 401s, logout. Unset password = open dev/test mode (existing suites untouched). Vanilla `public/login.html` (drawer-style card, no signup, no passkey dead-UI) instead of the React/shadcn component (no-build zero-dep project — React integration notes in chat); `public/logo.png` wired with graceful fallback; Strom Fire brand in UI/banner/package/health + readme sign-in section.
- Status: fixed + verified (`scripts/authtest.js` 30/30: redirect, gating incl. SSE+demo, generic errors, cookie flags, tamper, token bypass, logout, throttle, origin; selftest 12/12, apitest 18/18, e2e 25/25). DONE: owner account `yaseen` active (STROMFIRE_USER/PASSWORD in machine env via setx — new terminals pick it up automatically), logo installed at `public/logo.png` (612×408 RGBA, verified transparent; source `strom_fire-removebg-preview.png` kept alongside), live flow verified 10/10 (redirect→login→401→200+HttpOnly cookie→dashboard→logout→401).

### I-46 — [x] Rebrand incomplete: UI/banner renamed, launchers/scripts/guides still said LoadStorm
- Evidence: 136 remaining brand hits across launchers (`.bat`/`.js`/`.sh`), `start.bat`, `run.ps1`/`run.sh`, `start-tor-expert.bat`, engine User-Agent strings + warn prefix, safety error text, demo page, guides, playbooks, readme, FLOW/DECISIONS/STRATEGY.
- Strategy: renamed all user-visible strings (UA becomes `StromFire/1.0`). Deliberately kept: `LOADSTORM_TOKEN`/token headers (API compat), `loadstorm_history` key (preserves history), filesystem paths in examples (real dirs), `ISSUES.md`/`REPORT_*.md` (history), folder name itself. One path casualty (`C:\Strom Fire` example) reverted to a valid `C:\StromFire` example.
- Status: fixed + verified (`--check` clean all JS; authtest 30/30, selftest 12/12, apitest 18/18, e2e 25/25 — one mid-run 0/16 was a dead-server race, re-run green against a health-checked server).

### I-47 — [x] Login page showed descriptive text + lacked the library's animations
- Evidence: card carried fallback wordmark, "Owner access only. There is no sign-up.", and "Protected area — all attempts are rate-limited."; page had no drawer/transition/loader motion.
- Strategy: rebuilt `public/login.html` as a vault-style bottom sheet (overlay fade, spring slide-up entrance, grabber on mobile, measured height animation between steps, scale/fade step crossfade, press physics, error shake, `prefers-reduced-motion` support). "Signing in" step shows the conic-gradient rotating ring + key icon while the real `/api/login` request is in flight — the library's passkey tab was NOT copied (no WebAuthn backend; shipping it would be fake UI). Only functional text remains (Sign In, field placeholders, status, generic errors); logo stays as the sole branding.
- Status: fixed + verified (authtest 32/32 incl. no-leak + animation-marker checks; live page contract 10/10; live login flow green; selftest 12/12, apitest green).

### I-48 — [x] Tor launchers 401'd once sign-in was enforced (anon workflow broken under auth)
- Evidence: all four launchers + both `ANONYMITY_SETUP.md` scripts + CI example POSTed with no session/token → `Sign in required` on an authed server (proven live: launcher printed the 401 as "Test started").
- Strategy: sign-in step everywhere — `.js` via session-cookie `apiCall` jar + `ensureAuth()` (aborts if password unset), `.bat`s via temp-file cookie + `LS_COOKIE` env consumed by IIFE header builders in every call, `.sh`/embedded-sh/CI via curl cookie jar gated on `auth-status`, PS script via `-SessionVariable`/`-WebSession`.
- Status: fixed + verified (`.bat` bodies executed 12/12 incl. 401-without/202-with/bad-login-no-cookie; full `anon-launcher.js` Tor run green: detect → control-verify → `Signed in as yaseen` → live rotations → printed report; selftest 12/12, apitest green, e2e 25/25).

### I-49 — [x] Anonymous testing had no one-click Tor setup on the dashboard (friction item 2 of the "make it workable" request)
- Evidence: proxy + control port had to be typed by hand; launchers auto-detected but the dashboard didn't.
- Strategy: new authed `GET /api/tor-status` (SOCKS 9150→9050 probe + `pickControlPort` verify/fallback, fast timeouts) + dashboard **Detect Tor** button filling both fields with mixed-pair/result messaging. (Friction items 1/3/4 answered without code changes: abort/concurrency guards stay by design — thresholds remain tunable per-run for own-target testing, proxyList round-robins multiple Tor instances; dashboard speed was already SSE-driven.)
- Status: fixed + verified (authtest 34/34 incl. gated+authed tor-status; apitest shape check incl. no-Tor hint; selftest 12/12, e2e 25/25).

### I-50 — [x] CRITICAL: proxy completely bypassed — every "proxied" request went direct (found by the "make features really work" audit)
- Evidence: engine run with dead `http://user:pass@127.0.0.1:9/` proxy → 1395/1395 OK direct. Root cause: both agent factories passed `createConnection` inside the `new Agent()` constructor options, which modern Node (verified v26) silently ignores — custom hook never called, zero errors. Every anonymity/proxy run was theater (SOCKS and HTTP); only `server.js:/api/test-proxy` (raw sockets) ever really used a proxy.
- Strategy: assign `agent.createConnection = fn` (method override) in both factories, with comments so nobody regresses it.
- Status: fixed + verified (dead proxy → honest conn errors; live SOCKS relay rig: 2674/2674 OK *through* relay with relay-side session count > 0; full-config round-trip 21/21 incl. clamp/method/rps/pacing/rotation/threshold/header/body proofs; selftest 12/12, apitest green, authtest 34/34, e2e 25/25).

### I-51 — [x] Proxy credentials persisted into reports/SSE/dashboard (found by the round-trip's no-leak check)
- Evidence: `blockedProxies` stored full `user:pass@` URLs → `summary()` → persisted `reports/*.json` + `/api/report` + rotation log (4 leaked files from my own probes, deleted).
- Strategy: shared `redactProxyUrl()` in `lib/util.js` (`user:pass@` → `***@`); applied at the single `_blockedProxies` writer + `proxy-blocked` event (skip-comparison redacted too, preserving round-robin semantics) + `probeResult.proxy` echo.
- Status: fixed + verified (round-trip no-leak PASS, on-disk scan clean, rotation rig still 2/2).

### I-52 — [x] Dashboard promised what the engine wouldn't do (100k users field, silent rotate no-op)
- Evidence: concurrency input `max=100000` while engine clamps to 10000 (user's own 100k run silently ran 10k); auto-rotate checkbox with no proxy configured silently no-ops (user's run: "despite 0 rotations").
- Strategy: input `max=10000` + hint explaining the cap (ports/sockets, scale via Stress/more generators); `readConfig` belt-and-braces clamp; live `#rotateWarn` hint when auto-rotate is on with both proxy fields empty (init + change/input events).
- Status: fixed + verified (`--check` clean; covered by round-trip clamp proof + suites above).
13. Form-honesty batch (I-50…I-52): proxy-bypass fix, credential redaction, dashboard clamp/warn. Verify: round-trip 21/21, proxy negative+positive proofs, rotation 2/2, selftest 12/12, apitest green, authtest 34/34, e2e 25/25.

### I-53 — [x] Pool auto-skip + rotation tuning (the "stronger anonymous auto-rotating tests" guidelines)
- Evidence: (a) with proxyList-only configs, block rotation never fired (`_worker` gate required single `cfg.proxy`) and dead pool members were never skipped (`_blockedProxies` only ever held the single proxy) — pools distributed but never self-healed; (b) `tor-expert/torrc` had no circuit-turnover tuning.
- Strategy: gate accepts single proxy OR list; per-proxy health (`proxyHealthFails` default 5 consecutive transport fails → skip `proxyHealthCooldownMs` default 60 s, timed recovery, HTTP statuses never blame the proxy, any HTTP response clears) with redacted `proxy-quarantined` events; torrc + generator gain `MaxCircuitDirtiness 60` / `NewCircuitPeriod 30` with comments (NEWNYM is what the tool uses; 1 s values churn circuits, slow tests, and load volunteer relays); pool guide subsection in COMPLETE_GUIDE (multi-Tor ports, NEWNYM stays single-control-port).
- Status: fixed + verified (pool proof: okPct 0.84 with dead authed member, quarantine redacted, list-only rotation rot=2; selftest 12/12, apitest green, authtest 34/34, e2e 25/25, round-trip + proxy proofs green).

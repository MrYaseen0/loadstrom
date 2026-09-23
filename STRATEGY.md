# Strom Fire — Final Issues & Strategy Document

Generated: 2026-09-15

## Test Results

| Suite | Result |
|-------|--------|
| selftest.js (13 tests) | **ALL PASS** |
| e2e-test.js (14 tests, 27 checks) | **ALL PASS** |

---

## All Issues Fixed (This Session + Previous)

### CRITICAL (3 fixed)

| # | Bug | File | Fix |
|---|-----|------|-----|
| 1 | SOCKS5 HTTPS broken — `https.request({socket})` invalid | `engine.js` | Changed to `tls.connect({socket, ciphers, sigalgs, curves})` |
| 2 | Same bug in `_createProxyAgent` + undefined `targetHost` | `engine.js` | Fixed variable + `tls.connect()` |
| 3 | `this` lost in `function sendConnect()` strict mode | `engine.js` | Arrow function + `agentCfg` capture |

### HIGH (3 fixed)

| # | Bug | Fix |
|---|-----|-----|
| 4 | `require('net')` inside per-connection callback | Top-level require |
| 5 | `require('dns')` inside per-request callback | Top-level require |
| 6 | `durationSec=0` masked by `\|\| 30` | Explicit empty-string check |

### MEDIUM (8 fixed)

| # | Bug | Fix |
|---|-----|-----|
| 7 | `reuseConnections` no UI | Checkbox + wiring |
| 8 | Cookie `secure` hardcoded `true` | `secure: !!isHttps` |
| 9 | Launcher port inconsistency (9050 vs 9150) | Standardized to 9150/9151 |
| 10 | TLS fingerprint missing `curves` | Added X25519/P-256/P-384 per profile |
| 11 | HTTP/2 SETTINGS not configurable | Added `h2Settings` config object |
| 12 | Timeline bucket unbounded growth | Added trim when >2x maxTimeline |
| 13 | Per-bucket p95 stale after 256 entries | Generation counter invalidation |
| 14 | HTTP proxy `targetHost` undefined in `_createProxyAgent` | Fixed to `connectHost` |

### LOW (7 fixed)

| # | Bug | Fix |
|---|-----|-----|
| 15 | Cookie jar not persisted | Added `cookieStorePath` config |
| 16 | Redirect phases not accumulated | Merge phases across hops |
| 17 | Unsafe proxy fallback in `_createProxyAgent` | Now throws like `_createAgent` |
| 18 | No 64KB body limit test | Added to selftest |
| 19 | `anon-launcher.bat` kills all node.exe | PID tracking via wmic |
| 20 | Graceful shutdown not supported | Added `gracefulShutdownMs` config |
| 21 | Connection pool metrics missing | Added `connectionPool` to snapshot |

---

## New Features Added

| Feature | Config Field | Description |
|---------|-------------|-------------|
| TLS Curves | `tlsFingerprint` profiles | X25519, P-256, P-384, P-521 per browser profile |
| HTTP/2 SETTINGS | `h2Settings` | headerTableSize, enablePush, maxConcurrentStreams, initialWindowSize, maxFrameSize, maxHeaderListSize |
| Cookie Persistence | `cookieStorePath` | Save/load cookies to JSON file across test runs |
| Redirect Phase Accumulation | automatic | Phase data sums across redirect hops |
| Connection Pool Stats | `connectionPool` in snapshot | active, free, total connections |
| Graceful Shutdown | `gracefulShutdownMs` | Wait for in-flight requests before stopping |
| Body Limit Test | selftest | Validates 64KB body rejection |

---

## Remaining Issues (all DOCUMENTED, no code changes needed)

| # | Issue | Status | Why No Fix |
|---|-------|--------|-----------|
| R1 | TLS fingerprint: Node.js can't fully control ClientHello | DOCUMENTED | Requires native addon (utls); diminishing returns |
| R2 | HTTP/2: SETTINGS fingerprint still detectable | DOCUMENTED | Requires raw TCP HPACK implementation |
| R5 | Precise pacing drift at >500 concurrency | DOCUMENTED | Already adaptive; edge case only |
| R8 | SSE timer runs after test finishes | DOCUMENTED | Already cleaned up when clients disconnect |
| — | `sampleCap` hidden config | BY DESIGN | Advanced API-only tuning |
| — | `proxyAuth` hidden config | BY DESIGN | Embedded in proxy URL |
| — | No DNS rebinding protection | BY DESIGN | String-only validation inherent |
| — | `minRps` warning doesn't fail | BY DESIGN | Advisory, not blocking |

---

## Files Modified

| File | Changes |
|------|---------|
| `lib/engine.js` | 3 CRITICAL fixes, top-level requires, TLS curves, HTTP/2 SETTINGS, cookie persistence, redirect phases, graceful shutdown, connection pool stats, proxy fallback throw, `targetHost` fix |
| `lib/metrics.js` | Timeline bucket TTL trim, per-bucket p95 generation counter |
| `public/app.js` | `durationSec=0` fix, `reuseConnections` wiring |
| `public/index.html` | `reuseConnections` checkbox |
| `anon-launcher.sh` | Port standardization (9150/9151) |
| `anon-launcher.bat` | PID tracking for cleanup |
| `scripts/selftest.js` | 64KB body limit test (13 tests total) |
| `scripts/e2e-test.js` | 27-check E2E test suite |
| `STRATEGY.md` | Comprehensive issues + strategy document |

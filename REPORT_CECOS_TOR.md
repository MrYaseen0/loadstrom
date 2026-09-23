# Anonymous-workflow test — https://cecos.edu.pk/ (2026-09-16)

## Scope (deliberate limits)
- NO high-concurrency load test was run against `cecos.edu.pk` (third-party site, no permission on file).
- Real target traffic: 1× `POST /api/validate` (no page fetch), 1× proxied probe, 1× direct smoke request (concurrency 1, 4 s).
- Rotation ("automatic rerouting") was proven end-to-end against a **local rig** (fake Tor control + failing local target) — zero external traffic, real Tor instance untouched.

## Host Tor inventory (measured, not assumed)
| Port | Finding |
|---|---|
| 9050 SOCKS | live SOCKS5 (`05 00`), working Tor (exit `185.220.101.7` on IP-echo probe) |
| 9150 SOCKS | refused (Tor Browser not running) |
| 9051 control | refused (no system-tor control) |
| 9151 control | answers `250 OK` to `AUTHENTICATE` (unknown instance — left alone, no NEWNYM sent) |

Note the mixed pair (SOCKS 9050 + control 9151) matches neither convention. Launchers now handle this automatically (I-44): they verify the derived control port answers as Tor control and fall back to whichever of 9151/9051 answers, logging a NOTE. Manual runs still need explicit `torControlPort: 9151` on this host.

## Test results
1. **`POST /api/validate` cecos.edu.pk** → 200 `{ok:true, level:ok, host, scheme:https, kind:public}`. Passes safety gates.
2. **`POST /api/test-proxy` via `socks5://127.0.0.1:9050` → `https://cecos.edu.pk/`** → `{ok:false, error:"Connection timeout", ms:5005}`. One request, 5 s budget.
3. **Control: same proxy → `https://httpbin.org/ip`** → `{ok:true, ms:2856, ip:"185.220.101.7"}`. Proxy path works; the cecos timeout is target-side over Tor, not a dead proxy.
4. **Direct smoke (concurrency 1, 4 s, timeout 15 s)** → 1 attempt, 0 responses, verdict `fail`. Phase split: dns 1.5 ms, tcp ~0 ms, **tls 44,654 ms**, then timeout. TCP connects instantly; the TLS handshake never completes (SNI filtering / WAF stall). Saved: `reports/cecos-anon-smoke-2026-09-16.json`.
5. **Local rotation E2E** (failing target + dead `:9150` proxy + fake control, `ENABLE_EVASION=1`) → `rotationCount=2`, `NEWNYM=2`, events `proxy-blocked → block-detected → tor-circuit-rotated` ×2. **PASS.**
6. **Negative control** (same rig, gate off) → `NEWNYM=0`, `tor-rotation-failed` ×2. Proves the gate is load-bearing — this was every launcher run before the I-40 fix.

## Does it reroute automatically?
**Yes — the machinery works, given three preconditions:** (a) `autoRotate: true` + a proxy, (b) `ENABLE_EVASION=1` on the server (all launchers now set it — I-40), (c) a reachable Tor control port with ~10 s NEWNYM cooldown. Live Tor rotation on this host was deliberately NOT exercised (unknown 9151 instance, mismatched pair).

## Incidental finding fixed during this test (I-43)
The 0-response verdict gave Tor/proxy remediation for a **direct** run (rec0–rec3 above). `evaluate()` now takes `{proxied}` from engine config; direct collapses get TLS/network guidance instead. Verified both branches by unit probe; suites still green (selftest 12/12, apitest 18/18, e2e 25/25).

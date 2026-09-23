# Test report — https://cecos.edu.pk/ (redirect + anonymity workflow)

Date (UTC): 2026-09-16 · Method: safe single-request probes only (no concurrency, no load test against a third party) + local engine functional run for load functions.

## Verdict: YES, it reroutes automatically (http → https)

| Start URL | Hops | Result |
|---|---|---|
| `https://cecos.edu.pk/` | 1 hop → `200` | No further redirect. Final page: `CECOS University` (nginx, `text/html; charset=UTF-8`, ~275,535 bytes, ~4.9 s first-hit TLS+TTFB) |
| `http://cecos.edu.pk/` | 2 hops: `301 → https://cecos.edu.pk/` → `200` | Auto-reroutes http → https (~2.1 s for the 301 hop, ~3.4 s for the final 200) |

So: the apex over HTTPS is terminal (no chain); plain HTTP 301-reroutes to HTTPS automatically. LoadStorm with defaults (`followRedirects: true`, `maxRedirects: 5`) follows this hop on its own — confirmed by design and by the traced `Location: https://cecos.edu.pk/` header.

## Anonymity workflow mapping (what LoadStorm would do per request)

| Workflow step | Setting used in probe | Behavior vs this URL |
|---|---|---|
| Header profile | `desktop-chrome` UA + browser headers | Accepted (200, full HTML). No bot-block on single request |
| Proxy | None configured (direct) | Direct TLS to `118.139.165.3`; Tor/proxy rotation not exercised (no proxy credentials supplied) |
| TLS fingerprint | `chrome120` (ciphersuites + groups) | Handshake accepted by nginx |
| Cookies | Per-user jar | `set-cookie`: 0 on both hops |
| Redirects | Follow, max 5 | 301 followed automatically; chain depth 1, well within limit |
| Think-time / jitter | Off by default | Not applied (opt-in only) |
| Auto-rotate | Off by default (needs proxy) | Not triggered; single 200, no blocking detected |

What was NOT tested (deliberately): multi-user load, ramping, or proxy/Tor exit rotation against this host — that requires the owner's written permission (see Responsible-use policy). Supply a proxy URL + written authorization and the same workflow can be re-run through `POST /api/test-proxy` and a proxied engine run.

## Safety / DNS

- DNS: `cecos.edu.pk → 118.139.165.3` (public IPv4, not metadata/link-local).
- `validateTarget()`: `{ok: true, kind: "public", host: "cecos.edu.pk"}` — not on the third-party tripwire list (that list is a small tripwire, not approval).
- `validateTargetResolved()`: `{ok: true}` — resolves to public IP, no rebinding signal.
- NOTE: passing these gates is not permission. Do not load-test this host without authorization.

## Local functional run (real engine data, localhost demo target)

To cover the load functions without touching the third party, `LoadEngine` ran 10 users × 5 s vs local `/demo/fast`:

- Attempted/completed/failed: 15,243 / 15,243 / 0 · error rate 0.00%
- Throughput: ~3,042 rps · p50 2.4 ms · p95 4.9 ms · p99 9 ms
- Verdict: `pass` — "Handled it: 15,243 successful requests at 3043 rps, p95 5 ms"
- Phases tracked (dns/tcp/tls/ttfb/download); wall clock 5 s

Proves: worker loops, pacing, metrics/reservoir, phases, verdict, and report paths all work on real traffic.

## Limitations / next steps

1. Single-request view only — no tail-latency/error-rate profile for cecos.edu.pk (would need authorized load run).
2. No proxy/Tor path exercised — provide `socks5://…` or `http://…` proxy + `ENABLE_EVASION=1` for Tor rotation, then re-run `POST /api/test-proxy {proxy, target}`.
3. First-hit latency (~4.9 s) includes cold TLS + full 275 KB page; not a capacity conclusion.

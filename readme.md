# ⚡ Strom Fire

A **self-hosted, zero-cost load-testing dashboard**. Paste a URL or IP of a site **you own**, choose how many concurrent users and how fast they should hit it, and watch live charts tell you whether your server handles it — with a clear pass/fail verdict at the end.

One owner sign-in. No cloud. No paid tiers. No npm install. One `node` process.

```
┌────────────────────────────────────────────────────────────────────┐
│  paste URL ──▶ pick users & rate ──▶ START ──▶ live dashboard      │
│                                                    charts + KPIs   │
│  verdict: PASS / WARN / FAIL  +  breaking point  +  JSON/CSV report │
└────────────────────────────────────────────────────────────────────┘
```

---

## ⚠️ Responsible use (read this first)

Strom Fire is a **weapon-grade request generator that you point at your own things**. Before every test you must confirm:

> **I own this target or have explicit written permission to load-test it.**

- Load-testing a system without authorisation can be a criminal offence (e.g. US CFAA, UK Computer Misuse Act) and can take someone's site down.
- The server enforces this checkbox server-side and refuses to start without it.
- Well-known third-party hosts (google.com, facebook.com, …) are hard-blocked.
- An **auto-abort safety valve** (default: 10% errors after 50 requests; still armed as an extreme backstop at 50% after 500 requests when IP auto-rotation is on) stops any test whose target is clearly collapsing.
- When in doubt, use the built-in demo target — it runs on your own machine.

## Quick start

You need [Node.js](https://nodejs.org) 18+ (free). Nothing else.

**Windows** — double-click `start.bat`
**Windows (PowerShell)** — `powershell -ExecutionPolicy Bypass -File .\run.ps1`
**macOS / Linux** — `chmod +x run.sh && ./run.sh`
**Any OS** — `node server.js`

Then open <http://127.0.0.1:8787/>. The dashboard opens automatically when you use the launcher scripts. A demo target (`http://127.0.0.1:8787/demo/fast`) is pre-filled so you can run your first test five seconds after launch, safely.

## Sign-in (owner only — no sign-up)

Opening the dashboard asks for a sign-in. There is exactly one account, configured on the server — no registration page exists.

```cmd
:: Windows (example)
set STROMFIRE_USER=admin
set STROMFIRE_PASSWORD=your-strong-password-here
node server.js
```

- Sessions are random server-side tokens in an `HttpOnly` + `SameSite=Lax` cookie (12 h expiry, sliding refresh, `Secure` over TLS). Passwords are verified with scrypt and never stored, logged, or returned.
- Wrong credentials always return the same generic `Invalid username or password.` Sign-in is throttled (10 attempts/min per IP).
- Without `STROMFIRE_PASSWORD` the server runs **open** (dev/test mode) and says so at boot — set it on any machine reachable by others.
- `LOADSTORM_TOKEN` still works for scripts/automation alongside sessions.
- Save your logo as `public/logo.png` (transparent, background-free PNG) — it appears on the sign-in card, the dashboard brand, and the favicon.

## How to check "can my site handle it?"

1. **Smoke** — 5 users, 30 s. Does everything work at all?
2. **Steady load** — set the concurrent users you actually expect in production (e.g. 200). Watch p95 latency and error rate.
3. **Stress (ramp)** — start 20, step 20, max 500. The tool climbs until your pass/fail rules break, then tells you your **breaking point**.
4. Read the verdict: green = handled, amber = bending, red = broke. Export the JSON/CSV report for your records.

Rules of thumb baked into the defaults (edit them per test):

| Rule | Default | Meaning |
|---|---|---|
| Max error rate | 1% | more than 1 in 100 requests failing = not handled |
| Max p95 latency | 1000 ms | 19 of 20 users wait longer than 1 s = not handled |
| Min throughput | 0 (off) | optional floor on requests/sec |

> Prefer p95/p99 over averages. An average of 120 ms can hide a p99 of 8 seconds.

## What's measured

- **Throughput** — requests/second, live and per-second timeline
- **Latency** — avg, p50, p90, **p95**, **p99**, min, max (reservoir-sampled, bounded memory)
- **Errors** — HTTP 4xx/5xx, timeouts, connection errors, each classified separately
- **Status codes** — full breakdown table
- **Stress steps** — per-step rps / p95 / error rate with verdicts, and the breaking point

## Config reference

| Field | What it does |
|---|---|
| URL / IP | full target incl. scheme (`https://…`, `http://10.0.0.5:8080`) |
| Method + headers + body | any HTTP method; JSON headers; request body for POST/PUT/PATCH |
| Concurrent users | closed-model virtual users, each loops request→response→request |
| Target rate (rps) | optional cap; 0 = as fast as the users can go |
| Duration / Ramp-up | seconds; ramp-up staggers user start for realism |
| Stress mode | start/step/max users + seconds per step |
| Pass/fail rules | max error %, max p95 ms, min rps |
| Auto-abort error % | safety valve; test self-stops above this error rate |
| TLS verify / redirects | turn off TLS verification for self-signed test servers |

## HTTP API

The dashboard is just a client of the server API — script it if you like:

```
POST /api/validate   {url}                     → safety check
POST /api/start      {url, confirm:true, ...}  → 202 (test runs)
POST /api/stop                                 → stop current test
GET  /api/status                               → live snapshot
GET  /api/stream                               → SSE live stream (1/s)
GET  /api/report                               → last finished report (JSON)
POST /api/reset                                → clear state
```

## Built-in demo target

`/demo/fast` · `/demo/json` · `/demo/slow?ms=200` · `/demo/heavy?ms=50&kb=50` · `/demo/flaky?rate=0.1`

Loopback-only synthetic endpoints for trying the tool without touching anything real. `/demo/flaky` always fails some fraction so you can see failure handling working.

## Architecture

```
server.js            HTTP server: static UI + API + SSE + demo target (node core only)
lib/engine.js        the load engine: N worker loops, pacing, stress ramp, auto-abort
lib/metrics.js       reservoir-sampled percentiles, per-second timeline
lib/verdict.js       threshold evaluation → pass/warn/fail + recommendations
lib/safety.js        target validation + blocklist
public/              the dashboard (vanilla HTML/CSS/JS, canvas charts, SSE client)
scripts/selftest.js  engine self-test (fixture server + assertions)
scripts/apitest.js   full API integration test
```

Zero dependencies — everything is Node.js core (`http`, `https`, `crypto`-free). Works offline.

## Testing it

One command runs everything (engine, API, auth, proxy/IP probe, full e2e):

```
npm run test:all
```

Individual suites (each boots its own server — no manual setup):

```
npm run selftest    # engine: steady, paced, flaky, stop, auto-abort
npm run apitest     # server: safety gates, start/stop, stress, report
npm run authtest    # sign-in matrix: sessions, cookies, throttle, gates
npm run proxytest   # IP-probe path + proxied load generation
npm run e2e         # 14 full dashboard flows: load, stress, SSE, pacing…
```

`npm test` runs the fast pair (selftest + apitest) only.

## Scaling higher

One Node process comfortably generates thousands of rps (a laptop reached ~2,200 rps with 25 local users in testing). For more:

- Raise concurrency (each user ≈ 1 socket) — on Linux, `ulimit -n 65536` first.
- Run several Strom Fire instances (`PORT=8788 node server.js`) — they aggregate per instance; compare reports side by side.
- Calibrating against the demo target? The demo shares the generator's event loop, so extreme loads self-interfere. For clean numbers, run a dedicated target instance (`PORT=8788 node server.js`) and point the dashboard at `http://127.0.0.1:8788/demo/fast`.
- For web-scale, the next step is true distributed generation (multiple machines); the JSON reports are designed to be merged.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE` | another instance is running; `set PORT=8788` and retry |
| RPS plateaus below target | the site (or a proxy) is the bottleneck, or raise concurrency |
| Many `TIMEOUT` errors | server is saturated — that *is* your answer; also check your timeout setting |
| `ECONNRESET` bursts | target or middlebox dropping connections under load |
| Charts empty | SSE blocked by a proxy — run the dashboard directly on 127.0.0.1 |

## License

MIT — see `LICENSE`. Use it lawfully and responsibly: only test systems you own or are authorised to test.
"# loadstrom" 

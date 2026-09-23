# USE.md — What Strom Fire Is Used For

Strom Fire is a **self-hosted, zero-cost load-testing dashboard** built for one purpose:
**checking whether a website you own can handle real traffic.**

---

## Who uses it

- **Developers** who need to verify their own site handles expected traffic before a release
- **Site owners** (e.g. [yaseenahmadexe.vercel.app](https://yaseenahmadexe.vercel.app/) and other personal projects) who want to confirm their hosting can survive real-world load
- **DevOps engineers** running capacity tests against their own staging or pre-prod environments
- **Anyone with a personal website** who has zero budget for paid load-testing SaaS tools

---

## Core use cases

### 1. Smoke test — "Does it work at all?"
Run 5 concurrent users for 30 seconds. Confirms the site responds correctly under light load.

### 2. Steady load — "Can it handle my expected traffic?"
Set the concurrency you expect in production (e.g. 200 users). Watch p95 latency and error rate in real time.

### 3. Stress test — "Where does it break?"
Use the ramp/stress mode to gradually increase load until the site fails. The tool reports your **breaking point**.

### 4. Anonymous load testing — "Can I test without exposing my IP?"
Route traffic through Tor (`socks5://127.0.0.1:9050`) with header rotation, TLS fingerprint spoofing, and auto-IP-rotation when blocked. See `ANONYMITY_SETUP.md`.

### 5. CI/CD integration — "Automate load tests on every release"
Use the HTTP API (`POST /api/start`, `GET /api/report`) in GitHub Actions or any pipeline to gate deployments on load-test pass/fail verdicts.

### 6. Demo / safe testing — "Try it without touching a real server"
Built-in loopback demo endpoints (`/demo/fast`, `/demo/flaky`, `/demo/slow`) let you verify the tool works end-to-end without targeting anything real.

---

## How to use it (quick)

```bash
node server.js                          # start the dashboard
# Open http://127.0.0.1:8787/
# Sign in (one owner account, no registration)
# Paste your URL (e.g. https://yaseenahmadexe.vercel.app/)
# Set concurrent users, rate, duration
# Click START → watch live charts + verdict
```

Or use the API directly:
```bash
curl -X POST http://127.0.0.1:8787/api/start \
  -H "Content-Type: application/json" \
  -d '{"url":"https://yaseenahmadexe.vercel.app/","concurrency":50,"durationSec":60,"confirm":true}'
```

---

## What you get back

- **Pass / Warn / Fail verdict** based on error rate, p95 latency, and throughput
- **Breaking point** (in stress mode) — the concurrency level where the site fails
- **Live dashboard**: throughput, latency (p50/p90/p95/p99), error breakdown, status codes
- **JSON/CSV report** for records, CI gates, or post-mortems
- **Per-step results** showing rps, p95, error rate at each stress level

---

## Targets you can test

| Target type | Example | Notes |
|---|---|---|
| Your own Vercel site | `https://yaseenahmadexe.vercel.app/` | Personal project |
| Your own staging server | `https://staging.mycorp.com` | Must be authorized |
| Your own LAN device | `http://192.168.1.10:8080` | Explicit private IP allowed |
| Local demo | `http://127.0.0.1:8787/demo/fast` | Built-in, safe, no real target |
| Any site you own | Any `http://` or `https://` URL | Owner confirmation required |

---

## What Strom Fire will NOT test

- **Well-known third-party sites** (google.com, facebook.com, youtube.com, etc.) — hard-blocked server-side
- **Cloud metadata endpoints** (169.254.169.254) — blocked as SSRF protection
- **Empty/invalid URLs** — rejected before any request is sent
- **Sites you don't own** — `confirm=true` + server-side validation required

---

## Responsible use

> **You must own the target or have explicit written permission to load-test it.**
> Load-testing without authorization is a criminal offense in many jurisdictions (US CFAA, UK Computer Misuse Act).
>
> The server enforces this with a confirmation gate, a third-party blocklist, and an auto-abort safety valve.
> When in doubt, use the built-in demo target — it runs on your own machine.

---

## Common workflows

### Pre-deployment check
1. Point at your staging URL
2. Run steady load at expected production concurrency
3. Verify p95 < 1s and error rate < 1%
4. Deploy if verdict is PASS

### Pre-launch stress test
1. Use stress mode with ramp-up (start 20, step 20, max 500)
2. Watch until breaking point is reached
3. Know your safe operating limit (50–70% of breaking point)
4. Harden the target, then re-test

### Anonymity-required testing
1. Start Tor service
2. Set `proxy: "socks5://127.0.0.1:9050"` and `autoRotate: true`
3. Run with `ENABLE_EVASION=1`
4. Tor rotates circuits; tool auto-rotates IP when blocked

---

*See `readme.md` for full configuration reference and `HARDENING_PLAYBOOK.md` for capacity testing methodology.*

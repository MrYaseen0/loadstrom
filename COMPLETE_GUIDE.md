# Strom Fire Complete Guide: From Basic to Advanced

**Version:** 2.0  
**For:** Strom Fire self-hosted load tester  
**Scope:** Complete tutorial — install, configure, run basic tests, then advance to anonymity, high-throughput, and CI/CD integration.

---

## Table of Contents

1. [Quick Start (5 minutes)](#1-quick-start-5-minutes)
2. [Basic Load Testing](#2-basic-load-testing)
3. [Understanding Results](#3-understanding-results)
4. [Stress Testing (Find Breaking Point)](#4-stress-testing-find-breaking-point)
5. [Anonymity & Proxy (Hide Your Identity)](#5-anonymity--proxy-hide-your-identity)
6. [High-Throughput Tuning](#6-high-throughput-tuning)
7. [Custom Headers & Browser Spoofing](#7-custom-headers--browser-spoofing)
8. [CI/CD Integration](#8-cicd-integration)
9. [Advanced Scenarios](#9-advanced-scenarios)
10. [Troubleshooting](#10-troubleshooting)
11. [Legal & Ethics](#11-legal--ethics)

---

## 1. Quick Start (5 Minutes)

### Prerequisites

| OS | Command |
|----|---------|
| **Windows** | `choco install nodejs-lts tor -y` |
| **macOS** | `brew install node tor` |
| **Linux (Ubuntu/Debian)** | `sudo apt install nodejs tor` |

### Install Strom Fire

```bash
# Clone or download to your machine
cd /path/to/loadstorm

# No dependencies to install! (Zero-dep)
node --version  # Verify Node.js 18+
```

### Start Tor (for anonymity)

```bash
# Linux/macOS
sudo systemctl start tor
# or
brew services start tor

# Windows (Admin PowerShell)
net start tor
```

**Verify Tor works:**
```bash
curl --socks5 127.0.0.1:9050 https://check.torproject.org/api/ip
# Should return a Tor exit node IP, NOT your real IP
```

### Launch Dashboard

```bash
cd /path/to/loadstorm
node server.js
```

Open browser: **http://127.0.0.1:8787/**

### Run Your First Test

1. **Paste your target URL** (must be a system YOU own)
2. **Click "Use demo target"** to test safely first
3. **Tick "I own this target"**
4. **Click "▶ Start test"**
5. Watch live charts → Get report

---

## 2. Basic Load Testing

### Dashboard Walkthrough

```
┌─────────────────────────────────────────────────────────────┐
│ 1 · TARGET                                                  │
│   URL: https://your-staging.example.com                     │
│   Method: GET  |  Timeout: 10000ms                         │
├─────────────────────────────────────────────────────────────┤
│ 2 · LOAD PROFILE                                            │
│   ☐ Steady Load  (fixed concurrency)                       │
│   ☐ Stress/Ramp  (step up until break)                     │
│                                                             │
│   Steady:                                                   │
│   Concurrent Users: 100     Target RPS: 0 (unlimited)      │
│   Duration: 60s             Ramp-up: 10s                   │
├─────────────────────────────────────────────────────────────┤
│ 3 · PASS/FAIL RULES                                         │
│   Max Error %: 1      Max p95: 1000ms      Min RPS: 0      │
├─────────────────────────────────────────────────────────────┤
│   [Advanced] [Anonymity & Proxy]                           │
│   ☑ I own this target                                       │
│   [▶ Start test]  [■ Stop]  [Reset]                        │
└─────────────────────────────────────────────────────────────┘
```

### Recommended Starter Config

| Setting | Value | Why |
|---------|-------|-----|
| **Mode** | Steady Load | Baseline measurement |
| **Concurrent Users** | 50 | Start conservative |
| **Target RPS** | 0 (unlimited) | Let concurrency drive rate |
| **Duration** | 60s | Long enough for stable metrics |
| **Ramp-up** | 10s | Gradual start, avoids spikes |
| **Max Error %** | 1 | Strict baseline |
| **Max p95** | 1000ms | Reasonable threshold |

### Run & Observe

1. Click **Start test**
2. Watch **live charts** (RPS, latency, errors)
3. Wait for **verdict**: Pass / Warnings / Fail
4. Click **Export JSON** or **Copy summary**

---

## 3. Understanding Results

### Key Metrics Explained

| Metric | Good | Warning | Bad | What It Means |
|--------|------|---------|-----|---------------|
| **RPS** | High | Medium | Low | Requests per second throughput |
| **p50** | <100ms | 100-500ms | >500ms | Median latency |
| **p95** | <500ms | 500-2000ms | >2000ms | 95th percentile (tail) |
| **p99** | <1000ms | 1-3s | >3s | Worst 1% experience |
| **Error %** | 0% | <1% | >1% | Failed requests |
| **Timeouts** | 0 | <0.5% | >0.5% | Requests that hung |

### Verdict Types

| Status | Meaning | Action |
|--------|---------|--------|
| **Pass** | All thresholds met | Increase load, find limits |
| **Warnings** | Near thresholds | Investigate, then push harder |
| **Fail** | Thresholds exceeded | Fix bottleneck, re-test |

### Status Code Breakdown

| Code Range | Meaning | Typical Cause |
|------------|---------|---------------|
| **2xx** | Success | Healthy |
| **3xx** | Redirect | Check redirect chains |
| **4xx** | Client error | Bad requests, auth issues |
| **5xx** | Server error | Overload, crashes, timeouts |
| **timeout** | No response | Server hung, firewall |
| **conn error** | TCP/TLS failed | Network, cert, proxy |

---

## 4. Stress Testing (Find Breaking Point)

### When to Use Stress Mode

- After baseline passes
- To find **maximum capacity**
- To identify **breaking point**
- For capacity planning

### Stress Config

```
Mode: Stress/Ramp
Start Users: 20
Step: 20 users per step
Max Users: 500
Seconds per Step: 30
Thresholds: Max Error 5%, Max p95 2000ms
```

### How It Works

```
Step 1:  20 users → 30s → Pass? → Continue
Step 2:  40 users → 30s → Pass? → Continue
Step 3:  60 users → 30s → Pass? → Continue
...
Step 6:  120 users → 30s → FAIL → STOP (breaking point = 120; safe limit ≈ 60–84 users)
```

### Reading Stress Results

| Column | Meaning |
|--------|---------|
| **Users** | Concurrency at this step |
| **RPS** | Throughput achieved |
| **p95** | Tail latency |
| **Err %** | Error rate |
| **Verdict** | Pass/Warn/Fail |

**Safe Operating Limit = 50-70% of breaking point**

---

## 5. Anonymity & Proxy (Hide Your Identity)

### Why Anonymity Matters

- Test **external-facing** staging behind WAF/CDN
- Avoid **rate limiting** by your own infrastructure
- Simulate **real user geography** (via proxy locations)
- **Security testing** without triggering alerts

### Proxy Types Supported

| Type | Format | Use Case |
|------|--------|----------|
| **SOCKS5 (Tor)** | `socks5://127.0.0.1:9050` | Maximum anonymity |
| **HTTP/HTTPS** | `http://user:pass@proxy:8080` | Corporate proxy, residential |
| **Proxy List** | Multiple (one per line) | Round-robin IP rotation |

### Setup Tor (Best Anonymity)

```bash
# Install
sudo apt install tor          # Linux
brew install tor              # macOS
choco install tor -y          # Windows

# Start
sudo systemctl start tor      # Linux
brew services start tor       # macOS
net start tor                 # Windows (Admin)

# Verify
curl --socks5 127.0.0.1:9050 https://ifconfig.me
```

### Configure in Dashboard

1. Open **Anonymity & Proxy** section
2. **Proxy URL**: `socks5://127.0.0.1:9050`
3. **Header Profile**: `desktop-chrome`
4. **Rotate Headers**: ✅ ON
4. **Request Jitter**: `25` ms (small jitter only — large values queue Tor runs)
5. **Isolate Cookies**: ✅ ON
6. **Simulate User Session**: ⬜ OFF (opt-in for realism only — think-time throttles Tor runs)
7. **HTTP Version**: `1.1` (HTTP/2 unstable over Tor)

### Proxy List (Round-Robin Rotation)

```
socks5://127.0.0.1:9150
socks5://127.0.0.1:9050
http://user:pass@residential-proxy1.com:8080
http://user:pass@residential-proxy2.com:8080
```

Each virtual user gets a different proxy → **distributed IP footprint**.

### Pool Auto-Skip (dead members drop out on their own)

A pool member that fails transport-level requests 5 times in a row (`proxyHealthFails`) is skipped for 60 s (`proxyHealthCooldownMs`), then retried automatically — a dead entry can't drag the run down, and no control port is needed for this. Only transport failures (timeouts/conn errors) count; HTTP error statuses blame the target, not the proxy. A `proxy-quarantined` line appears in the rotation log naming the redacted URL (credentials never logged).

Want several Tor exits at once? Run extra Tor instances on their own ports (e.g. second torrc with `SocksPort 9052` + `ControlPort 9053`) and list them all in Proxy List. Distribution + auto-skip work per member; the NEWNYM control signal still targets the single configured `torControlPort`.

---

## 6. High-Throughput Tuning

### When You Need More Than 1 Machine

| Concurrency | Recommended Setup |
|-------------|-------------------|
| 100-500 | Single machine, direct |
| 500-2000 | Single machine, optimized |
| 2000-5000 | Single machine + HTTP/2 |
| 5000+ | **Multiple generators** |

### Single Machine Optimization

```bash
# Linux: Increase file descriptors
echo "* soft nofile 100000" | sudo tee /etc/security/limits.d/loadstorm.conf
echo "* hard nofile 100000" | sudo tee -a /etc/security/limits.d/loadstorm.conf

# Increase ephemeral ports
sudo sysctl -w net.ipv4.ip_local_port_range="1024 65535"
sudo sysctl -w net.core.somaxconn=4096

# Apply
sudo sysctl -p
```

### Unlimited Mode (Run Until Stopped)

```json
{
  "mode": "load",
  "concurrency": 50,
  "durationSec": 0,
  "rampUpSec": 10,
  "proxy": "socks5://127.0.0.1:9150",
  "autoRotate": true,
  "torControlPort": 9151,
  "blockThresholdPct": 70,
  "abortOnErrorRatePct": 50,
  "confirm": true
}
```

**Key Settings:**
- `durationSec: 0` = **Unlimited** (runs until you click Stop)
- `autoRotate: true` = Auto-rotate IP when blocked
- `abortOnErrorRatePct: 50` = Backstop: rotation handles transient blocks, but a dead proxy/path stops the run instead of piling up failures (do not use 0)
- Keep Tor concurrency ≤ 20 per circuit; probe `https://httpbin.org/ip` (an IP-echo URL) first — probing a target HTML page cannot show the exit IP

### High-Throughput Config

```json
{
  "mode": "load",
  "concurrency": 2000,
  "durationSec": 300,
  "rampUpSec": 60,
  "httpVersion": "2",
  "pacing": "precise",
  "timeoutMs": 30000,
  "trackPhases": true
}
```

### Multiple Generators (Horizontal Scale)

```bash
# Generator 1 (Machine A)
PORT=8787 node server.js &

# Generator 2 (Machine B)
PORT=8787 node server.js &

# Coordinator splits load:
# Gen 1: users 1-1000, Gen 2: users 1001-2000
# Aggregate results manually (sum RPS, weighted p95)
```

### Load Balancer for Generators

```nginx
# nginx.conf upstream for Strom Fire generators
upstream loadstorm_generators {
    server gen1:8787;
    server gen2:8787;
    server gen3:8787;
}
```

---

## 7. Custom Headers & Browser Spoofing

### Pre-built Profiles (Select in Dropdown)

| Profile | User-Agent | Best For |
|---------|------------|----------|
| `desktop-chrome` | Chrome 120 Windows | Most sites |
| `desktop-firefox` | Firefox 121 Windows | Firefox-heavy traffic |
| `desktop-safari` | Safari 17 macOS | Apple ecosystem |
| `mobile-chrome` | Chrome 120 Android | Mobile traffic |
| `api-client` | Minimal | API endpoints |
| `minimal` | Strom Fire default | Internal testing |

### Custom Headers (Advanced Section)

```json
{
  "Authorization": "Bearer eyJhbGciOiJIUzI1NiIs...",
  "X-API-Key": "your-api-key",
  "X-Request-ID": "load-test-{{timestamp}}",
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "X-Forwarded-For": "auto",
  "CF-Connecting-IP": "auto"
}
```

### Anti-Fingerprinting Features (Auto)

| Feature | Enable Via | Effect |
|---------|------------|--------|
| **Header Rotation** | Anonymity → Rotate Headers | Shuffles Accept-Language per request |
| **Sticky UA** | Auto (per virtual user) | Consistent identity per user |
| **Header Order Shuffle** | Anonymity → Request Order Randomization | Randomizes header key order |
| **Think Time** | Anonymity → Simulate User Session | 500-3500ms between requests |
| **Cookie Isolation** | Anonymity → Isolate Cookies | Separate session per user |

### Maximum Evasion Config

```json
{
  "proxyList": ["socks5://127.0.0.1:9050"],
  "headerProfile": "desktop-chrome",
  "rotateHeaders": true,
  "requestJitterMs": 25,
  "isolateCookies": true,
  "simulateUserSession": false,
  "requestOrderRandomization": true,
  "tlsFingerprint": "chrome120",
  "httpVersion": "1.1",
  "timeoutMs": 30000,
  "autoRotate": true,
  "blockThresholdPct": 70,
  "abortOnErrorRatePct": 50,
  "headers": {
    "Authorization": "Bearer token",
    "X-Custom": "value"
  }
}
```

> Tor caution: one circuit handles ~20 concurrent users — keep `concurrency` ≤ 20, and probe an IP-echo URL (`https://httpbin.org/ip`) before the real target. Think-time + jitter trade throughput for realism; the `abortOnErrorRatePct` backstop stays armed even with `autoRotate` (extreme-rate stop after 500 requests).

---

## 8. CI/CD Integration

### GitHub Actions Example

```yaml
# .github/workflows/load-test.yml
name: Load Test Staging
on:
  workflow_dispatch:
    inputs:
      target:
        description: 'Staging URL'
        required: true
        default: 'https://staging.example.com'
      concurrency:
        description: 'Concurrent users'
        default: '200'

jobs:
  load-test:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      
      - name: Install Tor
        run: |
          sudo apt update && sudo apt install -y tor
          sudo systemctl start tor
          sleep 3
          curl --socks5 127.0.0.1:9050 https://ifconfig.me
      
      - name: Start Strom Fire
        run: |
          cd loadstorm
          node server.js &
          sleep 3
      
      - name: Sign in (skipped when auth is off)
        env:
          STROMFIRE_USER: admin
          STROMFIRE_PASSWORD: ${{ secrets.STROMFIRE_PASSWORD }}
        run: |
          cd loadstorm
          rm -f cookies.txt
          if curl -s http://127.0.0.1:8787/api/auth-status | jq -e '.authEnabled == true and .authed == false' >/dev/null; then
            curl -s -c cookies.txt -X POST http://127.0.0.1:8787/api/login \
              -H "Content-Type: application/json" \
              -d "{\"username\":\"$STROMFIRE_USER\",\"password\":\"$STROMFIRE_PASSWORD\"}"
          else
            touch cookies.txt
          fi
      
      - name: Run Load Test
        env:
          TARGET: ${{ inputs.target }}
          CONCURRENCY: ${{ inputs.concurrency }}
        run: |
          cd loadstorm
          cat > test-config.json <<EOF
          {
            "url": "$TARGET",
            "mode": "load",
            "concurrency": $CONCURRENCY,
            "durationSec": 300,
            "rampUpSec": 30,
            "proxy": "socks5://127.0.0.1:9050",
            "headerProfile": "desktop-chrome",
            "rotateHeaders": true,
            "requestJitterMs": 25,
            "isolateCookies": true,
            "simulateUserSession": false,
            "timeoutMs": 30000,
            "autoRotate": true,
            "torControlPort": 9051,
            "blockThresholdPct": 70,
            "abortOnErrorRatePct": 50,
            "confirm": true
          }
          EOF
          
          # Start test
          RESPONSE=$(curl -s -b cookies.txt -X POST http://127.0.0.1:8787/api/start \
            -H "Content-Type: application/json" \
            -d @test-config.json)
          echo "Started: $RESPONSE"
          
          # Poll for completion
          while true; do
            sleep 10
            STATUS=$(curl -s -b cookies.txt http://127.0.0.1:8787/api/status)
            STATE=$(echo "$STATUS" | jq -r '.engineState')
            RPS=$(echo "$STATUS" | jq -r '.rps // .attemptedRps // 0')
            echo "State: $STATE | RPS: $RPS"
            [[ "$STATE" =~ ^(finished|error|stopping)$ ]] && break
          done
          
          # Get report
          curl -s -b cookies.txt http://127.0.0.1:8787/api/report | jq '.report' > load-report.json
          
          # Check verdict
          VERDICT=$(jq -r '.result.status' load-report.json)
          echo "Verdict: $VERDICT"
          [[ "$VERDICT" == "pass" ]] || exit 1
      
      - name: Upload Report
        uses: actions/upload-artifact@v4
        with:
          name: loadstorm-report
          path: loadstorm/load-report.json
```

### GitLab CI Example

```yaml
# .gitlab-ci.yml
load_test:
  stage: test
  image: node:20
  services:
    - name: alpine/tor
      alias: tor
  variables:
    TARGET_URL: "https://staging.example.com"
  script:
    - cd loadstorm
    - node server.js &
    - sleep 3
    - |
      cat > config.json <<EOF
      {
        "url": "$TARGET_URL",
        "mode": "load",
        "concurrency": 100,
        "durationSec": 120,
        "proxy": "socks5://tor:9050",
        "headerProfile": "desktop-chrome",
        "rotateHeaders": true,
        "confirm": true
      }
      EOF
    - curl -X POST http://localhost:8787/api/start -H "Content-Type: application/json" -d @config.json
    - # ... poll and check verdict
```

---

## 9. Advanced Scenarios

### API Load Testing (POST/PUT/PATCH)

```json
{
  "url": "https://api.example.com/orders",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer token"
  },
  "body": "{\"productId\": 123, \"quantity\": 2, \"userId\": \"{{userId}}\"}",
  "mode": "load",
  "concurrency": 50,
  "durationSec": 120
}
```

**Dynamic body per user** — use `{{userId}}` placeholder (replaced per virtual user).

### Authentication Flow Testing

```json
{
  "url": "https://auth.example.com/login",
  "method": "POST",
  "headers": { "Content-Type": "application/x-www-form-urlencoded" },
  "body": "username=testuser&password=testpass",
  "simulateUserSession": true,
  "isolateCookies": true,
  "followRedirects": true
}
```

**Cookie isolation** maintains session per virtual user.

### GraphQL Load Testing

```json
{
  "url": "https://api.example.com/graphql",
  "method": "POST",
  "headers": { "Content-Type": "application/json" },
  "body": "{\"query\": \"{ products { id name price } }\"}",
  "mode": "stress",
  "stress": { "start": 10, "step": 10, "max": 200, "stepDurationSec": 30 }
}
```

### WebSocket Testing (Not Native — Use HTTP Upgrade)

```bash
# Strom Fire is HTTP/HTTPS only
# For WebSocket, use: wscat, artillery, or k6
```

### Spike Testing

```json
{
  "mode": "load",
  "concurrency": 1000,
  "durationSec": 10,
  "rampUpSec": 1,
  "abortOnErrorRatePct": 20
}
```

**Sudden burst** — tests auto-scaling, circuit breakers.

### Soak Testing (Long Duration)

```json
{
  "mode": "load",
  "concurrency": 200,
  "durationSec": 7200,  # 2 hours
  "rampUpSec": 60,
  "abortOnErrorRatePct": 5
}
```

**Watch for**: Memory leaks, GC pauses, connection pool exhaustion.

---

## 10. Troubleshooting

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ECONNREFUSED 127.0.0.1:9050` | Tor not running | `systemctl start tor` |
| `Proxy CONNECT failed: 403` | Proxy auth required | Add `user:pass@` to proxy URL |
| `Certificate verify failed` | Self-signed cert | Uncheck "Verify TLS" (testing only) |
| `HTTP/2 hang` | HTTP/2 over proxy/Tor | Use `httpVersion: "1.1"` |
| `Low RPS over Tor` | Tor latency | Increase `timeoutMs` to 60000 |
| `MaxListenersExceededWarning` | Too many connections | Reduce concurrency, check leaks |
| `Test won't start` | Confirm not checked | Tick "I own this target" |
| `403 Forbidden` | WAF blocking | Use proxy, rotate headers, reduce rate |

### Debug Mode

```bash
# Verbose logging
DEBUG=* node server.js

# Or add to config
{
  "debug": true
}
```

### Check System Limits

```bash
# Current limits
ulimit -a

# Should show:
# open files: 100000
# max user processes: 100000
```

### Port Exhaustion

```bash
# Check TIME_WAIT connections
netstat -an | grep TIME_WAIT | wc -l

# Fix: Increase port range, enable reuse
sudo sysctl -w net.ipv4.tcp_tw_reuse=1
```

---

## 11. Legal & Ethics

### ⚠️ MANDATORY RULES

| Rule | Enforcement |
|------|-------------|
| **Only test systems you own** | Strom Fire requires `confirm: true` on every start |
| **Written permission required** | For any external/internal shared system |
| **No unauthorized targets** | Blocklist prevents known public sites |
| **Rate limit your tests** | Auto-abort at 10% error rate by default |
| **Respect robots.txt / ToS** | Your responsibility |

### Legal Frameworks

| Jurisdiction | Law | Risk |
|--------------|-----|------|
| **USA** | CFAA (18 U.S.C. § 1030) | Felony for unauthorized access |
| **EU** | GDPR Art. 32 | Fines up to 4% revenue |
| **UK** | Computer Misuse Act 1990 | Up to 10 years prison |
| **Canada** | Criminal Code s.342.1 | Up to 10 years |

### Best Practices

1. **Use staging/pre-prod only** — Never production without explicit approval
2. **Schedule with ops team** — Coordinate maintenance windows
3. **Start small** — Smoke test → baseline → stress
4. **Monitor target** — Watch CPU, RAM, DB, logs during test
5. **Document everything** — Config, results, changes, approvals

### Authorization Template

```
LOAD TEST AUTHORIZATION

Target: https://staging.example.com
Date: 2026-01-15 10:00-12:00 UTC
Tester: [Your Name/Team]
Tool: Strom Fire v2.0
Max Concurrency: 500
Max Duration: 2 hours
Expected Impact: <5% CPU, <10% memory increase
Rollback Plan: Stop test immediately if errors >1%

Approved by: _________________ (Infrastructure Lead)
Date: _________________
```

---

## Appendix: Command Reference

### Dashboard URLs

| URL | Purpose |
|-----|---------|
| `http://localhost:8787/` | Main dashboard |
| `http://localhost:8787/api/health` | Health check |
| `http://localhost:8787/api/demo-target` | Get demo URLs |
| `http://localhost:8787/api/validate` | Validate target (POST) |
| `http://localhost:8787/api/start` | Start test (POST) |
| `http://localhost:8787/api/stop` | Stop test (POST) |
| `http://localhost:8787/api/status` | Live status (GET) |
| `http://localhost:8787/api/report` | Final report (GET) |
| `http://localhost:8787/api/stream` | SSE live stream (GET) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8787 | Server port |
| `HOST` | 127.0.0.1 | Bind address |
| `USE_TLS` | 0 | Enable HTTPS (1=yes) |
| `TLS_KEY_FILE` | ./tls/key.pem | TLS key path |
| `TLS_CERT_FILE` | ./tls/cert.pem | TLS cert path |
| `OPEN_BROWSER` | 0 | Auto-open browser (1=yes) |

### CLI Scripts

```bash
# Self-test (verify installation)
node scripts/selftest.js

# Anonymous launcher (Windows)
anon-launcher.bat "https://target.com" 20 0

# Anonymous launcher (Node.js)
node anon-launcher.js "https://target.com" 20 0

# Anonymous launcher (Linux/macOS)
./anon-launcher.sh "https://target.com" 20 300 desktop-chrome 25
```

---

## Next Steps

1. **Start with demo target** → Verify everything works
2. **Test your staging** → Baseline at 50 users
3. **Add Tor + anonymity** → Test behind WAF/CDN
4. **Run stress test** → Find breaking point
5. **Optimize target** → Fix bottlenecks, re-test
6. **Add to CI/CD** → Gate deployments on load test pass
7. **Scale horizontally** → Multiple generators for 5k+ users

---

**Remember:** Strom Fire is a tool for **testing systems you own**. The anonymity features help you test realistic traffic patterns against your own infrastructure — not to attack others.

**Happy Load Testing!** ⚡
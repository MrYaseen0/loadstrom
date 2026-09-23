# Strom Fire Quick Reference Card

## 🚀 Quick Start (Windows)

```cmd
# Double-click to start (auto-detects Tor)
start.bat

# Or run from command line
cd "C:\New folder\loadstorm"
node server.js
# Open http://127.0.0.1:8787
```

## 🚀 One-Line Commands

```bash
# Start dashboard
node server.js

# Start with HTTPS (auto self-signed cert)
USE_TLS=1 node server.js

# Run self-test
node scripts/selftest.js

# Run anonymous test (Node.js launcher)
node anon-launcher.js "https://target.com" 100 60

# Run anonymous test (Windows batch)
.\anon-launcher.bat "https://target.com" 100 60
```

## 📊 Dashboard Config Cheat Sheet

### Basic Test (Start Here)
| Field | Value |
|-------|-------|
| Mode | **Steady Load** |
| Concurrent Users | **50** |
| Target RPS | **0** (unlimited) |
| Duration | **60s** (or `0` for unlimited) |
| Ramp-up | **10s** |
| Max Error % | **1** |
| Max p95 | **1000ms** |

### Unlimited Test (Run Until Stopped)
| Field | Value |
|-------|-------|
| Mode | **Steady Load** |
| Concurrent Users | **50** |
| Duration | **0** (unlimited) |
| Auto-rotate IP | **✅ Enabled** |
| Block threshold | **70%** |
| Abort on error | **50** (extreme backstop — never 0, it disables the safety valve) |

**Duration = 0** means the test runs forever until you click Stop. Combined with auto-rotation, the system will keep rotating IPs unlimited times — the abort backstop still stops a dead-proxy run instead of piling up failures forever.

### Stress Test (Find Limits)
| Field | Value |
|-------|-------|
| Mode | **Stress/Ramp** |
| Start Users | **20** |
| Step | **20** |
| Max Users | **500** |
| Seconds/Step | **30** |
| Max Error % | **5** |
| Max p95 | **2000ms** |

### High Throughput
| Field | Value |
|-------|-------|
| Concurrent Users | **1000-5000** |
| HTTP Version | **2** (HTTPS only) |
| Pacing | **Precise** |
| Timeout | **30000ms** |

---

## 🔒 Anonymity Config (Maximum Evasion)

```json
{
  "proxyList": [
    "socks5://127.0.0.1:9150",
    "socks5://127.0.0.1:9050"
  ],
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
  "abortOnErrorRatePct": 50
}
```

> Tor caution: one circuit handles ~20 concurrent users — keep `concurrency` ≤ 20, and probe an IP-echo URL (`https://httpbin.org/ip`) before the real target. Think-time + jitter trade throughput for realism; drop them when measuring max RPS.

### Proxy Formats
| Type | Format |
|------|--------|
| Tor Browser (recommended) | `socks5://127.0.0.1:9150` |
| Tor Service | `socks5://127.0.0.1:9050` |
| HTTP Proxy | `http://user:pass@proxy:8080` |
| HTTPS Proxy | `https://user:pass@proxy:8443` |
| SOCKS5 w/ Auth | `socks5://user:pass@host:1080` |

---

## 🔄 Auto IP Rotation (Bypass Blocks)

When the website blocks your IP, Strom Fire automatically switches to a new one.

### Dashboard Settings
| Setting | Default | Description |
|---------|---------|-------------|
| Auto-rotate IP | ⬜ Opt-in | Detect blocks & switch IPs |
| Tor control port | `9151` | Tor Browser's control port |
| Block threshold | `70%` | Error rate that triggers rotation |

### How It Works
1. **Detection** — Monitors timeout/error rate per request window
2. **Trigger** — When >70% errors (configurable), assumes blocked
3. **Rotation** — Tor: sends NEWNYM signal for new exit IP
4. **Continue** — Test resumes with fresh IP automatically

### Live Log Messages
```
⚠ Block detected — 45 timeouts, rotating IP...
✓ Tor circuit rotated (new exit IP) — rotation #1
```

### API Config
```json
{
  "proxy": "socks5://127.0.0.1:9150",
  "autoRotate": true,
  "torControlPort": 9151,
  "blockThresholdPct": 70
}
```

### Header Profiles
| Profile | Use For |
|---------|---------|
| `desktop-chrome` | General (default) |
| `desktop-firefox` | Firefox traffic |
| `desktop-safari` | Apple ecosystem |
| `mobile-chrome` | Mobile users |
| `api-client` | REST/GraphQL APIs |
| `minimal` | Internal/debug |

---

## 🎯 API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Health check |
| GET | `/api/demo-target` | Get demo URLs |
| POST | `/api/validate` | Validate target |
| POST | `/api/start` | Start test |
| POST | `/api/stop` | Stop test |
| POST | `/api/reset` | Reset engine |
| GET | `/api/status` | Live status |
| GET | `/api/report` | Final report |
| GET | `/api/stream` | SSE live updates |

### Start Test Payload (Minimal)
```json
{
  "url": "https://target.com",
  "mode": "load",
  "concurrency": 100,
  "durationSec": 60,
  "confirm": true
}
```

### Start Test Payload (Full)
```json
{
  "url": "https://target.com",
  "method": "GET",
  "mode": "load",
  "concurrency": 200,
  "rps": 0,
  "durationSec": 300,
  "rampUpSec": 30,
  "timeoutMs": 15000,
  "tlsVerify": true,
  "followRedirects": true,
  "httpVersion": "1.1",
  "trackPhases": true,
  "pacing": "standard",
  "proxy": "socks5://127.0.0.1:9050",
  "proxyList": [],
  "headerProfile": "desktop-chrome",
  "rotateHeaders": true,
  "requestJitterMs": 25,
  "tlsFingerprint": "chrome120",
  "isolateCookies": true,
  "simulateUserSession": false,
  "requestOrderRandomization": true,
  "autoRotate": true,
  "torControlPort": 9051,
  "blockThresholdPct": 70,
  "abortOnErrorRatePct": 10,
  "thresholds": {
    "maxErrorRatePct": 1,
    "maxP95Ms": 1000,
    "minRps": 0
  },
  "stress": {
    "start": 20,
    "step": 20,
    "max": 500,
    "stepDurationSec": 30
  },
  "headers": {},
  "body": null,
  "confirm": true
}
```

> Tor caution: this reference pairs a Tor proxy with rotation + small jitter and no think-time — through one circuit keep `concurrency` ≤ 20 and prefer small jitter; the abort valve stays armed as an extreme backstop (50% after 500 requests) even with `autoRotate` on.

---

## 📈 Metric Thresholds

| Metric | Good | Warning | Critical |
|--------|------|---------|----------|
| **p50** | <50ms | 50-200ms | >200ms |
| **p95** | <200ms | 200-1000ms | >1000ms |
| **p99** | <500ms | 500-2000ms | >2000ms |
| **Error %** | 0% | <0.1% | >1% |
| **Timeouts** | 0 | <0.1% | >0.5% |
| **RPS** | >target*0.8 | >target*0.5 | <target*0.5 |

---

## 🛠️ System Tuning (Linux)

```bash
# File descriptors
echo "* soft nofile 100000" | sudo tee /etc/security/limits.d/loadstorm.conf
echo "* hard nofile 100000" | sudo tee -a /etc/security/limits.d/loadstorm.conf

# Port range
sudo sysctl -w net.ipv4.ip_local_port_range="1024 65535"
sudo sysctl -w net.core.somaxconn=4096
sudo sysctl -w net.ipv4.tcp_tw_reuse=1

# Apply
sudo sysctl -p
```

---

## 🐛 Quick Debug

| Issue | Fix |
|-------|-----|
| Tor not connecting | Open Tor Browser → click "Connect" |
| Tor blocked your IP | Enable auto-rotation (switches exit IP when blocked) |
| Proxy 403 | Add `user:pass@` to proxy URL |
| Cert error | Uncheck "Verify TLS" (testing only) |
| HTTP/2 hang | Use `httpVersion: "1.1"` |
| Low RPS | Increase concurrency, check target health |
| Test won't start | Tick "I own this target" checkbox |
| Port 9150 vs 9151 | 9150 = SOCKS proxy, 9151 = Tor control (auto-detects) |

---

## ⚖️ Legal Checklist

- [ ] Target is **my infrastructure** (staging/pre-prod)
- [ ] **Written approval** from infrastructure owner
- [ ] **Maintenance window** scheduled
- [ ] **Rollback plan** documented
- [ ] **Monitoring** active during test
- [ ] **Emergency stop** tested (Esc key / Stop button)

---

## 📁 Key Files

| File | Purpose |
|------|---------|
| `start.bat` | **Double-click to start** (Windows) |
| `server.js` | Main server + dashboard |
| `lib/engine.js` | Load engine core (auto-rotation) |
| `lib/metrics.js` | Metrics collection |
| `lib/safety.js` | Target validation |
| `lib/verdict.js` | Pass/fail logic |
| `public/app.js` | Dashboard UI |
| `anon-launcher.bat` | Windows CLI launcher |
| `anon-launcher.js` | Node.js launcher (recommended) |
| `anon-launcher.sh` | Linux/macOS launcher |
| `COMPLETE_GUIDE.md` | Full tutorial |
| `ANONYMITY_SETUP.md` | Tor + proxy guide |

---

## 🔑 Environment Variables

```bash
PORT=8787              # Server port (default 8787)
HOST=127.0.0.1         # Bind address (default localhost)
USE_TLS=1              # Enable HTTPS
TLS_KEY_FILE=./tls/key.pem
TLS_CERT_FILE=./tls/cert.pem
OPEN_BROWSER=1         # Auto-open dashboard
```

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **Esc** | Emergency stop (during test) |
| **Enter** | Start test (when focused on URL) |

---

*Keep this card handy. Full guide: `COMPLETE_GUIDE.md`*
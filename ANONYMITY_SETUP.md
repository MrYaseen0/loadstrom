# Strom Fire True Anonymity Setup Guide (Windows/Linux/macOS)

## Quick Start (Windows)

### 1. Install Prerequisites

**Option A: Chocolatey (recommended)**
```powershell
# Run as Administrator
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

choco install nodejs-lts tor -y
refreshenv
```

**Option B: Manual**
- Node.js LTS: https://nodejs.org/
- Tor Expert Bundle: https://www.torproject.org/download/tor/ (extract to `C:\Tools\tor`)

---

### 2. Configure Tor as Windows Service

```powershell
# Run as Administrator
# Create torrc config
$torrc = @"
SocksPort 9050
ControlPort 9051
CookieAuthentication 1
Log notice file C:\Tools\tor\tor.log
RunAsDaemon 1
"@
$torrc | Out-File -Encoding utf8 "C:\Tools\tor\torrc"

# Install as service
C:\Tools\tor\tor.exe --service install -options -f "C:\Tools\tor\torrc"
Start-Service tor
```

**Verify:**
```powershell
curl --socks5 127.0.0.1:9050 https://check.torproject.org/api/ip
# Should show Tor exit node IP
```

---

### 3. Deploy Strom Fire

```powershell
# Clone or copy the app folder to your laptop
# Example: C:\StromFire (any folder works)
cd C:\StromFire

# Install dependencies (none needed - zero deps!)
# Just verify Node works
node --version
```

---

### 4. Run Strom Fire with Anonymity Profile

**Create `anon-config.json`:**
```json
{
  "url": "https://YOUR-STAGING-TARGET.com",
  "mode": "load",
  "concurrency": 50,
  "durationSec": 0,
  "rampUpSec": 10,
  "proxy": "socks5://127.0.0.1:9150",
  "headerProfile": "desktop-chrome",
  "rotateHeaders": true,
  "requestJitterMs": 25,
  "isolateCookies": true,
  "simulateUserSession": false,
  "httpVersion": "1.1",
  "trackPhases": true,
  "pacing": "standard",
  "timeoutMs": 30000,
  "tlsVerify": true,
  "followRedirects": true,
  "maxRedirects": 5,
  "autoRotate": true,
  "torControlPort": 9151,
  "blockThresholdPct": 70,
  "abortOnErrorRatePct": 50,
  "thresholds": {
    "maxErrorRatePct": 5,
    "maxP95Ms": 2000,
    "minRps": 0
  },
  "confirm": true
}
```

**Key Settings:**
- `durationSec: 0` = **Unlimited** (runs until you click Stop)
- `autoRotate: true` = Auto-rotate IP when blocked
- `torControlPort: 9151` = Tor Browser control port
- `blockThresholdPct: 70` = Trigger rotation at 70% errors
- `abortOnErrorRatePct: 50` = Backstop: rotation handles transient blocks, but a dead proxy/path stops the run instead of piling up failures (do not use 0 — it disables the safety valve entirely)

**Run via CLI:**
```powershell
# Terminal 1: Start Strom Fire dashboard
# (ENABLE_EVASION=1 allows Tor NEWNYM rotation)
$env:ENABLE_EVASION = '1'
node server.js

# Terminal 2: Run anonymous test
$cfg = Get-Content anon-config.json -Raw
Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:8787/api/start" -Body $cfg -ContentType "application/json"

# Or use the Node.js launcher
node anon-launcher.js "https://YOUR-TARGET.com" 50 0
```

---

## Quick Start (Linux/macOS)

### 1. One-Line Install
```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y nodejs tor curl jq

# macOS
brew install node tor jq

# Arch
sudo pacman -S nodejs tor jq
```

### 2. Configure Tor
```bash
# Enable and start Tor service
sudo systemctl enable --now tor      # Linux
brew services start tor              # macOS

# Verify
curl --socks5 127.0.0.1:9050 https://check.torproject.org/api/ip
```

### 3. Deploy & Run
```bash
cd /path/to/loadstorm
node server.js &

# Run anonymous test
cat > anon-config.json <<'EOF'
{
  "url": "https://YOUR-STAGING-TARGET.com",
  "mode": "load",
  "concurrency": 50,
  "durationSec": 60,
  "proxy": "socks5://127.0.0.1:9050",
  "headerProfile": "desktop-firefox",
  "rotateHeaders": true,
  "requestJitterMs": 25,
  "httpVersion": "1.1",
  "trackPhases": true,
  "timeoutMs": 30000,
  "autoRotate": true,
  "torControlPort": 9051,
  "blockThresholdPct": 70,
  "abortOnErrorRatePct": 50,
  "confirm": true
}
EOF

curl -X POST http://127.0.0.1:8787/api/start \
  -H "Content-Type: application/json" \
  -d @anon-config.json
```

---

## Complete Anonymity Checklist

| Layer | Setting | Verify |
|-------|---------|--------|
| **Network** | Tor running on 9050 | `curl --socks5 127.0.0.1:9050 https://ifconfig.me` |
| **Proxy** | `socks5://127.0.0.1:9050` in config | Check Strom Fire logs show proxy connection |
| **Headers** | `headerProfile: "desktop-chrome"` | Rotate headers = ON |
| **Timing** | `requestJitterMs: 25` (small jitter only — large jitter + think-time queue Tor runs) | Requests not in perfect intervals |
| **TLS** | `tlsVerify: true` | Target has valid cert |
| **HTTP** | `httpVersion: "1.1"` | HTTP/2 over Tor is unstable |
| **Target** | Your staging/test env only | Legal authorization confirmed |

---

## Automated Startup Script (Windows)

Save as `start-anon-loadstorm.ps1`:
```powershell
<# 
.SYNOPSIS
    Starts Tor + Strom Fire with full anonymity config
#>

param(
    [string]$TargetUrl = "https://your-staging.example.com",
    [int]$Concurrency = 50,
    [int]$DurationSec = 60,
    [string]$Profile = "desktop-chrome",
    [int]$JitterMs = 25
)

Write-Host "🔐 Starting Anonymous Strom Fire Setup..." -ForegroundColor Cyan

# 1. Ensure Tor is running
$torStatus = Get-Service tor -ErrorAction SilentlyContinue
if (-not $torStatus -or $torStatus.Status -ne 'Running') {
    Write-Host "Starting Tor service..." -ForegroundColor Yellow
    Start-Service tor -ErrorAction Stop
    Start-Sleep 3
}

# 2. Verify Tor circuit
$torIp = curl --socks5 127.0.0.1:9050 https://ifconfig.me 2>$null
Write-Host "Tor Exit IP: $torIp" -ForegroundColor Green

# 3. Start Strom Fire dashboard
# (ENABLE_EVASION=1 allows Tor NEWNYM rotation; without it every rotation
# fails with "Tor rotation disabled")
Write-Host "Starting Strom Fire on http://127.0.0.1:8787" -ForegroundColor Cyan
$env:ENABLE_EVASION = '1'
$ls = Start-Process node -ArgumentList "server.js" -WorkingDirectory (Get-Location) -PassThru

# 4. Wait for server
Start-Sleep 2

# 5. Build config
$cfg = @{
    url = $TargetUrl
    mode = "load"
    concurrency = $Concurrency
    durationSec = $DurationSec
    rampUpSec = 10
    proxy = "socks5://127.0.0.1:9050"
    headerProfile = $Profile
    rotateHeaders = $true
    requestJitterMs = $JitterMs
    httpVersion = "1.1"
    trackPhases = $true
    pacing = "standard"
    timeoutMs = 30000
    tlsVerify = $true
    confirm = $true
    autoRotate = $true
    torControlPort = 9051
    blockThresholdPct = 70
    abortOnErrorRatePct = 50
    thresholds = @{
        maxErrorRatePct = 5
        maxP95Ms = 2000
        minRps = 0
    }
} | ConvertTo-Json -Depth 5

# 6. Sign in when the server requires it (no-op when auth is off)
$session = $null
$authState = Invoke-RestMethod "http://127.0.0.1:8787/api/auth-status"
if ($authState.authEnabled -and -not $authState.authed) {
    $loginUser = if ($env:STROMFIRE_USER) { $env:STROMFIRE_USER } else { 'admin' }
    $loginBody = @{ username = $loginUser; password = $env:STROMFIRE_PASSWORD } | ConvertTo-Json
    Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:8787/api/login" -Body $loginBody -ContentType "application/json" -SessionVariable session | Out-Null
    Write-Host "Signed in as $loginUser." -ForegroundColor Green
}

# 7. Start test
Write-Host "Starting anonymous load test..." -ForegroundColor Green
$response = Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:8787/api/start" -Body $cfg -ContentType "application/json" -WebSession $session
Write-Host "Test started: $($response.target) [$($response.mode)]" -ForegroundColor Green

# 8. Poll for completion
do {
    Start-Sleep 3
    $status = Invoke-RestMethod "http://127.0.0.1:8787/api/status" -WebSession $session
    $rps = if ($status.rps) { $status.rps } else { $status.attemptedRps }
    Write-Host "State: $($status.engineState) | RPS: $([math]::Round($rps,1)) | Users: $($status.activeWorkers)"
} until ($status.engineState -in @('finished','error','stopping'))

# 9. Get report
$report = Invoke-RestMethod "http://127.0.0.1:8787/api/report" -WebSession $session
$report.report | ConvertTo-Json -Depth 5 | Out-File "anon-report-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
Write-Host "Report saved!" -ForegroundColor Cyan

# 10. Cleanup
Stop-Process $ls.Id -Force
Write-Host "Done." -ForegroundColor Cyan
```

**Run:**
```powershell
.\start-anon-loadstorm.ps1 -TargetUrl "https://your-staging.example.com" -Concurrency 100 -DurationSec 120
```

---

## Automated Startup Script (Linux/macOS)

Save as `start-anon-loadstorm.sh`:
```bash
#!/bin/bash
set -euo pipefail

TARGET_URL="${1:-https://your-staging.example.com}"
CONCURRENCY="${2:-50}"
DURATION="${3:-60}"
PROFILE="${4:-desktop-firefox}"
JITTER="${5:-25}"

echo "🔐 Starting Anonymous Strom Fire Setup..."

# 1. Ensure Tor is running
if ! systemctl is-active --quiet tor 2>/dev/null; then
    echo "Starting Tor..."
    sudo systemctl start tor
    sleep 3
fi

# 2. Verify Tor circuit
TOR_IP=$(curl --socks5 127.0.0.1:9050 -s https://ifconfig.me || true)
echo "Tor Exit IP: $TOR_IP"

# 3. Start Strom Fire (ENABLE_EVASION=1 allows Tor NEWNYM rotation;
# without it every rotation fails with "Tor rotation disabled")
echo "Starting Strom Fire on http://127.0.0.1:8787"
ENABLE_EVASION=1 node server.js &
LS_PID=$!
sleep 2
COOKIE_JAR="$(mktemp)"
trap "rm -f $COOKIE_JAR; kill $LS_PID 2>/dev/null; echo 'Stopped Strom Fire'; exit" INT TERM EXIT

# 3b. Sign in when the server requires it (no-op when auth is off)
if curl -s http://127.0.0.1:8787/api/auth-status | jq -e '.authEnabled == true and .authed == false' >/dev/null 2>&1; then
    echo "Signing in..."
    curl -s -c "$COOKIE_JAR" -X POST http://127.0.0.1:8787/api/login \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"${STROMFIRE_USER:-admin}\",\"password\":\"${STROMFIRE_PASSWORD:-}\"}" > /dev/null
fi

# 4. Build config
CFG=$(cat <<EOF
{
  "url": "$TARGET_URL",
  "mode": "load",
  "concurrency": $CONCURRENCY,
  "durationSec": $DURATION,
  "rampUpSec": 10,
  "proxy": "socks5://127.0.0.1:9050",
  "headerProfile": "$PROFILE",
  "rotateHeaders": true,
  "requestJitterMs": $JITTER,
  "httpVersion": "1.1",
  "trackPhases": true,
  "pacing": "standard",
  "timeoutMs": 30000,
  "tlsVerify": true,
  "confirm": true,
  "autoRotate": true,
  "torControlPort": 9051,
  "blockThresholdPct": 70,
  "abortOnErrorRatePct": 50,
  "thresholds": {
    "maxErrorRatePct": 5,
    "maxP95Ms": 2000,
    "minRps": 0
  }
}
EOF
)

# 5. Start test
echo "Starting anonymous load test..."
RESPONSE=$(curl -s -b "$COOKIE_JAR" -X POST http://127.0.0.1:8787/api/start \
    -H "Content-Type: application/json" \
    -d "$CFG")
echo "Test started: $(echo "$RESPONSE" | jq -r '.target') [$(echo "$RESPONSE" | jq -r '.mode')]"

# 6. Poll for completion
while true; do
    sleep 3
    STATUS=$(curl -s -b "$COOKIE_JAR" http://127.0.0.1:8787/api/status)
    STATE=$(echo "$STATUS" | jq -r '.engineState')
    RPS=$(echo "$STATUS" | jq -r '.rps // .attemptedRps // 0')
    USERS=$(echo "$STATUS" | jq -r '.activeWorkers // 0')
    echo "State: $STATE | RPS: $RPS | Users: $USERS"
    [[ "$STATE" =~ ^(finished|error|stopping)$ ]] && break
done

# 7. Get report
REPORT=$(curl -s -b "$COOKIE_JAR" http://127.0.0.1:8787/api/report)
echo "$REPORT" | jq '.report' > "anon-report-$(date +%Y%m%d-%H%M%S).json"
echo "Report saved!"

# 8. Cleanup
kill $LS_PID 2>/dev/null
echo "Done."
```

**Run:**
```bash
chmod +x start-anon-loadstorm.sh
./start-anon-loadstorm.sh "https://your-staging.example.com" 100 120 desktop-chrome 25
```

---

## Dashboard Manual Config (No Script)

1. Open `http://127.0.0.1:8787/`
2. Paste your target URL
3. Click **"Anonymity & Proxy"** section (▼)
4. Fill:
   - **Proxy URL**: `socks5://127.0.0.1:9050`
   - **Header Profile**: Desktop Chrome / Firefox / Safari
   - **Rotate Headers**: ☑️
   - **Request Jitter**: `25` ms (small jitter only — large values queue Tor runs)
5. Advanced → HTTP Version: **HTTP/1.1**
6. Tick **"I own this target"**
7. Press **▶ Start test**

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `ECONNREFUSED 127.0.0.1:9050` | Tor not running. Start service. |
| `Proxy CONNECT failed: 403` | Proxy auth needed. Use `socks5://user:pass@host:port` |
| `Certificate verify failed` | Target has self-signed cert. Uncheck TLS Verify (testing only). |
| `HTTP/2 hang` | Use HTTP/1.1 over Tor. |
| `Low RPS` | Tor adds latency. Increase `timeoutMs` to 60000. |

---

## Legal Reminder

> **Only test systems you own or have explicit written permission to test.**
> Unauthorized load testing is illegal (CFAA, GDPR, etc.) and unethical.
> This guide is for authorized security/performance testing of your own infrastructure.
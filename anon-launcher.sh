#!/bin/bash
# ============================================================
# Strom Fire Anonymous Launcher (Linux/macOS)
# ============================================================
# Usage: ./anon-launcher.sh "https://your-target.com" [concurrency] [duration_sec] [profile] [jitter_ms]
# Example: ./anon-launcher.sh "https://staging.example.com" 100 0 desktop-firefox 300
# Duration 0 = unlimited (runs until stopped)
# ============================================================

set -euo pipefail

# Check for jq
if ! command -v jq &> /dev/null; then
    echo "ERROR: jq is required but not installed."
    echo "Install: sudo apt install jq  OR  brew install jq"
    exit 1
fi

TARGET_URL="${1:-}"
CONCURRENCY="${2:-50}"
DURATION="${3:-0}"
PROFILE="${4:-desktop-chrome}"
JITTER="${5:-25}"

if [[ -z "$TARGET_URL" ]]; then
    echo "Usage: $0 \"https://your-target.com\" [concurrency] [duration_sec] [profile] [jitter_ms]"
    echo "Duration 0 = unlimited (runs until stopped)"
    exit 1
fi

echo "============================================================"
echo "  Strom Fire Anonymous Launcher"
echo "============================================================"
echo "Target:      $TARGET_URL"
echo "Concurrency: $CONCURRENCY"
if [[ "$DURATION" == "0" ]]; then
    echo "Duration:    UNLIMITED (stops when you press Ctrl+C)"
else
    echo "Duration:    $DURATION sec"
fi
echo "Profile:     $PROFILE"
echo "Jitter:      $JITTER ms"
echo "Proxy:       socks5://127.0.0.1:9150 or :9050 (Tor, auto-detected)"
echo "============================================================"
echo

# 1. Check Tor (Tor Browser = 9150/9151, system tor = 9050/9051)
echo "[1/6] Checking Tor service..."
if command -v systemctl >/dev/null 2>&1; then
    if ! systemctl is-active --quiet tor; then
        echo "Starting Tor service..."
        sudo systemctl start tor
        sleep 3
    fi
elif command -v brew >/dev/null 2>&1; then
    if ! brew services list | grep -q "tor.*started"; then
        echo "Starting Tor service..."
        brew services start tor
        sleep 3
    fi
else
    echo "Warning: Could not detect service manager. Ensure Tor is running on 9150 or 9050."
fi

# 2. Verify Tor circuit (prefer Tor Browser 9150, fall back to system tor 9050)
echo "[2/6] Verifying Tor circuit..."
TOR_SOCKS=9150
TOR_CTRL=9151
if ! TOR_IP=$(curl --socks5 127.0.0.1:9150 -s https://ifconfig.me --max-time 10); then
    TOR_IP=""
fi
if [[ -z "$TOR_IP" ]]; then
    # '|| true': with 'set -e' an unguarded failing curl would exit here
    # before the empty-check below can print the friendly error.
    TOR_IP=$(curl --socks5 127.0.0.1:9050 -s https://ifconfig.me --max-time 10 || true)
    if [[ -n "$TOR_IP" ]]; then
        TOR_SOCKS=9050
        TOR_CTRL=9051
    fi
fi
if [[ -z "$TOR_IP" ]]; then
    echo "ERROR: Tor not responding on 127.0.0.1:9150 or 127.0.0.1:9050"
    exit 1
fi
echo "Tor Exit IP: $TOR_IP (socks $TOR_SOCKS, control $TOR_CTRL)"
# Verify the derived control port answers as Tor control; mixed-pair hosts
# (e.g. SOCKS 9050 + control 9151) fall back to whichever answers.
if [[ "$TOR_CTRL" == "9051" ]]; then TOR_ALT=9151; else TOR_ALT=9051; fi
# '|| echo': with 'set -e' a failing node call must not exit before the
# empty-check below can restore the derived port.
CHOSEN_CTRL=$(node check-tor-control.js "$TOR_CTRL" "$TOR_ALT" 2>/dev/null || echo "$TOR_CTRL")
if [[ -z "$CHOSEN_CTRL" ]]; then CHOSEN_CTRL="$TOR_CTRL"; fi
if [[ "$CHOSEN_CTRL" != "$TOR_CTRL" ]]; then
    echo "NOTE: control $TOR_CTRL refused, but $CHOSEN_CTRL answers - using $CHOSEN_CTRL (mixed Tor pair)."
fi
TOR_CTRL="$CHOSEN_CTRL"
if [[ "$CONCURRENCY" -gt 20 ]]; then
    echo "WARNING: concurrency $CONCURRENCY is far past what one Tor circuit handles (~20). Expect queueing/timeouts. Use 20 or less for Tor runs."
fi

# 3. Start Strom Fire (ENABLE_EVASION=1 allows Tor NEWNYM rotation;
# without it every rotation fails with "Tor rotation disabled")
echo "[3/6] Starting Strom Fire dashboard..."
ENABLE_EVASION=1 node server.js &
LS_PID=$!
sleep 2

# Cleanup on exit
COOKIE_JAR="$(mktemp)"
trap "rm -f $COOKIE_JAR; kill $LS_PID 2>/dev/null; echo 'Stopped Strom Fire'; exit" INT TERM EXIT

# 3b. Sign in when the server requires it (no-op when auth is off)
if curl -s http://127.0.0.1:8787/api/auth-status | jq -e '.authEnabled == true and .authed == false' >/dev/null 2>&1; then
    echo "Signing in..."
    curl -s -c "$COOKIE_JAR" -X POST http://127.0.0.1:8787/api/login \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"${STROMFIRE_USER:-admin}\",\"password\":\"${STROMFIRE_PASSWORD:-}\"}" > /dev/null
fi

# 4. Build JSON config
CFG=$(cat <<EOF
{
  "url": "$TARGET_URL",
  "mode": "load",
  "concurrency": $CONCURRENCY,
  "durationSec": $DURATION,
  "rampUpSec": 10,
  "proxy": "socks5://127.0.0.1:$TOR_SOCKS",
  "headerProfile": "$PROFILE",
  "rotateHeaders": true,
  "requestJitterMs": $JITTER,
  "isolateCookies": true,
  "simulateUserSession": false,
  "httpVersion": "1.1",
  "trackPhases": true,
  "pacing": "standard",
  "timeoutMs": 30000,
  "tlsVerify": true,
  "confirm": true,
  "autoRotate": true,
  "torControlPort": $TOR_CTRL,
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
echo "[4/6] Starting anonymous load test..."
RESPONSE=$(curl -s -b "$COOKIE_JAR" -X POST http://127.0.0.1:8787/api/start \
    -H "Content-Type: application/json" \
    -d "$CFG")
echo "Test started: $(echo "$RESPONSE" | jq -r '.target // "unknown"') [$(echo "$RESPONSE" | jq -r '.mode // "unknown"')]"

# 6. Poll for completion
echo "[5/6] Running test..."
while true; do
    sleep 3
    STATUS=$(curl -s -b "$COOKIE_JAR" http://127.0.0.1:8787/api/status)
    STATE=$(echo "$STATUS" | jq -r '.engineState // "unknown"')
    RPS=$(echo "$STATUS" | jq -r '.rps // .attemptedRps // 0')
    USERS=$(echo "$STATUS" | jq -r '.activeWorkers // 0')
    echo "State: $STATE | RPS: $RPS | Users: $USERS"
    [[ "$STATE" =~ ^(finished|error|stopping)$ ]] && break
done

# 7. Get report
echo "[6/6] Fetching report..."
REPORT=$(curl -s -b "$COOKIE_JAR" http://127.0.0.1:8787/api/report)
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
echo "$REPORT" | jq '.report' > "anon-report-$TIMESTAMP.json"
echo "Report saved: anon-report-$TIMESTAMP.json"
echo "$REPORT" | jq -r '.report.result.headline // empty'
echo "$REPORT" | jq -r '.report.result.reasons[]? // empty' | sed 's/^/  - /'
echo "$REPORT" | jq -r '.report.result.recommendations[]? // empty' | sed 's/^/  - /'

# Cleanup handled by trap
echo
echo "============================================================"
echo "  Anonymous test complete!"
echo "============================================================"
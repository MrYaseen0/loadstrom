#!/usr/bin/env bash
# Strom Fire launcher (macOS / Linux)
# Usage:   chmod +x run.sh && ./run.sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is required. Install it free (LTS) from https://nodejs.org"
  echo ""
  exit 1
fi

export PORT="${PORT:-8787}"
export OPEN_BROWSER=1

echo ""
echo "  Starting Strom Fire on http://127.0.0.1:${PORT}/"
echo "  Press Ctrl+C to stop."
echo ""

exec node server.js

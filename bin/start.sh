#!/bin/sh
# start.sh — All-in-one launcher for OpenCode Zen Proxy system.
#
# Launches both Xray (127.0.0.1:10901) and zen-relay (127.0.0.1:10900)
# with a single command. Pressing Ctrl+C stops both cleanly.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ZEN_DIR="$HOME/.config/zen-proxy"
LOG_DIR="$ZEN_DIR/logs"
mkdir -p "$LOG_DIR"

cleanup() {
  echo ""
  echo "Shutting down OpenCode Zen Proxy system..."
  if [ -n "${XPID:-}" ]; then
    kill "$XPID" 2>/dev/null || true
  fi
  fuser -k -9 10900/tcp 2>/dev/null || true
  fuser -k -9 10901/tcp 2>/dev/null || true
  exit 0
}

trap cleanup INT TERM EXIT

# Free ports if occupied
fuser -k -9 10900/tcp 2>/dev/null || true
fuser -k -9 10901/tcp 2>/dev/null || true
sleep 0.5

echo "=== Starting OpenCode Zen Proxy System ==="

# 1. Start Xray proxy in background
echo "[1/2] Starting Xray proxy balancer on 127.0.0.1:10901..."
"$SCRIPT_DIR/start-zen-proxy.sh" > "$LOG_DIR/xray.log" 2>&1 &
XPID=$!

# Wait for Xray to listen
MAX_WAIT=10
WAITED=0
while ! ss -tlnp "sport = :10901" 2>/dev/null | grep -q "10901"; do
  sleep 0.5
  WAITED=$((WAITED + 1))
  if [ "$WAITED" -ge "$((MAX_WAIT * 2))" ]; then
    echo "Error: Xray failed to start on 127.0.0.1:10901. Check log: $LOG_DIR/xray.log" >&2
    exit 1
  fi
done
echo "      Xray is listening on 127.0.0.1:10901 (PID $XPID)"

# 2. Start zen-relay
echo "[2/2] Starting zen-relay on 127.0.0.1:10900..."
echo "      Proxy is ready! In your OpenCode window, make sure to restart service if needed:"
echo "      opencode service restart"
echo "      Press Ctrl+C to stop both proxy services."
echo "--------------------------------------------------------"

exec node "$SCRIPT_DIR/zen-relay.js"

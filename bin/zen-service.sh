#!/bin/sh
# zen-service.sh — background daemon service manager for OpenCode Zen Proxy.
#
# Commands:
#   start     Start Xray and zen-relay in background
#   stop      Stop all proxy processes and free ports
#   restart   Restart both services cleanly
#   status    Check status, listening ports, and recent logs
#   scrape    Re-scrape public nodes and restart
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ZEN_DIR="$HOME/.config/zen-proxy"
LOG_DIR="$ZEN_DIR/logs"
PID_FILE="$ZEN_DIR/zen-service.pid"
mkdir -p "$LOG_DIR"

is_listening() {
  local port="$1"
  ss -tlnp "sport = :$port" 2>/dev/null | grep -q "$port"
}

stop_services() {
  echo "Stopping OpenCode Zen Proxy system..."
  fuser -k -9 10900/tcp 2>/dev/null || true
  fuser -k -9 10901/tcp 2>/dev/null || true
  fuser -k -9 10902/tcp 2>/dev/null || true
  rm -f "$PID_FILE"
  sleep 0.5
  echo "Proxy services stopped."
}

start_services() {
  if is_listening 10900 && is_listening 10901; then
    echo "Zen Proxy is already running on 127.0.0.1:10900 and 127.0.0.1:10901."
    return 0
  fi

  # Free any stale ports
  fuser -k -9 10900/tcp 2>/dev/null || true
  fuser -k -9 10901/tcp 2>/dev/null || true
  fuser -k -9 10902/tcp 2>/dev/null || true
  sleep 0.5

  echo "Starting OpenCode Zen Proxy system in background..."

  # 1. Start Xray on 10901
  setsid "$SCRIPT_DIR/start-zen-proxy.sh" > "$LOG_DIR/xray.log" 2>&1 &
  XPID=$!

  # Wait for Xray
  WAITED=0
  while ! is_listening 10901; do
    sleep 0.5
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge 20 ]; then
      echo "Error: Xray failed to start on 10901. Check $LOG_DIR/xray.log" >&2
      exit 1
    fi
  done
  echo "  - Xray running on 127.0.0.1:10901 (PID $XPID)"

  # 2. Start zen-relay on 10900
  setsid node "$SCRIPT_DIR/zen-relay.js" > "$LOG_DIR/relay.log" 2>&1 &
  RPID=$!

  WAITED=0
  while ! is_listening 10900; do
    sleep 0.5
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge 20 ]; then
      echo "Error: zen-relay failed to start on 10900. Check $LOG_DIR/relay.log" >&2
      exit 1
    fi
  done
  echo "  - zen-relay running on 127.0.0.1:10900 (PID $RPID)"

  echo "$XPID $RPID" > "$PID_FILE"
  echo "OpenCode Zen Proxy is ready!"
  echo "Logs: $LOG_DIR/relay.log, $LOG_DIR/xray.log"
}

status_services() {
  echo "=== OpenCode Zen Proxy Status ==="
  if is_listening 10900; then
    echo "zen-relay: RUNNING on 127.0.0.1:10900"
  else
    echo "zen-relay: STOPPED (port 10900 not listening)"
  fi

  if is_listening 10901; then
    echo "xray:      RUNNING on 127.0.0.1:10901"
  else
    echo "xray:      STOPPED (port 10901 not listening)"
  fi

  echo ""
  echo "Recent zen-relay logs:"
  if [ -f "$LOG_DIR/relay.log" ]; then
    tail -n 10 "$LOG_DIR/relay.log"
  else
    echo "(No logs yet)"
  fi
}

scrape_proxies() {
  echo "Re-scraping live public proxies and validating Zen free quota..."
  node "$SCRIPT_DIR/zen-scrape.js" --zen-check 60 --limit 150 --concurrency 20 --output "$ZEN_DIR/zen.json"
  echo "Restarting services with fresh proxy pool..."
  stop_services
  start_services
}

case "${1:-status}" in
  start)
    start_services
    ;;
  stop)
    stop_services
    ;;
  restart)
    stop_services
    start_services
    ;;
  status)
    status_services
    ;;
  scrape)
    scrape_proxies
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|scrape}"
    exit 1
    ;;
esac

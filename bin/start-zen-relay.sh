#!/bin/sh
# start-zen-relay.sh — run the transparent relay that rotates proxy tunnels.
#
#   OpenCode --HTTPS_PROXY--> 127.0.0.1:10900 (relay) --> 127.0.0.1:10901 (xray)
#
# Rotation matters: the proxy picks an exit once per tunnel, and a tunnel pinned
# to a spent exit makes every request 429 until it is dropped.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${ZEN_RELAY_PORT:-10900}"

# If port is already in use, kill the old process
P=$(ss -tlnp "sport = :$PORT" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
if [ -n "$P" ]; then
  echo "killing previous zen-relay process (PID $P)..."
  kill "$P" 2>/dev/null || true
  sleep 1
fi

exec node "$SCRIPT_DIR/zen-relay.js"

#!/bin/sh
# start-zen-relay.sh — run the transparent relay that rotates proxy tunnels.
#
#   OpenCode --HTTPS_PROXY--> 127.0.0.1:10900 (relay) --> 127.0.0.1:10901 (xray)
#
# Rotation matters: the proxy picks an exit once per tunnel, and a tunnel pinned
# to a spent exit makes every request 429 until it is dropped.
set -eu
fuser -k -9 "${ZEN_RELAY_PORT:-10900}/tcp" 2>/dev/null || true
fuser -k -9 "${ZEN_RELAY_CONTROL_PORT:-10902}/tcp" 2>/dev/null || true
sleep 0.5
exec node "$(dirname "$0")/zen-relay.js"

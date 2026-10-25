#!/bin/sh
# start-zen-relay.sh — run the transparent relay that rotates proxy tunnels.
#
#   OpenCode --HTTPS_PROXY--> 127.0.0.1:10900 (relay) --> 127.0.0.1:10901 (xray)
#
# Rotation matters: the proxy picks an exit once per tunnel, and a tunnel pinned
# to a spent exit makes every request 429 until it is dropped.
set -eu
exec node "$(dirname "$0")/zen-relay.js"

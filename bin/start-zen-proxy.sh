#!/bin/sh
# start-zen-proxy.sh — run a dedicated Xray instance that serves an HTTP+SOCKS
# proxy for OpenCode Zen traffic (default 127.0.0.1:10901).
#
#   ZEN_PROXY_CONFIG=~/.config/zen-proxy/zen.json ./start-zen-proxy.sh
#
# The config's local inbound port is rewritten to ZEN_PROXY_PORT, so the same
# config can be launched anywhere. The instance's DNS inbound, if present, is
# moved to port+53.
#
# Environment:
#   ZEN_PROXY_PORT       listen port (default 10901)
#   ZEN_PROXY_CONFIG     Xray config to run (default ~/.config/zen-proxy/zen.json)
#   XRAY                 xray binary (default: xray on PATH)
#   XRAY_LOCATION_ASSET  dir containing geoip.dat/geosite.dat (needed by configs
#                        that use geosite:/geoip: routing rules)
set -eu

XRAY="${XRAY:-xray}"
CONFIG="${ZEN_PROXY_CONFIG:-$HOME/.config/zen-proxy/zen.json}"
PORT="${ZEN_PROXY_PORT:-10901}"

[ -f "$CONFIG" ] || {
  echo "no config at $CONFIG" >&2
  echo "copy config/xray-balancer.example.json there and add your servers" >&2
  exit 1
}

python3 - "$CONFIG" "$PORT" <<'EOF'
import json, sys
cfg, port = sys.argv[1], int(sys.argv[2])
c = json.load(open(cfg))
for ib in c.get("inbounds", []):
    if ib.get("protocol") in ("mixed", "socks", "http"):
        ib["port"] = port
    elif ib.get("protocol") == "dokodemo-door":
        ib["port"] = port + 53
json.dump(c, open(cfg, "w"), indent=1)
EOF

echo "zen-proxy: $CONFIG -> 127.0.0.1:$PORT"
exec "$XRAY" run -c "$CONFIG"

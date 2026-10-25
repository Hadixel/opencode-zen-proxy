#!/bin/sh
# start-zen-proxy.sh — run a dedicated Xray instance that serves an HTTP+SOCKS
# proxy for OpenCode Zen traffic (default 127.0.0.1:10901).
#
#   ZEN_PROXY_CONFIG=~/.config/zen-proxy/zen.json ./start-zen-proxy.sh
#
# Environment:
#   ZEN_PROXY_PORT       listen port (default 10901)
#   ZEN_PROXY_CONFIG     Xray config to run (default ~/.config/zen-proxy/zen.json)
#   XRAY                 xray binary (default: auto-detected)
#   XRAY_LOCATION_ASSET  dir containing geoip.dat/geosite.dat
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${ZEN_PROXY_CONFIG:-$HOME/.config/zen-proxy/zen.json}"
PORT="${ZEN_PROXY_PORT:-10901}"

# Auto-detect Xray binary
XRAY_BIN="${XRAY:-}"
if [ -z "$XRAY_BIN" ]; then
  for candidate in "xray" "$HOME/.local/share/v2rayN/bin/xray/xray" "$HOME/.local/bin/xray" "/usr/local/bin/xray" "/usr/bin/xray"; do
    if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then
      XRAY_BIN="$candidate"
      break
    fi
  done
fi

[ -n "$XRAY_BIN" ] || {
  echo "error: xray binary not found. Install xray or set XRAY=/path/to/xray" >&2
  exit 1
}

# Auto-detect location assets if not set
if [ -z "${XRAY_LOCATION_ASSET:-}" ]; then
  for asset_candidate in "$HOME/.local/share/v2rayN/bin" "/usr/local/share/xray" "/usr/share/xray"; do
    if [ -f "$asset_candidate/geosite.dat" ]; then
      export XRAY_LOCATION_ASSET="$asset_candidate"
      break
    fi
  done
fi

# Auto-scrape if config is missing
if [ ! -f "$CONFIG" ]; then
  echo "no config at $CONFIG; automatically scraping public nodes..."
  node "$SCRIPT_DIR/zen-scrape.js" --max 30 --output "$CONFIG"
fi

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

echo "zen-proxy: $CONFIG -> 127.0.0.1:$PORT using $XRAY_BIN"
exec "$XRAY_BIN" run -c "$CONFIG"

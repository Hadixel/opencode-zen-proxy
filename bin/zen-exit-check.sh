#!/bin/sh
# zen-exit-check.sh — check (and switch) which proxy exit OpenCode Zen uses.
#
#   zen-exit-check.sh                          probe the configured proxy
#   zen-exit-check.sh --proxy http://host:port probe a specific proxy
#   zen-exit-check.sh --sweep <dir>            test every Xray config in a dir
#   zen-exit-check.sh --use <config.json>      switch the dedicated proxy
#
# Free-tier allowance is tied to the EXIT IP, and shared/datacenter exits are
# often spent. A single run tells you whether the exit you're using can serve
# free models right now (it prints OK or the gateway's error).
#
# Environment:
#   ZEN_PROXY_PORT     port of the dedicated proxy (default 10900)
#   ZEN_PROXY_CONFIG   config used by --use / start (default ~/.config/zen-proxy/zen.json)
#   XRAY               xray binary (default: xray on PATH)
#   XRAY_LOCATION_ASSET  dir with geoip.dat/geosite.dat if needed
set -eu

ZEN_PORT="${ZEN_PROXY_PORT:-10900}"
ZEN_CFG="${ZEN_PROXY_CONFIG:-$HOME/.config/zen-proxy/zen.json}"
if [ -z "${XRAY:-}" ]; then
  if command -v xray >/dev/null 2>&1; then
    XRAY_BIN=xray
  elif [ -x "$HOME/.local/bin/xray" ]; then
    XRAY_BIN="$HOME/.local/bin/xray"
  elif [ -x "$HOME/.local/share/v2rayN/bin/xray/xray" ]; then
    XRAY_BIN="$HOME/.local/share/v2rayN/bin/xray/xray"
  else
    XRAY_BIN=xray
  fi
else
  XRAY_BIN="$XRAY"
fi
PROXY="http://127.0.0.1:$ZEN_PORT"

exit_ip() {
  curl -s --max-time 15 -x "$1" https://api.ipify.org 2>/dev/null || echo "unreachable"
}

probe() {
  env HTTPS_PROXY="$1" HTTP_PROXY="$1" NO_PROXY=localhost,127.0.0.1,::1 \
    timeout 60 opencode run --standalone --model opencode/big-pickle "say OK" 2>&1 \
    | tail -1 | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-60
}

case "${1:-}" in
  --sweep)
    DIR="${2:?usage: zen-exit-check.sh --sweep <dir-of-xray-configs>}"
    SPARE_PORT=$((ZEN_PORT + 1))
    export XRAY_LOCATION_ASSET="${XRAY_LOCATION_ASSET:-}"
    for cfg in "$DIR"/*.json; do
      [ -f "$cfg" ] || continue
      remark=$(python3 -c "import json,sys
try: print(json.load(open(sys.argv[1])).get('remarks','?')[:30])
except: print('?')" "$cfg" 2>/dev/null)
      python3 - "$cfg" "$SPARE_PORT" <<'PYEOF'
import json, sys
c = json.load(open(sys.argv[1]))
port = int(sys.argv[2])
for ib in c.get("inbounds", []):
    if ib.get("protocol") in ("mixed", "socks", "http"):
        ib["port"] = port
    elif ib.get("protocol") == "dokodemo-door":
        ib["port"] = port + 53
json.dump(c, open("/tmp/zen-sweep.json", "w"))
PYEOF
      "$XRAY_BIN" run -c /tmp/zen-sweep.json >/dev/null 2>&1 &
      XPID=$!; sleep 4
      ip=$(exit_ip "http://127.0.0.1:$SPARE_PORT")
      if [ "$ip" = "unreachable" ]; then
        printf "%-34s %s\n" "$remark" "SKIP (xray failed)"
      else
        # One config = one exit; retrying it through the plugin only wastes quota.
        res=$(ZEN_RETRY_DISABLE=1 probe "http://127.0.0.1:$SPARE_PORT")
        printf "%-34s exit=%-18s zen=%s\n" "$remark" "$ip" "$(echo "$res" | cut -c1-20)"
      fi
      kill "$XPID" 2>/dev/null; sleep 1
    done
    rm -f /tmp/zen-sweep.json
    ;;

  --use)
    SRC="${2:?usage: zen-exit-check.sh --use <config.json-or-profile-id>}"
    if [ -f "$SRC" ]; then
      cp "$SRC" "$ZEN_CFG"
    else
      F=$(ls "$HOME/.local/share/v2rayN/guiConfigs/${SRC}"*.json 2>/dev/null | head -1)
      [ -n "$F" ] || { echo "not found: $SRC" >&2; exit 1; }
      python3 - "$F" "$ZEN_CFG" <<'PYEOF'
import json, sys
c = json.load(open(sys.argv[1]))
for ib in c.get("inbounds", []):
    if ib.get("protocol") in ("mixed", "socks", "http"):
        ib["port"] = int(sys.argv[3]) if len(sys.argv) > 3 else 10901
    elif ib.get("protocol") == "dokodemo-door":
        ib["port"] = (int(sys.argv[3]) if len(sys.argv) > 3 else 10901) + 53
json.dump(c, open(sys.argv[2], "w"), indent=1)
PYEOF
    fi
    P=$(ss -tlnp 2>/dev/null | sed -n "s/.*127.0.0.1:${ZEN_PORT} .*pid=\([0-9]*\).*/\1/p" | head -1)
    [ -n "$P" ] && kill "$P" 2>/dev/null; sleep 2
    setsid nohup "$HOME/.local/bin/start-zen-proxy.sh" >/dev/null 2>&1 &
    sleep 4
    echo "switched to: $(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('remarks','?'))" "$ZEN_CFG" 2>/dev/null || echo '?')"
    echo "exit: $(exit_ip "$PROXY")"
    echo "zen:  $(probe "$PROXY")"
    ;;

  --proxy)
    PROXY="${2:?usage: zen-exit-check.sh --proxy <url>}"
    echo "exit: $(exit_ip "$PROXY")"
    echo "zen:  $(probe "$PROXY")"
    ;;

  *)
    echo "exit: $(exit_ip "$PROXY")"
    echo "zen:  $(probe "$PROXY")"
    echo
    echo "if it says 'Free usage limit reached', the exit IP is spent; try"
    echo "  zen-exit-check.sh --sweep <dir-of-xray-configs>"
    ;;
esac

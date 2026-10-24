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
#   XRAY_LOCATION_ASSET  dir with geoip.dat/geosite.dat if your config needs them
set -eu

MODEL="${ZEN_MODEL:-opencode/big-pickle}"
PROXY="${HTTPS_PROXY:-http://127.0.0.1:${ZEN_PROXY_PORT:-10900}}"
ZEN_PORT="${ZEN_PROXY_PORT:-10900}"
SWEEP_PORT=$((ZEN_PORT + 1))
ZEN_CFG="${ZEN_PROXY_CONFIG:-$HOME/.config/zen-proxy/zen.json}"
XRAY="${XRAY:-xray}"
WORK="${TMPDIR:-/tmp}/zen-exit-check"
PROBE_DATA="$WORK/oc-profile"
DIRECT_CFG="$WORK/direct.json"

command -v opencode >/dev/null 2>&1 || PATH="$HOME/.opencode/bin:$PATH"
export PATH
mkdir -p "$WORK"

# Provider config pinning the real origin, so the proxy env is what's exercised.
if [ ! -f "$DIRECT_CFG" ]; then
  cat > "$DIRECT_CFG" <<'EOF'
{ "provider": { "opencode": { "options": { "baseURL": "https://opencode.ai/inference/openai/v1" } } } }
EOF
fi

probe() { # $1 = proxy URL
  env XDG_DATA_HOME="$PROBE_DATA/data" XDG_STATE_HOME="$PROBE_DATA/state" \
      XDG_CACHE_HOME="$PROBE_DATA/cache" \
      HTTPS_PROXY="$1" HTTP_PROXY="$1" \
      NO_PROXY="localhost,127.0.0.1,::1" \
      OPENCODE_CONFIG="$DIRECT_CFG" \
      timeout 180 opencode run --standalone --model "$MODEL" "say OK" 2>&1 \
    | tail -1 | sed 's/\x1b\[[0-9;]*m//g'
}

exit_ip() { # $1 = proxy URL
  curl -s --max-time 15 --proxy "$1" https://api.ipify.org 2>/dev/null \
    || curl -s --max-time 15 -x "$1" https://api.ipify.org 2>/dev/null \
    || echo NOCONN
}

start_xray() { # $1 = config, $2 = port, $3 = log
  python3 - "$1" "$2" <<'EOF'
import json, sys
cfg, port = sys.argv[1], int(sys.argv[2])
c = json.load(open(cfg))
for ib in c.get("inbounds", []):
    if ib.get("protocol") in ("mixed", "socks", "http"):
        ib["port"] = port
    elif ib.get("protocol") == "dokodemo-door":
        ib["port"] = port + 53
json.dump(c, open("/tmp/.zen-sweep.json", "w"))
EOF
  setsid nohup "$XRAY" run -c /tmp/.zen-sweep.json > "$3" 2>&1 &
}

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

case "${1:-}" in
  -h|--help) usage 0 ;;

  --proxy)
    PROXY="${2:-}"; shift 2
    echo "proxy: $PROXY"
    echo "exit:  $(exit_ip "$PROXY")"
    echo "zen:   $(probe "$PROXY")"
    ;;

  --sweep)
    DIR="${2:-}"
    [ -d "$DIR" ] || { echo "usage: zen-exit-check.sh --sweep <directory-of-xray-configs>"; exit 1; }
    command -v "$XRAY" >/dev/null 2>&1 || { echo "xray not found (set XRAY=/path/to/xray)"; exit 1; }
    printf '%-40s %-18s %s\n' "config" "exit IP" "zen free model"
    for f in "$DIR"/*.json; do
      [ -f "$f" ] || continue
      name=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('remarks','')or sys.argv[1].split('/')[-1])" "$f" 2>/dev/null || basename "$f")
      start_xray "$f" "$SWEEP_PORT" "$WORK/sweep.log"
      sleep 4
      ip=$(exit_ip "http://127.0.0.1:$SWEEP_PORT")
      if [ "$ip" = "NOCONN" ]; then
        printf '%-40s %-18s %s\n' "$name" "-" "config failed to start"
      else
        res=$(probe "http://127.0.0.1:$SWEEP_PORT")
        printf '%-40s %-18s %s\n' "$name" "$ip" "${res#Error: }"
      fi
      pkill -f ".zen-sweep.json" 2>/dev/null || true
      sleep 1
    done
    ;;

  --use)
    SRC="${2:-}"
    [ -f "$SRC" ] || { echo "usage: zen-exit-check.sh --use <config.json>"; exit 1; }
    mkdir -p "$(dirname "$ZEN_CFG")"
    python3 - "$SRC" "$ZEN_CFG" "$ZEN_PORT" <<'EOF'
import json, sys
src, dst, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
c = json.load(open(src))
for ib in c.get("inbounds", []):
    if ib.get("protocol") in ("mixed", "socks", "http"):
        ib["port"] = port
    elif ib.get("protocol") == "dokodemo-door":
        ib["port"] = port + 53
json.dump(c, open(dst, "w"), indent=1)
EOF
    P=$(ss -tlnp 2>/dev/null | sed -n "s/.*127.0.0.1:$ZEN_PORT .*pid=\([0-9]*\).*/\1/p" | head -1)
    [ -n "$P" ] && kill "$P" 2>/dev/null || true
    sleep 1
    setsid nohup "$(dirname "$0")/start-zen-proxy.sh" > "$WORK/zen-proxy.log" 2>&1 &
    sleep 4
    echo "switched to: $ZEN_CFG"
    echo "exit: $(exit_ip "http://127.0.0.1:$ZEN_PORT")"
    echo "zen:  $(probe "http://127.0.0.1:$ZEN_PORT")"
    ;;

  *)
    echo "exit: $(exit_ip "$PROXY")"
    echo "zen:  $(probe "$PROXY")"
    echo
    echo "if it says 'Free usage limit reached', the exit IP is spent; try"
    echo "  zen-exit-check.sh --sweep <dir-of-xray-configs>"
    ;;
esac

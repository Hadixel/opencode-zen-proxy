#!/bin/sh
# zen-setup.sh — point OpenCode at an HTTP proxy at the *fetch* layer.
#
#   zen-setup.sh --proxy http://127.0.0.1:10900
#   zen-setup.sh --proxy http://corp:8080 --print-shell-env
#
# Writes HTTPS_PROXY/HTTP_PROXY/NO_PROXY into OpenCode's service environment
# (so the background server uses it). Restart the server afterwards:
#
#   opencode service restart
#
# Do NOT point provider baseURL at a local proxy: OpenCode must keep doing its
# own TLS, otherwise Zen rejects the request as "not from OpenCode".
set -eu

PROXY=""
NO_PROXY_VAL="${NO_PROXY_VAL:-localhost,127.0.0.1,::1}"
PRINT=0
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --proxy) PROXY="${2:-}"; shift 2 ;;
    --no-proxy) NO_PROXY_VAL="${2:-}"; shift 2 ;;
    --print-shell-env) PRINT=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done

[ -n "$PROXY" ] || { echo "error: --proxy is required" >&2; usage 1; }

if [ "$PRINT" = 1 ]; then
  printf 'export HTTPS_PROXY=%s\nexport HTTP_PROXY=%s\nexport NO_PROXY=%s\n' \
    "$PROXY" "$PROXY" "$NO_PROXY_VAL"
  exit 0
fi

CFG="$CONFIG_DIR/service.json"
python3 - "$CFG" "$PROXY" "$NO_PROXY_VAL" <<'EOF'
import json, os, sys

cfg, proxy, no_proxy = sys.argv[1], sys.argv[2], sys.argv[3]
data = {}
if os.path.exists(cfg):
    with open(cfg) as fh:
        data = json.load(fh)
env = data.setdefault("env", {})
env["HTTPS_PROXY"] = proxy
env["HTTP_PROXY"] = proxy
env["NO_PROXY"] = no_proxy
os.makedirs(os.path.dirname(cfg), exist_ok=True)
with open(cfg, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
print("updated", cfg)
print(json.dumps(env, indent=2))
EOF

cat <<'EOM'

next:  opencode service restart
EOM

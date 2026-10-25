#!/bin/sh
# zen-setup.sh — complete turnkey setup for opencode-zen-proxy.
#
#   ./bin/zen-setup.sh                      automatic zero-config setup
#   ./bin/zen-setup.sh --proxy http://127.0.0.1:10900
#   ./bin/zen-setup.sh --skip-scrape        do not auto-scrape public proxies
#
# Writes HTTPS_PROXY, HTTP_PROXY, NO_PROXY, and NODE_TLS_REJECT_UNAUTHORIZED
# into OpenCode's service environment, generates local interception certificates,
# and initializes working public proxy configs.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY="http://127.0.0.1:10900"
NO_PROXY_VAL="${NO_PROXY_VAL:-localhost,127.0.0.1,::1}"
PRINT=0
SKIP_SCRAPE=0
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
ZEN_DIR="$HOME/.config/zen-proxy"
CERT_DIR="$ZEN_DIR/certs"

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --proxy) PROXY="${2:-}"; shift 2 ;;
    --no-proxy) NO_PROXY_VAL="${2:-}"; shift 2 ;;
    --skip-scrape) SKIP_SCRAPE=1; shift ;;
    --print-shell-env) PRINT=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done

if [ "$PRINT" = 1 ]; then
  printf 'export HTTPS_PROXY=%s\nexport HTTP_PROXY=%s\nexport NO_PROXY=%s\nexport NODE_TLS_REJECT_UNAUTHORIZED=0\n' \
    "$PROXY" "$PROXY" "$NO_PROXY_VAL"
  exit 0
fi

echo "=== OpenCode Zen Proxy Turnkey Setup ==="

# 1. Generate local interception certs if missing
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/cert.pem" ] || [ ! -f "$CERT_DIR/key.pem" ]; then
  echo "[1/4] Generating local interceptor certificates for opencode.ai..."
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CERT_DIR/key.pem" \
    -out "$CERT_DIR/cert.pem" \
    -days 365 \
    -subj "/CN=opencode.ai" \
    -addext "subjectAltName=DNS:opencode.ai,DNS:*.opencode.ai" >/dev/null 2>&1
  echo "      Certificates created at $CERT_DIR"
else
  echo "[1/4] Local interceptor certificates exist at $CERT_DIR"
fi

# 2. Check Xray binary
echo "[2/4] Checking Xray installation..."
XRAY_BIN=""
for candidate in "${XRAY:-}" "xray" "$HOME/.local/share/v2rayN/bin/xray/xray" "$HOME/.local/bin/xray" "/usr/local/bin/xray" "/usr/bin/xray"; do
  [ -z "$candidate" ] && continue
  if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then
    XRAY_BIN="$candidate"
    break
  fi
done

if [ -n "$XRAY_BIN" ]; then
  echo "      Found Xray: $XRAY_BIN"
else
  echo "      Warning: xray binary not found in standard paths."
  echo "      You can install it or specify XRAY=/path/to/xray"
fi

# 3. Check or scrape proxy configurations
mkdir -p "$ZEN_DIR"
if [ ! -f "$ZEN_DIR/zen.json" ]; then
  if [ "$SKIP_SCRAPE" = 0 ]; then
    echo "[3/4] No zen.json found. Scraping live public proxies from GitHub..."
    node "$SCRIPT_DIR/zen-scrape.js" --max 30 --output "$ZEN_DIR/zen.json" || true
  else
    echo "[3/4] Skipping scraper (--skip-scrape). Copying example config..."
    cp "$SCRIPT_DIR/../config/xray-balancer.example.json" "$ZEN_DIR/zen.json"
  fi
else
  echo "[3/4] Found existing proxy config at $ZEN_DIR/zen.json"
fi

# 4. Configure OpenCode service environment
echo "[4/4] Configuring OpenCode service environment..."
CFG="$CONFIG_DIR/service.json"
python3 - "$CFG" "$PROXY" "$NO_PROXY_VAL" <<'EOF'
import json, os, sys

cfg, proxy, no_proxy = sys.argv[1], sys.argv[2], sys.argv[3]
data = {}
if os.path.exists(cfg):
    with open(cfg) as fh:
        try:
            data = json.load(fh)
        except Exception:
            data = {}
env = data.setdefault("env", {})
env["HTTPS_PROXY"] = proxy
env["HTTP_PROXY"] = proxy
env["NO_PROXY"] = no_proxy
env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"
os.makedirs(os.path.dirname(cfg), exist_ok=True)
with open(cfg, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
print("      Updated", cfg)
print("      Environment:", json.dumps(env, indent=2))
EOF

cat <<'EOM'

Setup completed successfully!

To run in the foreground:
  ./run.sh

Or run in the background (daemon):
  ./bin/zen-service.sh start

Then restart OpenCode service:
  opencode service restart
EOM

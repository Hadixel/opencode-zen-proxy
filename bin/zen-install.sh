#!/bin/sh
# zen-install.sh — one-command install for the OpenCode Zen proxy.
#
#   ./bin/zen-install.sh
#   ./bin/zen-install.sh --refresh --limit 200
#   ./bin/zen-install.sh --no-scrape --no-service
#
# Installs the scripts into ~/.local/bin, the retry plugin into OpenCode's
# plugin directory, downloads Xray if it is missing, scrapes public node feeds
# into ~/.config/zen-proxy/zen.json, writes OpenCode's service environment, and
# starts the proxy + relay as systemd user services (or via autostart on
# systems without systemd).
#
# Public nodes are shared and untrusted. Do not send secrets through them.
set -u

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BIN_DIR="${ZEN_BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${ZEN_CONFIG_DIR:-$HOME/.config/zen-proxy}"
OPENCODE_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
STATE_DIR="$HOME/.local/state/zen-proxy"
LIMIT="${ZEN_SCRAPE_LIMIT:-150}"
ZEN_CHECK="${ZEN_ZEN_CHECK:-5}"
DO_SCRAPE=1
DO_SERVICE=1
DO_VERIFY=1
ALLOW_XRAY_DOWNLOAD=1
FORCE=0
REFRESH=0

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --refresh) DO_SCRAPE=1; REFRESH=1; ;;
    --no-scrape) DO_SCRAPE=0; ;;
    --no-service) DO_SERVICE=0; ;;
    --no-verify) DO_VERIFY=0; ;;
    --no-xray) ALLOW_XRAY_DOWNLOAD=0; ;;
    --force) FORCE=1; ;;
    --limit) LIMIT="${2:?--limit needs a value}"; shift ;;
    --zen-check) ZEN_CHECK="${2:?--zen-check needs a value}"; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
  shift
done

say() { printf '[zen-install] %s\n' "$*" >&2; }
warn() { printf '[zen-install] %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

find_xray() {
  if [ -n "${XRAY:-}" ] && [ -x "$XRAY" ]; then echo "$XRAY"; return 0; fi
  if command -v xray >/dev/null 2>&1; then command -v xray; return 0; fi
  for candidate in "$HOME/.local/bin/xray" "$HOME/.local/share/v2rayN/bin/xray/xray" "/usr/local/bin/xray" "/usr/bin/xray"; do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

download_xray() {
  [ "$ALLOW_XRAY_DOWNLOAD" = 1 ] || die "xray not found; install it or rerun without --no-xray"
  need curl
  need python3
  need sha256sum
  case "$(uname -m)" in
    x86_64|amd64) asset="Xray-linux-64.zip" ;;
    aarch64|arm64) asset="Xray-linux-arm64-v8a.zip" ;;
    armv7l|armv7) asset="Xray-linux-arm32-v7a.zip" ;;
    *) die "unsupported architecture for automatic Xray download: $(uname -m)" ;;
  esac
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT HUP INT TERM
  url="https://github.com/XTLS/Xray-core/releases/latest/download/$asset"
  say "downloading $asset"
  curl -fL --retry 3 --connect-timeout 15 -o "$tmp/xray.zip" "$url" || die "failed to download Xray"
  curl -fsSL --retry 3 -o "$tmp/xray.dgst" "$url.dgst" || die "failed to download Xray checksum"
  expected=$(sed -n 's/^SHA2-256= //p' "$tmp/xray.dgst")
  [ -n "$expected" ] || die "could not parse Xray checksum"
  actual=$(sha256sum "$tmp/xray.zip" | awk '{print $1}')
  [ "$expected" = "$actual" ] || die "Xray checksum mismatch"
  mkdir -p "$HOME/.local/share/zen-proxy"
  python3 - "$tmp/xray.zip" "$HOME/.local/share/zen-proxy" <<'PY'
import os, sys, zipfile
archive, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(archive) as z:
    z.extractall(dest)
PY
  found=""
  for candidate in "$HOME/.local/share/zen-proxy/xray" "$HOME/.local/share/zen-proxy/Xray-linux-64/xray"; do
    [ -f "$candidate" ] && { found="$candidate"; break; }
  done
  [ -n "$found" ] || found=$(find "$HOME/.local/share/zen-proxy" -maxdepth 3 -type f -name xray | head -1)
  [ -n "$found" ] || die "Xray binary not found after extraction"
  chmod +x "$found"
  mkdir -p "$BIN_DIR"
  if [ -e "$BIN_DIR/xray" ] && [ "$FORCE" != 1 ]; then
    say "keeping existing $BIN_DIR/xray"
  else
    ln -sf "$found" "$BIN_DIR/xray"
  fi
  echo "$found"
}

install_files() {
  mkdir -p "$BIN_DIR" "$CONFIG_DIR" "$STATE_DIR" "$OPENCODE_DIR/plugin"
  for file in zen-relay.js zen-scrape.js zen-scrape.sh start-zen-proxy.sh start-zen-relay.sh zen-exit-check.sh zen-setup.sh zen-retry-plugin.js; do
    [ -f "$REPO_DIR/bin/$file" ] || die "missing $REPO_DIR/bin/$file"
    install -m 0755 "$REPO_DIR/bin/$file" "$BIN_DIR/$file"
  done
  plugin="$OPENCODE_DIR/plugin/zen-retry.js"
  if [ -f "$plugin" ] && [ "$FORCE" != 1 ] && ! cmp -s "$REPO_DIR/bin/zen-retry-plugin.js" "$plugin"; then
    cp "$plugin" "$plugin.bak.$(date +%Y%m%d-%H%M%S)"
    say "backed up existing OpenCode plugin"
  fi
  install -m 0644 "$REPO_DIR/bin/zen-retry-plugin.js" "$plugin"
  say "installed scripts to $BIN_DIR"
  say "installed retry plugin to $plugin"
}

write_systemd() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user show-environment >/dev/null 2>&1 || return 1
  need_node=$(command -v node || true)
  [ -n "$need_node" ] || return 1
  unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"
  cat >"$unit_dir/zen-proxy.service" <<EOF
[Unit]
Description=OpenCode Zen Xray proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="$BIN_DIR/start-zen-proxy.sh"
Environment="XRAY=$XRAY_BIN"
Environment=ZEN_PROXY_PORT=10901
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  cat >"$unit_dir/zen-relay.service" <<EOF
[Unit]
Description=OpenCode Zen tunnel relay
After=zen-proxy.service
Wants=zen-proxy.service

[Service]
Type=simple
ExecStart="$need_node" "$BIN_DIR/zen-relay.js"
Environment=ZEN_PROXY_PORT=10901
Environment=ZEN_RELAY_PORT=10900
Environment=ZEN_RELAY_CONTROL_PORT=10902
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload || return 1
  systemctl --user enable zen-proxy.service zen-relay.service || return 1
  # restart (not just start) so an existing unit picks up a changed ExecStart.
  systemctl --user restart zen-proxy.service zen-relay.service ||
    warn "systemd units were installed but did not restart; check: journalctl --user -u zen-proxy -u zen-relay -n 50"
  say "started systemd user services: zen-proxy, zen-relay"
  return 0
}

write_autostart() {
  node_bin=$(command -v node || true)
  [ -n "$node_bin" ] || return 1
  mkdir -p "$HOME/.config/autostart"
  cat >"$HOME/.config/autostart/zen-proxy.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=zen-proxy
Comment=OpenCode Zen Xray proxy
Exec=sh -c 'exec "$HOME/.local/bin/start-zen-proxy.sh"'
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
EOF
  cat >"$HOME/.config/autostart/zen-relay.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=zen-relay
Comment=Transparent relay in front of zen-proxy
Exec=sh -c 'exec "$node_bin" "$HOME/.local/bin/zen-relay.js"'
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
EOF
  ( cd "$HOME" && setsid nohup env XRAY="$XRAY_BIN" "$BIN_DIR/start-zen-proxy.sh" >"$STATE_DIR/proxy.log" 2>&1 & )
  ( cd "$HOME" && setsid nohup env ZEN_PROXY_PORT=10901 "$node_bin" "$BIN_DIR/zen-relay.js" >"$STATE_DIR/relay.log" 2>&1 & )
  say "started proxy and relay; added autostart entries"
}

say "repository: $REPO_DIR"
need node
need python3
need curl
need opencode
say "node: $(command -v node)"
say "opencode: $(command -v opencode)"

XRAY_BIN=$(find_xray || true)
if [ -z "$XRAY_BIN" ]; then
  XRAY_BIN=$(download_xray) || die "could not obtain Xray"
fi
say "xray: $XRAY_BIN"

install_files

if [ "$DO_SCRAPE" = 1 ]; then
  if [ -f "$CONFIG_DIR/zen.json" ] && [ "$REFRESH" != 1 ]; then
    say "existing $CONFIG_DIR/zen.json found; use --refresh to replace it"
  else
    say "scraping public node feeds (limit $LIMIT, Zen checks $ZEN_CHECK)"
    if ! XRAY="$XRAY_BIN" node "$BIN_DIR/zen-scrape.js" --limit "$LIMIT" --concurrency 16 --timeout 6 --zen-check "$ZEN_CHECK"; then
      [ -f "$CONFIG_DIR/zen.json" ] || die "scrape failed and no config exists"
      warn "scrape failed; keeping the existing config"
    fi
  fi
else
  say "scrape skipped"
  [ -f "$CONFIG_DIR/zen.json" ] || warn "no $CONFIG_DIR/zen.json yet; the proxy will not start until one exists"
fi

"$BIN_DIR/zen-setup.sh" --proxy http://127.0.0.1:10900 || warn "could not update OpenCode service.json"

if [ "$DO_SERVICE" = 1 ]; then
  if ! write_systemd; then
    say "systemd user services unavailable; falling back to autostart"
    write_autostart
  fi
else
  say "service installation skipped"
fi

# Pick up the proxy env and the plugin on the next server start.
if command -v opencode >/dev/null 2>&1; then
  opencode service restart >/dev/null 2>&1 || warn "could not restart the OpenCode service; run: opencode service restart"
fi

if [ "$DO_VERIFY" = 1 ]; then
  # Give the services a moment to bind 10900/10901 after enable/start.
  sleep 4
  say "verifying the proxy (this may use one free request)"
  if timeout 150 "$BIN_DIR/zen-exit-check.sh" 2>&1 | sed 's/^/[zen-install] /'; then
    say "verification finished"
  else
    warn "verification did not finish; check 'systemctl --user status zen-proxy zen-relay' (or the autostart logs)"
  fi
fi

cat <<'EOM'
[zen-install] done.

The OpenCode retry plugin reacts to 403/429 by rotating the relay tunnel and
retrying on a new exit. Public nodes are shared and untrusted: do not send
credentials, private code, or other secrets through them.
EOM

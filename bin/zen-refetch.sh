#!/bin/sh
# zen-refetch.sh — fetch, validate and activate a fresh exit pool.
#
#   zen-refetch.sh                 refresh from the configured sources
#   zen-refetch.sh --limit 50      pass scraper options through
#
# Used by the relay's POST /refetch endpoint when the retry plugin reports that
# the current pool is exhausted (all exits dead or rate-limited). The proxy is
# only restarted when the scraper wrote a new healthy config.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_BIN="${NODE:-node}"
[ $# -gt 0 ] || set -- --refresh --limit 100 --zen-check 3

"$NODE_BIN" "$HERE/zen-scrape.js" "$@"

if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet zen-proxy 2>/dev/null; then
  systemctl --user restart zen-proxy
  echo "zen-refetch: restarted zen-proxy"
else
  echo "zen-refetch: config updated; restart the proxy to apply it" >&2
fi

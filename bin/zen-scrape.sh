#!/bin/sh
# zen-scrape.sh — wrapper around zen-scrape.js (keeps the Node script optional to call).
set -eu
exec node "$(dirname "$0")/zen-scrape.js" "$@"

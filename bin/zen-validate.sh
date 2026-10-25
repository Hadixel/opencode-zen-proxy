#!/bin/sh
# zen-validate.sh — re-probe the active Xray config and drop dead exits.
#
#   zen-validate.sh                 validate ~/.config/zen-proxy/zen.json
#   zen-validate.sh --dry-run       report healthy exits without writing
#   zen-validate.sh --zen-check 3   also re-check the first 3 against Zen
#
# Exits must pass Xray's parser and answer an HTTPS request through their
# outbound. If none survive, the existing config is left untouched.
set -eu
exec node "$(dirname "$0")/zen-scrape.js" --validate-only "$@"

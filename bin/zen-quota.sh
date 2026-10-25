#!/bin/sh
# zen-quota.sh — show the free-tier quota state for this machine's exit IP.
#
#   zen-quota.sh
#
# Prints the HTTP status and, on 429, the Retry-After value and reset time.
# This is a direct request: it reports the local IP, not a proxy exit.
set -eu

URL="https://opencode.ai/inference/openai/v1/chat/completions"
BODY='{"model":"big-pickle","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'
HEADERS=$(curl -sS -D - -o /dev/null --max-time 20 "$URL" \
  -H 'content-type: application/json' \
  -H 'user-agent: opencode/latest/2.1.4/cli' \
  -H 'x-opencode-client: cli' \
  --data "$BODY" 2>/dev/null || true)

STATUS=$(printf '%s\n' "$HEADERS" | sed -n 's/^HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' | tail -1)
RETRY=$(printf '%s\n' "$HEADERS" | sed -n 's/^[Rr]etry-[Aa]fter: *//p' | tr -d '\r' | tail -1)

echo "status: ${STATUS:-unreachable}"
if [ -n "$RETRY" ]; then
  echo "retry-after: ${RETRY}s"
  case "$RETRY" in
    *[!0-9]*)
      echo "reset: $RETRY"
      ;;
    *)
      now=$(date +%s)
      if reset=$(date -u -d "@$((now + RETRY))" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null); then
        echo "reset: $reset"
      fi
      ;;
  esac
elif [ "$STATUS" = "200" ]; then
  echo "free tier: available"
fi

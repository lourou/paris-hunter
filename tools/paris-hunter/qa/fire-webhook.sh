#!/usr/bin/env bash
# paris-hunter QA: fire a Stream Estate webhook fixture at the local route (lane 6).
#
# usage: tools/paris-hunter/qa/fire-webhook.sh <fixture> [options]
#
#   fixture: match | event-price-drop | event-price-increase | match-meuble |
#            match-non-meuble | match-furnished-true | match-out-of-band |
#            match-missing-rooms | match-missing-price | match-unknown-shape
#
#   --base <url>          default http://127.0.0.1:9998
#   --secret <s>          default STREAM_ESTATE_WEBHOOK_SECRET (env or .env)
#   --expect <code>       assert HTTP status (default 200); 'any' disables
#   --repeat <n>          fire the same body n times (replay/idempotence tests)
#   --synth --fresh --external-id --created-at --inject-term --price --price-hc
#   --rooms --zip --new-price --photo    (forwarded to payload.js)
#   --print-key           print the dedup key on stdout (for scripting)
#
# The endpoint kind (match|event) is derived from the fixture name.
# Exit: 0 expected status observed (all repeats) · 1 unexpected status · 2 fixture
# missing (lane 2 not landed) · 3 usage error.

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

FIXTURE="${1:-}"
[ -n "$FIXTURE" ] || { ph_fail "usage: fire-webhook.sh <fixture> [options]"; exit 3; }
shift

BASE="http://127.0.0.1:9998"
SECRET=""
EXPECT="200"
REPEAT=1
PRINT_KEY=0
PAYLOAD_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --secret) SECRET="$2"; shift 2 ;;
    --expect) EXPECT="$2"; shift 2 ;;
    --repeat) REPEAT="$2"; shift 2 ;;
    --print-key) PRINT_KEY=1; shift ;;
    --synth|--fresh) PAYLOAD_ARGS+=("$1"); shift ;;
    --external-id|--created-at|--inject-term|--price|--price-hc|--rooms|--zip|--new-price|--photo|--kind)
      PAYLOAD_ARGS+=("$1" "$2"); shift 2 ;;
    *) ph_fail "unknown option: $1"; exit 3 ;;
  esac
done

SECRET="${SECRET:-$(ph_env STREAM_ESTATE_WEBHOOK_SECRET)}"
[ -n "$SECRET" ] || { ph_fail "no webhook secret (set STREAM_ESTATE_WEBHOOK_SECRET or --secret)"; exit 3; }

TMP_BODY="$(mktemp -t ph-qa-payload.XXXXXX)"
trap 'rm -f "$TMP_BODY"' EXIT

# payload.js emits KIND / EXTERNAL_ID / DEDUP_KEY / BODY_FILE assignments.
SHELL_META="$(ph_node tools/paris-hunter/qa/payload.js "$FIXTURE" --out "$TMP_BODY" --emit-shell "${PAYLOAD_ARGS[@]+"${PAYLOAD_ARGS[@]}"}")" || exit $?
eval "$SHELL_META"

URL="$BASE/api/webhook/stream-estate/$SECRET/$KIND"
REDACTED_URL="$BASE/api/webhook/stream-estate/<redacted>/$KIND"

STATUS_OK=0
for i in $(seq 1 "$REPEAT"); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -X POST -H 'Content-Type: application/json' --data-binary "@$TMP_BODY" "$URL") || CODE=000
  ph_log "fired $FIXTURE ($i/$REPEAT) -> $REDACTED_URL : HTTP $CODE (externalId=$EXTERNAL_ID dedupKey=$DEDUP_KEY)"
  if [ "$EXPECT" != "any" ] && [ "$CODE" != "$EXPECT" ]; then
    STATUS_OK=1
    ph_fail "expected HTTP $EXPECT, got $CODE"
  fi
done

[ "$PRINT_KEY" -eq 1 ] && echo "$DEDUP_KEY"
exit "$STATUS_OK"

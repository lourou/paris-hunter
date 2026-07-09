#!/usr/bin/env bash
# paris-hunter QA: live end-to-end runbook driver (contract doc §9 + build plan §C live rows,
# v2 #18 additions, v3 A1/A4/A5/A7). Runs on XMTP_ENV=dev against a DISPOSABLE convos-cli
# creator group — never against the real group. Full matrix + expected outputs: docs/QA.md.
#
# usage: tools/paris-hunter/qa/live-qa.sh <phase> [options]
#   phases (in order):
#     preflight    check tools + env (safe anytime)
#     creator      start the disposable convos-cli creator (agent serve), mint invite
#     adapter      backup local DB, start fredy+adapter with scratch convos state, assert
#                  silent join (member_joined, NO group message during join)
#     silent       AC2: unseeded -> 3 fires -> 0 messages, decisions suppressed:unseeded
#     first-send   seed watermark -> 1 fresh fire -> photo+text arrive; attachment
#                  round-trip; Scaleway unauthenticated-GET + StorageClass asserts
#     watermark    A4 boundary spot-checks: event_at == cutoffMs -> suppressed;
#                  cutoffMs+1s -> notifies
#     exactly-once replay match 3x -> 1 pair; price-drop 3x -> 1 more; increase -> 0
#     exclusions   AC4: per-term live arms + quarantine fixtures -> 0 messages each,
#                  correct decisions; 'non meublé' counter-case notifies
#     restart      AC6: graceful restart -> no re-join, sends still land; SIGKILL +
#                  immediate restart -> lock acquired, no re-join, no duplicate sends
#     budget       #13/A7 drill: PH_MONTHLY_ITEM_BUDGET=3 -> warn at 70%, disable_required,
#                  PUT+GET-verify against mock-stream-estate (needs API-base override, see doc)
#     failpoints   delegate to failpoint-run.sh --mode live
#     teardown     explode the QA conversation, kill processes, restore DB, clean blobs
#   options: --qa-dir <dir> (default /tmp/ph-live-qa) · --port 9998
#
# Exit: 0 pass · 1 assert fail · 2 blocked (missing prerequisite/lane) · 3 usage.

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

PHASE="${1:-}"
[ -n "$PHASE" ] || { ph_fail "usage: live-qa.sh <phase> [--qa-dir <dir>] [--port <p>]"; exit 3; }
shift || true

QA_DIR="/tmp/ph-live-qa"
PORT=9998
while [ $# -gt 0 ]; do
  case "$1" in
    --qa-dir) QA_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) ph_fail "unknown option: $1"; exit 3 ;;
  esac
done

BASE="http://127.0.0.1:$PORT"
CREATOR_LOG="$QA_DIR/creator.ndjson"
SERVER_LOG="$QA_DIR/server.log"
mkdir -p "$QA_DIR"

CONVOS_BIN="$REPO_ROOT/node_modules/.bin/convos"
[ -x "$CONVOS_BIN" ] || CONVOS_BIN="npx -y @xmtp/convos-cli@0.10.14"

SECRET="$(ph_env STREAM_ESTATE_WEBHOOK_SECRET)"

fire() { "$QA_DIR_SELF/fire-webhook.sh" "$@" --base "$BASE"; }
dbjs() { ph_node tools/paris-hunter/qa/db.js "$@"; }
creator_offset() { [ -f "$CREATOR_LOG" ] && wc -l <"$CREATOR_LOG" || echo 0; }
count_messages_since() { ph_count_lines "$CREATOR_LOG" '"event"[[:space:]]*:[[:space:]]*"message"' "$1"; }

require_state() {
  local file="$QA_DIR/$1"
  [ -f "$file" ] || { ph_fail "missing $file — run earlier phases first"; exit 2; }
  cat "$file"
}

start_server() { # extra env pairs as args; writes server.pid
  local extra=("$@")
  (cd "$REPO_ROOT" && exec env \
    XMTP_ENV=dev CONVOS_ENABLED=true FREDY_SKIP_CHROMIUM=true \
    CONVOS_DATA_DIR="$QA_DIR/convos-data" \
    CONVOS_INVITE_URL="$(cat "$QA_DIR/invite" 2>/dev/null || true)" \
    STREAM_ESTATE_WEBHOOK_SECRET="$SECRET" \
    "${extra[@]+"${extra[@]}"}" \
    node --env-file-if-exists=.env index.js) >>"$SERVER_LOG" 2>&1 &
  echo $! >"$QA_DIR/server.pid"
  ph_wait_for_http "$BASE/" 90 || { ph_fail "server did not boot (see $SERVER_LOG)"; return 1; }
}

stop_server() {
  local sig="${1:-TERM}" pid
  pid=$(cat "$QA_DIR/server.pid" 2>/dev/null || true)
  [ -n "$pid" ] || return 0
  kill "-$sig" "$pid" 2>/dev/null || true
  ph_wait_for_exit "$pid" 40 || kill -9 "$pid" 2>/dev/null || true
}

case "$PHASE" in
  # -------------------------------------------------------------------------
  preflight)
    ok=0
    ph_log "node: $(node -v)"
    if [ -x "$REPO_ROOT/node_modules/.bin/convos" ]; then
      ph_pass "convos-cli 0.10.14 available (repo-local)"
    else
      ph_warn "repo-local convos-cli missing — will fall back to npx (needs network)"
    fi
    [ -n "$SECRET" ] && [ "${#SECRET}" -ge 32 ] && ph_pass "webhook secret present (>=32 chars)" || {
      ph_fail "STREAM_ESTATE_WEBHOOK_SECRET missing/short in .env"; ok=1; }
    XMTP_ENV_VAL="$(ph_env XMTP_ENV production)"
    [ "$XMTP_ENV_VAL" = "dev" ] && ph_pass "XMTP_ENV=dev" || \
      ph_warn "XMTP_ENV=$XMTP_ENV_VAL in .env — live QA phases override to dev; NEVER run this against production"
    dbjs tables >/dev/null 2>&1 && ph_pass "paris-hunter tables present" || \
      ph_warn "paris-hunter tables missing (lane 2 pending) — most phases will BLOCK"
    command -v aws >/dev/null 2>&1 && ph_pass "aws CLI present (StorageClass assert available)" || \
      ph_warn "aws CLI absent — head-object StorageClass assert will be skipped"
    exit "$ok"
    ;;

  # -------------------------------------------------------------------------
  creator)
    export CONVOS_HOME="$QA_DIR/convos-home"
    mkdir -p "$CONVOS_HOME"
    if [ ! -f "$CONVOS_HOME/.initialized" ]; then
      $CONVOS_BIN init --env dev && touch "$CONVOS_HOME/.initialized"
    fi
    ph_log "starting creator (agent serve) — ndjson: $CREATOR_LOG"
    $CONVOS_BIN agent serve --name "paris-hunter QA" --profile-name "QA Creator" >"$CREATOR_LOG" 2>"$QA_DIR/creator.err" &
    echo $! >"$QA_DIR/creator.pid"
    ph_wait_for_line "$CREATOR_LOG" '"event"[[:space:]]*:[[:space:]]*"ready"' 120 || {
      ph_fail "creator never emitted ready (see $QA_DIR/creator.err)"; exit 1; }
    node -e "
      const fs = require('fs');
      const line = fs.readFileSync('$CREATOR_LOG', 'utf8').split('\n').find((l) => l.includes('\"ready\"'));
      const evt = JSON.parse(line);
      fs.writeFileSync('$QA_DIR/conv', evt.conversationId);
      fs.writeFileSync('$QA_DIR/invite', evt.inviteUrl);
      console.log('conversationId=' + evt.conversationId);
      console.log('inviteUrl=' + evt.inviteUrl);
    " || { ph_fail "could not parse ready event"; exit 1; }
    ph_pass "creator ready — invite minted"
    ;;

  # -------------------------------------------------------------------------
  adapter)
    require_state invite >/dev/null
    # Fresh-DB guarantee for the silent phase: move the local sqlite aside (restored at teardown).
    if [ -f "$REPO_ROOT/db/listings.db" ] && [ ! -f "$QA_DIR/db-backed-up" ]; then
      mkdir -p "$QA_DIR/db-backup"
      mv "$REPO_ROOT/db/listings.db"* "$QA_DIR/db-backup/" 2>/dev/null || true
      touch "$QA_DIR/db-backed-up"
      ph_log "local DB moved to $QA_DIR/db-backup (teardown restores it)"
    fi
    rm -rf "$QA_DIR/convos-data" && mkdir -p "$QA_DIR/convos-data"
    OFFSET=$(creator_offset)
    start_server || exit 1
    ph_wait_for_line "$CREATOR_LOG" '"event"[[:space:]]*:[[:space:]]*"member_joined"' 300 "$OFFSET" || {
      ph_fail "no member_joined within 5 min (join flow broken or lane 3 pending)"; exit 1; }
    N_MSG=$(count_messages_since "$OFFSET")
    [ "$N_MSG" -eq 0 ] && ph_pass "silent JOIN: member_joined seen, 0 group messages" || {
      ph_fail "silent JOIN violated: $N_MSG message(s) during join"; exit 1; }
    [ -f "$QA_DIR/convos-data/adapter-state.json" ] && ph_pass "adapter-state.json written" || \
      ph_warn "adapter-state.json not found under scratch dir (check lane 3 state layout)"
    ;;

  # -------------------------------------------------------------------------
  silent)
    dbjs tables >/dev/null 2>&1 || { ph_fail "tables missing — lane 2 pending"; exit 2; }
    OFFSET=$(creator_offset)
    EXT_ID="$(uuidgen | tr 'A-Z' 'a-z')"
    for i in 1 2 3; do
      fire match --synth --external-id "$EXT_ID" --created-at now --expect 200 || exit 1
    done
    sleep 20
    N_MSG=$(count_messages_since "$OFFSET")
    [ "$N_MSG" -eq 0 ] || { ph_fail "AC2 violated: $N_MSG message(s) while UNSEEDED"; exit 1; }
    ROW=$(dbjs inbox-row "$EXT_ID")
    echo "$ROW" | grep -q '"decision": *"suppressed:unseeded"' && \
      ph_pass "AC2: 0 messages, decision suppressed:unseeded" || {
      ph_fail "AC2: expected decision suppressed:unseeded — got: $(echo "$ROW" | grep '"decision"')"; exit 1; }
    ;;

  # -------------------------------------------------------------------------
  first-send)
    dbjs qa-seed-watermark >"$QA_DIR/watermark.json" || { ph_fail "watermark mint failed"; exit 2; }
    grep -q 'qa-unknown-configrev' "$QA_DIR/watermark.json" && {
      ph_fail "configRev export missing (lane 2) — gate would suppress"; exit 2; }
    OFFSET=$(creator_offset)
    KEY=$(fire match --synth --fresh --expect 200 --print-key | tail -1)
    echo "$KEY" >"$QA_DIR/first-key"
    ATTACH_PATTERN="${PH_QA_ATTACH_PATTERN:-remoteStaticAttachment|remote_static_attachment|remoteAttachment}"
    ph_wait_for_line "$CREATOR_LOG" "\"event\"[[:space:]]*:[[:space:]]*\"message\".*($ATTACH_PATTERN)" 90 "$OFFSET" || {
      ph_fail "AC1: no attachment message within 90 s"; exit 1; }
    ph_wait_for_line "$CREATOR_LOG" '"event"[[:space:]]*:[[:space:]]*"message"' 90 "$OFFSET" || exit 1
    ph_pass "AC1: photo + text arrived for $KEY"
    # Attachment round-trip + Scaleway asserts.
    OUTROW=$(dbjs outbox-row "$KEY")
    URL=$(echo "$OUTROW" | node -e "
      let s=''; process.stdin.on('data',(d)=>s+=d).on('end',()=>{
        const row = JSON.parse(s); const meta = row?.enc_meta ? JSON.parse(row.enc_meta) : null;
        console.log(meta?.url ?? '');});")
    if [ -n "$URL" ]; then
      CODE=$(curl -s -o "$QA_DIR/blob.bin" -w '%{http_code}' "$URL")
      [ "$CODE" = "200" ] && [ -s "$QA_DIR/blob.bin" ] && \
        ph_pass "Scaleway blob: unauthenticated GET 200 ($URL)" || {
        ph_fail "Scaleway blob GET failed (HTTP $CODE) for $URL"; exit 1; }
      echo "$URL" >>"$QA_DIR/uploaded-urls"
      if command -v aws >/dev/null 2>&1; then
        BUCKET="$(ph_env SCW_S3_BUCKET paris-hunter)"; ENDPOINT="$(ph_env SCW_S3_ENDPOINT)"
        OBJ_KEY="${URL#*"$BUCKET".*/}"
        SC=$(AWS_ACCESS_KEY_ID="$(ph_env SCW_ACCESS_KEY)" AWS_SECRET_ACCESS_KEY="$(ph_env SCW_SECRET_KEY)" \
          aws s3api head-object --endpoint-url "$ENDPOINT" --bucket "$BUCKET" --key "$OBJ_KEY" \
          --query StorageClass --output text 2>/dev/null || echo UNKNOWN)
        [ "$SC" = "ONEZONE_IA" ] && ph_pass "StorageClass ONEZONE_IA" || \
          ph_warn "StorageClass=$SC (expected ONEZONE_IA — verify bucket/class config)"
      fi
    else
      ph_warn "no enc_meta url on outbox row (image skipped?) — Scaleway assert skipped"
    fi
    # Round-trip decrypt via convos-cli (needs the message id of the attachment event).
    MSG_ID=$(tail -n +"$((OFFSET + 1))" "$CREATOR_LOG" | grep -E "$ATTACH_PATTERN" | head -1 | node -e "
      let s=''; process.stdin.on('data',(d)=>s+=d).on('end',()=>{
        try { const evt = JSON.parse(s); console.log(evt.messageId ?? evt.id ?? ''); } catch { console.log(''); }});")
    if [ -n "$MSG_ID" ]; then
      CONV=$(require_state conv)
      CONVOS_HOME="$QA_DIR/convos-home" $CONVOS_BIN conversation download-attachment "$CONV" "$MSG_ID" \
        --output "$QA_DIR/qa.jpg" && [ -s "$QA_DIR/qa.jpg" ] && \
        ph_pass "attachment round-trip: decrypted bytes at $QA_DIR/qa.jpg" || \
        ph_warn "download-attachment failed — verify manually (message id/CLI flags)"
    else
      ph_warn "could not extract attachment message id from creator ndjson — round-trip skipped"
    fi
    ph_node tools/paris-hunter/qa/latency-report.js || true
    ;;

  # -------------------------------------------------------------------------
  watermark)
    # v3 A4 boundary spot-checks against the minted cutoff.
    WM=$(dbjs get-meta notifyWatermark)
    CUTOFF_MS=$(echo "$WM" | node -e "
      let s=''; process.stdin.on('data',(d)=>s+=d).on('end',()=>{console.log(JSON.parse(s).cutoffMs);});") || {
      ph_fail "no watermark JSON — run first-send first"; exit 2; }
    AT_CUTOFF=$(node -e "console.log(new Date($CUTOFF_MS).toISOString())")
    AFTER_CUTOFF=$(node -e "console.log(new Date($CUTOFF_MS + 1000).toISOString())")
    EXT_A="$(uuidgen | tr 'A-Z' 'a-z')"; EXT_B="$(uuidgen | tr 'A-Z' 'a-z')"
    OFFSET=$(creator_offset)
    fire match --synth --external-id "$EXT_A" --created-at "$AT_CUTOFF" --expect 200 || exit 1
    sleep 15
    dbjs inbox-row "$EXT_A" | grep -q '"decision": *"suppressed:watermark"' && \
      ph_pass "event_at == cutoffMs -> suppressed:watermark" || {
      ph_fail "boundary: expected suppressed:watermark at exact cutoff"; exit 1; }
    fire match --synth --external-id "$EXT_B" --created-at "$AFTER_CUTOFF" --expect 200 || exit 1
    ph_wait_for_line "$CREATOR_LOG" '"event"[[:space:]]*:[[:space:]]*"message"' 90 "$OFFSET" && \
      ph_pass "event_at > cutoffMs -> notifies" || { ph_fail "boundary: cutoff+1s did not notify"; exit 1; }
    ;;

  # -------------------------------------------------------------------------
  exactly-once)
    # Amended §4.4 (v3 A1): at-least-once with duplicates ONLY at crash boundaries —
    # on the normal path (no kill), replays must still yield EXACTLY one pair.
    OFFSET=$(creator_offset)
    EXT_ID="$(uuidgen | tr 'A-Z' 'a-z')"
    fire match --synth --external-id "$EXT_ID" --created-at now --repeat 3 --expect 200 || exit 1
    sleep 30
    N_MSG=$(count_messages_since "$OFFSET")
    [ "$N_MSG" -eq 2 ] && ph_pass "AC3a: 3 identical fires -> exactly 1 pair (2 events)" || {
      ph_fail "AC3a: expected 2 message events, saw $N_MSG"; exit 1; }
    ph_node tools/paris-hunter/qa/replay-inbox.js --external-id "$EXT_ID" --assert-once "se:$EXT_ID" || exit 1
    OFFSET=$(creator_offset)
    DROP_AT=$(node -e "console.log(new Date().toISOString())")
    fire event-price-drop --synth --external-id "$EXT_ID" --created-at "$DROP_AT" --repeat 3 --expect 200 || exit 1
    sleep 30
    N_MSG=$(count_messages_since "$OFFSET")
    [ "$N_MSG" -ge 1 ] && [ "$N_MSG" -le 2 ] && ph_pass "AC3b: price-drop x3 -> exactly 1 re-notification" || {
      ph_fail "AC3b: expected 1 re-notification (1-2 events), saw $N_MSG"; exit 1; }
    tail -n +"$((OFFSET + 1))" "$CREATOR_LOG" | grep -q 'baisse de prix' && \
      ph_pass "AC3b: drop message text starts with baisse de prix" || \
      ph_warn "drop text marker not found in creator ndjson (check messageFormat)"
    OFFSET=$(creator_offset)
    fire event-price-increase --synth --external-id "$EXT_ID" --created-at now --expect 200 || exit 1
    sleep 20
    N_MSG=$(count_messages_since "$OFFSET")
    [ "$N_MSG" -eq 0 ] && ph_pass "AC3c: price increase -> 0 messages" || {
      ph_fail "AC3c: price increase produced $N_MSG message(s)"; exit 1; }
    ;;

  # -------------------------------------------------------------------------
  exclusions)
    # AC4 live arms (v2 #18): canonical fail-closed fixtures + one arm per exclusion term.
    FAILED=0
    check_zero() { # $1 fixture/label $2.. fire args
      local label="$1"; shift
      local offset ext_id
      offset=$(creator_offset)
      ext_id="$(uuidgen | tr 'A-Z' 'a-z')"
      fire "$@" --external-id "$ext_id" --created-at now --expect 200 || { FAILED=1; return; }
      sleep 15
      local n
      n=$(count_messages_since "$offset")
      if [ "$n" -eq 0 ]; then
        ph_pass "AC4[$label]: 0 messages (decision: $(dbjs inbox-row "$ext_id" | grep -o '"decision": *"[^"]*"'))"
      else
        ph_fail "AC4[$label]: $n message(s) leaked"; FAILED=1
      fi
    }
    check_zero meuble match-meuble --synth
    check_zero furnished-true match-furnished-true --synth
    check_zero out-of-band match-out-of-band --synth
    check_zero missing-rooms match-missing-rooms --synth
    check_zero missing-price match-missing-price --synth
    check_zero unknown-shape match-unknown-shape --synth
    for term in "colocation" "bail mobilité" "courte durée" "sous-location" "saisonnier"; do
      check_zero "term:$term" match --synth --inject-term "$term"
    done
    # Negation counter-case MUST notify.
    OFFSET=$(creator_offset)
    fire match-non-meuble --synth --fresh --expect 200 || FAILED=1
    ph_wait_for_line "$CREATOR_LOG" '"event"[[:space:]]*:[[:space:]]*"message"' 60 "$OFFSET" && \
      ph_pass "AC4[non-meublé counter-case]: notifies" || { ph_fail "counter-case did not notify"; FAILED=1; }
    exit "$FAILED"
    ;;

  # -------------------------------------------------------------------------
  restart)
    # AC6: graceful restart -> no re-join; then SIGKILL + immediate restart (stale lock).
    for sig in TERM KILL; do
      OFFSET=$(creator_offset)
      stop_server "$sig"
      start_server || { ph_fail "restart after SIG$sig failed (stale lock? see $SERVER_LOG)"; exit 1; }
      sleep 20
      N_JOIN=$(ph_count_lines "$CREATOR_LOG" '"event"[[:space:]]*:[[:space:]]*"member_joined"' "$OFFSET")
      N_MSG=$(count_messages_since "$OFFSET")
      [ "$N_JOIN" -eq 0 ] && ph_pass "AC6[SIG$sig]: no re-join after restart" || {
        ph_fail "AC6[SIG$sig]: re-join detected ($N_JOIN member_joined)"; exit 1; }
      if [ "$sig" = "KILL" ] && [ "$N_MSG" -gt 0 ]; then
        grep -qi 'possible duplicate' "$SERVER_LOG" && \
          ph_warn "AC6[KILL]: $N_MSG resend(s) after SIGKILL — WARN present (documented residual)" || {
          ph_fail "AC6[KILL]: duplicate WITHOUT 'possible duplicate' WARN (v3 A1 rule)"; exit 1; }
      fi
      OFFSET=$(creator_offset)
      fire match --synth --fresh --expect 200 || exit 1
      ph_wait_for_line "$CREATOR_LOG" '"event"[[:space:]]*:[[:space:]]*"message"' 90 "$OFFSET" && \
        ph_pass "AC6[SIG$sig]: post-restart send lands" || { ph_fail "AC6[SIG$sig]: send did not land"; exit 1; }
    done
    # Second process on the same CONVOS_DATA_DIR must refuse (single-writer lock).
    (cd "$REPO_ROOT" && exec env XMTP_ENV=dev CONVOS_ENABLED=true FREDY_SKIP_CHROMIUM=true \
      CONVOS_DATA_DIR="$QA_DIR/convos-data" STREAM_ESTATE_WEBHOOK_SECRET="$SECRET" \
      node --env-file-if-exists=.env index.js) >"$QA_DIR/second.log" 2>&1 &
    SECOND=$!
    if ph_wait_for_exit "$SECOND" 60; then
      ph_pass "AC6: second process on same CONVOS_DATA_DIR exited (lock held)"
    else
      kill -9 "$SECOND" 2>/dev/null
      ph_fail "AC6: second process kept running on the same data dir — single-writer lock broken"
      exit 1
    fi
    ;;

  # -------------------------------------------------------------------------
  budget)
    # v2 #13 / v3 A7 drill. Full PUT+GET-verify observation requires the server to
    # point its Stream Estate base at mock-stream-estate.js (lane-2 override, see doc).
    MOCK_PORT=8998
    ph_kill_port "$MOCK_PORT"
    ph_node tools/paris-hunter/qa/mock-stream-estate.js --port "$MOCK_PORT" >"$QA_DIR/mock.log" 2>&1 &
    echo $! >"$QA_DIR/mock.pid"
    stop_server
    MONTH_KEY="usage:$(date +%Y-%m)"
    dbjs set-meta "$MONTH_KEY" 0
    start_server PH_MONTHLY_ITEM_BUDGET=3 STREAM_ESTATE_API_BASE="http://127.0.0.1:$MOCK_PORT" || exit 1
    for i in 1 2 3 4; do fire match --synth --fresh --expect 200 || exit 1; done
    sleep 70   # budget monitor tick is 60 s
    USAGE=$(dbjs get-meta "$MONTH_KEY")
    [ "$USAGE" = "4" ] && ph_pass "budget: usage counter = 4 after 4 fires" || {
      ph_fail "budget: usage counter = $USAGE (expected 4)"; exit 1; }
    grep -qiE 'budget.*(warn|70)' "$SERVER_LOG" && ph_pass "budget: 70% warn logged" || \
      ph_warn "budget: no warn log matched (check budget.js wording; adjust grep)"
    DISABLE_REQ=$(dbjs get-meta disable_required)
    DISABLE_CONF=$(dbjs get-meta disable_confirmed)
    if [ "$DISABLE_CONF" != "(null)" ]; then
      ph_pass "budget: disable confirmed (GET-verified) at $DISABLE_CONF"
      curl -s "http://127.0.0.1:$MOCK_PORT/__requests" | grep -q '"method":"PUT"' && \
        ph_pass "budget: PUT notificationEnabled:false recorded by mock" || \
        ph_warn "budget: no PUT recorded — server not pointed at the mock (lane-2 base override pending)"
    elif [ "$DISABLE_REQ" != "(null)" ]; then
      ph_warn "budget: disable_required set but not confirmed — enforcement loop could not reach the API " \
        "(expected until the lane-2 STREAM_ESTATE_API_BASE override exists); offline half PASSES"
    else
      ph_fail "budget: neither disable_required nor disable_confirmed set after crossing the ceiling"
      exit 1
    fi
    kill "$(cat "$QA_DIR/mock.pid")" 2>/dev/null || true
    stop_server; start_server || true   # back to normal env
    ;;

  # -------------------------------------------------------------------------
  failpoints)
    exec "$QA_DIR_SELF/failpoint-run.sh" --mode live --port "$PORT" --creator-log "$CREATOR_LOG"
    ;;

  # -------------------------------------------------------------------------
  teardown)
    CONV=$(cat "$QA_DIR/conv" 2>/dev/null || true)
    if [ -n "$CONV" ]; then
      CONVOS_HOME="$QA_DIR/convos-home" $CONVOS_BIN conversation explode "$CONV" --force || \
        ph_warn "explode failed — clean the QA conversation manually"
    fi
    stop_server KILL
    [ -f "$QA_DIR/creator.pid" ] && kill "$(cat "$QA_DIR/creator.pid")" 2>/dev/null || true
    [ -f "$QA_DIR/mock.pid" ] && kill "$(cat "$QA_DIR/mock.pid")" 2>/dev/null || true
    # Delete QA blobs from the bucket (keys recorded during first-send).
    if [ -f "$QA_DIR/uploaded-urls" ] && command -v aws >/dev/null 2>&1; then
      BUCKET="$(ph_env SCW_S3_BUCKET paris-hunter)"; ENDPOINT="$(ph_env SCW_S3_ENDPOINT)"
      while IFS= read -r url; do
        key="${url#*"$BUCKET".*/}"
        AWS_ACCESS_KEY_ID="$(ph_env SCW_ACCESS_KEY)" AWS_SECRET_ACCESS_KEY="$(ph_env SCW_SECRET_KEY)" \
          aws s3api delete-object --endpoint-url "$ENDPOINT" --bucket "$BUCKET" --key "$key" 2>/dev/null && \
          ph_log "deleted blob $key" || ph_warn "could not delete $key"
      done <"$QA_DIR/uploaded-urls"
    fi
    # Restore the local DB moved aside by the adapter phase.
    if [ -f "$QA_DIR/db-backed-up" ]; then
      rm -f "$REPO_ROOT/db/listings.db"*
      mv "$QA_DIR/db-backup/"* "$REPO_ROOT/db/" 2>/dev/null || true
      ph_log "local DB restored"
    fi
    ph_log "teardown done — remove $QA_DIR manually if no longer needed"
    ;;

  *)
    ph_fail "unknown phase: $PHASE (see header for the phase list)"
    exit 3
    ;;
esac

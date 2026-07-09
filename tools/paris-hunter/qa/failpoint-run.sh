#!/usr/bin/env bash
# paris-hunter QA: PH_FAILPOINT kill/restart matrix runner (build plan v2 #14, v3 A1/A12).
#
# For each failpoint: start the stack with PH_FAILPOINT=<name>, fire ONE fresh synthetic
# match, watch the process die (exit 137, 'FAILPOINT <name>' on stderr), restart WITHOUT
# the env, then assert the terminal state within the deadline:
#
#   after_inbox_insert  strict: inbox done, ph_seen=1, outbox=1        (offline+live)
#   after_claim         strict + restarted log MUST contain the dead-lease recovery
#                       line ('recovered ... dead lease')  [v3 A2/A12]  (offline+live)
#   after_decision_tx   strict                                          (offline+live)
#   after_upload        strict single message pair                      (live only)
#   after_image_send    documented residual: killed leg may appear 2x on creator stdout,
#   after_text_send     resend MUST happen, restarted log MUST contain the
#                       'possible duplicate' WARN; duplicate WITHOUT the WARN = FAIL;
#                       other leg exactly 1x                            (live only) [v3 A1]
#
# usage: tools/paris-hunter/qa/failpoint-run.sh [--mode offline|live] [--failpoint <name>|all]
#          [--port 9998] [--deadline <s>] [--creator-log <ndjson>] [--keep-logs]
#
# offline mode: CONVOS_ENABLED=false — only the three ingest failpoints run; send-side
#   boundaries are covered by lane 3's mocked-XMTP vitest suite offline and by this
#   script in live mode (CP3, dev QA group).
# live mode: requires a running convos-cli creator ('live-qa.sh creator') and the
#   adapter env (XMTP_ENV=dev, CONVOS_INVITE_URL, ...) present in .env / environment;
#   pass --creator-log so message events can be counted.
#
# Exit: 0 all PASS · 1 any FAIL · 2 BLOCKED (prerequisites missing, e.g. lane 2 pending).

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

MODE=offline
FP=all
PORT=9998
DEADLINE=90
CREATOR_LOG=""
KEEP_LOGS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --failpoint) FP="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --deadline) DEADLINE="$2"; shift 2 ;;
    --creator-log) CREATOR_LOG="$2"; shift 2 ;;
    --keep-logs) KEEP_LOGS=1; shift ;;
    *) ph_fail "unknown option: $1"; exit 3 ;;
  esac
done

OFFLINE_FPS=(after_inbox_insert after_claim after_decision_tx)
LIVE_FPS=(after_inbox_insert after_claim after_decision_tx after_upload after_image_send after_text_send)
if [ "$FP" = "all" ]; then
  if [ "$MODE" = "live" ]; then FPS=("${LIVE_FPS[@]}"); else FPS=("${OFFLINE_FPS[@]}"); fi
else
  FPS=("$FP")
fi

BASE="http://127.0.0.1:$PORT"
SECRET="$(ph_env STREAM_ESTATE_WEBHOOK_SECRET)"
if [ -z "$SECRET" ] || [ "${#SECRET}" -lt 32 ]; then
  SECRET="$(openssl rand -hex 24)"
  ph_log "no (valid) STREAM_ESTATE_WEBHOOK_SECRET in env/.env — using an ephemeral one for this run"
fi

LOG_DIR="$(mktemp -d -t ph-failpoints.XXXXXX)"
ph_log "logs: $LOG_DIR (mode=$MODE, deadline=${DEADLINE}s)"
if [ "$MODE" = "live" ] && [ -z "$CREATOR_LOG" ]; then
  ph_warn "live mode without --creator-log: creator-stdout message counting is skipped (DB + WARN asserts only)"
fi

# Environment for the server under test. Offline: adapter off, local attachment store.
server_env() {
  local extra_failpoint="$1"
  local env_vars=(
    "STREAM_ESTATE_WEBHOOK_SECRET=$SECRET"
    "FREDY_SKIP_CHROMIUM=true"
  )
  if [ "$MODE" = "offline" ]; then
    env_vars+=("CONVOS_ENABLED=false" "ATTACHMENT_STORE=local"
      "ATTACHMENTS_DIR=$LOG_DIR/attachments" "ATTACHMENTS_PUBLIC_BASE=http://127.0.0.1:1")
  fi
  if [ -n "$extra_failpoint" ]; then env_vars+=("PH_FAILPOINT=$extra_failpoint"); fi
  printf '%s\n' "${env_vars[@]}"
}

start_server() { # $1=failpoint-or-empty $2=logfile -> echoes pid
  local envs=()
  while IFS= read -r line; do envs+=("$line"); done < <(server_env "$1")
  (cd "$REPO_ROOT" && exec env "${envs[@]}" node --env-file-if-exists=.env index.js) >"$2" 2>&1 &
  echo $!
}

stop_server() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  ph_wait_for_exit "$pid" 15 || kill -9 "$pid" 2>/dev/null || true
}

declare -a RESULTS=()
ANY_FAIL=0
ANY_BLOCKED=0

for fp in "${FPS[@]}"; do
  ph_log "=== failpoint: $fp ==="
  ph_kill_port "$PORT"
  RUN_LOG="$LOG_DIR/$fp.run.log"
  RESTART_LOG="$LOG_DIR/$fp.restart.log"

  # Phase 1: server with the failpoint armed.
  PID=$(start_server "$fp" "$RUN_LOG")
  if ! ph_wait_for_http "$BASE/" 60; then
    ph_fail "$fp: server did not come up (see $RUN_LOG)"
    RESULTS+=("$fp BLOCKED(no-boot)"); ANY_BLOCKED=1; stop_server "$PID"; continue
  fi

  # Prerequisites (idempotent): tables (lane 2 landed?), job row, opened watermark gate.
  if ! ph_node tools/paris-hunter/qa/db.js tables >/dev/null 2>&1; then
    ph_warn "$fp: paris-hunter tables missing — lane 2 / migration 22 not landed. BLOCKED."
    RESULTS+=("$fp BLOCKED(tables)"); ANY_BLOCKED=1; stop_server "$PID"; continue
  fi
  ph_node tools/paris-hunter/qa/db.js qa-ensure-job >/dev/null || true
  SEED_OUT=$(ph_node tools/paris-hunter/qa/db.js qa-seed-watermark 2>&1) || true
  if echo "$SEED_OUT" | grep -q 'qa-unknown-configrev'; then
    ph_warn "$fp: watermark configRev unavailable (lane 2 export pending) — gate will suppress. BLOCKED."
    RESULTS+=("$fp BLOCKED(configRev)"); ANY_BLOCKED=1; stop_server "$PID"; continue
  fi

  CREATOR_OFFSET=0
  if [ -n "$CREATOR_LOG" ] && [ -f "$CREATOR_LOG" ]; then CREATOR_OFFSET=$(wc -l <"$CREATOR_LOG"); fi

  # Phase 2: fire ONE fresh synthetic match (server may die before replying).
  DEDUP_KEY=$("$QA_DIR_SELF/fire-webhook.sh" match --synth --fresh --base "$BASE" --secret "$SECRET" \
    --expect any --print-key | tail -1)
  ph_log "$fp: fired dedupKey=$DEDUP_KEY"

  # Phase 3: the armed process must die with the failpoint marker.
  if ! ph_wait_for_exit "$PID" 60; then
    ph_warn "$fp: process still alive — failpoint never reached (lane code pending?). BLOCKED."
    RESULTS+=("$fp BLOCKED(not-reached)"); ANY_BLOCKED=1; stop_server "$PID"; continue
  fi
  if ! grep -q "FAILPOINT $fp" "$RUN_LOG"; then
    ph_fail "$fp: process exited without the 'FAILPOINT $fp' marker (see $RUN_LOG)"
    RESULTS+=("$fp FAIL(no-marker)"); ANY_FAIL=1; continue
  fi
  ph_log "$fp: process killed at the failpoint (137)"

  # Phase 4: restart WITHOUT the failpoint; recovery must complete within the deadline.
  PID=$(start_server "" "$RESTART_LOG")
  if ! ph_wait_for_http "$BASE/" 60; then
    ph_fail "$fp: restart failed (see $RESTART_LOG)"
    RESULTS+=("$fp FAIL(no-restart)"); ANY_FAIL=1; continue
  fi

  ASSERT_MODE=offline
  [ "$MODE" = "live" ] && ASSERT_MODE=live
  if ph_node tools/paris-hunter/qa/db.js assert-final "$DEDUP_KEY" --mode "$ASSERT_MODE" --deadline "$DEADLINE" \
      >"$LOG_DIR/$fp.assert.json" 2>&1; then
    DB_OK=1
  else
    DB_OK=0
  fi

  # Per-failpoint extra criteria.
  EXTRA_OK=1
  case "$fp" in
    after_claim)
      # v3 A2/A12: the restarted boot must recover the dead lease and log it.
      if ! grep -qiE 'recovered [0-9]+ dead lease' "$RESTART_LOG"; then
        ph_fail "$fp: dead-lease recovery log line missing in restarted boot"
        EXTRA_OK=0
      fi
      ;;
    after_image_send|after_text_send)
      # v3 A1: residual window — WARN is MANDATORY (duplicate or not).
      if ! grep -qi 'possible duplicate' "$RESTART_LOG"; then
        ph_fail "$fp: 'possible duplicate' WARN missing after send-boundary kill"
        EXTRA_OK=0
      fi
      if [ -n "$CREATOR_LOG" ] && [ -f "$CREATOR_LOG" ]; then
        ATTACH_PATTERN="${PH_QA_ATTACH_PATTERN:-remoteStaticAttachment|remote_static_attachment|remoteAttachment}"
        N_ATTACH=$(ph_count_lines "$CREATOR_LOG" "\"event\"[[:space:]]*:[[:space:]]*\"message\".*($ATTACH_PATTERN)" "$CREATOR_OFFSET")
        N_TEXT=$(ph_count_lines "$CREATOR_LOG" "\"event\"[[:space:]]*:[[:space:]]*\"message\"" "$CREATOR_OFFSET")
        N_TEXT=$((N_TEXT - N_ATTACH))
        if [ "$fp" = "after_image_send" ]; then
          KILLED=$N_ATTACH; OTHER=$N_TEXT
        else
          KILLED=$N_TEXT; OTHER=$N_ATTACH
        fi
        if [ "$KILLED" -lt 1 ] || [ "$KILLED" -gt 2 ]; then
          ph_fail "$fp: killed leg appeared ${KILLED}x on creator stdout (expected 1 or 2)"
          EXTRA_OK=0
        fi
        if [ "$OTHER" -ne 1 ]; then
          ph_fail "$fp: other leg appeared ${OTHER}x on creator stdout (expected exactly 1)"
          EXTRA_OK=0
        fi
      fi
      ;;
    *)
      # Strict boundaries (v3 A1): a duplicate WARN here means an unexpected resend.
      if [ "$MODE" = "live" ] && [ -n "$CREATOR_LOG" ] && [ -f "$CREATOR_LOG" ]; then
        N_MSG=$(ph_count_lines "$CREATOR_LOG" '"event"[[:space:]]*:[[:space:]]*"message"' "$CREATOR_OFFSET")
        if [ "$N_MSG" -ne 2 ]; then
          ph_fail "$fp: expected exactly 1 message pair (2 events) on creator stdout, saw $N_MSG"
          EXTRA_OK=0
        fi
      fi
      ;;
  esac

  stop_server "$PID"

  if [ "$DB_OK" -eq 1 ] && [ "$EXTRA_OK" -eq 1 ]; then
    ph_pass "$fp"
    RESULTS+=("$fp PASS")
  else
    [ "$DB_OK" -ne 1 ] && ph_fail "$fp: DB terminal-state assert failed (see $LOG_DIR/$fp.assert.json)"
    RESULTS+=("$fp FAIL"); ANY_FAIL=1
  fi
done

echo
echo "=== failpoint matrix ($MODE) ==="
printf '%s\n' "${RESULTS[@]+"${RESULTS[@]}"}"
[ "$KEEP_LOGS" -eq 1 ] && ph_log "logs kept at $LOG_DIR" || true

if [ "$ANY_FAIL" -eq 1 ]; then exit 1; fi
if [ "$ANY_BLOCKED" -eq 1 ]; then exit 2; fi
exit 0

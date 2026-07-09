#!/usr/bin/env bash
# paris-hunter QA harness — shared shell helpers (lane 6). Source, do not execute.

set -u

QA_DIR_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$QA_DIR_SELF/../../.." && pwd)"

ph_log() { printf '\033[0;36m[qa]\033[0m %s\n' "$*" >&2; }
ph_pass() { printf '\033[0;32m[PASS]\033[0m %s\n' "$*" >&2; }
ph_fail() { printf '\033[0;31m[FAIL]\033[0m %s\n' "$*" >&2; }
ph_warn() { printf '\033[0;33m[WARN]\033[0m %s\n' "$*" >&2; }

# ph_env KEY [default] — env var wins; else parse repo .env; else default.
ph_env() {
  local key="$1" default="${2:-}"
  local current="${!key:-}"
  if [ -n "$current" ]; then
    printf '%s' "$current"
    return 0
  fi
  if [ -f "$REPO_ROOT/.env" ]; then
    local line
    line=$(grep -E "^${key}=" "$REPO_ROOT/.env" | tail -1 || true)
    if [ -n "$line" ]; then
      local value="${line#*=}"
      value="${value%%#*}" # strip trailing comment
      value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//')"
      printf '%s' "$value"
      return 0
    fi
  fi
  printf '%s' "$default"
}

# ph_wait_for_http URL TIMEOUT_S — poll until the server answers anything.
ph_wait_for_http() {
  local url="$1" timeout="${2:-60}" start code
  start=$(date +%s)
  while true; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || echo 000)
    if [ "$code" != "000" ]; then return 0; fi
    if [ $(($(date +%s) - start)) -ge "$timeout" ]; then return 1; fi
    sleep 1
  done
}

# ph_wait_for_exit PID TIMEOUT_S — wait for a process to die.
ph_wait_for_exit() {
  local pid="$1" timeout="${2:-60}" start
  start=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    if [ $(($(date +%s) - start)) -ge "$timeout" ]; then return 1; fi
    sleep 1
  done
  return 0
}

# ph_wait_for_line FILE PATTERN TIMEOUT_S [FROM_LINE] — grep a growing log.
ph_wait_for_line() {
  local file="$1" pattern="$2" timeout="${3:-60}" from="${4:-0}" start
  start=$(date +%s)
  while true; do
    if [ -f "$file" ] && tail -n "+$((from + 1))" "$file" | grep -qE "$pattern"; then return 0; fi
    if [ $(($(date +%s) - start)) -ge "$timeout" ]; then return 1; fi
    sleep 1
  done
}

# ph_count_lines FILE PATTERN [FROM_LINE] — count matches after an offset.
ph_count_lines() {
  local file="$1" pattern="$2" from="${3:-0}"
  if [ ! -f "$file" ]; then echo 0; return; fi
  tail -n "+$((from + 1))" "$file" | grep -cE "$pattern" || true
}

# ph_kill_port PORT — free a TCP port (stale server from an earlier run).
ph_kill_port() {
  local port="$1"
  lsof -ti ":$port" 2>/dev/null | xargs kill 2>/dev/null || true
}

# ph_node ARGS... — run node with repo .env loaded, from the repo root.
ph_node() {
  (cd "$REPO_ROOT" && node --env-file-if-exists=.env "$@")
}

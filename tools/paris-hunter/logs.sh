#!/usr/bin/env bash
# Read the deploy logs as compact operator events.
#
# Usage:
#   tools/paris-hunter/logs.sh [webhooks|all|errors] [--since <duration>]
#
# The default "webhooks" view follows webhook access records and all Fredy
# paris-hunter pipeline lines. "all" keeps every service line but compacts
# structured Caddy records. "errors" keeps non-2xx access records and Fredy
# WARN/ERROR lines.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tools/paris-hunter/logs.sh [webhooks|all|errors] [--since <duration>]

Modes:
  webhooks  Follow webhook requests and Fredy paris-hunter events (default)
  all       Follow all Caddy and Fredy logs, compacting Caddy JSON
  errors    Follow non-2xx Caddy requests and Fredy WARN/ERROR events
EOF
}

mode=webhooks
if (($# > 0)) && [[ $1 != --* ]]; then
  mode=$1
  shift
fi

case "$mode" in
  webhooks | all | errors) ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown log mode: $mode" >&2
    usage >&2
    exit 2
    ;;
esac

since_args=()
while (($# > 0)); do
  case "$1" in
    --since)
      if (($# < 2)); then
        echo "--since requires a duration (for example: --since 30m)" >&2
        exit 2
      fi
      since_args=(--since "$2")
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Install it with 'brew install jq' (macOS) or 'sudo apt install jq' (Debian/Ubuntu)." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to read the Compose logs." >&2
  exit 1
fi

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
compose_file="$repo_root/deploy/compose.yml"

# Keep Compose's service prefix long enough for jq to distinguish Fredy from
# Caddy, then remove it from the rendered event. --no-color also prevents ANSI
# escapes from interfering with level matching.
docker compose -f "$compose_file" logs --follow --no-color "${since_args[@]}" caddy fredy |
  jq --raw-input --raw-output --unbuffered --arg mode "$mode" '
    def split_compose_line:
      try capture("^(?<service>caddy|fredy)(?:-[^[:space:]]+)?[[:space:]]+\\|[[:space:]]?(?<message>.*)$")
      catch {service: "unknown", message: .};

    def parsed_json:
      try fromjson catch null;

    # Console access logs keep their structured fields as a trailing JSON object.
    # Also accept the former all-JSON access format so upgrades remain seamless.
    def access_record:
      . as $message
      | (parsed_json) as $json
      | if (($json | type) == "object" and ($json.request | type) == "object") then
          $json
        else
          (
            try (
              capture(
                "^(?<ts>[^[:space:]]+)[[:space:]]+[^[:space:]]+[[:space:]]+http\\.log\\.access(?:\\.[^[:space:]]+)?[[:space:]]+handled request[[:space:]]+(?<data>\\{.*\\})$"
              ) as $console
              | ($console.data | fromjson) + {ts: $console.ts}
            ) catch null
          ) // null
        end;

    def access_line:
      (.ts | if type == "number" then todate else (. // "-") end) as $ts
      | (.request.remote_ip // .request.client_ip // "-") as $ip
      | (.request.uri // "-"
          | gsub("/api/webhook/stream-estate/[^/]+"; "/api/webhook/stream-estate/<redacted>")) as $uri
      | "\($ts)  \($ip)  \(.request.method // "-") \(.request.host // "-")\($uri) → \(.status // "-")";

    def runtime_line:
      . as $entry
      | ($entry.ts | if type == "number" then todate else (. // "-") end) as $ts
      | ($entry.level // "INFO" | ascii_upcase) as $level
      | ($entry.logger // $entry.name // "caddy") as $logger
      | ($entry.msg // "") as $message
      | ($entry | del(.ts, .level, .logger, .name, .msg)) as $details
      | "\($ts)  \($level)  \($logger): \($message)"
        + (if ($details | length) == 0 then "" else " \($details | tojson)" end);

    split_compose_line as $line
    | ($line.message | access_record) as $access
    | ($line.message | parsed_json) as $json
    | if $mode == "webhooks" then
        if ($line.service == "caddy"
            and $access != null
            and (($access.request.uri // "") | startswith("/api/webhook/"))) then
          $access | access_line
        elif ($line.service == "fredy" and ($line.message | contains("paris-hunter"))) then
          $line.message
        else
          empty
        end
      elif $mode == "errors" then
        if ($line.service == "caddy"
            and $access != null
            and (($access.status // 0) < 200 or ($access.status // 0) >= 300)) then
          $access | access_line
        elif ($line.service == "fredy"
              and ($line.message | test("(^|[[:space:]])(WARN|ERROR)(:|[[:space:]])"))) then
          $line.message
        else
          empty
        end
      elif ($line.service == "caddy" and $access != null) then
        $access | access_line
      elif ($line.service == "caddy" and (($json | type) == "object")) then
        $json | runtime_line
      else
        $line.message
      end
  '

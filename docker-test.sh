#!/bin/sh
set -e

# Stop and remove old container if it exists
if [ "$(docker ps -aq -f name=fredy)" ]; then
  docker stop fredy || true
  docker rm fredy || true
fi

# On Apple Silicon, force linux/amd64 to match production CI and avoid arm64/x86_64
# Chrome mismatch under Rosetta. On native Linux (amd64 or arm64) let Docker pick naturally. That took me fucking 1 hour to figure out.
# paris-hunter: forcing amd64 also makes the Dockerfile's build-time @xmtp
# native-binding assertion validate the PRODUCTION (VPS linux/amd64) binding.
PLATFORM=""
if [ "$(uname -m)" = "arm64" ] && [ "$(uname -s)" = "Darwin" ]; then
  PLATFORM="linux/amd64"
fi

# Build image from local Dockerfile, forcing a fresh build without cache
if [ -n "$PLATFORM" ]; then
  docker build --no-cache --platform "$PLATFORM" -t fredy:local .
else
  docker build --no-cache -t fredy:local .
fi

# Run container with volumes and port mapping.
# paris-hunter: dummy-valid smoke env (NEVER production values) so boot-time
# env validation passes and the convos adapter init actually runs — the smoke
# must exercise the @xmtp native-binding load, not just "the app is up".
SMOKE_ENV="-e CONVOS_ENABLED=true \
  -e STREAM_ESTATE_WEBHOOK_SECRET=dummy-smoke-secret-0123456789abcdef \
  -e PUBLIC_BASE_URL=https://smoke.invalid \
  -e CONVOS_INVITE_URL= \
  -e CONVOS_DATA_DIR=/data/convos \
  -e ATTACHMENT_STORE=local \
  -e ATTACHMENTS_DIR=/data/convos/attachments \
  -e ATTACHMENTS_PUBLIC_BASE=https://smoke.invalid/attachments"
if [ -n "$PLATFORM" ]; then
  docker run -d --name fredy --platform "$PLATFORM" $SMOKE_ENV -v fredy_conf:/conf -v fredy_db:/db -p 9998:9998 fredy:local
else
  docker run -d --name fredy $SMOKE_ENV -v fredy_conf:/conf -v fredy_db:/db -p 9998:9998 fredy:local
fi

echo "Waiting for app to be ready..."
for i in $(seq 1 30); do
  if docker exec fredy curl -sf http://localhost:9998/ > /dev/null 2>&1; then
    echo "App is up"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "App did not come up in time"
    docker logs fredy
    exit 1
  fi
  sleep 2
done

# Boot-log assertions (paris-hunter): the logs MUST contain
# 'paris-hunter: initialized' AND MUST NOT contain 'degraded(init-error)'.
# degraded(init-error) is how a missing/unloadable @xmtp native binding
# surfaces at runtime ("Cannot find native binding...") — the boot still looks
# clean without these greps, which is exactly how a broken image once shipped.
# On a fresh container the adapter must get PAST client creation and park in
# its normal first-run state: degraded(no-invite) (or healthy if state exists).
echo "Checking boot logs..."
sleep 3
BOOT_LOGS=$(docker logs fredy 2>&1)
if ! echo "$BOOT_LOGS" | grep -q "paris-hunter: initialized"; then
  echo "Boot log check FAILED - 'paris-hunter: initialized' not found"
  docker logs fredy
  exit 1
fi
if echo "$BOOT_LOGS" | grep -q "degraded(init-error)"; then
  echo "Boot log check FAILED - convos adapter degraded(init-error) (broken @xmtp native binding?)"
  docker logs fredy
  exit 1
fi
if ! echo "$BOOT_LOGS" | grep -qE "degraded\(no-invite\)|convos adapter: healthy"; then
  echo "Boot log check FAILED - convos adapter never reached no-invite/healthy (init did not complete)"
  docker logs fredy
  exit 1
fi
echo "Boot logs are clean (initialized, adapter past client init, no init-error)"

# Verify the DB is readable/writable via the API.
# /api/demo is unauthenticated and reads the settings table - if SQLite is broken this returns an error.
echo "Testing DB via API (/api/demo)..."
DEMO_RESPONSE=$(docker exec fredy curl -sf http://localhost:9998/api/demo 2>&1)
if echo "$DEMO_RESPONSE" | grep -q "demoMode"; then
  echo "DB is readable (got demoMode from /api/demo)"
else
  echo "DB check failed - unexpected response from /api/demo: $DEMO_RESPONSE"
  docker logs fredy
  exit 1
fi

# Verify Chrome launches without crashing.
# paris-hunter: the image is API-only (FREDY_SKIP_CHROMIUM=true baked in, no
# Chromium shipped) — skip the Chrome check for it.
if [ "$(docker exec fredy sh -c 'echo $FREDY_SKIP_CHROMIUM')" = "true" ]; then
  echo "Skipping Chrome check (FREDY_SKIP_CHROMIUM=true, API-only image)"
  echo ""
  echo "All checks passed."
  exit 0
fi
# On amd64: Chrome for Testing lives in the puppeteer cache.
# On arm64: system Chromium is used instead.
echo "Testing Chrome..."
CHROME=$(docker exec fredy find /root/.cache/puppeteer /home -name chrome -type f 2>/dev/null | head -1)
if [ -z "$CHROME" ]; then
  CHROME=$(docker exec fredy which chromium 2>/dev/null || true)
fi
if [ -z "$CHROME" ]; then
  echo "Chrome/Chromium binary not found"
  exit 1
fi
if docker exec fredy "$CHROME" --headless --no-sandbox --disable-gpu --dump-dom https://example.com 2>&1 | grep -q "<html"; then
  echo "Chrome works"
else
  echo "Chrome failed to render a page"
  docker exec fredy "$CHROME" --headless --no-sandbox --disable-gpu --dump-dom https://example.com 2>&1 | head -20
  exit 1
fi

echo ""
echo "All checks passed."

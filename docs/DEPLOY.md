# paris-hunter — VPS deploy runbook

What this deploys: a single-VPS docker-compose stack — Fredy (fork, API-only, no Chromium) behind
Caddy (TLS + webhook IP allowlist). Stream Estate pushes webhooks in; the convos adapter posts
scored listings to an XMTP group; photo ciphertext blobs are uploaded to Scaleway Object Storage
and served from there (Caddy has NO attachments route).

```
Stream Estate ──POST /api/webhook/stream-estate/<secret>/{match,event}──▶ Caddy (443, allowlist)
  ──▶ fredy:9998 (inbox → provider → outbox → convos adapter) ──▶ XMTP group
                                             └──▶ Scaleway bucket paris-hunter (ciphertext photos)
```

## 1. Prerequisites

- VPS with `docker` + `docker compose` v2.
- A domain with a DNS A record → the VPS IP (Caddy gets Let's Encrypt certs automatically).
- The Scaleway bucket `paris-hunter` exists in `fr-par` (user-owned; nothing here creates it).
- Stream Estate billing confirmed (go-live checklist E.1) — until then, keep `bootstrap.js` in
  `--dry-run` and fire only fixtures.

## 2. Populate `.env`

Copy `.env.example` → `.env` on the VPS and fill it in. Hard requirements enforced at boot
(process exits with a clear message if violated):

- `STREAM_ESTATE_WEBHOOK_SECRET` — **at least 32 characters** (boot-fatal below that). Generate:
  `openssl rand -hex 24` (48 hex chars). It is a URL path segment: keep it out of shell history
  where possible, and note that the app redacts it in all logs.
- `PUBLIC_BASE_URL` — **must be `https://…` in production** (boot-fatal otherwise). This is the
  base used to register webhook URLs with Stream Estate.
- `SCW_ACCESS_KEY` / `SCW_SECRET_KEY` — required when `ATTACHMENT_STORE=s3` (the default).

### Env-file handling (two distinct mechanisms — don't mix them up)

- **Inside the container**: compose injects `../.env` via `env_file` (see `deploy/compose.yml`).
  Nothing to do; `docker compose run --rm fredy node tools/paris-hunter/<tool>.js` inherits it.
- **On a host shell** (operator machine or VPS, outside docker): Node does NOT read `.env` by
  itself. ALWAYS invoke tools as:

  ```bash
  node --env-file-if-exists=.env tools/paris-hunter/<tool>.js
  ```

## 3. Scaleway credential split (recommended)

Two kinds of S3 access exist with very different blast radii:

| Key                                                                | Used by                | Where it lives                       | Scope                                                                                                |
| ------------------------------------------------------------------ | ---------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `SCW_LIFECYCLE_ACCESS_KEY` / `SCW_LIFECYCLE_SECRET_KEY` (optional) | `setup-bucket.js` only | operator machine — **never the VPS** | admin (bucket lifecycle config)                                                                      |
| `SCW_ACCESS_KEY` / `SCW_SECRET_KEY`                                | runtime uploads        | VPS `.env`                           | ideally a dedicated key restricted via a Scaleway IAM policy to bucket `paris-hunter` (object write) |

Single-key fallback: if you skip the split, `setup-bucket.js` falls back to
`SCW_ACCESS_KEY`/`SCW_SECRET_KEY`. That is an accepted tradeoff, but then a VPS compromise exposes
a key that can rewrite bucket lifecycle (and whatever else the key allows) — prefer the split.

## 4. Bucket setup (once, from the operator machine)

```bash
node --env-file-if-exists=.env tools/paris-hunter/setup-bucket.js --dry-run   # review
node --env-file-if-exists=.env tools/paris-hunter/setup-bucket.js            # apply
```

What it does: asserts the bucket exists (never creates it), then MERGES a lifecycle rule
`ph-attachments-30d` — scoped to the `attachments/` key prefix, 30-day expiry, plus a 30-day
noncurrent-version expiry iff bucket versioning is enabled. All pre-existing rules are preserved
verbatim; re-running is idempotent.

aws-cli fallback (equivalent):

```bash
aws s3api get-bucket-lifecycle-configuration --endpoint-url "$SCW_S3_ENDPOINT" --bucket "$SCW_S3_BUCKET"
# merge by hand, keep existing rules, then:
aws s3api put-bucket-lifecycle-configuration --endpoint-url "$SCW_S3_ENDPOINT" --bucket "$SCW_S3_BUCKET" \
  --lifecycle-configuration '{"Rules":[<existing rules...>,{"ID":"ph-attachments-30d","Status":"Enabled","Filter":{"Prefix":"attachments/"},"Expiration":{"Days":30}}]}'
```

### Storage class & cost note

Uploads use `StorageClass: ONEZONE_IA` + `ACL: public-read` (user decision; mandatory on every
upload). Cost reality check: Scaleway bills Object Storage in started GB-hour units; at our volume
(~300 objects/month × ~300 KB ≈ 0.09 GB live at any time under the 30-day sweep) either storage
class costs cents per month — the class choice is immaterial at this scale. One Zone - IA is meant
for recreatable data, which fits: blobs are ciphertext of downscaled photos, fully expendable
(losing them only breaks the image bubble of old messages; text messages are unaffected).
Public-read leaks nothing but size/timing — content is encrypted (XMTP remote-attachment scheme).

## 5. First boot — EXACT order (go-live E.3)

The order matters: it guarantees the "silent first run" invariant (a fresh deploy can never spam
the group with pre-existing listings).

```bash
# 0. Build & pre-checks (VPS, repo checked out)
docker compose -f deploy/compose.yml build

# 1. Bucket lifecycle (operator machine — see §4)
node --env-file-if-exists=.env tools/paris-hunter/setup-bucket.js

# 2. Bootstrap DRY-RUN — review every intended Stream Estate API call
docker compose -f deploy/compose.yml run --rm fredy node tools/paris-hunter/bootstrap.js --dry-run

# 3. Real bootstrap — creates/reconciles the saved search with notifications DISABLED
docker compose -f deploy/compose.yml run --rm fredy node tools/paris-hunter/bootstrap.js

# 4. Seed — marks the current market as seen and persists the notify watermark
docker compose -f deploy/compose.yml run --rm fredy node tools/paris-hunter/seed.js

# 5. Enable notifications — REFUSES to run if no watermark exists
docker compose -f deploy/compose.yml run --rm fredy node tools/paris-hunter/bootstrap.js --enable-notifications

# 6. Start the stack
docker compose -f deploy/compose.yml up -d

# 7. AC2 silent check: watch logs — webhook deliveries must be suppressed
#    (decision 'suppressed:watermark'/'suppressed:unseeded'), ZERO group messages.
docker compose -f deploy/compose.yml logs -f fredy
```

Watermark margin caveat (accepted risk F.12): seeding sets the watermark 2 minutes in the future
(clock-skew margin). A listing published inside that enable window is suppressed, not notified —
over-suppression is chosen over a notification storm.

Then per go-live checklist: verify webhook reachability (§8), create the real group invite, set
`CONVOS_INVITE_URL`, restart, approve the join on the phone, lock the group.

## 6. Single-writer discipline (upgrades & restarts)

There must NEVER be two Fredy processes on the same volumes: two XMTP writers on one identity
corrupt the client state, and sqlite is single-writer. Concretely:

- **Never** `docker compose up --scale fredy=2`, never a second compose project on the same
  volumes, never `docker compose run` a tool that opens XMTP while the main container runs.
- Upgrades are **stop-then-start**, not rolling:

  ```bash
  git pull
  docker compose -f deploy/compose.yml build
  docker compose -f deploy/compose.yml down   # full stop — waits stop_grace_period (30s)
  docker compose -f deploy/compose.yml up -d  # start the new image
  ```

- `stop_grace_period: 30s` gives the adapter time to finish an in-flight send and close the XMTP
  client on SIGTERM. If a container is SIGKILLed, boot recovers: the flock dies with the process,
  leases expire, and the outbox state machine resends anything not confirmed sent (a crash exactly
  between a network send and its state write may produce ONE duplicate message — documented
  residual, preferred over loss).

## 7. Budget ceiling (Stream Estate PAYG)

`PH_MONTHLY_ITEM_BUDGET` (default 900 items/month ≈ €9 PAYG) caps spend via a delivery-proxy
counter (`usage:<YYYY-MM>` in `paris_hunter_meta`, incremented per accepted webhook item):

- ≥ 70%: WARN logs.
- 100%: the app **auto-disables the saved search** (PUT `notificationEnabled:false` on the Stream
  Estate side) and logs loudly. Webhooks stop arriving; nothing is lost locally.
- To re-enable after a trip: raise `PH_MONTHLY_ITEM_BUDGET` in `.env` (or wait for the month to
  roll over), restart, then run
  `docker compose -f deploy/compose.yml run --rm fredy node tools/paris-hunter/bootstrap.js --enable-notifications`.
- The counter is a proxy for billed items until billing semantics are confirmed (E.1). On day 1,
  compare the meta counter with the Stream Estate dashboard and adjust the ceiling (E.9).
  Investigate if usage trends past ~700 items/month (realistic estimate is 90–620).

## 8. Webhook reachability check (go-live E.4)

```bash
# From a random IP (e.g. your laptop): expect 403 (Caddy IP allowlist)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "https://<domain>/api/webhook/stream-estate/$STREAM_ESTATE_WEBHOOK_SECRET/match"

# From Stream Estate's tester (AFTER billing confirmation E.1 — tester calls may bill):
curl "https://api.stream.estate/webhook-tester?endpoint=https://<domain>/api/webhook/stream-estate/$STREAM_ESTATE_WEBHOOK_SECRET/match" \
  -H "X-API-KEY: $STREAM_ESTATE_API_KEY"
```

If deliveries go silent later, check Caddy logs for 403s first — Stream Estate rotating its egress
IP (`144.76.91.183` today) would surface exactly like that; update the `remote_ip` allowlist.
The secret path alone still gates the app if you must temporarily widen the allowlist.

## 9. XMTP environments

|                        | QA                  | Production                                           |
| ---------------------- | ------------------- | ---------------------------------------------------- |
| `XMTP_ENV`             | `dev`               | `production`                                         |
| Invite origin          | convos-cli QA group | Convos iOS app (PROD build)                          |
| Invite URL domain hint | `dev.convos.org`    | `popup.convos.org` / `app.convos.org` / `convos.org` |

The env MUST match the invite's origin app — a prod invite with `XMTP_ENV=dev` sends the join
request into the void. Boot logs print `XMTP_ENV` and an invite-domain hint; check them first when
a join never completes.

## 10. Backup & restore

- Snapshot the `convos-data` and `fredy-db` volumes **together** (they form one consistency unit:
  XMTP identity/state + sqlite outbox/seen-ledger). Example:

  ```bash
  docker compose -f deploy/compose.yml down
  docker run --rm -v paris-hunter_convos-data:/a -v paris-hunter_fredy-db:/b -v "$PWD/backup:/out" \
    debian:stable-slim tar czf /out/ph-backup-$(date +%F).tgz -C / a b
  docker compose -f deploy/compose.yml up -d
  ```

- Bucket contents are expendable (see §4) — do not back them up.
- After a restore, boot must NOT re-join the group and must NOT resend old messages (outbox state
  is restored with the DB). `bootstrap.js` reconciles against the remote saved search by ownership
  marker, so a DB restore never creates a duplicate search.

## 11. Alternative ingress: cloudflared (documented, NOT the default)

Instead of exposing 80/443 via Caddy, you can run a Cloudflare Tunnel:

```yaml
# deploy/compose.yml — replace the caddy service with:
cloudflared:
  image: cloudflare/cloudflared:latest
  restart: unless-stopped
  command: tunnel --no-autoupdate run --token ${CLOUDFLARED_TUNNEL_TOKEN}
  depends_on:
    - fredy
# In the Cloudflare Zero Trust dashboard: public hostname <domain> → http://fredy:9998
```

Caveat (why Caddy is the default): Cloudflare terminates TLS at its edge, so an in-stack
`remote_ip` check would see Cloudflare edge IPs, not Stream Estate's. The `144.76.91.183`
allowlist must then move to a Cloudflare WAF/Access policy (match on the true client IP) — or you
accept the secret path as the only gate. Also protect the Fredy UI with Cloudflare Access if you
drop Caddy's basic auth.

## 12. Day-1 checklist

- Compare Stream Estate dashboard usage vs the meta `usage:<month>` counter; set/adjust
  `PH_MONTHLY_ITEM_BUDGET` (§7, E.9).
- Change the Fredy admin password from `admin`/`admin` (the UI is behind Caddy basic auth, but
  still).
- Confirm ZERO notifications happened before `--enable-notifications` (AC2) and that the first
  organic match after it lands in the group.

# paris-hunter — QA runbook & acceptance matrix

Owner: lane 6 (QA harness). Plan precedence: **v3 addendum > v2 > v1** (see
`_orchestra/260709_2141_paris-hunter/`). Delivery guarantee is the **amended §4.4
(v3 A1): at-least-once** — duplicates are permitted ONLY in the crash-at-send-boundary
window and every such resend MUST be WARN-logged (`possible duplicate for <dedupKey>`).
**A duplicate observed without a matching WARN log line is a FAIL.** Decision-level
exactly-once stays strict: at most one `convos_outbox` row per `dedupKey`, ever.

Two strictly separated arms:

- **OFFLINE** — no network, no live creds. Vitest suites (`TEST_MODE=offline yarn test:offline`,
  owned by lanes 2/3/4) + this harness's DB-state tools + the ingest half of the failpoint
  matrix (`CONVOS_ENABLED=false`). Fixture-driven only.
- **LIVE (dev)** — `XMTP_ENV=dev`, disposable convos-cli creator group, real Scaleway bucket.
  NEVER against the real group; NO live Stream Estate calls before §E-1 billing confirmation
  (all Stream Estate traffic stays fixture-driven; the mock API stands in for search PUT/GETs).

## Harness inventory (`tools/paris-hunter/qa/`)

| Tool                               | Purpose                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `fire-webhook.sh <fixture> [opts]` | POST a fixture (or `--synth` payload) at the local webhook route; `--repeat`, `--inject-term`, `--fresh`, `--expect`, `--print-key` |
| `payload.js`                       | fixture loader / synthetic payload builder + mutations (used by fire-webhook)                                                       |
| `db.js <cmd>`                      | DB-state CLI: `tables`, `get/set-meta`, `inbox-row`, `outbox-row`, `counts`, `assert-final`, `qa-seed-watermark`, `qa-ensure-job`   |
| `replay-inbox.js`                  | reset inbox rows undone/unleased; `--assert-once <key>` exactly-once prover; `--requeue-dead-letter` (v3 A8)                        |
| `latency-report.js`                | webhook receipt → `sent_at` join on `ph.dedupKey`; asserts p95 < 30 s                                                               |
| `requeue-outbox.js`                | list/requeue `parked` outbox rows (v2 #15 operator tool)                                                                            |
| `failpoint-run.sh`                 | PH_FAILPOINT kill/restart matrix runner (v2 #14, v3 A1/A12)                                                                         |
| `live-qa.sh <phase>`               | live E2E driver (contract §9 recipe + all live matrix rows)                                                                         |
| `mock-stream-estate.js`            | stateful mock API (search PUT/GET recorder) for the budget drill                                                                    |
| `_lib.sh`                          | shared shell helpers                                                                                                                |

Node tools are invoked `node --env-file-if-exists=.env tools/paris-hunter/qa/<tool>.js`
(v2 #12 convention). Exit codes: `0` pass · `1` assertion failure · `2` not-ready/blocked
(lane not landed, prerequisite missing) · `3` usage error.

Fixtures: the normative payloads are lane 2's `test/mocks/streamEstate/*.json` — the harness
uses them when present. `--synth` generates shape-equivalent payloads (from the documented
webhook example) for plumbing/failpoint/live runs; synthetic payloads are NOT the behavior
spec and are labeled `[QA SYNTHETIC PAYLOAD]` in their description.

## Failpoint kill matrix (v2 #14, expectations restated per v3 A1/A12)

Runner: `tools/paris-hunter/qa/failpoint-run.sh [--mode offline|live]`.
Per boundary: arm `PH_FAILPOINT=<name>` → fire ONE fresh synthetic match → process exits 137
(`FAILPOINT <name>` marker) → restart WITHOUT the env → assert within 90 s:

| Failpoint            | Mode         | Expected terminal state                                                                                                             |
| -------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `after_inbox_insert` | offline+live | STRICT: inbox row done, `ph_seen`=1, outbox=1, one message pair (live)                                                              |
| `after_claim`        | offline+live | STRICT + restarted boot log MUST contain the dead-lease recovery line (`recovered N dead lease(s)`, v3 A2/A12); 90 s budget stands  |
| `after_decision_tx`  | offline+live | STRICT (decision committed; restart only delivers)                                                                                  |
| `after_upload`       | live         | STRICT single pair (`enc_meta` persisted once, reused — v2 #15)                                                                     |
| `after_image_send`   | live         | RESIDUAL: killed leg may appear 2× on creator stdout; resend MUST happen; `possible duplicate` WARN MANDATORY; other leg exactly 1× |
| `after_text_send`    | live         | RESIDUAL: same as above with legs swapped                                                                                           |

Duplicate without the WARN = FAIL (v3 A1). Offline mode covers the three ingest boundaries
(adapter off); the send boundaries are covered offline by lane 3's mocked-XMTP vitest
state-machine tests and live by this runner at CP3.

## Acceptance matrix (brief §7 → concrete verification)

| #   | Criterion                                                              | Verification (command → expected)                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | New matching listing → group message (photo + scored text) < 5 min     | `live-qa.sh first-send`: fire fresh synth match → attachment event + text event on creator stdout ≤ 90 s; `download-attachment` round-trips bytes; `latency-report.js` p95 < 30 s (webhook→send leg). **Real-world arm (v2 #18, CP5):** post-billing 48 h VPS observation — ≥3 organic matches, portal `publishedAt` vs `sent_at`, median < 5 min                                                                 |
| AC2 | First deploy produces ZERO notifications                               | `live-qa.sh silent` on a FRESH DB: 3 fires unseeded → 0 messages, decisions `suppressed:unseeded`; plus (A5) `bootstrap.js --enable-notifications` REFUSES without watermark/`seededAt` and without a 200 from `GET .../health` (see below)                                                                                                                                                                       |
| AC3 | Price drop on known listing → exactly one re-notification              | `live-qa.sh exactly-once`: drop event ×3 → exactly 1 message starting `⬇️ baisse de prix`; increase → 0; dedup key per v3 A9 (`se:<uuid>:price:<eventAtMs>:<old>-><new>`) so a later distinct re-drop DOES notify again                                                                                                                                                                                           |
| AC4 | meublé/coloc/out-of-budget/out-of-area (+ fail-closed) never notify    | `live-qa.sh exclusions`: canonical fixtures (meublé regex, `furnished===true` structured, out-of-band, missing-rooms → `quarantine:rooms`, missing-price → `quarantine:price`, unknown-shape) + one arm per term (colocation, bail mobilité, courte durée, sous-location, saisonnier) → 0 messages + correct `decision`; `non meublé` counter-case notifies. Offline: lane 2's filter vitest on the same fixtures |
| AC5 | Monthly Stream Estate cost single-digit €                              | NOT machine-testable pre-live. Day-1 (CP5): compare meta `usage:<YYYY-MM>` (`db.js get-meta`) with the Stream Estate dashboard; calibrate `PH_MONTHLY_ITEM_BUDGET` (§E.9)                                                                                                                                                                                                                                         |
| AC6 | Identity survives restarts; no re-join, no dup-client corruption       | `live-qa.sh restart`: SIGTERM restart → no `member_joined`, sends land; SIGKILL + immediate restart → lock acquired, no re-join, any resend has the WARN; second process on same `CONVOS_DATA_DIR` exits non-zero. **Backup-restore drill** (manual, below)                                                                                                                                                       |
| —   | At-least-once, duplicates only at crash boundary (amended §4.4, v3 A1) | (a) normal-path replays: `fire-webhook.sh ... --repeat 3` → 1 pair; `replay-inbox.js --assert-once` → outbox=1, seen=1; (b) `failpoint-run.sh` send boundaries → resend + WARN; (c) duplicate w/o WARN = FAIL (both scripts enforce)                                                                                                                                                                              |
| —   | Webhook→send latency < 30 s (brief §4.5)                               | `latency-report.js` over the live session; p95 < 30 s                                                                                                                                                                                                                                                                                                                                                             |
| —   | Silent JOIN (contract §5)                                              | `live-qa.sh adapter`: 0 group messages between `member_joined` and the first fired listing                                                                                                                                                                                                                                                                                                                        |
| —   | Watermark boundary (v3 A4)                                             | `live-qa.sh watermark`: `event_at == cutoffMs` → `suppressed:watermark`; `cutoffMs + 1 s` → notifies                                                                                                                                                                                                                                                                                                              |
| —   | Budget ceiling (v2 #13, v3 A7)                                         | `live-qa.sh budget`: `PH_MONTHLY_ITEM_BUDGET=3`, 4 fires → usage=4, 70% warn, `disable_required` set; PUT `notificationEnabled:false` + GET-verify recorded by `mock-stream-estate.js` (requires the API-base override, see "requests")                                                                                                                                                                           |
| —   | Dead-letter + parked recovery (v3 A8, v2 #15)                          | poison payload → decision `dead-letter:<class>` after 5 attempts → `replay-inbox.js --requeue-dead-letter` reprocesses; parked outbox rows → `requeue-outbox.js --all` → flush retries                                                                                                                                                                                                                            |

**Health endpoint (v3 A5):** `curl -s -o /dev/null -w '%{http_code}' "$BASE/api/webhook/stream-estate/$SECRET/health"`
→ `200`; with a wrong secret → `404`.

## Live E2E runbook (CP3; contract doc §9 scripted)

```bash
Q=tools/paris-hunter/qa
$Q/live-qa.sh preflight        # tools + env sanity (safe anytime)
$Q/live-qa.sh creator          # scratch CONVOS_HOME + convos-cli 0.10.14 agent serve → invite
$Q/live-qa.sh adapter          # scratch CONVOS_DATA_DIR, silent-join assert (local DB moved aside)
$Q/live-qa.sh silent           # AC2 (unseeded → 0 sends)
$Q/live-qa.sh first-send       # AC1 + Scaleway blob GET + StorageClass + round-trip + latency
$Q/live-qa.sh watermark        # A4 boundary spot-checks
$Q/live-qa.sh exactly-once     # AC3 + normal-path replay guarantees
$Q/live-qa.sh exclusions       # AC4 arms
$Q/live-qa.sh restart          # AC6 (TERM, KILL, stale lock, double-process)
$Q/live-qa.sh budget           # #13/A7 drill (see requests below)
$Q/live-qa.sh failpoints       # full live failpoint matrix
$Q/live-qa.sh teardown         # explode conversation, restore DB, delete QA blobs
```

Notes: never the machine's global `convos` (0.9.1, obsolete identity model) — the harness
uses the repo-pinned `node_modules/.bin/convos` (0.10.14). Photo QA runs against the REAL
Scaleway bucket; uploaded QA blob URLs are recorded and deleted at teardown. Synthetic
payloads default to a public `picsum.photos` image (override: `--photo <url>`); the SSRF
suite's hostile URLs live in lane 3's offline tests.

### Backup-restore drill (AC6 arm, v2 #18 — manual, needs lane 5 compose)

1. After a green `first-send`, `docker compose -f deploy/compose.yml stop` (or accept
   crash-consistency), snapshot the `convos-data` + `fredy-db` volumes together.
2. `docker compose down` + wipe containers, restore both volumes from the snapshot, `up -d`.
3. Assert: boot healthy; NO `member_joined` on creator stdout (no re-join); no duplicate
   sends (creator message count unchanged); `bootstrap.js` reconcile finds the existing
   search (v2 #6) — run with `--dry-run` and check it reports 1 owned search, PUT-converge.

## Execution status (authored 2026-07-09, pre-CP2)

Runs GREEN today (against CP0 + lane-1 addendum stubs):

- `payload.js` all fixtures via `--synth` + mutations; `fire-webhook.sh --synth --expect 501`
  against the stub route; `db.js tables` → clean `NOT READY` exit 2; `replay-inbox.js` /
  `latency-report.js` / `requeue-outbox.js` not-ready paths; `live-qa.sh preflight`.

Awaits lane 2 (migration 22 + provider + route): everything DB-asserting, ingest failpoints,
decisions. Awaits lane 3: send-side failpoints, live phases. Awaits CP2 (integration):
full matrix execution → results to `_orchestra/.../260709_XXXX_qa-results.md`.

Requests to other lanes (tracked in lane6-notes):

1. **lane 2:** export a pure `computeConfigRev()` (provider or inbox module) so
   `db.js qa-seed-watermark` can mint a gate-valid watermark offline (v3 A5 binds the
   watermark to searchId+configRev; without the export the gate suppresses QA fires).
2. **lane 2:** an env override for the Stream Estate API base (e.g. `STREAM_ESTATE_API_BASE`)
   so the budget drill's PUT+GET-verify can hit `mock-stream-estate.js` instead of production.
3. **lane 2/3 (wording locks):** dead-lease recovery log must match
   `recovered N dead lease(s)`; duplicate WARN must contain `possible duplicate`
   (both are pass-criteria greps; adjust `failpoint-run.sh`/`live-qa.sh` if wording differs).

# paris-hunter

Automated Paris rental hunt for lourou + the group. A thin fork of
[Fredy](https://github.com/orangecoding/fredy) (merged at upstream `428977e`, v22.9.7)
that turns Stream Estate saved-search webhooks into scored listing messages in a
Convos (XMTP) group — first photo as attachment + a French scored summary.

Target: a matching listing published anywhere → group message in **< 5 minutes**
(dominated by upstream publication delay). The webhook→message leg is live-QA-proven
at **p95 ≈ 1.8 s** (budget: 30 s).

## Architecture

```
Stream Estate saved search (server-side filters)
        │  webhook: POST /api/webhook/stream-estate/<secret>/{match,event}
        ▼
Fredy web server ──▶ stream_estate_inbox (durable sqlite queue)
        ▼
provider streamEstate ── normalize → hard exclusions → price/rooms/zip guard
        ▼
scoring: €/m² + cap-ratio vs per-arrondissement cap table
        ▼
notification adapter convos ── outbox (at-least-once) ──▶ XMTP group message
                                    └──▶ Scaleway bucket (ciphertext photo blobs)
```

Thin-fork design: everything ours is additive — `lib/services/paris-hunter/**`
(config, scoring, cap table, exclusions, inbox, budget guard, message format),
the `lib/provider/streamEstate.js` provider (webhook-fed, API-only, no Chromium —
`FREDY_SKIP_CHROMIUM=true` skips the CloakBrowser download), the
`lib/notification/adapter/convos.js` adapter (XMTP send-only participant with a
durable outbox), and `tools/paris-hunter/**`. Upstream files carry only a register
line plus guards, so upstream rebases stay cheap (see Fork maintenance below).

## Search criteria (current config)

Defaults live in `lib/services/paris-hunter/phConfig.js`; all overridable via
`PH_*` env vars (see `.env.example`).

- **Location:** Paris 9e, 10e, 11e, 12e, 13e, 17e + 20e (75009, 75010, 75011,
  75012, 75013, 75017, 75020). Secondary zones to enable later: 3e, 4e.
- **Type:** apartment, **unfurnished** (location nue, bail loi 1989), long-term.
- **Rooms:** 3–4 pièces. **Price:** €2,000–3,100/month **hors charges**.
  Surface: no hard filter (used for scoring only).
- **Hard exclusions (regex post-filter):** meublé, colocation/coloc, bail
  mobilité, courte durée, sous-location, saisonnière.
- **Scoring (flag, don't decide):** `pricePerM2 = priceHc / surface`;
  `capRatio = pricePerM2 / cap` where the cap approximates the *loyer de
  référence majoré* per arrondissement (€/m², `capTable.js`):
  `{11e: 34, 12e: 32, 10e: 33, 20e: 30, 3e: 38, 4e: 39, 9e: 34, 13e: 31, 17e: 33}`.
  Flags: `OVER_CAP` if capRatio > 1.05 · `GOOD_DEAL` if < 0.85 ·
  `NO_SURFACE` if surface missing · `BAIL_6_ANS` (premium, 🏛️) if the text
  advertises an institutional 6-year lease.

Price-decrease events on a known listing re-notify once, with a distinct
"⬇️ baisse de prix" format.

## Ops

**`docs/DEPLOY.md` is the source of truth** — VPS runbook (docker-compose stack,
Fredy behind Caddy with TLS + webhook IP allowlist — the admin UI is Tailscale-only,
never internet-exposed — exact first-boot order that guarantees the silent first
run, single-writer discipline, backup/restore). §0 is a copy-paste quickstart
(fresh VPS → running stack).

- `docs/QA.md` — QA harness, failpoint kill matrix, acceptance matrix, live E2E runbook.
- `docs/BRIEF-paris-hunter.md` — original product brief.
- `tools/paris-hunter/` — `bootstrap.js` (saved search create/reconcile/enable),
  `seed.js` (mark existing market as seen), `setup-bucket.js` (bucket lifecycle),
  `qa/` (harness). Invoke with `node --env-file-if-exists=.env …` outside docker.
- `.env.example` — every env var, documented. Local run: `yarn start:paris-hunter`.
- **Reading the logs:** `tools/paris-hunter/logs.sh` gives readable, filtered views
  of the running stack (details in `docs/DEPLOY.md`):

  ```bash
  tools/paris-hunter/logs.sh              # webhooks: real deliveries + pipeline decisions, scanner noise hidden (default)
  tools/paris-hunter/logs.sh all          # everything, Caddy JSON compacted to one line each
  tools/paris-hunter/logs.sh errors       # only non-2xx + Fredy warnings/errors
  tools/paris-hunter/logs.sh webhooks --since 1h
  ```
- **Budget guard:** `PH_MONTHLY_ITEM_BUDGET` (default 900 items/month ≈ €9
  Stream Estate PAYG) — WARN logs from 70%, and at 90% the app **auto-disables
  the saved search** on the Stream Estate side; re-arm flow in `docs/DEPLOY.md` §7.
- **Attachments:** photo blobs live in the Scaleway bucket `paris-hunter`
  (fr-par) — ciphertext of downscaled photos (XMTP remote-attachment scheme),
  public-read, `ONEZONE_IA`, 180-day lifecycle (rule `ph-attachments-180d`,
  applied by `setup-bucket.js`). Expendable: losing them only breaks the image
  bubble of old messages.

## Notification semantics (honesty note)

Delivery is **at-least-once**. Decision-level exactly-once is strict (at most one
outbox row per dedup key, ever), but the XMTP SDK has no send idempotency: a crash
exactly between a network send and its state write can produce one duplicate
message. Every such resend is WARN-logged (`possible duplicate`) — a duplicate
without that log line is a bug.

## Fork maintenance

- Upstream: https://github.com/orangecoding/fredy, merged at `428977e` (v22.9.7),
  remote `upstream`, branch `master`.
- Rebase: `git fetch upstream && git merge upstream/master`. Our code is additive
  plugin files, so conflicts should be ≈ zero.
- This `README.md` is protected from upstream merges via `.gitattributes`
  (`README.md merge=ours`). The `ours` merge driver must be enabled **once per
  clone**: `git config merge.ours.driver true`.
- The upstream README is preserved verbatim at `README-fredy-upstream.md`
  (Fredy's own docs: providers, adapters, UI, general usage).
- `ui/src/components/map/Map.jsx` intentionally diverges from upstream (Paris
  default center/zoom, `FRANCE_BOUNDS` instead of `GERMANY_BOUNDS`); rebases may
  conflict there — resolve by keeping the France bounds.
- Geocoding intentionally diverges from upstream (which is Germany-only):
  - `lib/services/geocoding/geoCodingService.js` routes BAN
    (api-adresse.data.gouv.fr, our additive `client/banClient.js`) first,
    Nominatim as fallback; paused only when both geocoders are paused. It also
    adds `geocodeListing` — the listing precision ladder: BAN street tier on
    the provider's `geocodeHint` (street extracted from listing text,
    postcode-paired, accepted only at street/housenumber precision) → native
    payload coordinates → free-text address fallback.
  - `lib/services/geocoding/client/nominatimClient.js` replaces the hardcoded
    `&countrycodes=de` with the optional `GEOCODER_COUNTRY` env (default unset
    = worldwide).
  - `lib/FredyPipelineExecutioner.js` `_geocode` delegates to `geocodeListing`
    instead of always geocoding `listing.address`.
  Rebases may conflict in those three files — resolve by keeping our versions.

## v2 backlog (out of scope, see brief §6)

- Real DRIHL encadrement grid (80 quartiers × rooms × era) + quartier point-in-polygon.
- Two-way group commands ("ok"/"non"/"visite" replies → status; deterministic reply parsing, no LLM).
- Stream Estate MCP tool for free-form queries in the group.
- Custom sources for institutional landlord portals (YouFirst/Gecina, CDC Habitat).
- Optional TanStack Start dashboard, only if the group-chat CRM proves insufficient.

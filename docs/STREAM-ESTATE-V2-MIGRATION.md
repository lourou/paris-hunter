# Stream Estate V2 migration guide

> **STATUS — DECISION 2026-07-13: STAY ON V1.** V1 is proven and remains available until approximately May 2027. Do **not** migrate yet; use this guide when a migration trigger fires.
>
> **Current live setup:** V1 REST + webhooks, ingress protected by the `144.76.91.183` IP allowlist and a secret URL path, €0.01/item PAYG, balance positive.

This is the permanent implementation and cutover plan for moving paris-hunter from Stream Estate V1 to the V2 beta. It records the API findings and repository impact known on 2026-07-13. Revalidate beta behavior, pricing, and schemas before implementation.

## Why migrate

- **Signed webhooks.** V2 supplies HMAC-SHA256 signatures; V1 has no signature and relies on a secret path plus source-IP filtering.
- **Opaque cursor pagination.** V2's stable cursor removes the overlapping/manual pagination failure mode behind the July 2026 incident: 11,580 billed items for about 450 unique properties, costing approximately €133.
- **Recovery primitives.** Alert match history and event-notification records provide a server-side ledger for reconciliation after receiver downtime or exhausted retries.
- **Richer criteria.** Recursive criteria trees, explicit feature membership, price-change direction, charge metadata, and missing-value controls are more expressive than V1 saved searches.

## Why not yet

- `GET /account/api-usage` returns `401 {"code":401,"message":"JWT Token not found"}` when called with the otherwise-valid V2 API key. Budget auto-disable parity depends on reconciling against official usage, so account API-key auth is a release blocker. `/account/event-destinations` has the same problem.
- Exhausted V2 webhook retries suspend the destination. Migration needs a watchdog that detects suspension and a tested authenticated reactivation runbook; the current watchdog does neither.
- V2 webhook egress IPs are undocumented. The current Caddy `remote_ip 144.76.91.183` gate would silently reject V2, so the gate must move to application-level HMAC verification.
- Beta documentation and schemas are still changing quickly (docs were at v0.1.92 on 2026-07-01).
- No V2 price sheet or definitive billable-unit policy is published.

## MIGRATE-WHEN triggers

Migrate when **any** hard trigger fires, provided **all** readiness gates hold.

### Hard triggers — any one

1. Stream Estate announces V1 deprecation or V2 GA. In all cases, start no later than **Q1 2027**: V1 EOL is expected around May 2027, and the migration needs at least two months of production soak.
2. Published V2 pricing is at or below V1's effective cost for this workload (under €20/month), or Stream Estate announces that the unbilled beta window is closing. Complete the free reseed before that window closes; an earlier rehearsal reseed is reasonable while it remains free.
3. The project chooses to require HMAC-authenticated delivery. HMAC is the largest security improvement, and V2 has no documented egress IPs with which to preserve the current Caddy gate.

### Readiness gates — all required

- `/account/api-usage` and `/account/event-destinations` accept `X-API-KEY`; they returned `401 JWT Token not found` on 2026-07-13. This is required for budget parity, destination reconciliation, signing-key rotation, and suspension recovery.
- Criteria echo is verified live by creating an alert, reading it back, and diffing the stored criteria.
- `PRICE_CHANGED` with `thresholdDirection: "DECREASE"` is verified with a real beta price-drop delivery.
- Documentation/schema churn has slowed; recheck the changelog cadence from the v0.1.92 baseline.

## Key V2 API deltas

### Auth, base URL, and representation

- Send the V2 key in `X-API-KEY`. V1 keys do not work in V2; generate a separate V2 key.
- Use `https://api-v2.stream.estate`.
- V2 data responses use JSON:API (`application/vnd.api+json`) rather than V1 Hydra/JSON-LD. Collection and resource parsing must follow the actual V2 `data` shape.
- Data endpoints were partially verified on 2026-07-13: `GET /alerts` returned 200 with the V2 key, while the two tested `/account/*` endpoints returned the JWT 401 above.

### Alert criteria

V1 searches become V2 alerts. Criteria can be recursive `and`/`or` trees; this search needs a single property leaf. The following maps the current repository defaults in `phConfig.js`, including the widened seven-arrondissement search and deliberately wider server-side displayed-price band:

```json
{
  "property": {
    "type": { "in": ["FLAT"] },
    "transaction": { "type": "RENT" },
    "pricing": {
      "displayed": { "gte": 1900, "lte": 3350 }
    },
    "unit": {
      "rooms": { "gte": 3, "lte": 4 },
      "features": { "nin": ["FURNISHED"] }
    },
    "locations": {
      "countryCode": "FR",
      "in": {
        "postalCodes": [
          "75009",
          "75010",
          "75011",
          "75012",
          "75013",
          "75017",
          "75020"
        ]
      }
    }
  }
}
```

The €1,900–€3,350 `pricing.displayed` band is intentionally wider than the local €2,000–€3,100 hors-charges filter because advertised prices may include charges. Keep the strict HC decision in the existing local filter. Environment overrides remain authoritative at runtime.

Configure notifications for `NEW_MATCH` and `PRICE_CHANGED` with `thresholdDirection: "DECREASE"`. Leave `ADDITIONAL_LISTING`, `ANY_ATTRIBUTE_CHANGED`, `LISTING_EXPIRED`, and `LISTING_REACTIVATED` disabled initially.

### Webhook envelope and verification

V2 sends match and lifecycle events to one endpoint. The envelope is:

```json
{
  "eventType": "NEW_MATCH",
  "eventId": "<idempotency-key>",
  "alert": { "id": "<alert-id>", "name": "<alert-name>" },
  "listing": { "id": "<listing-id>" },
  "data": {
    "id": "<property-id>",
    "property": {},
    "publishers": [],
    "listings": []
  }
}
```

Verify every delivery before JSON parsing:

1. Capture the exact raw request-body bytes. Fastify needs a raw-body hook or content-type parser installed before its JSON parser consumes the stream.
2. Read `X-Webhook-Timestamp` as Unix seconds and reject timestamps outside a ±300-second window.
3. Read `X-Webhook-Signature`, require the `sha256=` prefix, and hex-decode the remainder.
4. Compute `HMAC-SHA256(signingKey, timestamp + "." + rawBodyBytes)`.
5. Compare expected and supplied bytes with a constant-time comparison, including an equal-length check.
6. Only then parse and validate JSON. Persist `eventId` as the delivery idempotency key and skip repeats.

Keep the secret URL path as defense in depth. The `whsec_...` signing key is returned **once**, when the webhook destination is created; persist it immediately in secret storage. Rotation invalidates the old key immediately, although in-flight retries can still carry it, so plan a short dual-key acceptance window.

### Cursor contract

Seed and backfill with `POST /properties`:

```json
{
  "paginationType": "CURSOR",
  "size": 100,
  "cursor": null,
  "criteria": { "property": {} },
  "sort": { "field": "CREATED_AT", "direction": "ASC" }
}
```

Use the complete criteria tree above. The response is `{items, totalItems, hasNextPage, cursor}`. Echo the opaque cursor verbatim with identical size and criteria; stop only when `hasNextPage === false`. The maximum size is 100. Keep the page-count safety valve. A `size: 1` first request can expose `totalItems` for progress and a preflight budget check. Do not construct page numbers or date windows.

### Match history and delivery state

- `GET /alerts/{alertUuid}/events` provides the alert event history.
- `GET /event-notifications` exposes delivery status, attempts, and errors.
- After five retry attempts over roughly 2.6 hours, the destination becomes `SUSPENDED`; all later notifications remain suspended until `POST /account/event-destinations/{id}/reactivate` succeeds.
- The watchdog must detect silence/suspension, reconcile the histories, and make reactivation an explicit operator action.

### Billing unknowns

V2 usage reports expose both calls and results, grouped by key, route, and channel. Webhook payloads are documented as avoiding an extra billed API call, but webhook billing itself is unspecified. Before cutover, obtain the V2 price sheet, precise billable units, beta-to-GA date, and confirmation that beta usage will not be billed retroactively. Keep the local atomic delivery counter, and reconcile it against `/account/api-usage` once API-key auth works.

## Migration surface

All paths are repository-relative.

| File | Change | Effort |
|---|---|---:|
| `lib/provider/streamEstate.js` | Rewrite `phNormalize` for the V2 envelope and `data.property`/`publishers`/`listings` paths; use `eventId` for event idempotency while retaining `se:<propertyId>` match dedup; update `metaInformation.baseUrl`. The server-side decrease rule makes `skip:price_increase` optional, but retain it initially as a defensive check. | **1.5–2 d** |
| `lib/api/routes/streamEstateWebhookRoute.js` | Collapse match/event routes into one event-type route; capture raw bytes; add HMAC, constant-time comparison, and timestamp checks; retain the secret path; replace the schema and add the `whsec_` environment secret. | **1 d** |
| `lib/services/paris-hunter/searchConfig.js` | Build a V2 alert with the criteria, notification rules, and destination; hash the new canonical body; rename the ownership marker from `[ph:v1]` to `[ph:v2]`. | **0.5 d** |
| `lib/services/paris-hunter/budget.js` | Replace V1 search GET/PUT and `notificationEnabled:false` with V2 alert GET/PUT and `enabled:false`; parse JSON:API; default the base to V2 and verify the echoed state. | **0.5 d** |
| `tools/paris-hunter/bootstrap.js` | Reconcile JSON:API alerts and account-level destinations; recreate destinations when URLs change; capture and immediately persist the one-time signing key; enable with alert PUT. Blocked until account API-key auth works. | **1 d** |
| `tools/paris-hunter/seed.js` | Replace the V1 `hydra:next` walk with the V2 cursor loop at size 100; preserve maximum-page and budget preflight guards. | **0.5–1 d** |
| `tools/paris-hunter/qa/mock-stream-estate.js`, `tools/paris-hunter/qa/payload.js`, `test/services/paris-hunter/fixtures/stream-estate-search-echo.json`, and Stream Estate/paris-hunter tests | Model JSON:API alert CRUD, cursor pages, event destinations, signed deliveries, and HMAC vectors; recapture fixtures from beta. Affected tests include `test/provider/streamEstate.test.js`, `test/api/streamEstateWebhook.test.js`, and `test/services/paris-hunter/{bootstrapSeed,budget,phConfig,inbox}.test.js`. | **1–1.5 d** |
| `deploy/Caddyfile`, `deploy/Caddyfile.local`, `docs/DEPLOY.md` | Remove or replace the V1 `remote_ip 144.76.91.183` gate; make verified HMAC the V2 ingress gate. | **0.25 d** |
| `lib/services/paris-hunter/phConfig.js`, `.env`, `.env.example`, `docs/BRIEF-paris-hunter.md` | Add a V2 API key, webhook signing key, and base URL configuration. | **0.25 d** |
| `lib/services/paris-hunter/inbox.js` | Set `external_id` from `data.id` and derive inbox kind from `eventType`; timestamp normalization remains unchanged. | **0.25 d** |

Estimated total: **about 4–6 engineer-days**, including mock-driven QA and a live cutover rehearsal.

Explicitly unchanged: the Convos adapter and notifications (`lib/notification/**`), scoring, exclusions, message formatting, the Convos outbox and flush path, watchdog core, BAN geocoding, database schema/migrations, and `FredyPipelineExecutioner`. Search ID, watermark, config revision, and related metadata values are re-minted, but the tables do not change. The inbox drain, lease, transaction, and decision machinery remains intact.

## Cutover sketch

1. Create the V2 event destination and immediately persist its signing key; create the V2 alert with `enabled:false`.
2. Deploy the HMAC-ready receiver in a dual-accept mode: continue accepting V1 secret-path match/event deliveries and accept only correctly signed V2 deliveries on the V2 path.
3. Seed all current V2 matches through the cursor endpoint while notifications remain disabled.
4. Mint a new watermark bound to the V2 alert ID and V2 canonical `configRev`.
5. Set the V2 alert to `enabled:true` and verify the first live signed delivery end to end.
6. Set the V1 search to `notificationEnabled:false`, observe the V2 path for a short window, then delete the V1 search.
7. After the observation window, remove V1 route acceptance, credentials, configuration, and reconciliation code.

V1 UUIDs and V2 property IDs are different ID spaces. Cross-version deduplication cannot be assumed, so keep the dual-delivery overlap to hours and rely on the newly minted watermark to suppress old V2 inventory.

## Questions for Stream Estate support

1. Why do `/account/api-usage` and `/account/event-destinations` require a JWT when the documentation says `X-API-KEY` works, and when will API-key access be fixed?
2. What is the V2 price sheet, what exactly is billed (calls, returned results, webhook deliveries), when does beta billing become GA billing, and can beta usage be billed retroactively?
3. Are V2 webhook egress IPs stable and published? If so, what are the production and sandbox ranges?
4. Does alert creation backfill existing matching properties, or does it emit only future matches? Confirm whether a separate seed is mandatory.

The beta bug list, including the account-auth failures, was sent to Stream Estate on **2026-07-13**. Reconcile support's answers into this document before implementation.

## What I noticed / gotchas

- **Write-only-field history:** V1 omitted fields such as `includedZipcodes` and `roomMax` from GET responses. V2 claims to echo the stored criteria document, but do not trust echo-based reconciliation until a create→GET diff succeeds. Continue treating the locally canonical PUT body as identity.
- **Furnished missing-value semantics:** `features.nin:["FURNISHED"]` passes both explicitly unfurnished and missing feature data. The existing structured and regex client filters remain load-bearing.
- **One-shot signing key:** the webhook signing key is returned only once at destination creation. Persist it immediately or it is lost; recovery means rotation, with operational consequences for in-flight retries.
- **Mandatory reseed:** changing the canonical search body to V2 changes `configRev`; the alert ID also changes. Watermark validation therefore fails closed automatically. This is correct—reseed and mint a new watermark before enabling V2.
- **No cross-version dedup:** V1 and V2 IDs differ, so `se:<v1 uuid>` cannot suppress `se:<v2 property id>`. Control duplication with a short overlap and the V2 watermark, not an assumed ID mapping.

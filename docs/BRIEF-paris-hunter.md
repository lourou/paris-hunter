# paris-hunter — Executive Brief for the Coding Agent

**Mission.** Automated Paris rental hunt for a small group. Pipeline: **Stream Estate (data) → Fredy (engine) → Convos agent (notifications in a group chat)**. Target: a matching listing published anywhere → scored message in the Convos group in **< 5 minutes**.

---

## 1. Locked decisions — do not relitigate

| Topic | Decision |
|---|---|
| Data source | **Stream Estate** (operates the ex-Melo API): REST + real-time webhooks + MCP server. ~1,500 French sources, ~50k new listings/day, property-level dedup. **Pay-as-you-go** plan (€0.01/item). The Melo web SaaS subscription is NOT part of the pipeline. |
| Engine | **Fredy** — github.com/orangecoding/fredy (Node.js flat-hunting bot, provider + notification-adapter architecture). Fork or extend. |
| Notifications | **Convos (XMTP) agent**, running **in-process inside Fredy** as a notification adapter, with its own agent identity, posting to a group chat (the group members + agent). Signal/Hermes, Discord, Telegram: all rejected. |
| Runtime | One long-lived Node process (Fredy + XMTP client). Deploy on Fly.io/Railway/VPS. An earlier Cloudflare Workers pipeline sketch exists in history — **superseded**, ignore it. |
| Internal repos | The dev agent has read access to closed-source Convos/Ephemera agent repos. **Mine them for patterns** (identity provisioning, group consent/join, rich message format, deployment). Read for inspiration only — never vendor closed-source code into this repo. |

## 2. Search criteria (initial config, keep configurable)

- **Location:** Paris 11e + 12e (75011, 75012). Secondary zones to enable later: 10e, 20e, 3e, 4e.
- **Type:** apartment, **unfurnished** (location nue, bail loi 1989), long-term.
- **Rooms:** 3–4 pièces. **Price:** €2,500–3,100 /month **hors charges**. Surface: no hard filter (expect ~65–100 m²; used for scoring).
- **Hard exclusions (regex post-filter):** meublé, colocation/coloc, bail mobilité, courte durée, sous-location, saisonnière.

## 3. Architecture

```
Stream Estate saved Search (server-side filters)
        │  webhook: new Match (property-level, deduped) + Events (price decrease)
        ▼
Fredy web server — inbound webhook route   [fallback: cursor-based polling every 2–3 min]
        ▼
provider `stream-estate` → normalize → local post-filter (exclusions + price/rooms/arrondissement guard)
        ▼
scoring: €/m² + cap-ratio vs encadrement
        ▼
notification adapter `convos` → XMTP group message
```

- **Provider `stream-estate`:** create the saved Search via their API with every filter they support server-side; consume via **webhook** (optimal for both latency and PAYG billing). Polling fallback must use a strict `since`/cursor to avoid re-billing overlaps.
- **Events:** subscribe to price-decrease events on the search → re-notify with a distinct "⬇️ baisse de prix" format.
- **Scoring v1 (heuristic, flag don't decide):** pricePerM2 = priceHc / surface; capRatio = pricePerM2 / approx *loyer de référence majoré* (location nue): `{11e: 34, 12e: 32, 10e: 33, 20e: 30, 3e: 38, 4e: 39, 9e: 34}` €/m². Flags: `OVER_CAP` if capRatio > 1.05, `GOOD_DEAL` if < 0.85, `NO_SURFACE` if surface missing.
- **Message format (mobile-first, everything actionable on one screen):** first photo as attachment + `🏠 3P · 72 m² · 2 850 € HC · 39,6 €/m² ⚠️ > plafond` / `📍 Paris 11e — Charonne` / title / `📞 phone` if present / `🔗 url`.
- **State:** use Fredy's built-in listing store for v1. If a custom store becomes necessary, preference: SQLite (Drizzle; Turso if hosted). Keep a local `(source, externalId)` uniqueness guard even though Stream Estate dedupes — it protects the polling fallback.
- **Convos adapter contract (v1 = send-only participant, NOT a conversational agent):** dedicated agent identity (not Hermes, not reused elsewhere). Bootstrap: a one-shot Convos **invite URL** provided via env/config → on first run, redeem it, join the group, persist `conversationId` + identity state; all subsequent runs load state and send — never re-redeem the URL on boot. Inbound-message handler stays empty, but the XMTP client's **sync loop must keep running** (group membership/epoch state must stay current even for a mute participant). On boot, health-check group membership: if the agent is no longer a member (group recreated / agent removed), fail loudly and wait for a new invite — never drop notifications silently. Fallback if invite links aren't redeemable headlessly: add the agent's inboxId to the group manually from the app; persisted membership is the only outcome that matters.

## 4. Critical behaviors

1. **Silent first run.** On first deploy, seed all existing matches as "seen" WITHOUT notifying. A notification storm into the group is the failure mode to avoid at all costs.
2. **Single writer on the XMTP identity.** Exactly one process owns the agent's XMTP client and its local state. No second instance, ever.
3. **Consent/join flow.** The agent must be properly joined/consented in the group before sending — extract the exact flow from the internal repos.
4. **Exactly-once notifications.** New match → one message. Price drop → one re-notification. Nothing else re-notifies.
5. **Latency budget:** webhook receipt → group message < 30 s (the < 5 min target is dominated by upstream publication delay).

## 5. Day-1 verifications (blocking)

- [ ] Exact billable definition of **"item"** (advert vs property vs delivered event) — docs or support. Expected monthly cost at our volume: single-digit €; if projections exceed ~€20/month, something is misconfigured.
- [ ] Does the saved Search support **furnished=false server-side**? If not, rely on local post-filter.
- [ ] Webhook payload schema + **auth/signature verification** per their docs.
- [ ] Ingest the docs via **`docs.stream.estate`** (an `llms.txt` index is published). Their **MCP server** can be used interactively during development to explore schema and test filters.

## 6. v2 backlog — explicitly out of scope now

- Real DRIHL encadrement grid (80 quartiers × rooms × construction era, annual arrêté, open data) + quartier geojson point-in-polygon.
- Two-way group commands ("ok" / "non" / "visite" as replies to a listing → status update; the group chat becomes the couple's CRM). Implement as **deterministic reply parsing** (regex on quoted replies) — no LLM required.
- Stream Estate MCP tool for free-form queries in the group ("un 4P sous 2 900 cette semaine ?") — the only feature that ever needs a model; keep it a scoped in-process LLM call, not a general-purpose agent.
- Custom source for institutional landlord portals (YouFirst/Gecina, CDC Habitat) if coverage gaps are observed.
- Optional TanStack Start dashboard — only if the group-chat CRM proves insufficient.

## 7. Acceptance criteria

1. A new matching listing published on a major portal produces a Convos group message (photo + scored summary) in < 5 min.
2. First deploy produces **zero** notifications.
3. A price drop on a known listing produces exactly one re-notification.
4. Meublé / coloc / out-of-budget / out-of-area listings never notify.
5. Monthly Stream Estate PAYG cost stays single-digit €.
6. The agent identity survives process restarts without re-provisioning or duplicate-client state corruption.

## References

- Fredy: https://github.com/orangecoding/fredy
- Stream Estate pricing: https://stream.estate/fr/pricing — docs: https://docs.stream.estate (llms.txt available) — startup program: Starter free 3 months for PropTech startups (relevant only if this graduates to a Lacompany demand-test; not for v1).
- Encadrement des loyers official reference (v2): http://www.referenceloyer.drihl.ile-de-france.developpement-durable.gouv.fr/paris/

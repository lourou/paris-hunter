# paris-hunter

A thin fork of [Fredy](https://github.com/orangecoding/fredy) (merged at upstream
`428977e`, v22.9.7) that hunts Paris 11e/12e rental listings and posts scored
matches to a Convos (XMTP) group.

Pipeline: Stream Estate saved-search webhooks → `POST /api/webhook/stream-estate/:secret/{match,event}`
→ `stream_estate_inbox` → `streamEstate` provider (API-only, no Chromium) →
scoring + hard exclusions → dedup → `convos` notification adapter → XMTP group
(photo + scored summary).

Fork-specific pieces:

- `lib/provider/streamEstate.js` — webhook-fed provider (drains the inbox)
- `lib/notification/adapter/convos.js` — XMTP/Convos adapter (outbox, exactly-once)
- `lib/services/paris-hunter/` — config, scoring, cap table, exclusions, message format
- `FREDY_SKIP_CHROMIUM=true` skips the CloakBrowser download (API-only deploy)
- `.env.example` — every env var; run locally with `yarn start:paris-hunter`

Docs: `docs/BRIEF-paris-hunter.md` (product brief) · `docs/DEPLOY.md` (VPS runbook) ·
`docs/QA.md` (acceptance matrix). Upstream docs remain in `README.md`.

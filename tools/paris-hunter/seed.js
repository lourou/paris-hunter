/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/* eslint-disable no-console */

/**
 * paris-hunter: seed the seen-ledger before notifications are ever enabled
 * (build plan v2 lane 2 #3, v3 A5).
 *
 * Preconditions: the canonical search EXISTS and has notificationEnabled:false
 * (verified via GET — refuses otherwise), and the RECEIVER IS STOPPED
 * (`docker compose stop fredy` — enforced via initToolContext, see
 * lib/bootContext.js). Run order: bootstrap.js → seed.js →
 * docker compose up -d → bootstrap.js --enable-notifications.
 *
 * DEFAULT: polls GET /documents/properties with the saved-search filters and
 * inserts every dedupKey ('se:<uuid>') into ph_seen so pre-existing listings
 * can never notify. --store-listings additionally stores them for the Fredy
 * UI. --no-poll skips polling entirely (zero cost; webhooks only deliver
 * forward-looking matches).
 *
 * BOTH variants then persist meta seededAt. The notification watermark is NOT
 * minted here (v3 A5) — bootstrap.js --enable-notifications mints the cutoff
 * at enable time. Refuses to re-run when seededAt exists (--force overrides).
 *
 * ⚠️ LIVE + BILLABLE PATH — READ THIS (live incident 2026-07-11, method
 * vendor-confirmed 2026-07-13):
 * Stream Estate bills EVERY delivered item. The dashboard proved it: a naive
 * 200-page hand-built `page=N` walk re-fetched ~450 unique listings ~25x each
 * → 11,580 billed items (≈ −€133). Stream Estate support has since CONFIRMED
 * IN WRITING the canonical pagination for the listing endpoint: issue ONE
 * query (`page` + `itemsPerPage`, max 30) and follow the Hydra links —
 * `hydra:view` → `hydra:next` — until `hydra:next` is absent. That walk
 * delivers each property exactly once (no date windows, no hand-advanced
 * page numbers), which under per-delivered-item billing is the cheapest
 * possible full pull. NEVER hand-build `page=N` URLs on this endpoint.
 * A hard billing guard tracks items returned and ABORTS the run when
 * returned > max(3 × uniques, PH_SEED_MAX_ITEMS [default 2000]) — so a
 * misbehaving API (e.g. a looping `hydra:next`) can never silently burn the
 * account again. Progress is printed per page (items returned, new uniques,
 * running € estimate).
 * Gated behind --confirm-live; MUST NOT run before go-live checklist §E.1.
 * Offline tests inject fetchImpl mocks.
 *
 * usage: node --env-file-if-exists=.env tools/paris-hunter/seed.js
 *          [--no-poll] [--store-listings] [--confirm-live] [--force] [--dry-run]
 */

import { pathToFileURL } from 'node:url';
import SqliteConnection from '../../lib/services/storage/SqliteConnection.js';
import { PH } from '../../lib/services/paris-hunter/phConfig.js';
import { getParisHunterMeta, setParisHunterMeta, toEpochMs } from '../../lib/services/paris-hunter/inbox.js';
import { streamEstateApiBase } from '../../lib/services/paris-hunter/budget.js';

const PAGE_SIZE = 30; // documented max for itemsPerPage
const MAX_PAGES = 200; // absolute safety valve; the billing guard fires far earlier
const ITEM_COST_EUR = 0.01; // recon §1 estimate — used for progress/abort messages only
const DEFAULT_MAX_ITEMS = 2000;
const FETCH_TIMEOUT_MS = 60_000;

const headersFor = (env) => ({ 'X-API-KEY': env.STREAM_ESTATE_API_KEY, 'Content-Type': 'application/json' });

const euro = (items) => `€${(items * ITEM_COST_EUR).toFixed(2)}`;

/** @returns {number} abort threshold for billed items (see header) */
export const seedMaxItems = (env = process.env) => {
  const raw = Number(env.PH_SEED_MAX_ITEMS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_ITEMS;
};

/**
 * Billable poll URL — the SINGLE initial query of the hydra-link walk
 * (vendor-canonical, confirmed in writing 2026-07-13). Subsequent pages come
 * ONLY from the response's `hydra:view`.`hydra:next` link — never from
 * hand-built `page=N` URLs (see header).
 *
 * @param {string} base API base
 * @returns {string}
 */
export const buildPollUrl = (base) => {
  const params = new URLSearchParams();
  params.set('transactionType', '1');
  params.append('propertyTypes[]', '0');
  for (const zip of PH.zips) {
    params.append('includedZipcodes[]', zip);
  }
  params.set('budgetMin', String(PH.serverBudgetMin));
  params.set('budgetMax', String(PH.serverBudgetMax));
  params.set('roomMin', String(PH.roomsMin));
  params.set('roomMax', String(PH.roomsMax));
  params.set('furnished', 'false');
  params.set('itemsPerPage', String(PAGE_SIZE));
  params.set('order[createdAt]', 'asc');
  return `${base}/documents/properties?${params.toString()}`;
};

/**
 * Resolve a Hydra link (API Platform emits root-relative `@id` paths like
 * `/documents/properties?...&page=2`) against the API base.
 *
 * @param {string} base API base (no trailing slash)
 * @param {string} link `hydra:next` value
 * @returns {string} absolute URL
 */
export const resolveHydraLink = (base, link) => (/^https?:\/\//.test(link) ? link : `${base}${link}`);

const markSeen = (dedupKey) => {
  const info = SqliteConnection.execute(
    'INSERT OR IGNORE INTO ph_seen (dedup_key, first_seen_at) VALUES (@key, @now)',
    { key: dedupKey, now: Date.now() },
  );
  return info.changes === 1;
};

/**
 * @param {{ argv?: string[], fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv,
 *   deps?: { storeListings?: Function, normalize?: Function, now?: () => number } }} options
 * @returns {Promise<object>} machine-readable summary (used by tests)
 */
export const runSeed = async ({ argv = [], fetchImpl = fetch, env = process.env, deps = {} } = {}) => {
  const noPoll = argv.includes('--no-poll');
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');
  const confirmLive = argv.includes('--confirm-live');
  const storeForUi = argv.includes('--store-listings');
  const now = deps.now ?? Date.now;

  const mode = noPoll ? 'no-poll' : dryRun ? 'dry-run' : 'poll (LIVE + BILLABLE)';
  const base = streamEstateApiBase();
  const maxItems = seedMaxItems(env);
  // Immediate start line — BEFORE any network/DB await, so a stalled call can
  // never look like a dead process again (live incident 2026-07-11).
  console.log(
    `paris-hunter seed: starting — mode=${mode}, base=${base}, zips=${PH.zips.join('/')}, ` +
      `budget=${PH.serverBudgetMin}-${PH.serverBudgetMax}, rooms=${PH.roomsMin}-${PH.roomsMax}, ` +
      `pageSize=${PAGE_SIZE}, pagination=hydra:next link walk (vendor-canonical), ` +
      `maxPages=${MAX_PAGES}, itemGuard=${maxItems}`,
  );

  if (env.STREAM_ESTATE_API_KEY == null || env.STREAM_ESTATE_API_KEY === '') {
    throw new Error('STREAM_ESTATE_API_KEY must be set');
  }
  if (getParisHunterMeta('seededAt') != null && !force) {
    throw new Error('already seeded (meta seededAt exists) — re-run with --force only if you know why');
  }

  const searchId = getParisHunterMeta('searchId');
  if (searchId == null) {
    throw new Error('meta searchId missing — run bootstrap.js first');
  }

  const timedFetch = (url, options = {}) => {
    const timeoutError = new Error(`request did not complete within ${FETCH_TIMEOUT_MS / 1000}s: ${url.split('?')[0]}`);
    return fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...options }).catch((error) => {
      throw error?.name === 'TimeoutError' ? timeoutError : error;
    });
  };

  // Precondition: the canonical search must exist and be DISABLED.
  const searchPath = searchId.startsWith('/') ? searchId : `/searches/${searchId}`;
  console.log(`paris-hunter seed: verifying the saved search is DISABLED (GET ${searchPath})…`);
  const response = await timedFetch(`${base}${searchPath}`, { headers: headersFor(env) });
  if (!response.ok) {
    throw new Error(`GET ${searchPath} returned ${response.status} — run bootstrap.js first`);
  }
  const search = await response.json();
  if (search?.notificationEnabled !== false) {
    throw new Error(
      'the saved search does not report notificationEnabled:false — run bootstrap.js (reconcile forces it OFF) before seeding',
    );
  }

  const summary = { seeded: 0, pages: 0, stored: 0, itemsReturned: 0, noPoll, dryRun };

  if (!noPoll) {
    if (!confirmLive && !dryRun) {
      throw new Error(
        'polling /documents/properties is LIVE + BILLABLE (go-live checklist E.1 must be confirmed) — re-run with --confirm-live, or use --no-poll',
      );
    }
    if (dryRun) {
      console.log(
        `[dry-run] would walk hydra:next links from: ${buildPollUrl(base)} ` +
          `(single query; follows hydra:view → hydra:next until absent — each property delivered once; ` +
          `abort past ${maxItems} billed items)`,
      );
    } else {
      // ⚠️ LIVE BILLABLE polling loop — hydra:next link walk (vendor-canonical,
      // confirmed 2026-07-13). ONE initial query; every subsequent URL comes
      // from the response itself. Never hand-build `page=N`.
      const seenThisRun = new Set(); // uniques for the billing guard
      let nextUrl = buildPollUrl(base);
      for (let page = 1; nextUrl != null; page += 1) {
        if (page > MAX_PAGES) {
          throw new Error(`page count exceeded the ${MAX_PAGES} safety valve — aborting (API misbehaving?)`);
        }
        const pollResponse = await timedFetch(nextUrl, {
          headers: headersFor(env),
        });
        if (!pollResponse.ok) {
          throw new Error(`GET /documents/properties page ${page} returned ${pollResponse.status}`);
        }
        const body = await pollResponse.json();
        const members = Array.isArray(body) ? body : (body?.['hydra:member'] ?? []);
        if (members.length === 0) {
          break;
        }
        summary.pages += 1;
        summary.itemsReturned += members.length;

        const uniqueBefore = seenThisRun.size;
        for (const doc of members) {
          if (typeof doc?.uuid !== 'string' || doc.uuid === '') {
            continue;
          }
          seenThisRun.add(doc.uuid);
          if (markSeen(`se:${doc.uuid}`)) {
            summary.seeded += 1;
          }
          if (storeForUi) {
            try {
              const normalize = deps.normalize ?? (await import('../../lib/provider/streamEstate.js')).config.normalize;
              const storeListings =
                deps.storeListings ?? (await import('../../lib/services/storage/listingsStorage.js')).storeListings;
              const listing = normalize({
                kind: 'match',
                payload: { propertyDocument: doc, createdAt: doc.createdAt },
                eventAt: toEpochMs(doc.createdAt),
              });
              if (listing?.id != null) {
                storeListings(PH.jobId, 'streamEstate', [listing]);
                summary.stored += 1;
              }
            } catch (error) {
              console.error(
                `seed: could not store ${doc.uuid} for the UI (${error.message}) — seen-ledger unaffected.`,
              );
            }
          }
        }

        console.log(
          `paris-hunter seed: page ${page} — ${members.length} items returned, ` +
            `${seenThisRun.size - uniqueBefore} new listings marked seen — running total: ${seenThisRun.size} unique, ` +
            `${summary.itemsReturned} items billed ≈ ${euro(summary.itemsReturned)}`,
        );

        // HARD BILLING GUARD (live incident 2026-07-11: 11,580 items billed
        // for 450 uniques). Abort — and do NOT write seededAt — the moment
        // billed items exceed both 3× the uniques discovered and the cap.
        // With hydra links this also catches a maliciously looping hydra:next.
        const guard = Math.max(3 * seenThisRun.size, maxItems);
        if (summary.itemsReturned > guard) {
          throw new Error(
            `BILLING GUARD tripped: ${summary.itemsReturned} items billed (≈ ${euro(summary.itemsReturned)}) for only ` +
              `${seenThisRun.size} unique listings (threshold ${guard}; PH_SEED_MAX_ITEMS=${maxItems}) — the API is ` +
              're-returning already-fetched items. Aborting WITHOUT writing seededAt. Check the Stream Estate ' +
              'dashboard before re-running.',
          );
        }

        // Follow the vendor-canonical link: hydra:view → hydra:next. Absent
        // link (or absent view — a single-page collection) means DONE.
        const next = body?.['hydra:view']?.['hydra:next'];
        nextUrl = typeof next === 'string' && next !== '' ? resolveHydraLink(base, next) : null;
      }
    }
  }

  if (dryRun) {
    console.log('[dry-run] would set meta seededAt');
    return summary;
  }

  setParisHunterMeta('seededAt', String(now()));
  summary.seededAt = true;
  console.log(
    `paris-hunter seed: done — ${summary.seeded} new seen key(s) across ${summary.pages} page(s), ` +
      `${summary.itemsReturned} items billed ≈ ${euro(summary.itemsReturned)}` +
      `${storeForUi ? `, ${summary.stored} stored for UI` : ''}. Meta seededAt written.`,
  );
  console.log(
    'Next: docker compose up -d, then node tools/paris-hunter/bootstrap.js --enable-notifications (keep this window SHORT — the cutoff is minted at enable time).',
  );
  return summary;
};

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const { initToolContext, withReceiverHint } = await import('./lib/bootContext.js');
  try {
    // Seed REQUIRES a stopped receiver (runbook §5/§6 stop-first discipline):
    // sharing the live DB mid-seed is never worth debugging.
    await initToolContext({ requireReceiverStopped: true });
    await runSeed({ argv: process.argv.slice(2) });
  } catch (error) {
    console.error(`paris-hunter seed: FAILED — ${withReceiverHint(error).message}`);
    process.exit(1);
  }
}

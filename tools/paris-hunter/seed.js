/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

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
 * (verified via GET — refuses otherwise). Run order: bootstrap.js → seed.js →
 * docker compose up -d → bootstrap.js --enable-notifications.
 *
 * DEFAULT: polls GET /documents/properties with the saved-search filters
 * (pages of 30) and inserts every dedupKey ('se:<uuid>') into ph_seen so
 * pre-existing listings can never notify. --store-listings additionally stores
 * them for the Fredy UI. --no-poll skips polling entirely (zero cost; webhooks
 * only deliver forward-looking matches).
 *
 * BOTH variants then persist meta seededAt. The notification watermark is NOT
 * minted here (v3 A5) — bootstrap.js --enable-notifications mints the cutoff
 * at enable time. Refuses to re-run when seededAt exists (--force overrides).
 *
 * ⚠️ LIVE + BILLABLE PATH: /documents/properties polling bills per item
 * (~€0.01 × items, expected < €3 one-time). It is gated behind --confirm-live
 * and MUST NOT run before go-live checklist §E.1 (billing definition)
 * is confirmed. Offline tests inject fetchImpl mocks.
 *
 * usage: node --env-file-if-exists=.env tools/paris-hunter/seed.js
 *          [--no-poll] [--store-listings] [--confirm-live] [--force] [--dry-run]
 */

import { pathToFileURL } from 'node:url';
import SqliteConnection from '../../lib/services/storage/SqliteConnection.js';
import { PH } from '../../lib/services/paris-hunter/phConfig.js';
import { getParisHunterMeta, setParisHunterMeta, toEpochMs } from '../../lib/services/paris-hunter/inbox.js';
import { streamEstateApiBase } from '../../lib/services/paris-hunter/budget.js';

const PAGE_SIZE = 30;
const MAX_PAGES = 200; // safety valve (~6000 items ≫ any realistic backlog)

const headersFor = (env) => ({ 'X-API-KEY': env.STREAM_ESTATE_API_KEY, 'Content-Type': 'application/json' });

const buildPollUrl = (base, env, page) => {
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
  params.set('page', String(page));
  return `${base}/documents/properties?${params.toString()}`;
};

const markSeen = (dedupKey) => {
  const info = SqliteConnection.execute(
    'INSERT OR IGNORE INTO ph_seen (dedup_key, first_seen_at) VALUES (@key, @now)',
    { key: dedupKey, now: Date.now() },
  );
  return info.changes === 1;
};

/**
 * @param {{ argv?: string[], fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv,
 *   deps?: { storeListings?: Function, normalize?: Function } }} options
 * @returns {Promise<object>} machine-readable summary (used by tests)
 */
export const runSeed = async ({ argv = [], fetchImpl = fetch, env = process.env, deps = {} } = {}) => {
  const noPoll = argv.includes('--no-poll');
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');
  const confirmLive = argv.includes('--confirm-live');
  const storeForUi = argv.includes('--store-listings');

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
  const base = streamEstateApiBase();

  // Precondition: the canonical search must exist and be DISABLED.
  const searchPath = searchId.startsWith('/') ? searchId : `/searches/${searchId}`;
  const response = await fetchImpl(`${base}${searchPath}`, { headers: headersFor(env) });
  if (!response.ok) {
    throw new Error(`GET ${searchPath} returned ${response.status} — run bootstrap.js first`);
  }
  const search = await response.json();
  if (search?.notificationEnabled !== false) {
    throw new Error(
      'the saved search does not report notificationEnabled:false — run bootstrap.js (reconcile forces it OFF) before seeding',
    );
  }

  const summary = { seeded: 0, pages: 0, stored: 0, noPoll, dryRun };

  if (!noPoll) {
    if (!confirmLive && !dryRun) {
      throw new Error(
        'polling /documents/properties is LIVE + BILLABLE (go-live checklist E.1 must be confirmed) — re-run with --confirm-live, or use --no-poll',
      );
    }
    if (dryRun) {
      console.log(`[dry-run] would poll: ${buildPollUrl(base, env, 1)} (pages of ${PAGE_SIZE}, max ${MAX_PAGES})`);
    } else {
      // ⚠️ LIVE BILLABLE polling loop.
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const pollResponse = await fetchImpl(buildPollUrl(base, env, page), { headers: headersFor(env) });
        if (!pollResponse.ok) {
          throw new Error(`GET /documents/properties page ${page} returned ${pollResponse.status}`);
        }
        const body = await pollResponse.json();
        const members = Array.isArray(body) ? body : (body?.['hydra:member'] ?? []);
        if (members.length === 0) {
          break;
        }
        summary.pages += 1;
        for (const doc of members) {
          if (typeof doc?.uuid !== 'string' || doc.uuid === '') {
            continue;
          }
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
        if (members.length < PAGE_SIZE) {
          break;
        }
      }
    }
  }

  if (dryRun) {
    console.log('[dry-run] would set meta seededAt');
    return summary;
  }

  setParisHunterMeta('seededAt', String(Date.now()));
  summary.seededAt = true;
  console.log(
    `paris-hunter seed: done (${summary.seeded} new seen key(s), ${summary.pages} page(s)${storeForUi ? `, ${summary.stored} stored for UI` : ''}).`,
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
  const { initToolContext } = await import('./lib/bootContext.js');
  await initToolContext();
  try {
    await runSeed({ argv: process.argv.slice(2) });
  } catch (error) {
    console.error(`paris-hunter seed: FAILED — ${error.message}`);
    process.exit(1);
  }
}

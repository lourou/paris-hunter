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
 * paris-hunter: idempotent, reconcile-first Stream Estate bootstrap
 * (build plan v2 lane 2 #3/#6, v3 A5).
 *
 * DEFAULT MODE (reconcile, OFF-by-default):
 *   1. GET /searches; ours = title starts with '[ph:v1]' OR @id == meta
 *      searchId OR token == meta searchToken.
 *   2. INVARIANT (v3 A5): ALL owned searches are forced
 *      notificationEnabled:false via PUT — canonical AND duplicates, always.
 *      Canonical = --keep <@id> when given, else oldest createdAt. 0 owned →
 *      POST the identity body with notificationEnabled:false.
 *   3. Persist searchId+searchToken to meta ONLY after a verifying re-GET.
 *   4. upsertJob (fixed id 'paris-hunter', provider streamEstate, adapter convos).
 *
 * --enable-notifications (v3 A5 — the ONLY path that ever enables; run AFTER
 *   `docker compose up -d`):
 *   1. Receiver liveness: GET $PUBLIC_BASE_URL/api/webhook/stream-estate/<secret>/health
 *      must return 200 — refuse otherwise.
 *   2. Verify meta seededAt exists AND the canonical search matches the current
 *      configRev (re-GET, recompute).
 *   3. Mint the cutoff NOW: watermark JSON { cutoffMs: Date.now(), searchId,
 *      configRev } written atomically. (Gap note: listings between seed and this
 *      cutoff are skipped — keep the seed→enable window to minutes.)
 *   4. PUT notificationEnabled:true → re-GET verify → report.
 *
 * --dry-run: read-only GETs + prints every intended mutation, sends none.
 *
 * ⚠️ LIVE PATH: every fetch here hits the Stream Estate API (search management;
 * not item-billed per recon §1, but gated behind the go-live checklist §E —
 * billing definition unconfirmed). Offline tests inject fetchImpl mocks; never
 * run this against production before E.1 is confirmed.
 *
 * usage: node --env-file-if-exists=.env tools/paris-hunter/bootstrap.js
 *          [--dry-run] [--keep </searches/id>] [--enable-notifications]
 */

import { pathToFileURL } from 'node:url';
import { PH } from '../../lib/services/paris-hunter/phConfig.js';
import { getParisHunterMeta, setParisHunterMeta } from '../../lib/services/paris-hunter/inbox.js';
import {
  buildSearchBody,
  computeConfigRev,
  SEARCH_TITLE_PREFIX,
} from '../../lib/services/paris-hunter/searchConfig.js';
import { streamEstateApiBase } from '../../lib/services/paris-hunter/budget.js';
import { upsertJob } from '../../lib/services/storage/jobStorage.js';

const sameSet = (a, b) => {
  const left = Array.isArray(a) ? [...a].map(String).sort() : null;
  const right = Array.isArray(b) ? [...b].map(String).sort() : null;
  return JSON.stringify(left) === JSON.stringify(right);
};

/**
 * Compares our identity body against a remote search echo.
 * @returns {string[]} mismatched field names (empty = converged)
 */
export const diffSearch = (remote, body = buildSearchBody()) => {
  const mismatches = [];
  for (const [key, value] of Object.entries(body)) {
    const remoteValue = remote?.[key];
    const equal = Array.isArray(value) ? sameSet(value, remoteValue) : remoteValue === value;
    if (!equal) {
      mismatches.push(key);
    }
  }
  return mismatches;
};

const headersFor = (env) => ({ 'X-API-KEY': env.STREAM_ESTATE_API_KEY, 'Content-Type': 'application/json' });

const listSearches = async (fetchImpl, base, env) => {
  const response = await fetchImpl(`${base}/searches`, { headers: headersFor(env) });
  if (!response.ok) {
    throw new Error(`GET /searches returned ${response.status}`);
  }
  const body = await response.json();
  return Array.isArray(body) ? body : (body?.['hydra:member'] ?? []);
};

const getSearch = async (fetchImpl, base, env, searchId) => {
  const path = searchId.startsWith('/') ? searchId : `/searches/${searchId}`;
  const response = await fetchImpl(`${base}${path}`, { headers: headersFor(env) });
  if (!response.ok) {
    throw new Error(`GET ${path} returned ${response.status}`);
  }
  return response.json();
};

const putSearch = async (fetchImpl, base, env, searchId, body) => {
  const path = searchId.startsWith('/') ? searchId : `/searches/${searchId}`;
  const response = await fetchImpl(`${base}${path}`, {
    method: 'PUT',
    headers: headersFor(env),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`PUT ${path} returned ${response.status}`);
  }
  return response.json();
};

const isOwned = (search, meta) =>
  (typeof search?.title === 'string' && search.title.startsWith(SEARCH_TITLE_PREFIX)) ||
  (meta.searchId != null && search?.['@id'] === meta.searchId) ||
  (meta.searchToken != null && search?.token != null && search.token === meta.searchToken);

const pickCanonical = (owned, keepId) => {
  if (keepId != null) {
    const kept = owned.find((s) => s['@id'] === keepId);
    if (kept == null) {
      throw new Error(`--keep ${keepId} does not match any owned search`);
    }
    return kept;
  }
  return [...owned].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))[0];
};

/**
 * @param {{ argv?: string[], fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv,
 *   deps?: { upsertJob?: Function, adminUserId?: string, now?: () => number } }} options
 * @returns {Promise<object>} machine-readable summary (used by tests)
 */
export const runBootstrap = async ({ argv = [], fetchImpl = fetch, env = process.env, deps = {} } = {}) => {
  const dryRun = argv.includes('--dry-run');
  const enableMode = argv.includes('--enable-notifications');
  const keepIndex = argv.indexOf('--keep');
  const keepId = keepIndex >= 0 ? argv[keepIndex + 1] : null;
  const now = deps.now ?? Date.now;

  for (const key of ['STREAM_ESTATE_API_KEY', 'STREAM_ESTATE_WEBHOOK_SECRET', 'PUBLIC_BASE_URL']) {
    if (env[key] == null || env[key] === '') {
      throw new Error(`${key} must be set (see .env.example)`);
    }
  }

  const base = streamEstateApiBase();
  const identityBody = buildSearchBody({ env });
  const configRev = computeConfigRev(identityBody);
  const summary = { mode: enableMode ? 'enable' : 'reconcile', dryRun, actions: [], searchId: null, configRev };

  if (enableMode) {
    // ---- v3 A5 enable sequence — the ONLY path that sets notificationEnabled:true
    const secret = env.STREAM_ESTATE_WEBHOOK_SECRET;
    const healthUrl = `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/webhook/stream-estate/${secret}/health`;
    let health;
    try {
      health = await fetchImpl(healthUrl, { method: 'GET' });
    } catch (error) {
      throw new Error(
        `receiver health check unreachable (${error.message}) — start the stack first (docker compose up -d)`,
        { cause: error },
      );
    }
    if (!health.ok) {
      throw new Error(`receiver health check returned ${health.status} — refusing to enable notifications`);
    }

    if (getParisHunterMeta('seededAt') == null) {
      throw new Error('meta seededAt missing — run tools/paris-hunter/seed.js first');
    }
    const searchId = getParisHunterMeta('searchId');
    if (searchId == null) {
      throw new Error('meta searchId missing — run bootstrap.js (reconcile) first');
    }
    const remote = await getSearch(fetchImpl, base, env, searchId);
    const mismatches = diffSearch(remote, identityBody);
    if (mismatches.length > 0) {
      throw new Error(
        `canonical search no longer matches the current config (fields: ${mismatches.join(', ')}) — re-run bootstrap.js, seed.js, then --enable-notifications`,
      );
    }

    // Mint the cutoff NOW (not at seed time) and bind it to search identity.
    const watermark = { cutoffMs: now(), searchId, configRev };
    if (dryRun) {
      summary.actions.push({ action: 'would-write-watermark', watermark });
      summary.actions.push({ action: 'would-enable', searchId });
      console.log(`[dry-run] watermark: ${JSON.stringify(watermark)}`);
      console.log(`[dry-run] PUT ${searchId} notificationEnabled:true`);
      return summary;
    }
    setParisHunterMeta('notifyWatermark', JSON.stringify(watermark));
    summary.actions.push({ action: 'watermark-written', watermark });

    await putSearch(fetchImpl, base, env, searchId, { ...identityBody, notificationEnabled: true });
    const verified = await getSearch(fetchImpl, base, env, searchId);
    if (verified?.notificationEnabled !== true) {
      throw new Error('verify GET after enable still reports notificationEnabled != true');
    }
    summary.actions.push({ action: 'enabled', searchId });
    summary.searchId = searchId;
    console.log(
      `paris-hunter bootstrap: notifications ENABLED for ${searchId} (watermark cutoff ${watermark.cutoffMs}).`,
    );
    console.log('Keep the seed→enable window short: listings between seed and this cutoff are skipped by design.');
    return summary;
  }

  // ---- reconcile mode (OFF-by-default)
  const meta = { searchId: getParisHunterMeta('searchId'), searchToken: getParisHunterMeta('searchToken') };
  const all = await listSearches(fetchImpl, base, env);
  const owned = all.filter((s) => isOwned(s, meta));
  console.log(`paris-hunter bootstrap: ${all.length} remote search(es), ${owned.length} owned.`);

  let canonical;
  if (owned.length === 0) {
    if (dryRun) {
      summary.actions.push({ action: 'would-create', body: { ...identityBody, notificationEnabled: false } });
      console.log(`[dry-run] POST /searches ${JSON.stringify({ ...identityBody, notificationEnabled: false })}`);
      return summary;
    }
    const response = await fetchImpl(`${base}/searches`, {
      method: 'POST',
      headers: headersFor(env),
      body: JSON.stringify({ ...identityBody, notificationEnabled: false }),
    });
    if (!response.ok) {
      throw new Error(`POST /searches returned ${response.status}`);
    }
    canonical = await response.json();
    summary.actions.push({ action: 'created', searchId: canonical['@id'] });
  } else {
    canonical = pickCanonical(owned, keepId);
    // v3 A5 invariant: EVERY owned search is forced OFF — canonical converges
    // to the identity body, duplicates keep their own config but get disabled.
    for (const search of owned) {
      const id = search['@id'];
      const isCanonical = id === canonical['@id'];
      const putBody = isCanonical
        ? { ...identityBody, notificationEnabled: false }
        : { ...search, notificationEnabled: false };
      if (dryRun) {
        summary.actions.push({ action: isCanonical ? 'would-converge-off' : 'would-disable-duplicate', searchId: id });
        console.log(
          `[dry-run] PUT ${id} notificationEnabled:false${isCanonical ? ' (canonical, converge config)' : ' (duplicate)'}`,
        );
        continue;
      }
      await putSearch(fetchImpl, base, env, id, putBody);
      summary.actions.push({ action: isCanonical ? 'converged-off' : 'disabled-duplicate', searchId: id });
      if (!isCanonical) {
        console.log(
          `paris-hunter bootstrap: duplicate owned search ${id} DISABLED (kept canonical ${canonical['@id']}).`,
        );
      }
    }
  }
  if (dryRun) {
    return summary;
  }

  // Persist identity ONLY after a verifying re-GET.
  const verified = await getSearch(fetchImpl, base, env, canonical['@id']);
  const mismatches = diffSearch(verified, identityBody);
  if (mismatches.length > 0) {
    throw new Error(`verify re-GET diverges on: ${mismatches.join(', ')} — NOT persisting searchId`);
  }
  if (verified?.notificationEnabled === true) {
    throw new Error('verify re-GET reports notificationEnabled:true after forced disable — aborting');
  }
  setParisHunterMeta('searchId', verified['@id']);
  if (verified.token != null) {
    setParisHunterMeta('searchToken', String(verified.token));
  }
  summary.searchId = verified['@id'];
  summary.actions.push({ action: 'meta-persisted', searchId: verified['@id'] });

  const doUpsertJob = deps.upsertJob ?? upsertJob;
  let adminUserId = deps.adminUserId;
  if (adminUserId == null) {
    const { getAdminUserId } = await import('./lib/bootContext.js');
    adminUserId = getAdminUserId();
  }
  doUpsertJob({
    jobId: PH.jobId,
    name: 'paris-hunter',
    enabled: true,
    provider: [{ id: 'streamEstate', url: 'inbox://stream-estate', enabled: true }],
    notificationAdapter: [{ id: 'convos', fields: {} }],
    userId: adminUserId,
  });
  summary.actions.push({ action: 'job-upserted', jobId: PH.jobId });
  console.log(
    `paris-hunter bootstrap: reconciled. Canonical ${verified['@id']} is DISABLED (configRev ${configRev.slice(0, 12)}…). Next: seed.js, then bootstrap.js --enable-notifications.`,
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
    await runBootstrap({ argv: process.argv.slice(2) });
  } catch (error) {
    console.error(`paris-hunter bootstrap: FAILED — ${error.message}`);
    process.exit(1);
  }
}

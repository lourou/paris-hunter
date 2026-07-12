/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/* eslint-disable no-console */

/**
 * paris-hunter QA: shared sqlite access for the QA harness (lane 6).
 *
 * Speaks the SCHEMA contract (build plan v2, shared contract 3) directly via SQL —
 * deliberately NOT the lane-2 module API, so the harness stays decoupled from stub
 * evolution and can assert raw DB state after crashes.
 *
 * Dual use:
 *   - imported by replay-inbox.js / latency-report.js / requeue-outbox.js
 *   - CLI for shell scripts (failpoint-run.sh, live-qa.sh):
 *       node --env-file-if-exists=.env tools/paris-hunter/qa/db.js <command> [...args]
 *     commands:
 *       tables                          -> lists paris-hunter tables present/missing (exit 2 if missing)
 *       get-meta <key>                  -> prints value or '(null)'
 *       set-meta <key> <value>          -> upserts paris_hunter_meta
 *       inbox-row <externalId>          -> JSON of newest inbox row for that external id
 *       outbox-row <dedupKey>           -> JSON of the outbox row
 *       counts [dedupKey]               -> JSON {inboxDone, inboxPending, seen, outbox} for that key;
 *                                          without a key: whole-DB totals (scope:"global")
 *       assert-final <dedupKey> --mode offline|live [--deadline <s>]
 *                                       -> polls until the exactly-once terminal state holds (see below)
 *       qa-seed-watermark [--cutoff-ms <n>]
 *                                       -> QA-ONLY: mints a v3-A5 watermark JSON {cutoffMs, searchId,
 *                                          configRev} + seededAt so the provider gate opens without
 *                                          a live Stream Estate bootstrap (offline failpoint runs)
 *       qa-ensure-job                   -> QA-ONLY: upserts the paris-hunter job row (provider
 *                                          streamEstate + adapter convos) without live bootstrap
 *
 * Exit codes (all lane-6 node tools): 0 ok/pass · 1 assertion failure · 2 not-ready
 * (paris-hunter tables missing, i.e. lane 2 / migration 22 not landed) · 3 usage error.
 */

import { pathToFileURL } from 'url';
import SqliteConnection from '../../../lib/services/storage/SqliteConnection.js';

export const EXIT_FAIL = 1;
export const EXIT_NOT_READY = 2;
export const EXIT_USAGE = 3;

export const PH_TABLES = ['stream_estate_inbox', 'ph_seen', 'paris_hunter_meta', 'convos_outbox'];

/** Initializes the connection (reads conf/config.json for the sqlite dir). */
export const openDb = async () => {
  await SqliteConnection.init();
  // Force the connection open so tableExists/query work.
  SqliteConnection.getConnection();
  return SqliteConnection;
};

/** @returns {string[]} paris-hunter tables that do not exist yet */
export const missingTables = () => PH_TABLES.filter((table) => !SqliteConnection.tableExists(table));

/** Exits 2 with a clear message when migration 22 has not landed. */
export const requireTables = () => {
  const missing = missingTables();
  if (missing.length > 0) {
    console.error(
      `NOT READY: missing table(s) ${missing.join(', ')} — lane 2 (migration 22.paris-hunter.js) has not landed ` +
        'or the server never booted against this DB. Nothing to assert yet.',
    );
    process.exit(EXIT_NOT_READY);
  }
};

/** Strips IRI prefixes: '/documents/properties/<uuid>' | '/properties/<uuid>' -> '<uuid>'. */
export const normalizeExternalId = (raw) => {
  if (raw == null) return null;
  const parts = String(raw).split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
};

/**
 * Timestamp normalization mirroring v3-A4's toEpochMs: ISO-8601 or epoch (s|ms) ->
 * integer ms, null when missing/malformed/out of sanity bounds.
 */
export const toEpochMs = (value) => {
  if (value == null) return null;
  let ms;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    ms = n < 1e12 ? n * 1000 : n; // epoch seconds vs ms by magnitude
  } else {
    const parsed = Date.parse(String(value));
    ms = Number.isNaN(parsed) ? null : parsed;
  }
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < Date.parse('2020-01-01T00:00:00Z') || ms > Date.now() + 24 * 3600 * 1000) return null;
  return Math.round(ms);
};

/**
 * Derives ph.dedupKey from an inbox row.
 * match -> se:<externalId> (v2 shared contract 2)
 * price event -> se:<externalId>:price:<eventAtMs>:<oldNorm>-><newNorm> (v3 A9)
 *
 * @param {{kind: string, external_id: string|null, payload: string}} row
 * @returns {string|null}
 */
export const deriveDedupKey = (row) => {
  let payload;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null;
  }
  const match = payload?.match ?? payload;
  const externalId =
    normalizeExternalId(row.external_id) ??
    normalizeExternalId(match?.property) ??
    normalizeExternalId(match?.propertyDocument?.['@id']) ??
    match?.propertyDocument?.uuid ??
    null;
  if (externalId == null) return null;
  if (row.kind === 'event') {
    const adEvent = payload?.adEvent;
    if (adEvent == null) return null;
    const eventAtMs = toEpochMs(adEvent.createdAt);
    const oldNorm = Math.round(Number(adEvent.fieldOldValue));
    const newNorm = Math.round(Number(adEvent.fieldNewValue));
    if (eventAtMs == null || !Number.isFinite(oldNorm) || !Number.isFinite(newNorm)) return null;
    return `se:${externalId}:price:${eventAtMs}:${oldNorm}->${newNorm}`;
  }
  return `se:${externalId}`;
};

export const getMeta = (key) => {
  const rows = SqliteConnection.query('SELECT value FROM paris_hunter_meta WHERE key = :key', { key });
  return rows.length > 0 ? rows[0].value : null;
};

export const setMeta = (key, value) => {
  SqliteConnection.execute(
    'INSERT INTO paris_hunter_meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = :value',
    { key, value: String(value) },
  );
};

/** @returns {object|null} newest inbox row whose external_id contains the given id */
export const findInboxRow = (externalId) => {
  const rows = SqliteConnection.query(
    'SELECT * FROM stream_estate_inbox WHERE external_id LIKE :pattern ORDER BY id DESC LIMIT 1',
    { pattern: `%${externalId}%` },
  );
  return rows[0] ?? null;
};

export const findInboxDecisions = (externalId) =>
  SqliteConnection.query(
    'SELECT id, decision, done_at FROM stream_estate_inbox WHERE external_id LIKE :pattern ORDER BY id',
    { pattern: `%${externalId}%` },
  );

export const findOutboxRow = (dedupKey) => {
  const rows = SqliteConnection.query('SELECT * FROM convos_outbox WHERE id = :id OR dedup_key = :id LIMIT 1', {
    id: dedupKey,
  });
  return rows[0] ?? null;
};

/**
 * Whole-DB state snapshot (no dedup-key filter). Incident 2026-07-12: `counts`
 * without a dedup key silently bound `undefined` and returned all zeros against
 * a ledger holding 6001 rows — misdiagnosed as "seen ledger lost". A key-less
 * `counts` now reports these global totals instead.
 */
export const globalCounts = () => ({
  scope: 'global',
  inboxDone: SqliteConnection.query('SELECT COUNT(*) AS n FROM stream_estate_inbox WHERE done_at IS NOT NULL')[0].n,
  inboxPending: SqliteConnection.query('SELECT COUNT(*) AS n FROM stream_estate_inbox WHERE done_at IS NULL')[0].n,
  seen: SqliteConnection.query('SELECT COUNT(*) AS n FROM ph_seen')[0].n,
  outbox: SqliteConnection.query('SELECT COUNT(*) AS n FROM convos_outbox')[0].n,
  outboxSent: SqliteConnection.query('SELECT COUNT(*) AS n FROM convos_outbox WHERE sent_at IS NOT NULL')[0].n,
});

/**
 * Exactly-once state snapshot for one dedup key.
 * inboxDone/inboxPending count rows whose derived dedup key matches (kind-aware).
 */
export const countsFor = (dedupKey) => {
  if (dedupKey == null || dedupKey === '') {
    throw new Error('countsFor requires a dedup key — use globalCounts() for whole-DB totals');
  }
  const inboxRows = SqliteConnection.query('SELECT id, kind, external_id, payload, done_at FROM stream_estate_inbox');
  let inboxDone = 0;
  let inboxPending = 0;
  for (const row of inboxRows) {
    if (deriveDedupKey(row) === dedupKey) {
      if (row.done_at != null) inboxDone += 1;
      else inboxPending += 1;
    }
  }
  const seen = SqliteConnection.query('SELECT COUNT(*) AS n FROM ph_seen WHERE dedup_key = :key', { key: dedupKey })[0]
    .n;
  const outbox = SqliteConnection.query('SELECT COUNT(*) AS n FROM convos_outbox WHERE id = :key OR dedup_key = :key', {
    key: dedupKey,
  })[0].n;
  return { inboxDone, inboxPending, seen, outbox };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until the terminal exactly-once state holds for a dedup key, or the deadline passes.
 *
 * offline (CONVOS_ENABLED=false): inbox row done, ph_seen = 1, exactly 1 outbox row
 *   (state queued or sent — no adapter runs offline).
 * live: same + outbox row sent_at NOT NULL (text sent AND image sent-or-skipped).
 *
 * @returns {Promise<{pass: boolean, detail: object}>}
 */
export const assertFinal = async (dedupKey, { mode = 'offline', deadlineS = 90 } = {}) => {
  const deadline = Date.now() + deadlineS * 1000;
  let last;
  for (;;) {
    const counts = countsFor(dedupKey);
    const outboxRow = findOutboxRow(dedupKey);
    const terminal =
      counts.inboxPending === 0 &&
      counts.inboxDone >= 1 &&
      counts.seen === 1 &&
      counts.outbox === 1 &&
      (mode === 'offline' || (outboxRow != null && outboxRow.sent_at != null));
    last = { counts, outbox: outboxRow };
    if (terminal) {
      // Exactly-once violations are structural, not eventual: more than one outbox
      // or seen row can never heal — check them explicitly.
      const pass = counts.outbox === 1 && counts.seen === 1;
      return { pass, detail: last };
    }
    if (counts.outbox > 1 || counts.seen > 1) {
      return { pass: false, detail: last };
    }
    if (Date.now() > deadline) {
      return { pass: false, detail: { ...last, timedOut: true, deadlineS } };
    }
    await sleep(2000);
  }
};

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  await openDb();
  switch (command) {
    case 'tables': {
      const missing = missingTables();
      console.log(JSON.stringify({ present: PH_TABLES.filter((t) => !missing.includes(t)), missing }));
      process.exit(missing.length > 0 ? EXIT_NOT_READY : 0);
      break;
    }
    case 'get-meta': {
      requireTables();
      console.log(getMeta(args[0]) ?? '(null)');
      break;
    }
    case 'set-meta': {
      requireTables();
      if (args.length < 2) {
        console.error('usage: db.js set-meta <key> <value>');
        process.exit(EXIT_USAGE);
      }
      setMeta(args[0], args[1]);
      console.log(`meta ${args[0]} = ${args[1]}`);
      break;
    }
    case 'inbox-row': {
      requireTables();
      console.log(JSON.stringify(findInboxRow(args[0]), null, 2));
      break;
    }
    case 'inbox-decisions': {
      requireTables();
      console.log(JSON.stringify(findInboxDecisions(args[0]), null, 2));
      break;
    }
    case 'outbox-row': {
      requireTables();
      console.log(JSON.stringify(findOutboxRow(args[0]), null, 2));
      break;
    }
    case 'counts': {
      requireTables();
      // No dedup key → global totals (a key-less per-key query used to return
      // all-zeros no matter what the DB held — see globalCounts).
      console.log(JSON.stringify(args[0] ? countsFor(args[0]) : globalCounts()));
      break;
    }
    case 'qa-seed-watermark': {
      requireTables();
      const cutoffMs = args.includes('--cutoff-ms')
        ? Number(args[args.indexOf('--cutoff-ms') + 1])
        : Date.now() - 3600 * 1000;
      const searchId = getMeta('searchId') ?? '/searches/qa-search';
      if (getMeta('searchId') == null) setMeta('searchId', searchId);
      // The provider gate (v3 A5) only honors a watermark whose configRev matches the
      // rev it recomputes from PH at boot. Try lane 2's exported computation; without
      // it the gate will treat us as unseeded — flagged loudly so the runner can BLOCK.
      let configRev = null;
      for (const [modulePath, names] of [
        ['../../../lib/services/paris-hunter/searchConfig.js', ['currentConfigRev', 'computeConfigRev']],
        ['../../../lib/provider/streamEstate.js', ['computeConfigRev', 'currentConfigRev', 'configRev']],
        ['../../../lib/services/paris-hunter/inbox.js', ['computeConfigRev', 'currentConfigRev']],
      ]) {
        try {
          const module = await import(modulePath);
          for (const name of names) {
            if (typeof module[name] === 'function') {
              configRev = await module[name]();
              break;
            }
          }
        } catch {
          /* module not landed yet */
        }
        if (configRev != null) break;
      }
      if (configRev == null) {
        configRev = 'qa-unknown-configrev';
        console.error(
          'WARN: no lane-2 configRev export found (computeConfigRev) — watermark minted with a placeholder; ' +
            'the provider gate will suppress as unseeded. REQUEST to lane 2: export computeConfigRev().',
        );
      }
      setMeta('notifyWatermark', JSON.stringify({ cutoffMs, searchId, configRev }));
      setMeta('seededAt', String(Date.now()));
      console.log(JSON.stringify({ cutoffMs, searchId, configRev }));
      break;
    }
    case 'qa-ensure-job': {
      const { getJobs, upsertJob } = await import('../../../lib/services/storage/jobStorage.js');
      const existing = getJobs({ includeDisabled: true }).find((job) =>
        (job.provider ?? []).some((provider) => provider.id === 'streamEstate'),
      );
      if (existing != null) {
        console.log(`job exists: ${existing.id}`);
        break;
      }
      const { getUsers } = await import('../../../lib/services/storage/userStorage.js');
      const users = getUsers(false) ?? [];
      const admin = users.find((user) => user.isAdmin) ?? users[0];
      if (admin == null) {
        console.error('no user found — boot the server once (ensureAdminUserExists) before qa-ensure-job');
        process.exit(EXIT_NOT_READY);
      }
      upsertJob({
        jobId: 'paris-hunter',
        name: 'paris-hunter',
        provider: [{ id: 'streamEstate', url: 'inbox://stream-estate', enabled: true }],
        notificationAdapter: [{ id: 'convos', name: 'Convos (XMTP)', fields: {} }],
        userId: admin.userId ?? admin.id,
        enabled: true,
      });
      console.log('job paris-hunter created (QA)');
      break;
    }
    case 'assert-final': {
      requireTables();
      const dedupKey = args[0];
      if (!dedupKey) {
        console.error('usage: db.js assert-final <dedupKey> [--mode offline|live] [--deadline <s>]');
        process.exit(EXIT_USAGE);
      }
      const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'offline';
      const deadlineS = args.includes('--deadline') ? Number(args[args.indexOf('--deadline') + 1]) : 90;
      const { pass, detail } = await assertFinal(dedupKey, { mode, deadlineS });
      console.log(JSON.stringify({ pass, dedupKey, mode, ...detail }, null, 2));
      process.exit(pass ? 0 : EXIT_FAIL);
      break;
    }
    default:
      console.error(
        'usage: node --env-file-if-exists=.env tools/paris-hunter/qa/db.js ' +
          '<tables|get-meta|set-meta|inbox-row|outbox-row|counts|assert-final> [...args]',
      );
      process.exit(EXIT_USAGE);
  }
}

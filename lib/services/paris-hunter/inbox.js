/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: stream_estate_inbox + paris_hunter_meta storage access
 * (build plan v2 #1/#2/#19 + v3 A2/A4/A7/A8).
 *
 * Durability model: webhook payloads are INSERTED here (with the payload
 * timestamp normalized to epoch ms at ingress — A4) and later CLAIMED by the
 * provider under a lease owned by this process boot (bootId). Completion is a
 * CAS on lease ownership inside the provider's per-row decision transaction:
 * a row whose lease was lost (expired + reclaimed) rolls the whole row-tx back
 * so the current owner decides it exactly once. Never drain-on-read.
 *
 * The usage counter increments in the SAME transaction as the insert (A7), so
 * counter and rows can never diverge.
 */

import crypto from 'node:crypto';
import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';
import { recordUsageInTx } from './budget.js';

/** Lease duration for claimed inbox rows (5 min). */
export const LEASE_MS = 300_000;
/** Renew leases when a drain has been running longer than this (v3 A2). */
export const LEASE_RENEW_AFTER_MS = 120_000;
/** Per-row failures before a row is dead-lettered (v3 A8). */
export const MAX_ROW_ATTEMPTS = 5;

/**
 * Lease owner id — generated ONCE per process (v3 A2). Any lease carrying a
 * different bootId is by definition dead after a restart (kernel-enforced
 * SQLite adapter lock + single replica invariant) and is cleared by
 * recoverDeadLeases() at startup.
 */
export const bootId = crypto.randomUUID();

/** Timestamp sanity bounds (v3 A4): [2020-01-01, now + 24h]. */
const MIN_EVENT_MS = Date.UTC(2020, 0, 1);
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
/** Epoch-seconds vs epoch-ms disambiguation pivot (~ year 2255 in seconds). */
const EPOCH_SECONDS_PIVOT = 9_000_000_000;

/**
 * Normalizes a payload timestamp to integer epoch ms at ingress (v3 A4).
 * Accepts ISO-8601 with any timezone offset, or numeric epoch in seconds or
 * milliseconds (disambiguated by magnitude). Returns null for anything
 * missing, malformed, or outside the sanity bounds [2020-01-01, now + 24h] —
 * a payload we cannot place in time never notifies (fail-silent).
 *
 * @param {unknown} value
 * @returns {number|null} integer epoch ms, or null
 */
export const toEpochMs = (value) => {
  let ms = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value < EPOCH_SECONDS_PIVOT ? value * 1000 : value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      ms = numeric < EPOCH_SECONDS_PIVOT ? numeric * 1000 : numeric;
    } else {
      const parsed = Date.parse(trimmed);
      ms = Number.isNaN(parsed) ? null : parsed;
    }
  }
  if (ms == null || !Number.isFinite(ms)) {
    return null;
  }
  ms = Math.round(ms);
  if (ms < MIN_EVENT_MS || ms > Date.now() + MAX_FUTURE_SKEW_MS) {
    return null;
  }
  return ms;
};

/**
 * Inserts a webhook delivery into the durable inbox. The usage counter is
 * incremented in the SAME transaction (v3 A7).
 *
 * @param {{ kind: 'match'|'event', externalId: string|null, payload: string, eventAt?: number|null }} row
 * @returns {number} inserted row id
 */
export const insertInbox = ({ kind, externalId, payload, eventAt = null }) => {
  const now = Date.now();
  return SqliteConnection.withTransaction((db) => {
    const info = db
      .prepare(
        `INSERT INTO stream_estate_inbox (kind, external_id, payload, received_at, event_at)
         VALUES (@kind, @externalId, @payload, @receivedAt, @eventAt)`,
      )
      .run({
        kind,
        externalId: externalId ?? null,
        payload,
        receivedAt: now,
        eventAt: Number.isInteger(eventAt) ? eventAt : null,
      });
    recordUsageInTx(db, now);
    return Number(info.lastInsertRowid);
  });
};

/**
 * Claims up to `limit` claimable rows for this boot (v3 A2, atomic,
 * owner-stamped): one transaction leases the oldest claimable rows
 * (done_at IS NULL AND lease absent/expired) to bootId, then returns ALL
 * undone rows currently leased by this boot.
 *
 * @param {number} [limit]
 * @returns {Array<object>} leased inbox rows (oldest first)
 */
export const claimInbox = (limit = 200) => {
  const now = Date.now();
  return SqliteConnection.withTransaction((db) => {
    db.prepare(
      `UPDATE stream_estate_inbox SET lease_id = @bootId, lease_until = @leaseUntil
       WHERE id IN (
         SELECT id FROM stream_estate_inbox
         WHERE done_at IS NULL AND (lease_until IS NULL OR lease_until < @now)
         ORDER BY id LIMIT @limit
       )`,
    ).run({ bootId, leaseUntil: now + LEASE_MS, now, limit });
    return db
      .prepare('SELECT * FROM stream_estate_inbox WHERE lease_id = @bootId AND done_at IS NULL ORDER BY id')
      .all({ bootId });
  });
};

/**
 * Marks a row done with its decision — CAS on lease ownership (v3 A2). MUST be
 * called inside the provider's per-row decision transaction (pass the raw db
 * handle via options.db); the caller must ROLL BACK the whole row-tx when this
 * returns 0 changes (ownership lost: expired + reclaimed elsewhere).
 *
 * @param {number} id inbox row id
 * @param {string} decision 'outboxed'|'suppressed:watermark'|'suppressed:unseeded'
 *   |'suppressed:invalid-timestamp'|'excluded:<term>'|'quarantine:<field>'
 *   |'skip:price_increase'|'duplicate'|'dead-letter:<errClass>'
 * @param {{ db?: object, error?: string|null }} [options]
 * @returns {number} number of updated rows (0 = lost ownership)
 */
export const completeInbox = (id, decision, { db, error = null } = {}) => {
  const handle = db ?? SqliteConnection.getConnection();
  const info = handle
    .prepare(
      `UPDATE stream_estate_inbox
       SET done_at = @now, decision = @decision, error = @error, lease_id = NULL, lease_until = NULL
       WHERE id = @id AND lease_id = @bootId AND done_at IS NULL`,
    )
    .run({ id, decision, error, now: Date.now(), bootId });
  return info.changes;
};

/**
 * Per-row failure bookkeeping (v3 A8): increments attempts while we still own
 * the lease. Returns the new attempts count, or null when the row is no longer
 * ours (lost lease / already done) — callers must then skip the row.
 *
 * @param {number} id
 * @returns {number|null}
 */
export const bumpAttempts = (id) => {
  return SqliteConnection.withTransaction((db) => {
    const info = db
      .prepare(
        'UPDATE stream_estate_inbox SET attempts = attempts + 1 WHERE id = @id AND lease_id = @bootId AND done_at IS NULL',
      )
      .run({ id, bootId });
    if (info.changes === 0) {
      return null;
    }
    const row = db.prepare('SELECT attempts FROM stream_estate_inbox WHERE id = @id').get({ id });
    return row?.attempts ?? null;
  });
};

/**
 * Releases a single row's lease (immediate re-claimability after a per-row
 * failure — v3 A8).
 *
 * @param {number} id
 * @returns {void}
 */
export const releaseRow = (id) => {
  SqliteConnection.execute(
    'UPDATE stream_estate_inbox SET lease_id = NULL, lease_until = NULL WHERE id = @id AND lease_id = @bootId AND done_at IS NULL',
    { id, bootId },
  );
};

/**
 * Re-arms this boot's leases during a long drain (v3 A2 renewal).
 * @returns {void}
 */
export const renewLeases = () => {
  SqliteConnection.execute(
    'UPDATE stream_estate_inbox SET lease_until = @leaseUntil WHERE lease_id = @bootId AND done_at IS NULL',
    { leaseUntil: Date.now() + LEASE_MS, bootId },
  );
};

/**
 * Orderly release (v3 A2): rows claimed but not decided become immediately
 * claimable. Called in a finally at the end of every getListings() run and on
 * SIGTERM.
 *
 * @returns {void}
 */
export const releaseLeases = () => {
  SqliteConnection.execute(
    'UPDATE stream_estate_inbox SET lease_id = NULL, lease_until = NULL WHERE lease_id = @bootId AND done_at IS NULL',
    { bootId },
  );
};

/**
 * Dead-boot recovery (v3 A2): clears every foreign lease on undone rows.
 * Sound because exactly one process exists (exclusive adapter lock + single
 * replica invariant): any lease not carrying OUR bootId is dead. Runs as
 * startInboxWatchdog()'s FIRST action after the lock has been acquired, so
 * crash-after-claim recovery latency is next-boot-instant.
 *
 * @returns {number} number of recovered rows
 */
export const recoverDeadLeases = () => {
  const info = SqliteConnection.execute(
    'UPDATE stream_estate_inbox SET lease_id = NULL, lease_until = NULL WHERE done_at IS NULL AND lease_id IS NOT NULL AND lease_id != @bootId',
    { bootId },
  );
  if (info.changes > 0) {
    logger.info(`paris-hunter inbox: recovered ${info.changes} dead lease(s) at startup.`);
  }
  return info.changes;
};

/**
 * @returns {number} count of ALL undone inbox rows (in-flight + claimable)
 */
export const countPending = () => {
  const row = SqliteConnection.query('SELECT COUNT(1) AS c FROM stream_estate_inbox WHERE done_at IS NULL');
  return row[0]?.c ?? 0;
};

/**
 * Claimable = undone AND (no lease OR lease expired) — v3 A3. Rows under a
 * live lease of the current boot are in-flight, not claimable; foreign leases
 * are cleared at boot (A2), so the watchdog never stares at a dead lease.
 *
 * @returns {number}
 */
export const countClaimable = () => {
  const row = SqliteConnection.query(
    'SELECT COUNT(1) AS c FROM stream_estate_inbox WHERE done_at IS NULL AND (lease_until IS NULL OR lease_until < @now)',
    { now: Date.now() },
  );
  return row[0]?.c ?? 0;
};

/**
 * @param {string} key e.g. 'notifyWatermark' | 'searchId' | 'searchToken' | 'seededAt' | 'usage:<YYYY-MM>'
 * @returns {string|null}
 */
export const getParisHunterMeta = (key) => {
  try {
    const row = SqliteConnection.query('SELECT value FROM paris_hunter_meta WHERE key = @key', { key });
    return row[0]?.value ?? null;
  } catch {
    // Table absent (pre-migration boot paths, upstream tests): fail-silent —
    // a missing meta store must keep every notification gate suppressing.
    return null;
  }
};

/**
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
export const setParisHunterMeta = (key, value) => {
  SqliteConnection.execute(
    'INSERT INTO paris_hunter_meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value',
    { key, value },
  );
};

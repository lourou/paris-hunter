/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: stream_estate_inbox + paris_hunter_meta storage access.
 *
 * STUB (lane 1) — real implementation is owned by lane 2 (sqlite tables come with
 * migration 22.paris-hunter.js: stream_estate_inbox, ph_seen, paris_hunter_meta,
 * convos_outbox — build plan v2 shared contract 3).
 *
 * v2 semantics: leased claims, NEVER drain-on-read (#1). claimInbox leases rows
 * (lease_until = now + 5 min); completeInbox marks a decision inside the provider's
 * atomic per-row transaction; crashed runs roll back and leases expire, so the
 * watchdog re-claims them. The undone rows are the durable dirty flag (#2).
 *
 * Neutral behavior until lane 2 lands: empty inbox, no meta — keeps the
 * silent-first-run invariant safe by default (no seededAt/notifyWatermark ->
 * notifications suppressed).
 */

/**
 * @param {{ kind: 'match'|'event', externalId: string|null, payload: string }} row
 * @returns {number|null} inserted row id
 */
export const insertInbox = ({ kind, externalId, payload }) => {
  void kind;
  void externalId;
  void payload;
  // TODO(lane 2): INSERT INTO stream_estate_inbox, return lastInsertRowid.
  return null;
};

/**
 * Claim up to `limit` pending rows (done_at IS NULL AND lease expired/absent)
 * inside one transaction: select-then-lease (lease_id, lease_until = now + 300 000).
 *
 * @param {number} [limit]
 * @returns {Array<object>} leased inbox rows (oldest first)
 */
export const claimInbox = (limit = 200) => {
  void limit;
  // TODO(lane 2): tx select-then-lease.
  return [];
};

/**
 * Mark a row done with its decision — called INSIDE the provider's atomic
 * per-row transaction (ph_seen insert + convos_outbox insert + this).
 *
 * @param {number} id inbox row id
 * @param {string} decision 'outboxed'|'suppressed:watermark'|'suppressed:unseeded'
 *   |'excluded:<term>'|'quarantine:<field>'|'skip:price_increase'|'duplicate'
 * @param {{ tx?: object }} [options] enclosing better-sqlite3 transaction
 * @returns {void}
 */
export const completeInbox = (id, decision, { tx } = {}) => {
  void id;
  void decision;
  void tx;
  // TODO(lane 2): UPDATE stream_estate_inbox SET done_at, decision.
};

/**
 * @returns {number} count of undone, unleased inbox rows (watchdog dirty flag)
 */
export const countPending = () => {
  // TODO(lane 2): SELECT COUNT(*) pending.
  return 0;
};

/**
 * @param {string} key one of 'notifyWatermark' | 'searchId' | 'searchToken' | 'seededAt' | 'usage:<YYYY-MM>'
 * @returns {string|null}
 */
export const getParisHunterMeta = (key) => {
  void key;
  // TODO(lane 2): SELECT value FROM paris_hunter_meta. Returning null keeps the
  // notification gates suppressing (unseeded deploy cannot notify).
  return null;
};

/**
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
export const setParisHunterMeta = (key, value) => {
  void key;
  void value;
  // TODO(lane 2): INSERT INTO paris_hunter_meta ... ON CONFLICT(key) DO UPDATE.
};

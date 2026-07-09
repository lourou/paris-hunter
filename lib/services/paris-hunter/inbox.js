/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: stream_estate_inbox + paris_hunter_meta storage access.
 *
 * STUB (lane 1) — real implementation is owned by lane 2 (sqlite tables come with
 * migration 22.paris-hunter.js: stream_estate_inbox, paris_hunter_meta,
 * convos_outbox — see build plan shared contract 3).
 *
 * Neutral behavior until lane 2 lands: the inbox is empty and no meta is set —
 * this keeps the silent-first-run invariant safe by default (no seededAt ->
 * notifications suppressed).
 */

/**
 * @param {{ kind: 'match'|'event', externalId: string|null, payload: string }} row
 * @returns {void}
 */
export const insertInbox = ({ kind, externalId, payload }) => {
  void kind;
  void externalId;
  void payload;
  // TODO(lane 2): INSERT INTO stream_estate_inbox
};

/**
 * @param {number} [limit]
 * @returns {Array<object>} undrained inbox rows (oldest first)
 */
export const drainInbox = (limit = 200) => {
  void limit;
  // TODO(lane 2): SELECT undrained rows
  return [];
};

/**
 * @param {Array<number>} ids
 * @returns {void}
 */
export const markDrained = (ids) => {
  void ids;
  // TODO(lane 2): UPDATE stream_estate_inbox SET drained_at = now
};

/**
 * @param {string} key one of 'seededAt' | 'searchId' | 'searchToken'
 * @returns {string|null}
 */
export const getParisHunterMeta = (key) => {
  void key;
  // TODO(lane 2): SELECT value FROM paris_hunter_meta. Returning null keeps the
  // _notify guard suppressing notifications (unseeded deploy cannot notify).
  return null;
};

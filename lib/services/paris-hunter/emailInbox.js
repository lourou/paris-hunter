/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: durable raw-email inbox storage access.
 *
 * Increment 1 only persists inbound MIME. Lease, parsing, and completion
 * helpers arrive with the Increment 2 drain path.
 */

import SqliteConnection from '../storage/SqliteConnection.js';

/**
 * Inserts a received email into the durable inbox. Raw MIME is stored verbatim
 * on receipt (durable snapshot) before any parsing.
 *
 * @param {{ source?: string, searchTag?: string|null, rawMime: string, eventAt?: number|null }} row
 * @returns {number} inserted row id
 */
export const insertEmailInbox = ({ source = 'seloger', searchTag = null, rawMime, eventAt = null }) => {
  const now = Date.now();
  return SqliteConnection.withTransaction((db) => {
    const info = db
      .prepare(
        `INSERT INTO email_inbox (source, search_tag, raw_mime, received_at, event_at)
         VALUES (@source, @searchTag, @rawMime, @receivedAt, @eventAt)`,
      )
      .run({
        source,
        searchTag: searchTag ?? null,
        rawMime,
        receivedAt: now,
        eventAt: Number.isInteger(eventAt) ? eventAt : null,
      });
    return Number(info.lastInsertRowid);
  });
};

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Migration: paris-hunter durability tables (build plan v2 shared contract 3 +
 * v3 addendum deltas).
 *
 * - stream_estate_inbox: durable webhook ingestion queue. Rows are CLAIMED with
 *   leases (lease_id = process bootId, lease_until = now + 5 min) and completed
 *   with a CAS on lease ownership — never drain-on-read. `event_at` is the
 *   payload timestamp normalized to epoch ms AT INGRESS (v3 A4); `attempts`
 *   counts per-row processing failures for the dead-letter path (v3 A8).
 * - ph_seen: decision-exactly-once ledger keyed by ph.dedupKey.
 * - paris_hunter_meta: key/value store (notifyWatermark JSON, searchId,
 *   searchToken, seededAt, usage:<YYYY-MM>, disable_required, disable_confirmed).
 * - convos_outbox: at-least-once delivery outbox drained by the convos adapter
 *   (lane 3); one row per dedupKey, INSERT OR IGNORE only.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE stream_estate_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('match','event')),
      external_id TEXT,
      payload TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      event_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_id TEXT,
      lease_until INTEGER,
      done_at INTEGER,
      decision TEXT,
      error TEXT
    );
    CREATE INDEX idx_se_inbox_pending ON stream_estate_inbox (done_at, lease_until);

    CREATE TABLE ph_seen (
      dedup_key TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL
    );

    CREATE TABLE paris_hunter_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE convos_outbox (
      id TEXT PRIMARY KEY,
      dedup_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      image_url TEXT,
      enc_meta TEXT,
      image_state TEXT NOT NULL DEFAULT 'pending',
      text_state TEXT NOT NULL DEFAULT 'pending',
      image_message_id TEXT,
      text_message_id TEXT,
      state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      last_error TEXT
    );
  `);
}

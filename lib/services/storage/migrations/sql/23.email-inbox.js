/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Migration: durable raw-email ingestion queue.
 *
 * email_inbox mirrors the Stream Estate inbox lease and completion fields for
 * Increment 2 draining. Increment 1 stores the raw MIME snapshot immediately;
 * parsed payload and email-derived metadata remain nullable until Increment 2.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {void}
 */
export function up(db) {
  db.exec(`
    CREATE TABLE email_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT 'seloger' CHECK (source IN ('seloger')),
      search_tag TEXT,                 -- from the email Subject (Increment 2), nullable now
      external_id TEXT,                -- source ad id if resolvable (Increment 2), nullable
      raw_mime TEXT NOT NULL,          -- RAW MIME, durable snapshot stored the instant received
      payload TEXT,                    -- parsed JSON (Increment 2), nullable now
      received_at INTEGER NOT NULL,
      event_at INTEGER,                -- email Date: header → epoch ms (Increment 2), nullable
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_id TEXT,
      lease_until INTEGER,
      done_at INTEGER,
      decision TEXT,
      error TEXT
    );
    CREATE INDEX idx_email_inbox_pending ON email_inbox (done_at, lease_until);
  `);
}

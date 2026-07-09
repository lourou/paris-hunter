/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/* eslint-disable no-console */

/**
 * paris-hunter: operator tool for parked convos_outbox rows (build plan v2 #15, lane 6).
 *
 * Rows reach state='parked' after 10 real send attempts (lane 3 parks them with an
 * ERROR log). This tool lists and requeues them once the underlying issue is fixed.
 *
 * usage: node --env-file-if-exists=.env tools/paris-hunter/qa/requeue-outbox.js [options]
 *   (no args)            list parked rows (id, kind, attempts, last_error, states)
 *   --requeue <id,...>   requeue specific rows: state='queued', attempts=0, last_error=NULL
 *   --all                requeue every parked row
 *
 * NOTE: this only flips DB state; the adapter's 60 s flush timer (or a restart)
 * picks the rows up. image/text states are NOT touched here — 'sending' recovery is
 * boot-only and owned by the adapter (v3 A6); rows in 'sent' legs stay sent.
 *
 * Exit: 0 ok · 2 tables missing (lane 2 pending) · 3 usage error.
 */

import SqliteConnection from '../../../lib/services/storage/SqliteConnection.js';
import { openDb, requireTables, EXIT_USAGE } from './db.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

await openDb();
requireTables();

const parked = SqliteConnection.query(
  "SELECT id, kind, image_state, text_state, attempts, last_error, created_at FROM convos_outbox WHERE state = 'parked'",
);

if (opt('--requeue') == null && !args.includes('--all')) {
  if (parked.length === 0) {
    console.log('no parked outbox rows');
  } else {
    console.log(`${parked.length} parked row(s):`);
    for (const row of parked) {
      console.log(
        `  ${row.id} kind=${row.kind} attempts=${row.attempts} image=${row.image_state} text=${row.text_state} ` +
          `last_error=${row.last_error ?? '(none)'}`,
      );
    }
    console.log('requeue with: requeue-outbox.js --requeue <id,...> | --all');
  }
  process.exit(0);
}

let targets = [];
if (args.includes('--all')) {
  targets = parked.map((row) => row.id);
} else {
  const wanted = opt('--requeue')
    .split(',')
    .map((value) => value.trim());
  targets = parked.filter((row) => wanted.includes(row.id)).map((row) => row.id);
  const missing = wanted.filter((id) => !targets.includes(id));
  if (missing.length > 0) {
    console.error(`not parked (skipped): ${missing.join(', ')}`);
  }
}

if (targets.length === 0) {
  console.error('nothing to requeue');
  process.exit(EXIT_USAGE);
}

const placeholders = targets.map((_, index) => `:id${index}`).join(',');
const params = Object.fromEntries(targets.map((id, index) => [`id${index}`, id]));
const info = SqliteConnection.execute(
  `UPDATE convos_outbox SET state = 'queued', attempts = 0, last_error = NULL WHERE state = 'parked' ` +
    `AND id IN (${placeholders})`,
  params,
);
console.log(`requeued ${info.changes} row(s) — the adapter flush timer (60 s) or a restart will retry them`);

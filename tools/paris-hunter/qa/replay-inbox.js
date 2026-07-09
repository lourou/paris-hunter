/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/* eslint-disable no-console */

/**
 * paris-hunter QA: inbox replay + exactly-once prover (lane 6).
 *
 * Resets selected stream_estate_inbox rows to undone/unleased so the pipeline
 * reprocesses them. With leased claims + the per-row atomic decision tx (build plan
 * v2 #1), a replayed already-outboxed row must land on decision 'duplicate' and
 * MUST NOT create a second convos_outbox / ph_seen row — that is the assertion.
 *
 * usage: node --env-file-if-exists=.env tools/paris-hunter/qa/replay-inbox.js <selector> [options]
 *   selectors (one required):
 *     --ids 1,2,3            explicit inbox row ids
 *     --external-id <uuid>   all rows whose external_id contains <uuid>
 *     --last <n>             the n newest done rows
 *     --requeue-dead-letter  all rows with decision LIKE 'dead-letter:%' (v3 A8):
 *                            resets done_at, decision AND attempts to 0
 *   options:
 *     --assert-once <dedupKey>   after replay, poll until the row is done again and
 *                                assert ph_seen=1 and convos_outbox=1 for the key
 *     --wait <s>                 poll budget for --assert-once (default 60)
 *     --dry-run                  print what would be reset
 *
 * NOTE: this tool only flips DB state. The running server's inbox watchdog re-emits
 * jobs:runOne within 15 s while undone+unleased rows exist (v2 #2) — the server must
 * be running for the replay to be processed.
 *
 * Exit: 0 ok/assert pass · 1 assert fail · 2 tables missing (lane 2 pending) · 3 usage.
 */

import SqliteConnection from '../../../lib/services/storage/SqliteConnection.js';
import { openDb, requireTables, countsFor, assertFinal, EXIT_FAIL, EXIT_USAGE } from './db.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const flag = (name) => args.includes(name);

await openDb();
requireTables();

let rows = [];
let deadLetterMode = false;
if (flag('--requeue-dead-letter')) {
  deadLetterMode = true;
  rows = SqliteConnection.query(
    "SELECT id, kind, external_id, decision, done_at FROM stream_estate_inbox WHERE decision LIKE 'dead-letter:%'",
  );
} else if (opt('--ids') != null) {
  const ids = opt('--ids')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite);
  rows = SqliteConnection.query(
    `SELECT id, kind, external_id, decision, done_at FROM stream_estate_inbox WHERE id IN (${ids.join(',')})`,
  );
} else if (opt('--external-id') != null) {
  rows = SqliteConnection.query(
    'SELECT id, kind, external_id, decision, done_at FROM stream_estate_inbox WHERE external_id LIKE :pattern',
    { pattern: `%${opt('--external-id')}%` },
  );
} else if (opt('--last') != null) {
  rows = SqliteConnection.query(
    'SELECT id, kind, external_id, decision, done_at FROM stream_estate_inbox WHERE done_at IS NOT NULL ' +
      'ORDER BY id DESC LIMIT :n',
    { n: Number(opt('--last')) },
  );
} else {
  console.error(
    'usage: replay-inbox.js --ids 1,2,3 | --external-id <uuid> | --last <n> | --requeue-dead-letter ' +
      '[--assert-once <key>]',
  );
  process.exit(EXIT_USAGE);
}

if (rows.length === 0) {
  console.error('no matching inbox rows — nothing to replay');
  process.exit(EXIT_USAGE);
}

for (const row of rows) {
  console.log(`replay: inbox #${row.id} kind=${row.kind} external_id=${row.external_id} (was: ${row.decision})`);
}

if (flag('--dry-run')) {
  console.log(`dry-run: ${rows.length} row(s) would be reset`);
  process.exit(0);
}

const ids = rows.map((row) => row.id).join(',');
if (deadLetterMode) {
  // A8: dead-letter requeue also clears decision + attempts so the row gets 5 fresh tries.
  SqliteConnection.execute(
    'UPDATE stream_estate_inbox SET done_at = NULL, decision = NULL, attempts = 0, lease_id = NULL, ' +
      `lease_until = NULL WHERE id IN (${ids})`,
  );
} else {
  SqliteConnection.execute(
    `UPDATE stream_estate_inbox SET done_at = NULL, lease_id = NULL, lease_until = NULL WHERE id IN (${ids})`,
  );
}
console.log(`reset ${rows.length} row(s) to undone/unleased — the watchdog re-emits within 15 s (server must run)`);

const assertKey = opt('--assert-once');
if (assertKey != null) {
  const waitS = Number(opt('--wait') ?? 60);
  const { pass, detail } = await assertFinal(assertKey, { mode: 'offline', deadlineS: waitS });
  const counts = countsFor(assertKey);
  console.log(JSON.stringify({ assertOnce: assertKey, pass, counts, detail }, null, 2));
  if (!pass || counts.outbox !== 1 || counts.seen !== 1) {
    console.error(`EXACTLY-ONCE VIOLATION (or timeout) for ${assertKey}: outbox=${counts.outbox} seen=${counts.seen}`);
    process.exit(EXIT_FAIL);
  }
  console.log(`exactly-once holds for ${assertKey}: 1 outbox row, 1 seen row after replay`);
}

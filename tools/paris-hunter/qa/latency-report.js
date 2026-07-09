/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/* eslint-disable no-console */

/**
 * paris-hunter QA: webhook-receipt -> Convos-send latency report (lane 6).
 *
 * Joins stream_estate_inbox.received_at with convos_outbox.sent_at on ph.dedupKey
 * (derived per contract — NEVER on listing ids, which Fredy mutates; v2 #8) and
 * prints p50/p95/max. Asserts the brief §4.5 budget: p95 < 30 s (webhook->send leg).
 *
 * usage: node --env-file-if-exists=.env tools/paris-hunter/qa/latency-report.js [options]
 *   --since <ISO|epoch-ms>   only inbox rows received after this instant
 *   --budget-ms <n>          p95 budget (default 30000)
 *   --json                   machine-readable output
 *
 * Exit: 0 pass · 1 p95 over budget · 2 tables missing (lane 2 pending) · 3 no joined rows.
 */

import SqliteConnection from '../../../lib/services/storage/SqliteConnection.js';
import { openDb, requireTables, deriveDedupKey, toEpochMs } from './db.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

await openDb();
requireTables();

const sinceMs = opt('--since') != null ? (toEpochMs(opt('--since')) ?? 0) : 0;
const budgetMs = Number(opt('--budget-ms') ?? 30000);

const inboxRows = SqliteConnection.query(
  "SELECT id, kind, external_id, payload, received_at, decision FROM stream_estate_inbox WHERE decision = 'outboxed' " +
    'AND received_at >= :since',
  { since: sinceMs },
);

const samples = [];
let unjoined = 0;
for (const row of inboxRows) {
  const dedupKey = deriveDedupKey(row);
  if (dedupKey == null) {
    unjoined += 1;
    continue;
  }
  const outbox = SqliteConnection.query(
    'SELECT sent_at FROM convos_outbox WHERE (id = :key OR dedup_key = :key) AND sent_at IS NOT NULL LIMIT 1',
    { key: dedupKey },
  )[0];
  if (outbox == null) {
    unjoined += 1;
    continue;
  }
  samples.push({ dedupKey, receivedAt: row.received_at, sentAt: outbox.sent_at, ms: outbox.sent_at - row.received_at });
}

const percentile = (sorted, p) => {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
};

const sorted = samples.map((sample) => sample.ms).sort((a, b) => a - b);
const report = {
  outboxedRows: inboxRows.length,
  joined: samples.length,
  unjoined,
  p50Ms: percentile(sorted, 0.5),
  p95Ms: percentile(sorted, 0.95),
  maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
  budgetMs,
  pass: sorted.length > 0 && percentile(sorted, 0.95) < budgetMs,
};

if (args.includes('--json')) {
  console.log(JSON.stringify({ ...report, samples }, null, 2));
} else {
  console.log(`latency report (webhook receipt -> outbox sent_at, joined on ph.dedupKey)`);
  console.log(`  rows outboxed: ${report.outboxedRows} · joined: ${report.joined} · unjoined/pending: ${unjoined}`);
  console.log(`  p50: ${report.p50Ms} ms · p95: ${report.p95Ms} ms · max: ${report.maxMs} ms`);
  console.log(`  budget: p95 < ${budgetMs} ms -> ${report.pass ? 'PASS' : 'FAIL'}`);
}

if (samples.length === 0) {
  console.error('no joined rows — nothing sent yet (adapter pending, or run --since is too narrow)');
  process.exit(3);
}
process.exit(report.pass ? 0 : 1);

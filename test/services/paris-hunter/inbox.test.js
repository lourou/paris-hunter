/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemorySqlite, mockSqliteConnection } from './memoryDb.js';

const holder = vi.hoisted(() => ({ current: null }));
const logged = vi.hoisted(() => ({ info: [], warn: [], error: [] }));

vi.hoisted(() => {
  process.env.STREAM_ESTATE_WEBHOOK_SECRET = 'f'.repeat(48);
});

vi.mock('../../../lib/services/storage/SqliteConnection.js', () => mockSqliteConnection(holder));
vi.mock('../../../lib/services/logger.js', () => ({
  default: {
    info: (msg) => logged.info.push(String(msg)),
    warn: (msg) => logged.warn.push(String(msg)),
    error: (msg) => logged.error.push(String(msg)),
    debug: () => {},
  },
}));

import {
  bootId,
  bumpAttempts,
  claimInbox,
  completeInbox,
  countClaimable,
  countPending,
  getParisHunterMeta,
  insertInbox,
  recoverDeadLeases,
  releaseLeases,
  releaseRow,
  renewLeases,
  setParisHunterMeta,
  toEpochMs,
  LEASE_MS,
} from '../../../lib/services/paris-hunter/inbox.js';
import { usageKeyFor } from '../../../lib/services/paris-hunter/budget.js';

const insertOne = (overrides = {}) =>
  insertInbox({ kind: 'match', externalId: 'uuid-1', payload: '{"a":1}', eventAt: Date.now() - 1000, ...overrides });

beforeEach(() => {
  holder.current = createMemorySqlite();
  logged.info.length = 0;
  logged.warn.length = 0;
  logged.error.length = 0;
});

describe('toEpochMs — ingress timestamp normalization (v3 A4)', () => {
  it('parses ISO-8601 with Z', () => {
    expect(toEpochMs('2026-07-08T10:00:00Z')).toBe(Date.UTC(2026, 6, 8, 10, 0, 0));
  });

  it('yields IDENTICAL ms for the same instant with Z vs +02:00', () => {
    expect(toEpochMs('2026-07-08T12:00:00+02:00')).toBe(toEpochMs('2026-07-08T10:00:00Z'));
  });

  it('always returns an integer', () => {
    expect(Number.isInteger(toEpochMs('2026-07-08T10:00:00.123Z'))).toBe(true);
  });

  it('scales epoch-seconds input correctly (number and numeric string)', () => {
    const seconds = Math.floor(Date.UTC(2026, 5, 1) / 1000);
    expect(toEpochMs(seconds)).toBe(seconds * 1000);
    expect(toEpochMs(String(seconds))).toBe(seconds * 1000);
  });

  it('passes epoch-ms input through', () => {
    const ms = Date.UTC(2026, 5, 1);
    expect(toEpochMs(ms)).toBe(ms);
  });

  it.each(['yesterday', '', '2026-13-45', null, undefined, {}, [], NaN])('returns null for %j', (value) => {
    expect(toEpochMs(value)).toBe(null);
  });

  it('rejects timestamps outside the sanity bounds [2020-01-01, now + 24h]', () => {
    expect(toEpochMs('2019-12-31T23:59:59Z')).toBe(null);
    expect(toEpochMs(Date.now() + 25 * 60 * 60 * 1000)).toBe(null);
    expect(toEpochMs('2020-01-01T00:00:00Z')).toBe(Date.UTC(2020, 0, 1));
  });
});

describe('insertInbox — atomic insert + usage counter (v3 A7)', () => {
  it('inserts the row with its ingress event_at and returns the row id', () => {
    const eventAt = Date.now() - 5000;
    const id = insertOne({ eventAt });
    const row = holder.current.query('SELECT * FROM stream_estate_inbox WHERE id = @id', { id })[0];
    expect(row.kind).toBe('match');
    expect(row.event_at).toBe(eventAt);
    expect(row.attempts).toBe(0);
    expect(row.done_at).toBe(null);
  });

  it('stores NULL event_at for non-integer input', () => {
    const id = insertOne({ eventAt: null });
    const row = holder.current.query('SELECT event_at FROM stream_estate_inbox WHERE id = @id', { id })[0];
    expect(row.event_at).toBe(null);
  });

  it('increments the monthly usage counter in the SAME transaction', () => {
    insertOne();
    insertOne();
    insertOne();
    expect(getParisHunterMeta(usageKeyFor())).toBe('3');
  });
});

describe('claim / complete — lease CAS (v3 A2)', () => {
  it('claims pending rows for this boot and completes them exactly once', () => {
    const id = insertOne();
    const rows = claimInbox(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].lease_id).toBe(bootId);
    expect(rows[0].lease_until).toBeGreaterThan(Date.now());

    expect(completeInbox(id, 'outboxed')).toBe(1);
    const row = holder.current.query('SELECT * FROM stream_estate_inbox WHERE id = @id', { id })[0];
    expect(row.decision).toBe('outboxed');
    expect(row.done_at).not.toBe(null);
    expect(row.lease_id).toBe(null);

    expect(claimInbox(10)).toHaveLength(0);
  });

  it('completeInbox returns 0 when the lease was stolen (lost ownership)', () => {
    const id = insertOne();
    claimInbox(10);
    holder.current.execute('UPDATE stream_estate_inbox SET lease_id = @other WHERE id = @id', {
      other: 'other-boot',
      id,
    });
    expect(completeInbox(id, 'outboxed')).toBe(0);
    const row = holder.current.query('SELECT done_at FROM stream_estate_inbox WHERE id = @id', { id })[0];
    expect(row.done_at).toBe(null);
  });

  it('completeInbox returns 0 for an already-done row', () => {
    const id = insertOne();
    claimInbox(10);
    expect(completeInbox(id, 'outboxed')).toBe(1);
    expect(completeInbox(id, 'duplicate')).toBe(0);
  });

  it('does not claim rows under a live foreign lease, but claims expired ones', () => {
    const id = insertOne();
    holder.current.execute('UPDATE stream_estate_inbox SET lease_id = @o, lease_until = @until WHERE id = @id', {
      o: 'other-boot',
      until: Date.now() + LEASE_MS,
      id,
    });
    expect(claimInbox(10)).toHaveLength(0);
    expect(countClaimable()).toBe(0);
    expect(countPending()).toBe(1);

    holder.current.execute('UPDATE stream_estate_inbox SET lease_until = @until WHERE id = @id', {
      until: Date.now() - 1,
      id,
    });
    expect(countClaimable()).toBe(1);
    const rows = claimInbox(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].lease_id).toBe(bootId);
  });
});

describe('lease lifecycle helpers (v3 A2/A8)', () => {
  it('recoverDeadLeases clears foreign leases, keeps ours, and logs the locked wording', () => {
    const foreign = insertOne();
    const ours = insertOne({ externalId: 'uuid-2' });
    holder.current.execute('UPDATE stream_estate_inbox SET lease_id = @o, lease_until = @u WHERE id = @id', {
      o: 'dead-boot',
      u: Date.now() + LEASE_MS,
      id: foreign,
    });
    holder.current.execute('UPDATE stream_estate_inbox SET lease_id = @o, lease_until = @u WHERE id = @id', {
      o: bootId,
      u: Date.now() + LEASE_MS,
      id: ours,
    });

    expect(recoverDeadLeases()).toBe(1);
    const rows = holder.current.query('SELECT id, lease_id FROM stream_estate_inbox ORDER BY id');
    expect(rows[0].lease_id).toBe(null);
    expect(rows[1].lease_id).toBe(bootId);
    // Lane 6's A12 pass criterion greps this exact wording.
    expect(logged.info.some((line) => line.includes('recovered 1 dead lease(s)'))).toBe(true);
  });

  it('renewLeases re-arms our lease_until', () => {
    const id = insertOne();
    claimInbox(10);
    holder.current.execute('UPDATE stream_estate_inbox SET lease_until = @u WHERE id = @id', {
      u: Date.now() + 1000,
      id,
    });
    renewLeases();
    const row = holder.current.query('SELECT lease_until FROM stream_estate_inbox WHERE id = @id', { id })[0];
    expect(row.lease_until).toBeGreaterThan(Date.now() + LEASE_MS - 5000);
  });

  it('releaseLeases and releaseRow make undecided claims immediately claimable', () => {
    const a = insertOne();
    const b = insertOne({ externalId: 'uuid-2' });
    claimInbox(10);
    releaseRow(a);
    expect(countClaimable()).toBe(1);
    releaseLeases();
    expect(countClaimable()).toBe(2);
    const rows = holder.current.query('SELECT lease_id FROM stream_estate_inbox WHERE id IN (@a, @b)', { a, b });
    expect(rows.every((r) => r.lease_id == null)).toBe(true);
  });

  it('bumpAttempts increments while owned and returns null after ownership loss', () => {
    const id = insertOne();
    claimInbox(10);
    expect(bumpAttempts(id)).toBe(1);
    expect(bumpAttempts(id)).toBe(2);
    holder.current.execute('UPDATE stream_estate_inbox SET lease_id = @o WHERE id = @id', { o: 'other-boot', id });
    expect(bumpAttempts(id)).toBe(null);
  });
});

describe('paris_hunter_meta', () => {
  it('get/set round-trips and upserts', () => {
    expect(getParisHunterMeta('searchId')).toBe(null);
    setParisHunterMeta('searchId', '/searches/1');
    setParisHunterMeta('searchId', '/searches/2');
    expect(getParisHunterMeta('searchId')).toBe('/searches/2');
  });
});

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import { bus } from '../../../lib/services/events/event-bus.js';
import { startInboxWatchdog, stopInboxWatchdog } from '../../../lib/services/paris-hunter/inboxWatchdog.js';
import { insertInbox, bootId, LEASE_MS } from '../../../lib/services/paris-hunter/inbox.js';
import { PH } from '../../../lib/services/paris-hunter/phConfig.js';

const insertOne = (overrides = {}) =>
  insertInbox({ kind: 'match', externalId: 'uuid-1', payload: '{"a":1}', eventAt: Date.now() - 1000, ...overrides });

let runOneEvents;
let runOneListener;

beforeEach(() => {
  holder.current = createMemorySqlite();
  logged.info.length = 0;
  vi.useFakeTimers();
  runOneEvents = [];
  runOneListener = (payload) => runOneEvents.push(payload);
  bus.on('jobs:runOne', runOneListener);
});

afterEach(() => {
  stopInboxWatchdog();
  bus.off('jobs:runOne', runOneListener);
  vi.useRealTimers();
});

describe('startInboxWatchdog (v3 A2/A3)', () => {
  it('runs dead-boot recovery as its FIRST action', () => {
    const id = insertOne();
    holder.current.execute('UPDATE stream_estate_inbox SET lease_id = @o, lease_until = @u WHERE id = @id', {
      o: 'dead-boot',
      u: Date.now() + LEASE_MS,
      id,
    });

    startInboxWatchdog();

    const row = holder.current.query('SELECT lease_id, lease_until FROM stream_estate_inbox WHERE id = @id', {
      id,
    })[0];
    expect(row.lease_id).toBe(null);
    expect(row.lease_until).toBe(null);
    expect(logged.info.some((line) => line.includes('recovered 1 dead lease(s)'))).toBe(true);
  });

  it('re-emits jobs:runOne on the 15 s poll while claimable rows exist', () => {
    insertOne();
    startInboxWatchdog();
    expect(runOneEvents).toHaveLength(0);

    vi.advanceTimersByTime(15_000);
    expect(runOneEvents).toEqual([{ jobId: PH.jobId }]);

    vi.advanceTimersByTime(15_000);
    expect(runOneEvents).toHaveLength(2);
  });

  it('stays silent when nothing is claimable', () => {
    startInboxWatchdog();
    vi.advanceTimersByTime(60_000);
    expect(runOneEvents).toHaveLength(0);
  });

  it('does not count rows under a live lease of the current boot as claimable', () => {
    const id = insertOne();
    startInboxWatchdog();
    holder.current.execute('UPDATE stream_estate_inbox SET lease_id = @o, lease_until = @u WHERE id = @id', {
      o: bootId,
      u: Date.now() + LEASE_MS,
      id,
    });
    vi.advanceTimersByTime(15_000);
    expect(runOneEvents).toHaveLength(0);
  });

  it('immediately retriggers when a run finishes with claimable rows (v3 A3)', () => {
    insertOne();
    startInboxWatchdog();

    bus.emit('jobs:status', { jobId: PH.jobId, running: false });
    expect(runOneEvents).toEqual([{ jobId: PH.jobId }]);
  });

  it('ignores jobs:status for other jobs and for running:true', () => {
    insertOne();
    startInboxWatchdog();

    bus.emit('jobs:status', { jobId: 'someone-else', running: false });
    bus.emit('jobs:status', { jobId: PH.jobId, running: true });
    expect(runOneEvents).toHaveLength(0);
  });

  it('is idempotent (double start does not double-emit)', () => {
    insertOne();
    startInboxWatchdog();
    startInboxWatchdog();
    vi.advanceTimersByTime(15_000);
    expect(runOneEvents).toHaveLength(1);
  });
});

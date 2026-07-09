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
  // QA drill numbers (v2 §C budget row): budget 3 → warn at row 3 (ceil(0.7×3)),
  // disable_required at row 3 (3 >= 3×0.9).
  process.env.PH_MONTHLY_ITEM_BUDGET = '3';
  process.env.STREAM_ESTATE_API_KEY = 'test-api-key';
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

import { insertInbox, getParisHunterMeta, setParisHunterMeta } from '../../../lib/services/paris-hunter/inbox.js';
import { enforceBudgetDisable, streamEstateApiBase, usageKeyFor } from '../../../lib/services/paris-hunter/budget.js';

const insertOne = (n) =>
  insertInbox({ kind: 'match', externalId: `uuid-${n}`, payload: '{"a":1}', eventAt: Date.now() - 1000 });

beforeEach(() => {
  holder.current = createMemorySqlite();
  logged.info.length = 0;
  logged.warn.length = 0;
  logged.error.length = 0;
  delete process.env.STREAM_ESTATE_API_BASE;
});

describe('usage counter thresholds (v3 A7)', () => {
  it('warns at 70% and persists disable_required at budget × headroom, in the insert tx', () => {
    insertOne(1);
    insertOne(2);
    expect(logged.warn).toHaveLength(0);
    expect(getParisHunterMeta('disable_required')).toBe(null);

    insertOne(3); // 3 = ceil(0.7×3) → warn; 3 >= 2.7 → disable_required
    expect(logged.warn.some((line) => line.includes('usage 3/3'))).toBe(true);
    expect(getParisHunterMeta('disable_required')).toBe('1');

    insertOne(4); // ingest continues past the ceiling
    expect(getParisHunterMeta(usageKeyFor())).toBe('4');
    expect(holder.current.query('SELECT COUNT(1) AS c FROM stream_estate_inbox')[0].c).toBe(4);
  });

  it('does not re-arm disable_required after a confirmed disable this month', () => {
    setParisHunterMeta('disable_confirmed', `${usageKeyFor()}:${Date.now()}`);
    insertOne(1);
    insertOne(2);
    insertOne(3);
    expect(getParisHunterMeta('disable_required')).toBe(null);
  });
});

describe('enforceBudgetDisable — verified server-side disable (v3 A7)', () => {
  const arm = () => {
    setParisHunterMeta('disable_required', '1');
    setParisHunterMeta('searchId', '/searches/99');
  };

  const makeFetch = (searchState) => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET', body: options.body });
      if ((options.method ?? 'GET') === 'PUT') {
        searchState.notificationEnabled = JSON.parse(options.body).notificationEnabled;
        return { ok: true, status: 200, json: async () => ({ ...searchState }) };
      }
      return { ok: true, status: 200, json: async () => ({ ...searchState }) };
    });
    return { fetchImpl, calls };
  };

  it('is a no-op while disable_required is not set', async () => {
    const { fetchImpl } = makeFetch({});
    expect(await enforceBudgetDisable({ fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('PUTs notificationEnabled:false, GET-verifies, then clears the flag', async () => {
    arm();
    const { fetchImpl, calls } = makeFetch({ '@id': '/searches/99', notificationEnabled: true });

    expect(await enforceBudgetDisable({ fetchImpl })).toBe(true);

    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(JSON.parse(calls[1].body).notificationEnabled).toBe(false);
    expect(getParisHunterMeta('disable_required')).toBe(null);
    expect(getParisHunterMeta('disable_confirmed')).toMatch(new RegExp(`^${usageKeyFor()}`));
  });

  it('keeps the flag when the PUT fails, and retries next tick', async () => {
    arm();
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if ((options.method ?? 'GET') === 'PUT') {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ notificationEnabled: true }) };
    });

    expect(await enforceBudgetDisable({ fetchImpl })).toBe(false);
    expect(getParisHunterMeta('disable_required')).toBe('1');
    expect(logged.error.some((line) => line.includes('disable attempt failed'))).toBe(true);
  });

  it('keeps the flag when the verify GET still reports enabled', async () => {
    arm();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ notificationEnabled: true }) }));
    expect(await enforceBudgetDisable({ fetchImpl })).toBe(false);
    expect(getParisHunterMeta('disable_required')).toBe('1');
  });

  it('honors the STREAM_ESTATE_API_BASE override (QA mock server)', async () => {
    arm();
    process.env.STREAM_ESTATE_API_BASE = 'http://127.0.0.1:9777';
    expect(streamEstateApiBase()).toBe('http://127.0.0.1:9777');

    const { fetchImpl, calls } = makeFetch({ notificationEnabled: true });
    await enforceBudgetDisable({ fetchImpl });
    expect(calls[0].url).toBe('http://127.0.0.1:9777/searches/99');
  });
});

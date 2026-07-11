/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMemorySqlite, mockSqliteConnection } from './memoryDb.js';

const holder = vi.hoisted(() => ({ current: null }));

vi.hoisted(() => {
  process.env.STREAM_ESTATE_WEBHOOK_SECRET = 'f'.repeat(48);
  process.env.STREAM_ESTATE_API_KEY = 'test-api-key';
  process.env.PUBLIC_BASE_URL = 'https://hunter.test';
});

vi.mock('../../../lib/services/storage/SqliteConnection.js', () => mockSqliteConnection(holder));
vi.mock('../../../lib/services/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runBootstrap, diffSearch } from '../../../tools/paris-hunter/bootstrap.js';
import { runSeed } from '../../../tools/paris-hunter/seed.js';
import { buildSearchBody, computeConfigRev, parseWatermark } from '../../../lib/services/paris-hunter/searchConfig.js';
import { getParisHunterMeta, insertInbox, setParisHunterMeta } from '../../../lib/services/paris-hunter/inbox.js';
import { enforceBudgetDisable, usageKeyFor } from '../../../lib/services/paris-hunter/budget.js';

/**
 * Fake City resolution for a zipcode (real shape, test values — the live API
 * returns real /cities/<id> IRIs; only the string `zipcode` matters to verify).
 */
const cityFor = (zip) => ({
  '@id': `/cities/test-${zip}`,
  '@type': 'City',
  zipcode: String(zip),
  insee: `751${String(zip).slice(-2)}`,
  name: `Paris ${Number(String(zip).slice(-2))}e`,
});

/**
 * Real Stream Estate READ contract (observed live 2026-07-11; the docs'
 * response examples agree — see fixtures/stream-estate-search-echo.json):
 * reads are NOT a faithful echo. `roomMax`/`bedroomMax`/`includedZipcodes` are
 * write-only and dropped; zipcodes come back resolved as `includedCities`
 * City objects. The fake stores WRITE shape and serializes every response.
 */
const serializeSearch = (stored) => {
  const { roomMax, bedroomMax, includedZipcodes, ...rest } = stored; // eslint-disable-line no-unused-vars
  const includedCities = includedZipcodes != null ? includedZipcodes.map(cityFor) : (rest.includedCities ?? []);
  return { ...rest, includedCities };
};

/**
 * Minimal stateful Stream Estate API fake. Records every call; supports
 * GET/POST /searches, GET/PUT /searches/{id}, GET /documents/properties and
 * the receiver health URL.
 *
 * /documents/properties mirrors the LIVE billing contract (incident
 * 2026-07-11): every item in every response bills, `responsePageSize` items
 * come back regardless of itemsPerPage, fromDate/toDate are inclusive on
 * createdAt, hydra:totalItems counts the whole filtered window.
 * `ignoreDateFilters` emulates the worst-case API that re-returns the same
 * items no matter the window (what the billing guard must catch).
 */
const makeApi = ({
  searches = [],
  healthStatus = 200,
  documents = [],
  responsePageSize = 58,
  ignoreDateFilters = false,
} = {}) => {
  const state = { searches: new Map(searches.map((s) => [s['@id'], s])), calls: [], nextId: 100 };
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  const fetchImpl = vi.fn(async (url, options = {}) => {
    const method = options.method ?? 'GET';
    state.calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
    const { pathname, searchParams } = new URL(url);

    if (url.startsWith('https://hunter.test/')) {
      return json({ ok: healthStatus === 200 }, healthStatus);
    }
    if (pathname === '/searches' && method === 'GET') {
      return json({ 'hydra:member': [...state.searches.values()].map(serializeSearch) });
    }
    if (pathname === '/searches' && method === 'POST') {
      const body = JSON.parse(options.body);
      const id = `/searches/${state.nextId++}`;
      const created = {
        ...body,
        '@id': id,
        token: `tok-${id.split('/').pop()}`,
        createdAt: '2026-07-09T10:00:00+02:00',
      };
      state.searches.set(id, created);
      return json(serializeSearch(created), 201);
    }
    if (pathname.startsWith('/searches/') && method === 'GET') {
      const found = state.searches.get(pathname);
      return found ? json(serializeSearch(found)) : json({}, 404);
    }
    if (pathname.startsWith('/searches/') && method === 'PUT') {
      const existing = state.searches.get(pathname) ?? {};
      const updated = { ...existing, ...JSON.parse(options.body), '@id': pathname, token: existing.token ?? 'tok-x' };
      state.searches.set(pathname, updated);
      return json(serializeSearch(updated));
    }
    if (pathname === '/documents/properties' && method === 'GET') {
      if (ignoreDateFilters) {
        return json({
          'hydra:member': documents.slice(0, responsePageSize),
          'hydra:totalItems': documents.length + responsePageSize, // always looks truncated
        });
      }
      const fromDate = searchParams.get('fromDate');
      const toDate = searchParams.get('toDate');
      const fromMs = fromDate != null ? Date.parse(fromDate) : -Infinity;
      const toMs = toDate != null ? Date.parse(toDate) : Infinity;
      const window = documents
        .filter((d) => Date.parse(d.createdAt) >= fromMs && Date.parse(d.createdAt) <= toMs)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      return json({ 'hydra:member': window.slice(0, responsePageSize), 'hydra:totalItems': window.length });
    }
    return json({ error: `unrouted ${method} ${url}` }, 500);
  });
  return { state, fetchImpl };
};

const identity = () => buildSearchBody();
const ownedSearch = (id, extra = {}) => ({
  ...identity(),
  '@id': id,
  token: `tok-${id.split('/').pop()}`,
  createdAt: '2026-07-01T09:00:00+02:00',
  notificationEnabled: false,
  ...extra,
});

const upsertJobSpy = vi.fn();
const deps = { upsertJob: upsertJobSpy, adminUserId: 'admin-1' };

beforeEach(() => {
  holder.current = createMemorySqlite();
  upsertJobSpy.mockClear();
  process.env.PH_MONTHLY_ITEM_BUDGET = '900';
  delete process.env.PH_BUDGET_HEADROOM;
});

describe('bootstrap — reconcile mode (v2 #6, v3 A5)', () => {
  it('creates the search DISABLED when none is owned, then persists meta after re-GET verify', async () => {
    const { state, fetchImpl } = makeApi();
    const summary = await runBootstrap({ fetchImpl, deps });

    const post = state.calls.find((c) => c.method === 'POST');
    expect(post.body.notificationEnabled).toBe(false);
    expect(post.body.title.startsWith('[ph:v1]')).toBe(true);

    expect(getParisHunterMeta('searchId')).toBe(summary.searchId);
    expect(getParisHunterMeta('searchToken')).toMatch(/^tok-/);
    expect(upsertJobSpy).toHaveBeenCalledOnce();
    expect(upsertJobSpy.mock.calls[0][0].jobId).toBe('paris-hunter');
    expect(upsertJobSpy.mock.calls[0][0].provider[0]).toEqual({
      id: 'streamEstate',
      url: 'inbox://stream-estate',
      enabled: true,
    });
    // `name` must be persisted: the admin UI job editor renders the stored
    // adapter name, not a registry lookup — without it the row is blank.
    expect(upsertJobSpy.mock.calls[0][0].notificationAdapter).toEqual([
      { id: 'convos', name: 'Convos (XMTP)', fields: {} },
    ]);
  });

  it('forces notificationEnabled:false on ALL owned searches — canonical AND duplicates (v3 A5)', async () => {
    const { state, fetchImpl } = makeApi({
      searches: [
        ownedSearch('/searches/1', { createdAt: '2026-06-01T09:00:00+02:00', notificationEnabled: true }),
        ownedSearch('/searches/2', { createdAt: '2026-07-01T09:00:00+02:00', notificationEnabled: true }),
      ],
    });

    const summary = await runBootstrap({ fetchImpl, deps });

    const puts = state.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts.every((c) => c.body.notificationEnabled === false)).toBe(true);
    // oldest createdAt wins as canonical
    expect(summary.searchId).toBe('/searches/1');
    expect(summary.actions.some((a) => a.action === 'disabled-duplicate' && a.searchId === '/searches/2')).toBe(true);
    expect(getParisHunterMeta('searchId')).toBe('/searches/1');
  });

  it('--keep overrides canonical selection', async () => {
    const { fetchImpl } = makeApi({
      searches: [
        ownedSearch('/searches/1', { createdAt: '2026-06-01T09:00:00+02:00' }),
        ownedSearch('/searches/2', { createdAt: '2026-07-01T09:00:00+02:00' }),
      ],
    });
    const summary = await runBootstrap({ argv: ['--keep', '/searches/2'], fetchImpl, deps });
    expect(summary.searchId).toBe('/searches/2');
  });

  it('--dry-run performs no mutations and persists nothing', async () => {
    const { state, fetchImpl } = makeApi();
    const summary = await runBootstrap({ argv: ['--dry-run'], fetchImpl, deps });

    expect(state.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(summary.actions[0].action).toBe('would-create');
    expect(getParisHunterMeta('searchId')).toBe(null);
    expect(upsertJobSpy).not.toHaveBeenCalled();
  });

  it('fails fast when required env is missing', async () => {
    const { fetchImpl } = makeApi();
    const env = { ...process.env, STREAM_ESTATE_API_KEY: '' };
    await expect(runBootstrap({ fetchImpl, env, deps })).rejects.toThrow(/STREAM_ESTATE_API_KEY/);
  });
});

describe('diffSearch — LIVE API read contract (fixture = real GET echo, 2026-07-11)', () => {
  // Real prod echo of our search (only the webhook secret path segment and the
  // search token are replaced by same-shape placeholders). Quirks it encodes:
  // no `roomMax`/`includedZipcodes` keys; zipcodes resolved to `includedCities`.
  const realEcho = JSON.parse(
    readFileSync(new URL('./fixtures/stream-estate-search-echo.json', import.meta.url), 'utf8'),
  );
  const fixtureEnv = {
    ...process.env,
    PUBLIC_BASE_URL: 'https://fredy.example.com',
    STREAM_ESTATE_WEBHOOK_SECRET: 'c0ffee'.repeat(8),
  };
  const fixtureBody = () => buildSearchBody({ env: fixtureEnv });

  it('converges on the real echo (the exact divergence that broke prod bootstrap)', () => {
    expect(diffSearch(realEcho, fixtureBody())).toEqual([]);
  });

  it('still catches a genuinely wrong zipcode set behind includedCities', () => {
    const missingOne = { ...realEcho, includedCities: realEcho.includedCities.slice(1) };
    expect(diffSearch(missingOne, fixtureBody())).toEqual(['includedZipcodes']);
    const swapped = {
      ...realEcho,
      includedCities: [...realEcho.includedCities.slice(1), { ...realEcho.includedCities[0], zipcode: '75016' }],
    };
    expect(diffSearch(swapped, fixtureBody())).toEqual(['includedZipcodes']);
    const noCities = { ...realEcho };
    delete noCities.includedCities;
    expect(diffSearch(noCities, fixtureBody())).toEqual(['includedZipcodes']);
  });

  it('still catches wrong scalar values on the real echo shape', () => {
    expect(diffSearch({ ...realEcho, budgetMax: 9999 }, fixtureBody())).toEqual(['budgetMax']);
    expect(diffSearch({ ...realEcho, roomMin: 1 }, fixtureBody())).toEqual(['roomMin']);
    expect(diffSearch({ ...realEcho, furnished: null }, fixtureBody())).toEqual(['furnished']);
  });

  it('roomMax is skipped ONLY when absent (write-only read contract); an echoed value stays strict', () => {
    expect('roomMax' in realEcho).toBe(false); // the live echo really omits the key
    expect(diffSearch({ ...realEcho, roomMax: 4 }, fixtureBody())).toEqual([]);
    expect(diffSearch({ ...realEcho, roomMax: 5 }, fixtureBody())).toEqual(['roomMax']);
  });

  it('reconcile ADOPTS the orphaned owned search in place — no duplicate POST (live incident 2026-07-11)', async () => {
    const { state, fetchImpl } = makeApi({ searches: [realEcho] });
    const summary = await runBootstrap({ fetchImpl, deps, env: fixtureEnv });

    expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    const put = state.calls.find((c) => c.method === 'PUT');
    expect(put.url).toContain(realEcho['@id']);
    expect(put.body.notificationEnabled).toBe(false);
    expect(summary.searchId).toBe(realEcho['@id']);
    expect(getParisHunterMeta('searchId')).toBe(realEcho['@id']);
    expect(getParisHunterMeta('searchToken')).toBe(realEcho.token);
  });
});

describe('bootstrap — --enable-notifications (v3 A5 sequence)', () => {
  const FIXED_NOW = Date.UTC(2026, 6, 9, 12, 0, 0);

  const armEnable = ({ healthStatus = 200, remoteMutation } = {}) => {
    const canonical = ownedSearch('/searches/1');
    if (remoteMutation) {
      remoteMutation(canonical);
    }
    const api = makeApi({ searches: [canonical], healthStatus });
    setParisHunterMeta('searchId', '/searches/1');
    setParisHunterMeta('seededAt', String(FIXED_NOW - 60_000));
    return api;
  };

  it('refuses when the receiver health endpoint is unreachable (enabled-before-receiver closed)', async () => {
    const { state, fetchImpl } = armEnable({ healthStatus: 503 });
    await expect(runBootstrap({ argv: ['--enable-notifications'], fetchImpl, deps })).rejects.toThrow(/health check/);
    expect(getParisHunterMeta('notifyWatermark')).toBe(null);
    expect(state.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('refuses when seededAt is missing', async () => {
    const { fetchImpl } = makeApi({ searches: [ownedSearch('/searches/1')] });
    setParisHunterMeta('searchId', '/searches/1');
    await expect(runBootstrap({ argv: ['--enable-notifications'], fetchImpl, deps })).rejects.toThrow(/seededAt/);
  });

  it('refuses when the remote search no longer matches the current configRev', async () => {
    const { fetchImpl } = armEnable({ remoteMutation: (s) => (s.budgetMax = 9999) });
    await expect(runBootstrap({ argv: ['--enable-notifications'], fetchImpl, deps })).rejects.toThrow(
      /no longer matches/,
    );
    expect(getParisHunterMeta('notifyWatermark')).toBe(null);
  });

  it('mints the cutoff NOW, bound to searchId + configRev, then enables and verifies', async () => {
    const { state, fetchImpl } = armEnable();
    setParisHunterMeta('disable_confirmed', 'old-budget-confirmation');
    const summary = await runBootstrap({
      argv: ['--enable-notifications'],
      fetchImpl,
      deps: { ...deps, now: () => FIXED_NOW },
    });

    const watermark = parseWatermark(getParisHunterMeta('notifyWatermark'));
    expect(watermark).toEqual({
      cutoffMs: FIXED_NOW,
      searchId: '/searches/1',
      configRev: computeConfigRev(buildSearchBody()),
    });

    const put = state.calls.find((c) => c.method === 'PUT');
    expect(put.body.notificationEnabled).toBe(true);
    expect(getParisHunterMeta('disable_confirmed')).toBe(null);
    expect(summary.actions.map((a) => a.action)).toContain('enabled');
    // watermark write precedes the PUT (ordering: step 3 before step 4)
    expect(summary.actions.findIndex((a) => a.action === 'watermark-written')).toBeLessThan(
      summary.actions.findIndex((a) => a.action === 'enabled'),
    );
  });

  it('diffSearch treats array order as irrelevant but values as strict', () => {
    const body = identity();
    expect(diffSearch({ ...body, includedZipcodes: [...body.includedZipcodes].reverse() }, body)).toEqual([]);
    expect(diffSearch({ ...body, budgetMax: body.budgetMax + 1 }, body)).toEqual(['budgetMax']);
  });

  it('refuses enable when current usage is already at the raised effective threshold', async () => {
    const { state, fetchImpl } = armEnable();
    const env = { ...process.env, PH_MONTHLY_ITEM_BUDGET: '10', PH_BUDGET_HEADROOM: '0.9' };
    setParisHunterMeta(usageKeyFor(FIXED_NOW), '9');

    await expect(
      runBootstrap({ argv: ['--enable-notifications'], fetchImpl, env, deps: { ...deps, now: () => FIXED_NOW } }),
    ).rejects.toThrow(/current usage 9.*threshold 9/);
    expect(state.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(getParisHunterMeta('disable_confirmed')).toBe(null);
  });

  it('trip → raise → verified enable → trip again in the same month', async () => {
    process.env.PH_MONTHLY_ITEM_BUDGET = '3';
    const { fetchImpl } = armEnable();
    const insert = (id) =>
      insertInbox({ kind: 'match', externalId: `budget-${id}`, payload: '{}', eventAt: FIXED_NOW });

    insert(1);
    insert(2);
    insert(3);
    expect(getParisHunterMeta('disable_required')).toBe('1');
    await expect(enforceBudgetDisable({ fetchImpl, nowMs: FIXED_NOW })).resolves.toBe(true);
    expect(getParisHunterMeta('disable_required')).toBe(null);
    expect(getParisHunterMeta('disable_confirmed')).not.toBe(null);

    process.env.PH_MONTHLY_ITEM_BUDGET = '5';
    await runBootstrap({
      argv: ['--enable-notifications'],
      fetchImpl,
      deps: { ...deps, now: () => FIXED_NOW },
    });
    expect(getParisHunterMeta('disable_confirmed')).toBe(null);

    insert(4);
    expect(getParisHunterMeta('disable_required')).toBe(null);
    insert(5);
    expect(getParisHunterMeta('disable_required')).toBe('1');
  });
});

describe('seed (v2 lane 2, v3 A5 — seededAt only, no watermark)', () => {
  const seedDocs = [
    { uuid: 'aaaaaaaa-0000-4000-8000-000000000001', createdAt: '2026-07-01T10:00:00+02:00' },
    { uuid: 'aaaaaaaa-0000-4000-8000-000000000002', createdAt: '2026-07-02T10:00:00+02:00' },
  ];

  const docAt = (i, createdAt) => ({ uuid: `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`, createdAt });

  const armSeed = (extra = {}) => {
    setParisHunterMeta('searchId', '/searches/1');
    return makeApi({
      searches: [ownedSearch('/searches/1', extra.searchState)],
      documents: extra.documents ?? seedDocs,
      responsePageSize: extra.responsePageSize ?? 58,
      ignoreDateFilters: extra.ignoreDateFilters ?? false,
    });
  };

  let logSpy;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });
  const logged = () => logSpy.mock.calls.map((c) => c.join(' '));

  it('refuses while the search is not verifiably DISABLED', async () => {
    const { fetchImpl } = armSeed({ searchState: { notificationEnabled: true } });
    await expect(runSeed({ argv: ['--no-poll'], fetchImpl })).rejects.toThrow(/notificationEnabled:false/);
    expect(getParisHunterMeta('seededAt')).toBe(null);
  });

  it('--no-poll sets seededAt without touching /documents (zero cost) and mints NO watermark', async () => {
    const { state, fetchImpl } = armSeed();
    const summary = await runSeed({ argv: ['--no-poll'], fetchImpl });

    expect(summary.seededAt).toBe(true);
    expect(getParisHunterMeta('seededAt')).toMatch(/^\d+$/);
    expect(getParisHunterMeta('notifyWatermark')).toBe(null);
    expect(state.calls.some((c) => c.url.includes('/documents/'))).toBe(false);
  });

  it('polling REFUSES without --confirm-live (billable path is gated)', async () => {
    const { fetchImpl } = armSeed();
    await expect(runSeed({ fetchImpl })).rejects.toThrow(/--confirm-live/);
  });

  it('polls with --confirm-live and marks every returned uuid as seen', async () => {
    const { state, fetchImpl } = armSeed();
    const summary = await runSeed({ argv: ['--confirm-live'], fetchImpl });

    expect(summary.seeded).toBe(2);
    const seen = holder.current.query('SELECT dedup_key FROM ph_seen ORDER BY dedup_key').map((r) => r.dedup_key);
    expect(seen).toEqual(seedDocs.map((d) => `se:${d.uuid}`));
    expect(getParisHunterMeta('seededAt')).toMatch(/^\d+$/);
    const pollCall = state.calls.find((c) => c.url.includes('/documents/properties'));
    expect(pollCall.url).toContain('furnished=false');
    expect(pollCall.url).toContain('itemsPerPage=30');
  });

  it('refuses to re-run once seeded, unless --force', async () => {
    setParisHunterMeta('seededAt', '123');
    const { fetchImpl } = armSeed();
    await expect(runSeed({ argv: ['--no-poll'], fetchImpl })).rejects.toThrow(/--force/);
    await expect(runSeed({ argv: ['--no-poll', '--force'], fetchImpl })).resolves.toBeTruthy();
  });

  describe('billable pagination — date-window walk, NEVER page=N (live incident 2026-07-11)', () => {
    const T = (h) => `2026-06-01T${String(h).padStart(2, '0')}:00:00.000Z`;

    it('walks fromDate windows to completion; boundary timestamp group is re-fetched ONCE, whole windows never', async () => {
      // a(t1), b(t2), c(t2), d(t3), page size 3: window 2 restarts AT t2
      // (boundary group b,c re-billed once, deduped locally), then totalItems
      // says exhausted.
      const docs = [docAt(1, T(1)), docAt(2, T(2)), docAt(3, T(2)), docAt(4, T(3))];
      const { state, fetchImpl } = armSeed({ documents: docs, responsePageSize: 3 });
      const summary = await runSeed({ argv: ['--confirm-live'], fetchImpl });

      const polls = state.calls.filter((c) => c.url.includes('/documents/properties'));
      expect(polls).toHaveLength(2);
      for (const call of polls) {
        expect(call.url).not.toContain('page=');
        expect(call.url).toContain(encodeURIComponent('order[createdAt]') + '=asc');
        expect(call.url).toContain('toDate=');
      }
      expect(polls[0].url).not.toContain('fromDate=');
      expect(polls[1].url).toContain(`fromDate=${encodeURIComponent(T(2))}`);

      expect(summary.seeded).toBe(4); // every unique marked exactly once
      expect(summary.itemsReturned).toBe(6); // 3 + 3 (b,c re-billed at the boundary)
      expect(summary.pages).toBe(2);
      expect(holder.current.query('SELECT COUNT(1) AS c FROM ph_seen')[0].c).toBe(4);
      expect(getParisHunterMeta('seededAt')).toMatch(/^\d+$/);
    });

    it('multi-window walk marks every unique exactly once and advances strictly', async () => {
      const docs = [1, 2, 3, 4, 5].map((i) => docAt(i, T(i)));
      const { state, fetchImpl } = armSeed({ documents: docs, responsePageSize: 2 });
      const summary = await runSeed({ argv: ['--confirm-live'], fetchImpl });

      expect(summary.seeded).toBe(5);
      expect(summary.pages).toBe(4); // [1,2] [2,3] [3,4] [4,5] — 1-item boundary overlap each
      expect(summary.itemsReturned).toBe(8);
      const fromDates = state.calls
        .filter((c) => c.url.includes('/documents/properties'))
        .map((c) => new URL(c.url).searchParams.get('fromDate'));
      expect(fromDates).toEqual([null, T(2), T(3), T(4)]); // strictly increasing, no window repeated
    });

    it('handles a full response sharing ONE timestamp: steps 1s past it with a warning instead of re-pulling forever', async () => {
      const docs = [docAt(1, T(1)), docAt(2, T(1)), docAt(3, T(1)), docAt(4, T(1))];
      const { fetchImpl } = armSeed({ documents: docs, responsePageSize: 2 });
      const summary = await runSeed({ argv: ['--confirm-live'], fetchImpl });

      expect(summary.pages).toBe(1); // second window (t1+1s) is empty — terminated
      expect(summary.seeded).toBe(2); // the 2 same-second overflow docs are unreachable, by design
      expect(logged().some((l) => l.includes('WARNING') && l.includes('shares createdAt'))).toBe(true);
      expect(getParisHunterMeta('seededAt')).toMatch(/^\d+$/);
    });

    it('BILLING GUARD aborts (without seededAt) when the API re-returns items past max(3x uniques, PH_SEED_MAX_ITEMS)', async () => {
      const docs = [1, 2, 3, 4, 5, 6].map((i) => docAt(i, T(i)));
      const { fetchImpl } = armSeed({ documents: docs, responsePageSize: 6, ignoreDateFilters: true });
      const env = { ...process.env, PH_SEED_MAX_ITEMS: '10' };

      await expect(runSeed({ argv: ['--confirm-live'], fetchImpl, env })).rejects.toThrow(/BILLING GUARD/);
      // threshold = max(3×6, 10) = 18 → tripped at 24 billed items (4th window)
      expect(getParisHunterMeta('seededAt')).toBe(null);
    });
  });

  describe('progress output (silent-run fix, live incident 2026-07-11)', () => {
    const T = (h) => `2026-06-01T${String(h).padStart(2, '0')}:00:00.000Z`;

    it('prints a start line BEFORE any network call, then per-page progress, then a completion line', async () => {
      const docs = [1, 2, 3].map((i) => docAt(i, T(i)));
      const { fetchImpl } = armSeed({ documents: docs, responsePageSize: 2 });
      let logsAtFirstFetch = null;
      const observingFetch = (...a) => {
        logsAtFirstFetch ??= logged();
        return fetchImpl(...a);
      };
      await runSeed({ argv: ['--confirm-live'], fetchImpl: observingFetch });

      // start line was already out when the FIRST request left
      expect(logsAtFirstFetch.some((l) => /^paris-hunter seed: starting — mode=poll/.test(l))).toBe(true);
      expect(logsAtFirstFetch[0]).toMatch(/base=.+zips=.+budget=.+rooms=.+itemGuard=/);

      const lines = logged();
      expect(
        lines.some((l) =>
          /page 1 — 2 items returned, 2 new listings marked seen — running total: 2 unique, 2 items billed ≈ €0\.02/.test(
            l,
          ),
        ),
      ).toBe(true);
      expect(lines.some((l) => /page 2 — .+ running total: 3 unique, 4 items billed ≈ €0\.04/.test(l))).toBe(true);
      expect(
        lines.some((l) =>
          /done — 3 new seen key\(s\) across 2 window\(s\), 4 items billed ≈ €0\.04.*seededAt written/.test(l),
        ),
      ).toBe(true);
    });

    it('--dry-run announces the window walk and the guard without touching /documents', async () => {
      const { state, fetchImpl } = armSeed();
      const summary = await runSeed({ argv: ['--dry-run'], fetchImpl });

      expect(summary.dryRun).toBe(true);
      expect(state.calls.some((c) => c.url.includes('/documents/'))).toBe(false);
      expect(logged().some((l) => l.includes('[dry-run] would walk date windows'))).toBe(true);
      expect(getParisHunterMeta('seededAt')).toBe(null);
    });
  });
});

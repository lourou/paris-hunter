/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { readFileSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemorySqlite, mockSqliteConnection } from '../services/paris-hunter/memoryDb.js';

const holder = vi.hoisted(() => ({ current: null }));

vi.mock('../../lib/services/storage/SqliteConnection.js', () => mockSqliteConnection(holder));
vi.mock('../../lib/services/storage/listingsStorage.js', () => ({
  getAllEntriesFromListings: () => [],
}));

import * as provider from '../../lib/provider/allowa.js';
import { checkAndAddEntry, initSimilarityCache } from '../../lib/services/similarity-check/similarityCache.js';

const fixture = JSON.parse(readFileSync(new URL('../testFixtures/allowa.json', import.meta.url), 'utf-8'));
const KEEPER_REF = 'crafted-keeper-75011';

/**
 * Finds a fixture record by its Allowa reference.
 *
 * @param {string} reference Allowa ReferenceAnnonce__c
 * @returns {object} matching fixture record
 */
const fixtureByRef = (reference) => fixture.result.find((raw) => raw.ReferenceAnnonce__c === reference);

/** @returns {object[]} current durable Convos rows */
const outboxRows = () => holder.current.query('SELECT * FROM convos_outbox ORDER BY id');

/** @returns {object[]} current Allowa seen-ledger rows */
const seenRows = () => holder.current.query('SELECT * FROM ph_seen ORDER BY dedup_key');

/**
 * Creates an offline-only Allowa fetch replacement.
 *
 * @returns {ReturnType<typeof vi.fn>} fetch mock
 */
const buildFetchStub = () =>
  vi.fn(async (input) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.allowa.com' || url.pathname !== '/v1/search/pa') {
      throw new Error(`Network request blocked in offline mode: ${url}`);
    }
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve(fixture),
    };
  });

beforeEach(() => {
  holder.current = createMemorySqlite();
  initSimilarityCache();
  provider.init({ id: 'allowa', enabled: true }, []);
  vi.stubGlobal('fetch', buildFetchStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
  holder.current.raw.close();
});

describe('Allowa provider offline poll', () => {
  it('exposes getListings, requests the fixed API search, and returns every raw fixture row', async () => {
    expect(typeof provider.config.getListings).toBe('function');

    const raws = await provider.config.getListings();

    expect(raws).toHaveLength(fixture.count);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, options] = fetch.mock.calls[0];
    const url = new URL(String(input));
    expect(url.searchParams.getAll('cities[]')).toEqual(['Paris']);
    expect(url.searchParams.get('category')).toBe('Location');
    expect(url.searchParams.getAll('numberOfRooms[]')).toEqual(['3', '4', '5']);
    expect(url.searchParams.getAll('nature[]')).toEqual(['Appartement']);
    expect(url.searchParams.get('minPrice')).toBe('1900');
    expect(url.searchParams.get('maxPrice')).toBe('3350');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(options.headers).toMatchObject({
      AllowaOrigin: 'Allowa-Plateforme-Annonce',
      Accept: 'application/json',
      Origin: 'https://recherche.allowa.com',
      Referer: 'https://recherche.allowa.com/',
    });
    expect(options.headers['User-Agent']).toContain('Chrome/');
  });

  it('normalizes the keeper into ParsedListing plus Paris Hunter fields', () => {
    const raw = fixtureByRef(KEEPER_REF);
    const listing = provider.config.normalize(raw);

    expect(listing.id).toBe(`allowa:${KEEPER_REF}`);
    expect(listing.link).toBe('https://recherche.allowa.com/logement/location-appartement-crafted-keeper-75011');
    expect(listing.price).toBe(2750);
    expect(listing.ph.priceHc).toBe(2500);
    expect(listing.ph.charges).toBe(250);
    expect(listing.rooms).toBe(3);
    expect(listing.ph.zipcode).toBe('75011');
    expect(listing.latitude).toBe(48.853);
    expect(listing.longitude).toBe(2.375);
    expect(listing.image).toBe(raw.LienImage1__c);
    expect(listing.ph.photoUrls[0]).toBe(raw.LienImage1__c);
  });

  it('keeps only the valid candidate and drops each isolated filter case', () => {
    expect(provider.config.filter(provider.config.normalize(fixtureByRef(KEEPER_REF)))).toBe(true);
    expect(provider.config.filter(provider.config.normalize(fixtureByRef('crafted-rooms-band')))).toBe(false);
    expect(provider.config.filter(provider.config.normalize(fixtureByRef('crafted-over-budget')))).toBe(false);
    expect(provider.config.filter(provider.config.normalize(fixtureByRef('crafted-furnished')))).toBe(false);
    expect(provider.config.filter(provider.config.normalize(fixtureByRef('crafted-zip-75017')))).toBe(false);
    expect(provider.config.filter(provider.config.normalize(fixtureByRef('102paris18112020')))).toBe(false);
    expect(provider.config.filter(provider.config.normalize(fixtureByRef('ref-012333paris21220')))).toBe(false);
  });

  it('atomically records the keeper in ph_seen and convos_outbox only', async () => {
    await provider.config.getListings();

    const outbox = outboxRows();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      id: `allowa:${KEEPER_REF}`,
      dedup_key: `allowa:${KEEPER_REF}`,
      kind: 'match',
    });
    expect(outbox[0].text).toContain('Appartement familial 3 pièces');
    expect(outbox[0].image_url).toBe(fixtureByRef(KEEPER_REF).LienImage1__c);
    expect(seenRows()).toEqual([expect.objectContaining({ dedup_key: `allowa:${KEEPER_REF}` })]);

    const excludedKeys = [
      'crafted-zip-75017',
      'crafted-over-budget',
      'crafted-furnished',
      '102paris18112020',
      'ref-012333paris21220',
    ].map((reference) => `allowa:${reference}`);
    expect(outbox.map((row) => row.dedup_key)).not.toEqual(expect.arrayContaining(excludedKeys));
  });

  it('suppresses an exact cross-source cache match while still marking it seen', async () => {
    const keeper = provider.config.normalize(fixtureByRef(KEEPER_REF));
    expect(checkAndAddEntry({ title: keeper.title, address: keeper.address, price: keeper.price })).toBe(false);

    await provider.config.getListings();

    expect(outboxRows()).toHaveLength(0);
    expect(seenRows()).toEqual([expect.objectContaining({ dedup_key: `allowa:${KEEPER_REF}` })]);
  });

  it('does not create a second outbox row when ph_seen already contains the keeper', async () => {
    const first = await provider.config.getListings();
    const second = await provider.config.getListings();

    expect(first).toHaveLength(fixture.count);
    expect(second).toHaveLength(fixture.count);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(outboxRows()).toHaveLength(1);
    expect(seenRows()).toHaveLength(1);
  });
});

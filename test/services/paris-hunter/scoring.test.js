/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCapForZip } from '../../../lib/services/paris-hunter/capTable.js';
import { scoreListing } from '../../../lib/services/paris-hunter/scoring.js';

describe('paris-hunter cap table', () => {
  it.each([
    ['75011', 34],
    ['75012', 32],
    ['75010', 33],
    ['75020', 30],
    ['75003', 38],
    ['75004', 39],
    ['75009', 34],
  ])('returns the unfurnished cap for %s', (zipcode, cap) => {
    expect(getCapForZip(zipcode)).toBe(cap);
  });

  it('accepts numeric zipcodes and returns null for unknown or missing ones', () => {
    expect(getCapForZip(75011)).toBe(34);
    expect(getCapForZip('75015')).toBeNull();
    expect(getCapForZip(null)).toBeNull();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses a valid PH_CAP_TABLE_JSON override before the default table', async () => {
    vi.stubEnv('PH_CAP_TABLE_JSON', '{"75011":41,"75015":"29.5"}');
    vi.resetModules();
    const { getCapForZip: getOverriddenCap } = await import('../../../lib/services/paris-hunter/capTable.js');

    expect(getOverriddenCap('75011')).toBe(41);
    expect(getOverriddenCap('75015')).toBe(29.5);
    expect(getOverriddenCap('75012')).toBe(32);
  });
});

describe('paris-hunter scoring', () => {
  it('calculates the brief example without rounding the stored score', () => {
    const score = scoreListing({ priceHc: 2850, surface: 72, zipcode: '75011' });

    expect(score.pricePerM2).toBeCloseTo(39.583333, 6);
    expect(score.capRatio).toBeCloseTo(1.164216, 6);
    expect(score.flags).toEqual(['OVER_CAP']);
  });

  it('flags a listing only above 105% of the cap', () => {
    expect(scoreListing({ priceHc: 3570, surface: 100, zipcode: '75011' }).flags).toEqual([]);
    expect(scoreListing({ priceHc: 3570.01, surface: 100, zipcode: '75011' }).flags).toEqual(['OVER_CAP']);
  });

  it('flags a listing only below 85% of the cap', () => {
    expect(scoreListing({ priceHc: 2890, surface: 100, zipcode: '75011' }).flags).toEqual([]);
    expect(scoreListing({ priceHc: 2889.99, surface: 100, zipcode: '75011' }).flags).toEqual(['GOOD_DEAL']);
  });

  it.each([null, 0, -1])('flags an invalid surface (%s) as NO_SURFACE', (surface) => {
    expect(scoreListing({ priceHc: 2850, surface, zipcode: '75011' })).toEqual({
      pricePerM2: null,
      capRatio: null,
      flags: ['NO_SURFACE'],
    });
  });

  it('does not turn a missing price into a zero-price good deal', () => {
    expect(scoreListing({ priceHc: null, surface: 72, zipcode: '75011' })).toEqual({
      pricePerM2: null,
      capRatio: null,
      flags: [],
    });
  });

  it('keeps the price-per-m2 score when no cap is known', () => {
    expect(scoreListing({ priceHc: 3000, surface: 75, zipcode: '75015' })).toEqual({
      pricePerM2: 40,
      capRatio: null,
      flags: [],
    });
  });
});

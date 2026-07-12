/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * paris-hunter: the Nominatim country filter diverges from upstream —
 * `&countrycodes=de` was hardcoded; it is now the optional GEOCODER_COUNTRY
 * env (unset = worldwide, so French addresses resolve on fallback).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('node-fetch', () => ({ default: fetchMock }));

const loadClient = async () => await import('../../../lib/services/geocoding/client/nominatimClient.js');

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('nominatimClient country filter (GEOCODER_COUNTRY)', () => {
  it('unset → no countrycodes param (worldwide, French fallback works)', async () => {
    vi.stubEnv('GEOCODER_COUNTRY', '');
    fetchMock.mockResolvedValue(okResponse([{ lat: '48.85', lon: '2.38' }]));
    const { geocode } = await loadClient();

    const coords = await geocode('rue de la Roquette 75011 Paris');

    expect(coords).toEqual({ lat: 48.85, lng: 2.38 });
    expect(fetchMock.mock.calls[0][0]).not.toContain('countrycodes');
  });

  it('GEOCODER_COUNTRY=de → &countrycodes=de (upstream behavior, opt-in)', async () => {
    vi.stubEnv('GEOCODER_COUNTRY', 'de');
    fetchMock.mockResolvedValue(okResponse([]));
    const { geocode } = await loadClient();

    const coords = await geocode('Alexanderplatz 1 Berlin');

    expect(coords).toEqual({ lat: -1, lng: -1 });
    expect(fetchMock.mock.calls[0][0]).toContain('&countrycodes=de');
  });
});

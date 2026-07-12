/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * paris-hunter: unit tests for the BAN (Base Adresse Nationale) geocoding
 * client — mocked HTTP, offline-safe. The optional live check lives in
 * banClient.live.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('node-fetch', () => ({ default: fetchMock }));

/** Fresh module per test: resets the 429 pause + throttle state. */
const loadClient = async () => await import('../../../lib/services/geocoding/client/banClient.js');

const banBody = ({ lon, lat, score, type = 'street' }) => ({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { score, type, label: 'stub' },
    },
  ],
});

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
});

describe('banClient geocode', () => {
  it('resolves a full address — GeoJSON [lon, lat] mapped to {lat, lng} + precision type', async () => {
    fetchMock.mockResolvedValue(
      okResponse(banBody({ lon: 2.375021, lat: 48.857136, score: 0.97, type: 'housenumber' })),
    );
    const { geocode } = await loadClient();

    const coords = await geocode('12 rue de la Roquette 75011 Paris');

    expect(coords).toEqual({ lat: 48.857136, lng: 2.375021, type: 'housenumber' });
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('https://api-adresse.data.gouv.fr/search/?q=');
    expect(url).toContain(encodeURIComponent('12 rue de la Roquette 75011 Paris'));
    expect(url).toContain('&limit=1');
    expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toContain('Fredy');
  });

  it("street+postcode-only query ('rue de Charonne 75011') adds &postcode=", async () => {
    fetchMock.mockResolvedValue(okResponse(banBody({ lon: 2.3804, lat: 48.8546, score: 0.9 })));
    const { geocode } = await loadClient();

    const coords = await geocode('rue de Charonne 75011');

    expect(coords).toEqual({ lat: 48.8546, lng: 2.3804, type: 'street' });
    expect(fetchMock.mock.calls[0][0]).toContain('&postcode=75011');
  });

  it("number-less street query with { type: 'street' } → &type=street constrained request", async () => {
    fetchMock.mockResolvedValue(okResponse(banBody({ lon: 2.3804, lat: 48.8546, score: 0.9 })));
    const { geocode } = await loadClient();

    const coords = await geocode('rue de Charonne 75011', { type: 'street' });

    expect(coords.type).toBe('street');
    expect(fetchMock.mock.calls[0][0]).toContain('&type=street');
  });

  it('no options.type → no &type constraint in the request', async () => {
    fetchMock.mockResolvedValue(okResponse(banBody({ lon: 2.38, lat: 48.85, score: 0.9 })));
    const { geocode } = await loadClient();

    await geocode('12 rue de la Roquette 75011');

    expect(fetchMock.mock.calls[0][0]).not.toContain('&type=');
  });

  it('query without a 5-digit postcode omits the postcode filter', async () => {
    fetchMock.mockResolvedValue(okResponse(banBody({ lon: 2.38, lat: 48.85, score: 0.9 })));
    const { geocode } = await loadClient();

    await geocode('rue de Charonne Paris');

    expect(fetchMock.mock.calls[0][0]).not.toContain('postcode=');
  });

  it('ambiguous low-score match (< 0.4) → null (caller falls back)', async () => {
    fetchMock.mockResolvedValue(okResponse(banBody({ lon: 2.38, lat: 48.85, score: 0.31 })));
    const { geocode } = await loadClient();

    expect(await geocode('rue 75011')).toBeNull();
  });

  it('non-French query → empty features → null (Nominatim fallback covers it)', async () => {
    fetchMock.mockResolvedValue(okResponse({ type: 'FeatureCollection', features: [] }));
    const { geocode } = await loadClient();

    expect(await geocode('Alexanderplatz 1, 10178 Berlin')).toBeNull();
  });

  it('malformed body / missing geometry → null, no crash', async () => {
    fetchMock.mockResolvedValue(okResponse({ features: [{ properties: { score: 0.9 } }] }));
    const { geocode } = await loadClient();

    expect(await geocode('rue de la Roquette 75011')).toBeNull();
  });

  it('HTTP 429 → pauses for an hour and stops hitting the API', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({}) });
    const { geocode, isPaused } = await loadClient();

    expect(isPaused()).toBe(false);
    expect(await geocode('rue de la Roquette 75011 Paris')).toBeNull();
    expect(isPaused()).toBe(true);

    expect(await geocode('rue de la Roquette 75011 Paris')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('network error → null (never throws)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const { geocode, isPaused } = await loadClient();

    expect(await geocode('rue de la Roquette 75011 Paris')).toBeNull();
    expect(isPaused()).toBe(false);
  });
});

describe('extractStreet — French street extraction from listing text', () => {
  const extract = async (text) => (await loadClient()).extractStreet(text);

  it("'Bel appartement rue de Charonne' → 'rue de Charonne'", async () => {
    expect(await extract('Bel appartement rue de Charonne')).toBe('rue de Charonne');
  });

  it("'proche Bd Voltaire' → 'Bd Voltaire' (abbreviated token)", async () => {
    expect(await extract('Charmant 3 pièces proche Bd Voltaire, refait à neuf')).toBe('Bd Voltaire');
  });

  it("house number is kept: 'situé 12 rue de la Roquette rénové' → '12 rue de la Roquette'", async () => {
    expect(await extract('situé 12 rue de la Roquette rénové')).toBe('12 rue de la Roquette');
  });

  it('stops at a comma boundary', async () => {
    expect(await extract('avenue de la République, au calme')).toBe('avenue de la République');
  });

  it('stops at a digit boundary (postcode never swallowed)', async () => {
    expect(await extract('rue du Faubourg Saint-Antoine 75011 Paris')).toBe('rue du Faubourg Saint-Antoine');
  });

  it('stops at lowercase non-particle words (no greedy tail)', async () => {
    expect(await extract('Superbe séjour rue de Charonne au coeur du 11e')).toBe('rue de Charonne');
  });

  it('no street in text → null', async () => {
    expect(await extract('Appartement 3 pièces lumineux au coeur du 11e, proche métro')).toBeNull();
  });

  it("'place de parking en sous-sol' → null (no proper noun after the token)", async () => {
    expect(await extract('Avec place de parking en sous-sol')).toBeNull();
  });

  it("'Avenue ensoleillée' → null (adjective, not a street name)", async () => {
    expect(await extract('Avenue ensoleillée et calme')).toBeNull();
  });

  it('skips a false-positive token and finds a later real street', async () => {
    expect(await extract('place de parking, proche rue Oberkampf')).toBe('rue Oberkampf');
  });

  it('empty / non-string input → null', async () => {
    expect(await extract('')).toBeNull();
    expect(await extract(null)).toBeNull();
  });
});

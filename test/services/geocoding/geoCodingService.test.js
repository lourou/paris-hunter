/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * paris-hunter: routing tests for geoCodingService — DB cache first, then BAN
 * (French addresses), then Nominatim fallback (non-French / BAN outage).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ban = vi.hoisted(() => ({ geocode: vi.fn(), isPaused: vi.fn(() => false) }));
const nominatim = vi.hoisted(() => ({ geocode: vi.fn(), isPaused: vi.fn(() => false), autocomplete: vi.fn() }));
const cache = vi.hoisted(() => ({ getGeocoordinatesByAddress: vi.fn(() => null) }));

vi.mock('../../../lib/services/geocoding/client/banClient.js', () => ban);
vi.mock('../../../lib/services/geocoding/client/nominatimClient.js', () => nominatim);
vi.mock('../../../lib/services/storage/listingsStorage.js', () => cache);

import { geocodeAddress, geocodeListing, isGeocodingPaused } from '../../../lib/services/geocoding/geoCodingService.js';

beforeEach(() => {
  ban.geocode.mockReset();
  ban.isPaused.mockReset().mockReturnValue(false);
  nominatim.geocode.mockReset();
  nominatim.isPaused.mockReset().mockReturnValue(false);
  cache.getGeocoordinatesByAddress.mockReset().mockReturnValue(null);
});

describe('geocodeAddress routing', () => {
  it('DB cache hit short-circuits — no geocoder is called', async () => {
    cache.getGeocoordinatesByAddress.mockReturnValue({ lat: 48.85, lng: 2.38 });

    expect(await geocodeAddress('rue Sedaine 75011 Paris')).toEqual({ lat: 48.85, lng: 2.38 });
    expect(ban.geocode).not.toHaveBeenCalled();
    expect(nominatim.geocode).not.toHaveBeenCalled();
  });

  it('French address: BAN hit → returned, Nominatim never called', async () => {
    ban.geocode.mockResolvedValue({ lat: 48.857136, lng: 2.375021 });

    expect(await geocodeAddress('rue Sedaine 75011 Paris')).toEqual({ lat: 48.857136, lng: 2.375021 });
    expect(nominatim.geocode).not.toHaveBeenCalled();
  });

  it('non-French address: BAN misses (null) → Nominatim fallback answers', async () => {
    ban.geocode.mockResolvedValue(null);
    nominatim.geocode.mockResolvedValue({ lat: 52.5219, lng: 13.4132 });

    expect(await geocodeAddress('Alexanderplatz 1, 10178 Berlin')).toEqual({ lat: 52.5219, lng: 13.4132 });
    expect(ban.geocode).toHaveBeenCalledWith('Alexanderplatz 1, 10178 Berlin');
    expect(nominatim.geocode).toHaveBeenCalledWith('Alexanderplatz 1, 10178 Berlin');
  });

  it("both miss: Nominatim's not-found sentinel {-1, -1} passes through", async () => {
    ban.geocode.mockResolvedValue(null);
    nominatim.geocode.mockResolvedValue({ lat: -1, lng: -1 });

    expect(await geocodeAddress('nowhere at all')).toEqual({ lat: -1, lng: -1 });
  });

  it('empty address → null without any lookup', async () => {
    expect(await geocodeAddress('')).toBeNull();
    expect(ban.geocode).not.toHaveBeenCalled();
    expect(nominatim.geocode).not.toHaveBeenCalled();
  });

  it('geocoder throw is swallowed → null', async () => {
    ban.geocode.mockRejectedValue(new Error('boom'));
    expect(await geocodeAddress('rue Sedaine 75011 Paris')).toBeNull();
  });
});

describe('geocodeListing precision ladder', () => {
  const STREET_HIT = { lat: 48.8546, lng: 2.3804, type: 'street' };

  it('street tier: BAN street hit on geocodeHint OVERRIDES native centroid coords', async () => {
    ban.geocode.mockResolvedValue(STREET_HIT);

    const coords = await geocodeListing({
      latitude: 48.8578,
      longitude: 2.3841,
      geocodeHint: 'rue de Charonne 75011',
      address: '75011 Paris 11e',
    });

    expect(coords).toEqual(STREET_HIT);
    expect(nominatim.geocode).not.toHaveBeenCalled();
  });

  it("number-less hint → BAN constrained with { type: 'street' }", async () => {
    ban.geocode.mockResolvedValue(STREET_HIT);

    await geocodeListing({ geocodeHint: 'rue de Charonne 75011', latitude: null, longitude: null, address: null });

    expect(ban.geocode).toHaveBeenCalledWith('rue de Charonne 75011', { type: 'street' });
  });

  it('hint with a house number → unconstrained BAN query (housenumber precision allowed)', async () => {
    ban.geocode.mockResolvedValue({ lat: 48.857136, lng: 2.375021, type: 'housenumber' });

    const coords = await geocodeListing({
      geocodeHint: '12 rue Sedaine 75011',
      latitude: 48.8578,
      longitude: 2.3841,
      address: '75011 Paris 11e',
    });

    expect(ban.geocode).toHaveBeenCalledWith('12 rue Sedaine 75011', {});
    expect(coords.type).toBe('housenumber');
  });

  it('municipality-precision BAN result is REJECTED → native coords win', async () => {
    ban.geocode.mockResolvedValue({ lat: 48.8566, lng: 2.3522, type: 'municipality' });

    const coords = await geocodeListing({
      geocodeHint: 'rue Imaginaire 75011',
      latitude: 48.8578,
      longitude: 2.3841,
      address: '75011 Paris 11e',
    });

    expect(coords).toEqual({ lat: 48.8578, lng: 2.3841, type: 'native' });
  });

  it('BAN miss (null) on the hint → native coords win, no address lookup', async () => {
    ban.geocode.mockResolvedValue(null);

    const coords = await geocodeListing({
      geocodeHint: 'rue Imaginaire 75011',
      latitude: 48.8578,
      longitude: 2.3841,
      address: '75011 Paris 11e',
    });

    expect(coords).toEqual({ lat: 48.8578, lng: 2.3841, type: 'native' });
    expect(nominatim.geocode).not.toHaveBeenCalled();
  });

  it('no hint + native coords → native returned WITHOUT any geocoder call', async () => {
    const coords = await geocodeListing({ latitude: 48.8578, longitude: 2.3841, address: '75011 Paris 11e' });

    expect(coords).toEqual({ lat: 48.8578, lng: 2.3841, type: 'native' });
    expect(ban.geocode).not.toHaveBeenCalled();
    expect(nominatim.geocode).not.toHaveBeenCalled();
  });

  it('no hint, no native coords → falls through to geocodeAddress (BAN → Nominatim)', async () => {
    ban.geocode.mockResolvedValue(null);
    nominatim.geocode.mockResolvedValue({ lat: 48.86, lng: 2.36 });

    const coords = await geocodeListing({ latitude: null, longitude: null, address: '75010 Paris 10e' });

    expect(ban.geocode).toHaveBeenCalledWith('75010 Paris 10e');
    expect(coords).toEqual({ lat: 48.86, lng: 2.36 });
  });

  it('street-tier throw is swallowed → native coords still returned', async () => {
    ban.geocode.mockRejectedValue(new Error('boom'));

    const coords = await geocodeListing({
      geocodeHint: 'rue de Charonne 75011',
      latitude: 48.8578,
      longitude: 2.3841,
      address: '75011 Paris 11e',
    });

    expect(coords).toEqual({ lat: 48.8578, lng: 2.3841, type: 'native' });
  });

  it('null listing → null', async () => {
    expect(await geocodeListing(null)).toBeNull();
  });
});

describe('isGeocodingPaused', () => {
  it('paused only when BOTH BAN and Nominatim are paused', () => {
    expect(isGeocodingPaused()).toBe(false);

    ban.isPaused.mockReturnValue(true);
    expect(isGeocodingPaused()).toBe(false);

    nominatim.isPaused.mockReturnValue(true);
    expect(isGeocodingPaused()).toBe(true);

    ban.isPaused.mockReturnValue(false);
    expect(isGeocodingPaused()).toBe(false);
  });
});

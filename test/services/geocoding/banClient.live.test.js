/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * paris-hunter: OPTIONAL LIVE test — one real call to the public BAN API.
 * Runs only under `yarn test` (TEST_MODE=live); skipped by `yarn test:offline`.
 * BAN is free/public (api-adresse.data.gouv.fr), no key required.
 */

import { describe, it, expect } from 'vitest';

describe.runIf(process.env.TEST_MODE === 'live')('banClient LIVE (real BAN API call)', () => {
  it("resolves 'rue Sedaine 75011 Paris' to the 11e arrondissement", async () => {
    const { geocode } = await import('../../../lib/services/geocoding/client/banClient.js');

    const coords = await geocode('rue Sedaine 75011 Paris');

    // Verified 2026-07-12: {lat: 48.857136, lng: 2.375021}, score 0.979, type street.
    expect(coords).not.toBeNull();
    expect(coords.lat).toBeGreaterThan(48.84);
    expect(coords.lat).toBeLessThan(48.88);
    expect(coords.lng).toBeGreaterThan(2.35);
    expect(coords.lng).toBeLessThan(2.4);
    expect(coords.type).toBe('street');
  });

  it("number-less street-tier query 'rue de Charonne 75011' resolves at street precision", async () => {
    const { geocode } = await import('../../../lib/services/geocoding/client/banClient.js');

    const coords = await geocode('rue de Charonne 75011', { type: 'street' });

    expect(coords).not.toBeNull();
    expect(coords.type).toBe('street');
    expect(coords.lat).toBeGreaterThan(48.84);
    expect(coords.lat).toBeLessThan(48.87);
  });
});

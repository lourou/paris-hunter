/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import { buildMessage } from '../../../lib/services/paris-hunter/messageFormat.js';

const baseListing = (overrides = {}) => ({
  title: 'Grand appartement traversant',
  link: 'https://example.test/listing/123',
  ph: {
    kind: 'match',
    priceHc: 2850,
    priceCc: 2950,
    surface: 72,
    rooms: 3,
    zipcode: '75011',
    city: 'Paris',
    quartier: 'Charonne',
    phone: '06 12 34 56 78',
    score: { pricePerM2: 2850 / 72, capRatio: 2850 / 72 / 34, flags: ['OVER_CAP'] },
    ...overrides,
  },
});

describe('paris-hunter message formatting', () => {
  it('renders the mobile-first brief example with French numbers', () => {
    expect(buildMessage(baseListing())).toBe(
      [
        '🏠 3P · 72 m² · 2 850 € HC · 39,6 €/m² ⚠️ > plafond',
        '📍 Paris 11e — Charonne',
        'Grand appartement traversant',
        '📞 06 12 34 56 78',
        '🔗 https://example.test/listing/123',
      ].join('\n'),
    );
  });

  it('renders the good-deal marker', () => {
    const message = buildMessage(baseListing({ score: { pricePerM2: 27.5, capRatio: 0.8, flags: ['GOOD_DEAL'] } }));
    expect(message.split('\n')[0]).toContain('27,5 €/m² ✅ bonne affaire');
  });

  it('omits price per m2 and marks a missing surface', () => {
    const message = buildMessage(
      baseListing({ surface: null, score: { pricePerM2: 999, capRatio: null, flags: ['NO_SURFACE'] } }),
    );
    expect(message.split('\n')[0]).toBe('🏠 3P · 2 850 € HC (surface inconnue)');
  });

  it('uses the advert price with CC? when HC is unknown', () => {
    const message = buildMessage(baseListing({ priceHc: null, priceCc: 3025 }));
    expect(message.split('\n')[0]).toContain('3 025 € CC?');
  });

  it('omits the phone line when no phone is present', () => {
    const message = buildMessage(baseListing({ phone: null }));
    expect(message).not.toContain('📞');
    expect(message).toContain('🔗 https://example.test/listing/123');
  });

  it('prepends the required price-drop line before the same listing block', () => {
    const message = buildMessage(
      baseListing({ kind: 'price_drop', oldPrice: 2850, newPrice: 2700, pctVariation: -5.2 }),
    );
    expect(message.split('\n')[0]).toBe('⬇️ baisse de prix −5,2 % : 2 850 € → 2 700 €');
    expect(message.split('\n')[1]).toMatch(/^🏠 3P/);
  });

  it('derives a missing price-drop percentage from old and new prices', () => {
    const message = buildMessage(
      baseListing({ kind: 'price_drop', oldPrice: 3000, newPrice: 2700, pctVariation: null }),
    );
    expect(message.split('\n')[0]).toBe('⬇️ baisse de prix −10 % : 3 000 € → 2 700 €');
  });

  it('degrades a data-less price drop to the required label', () => {
    const message = buildMessage(
      baseListing({ kind: 'price_drop', oldPrice: null, newPrice: null, pctVariation: null }),
    );
    expect(message.split('\n')[0]).toBe('⬇️ baisse de prix');
  });

  it('formats the first arrondissement as Paris 1er', () => {
    expect(buildMessage(baseListing({ zipcode: '75001', quartier: null }))).toContain('📍 Paris 1er');
  });

  it('falls back to the city for a non-Paris zipcode', () => {
    expect(buildMessage(baseListing({ zipcode: '92100', city: 'Boulogne', quartier: null }))).toContain('📍 Boulogne');
  });

  it('handles missing optional display fields without leaking null or undefined', () => {
    const listing = {
      title: null,
      link: null,
      ph: {
        kind: 'match',
        priceHc: null,
        priceCc: null,
        surface: null,
        rooms: null,
        zipcode: null,
        city: null,
        quartier: null,
        phone: null,
        score: null,
      },
    };
    const message = buildMessage(listing);
    expect(message).toBe('🏠 (surface inconnue)');
    expect(message).not.toMatch(/null|undefined/);
  });

  it('consumes ph numerics and ignores Fredy-formatted top-level fields', () => {
    const listing = {
      ...baseListing(),
      id: 'mutated-db-id',
      price: '9.999,00 €',
      size: '999 m²',
      rooms: '9',
    };
    const message = buildMessage(listing);
    expect(message.split('\n')[0]).toBe('🏠 3P · 72 m² · 2 850 € HC · 39,6 €/m² ⚠️ > plafond');
    expect(message).not.toContain('mutated-db-id');
    expect(message).not.toContain('9.999');
  });

  it('throws on a Fredy-formatted listing without the normative ph object', () => {
    expect(() => buildMessage({ title: 'Wrong shape', link: 'https://example.test', price: '2 850 €' })).toThrow(
      /requires a listing with numeric ph fields/,
    );
  });

  it('does not mutate the listing while formatting it', () => {
    const listing = baseListing();
    const snapshot = structuredClone(listing);
    buildMessage(listing);
    expect(listing).toEqual(snapshot);
  });
});

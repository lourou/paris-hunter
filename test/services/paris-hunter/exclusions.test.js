/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import { findExclusion } from '../../../lib/services/paris-hunter/exclusions.js';

describe('paris-hunter hard exclusions', () => {
  it.each([
    ['Appartement meublé', 'meuble'],
    ['APPARTEMENT MEUBLE', 'meuble'],
    ['Location Meublée', 'meuble'],
    ['location meublee', 'meuble'],
    ['Coloc acceptée', 'coloc'],
    ['colocation possible', 'coloc'],
    ['COLOCATIONS ÉTUDIANTES', 'coloc'],
    ['Bail mobilité uniquement', 'bail mobilite'],
    ['bail mobilite uniquement', 'bail mobilite'],
    ['bail-mobilité', 'bail mobilite'],
    ['Location courte durée', 'courte duree'],
    ['location courte duree', 'courte duree'],
    ['COURTE-DURÉE', 'courte duree'],
    ['Sous-location autorisée', 'sous-location'],
    ['sous location autorisee', 'sous-location'],
    ['souslocation temporaire', 'sous-location'],
    ['Location saisonnière', 'saisonnier'],
    ['location saisonniere', 'saisonnier'],
    ['Logement saisonnier', 'saisonnier'],
    ['offre saisonniere', 'saisonnier'],
  ])('fails closed for fixture %j', (text, expectedTerm) => {
    expect(findExclusion(text)).toBe(expectedTerm);
  });

  it.each([
    'Appartement non meublé',
    'appartement non meuble',
    'Location non-meublée longue durée',
    'Ce logement n’est pas meublé',
    'Logement pas meuble',
    'Pas de meublé, bail classique',
  ])('removes an explicit unfurnished negation before matching: %s', (text) => {
    expect(findExclusion(text)).toBeNull();
  });

  it('still catches another exclusion after removing a furnished negation', () => {
    expect(findExclusion('Appartement non meublé, colocation possible')).toBe('coloc');
  });

  it('returns the first term in stable rule order for provider decision logging', () => {
    expect(findExclusion('Colocation dans un appartement meublé')).toBe('meuble');
  });

  it.each(['Appartement proche métro', 'Location nue longue durée', 'Bail loi 1989', 'Local à vélos', ''])(
    'does not produce a false positive for clean fixture %j',
    (text) => {
      expect(findExclusion(text)).toBeNull();
    },
  );

  // Regression pin: institutional/civil lease wordings must never trip the
  // "bail mobilité" arm (or any other exclusion).
  it.each(['bail civil', 'Bail civil', 'bail code civil', 'Bail code civil, location nue'])(
    'never excludes the civil-lease wording %j',
    (text) => {
      expect(findExclusion(text)).toBeNull();
    },
  );

  it('handles missing text without throwing', () => {
    expect(findExclusion(null)).toBeNull();
    expect(findExclusion(undefined)).toBeNull();
  });
});

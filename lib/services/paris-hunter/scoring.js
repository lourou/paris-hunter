/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getCapForZip } from './capTable.js';

/**
 * Scores a listing against the approximate unfurnished-rental cap. Flags are
 * informational only; filtering remains the provider's responsibility.
 *
 * @param {{ priceHc: number|null, surface: number|null, zipcode: string|null }} input
 * @returns {{ pricePerM2: number|null, capRatio: number|null, flags: Array<'OVER_CAP'|'GOOD_DEAL'|'NO_SURFACE'> }}
 */
export const scoreListing = ({ priceHc, surface, zipcode }) => {
  if (!Number.isFinite(surface) || surface <= 0) {
    return { pricePerM2: null, capRatio: null, flags: ['NO_SURFACE'] };
  }

  if (!Number.isFinite(priceHc)) {
    return { pricePerM2: null, capRatio: null, flags: [] };
  }

  const pricePerM2 = priceHc / surface;
  const cap = getCapForZip(zipcode);
  const capRatio = cap == null ? null : pricePerM2 / cap;
  const flags = [];

  if (capRatio != null && capRatio > 1.05) {
    flags.push('OVER_CAP');
  } else if (capRatio != null && capRatio < 0.85) {
    flags.push('GOOD_DEAL');
  }

  return { pricePerM2, capRatio, flags };
};

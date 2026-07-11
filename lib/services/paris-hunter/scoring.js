/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getCapForZip } from './capTable.js';
import { normalizeText } from './exclusions.js';

// Premium POSITIVE signal: an institutional 6-year unfurnished lease ("bail de
// 6 ans", "bail six ans", "bail 6 années", "bail institutionnel"). Matched on
// the same case/diacritic-normalized text as the exclusion regexes. A bare
// "bail" or "bail civil" must NOT trigger it.
const BAIL_6_ANS_PATTERN = /\bbail[-\s]+(?:de[-\s]+)?(?:6|six)[-\s]+an(?:s|nees?)\b|\bbail[-\s]+institutionnel\b/;

/**
 * True when the listing text advertises an institutional 6-year lease.
 *
 * @param {string|null|undefined} text listing title and/or description
 * @returns {boolean}
 */
export const hasBail6Ans = (text) => BAIL_6_ANS_PATTERN.test(normalizeText(text));

/**
 * Scores a listing against the approximate unfurnished-rental cap. Flags are
 * informational only; filtering remains the provider's responsibility.
 *
 * @param {{ priceHc: number|null, surface: number|null, zipcode: string|null, text?: string|null }} input
 *   `text` is the free listing text (title + description) scanned for premium markers.
 * @returns {{ pricePerM2: number|null, capRatio: number|null, flags: Array<'OVER_CAP'|'GOOD_DEAL'|'NO_SURFACE'|'BAIL_6_ANS'> }}
 */
export const scoreListing = ({ priceHc, surface, zipcode, text = null }) => {
  const premiumFlags = hasBail6Ans(text) ? ['BAIL_6_ANS'] : [];

  if (!Number.isFinite(surface) || surface <= 0) {
    return { pricePerM2: null, capRatio: null, flags: ['NO_SURFACE', ...premiumFlags] };
  }

  if (!Number.isFinite(priceHc)) {
    return { pricePerM2: null, capRatio: null, flags: [...premiumFlags] };
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
  flags.push(...premiumFlags);

  return { pricePerM2, capRatio, flags };
};

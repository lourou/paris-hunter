/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: listing scoring against the per-arrondissement rent cap table.
 *
 * STUB (lane 1) — real implementation is owned by lane 4:
 *   - !surface || surface <= 0 -> { pricePerM2: null, capRatio: null, flags: ['NO_SURFACE'] }
 *   - else pricePerM2 = priceHc / surface; cap = getCapForZip(zipcode);
 *     capRatio = cap ? pricePerM2 / cap : null
 *   - flags: capRatio > 1.05 -> 'OVER_CAP'; capRatio < 0.85 -> 'GOOD_DEAL'
 * Pure function, no I/O.
 *
 * @param {{ priceHc: number|null, surface: number|null, zipcode: string|null }} input
 * @returns {{ pricePerM2: number|null, capRatio: number|null, flags: Array<'OVER_CAP'|'GOOD_DEAL'|'NO_SURFACE'> }}
 */
export const scoreListing = ({ priceHc, surface, zipcode }) => {
  void priceHc;
  void surface;
  void zipcode;
  // TODO(lane 4): implement per the build plan; neutral no-flags result until then.
  return { pricePerM2: null, capRatio: null, flags: [] };
};

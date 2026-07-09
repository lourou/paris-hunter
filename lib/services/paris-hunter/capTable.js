/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: €/m² rent-cap table per zipcode (approx. loyer de référence majoré,
 * location nue — brief §3 LOCKED).
 *
 * STUB (lane 1) — real implementation is owned by lane 4:
 *   DEFAULT_CAP_TABLE = { '75011': 34, '75012': 32, '75010': 33, '75020': 30,
 *                         '75003': 38, '75004': 39, '75009': 34 }
 *   getCapForZip(zip) returns the override from PH_CAP_TABLE_JSON if set,
 *   else the default, else null.
 *
 * @param {string|null} zipcode
 * @returns {number|null}
 */
export const getCapForZip = (zipcode) => {
  void zipcode;
  // TODO(lane 4): implement per the build plan; no cap known until then.
  return null;
};

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { PH } from './phConfig.js';

const DEFAULT_CAP_TABLE = Object.freeze({
  75011: 34,
  75012: 32,
  75010: 33,
  75020: 30,
  75003: 38,
  75004: 39,
  75009: 34,
});

const asPositiveNumber = (value) => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/**
 * Returns the approximate unfurnished-rental cap for a Paris zipcode. A valid
 * per-zipcode PH_CAP_TABLE_JSON value takes precedence over the built-in table.
 *
 * @param {string|null} zipcode
 * @returns {number|null}
 */
export const getCapForZip = (zipcode) => {
  if (zipcode == null) {
    return null;
  }

  const zip = String(zipcode).trim();
  const override = PH.capTableOverride;
  if (override != null && Object.prototype.hasOwnProperty.call(override, zip)) {
    return asPositiveNumber(override[zip]);
  }

  return asPositiveNumber(DEFAULT_CAP_TABLE[zip]);
};

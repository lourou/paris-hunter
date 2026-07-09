/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: central env-driven configuration.
 * Single source of truth for the search band, area, and feature toggles.
 * Env keys are documented in .env.example (frozen by lane 1).
 */

import logger from '../logger.js';

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toList = (value, fallback) => {
  if (value == null || value.trim() === '') {
    return fallback;
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

/**
 * Builds the PH config object from an env map. Exported for tests; runtime code
 * should use the PH singleton below.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export const buildPhConfig = (env = process.env) => {
  let capTableOverride = null;
  if (env.PH_CAP_TABLE_JSON != null && env.PH_CAP_TABLE_JSON.trim() !== '') {
    try {
      capTableOverride = JSON.parse(env.PH_CAP_TABLE_JSON);
    } catch {
      logger.error('paris-hunter: PH_CAP_TABLE_JSON is not valid JSON — ignoring the override.');
      capTableOverride = null;
    }
  }
  return {
    zips: toList(env.PH_ZIPS, ['75011', '75012']),
    budgetHcMin: toInt(env.PH_BUDGET_HC_MIN, 2500),
    budgetHcMax: toInt(env.PH_BUDGET_HC_MAX, 3100),
    roomsMin: toInt(env.PH_ROOMS_MIN, 3),
    roomsMax: toInt(env.PH_ROOMS_MAX, 4),
    capTableOverride,
    skipChromium: env.FREDY_SKIP_CHROMIUM === 'true',
    convosEnabled: env.CONVOS_ENABLED === 'true',
    webhookSecret: env.STREAM_ESTATE_WEBHOOK_SECRET ?? null,
    jobId: 'paris-hunter',
  };
};

export const PH = buildPhConfig();

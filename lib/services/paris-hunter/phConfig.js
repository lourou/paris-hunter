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
    zips: toList(env.PH_ZIPS, ['75009', '75010', '75011', '75012', '75013', '75017', '75020']),
    // Allowa excludes 75017 from the PH zip union (75017 is deliberately dropped
    // on the Stream Estate side via excludedCities; PH_ZIPS carries it only due to
    // a reconcile coupling). Config-driven, not a magic literal.
    allowaExcludedZips: toList(env.PH_ALLOWA_EXCLUDED_ZIPS, ['75017']),
    budgetHcMin: toInt(env.PH_BUDGET_HC_MIN, 2000),
    budgetHcMax: toInt(env.PH_BUDGET_HC_MAX, 3100),
    // The server-side band is deliberately WIDER than the local HC band:
    // Stream Estate matches on the advertised price (which may include
    // charges or drop later), so a wider band avoids missing listings whose
    // hors-charges price lands in-band. The strict gate stays local
    // (decideFilter on priceHc against budgetHcMin/Max).
    serverBudgetMin: toInt(env.PH_SERVER_BUDGET_MIN, 1900),
    serverBudgetMax: toInt(env.PH_SERVER_BUDGET_MAX, 3350),
    roomsMin: toInt(env.PH_ROOMS_MIN, 3),
    roomsMax: toInt(env.PH_ROOMS_MAX, 4),
    monthlyItemBudget: toInt(env.PH_MONTHLY_ITEM_BUDGET, 900),
    capTableOverride,
    skipChromium: env.FREDY_SKIP_CHROMIUM === 'true',
    convosEnabled: env.CONVOS_ENABLED === 'true',
    webhookSecret: env.STREAM_ESTATE_WEBHOOK_SECRET ?? null,
    // The email endpoint remains safely disabled until both secrets are set.
    emailWebhookSecret: env.EMAIL_WEBHOOK_SECRET ?? null,
    emailWebhookToken: env.PH_EMAIL_TOKEN ?? null,
    jobId: 'paris-hunter',
  };
};

export const PH = buildPhConfig();

/**
 * Boot-fatal validation helpers (build plan v2 #17). They THROW with a clear,
 * secret-free message; initParisHunter() catches, logs, and process.exit(1)s.
 * The webhook secret value must NEVER appear in any log or error message.
 */

/** @param {string|null} [secret] */
export const assertValidSecret = (secret = PH.webhookSecret) => {
  // Length is also checked before timingSafeEqual at request time (it throws on
  // unequal-length buffers); ≥32 chars keeps the URL path segment unguessable.
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error(
      'STREAM_ESTATE_WEBHOOK_SECRET must be set and at least 32 characters long (generate: openssl rand -hex 24).',
    );
  }
};

/** @param {string|undefined} [baseUrl] */
export const assertHttpsBaseUrl = (baseUrl = process.env.PUBLIC_BASE_URL) => {
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('https://')) {
    throw new Error('PUBLIC_BASE_URL must be an https:// URL (required in production).');
  }
};

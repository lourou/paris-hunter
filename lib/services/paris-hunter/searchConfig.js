/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: Stream Estate saved-search IDENTITY shared by the bootstrap
 * tool, the budget guard, and the provider's watermark gate (v3 A5).
 *
 * configRev = sha256 of the canonical JSON of the search body we PUT (band,
 * zips, rooms, furnished, webhook URLs). The watermark JSON persisted in
 * paris_hunter_meta binds cutoffMs to BOTH the searchId and this configRev —
 * a watermark can never authorize notifications for a search/config it wasn't
 * minted for. notificationEnabled is deliberately NOT part of the identity
 * body (it is state, not identity — it flips between bootstrap and enable).
 */

import crypto from 'node:crypto';
import { PH } from './phConfig.js';

/** Ownership marker: every search we own has a title starting with this. */
export const SEARCH_TITLE_PREFIX = '[ph:v1]';

/**
 * Builds the canonical saved-search identity body (build plan v2 lane 2 /
 * recon §2). Reads env lazily so tools and tests see current values.
 *
 * @param {{ ph?: typeof PH, env?: NodeJS.ProcessEnv }} [options]
 * @returns {object} search body WITHOUT notificationEnabled
 */
export const buildSearchBody = ({ ph = PH, env = process.env } = {}) => {
  const baseUrl = (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  const secret = env.STREAM_ESTATE_WEBHOOK_SECRET ?? '';
  return {
    title: `${SEARCH_TITLE_PREFIX} paris-hunter 11e-12e 3-4p unfurnished`,
    transactionType: 1,
    propertyTypes: [0],
    includedZipcodes: [...ph.zips],
    budgetMin: ph.serverBudgetMin,
    budgetMax: ph.serverBudgetMax,
    roomMin: ph.roomsMin,
    roomMax: ph.roomsMax,
    furnished: false,
    endpointRecipient: `${baseUrl}/api/webhook/stream-estate/${secret}/match`,
    eventEndpoint: `${baseUrl}/api/webhook/stream-estate/${secret}/event`,
    subscribedEvents: ['ad.update.price'],
  };
};

const canonicalize = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value != null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
};

/**
 * @param {object} body search identity body
 * @returns {string} sha256 hex of the canonical (key-sorted) JSON
 */
export const computeConfigRev = (body) => {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(body)))
    .digest('hex');
};

/**
 * configRev of the CURRENT process configuration (PH + env) — the provider
 * recomputes this and refuses any watermark minted for another config.
 *
 * @returns {string}
 */
export const currentConfigRev = () => computeConfigRev(buildSearchBody());

/**
 * Parses the notifyWatermark meta value (v3 A5 JSON format). Strict: cutoffMs
 * must be an integer and searchId/configRev non-empty strings; anything else
 * returns null so callers treat the deploy as unseeded (fail-silent).
 *
 * @param {string|null} raw
 * @returns {{ cutoffMs: number, searchId: string, configRev: string }|null}
 */
export const parseWatermark = (raw) => {
  if (typeof raw !== 'string' || raw === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed != null &&
      Number.isInteger(parsed.cutoffMs) &&
      typeof parsed.searchId === 'string' &&
      parsed.searchId !== '' &&
      typeof parsed.configRev === 'string' &&
      parsed.configRev !== ''
    ) {
      return { cutoffMs: parsed.cutoffMs, searchId: parsed.searchId, configRev: parsed.configRev };
    }
    return null;
  } catch {
    return null;
  }
};

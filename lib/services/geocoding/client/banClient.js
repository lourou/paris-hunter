/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * paris-hunter addition: BAN (Base Adresse Nationale) geocoding client.
 * Modeled on nominatimClient.js (same throttle/pause interface).
 *
 * https://api-adresse.data.gouv.fr/ is the free French national address API.
 * It only knows French addresses — a confident hit returns coordinates, any
 * miss (no feature, low score, error) returns null so the caller can fall
 * back to Nominatim for non-French queries.
 */

import https from 'https';
import fetch from 'node-fetch';
import pThrottle from 'p-throttle';
import logger from '../../logger.js';

const API_URL = 'https://api-adresse.data.gouv.fr/search/';

/** BAN rejects matches below this score as ambiguous (properties.score is 0..1). */
const MIN_SCORE = 0.4;

const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
});

// BAN allows up to 50 req/s per IP; stay far below to be a good citizen.
const throttle = pThrottle({
  limit: 10,
  interval: 1000,
});

const userAgent = 'Fredy-Self-Hosted paris-hunter (+https://github.com/orangecoding/fredy)';

let last429 = 0;
const PAUSE_DURATION = 3600000; // 1 hour

/**
 * Extracts a French postcode (5 digits) from a free-text query, if any.
 * The last 5-digit group wins: "12 rue Sedaine 75011 Paris" → "75011".
 *
 * @param {string} query
 * @returns {string|null}
 */
const extractPostcode = (query) => {
  const matches = query.match(/\b\d{5}\b/g);
  return matches ? matches[matches.length - 1] : null;
};

/** French street-type tokens for free-text street extraction. */
const STREET_TOKEN_RE =
  /(?:\b(\d{1,4})(?:\s*(?:bis|ter))?\s*,?\s+)?\b(rue|avenue|av\.?|boulevard|bd\.?|passage|impasse|villa|cit[eé]|all[eé]e|quai|place|square)(?=\s)/gi;

/** Lowercase glue words allowed INSIDE a street name ("rue de la Roquette"). */
const STREET_PARTICLES = new Set(['de', 'du', 'des', 'la', 'le', 'les', "d'", "l'", 'd’', 'l’', 'au', 'aux', 'et']);

/**
 * Extracts a street name (with optional house number) from French free text.
 * After a street-type token, words are consumed while they are lowercase
 * particles or capitalized proper nouns; a digit/comma/other word is the
 * boundary. At least one proper noun is required ("place de parking" → null,
 * "proche Bd Voltaire" → "Bd Voltaire").
 *
 * @param {string} text - Free text (e.g. listing title + description).
 * @returns {string|null} e.g. "12 rue Sedaine", "rue de Charonne", or null.
 */
export const extractStreet = (text) => {
  if (typeof text !== 'string' || text === '') {
    return null;
  }
  STREET_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = STREET_TOKEN_RE.exec(text)) !== null) {
    let rest = text.slice(match.index + match[0].length);
    const words = [];
    let sawProperNoun = false;
    while (words.length < 5) {
      const word = rest.match(/^\s+([A-Za-zÀ-ÖØ-öø-ÿ'’-]+)/u);
      if (word == null) {
        break; // digit, comma, or end of text — hard boundary
      }
      const isParticle = STREET_PARTICLES.has(word[1].toLowerCase());
      const isProperNoun = /^[A-ZÀ-ÖØ-Þ]/u.test(word[1]);
      if (!isParticle && !isProperNoun) {
        break;
      }
      words.push(word[1]);
      sawProperNoun = sawProperNoun || isProperNoun;
      rest = rest.slice(word[0].length);
    }
    while (words.length > 0 && STREET_PARTICLES.has(words[words.length - 1].toLowerCase())) {
      words.pop(); // "rue de Charonne et" → drop the trailing glue
    }
    if (sawProperNoun && words.length > 0) {
      return `${match[1] ? `${match[1]} ` : ''}${match[2]} ${words.join(' ')}`;
    }
  }
  return null;
};

/**
 * Geocodes an address using the BAN API.
 *
 * Returns null for ANY miss (error, rate-limit pause, no feature, ambiguous
 * low-score match) — unlike nominatimClient there is no {-1, -1} sentinel,
 * because a BAN miss must let the caller fall back to Nominatim.
 *
 * @param {string} address - The address to geocode.
 * @param {{type?: string}} [options] - options.type constrains the BAN result
 *   type (e.g. 'street' for number-less street queries → street centroid).
 * @returns {Promise<{lat: number, lng: number, type: string}|null>} Coordinates
 *   + BAN precision type (housenumber|street|locality|municipality) on a
 *   confident hit, null otherwise.
 */
async function doGeocode(address, options = {}) {
  if (Date.now() - last429 < PAUSE_DURATION) {
    return null;
  }

  const postcode = extractPostcode(address);
  const typeFilter = options.type ? `&type=${encodeURIComponent(options.type)}` : '';
  const url = `${API_URL}?q=${encodeURIComponent(address)}&limit=1${postcode ? `&postcode=${postcode}` : ''}${typeFilter}`;

  try {
    const response = await fetch(url, {
      agent,
      timeout: 60000,
      headers: {
        'User-Agent': userAgent,
      },
    });

    if (response.status === 429) {
      logger.warn('BAN rate limit hit. Pausing for 1 hour.');
      last429 = Date.now();
      return null;
    }

    if (!response.ok) {
      logger.error(`BAN API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();

    // GeoJSON: features[0].geometry.coordinates = [lon, lat], properties.score = 0..1.
    const feature = Array.isArray(data?.features) ? data.features[0] : null;
    const score = Number(feature?.properties?.score);
    const coordinates = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
    const lon = Number(coordinates[0]);
    const lat = Number(coordinates[1]);

    if (feature == null || !(score >= MIN_SCORE) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }

    return { lat, lng: lon, type: feature.properties?.type ?? 'unknown' };
  } catch (error) {
    logger.error('Error during BAN geocoding:', error);
    return null;
  }
}

export const geocode = throttle(doGeocode);

export const isPaused = () => Date.now() - last429 < PAUSE_DURATION;

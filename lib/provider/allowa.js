/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../services/storage/SqliteConnection.js';
import logger from '../services/logger.js';
import { bus } from '../services/events/event-bus.js';
import { PH } from '../services/paris-hunter/phConfig.js';
import { buildMessage } from '../services/paris-hunter/messageFormat.js';
import { scoreListing } from '../services/paris-hunter/scoring.js';
import { findExclusion } from '../services/paris-hunter/exclusions.js';
import { hasEntry } from '../services/similarity-check/similarityCache.js';
import { isOneOf } from '../utils.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const API_URL = 'https://api.allowa.com/v1/search/pa';
const DEFAULT_URL = 'https://recherche.allowa.com/?category=Location&cities=Paris';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const ALLOWED_NATURES = new Set(['Appartement', 'Maison']);

let appliedBlacklist = [];

/**
 * Coerces an Allowa numeric field, accepting defensive French decimal strings.
 *
 * @param {unknown} value raw field value
 * @returns {number|null} finite number or null
 */
const num = (value) => {
  const parsed = typeof value === 'string' ? Number(value.replace(/\s/g, '').replace(',', '.')) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

/**
 * Extracts the HTTPS photo URLs exposed by an Allowa Salesforce record.
 *
 * @param {object} raw Allowa Logement__c record
 * @returns {string[]} usable photo URLs
 */
const photoUrlsFrom = (raw) => {
  const others = typeof raw?.Liens_Autres_Images__c === 'string' ? raw.Liens_Autres_Images__c.split(';') : [];
  return [raw?.LienImage1__c, ...others]
    .map((url) => (typeof url === 'string' ? url.trim() : url))
    .filter((url) => typeof url === 'string' && url.startsWith('https://'));
};

/**
 * Normalizes a Salesforce Logement__c record into Fredy's ParsedListing plus
 * the Paris Hunter fields used for filtering and Convos formatting.
 *
 * @param {object} raw Allowa Logement__c record
 * @returns {ParsedListing & { ph: object }} normalized listing
 */
function normalize(raw) {
  const externalId = raw?.ReferenceAnnonce__c ?? raw?.Id ?? null;
  const dedupKey = externalId == null ? null : `allowa:${externalId}`;
  const title = raw?.TitreAnnonce__c ?? null;
  const description = raw?.DescriptionAnnonce__c ?? null;
  const priceHc = num(raw?.LoyerHorsCharge__c);
  const charges = num(raw?.ChargesLogement__c);
  const fallbackPriceCc = priceHc != null && charges != null ? priceHc + charges : null;
  const priceCc = num(raw?.Total__c) ?? fallbackPriceCc;
  const surface =
    num(raw?.SurfaceHabitable__c) ?? num(raw?.Surface__c) ?? num(raw?.SurfaceCarrez__c) ?? num(raw?.Superficie__c);
  const rooms = num(raw?.Nombrepieces__c);
  const zipcode = raw?.CodePostal__c == null ? null : String(raw.CodePostal__c);
  const city = raw?.Ville__c ?? null;
  const nature = raw?.Nature__c ?? null;
  const photoUrls = photoUrlsFrom(raw);
  const slug = raw?.Slug__c ?? null;

  const ph = {
    dedupKey,
    kind: 'match',
    externalId,
    priceHc,
    charges,
    priceCc,
    surface,
    rooms,
    zipcode,
    city,
    furnished: raw?.Meuble__c === true,
    photoUrls,
    createdAtMs: Date.now(),
    nature,
    score: scoreListing({ priceHc, surface, zipcode, text: `${title ?? ''} ${description ?? ''}` }),
  };

  return {
    id: dedupKey,
    link: slug == null ? null : `https://recherche.allowa.com/logement/${slug}`,
    title,
    image: photoUrls[0] ?? null,
    size: surface,
    rooms,
    address: [raw?.Adresse__c, raw?.CodePostal__c, raw?.Ville__c].filter(Boolean).join(' '),
    latitude: num(raw?.Latitude__c),
    longitude: num(raw?.Longitude__c),
    price: priceCc,
    description,
    ph,
  };
}

/**
 * Returns the fail-closed decision for an Allowa candidate, or null when it
 * passes the local Paris Hunter gate.
 *
 * @param {ParsedListing & { ph: object }} listing normalized candidate
 * @returns {string|null} decision string or null
 */
const decideFilter = (listing) => {
  const { ph } = listing;
  const term = findExclusion(`${listing.title ?? ''} ${listing.description ?? ''}`);
  if (term != null) {
    return `excluded:${term}`;
  }
  if (ph.furnished === true) {
    return 'excluded:furnished';
  }
  if (!ALLOWED_NATURES.has(ph.nature)) {
    return 'excluded:nature';
  }
  const allowedZips = PH.zips.filter((zipcode) => !PH.allowaExcludedZips.includes(zipcode));
  if (ph.zipcode == null || !allowedZips.includes(ph.zipcode)) {
    return 'excluded:zip';
  }
  if (!Number.isFinite(ph.priceHc)) {
    return 'quarantine:price';
  }
  if (!Number.isFinite(ph.rooms)) {
    return 'quarantine:rooms';
  }
  // The PH band is hors-charges while the displayed top-level price is CC.
  // Applying this gate to CC would wrongly drop listings near the HC ceiling.
  if (ph.priceHc < PH.budgetHcMin || ph.priceHc > PH.budgetHcMax) {
    return 'excluded:band';
  }
  if (ph.rooms < PH.roomsMin || ph.rooms > PH.roomsMax) {
    return 'excluded:rooms-band';
  }
  if (isOneOf(listing.title, appliedBlacklist) || isOneOf(listing.description, appliedBlacklist)) {
    return 'excluded:blacklist';
  }
  return null;
};

/**
 * Applies the provider's local gate.
 *
 * @param {ParsedListing & { ph: object }} listing normalized listing
 * @returns {boolean} true when the listing should remain in Fredy's pipeline
 */
function filter(listing) {
  return decideFilter(listing) == null;
}

/**
 * Builds one API page URL from the fixed Allowa search and PH server band.
 * The wider server band avoids missing candidates; decideFilter applies the
 * strict HC band locally.
 *
 * @param {number} offset result offset
 * @returns {URL} Allowa API URL
 */
const buildSearchUrl = (offset) => {
  const url = new URL(API_URL);
  url.searchParams.append('cities[]', 'Paris');
  url.searchParams.set('category', 'Location');
  for (const rooms of [3, 4, 5]) {
    url.searchParams.append('numberOfRooms[]', String(rooms));
  }
  url.searchParams.append('nature[]', 'Appartement');
  url.searchParams.set('minPrice', String(PH.serverBudgetMin));
  url.searchParams.set('maxPrice', String(PH.serverBudgetMax));
  url.searchParams.set('offset', String(offset));
  return url;
};

/**
 * Atomically records a passing candidate as seen and, when unique across
 * providers, adds its durable Convos outbox row.
 *
 * @param {ParsedListing & { ph: object }} candidate normalized listing
 * @returns {string} durable decision
 */
const decideCandidate = (candidate) => {
  const seenKey = candidate.ph.dedupKey;
  return SqliteConnection.withTransaction((db) => {
    const seen = db.prepare('SELECT 1 FROM ph_seen WHERE dedup_key = @key').get({ key: seenKey });
    if (seen != null) {
      return 'duplicate';
    }

    const now = Date.now();
    db.prepare('INSERT INTO ph_seen (dedup_key, first_seen_at) VALUES (@key, @now)').run({ key: seenKey, now });

    // Known weak cross-source guard: the fork's designated cache hashes exact
    // title + CC price + address, so SeLoger/Allowa title or HC/CC differences
    // rarely collide. This lookup must stay read-only; Fredy's pipeline owns
    // the later checkAndAddEntry mutation for freshly stored rows.
    if (hasEntry({ title: candidate.title, address: candidate.address, price: candidate.price })) {
      return 'duplicate:cross-source';
    }

    db.prepare(
      `INSERT OR IGNORE INTO convos_outbox (id, dedup_key, kind, text, image_url, created_at)
       VALUES (@id, @dedupKey, @kind, @text, @imageUrl, @createdAt)`,
    ).run({
      id: seenKey,
      dedupKey: seenKey,
      kind: 'match',
      text: buildMessage(candidate),
      imageUrl: candidate.ph.photoUrls[0] ?? null,
      createdAt: now,
    });
    return 'outboxed';
  });
};

/**
 * Polls every Allowa API page, makes durable decisions for passing candidates,
 * and returns all raw rows for Fredy's normal pipeline storage/UI flow.
 *
 * @returns {Promise<object[]>} all raw API records
 */
async function getListings() {
  const collected = [];
  let offset = 0;

  for (;;) {
    const response = await fetch(buildSearchUrl(offset), {
      method: 'GET',
      headers: {
        AllowaOrigin: 'Allowa-Plateforme-Annonce',
        Accept: 'application/json',
        Origin: 'https://recherche.allowa.com',
        Referer: 'https://recherche.allowa.com/',
        'User-Agent': USER_AGENT,
      },
    });
    if (response.status === 204) {
      break;
    }
    if (!response.ok) {
      throw new Error(`Allowa API request failed with status ${response.status}`);
    }

    const page = await response.json();
    const results = Array.isArray(page?.result) ? page.result : [];
    collected.push(...results);
    offset += results.length;
    const count = Number(page?.count);
    if (results.length === 0 || (Number.isFinite(count) && collected.length >= count)) {
      break;
    }
  }

  let outboxedCount = 0;
  for (const raw of collected) {
    const candidate = normalize(raw);
    let decision = decideFilter(candidate);
    if (decision == null) {
      decision = decideCandidate(candidate);
      if (decision === 'outboxed') {
        outboxedCount += 1;
      }
    }
    logger.info(`paris-hunter provider: Allowa listing ${candidate.ph.dedupKey ?? 'unknown'} → ${decision}.`);
  }

  if (outboxedCount > 0) {
    try {
      bus.emit('convos:flush');
    } catch (error) {
      logger.warn(`paris-hunter provider: Allowa convos:flush emit failed — ${error.message}`);
    }
  }
  return collected;
}

/** @type {ProviderConfig} */
export const config = {
  url: null,
  requiredFieldNames: ['id', 'link', 'title'],
  normalize,
  filter,
  getListings,
};

/**
 * Applies the current job's source configuration and blacklist.
 *
 * @param {object} sourceConfig provider job configuration
 * @param {string[]} blacklist user blacklist entries
 * @returns {void}
 */
export const init = (sourceConfig, blacklist) => {
  config.enabled = sourceConfig?.enabled ?? true;
  config.url = sourceConfig?.url ?? DEFAULT_URL;
  appliedBlacklist = blacklist ?? [];
};

export const metaInformation = {
  id: 'allowa',
  name: 'Allowa',
  baseUrl: 'https://recherche.allowa.com/',
};

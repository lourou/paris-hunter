/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Stream Estate provider (build plan v2 lane 2, v3 A2/A3/A4/A8/A9).
 *
 * This provider never crawls: Stream Estate pushes saved-search matches and
 * price events to our webhook, which lands them in stream_estate_inbox.
 * getListings() drains that inbox under boot-owned leases and makes ONE
 * durable decision per row inside a single SQLite transaction:
 *   ph_seen insert (decision-exactly-once) + convos_outbox insert (delivery
 *   outbox) + inbox completion (CAS on lease ownership).
 * Crash anywhere → rollback → lease expires / dead-boot recovery → re-claim.
 *
 * The notification gate is the watermark JSON (v3 A5): no watermark, or a
 * watermark minted for another searchId/configRev, suppresses EVERYTHING
 * (fail-silent). Timestamps are epoch ms normalized at ingress (v3 A4) — this
 * module never parses timestamp strings from payloads.
 *
 * Decisions: outboxed | suppressed:watermark | suppressed:unseeded |
 * suppressed:invalid-timestamp | excluded:<term> | quarantine:<field> |
 * skip:price_increase | duplicate | dead-letter:<errClass>
 */

import crypto from 'node:crypto';
import SqliteConnection from '../services/storage/SqliteConnection.js';
import logger from '../services/logger.js';
import { bus } from '../services/events/event-bus.js';
import { PH } from '../services/paris-hunter/phConfig.js';
import {
  bootId,
  bumpAttempts,
  claimInbox,
  completeInbox,
  LEASE_RENEW_AFTER_MS,
  MAX_ROW_ATTEMPTS,
  getParisHunterMeta,
  releaseLeases,
  releaseRow,
  renewLeases,
} from '../services/paris-hunter/inbox.js';
import { currentConfigRev, parseWatermark } from '../services/paris-hunter/searchConfig.js';
import { failpoint } from '../services/paris-hunter/failpoints.js';
import { scoreListing } from '../services/paris-hunter/scoring.js';
import { findExclusion } from '../services/paris-hunter/exclusions.js';
import { buildMessage } from '../services/paris-hunter/messageFormat.js';
import { extractStreet } from '../services/geocoding/client/banClient.js';
import { isOneOf } from '../utils.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const CLAIM_BATCH = 200;
const MAX_DRAIN_ITERATIONS = 50;

let appliedBlacklist = [];

/** Thrown inside the per-row tx when the lease was lost — rolls the tx back. */
class LostLeaseError extends Error {
  constructor() {
    super('lost lease');
    this.name = 'LostLeaseError';
  }
}

/** Row-level error that dead-letters immediately (retries are pointless). */
class RowDataError extends Error {
  constructor(errClass, message) {
    super(message ?? errClass);
    this.name = 'RowDataError';
    this.errClass = errClass;
  }
}

const num = (value) => {
  // \s covers nbsp / narrow-nbsp thousands separators in French price strings.
  const parsed = typeof value === 'string' ? Number(value.replace(/\s/g, '').replace(',', '.')) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

/** A9: integer-normalized price for the price-drop dedup key. */
const normPrice = (value) => {
  const parsed = num(value);
  return parsed == null ? null : Math.round(parsed);
};

const uuidFromRef = (ref) => {
  if (typeof ref !== 'string') {
    return null;
  }
  const tail = ref.split('/').filter(Boolean).pop();
  return tail && tail.length > 0 ? tail : null;
};

const pickAdvert = (doc) => {
  const adverts = Array.isArray(doc?.adverts) ? doc.adverts : [];
  return adverts.find((a) => a != null && typeof a.url === 'string' && a.url !== '') ?? adverts[0] ?? {};
};

/**
 * Normalizes a webhook payload into ParsedListing + ph (shared contract 1,
 * amended by v3 A4: ph.createdAtMs replaces ph.createdAt). Same function for
 * ingress decisions and Fredy's normalize step.
 *
 * @param {'match'|'event'} kind
 * @param {object} payload parsed webhook body (UNTRUSTED)
 * @param {number} eventAtMs ingress-normalized event timestamp
 * @returns {ParsedListing & { ph: object }}
 */
const phNormalize = (kind, payload, eventAtMs) => {
  const isEvent = kind === 'event';
  const matchObj = isEvent ? payload.match : payload;
  const doc = matchObj?.propertyDocument ?? {};
  const advert = pickAdvert(doc);

  const externalId =
    typeof doc.uuid === 'string' && doc.uuid !== '' ? doc.uuid : uuidFromRef(matchObj?.property ?? null);
  if (externalId == null) {
    throw new RowDataError('no-external-id', 'payload carries no property uuid');
  }

  const priceCc = num(advert.price) ?? num(doc.price);
  const charges = num(advert.rentalCharges);
  let priceHc = num(advert.priceExcludingFees);
  if (priceHc == null && priceCc != null && charges != null) {
    priceHc = priceCc - charges;
  }
  if (priceHc == null) {
    priceHc = priceCc;
  }

  const surface = num(doc.surface) ?? num(advert.surface);
  const rooms = num(doc.room);
  const zipcode = typeof doc.city?.zipcode === 'string' && doc.city.zipcode !== '' ? doc.city.zipcode : null;
  const city = typeof doc.city?.name === 'string' && doc.city.name !== '' ? doc.city.name : null;
  const phone = typeof advert.contact?.phone === 'string' && advert.contact.phone !== '' ? advert.contact.phone : null;
  const photoUrls = (Array.isArray(doc.pictures) ? doc.pictures : (advert.pictures ?? [])).filter(
    (u) => typeof u === 'string' && u.startsWith('https://'),
  );
  const furnished = doc.furnished === true || advert.furnished === true;

  // Native coordinates: property-level locations {lat, lon} first, city
  // centroid as fallback — either way Fredy's map needs ZERO geocoding.
  const geo = doc.locations ?? doc.city?.location ?? null;
  const geoLat = num(geo?.lat);
  const geoLon = num(geo?.lon);
  const hasGeo = geoLat != null && geoLon != null;

  const adEvent = isEvent ? (payload.adEvent ?? {}) : null;
  const oldPrice = adEvent ? normPrice(adEvent.fieldOldValue) : null;
  const newPrice = adEvent ? normPrice(adEvent.fieldNewValue) : null;
  const pctRaw = adEvent ? Number(adEvent.percentVariation) : null;
  const pctVariation = pctRaw != null && Number.isFinite(pctRaw) ? pctRaw : null;

  // v3 A9: canonical event identity — a webhook retry of the SAME event maps to
  // the identical key; a later distinct drop (new event timestamp) re-notifies.
  const dedupKey = isEvent ? `se:${externalId}:price:${eventAtMs}:${oldPrice}->${newPrice}` : `se:${externalId}`;

  const title =
    (typeof doc.title === 'string' && doc.title !== '' ? doc.title : null) ??
    (typeof advert.title === 'string' && advert.title !== '' ? advert.title : null);
  const link = typeof advert.url === 'string' && advert.url !== '' ? advert.url : null;
  const description =
    (typeof doc.description === 'string' && doc.description !== '' ? doc.description : null) ??
    (typeof advert.description === 'string' && advert.description !== '' ? advert.description : null);

  // Street-level geocoding hint: the payload has NO structured street/address
  // field (0/5 real captures, none in the documented shape), so extract a
  // street from title+description text, postcode-paired. geocodeListing's BAN
  // type+score gate validates it — a garbage extraction just falls back to the
  // native coordinates above.
  const street = zipcode != null ? extractStreet(`${title ?? ''} ${description ?? ''}`) : null;
  const geocodeHint = street != null ? `${street} ${zipcode}` : null;

  const ph = {
    dedupKey,
    kind: isEvent ? 'price_drop' : 'match',
    externalId,
    priceHc,
    charges,
    priceCc,
    surface,
    rooms,
    zipcode,
    city,
    quartier: null,
    phone,
    photoUrls,
    createdAtMs: eventAtMs,
    oldPrice,
    newPrice,
    pctVariation,
    furnished,
    score: scoreListing({ priceHc, surface, zipcode, text: `${title ?? ''} ${description ?? ''}` }),
  };

  return {
    id: dedupKey,
    link,
    title,
    price: priceHc ?? priceCc,
    size: surface,
    rooms,
    address: [zipcode, city].filter(Boolean).join(' ') || null,
    latitude: hasGeo ? geoLat : null,
    longitude: hasGeo ? geoLon : null,
    geocodeHint,
    image: photoUrls[0] ?? null,
    description,
    ph,
  };
};

/**
 * Fail-closed hard filters (v2 #9). Returns the decision string when the
 * listing must NOT notify, or null when it passes.
 *
 * @param {ParsedListing & { ph: object }} listing
 * @returns {string|null}
 */
const decideFilter = (listing) => {
  const ph = listing.ph;
  if (ph == null) {
    return 'quarantine:ph';
  }
  const term = findExclusion(`${listing.title ?? ''} ${listing.description ?? ''}`);
  if (term != null) {
    return `excluded:${term}`;
  }
  // Structured furnished flag rejects independently of the regex.
  if (ph.furnished === true) {
    return 'excluded:furnished';
  }
  if (ph.zipcode == null || !PH.zips.includes(ph.zipcode)) {
    return 'excluded:zip';
  }
  if (!Number.isFinite(ph.priceHc)) {
    return 'quarantine:price';
  }
  if (!Number.isFinite(ph.rooms)) {
    return 'quarantine:rooms';
  }
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

/** Small ownership-checked completion tx for non-candidate decisions. */
const completeOwnedRow = (rowId, decision, error = null) => {
  return SqliteConnection.withTransaction((db) => {
    const changes = completeInbox(rowId, decision, { db, error });
    if (changes === 0) {
      throw new LostLeaseError();
    }
    return decision;
  });
};

/**
 * Stable raw-delivery ledger key for rows that cannot be timestamp-keyed. The
 * match identity keeps unrelated listings separate; the exact raw hash lets a
 * replay whose event_at is later repaired recognize the prior suppression.
 */
const rawPayloadLedgerKey = (row, payload) => {
  const match = row.kind === 'event' ? payload.match : payload;
  const matchId =
    (typeof match?.['@id'] === 'string' && match['@id'] !== '' ? match['@id'] : null) ??
    row.external_id ??
    'unknown-match';
  const payloadHash = crypto.createHash('sha256').update(row.payload).digest('hex');
  return `se:raw:${matchId}:${payloadHash}`;
};

/** Atomic seen-ledger insert + ownership-CAS completion. */
const completeOwnedRowWithSeen = (rowId, seenKey, decision) => {
  return SqliteConnection.withTransaction((db) => {
    const owner = db.prepare('SELECT lease_id, done_at FROM stream_estate_inbox WHERE id = @id').get({ id: rowId });
    if (owner == null || owner.done_at != null || owner.lease_id !== bootId) {
      throw new LostLeaseError();
    }
    db.prepare('INSERT OR IGNORE INTO ph_seen (dedup_key, first_seen_at) VALUES (@key, @now)').run({
      key: seenKey,
      now: Date.now(),
    });
    const changes = completeInbox(rowId, decision, { db });
    if (changes === 0) {
      throw new LostLeaseError();
    }
    return decision;
  });
};

/**
 * Decides one inbox row. Returns { decision, raw } where raw is non-null for
 * rows Fredy should keep showing in the UI (outboxed + suppressed:*).
 * Throws for per-row failures (handled by the caller's A8 try/catch).
 */
const processRow = (row, gate) => {
  let payload;
  try {
    payload = JSON.parse(row.payload);
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new RowDataError('invalid-payload', 'payload is not a JSON object');
    }
  } catch (error) {
    // Unparseable JSON → dead-letter immediately, retries are pointless (A8).
    throw error instanceof RowDataError ? error : new RowDataError('SyntaxError', error.message);
  }

  const eventAt = Number.isInteger(row.event_at) ? row.event_at : null;
  const payloadLedgerKey = rawPayloadLedgerKey(row, payload);
  if (eventAt == null) {
    // v3 A4: a payload we cannot place in time never notifies.
    logger.warn(`paris-hunter provider: inbox row ${row.id} has no valid event_at — suppressed:invalid-timestamp.`);
    return {
      decision: completeOwnedRowWithSeen(row.id, payloadLedgerKey, 'suppressed:invalid-timestamp'),
      raw: null,
    };
  }

  if (row.kind === 'event') {
    const adEvent = payload.adEvent;
    const pct = Number(adEvent?.percentVariation);
    if (adEvent?.fieldName !== 'price' || !(pct < 0)) {
      return { decision: completeOwnedRow(row.id, 'skip:price_increase'), raw: null };
    }
  }

  const candidate = phNormalize(row.kind, payload, eventAt);
  const filterDecision = decideFilter(candidate);

  const decision = SqliteConnection.withTransaction((db) => {
    // v3 A2: the row-tx STARTS with an ownership check…
    const owner = db.prepare('SELECT lease_id, done_at FROM stream_estate_inbox WHERE id = @id').get({ id: row.id });
    if (owner == null || owner.done_at != null || owner.lease_id !== bootId) {
      throw new LostLeaseError();
    }

    const rawSuppressed =
      db.prepare('SELECT 1 FROM ph_seen WHERE dedup_key = @key').get({ key: payloadLedgerKey }) != null;
    const seen = rawSuppressed
      ? { changes: 0 }
      : db
          .prepare('INSERT OR IGNORE INTO ph_seen (dedup_key, first_seen_at) VALUES (@key, @now)')
          .run({ key: candidate.ph.dedupKey, now: Date.now() });
    const isNew = seen.changes === 1;

    let rowDecision;
    if (!isNew) {
      rowDecision = 'duplicate';
    } else if (filterDecision != null) {
      rowDecision = filterDecision;
    } else if (
      gate.watermark == null ||
      gate.searchId == null ||
      gate.watermark.searchId !== gate.searchId ||
      gate.watermark.configRev !== gate.configRev
    ) {
      // v3 A5: a watermark minted for another search/config never authorizes.
      rowDecision = 'suppressed:unseeded';
    } else if (eventAt <= gate.watermark.cutoffMs) {
      rowDecision = 'suppressed:watermark';
    } else {
      db.prepare(
        `INSERT OR IGNORE INTO convos_outbox (id, dedup_key, kind, text, image_url, created_at)
         VALUES (@id, @dedupKey, @kind, @text, @imageUrl, @createdAt)`,
      ).run({
        id: candidate.ph.dedupKey,
        dedupKey: candidate.ph.dedupKey,
        kind: candidate.ph.kind,
        text: buildMessage(candidate),
        imageUrl: candidate.ph.photoUrls[0] ?? null,
        createdAt: Date.now(),
      });
      rowDecision = 'outboxed';
    }

    // …and ENDS with the CAS completion; 0 changes → rollback everything.
    const changes = completeInbox(row.id, rowDecision, { db });
    if (changes === 0) {
      throw new LostLeaseError();
    }
    return rowDecision;
  });

  if (decision === 'suppressed:unseeded') {
    logger.error(
      `paris-hunter provider: row ${row.id} suppressed:unseeded — no valid watermark for the current search/config. Run seed.js then bootstrap.js --enable-notifications.`,
    );
  }

  const returnable = decision === 'outboxed' || decision.startsWith('suppressed:');
  return { decision, raw: returnable ? { kind: row.kind, payload, eventAt } : null };
};

/** v3 A8: per-row failure bookkeeping — attempts + dead-letter at 5. */
const handleRowFailure = (row, error) => {
  if (error instanceof LostLeaseError) {
    logger.debug(`paris-hunter provider: row ${row.id} lease lost — current owner will decide it.`);
    return;
  }
  const errClass = error instanceof RowDataError ? error.errClass : (error.name ?? 'Error');
  if (error instanceof RowDataError) {
    try {
      completeOwnedRow(row.id, `dead-letter:${errClass}`, error.message);
      logger.error(`paris-hunter provider: row ${row.id} dead-lettered immediately (${errClass}): ${error.message}`);
    } catch {
      logger.debug(`paris-hunter provider: row ${row.id} lease lost while dead-lettering.`);
    }
    return;
  }
  const attempts = bumpAttempts(row.id);
  if (attempts == null) {
    logger.debug(`paris-hunter provider: row ${row.id} lease lost during failure handling.`);
    return;
  }
  if (attempts >= MAX_ROW_ATTEMPTS) {
    try {
      completeOwnedRow(row.id, `dead-letter:${errClass}`, error.message);
      logger.error(
        `paris-hunter provider: row ${row.id} dead-lettered after ${attempts} attempts (${errClass}): ${error.message}`,
      );
    } catch {
      logger.debug(`paris-hunter provider: row ${row.id} lease lost while dead-lettering.`);
    }
    return;
  }
  releaseRow(row.id);
  logger.warn(
    `paris-hunter provider: row ${row.id} failed (attempt ${attempts}/${MAX_ROW_ATTEMPTS}, ${errClass}): ${error.message} — released for retry.`,
  );
};

/**
 * Drains the inbox until empty (v3 A3) under boot-owned leases (v3 A2). The
 * job URL is ignored — the inbox is the source.
 *
 * @returns {Promise<Array<object>>} raw payloads for rows decided outboxed/suppressed:*
 */
async function getListings() {
  const gate = {
    watermark: parseWatermark(getParisHunterMeta('notifyWatermark')),
    searchId: getParisHunterMeta('searchId'),
    configRev: currentConfigRev(),
  };

  const returned = [];
  let outboxedCount = 0;
  let iterations = 0;
  try {
    for (;;) {
      const rows = claimInbox(CLAIM_BATCH);
      if (rows.length === 0) {
        break;
      }
      failpoint('after_claim');
      iterations += 1;
      if (iterations > MAX_DRAIN_ITERATIONS) {
        logger.warn(
          `paris-hunter provider: drain safety valve hit (${MAX_DRAIN_ITERATIONS} iterations) — stopping; the watchdog picks up the rest.`,
        );
        break;
      }
      let claimTime = Date.now();
      for (const row of rows) {
        if (Date.now() - claimTime > LEASE_RENEW_AFTER_MS) {
          renewLeases();
          claimTime = Date.now();
        }
        try {
          const outcome = processRow(row, gate);
          if (outcome.raw != null) {
            returned.push(outcome.raw);
          }
          if (outcome.decision === 'outboxed') {
            outboxedCount += 1;
          }
          failpoint('after_decision_tx');
        } catch (error) {
          handleRowFailure(row, error);
        }
      }
    }
  } finally {
    // v3 A2: orderly release — undecided claims become immediately claimable.
    releaseLeases();
  }

  if (outboxedCount > 0) {
    try {
      bus.emit('convos:flush');
    } catch (error) {
      logger.warn(`paris-hunter provider: convos:flush emit failed — ${error.message}`);
    }
  }
  return returned;
}

/**
 * @param {any} raw { kind, payload, eventAt } as returned by getListings
 * @returns {ParsedListing}
 */
function normalize(raw) {
  try {
    return phNormalize(raw.kind, raw.payload, raw.eventAt);
  } catch {
    // Defensive: Fredy's _filter drops null-id rows; the durable decision
    // already happened in getListings.
    return { id: null, link: null, title: null };
  }
}

/**
 * @param {ParsedListing} listing
 * @returns {boolean}
 */
function filter(listing) {
  return decideFilter(listing) == null;
}

/** @type {ProviderConfig} */
export const config = {
  url: null, // set by init(); getListings ignores it (inbox is the source)
  requiredFieldNames: ['id', 'link', 'title'],
  normalize,
  filter,
  getListings, // presence ⇒ Fredy never launches a browser
};

export const init = (sourceConfig, blacklist) => {
  config.enabled = sourceConfig?.enabled ?? true;
  config.url = sourceConfig?.url ?? 'inbox://stream-estate';
  appliedBlacklist = blacklist ?? [];
};

export const metaInformation = {
  name: 'Stream Estate',
  baseUrl: 'https://api.stream.estate/',
  id: 'streamEstate',
};

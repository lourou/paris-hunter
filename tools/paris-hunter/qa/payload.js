/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/* eslint-disable no-console */

/**
 * paris-hunter QA: webhook payload builder (lane 6).
 *
 * Produces a Stream Estate webhook body for fire-webhook.sh / live-qa.sh:
 *   node tools/paris-hunter/qa/payload.js <fixture-name> [options]
 *
 * Source of truth: lane 2's committed fixtures in test/mocks/streamEstate/<name>.json.
 * When a fixture file is missing (lane 2 not landed) pass --synth to generate a
 * payload from the built-in template below (shape mirrors the documented webhook
 * example — docs mirror api-reference_endpoint_webhooks_send.md). Synthetic payloads
 * are for plumbing/failpoint/live-QA runs ONLY; the committed fixtures remain the
 * normative behavior spec for offline vitest suites.
 *
 * Options:
 *   --synth                 allow synthesis when the fixture file is missing
 *   --out <file>            write body JSON to file (default: stdout)
 *   --emit-shell            print eval-able KIND=/EXTERNAL_ID=/DEDUP_KEY= lines (with --out)
 *   --fresh                 random external id + createdAt now (unique per run)
 *   --external-id <uuid>    force the property uuid everywhere it appears
 *   --created-at <now|ISO>  force match.createdAt (+ adEvent.createdAt for events)
 *   --inject-term <term>    append an exclusion term to title + description (AC4 per-term arms)
 *   --price <n>             set advert+document price (CC)
 *   --price-hc <n>          set priceExcludingFees
 *   --rooms <n|null>        set propertyDocument.room
 *   --zip <zipcode>         set city zipcode
 *   --new-price <n>         price-drop events: fieldNewValue (drives the dedup key)
 *   --photo <url>           override first picture URL (live QA needs a fetchable public image)
 *
 * Exit codes: 0 ok · 2 fixture missing and no --synth · 3 usage error.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const EXIT_NOT_READY = 2;
const EXIT_USAGE = 3;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_DIR = path.join(repoRoot, 'test', 'mocks', 'streamEstate');

const KNOWN_FIXTURES = [
  'match',
  'event-price-drop',
  'event-price-increase',
  'match-meuble',
  'match-non-meuble',
  'match-furnished-true',
  'match-out-of-band',
  'match-missing-rooms',
  'match-missing-price',
  // QA-extra (synth only, no committed fixture): hostile shape, fail-closed probe.
  'match-unknown-shape',
];

const uuid = () => crypto.randomUUID();

/**
 * Baseline synthetic match object (the /match webhook posts the Match object itself).
 * Values sit INSIDE the paris-hunter band: zip 75011, HC 2700 (band 2500-3100),
 * rooms 3 (band 3-4), unfurnished — so the baseline flows through to a notification.
 */
const synthMatch = (externalId, createdAt) => ({
  '@context': '/contexts/Match',
  '@id': `/matches/${uuid()}`,
  '@type': 'Match',
  property: `/properties/${externalId}`,
  search: '/searches/qa-search',
  createdAt,
  updatedAt: createdAt,
  propertyDocument: {
    '@context': '/contexts/PropertyDocument',
    '@id': `/documents/properties/${externalId}`,
    '@type': 'PropertyDocument',
    uuid: externalId,
    title: 'Appartement 3 pièces 72 m² — Paris 11e (QA synthetic)',
    description:
      'Bel appartement 3 pièces lumineux au coeur du 11e, parquet massif, cuisine équipée, proche métro. ' +
      '[QA SYNTHETIC PAYLOAD — paris-hunter harness]',
    price: 2850,
    pricePerMeter: 39.58,
    surface: 72,
    room: 3,
    bedroom: 2,
    furnished: false,
    elevator: true,
    floor: 3,
    expired: false,
    transactionType: 1,
    propertyType: 0,
    createdAt,
    updatedAt: createdAt,
    lastCrawledAt: createdAt,
    city: {
      id: 30943,
      name: 'Paris 11e',
      originalName: 'Paris 11e',
      zipcode: '75011',
      insee: '75111',
      department: { code: '75', id: 77, name: 'Paris' },
      region: { code: '11', id: 7, name: 'Île-de-France' },
      country: { code: '250', id: 2, name: 'France' },
      location: { lat: 48.8583, lon: 2.3802 },
    },
    locations: { lat: 48.8583, lon: 2.3802 },
    pictures: ['https://picsum.photos/seed/paris-hunter-qa/1600/1067'],
    adverts: [
      {
        uuid: uuid(),
        title: 'Appartement 3 pièces 72 m² — Paris 11e (QA synthetic)',
        description:
          'Bel appartement 3 pièces lumineux au coeur du 11e, parquet massif, cuisine équipée, proche métro. ' +
          '[QA SYNTHETIC PAYLOAD — paris-hunter harness]',
        price: 2850,
        priceExcludingFees: 2700,
        rentalCharges: 150,
        renterFees: 0,
        surface: 72,
        furnished: false,
        elevator: true,
        floor: 3,
        createdAt,
        updatedAt: createdAt,
        lastCrawledAt: createdAt,
        url: `https://example.org/qa/annonce/${externalId}`,
        pictures: ['https://picsum.photos/seed/paris-hunter-qa/1600/1067'],
        contact: { agency: 'QA Agence', name: 'QA Contact', phone: '0612345678', reference: 'QA-1' },
        publisher: { category: 'Portails', name: 'QA Portal', type: 1 },
        events: [],
      },
    ],
  },
});

const synthEvent = (externalId, createdAt, { oldPrice, newPrice }) => {
  const variation = ((newPrice - oldPrice) / oldPrice) * 100;
  return {
    event: 'ad.update.price',
    adEvent: {
      fieldName: 'price',
      fieldOldValue: String(oldPrice),
      fieldNewValue: String(newPrice),
      percentVariation: variation.toFixed(2),
      createdAt,
    },
    match: synthMatch(externalId, createdAt),
  };
};

/** Builds one of the named synthetic variants from the baseline. */
const synthesize = (name, externalId, createdAt) => {
  switch (name) {
    case 'match':
      return synthMatch(externalId, createdAt);
    case 'match-meuble': {
      // Regex arm: text says "meublé", structured flag stays false.
      const m = synthMatch(externalId, createdAt);
      m.propertyDocument.title = 'Appartement 3 pièces meublé — Paris 11e (QA synthetic)';
      m.propertyDocument.description = `Bel appartement meublé, tout équipé. ${m.propertyDocument.description}`;
      m.propertyDocument.adverts[0].title = m.propertyDocument.title;
      m.propertyDocument.adverts[0].description = m.propertyDocument.description;
      return m;
    }
    case 'match-non-meuble': {
      // Negation counter-case: MUST notify.
      const m = synthMatch(externalId, createdAt);
      m.propertyDocument.description = `Appartement non meublé, libre immédiatement. ${m.propertyDocument.description}`;
      m.propertyDocument.adverts[0].description = m.propertyDocument.description;
      return m;
    }
    case 'match-furnished-true': {
      // Structured arm (#9): furnished === true, text clean — fail-closed independent of regex.
      const m = synthMatch(externalId, createdAt);
      m.propertyDocument.furnished = true;
      m.propertyDocument.adverts[0].furnished = true;
      return m;
    }
    case 'match-out-of-band': {
      // HC 3600 — above budgetHcMax 3100. Rooms/zip stay valid so the price arm decides.
      const m = synthMatch(externalId, createdAt);
      m.propertyDocument.price = 3750;
      m.propertyDocument.adverts[0].price = 3750;
      m.propertyDocument.adverts[0].priceExcludingFees = 3600;
      return m;
    }
    case 'match-missing-rooms': {
      // Quarantine arm: rooms underivable.
      const m = synthMatch(externalId, createdAt);
      m.propertyDocument.room = null;
      m.propertyDocument.bedroom = null;
      return m;
    }
    case 'match-missing-price': {
      // Quarantine arm: priceHc underivable.
      const m = synthMatch(externalId, createdAt);
      m.propertyDocument.price = null;
      m.propertyDocument.pricePerMeter = null;
      m.propertyDocument.adverts[0].price = null;
      m.propertyDocument.adverts[0].priceExcludingFees = null;
      m.propertyDocument.adverts[0].rentalCharges = null;
      return m;
    }
    case 'match-unknown-shape': {
      // Hostile/unknown-fields probe: extra junk + core keys stripped. MUST fail closed
      // (quarantine/excluded decision, never a notification, never a crash).
      const m = synthMatch(externalId, createdAt);
      delete m.propertyDocument.city;
      delete m.propertyDocument.adverts;
      m.propertyDocument.room = undefined;
      m.propertyDocument.qaUnknownField = { nested: ['garbage', 42, null] };
      m.qaUnknownTopLevel = 'ignore-me';
      return m;
    }
    case 'event-price-drop':
      return synthEvent(externalId, createdAt, { oldPrice: 2700, newPrice: 2550 });
    case 'event-price-increase':
      return synthEvent(externalId, createdAt, { oldPrice: 2700, newPrice: 2800 });
    default:
      return null;
  }
};

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const fixtureName = args[0];
if (!fixtureName || fixtureName.startsWith('--')) {
  console.error(`usage: payload.js <${KNOWN_FIXTURES.join('|')}> [options] (see file header)`);
  process.exit(EXIT_USAGE);
}

const opt = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const flag = (name) => args.includes(name);

const kind = opt('--kind') ?? (fixtureName.startsWith('event') ? 'event' : 'match');
let externalId = opt('--external-id');
let createdAt = opt('--created-at');
if (flag('--fresh')) {
  externalId = externalId ?? uuid();
  createdAt = createdAt ?? 'now';
}
if (createdAt === 'now') createdAt = new Date().toISOString();

let body;
const fixturePath = path.join(FIXTURE_DIR, `${fixtureName}.json`);
if (fs.existsSync(fixturePath)) {
  body = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
} else if (flag('--synth')) {
  body = synthesize(fixtureName, externalId ?? uuid(), createdAt ?? new Date().toISOString());
  if (body == null) {
    console.error(`unknown fixture '${fixtureName}' — known: ${KNOWN_FIXTURES.join(', ')}`);
    process.exit(EXIT_USAGE);
  }
} else {
  console.error(
    `NOT READY: fixture ${fixturePath} missing (lane 2 owns test/mocks/streamEstate/). ` +
      'Pass --synth for a synthetic payload (plumbing/failpoint/live QA only).',
  );
  process.exit(EXIT_NOT_READY);
}

// --- mutations (apply to fixture-loaded bodies too) -------------------------
const matchObj = body.match ?? body;
const doc = matchObj.propertyDocument ?? {};

if (externalId != null) {
  matchObj.property = `/properties/${externalId}`;
  if (doc['@id'] != null) doc['@id'] = `/documents/properties/${externalId}`;
  if ('uuid' in doc) doc.uuid = externalId;
  if (Array.isArray(doc.adverts) && doc.adverts[0]?.url != null) {
    doc.adverts[0].url = `https://example.org/qa/annonce/${externalId}`;
  }
}
if (createdAt != null) {
  matchObj.createdAt = createdAt;
  if (body.adEvent != null) body.adEvent.createdAt = createdAt;
}
const term = opt('--inject-term');
if (term != null) {
  doc.title = `${doc.title ?? ''} ${term}`.trim();
  doc.description = `${doc.description ?? ''} ${term}`.trim();
  if (Array.isArray(doc.adverts) && doc.adverts[0] != null) {
    doc.adverts[0].title = doc.title;
    doc.adverts[0].description = doc.description;
  }
}
if (opt('--price') != null) {
  doc.price = Number(opt('--price'));
  if (Array.isArray(doc.adverts) && doc.adverts[0] != null) doc.adverts[0].price = doc.price;
}
if (opt('--price-hc') != null && Array.isArray(doc.adverts) && doc.adverts[0] != null) {
  doc.adverts[0].priceExcludingFees = Number(opt('--price-hc'));
}
if (opt('--rooms') != null) {
  doc.room = opt('--rooms') === 'null' ? null : Number(opt('--rooms'));
}
if (opt('--zip') != null && doc.city != null) {
  doc.city.zipcode = opt('--zip');
}
if (opt('--new-price') != null && body.adEvent != null) {
  body.adEvent.fieldNewValue = String(opt('--new-price'));
}
if (opt('--photo') != null) {
  if (Array.isArray(doc.pictures)) doc.pictures = [opt('--photo')];
  if (Array.isArray(doc.adverts) && doc.adverts[0] != null) doc.adverts[0].pictures = [opt('--photo')];
}

// --- output -----------------------------------------------------------------
const resolvedExternalId = (matchObj.property ?? doc['@id'] ?? doc.uuid ?? '').split('/').filter(Boolean).pop() ?? '';
// Dedup key rules: v2 shared contract 2 (match) + v3 addendum A9 (price events).
// Mirror of db.js deriveDedupKey — kept inline so payload.js stays DB-free.
let dedupKey = `se:${resolvedExternalId}`;
if (kind === 'event' && body.adEvent != null) {
  const eventAtMs = Date.parse(body.adEvent.createdAt ?? '') || 0;
  const oldNorm = Math.round(Number(body.adEvent.fieldOldValue));
  const newNorm = Math.round(Number(body.adEvent.fieldNewValue));
  dedupKey = `se:${resolvedExternalId}:price:${eventAtMs}:${oldNorm}->${newNorm}`;
}

const json = JSON.stringify(body, null, 2);
const outFile = opt('--out');
if (outFile != null) {
  fs.writeFileSync(outFile, json);
  if (flag('--emit-shell')) {
    console.log(`KIND=${kind}`);
    console.log(`EXTERNAL_ID=${resolvedExternalId}`);
    console.log(`DEDUP_KEY='${dedupKey}'`);
    console.log(`BODY_FILE='${outFile}'`);
  }
} else {
  console.log(json);
}

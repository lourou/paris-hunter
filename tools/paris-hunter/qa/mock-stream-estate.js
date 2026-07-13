/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/* eslint-disable no-console */

/**
 * paris-hunter QA: minimal stateful Stream Estate API mock (lane 6).
 *
 * Purpose: the budget auto-disable drill (v2 #13, v3 A7) — budget.js must PUT
 * `notificationEnabled:false` on the canonical search and GET-verify it before
 * clearing `disable_required`. This mock records every request and serves a
 * mutable search object so the GET-verify loop can be observed end to end.
 *
 * usage: node tools/paris-hunter/qa/mock-stream-estate.js
 *          [--port 8998] [--documents 450] [--delay-ms 0] [--legacy-overlap]
 *   GET  /searches            -> hydra collection with the one QA search
 *   GET  /searches/<id>       -> the QA search
 *   PUT  /searches/<id>       -> merges body into the search (records notificationEnabled)
 *   POST /searches            -> creates the QA search
 *   GET  /documents/properties -> billable-endpoint emulation (see below)
 *   GET  /__requests          -> QA introspection: every recorded request (method, url, body)
 *   POST /__reset             -> clears state
 *
 * /documents/properties serves the vendor-canonical Hydra pagination
 * (confirmed in writing by Stream Estate support, 2026-07-13; envelope shape
 * per the docs mirror of GET /documents/properties): `page` + `itemsPerPage`
 * (max 30) slices with a JSON-LD `hydra:view` object carrying root-relative
 * `hydra:first`/`hydra:last`/`hydra:next` links — `hydra:next` absent on the
 * final page. Following hydra:next delivers each document EXACTLY ONCE, the
 * contract seed.js's link walk (and per-delivered-item billing) relies on.
 * fromDate/toDate (inclusive, on createdAt) and order[createdAt] are honored.
 *
 * --legacy-overlap re-enables the REAL billing trap observed live on
 * 2026-07-11 (11,580 items billed for 450 uniques, −€133) for the billing
 * guard's regression test:
 *   - every response carries 58 items regardless of itemsPerPage (documented
 *     max is 30 — the live API ignored it);
 *   - page windows overlap heavily (start advances by 2 while 58 are
 *     returned → each item re-served ~25x) and hydra:next NEVER runs out —
 *     a compliant hydra walker would loop until its billing guard trips.
 * Dataset: --documents N (default 450) items, uuid qa-doc-<i>, createdAt
 * spread hourly from 2026-06-01T00:00:00Z. --delay-ms stalls every response
 * (QA for the silent-hang class).
 *
 * READ CONTRACT (mirrors the LIVE API, observed 2026-07-11 — see
 * test/services/paris-hunter/fixtures/stream-estate-search-echo.json): the
 * real Stream Estate API is NOT a faithful echo. Every read (GET single, GET
 * collection, POST/PUT response bodies):
 *   - drops `roomMax` / `bedroomMax` / `includedZipcodes` (write-only params),
 *   - resolves `includedZipcodes` to `includedCities`: City objects carrying a
 *     string `zipcode` (plus @id/@type/insee/name...).
 * This mock stores what was written but serializes reads the same way, so the
 * offline suite exercises the real divergence.
 *
 * DEPENDENCY (flagged to lane 2): the server under test must let QA point its
 * Stream Estate base URL here (e.g. STREAM_ESTATE_API_BASE env). Until that
 * override exists, the drill asserts only the offline-observable half (usage
 * counter, warn log, disable_required meta).
 */

import http from 'http';

const args = process.argv.slice(2);
const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 8998;
const documentCount = args.includes('--documents') ? Number(args[args.indexOf('--documents') + 1]) : 450;
const delayMs = args.includes('--delay-ms') ? Number(args[args.indexOf('--delay-ms') + 1]) : 0;
const legacyOverlap = args.includes('--legacy-overlap');

const MAX_ITEMS_PER_PAGE = 30; // documented max; requests above it are clamped
// Observed live page size in the 2026-07-11 incident (itemsPerPage ignored).
const LEGACY_PAGE_SIZE = 58;
// Legacy `page=N` overlap: the window start advances by 2 items per page
// while 58 items are returned → ~25x duplication, the 2026-07-11 incident.
const LEGACY_PAGE_STEP = 2;

const DOCUMENTS_EPOCH = Date.parse('2026-06-01T00:00:00.000Z');
const documents = Array.from({ length: documentCount }, (unused, i) => ({
  uuid: `qa-doc-${String(i).padStart(4, '0')}`,
  createdAt: new Date(DOCUMENTS_EPOCH + i * 3_600_000).toISOString(),
}));

/** Root-relative hydra link for `page`, preserving all other query params (API Platform shape). */
const hydraLink = (searchParams, page) => {
  const params = new URLSearchParams(searchParams);
  params.set('page', String(page));
  return `/documents/properties?${params.toString()}`;
};

const serveDocuments = (searchParams) => {
  const page = Math.max(1, Number(searchParams.get('page') ?? '1'));

  if (legacyOverlap) {
    // 2026-07-11 billing trap (behind --legacy-overlap): oversized
    // overlapping windows, and hydra:next NEVER runs out — the walker's
    // billing guard is the only thing that stops the burn.
    const start = (page - 1) * LEGACY_PAGE_STEP;
    const members = documents.slice(start, start + LEGACY_PAGE_SIZE);
    return {
      '@context': '/contexts/PropertyDocument',
      '@id': '/documents/properties',
      '@type': 'hydra:Collection',
      'hydra:member': members,
      'hydra:totalItems': documents.length,
      'hydra:view': {
        '@id': hydraLink(searchParams, page),
        '@type': 'hydra:PartialCollectionView',
        'hydra:first': hydraLink(searchParams, 1),
        ...(members.length > 0 ? { 'hydra:next': hydraLink(searchParams, page + 1) } : {}),
      },
    };
  }

  // Vendor-canonical mode: honest page/itemsPerPage slices, exact-once via
  // hydra:next (absent on the last page).
  const fromDate = searchParams.get('fromDate');
  const toDate = searchParams.get('toDate');
  const order = searchParams.get('order[createdAt]');
  const requested = Number(searchParams.get('itemsPerPage') ?? '10');
  const itemsPerPage = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 10, MAX_ITEMS_PER_PAGE);

  const fromMs = fromDate != null ? Date.parse(fromDate) : -Infinity;
  const toMs = toDate != null ? Date.parse(toDate) : Infinity;
  const filtered = documents.filter((d) => {
    const ms = Date.parse(d.createdAt);
    return ms >= fromMs && ms <= toMs; // both bounds inclusive, per the live docs
  });
  filtered.sort((a, b) => (order === 'desc' ? -1 : 1) * (Date.parse(a.createdAt) - Date.parse(b.createdAt)));

  const lastPage = Math.max(1, Math.ceil(filtered.length / itemsPerPage));
  return {
    '@context': '/contexts/PropertyDocument',
    '@id': '/documents/properties',
    '@type': 'hydra:Collection',
    'hydra:member': filtered.slice((page - 1) * itemsPerPage, page * itemsPerPage),
    'hydra:totalItems': filtered.length,
    'hydra:view': {
      '@id': hydraLink(searchParams, page),
      '@type': 'hydra:PartialCollectionView',
      'hydra:first': hydraLink(searchParams, 1),
      'hydra:last': hydraLink(searchParams, lastPage),
      ...(page < lastPage ? { 'hydra:next': hydraLink(searchParams, page + 1) } : {}),
    },
  };
};

let requests = [];
// Stored in WRITE shape (may hold includedZipcodes/roomMax); reads serialize.
let search = {
  '@id': '/searches/qa-search',
  '@type': 'Search',
  title: '[ph:v1] paris-hunter 11e-12e 3-4p unfurnished',
  notificationEnabled: true,
  token: 'qa-token',
  createdAt: new Date().toISOString(),
};

/** Fake City resolution for a zipcode (real shape, QA values). */
const cityFor = (zip) => ({
  '@id': `/cities/qa-${zip}`,
  '@type': 'City',
  zipcode: String(zip),
  insee: `751${String(zip).slice(-2)}`,
  article: '',
  name: `Paris ${Number(String(zip).slice(-2))}e`,
  libelle: 'PARIS',
});

/** Real read contract: strip write-only params, resolve zipcodes to cities. */
const serializeSearch = (stored) => {
  const { roomMax, bedroomMax, includedZipcodes, ...rest } = stored; // eslint-disable-line no-unused-vars
  const includedCities = includedZipcodes != null ? includedZipcodes.map(cityFor) : (rest.includedCities ?? []);
  return { ...rest, includedCities };
};

const readBody = (request) =>
  new Promise((resolve) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
    });
    request.on('end', () => resolve(data));
  });

const server = http.createServer(async (request, response) => {
  const body = await readBody(request);
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = { unparseable: body };
  }
  requests.push({ at: Date.now(), method: request.method, url: request.url, body: parsed });
  console.log(JSON.stringify({ method: request.method, url: request.url }));

  const send = (code, payload) => {
    const write = () => {
      response.writeHead(code, { 'Content-Type': 'application/ld+json' });
      response.end(JSON.stringify(payload));
    };
    if (delayMs > 0) {
      setTimeout(write, delayMs);
      return undefined;
    }
    return write();
  };

  if (request.url?.startsWith('/documents/properties') && request.method === 'GET') {
    const { searchParams } = new URL(request.url, 'http://mock');
    return send(200, serveDocuments(searchParams));
  }
  if (request.url === '/__requests') return send(200, requests);
  if (request.url === '/__reset' && request.method === 'POST') {
    requests = [];
    search.notificationEnabled = true;
    return send(200, { ok: true });
  }
  if (request.url?.startsWith('/searches')) {
    if (request.method === 'GET' && request.url === '/searches') {
      return send(200, { 'hydra:member': [serializeSearch(search)], 'hydra:totalItems': 1 });
    }
    if (request.method === 'GET') return send(200, serializeSearch(search));
    if (request.method === 'PUT') {
      search = { ...search, ...(parsed ?? {}) };
      return send(200, serializeSearch(search));
    }
    if (request.method === 'POST') {
      search = { ...search, ...(parsed ?? {}) };
      return send(201, serializeSearch(search));
    }
  }
  return send(404, { error: 'not found' });
});

server.listen(port, () => console.log(JSON.stringify({ event: 'ready', port })));

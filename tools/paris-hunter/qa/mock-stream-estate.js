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
 * usage: node tools/paris-hunter/qa/mock-stream-estate.js [--port 8998]
 *   GET  /searches            -> hydra collection with the one QA search
 *   GET  /searches/<id>       -> the QA search
 *   PUT  /searches/<id>       -> merges body into the search (records notificationEnabled)
 *   POST /searches            -> creates the QA search
 *   GET  /__requests          -> QA introspection: every recorded request (method, url, body)
 *   POST /__reset             -> clears state
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
    response.writeHead(code, { 'Content-Type': 'application/ld+json' });
    response.end(JSON.stringify(payload));
  };

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

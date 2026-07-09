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
 * DEPENDENCY (flagged to lane 2): the server under test must let QA point its
 * Stream Estate base URL here (e.g. STREAM_ESTATE_API_BASE env). Until that
 * override exists, the drill asserts only the offline-observable half (usage
 * counter, warn log, disable_required meta).
 */

import http from 'http';

const args = process.argv.slice(2);
const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 8998;

let requests = [];
let search = {
  '@id': '/searches/qa-search',
  '@type': 'Search',
  title: '[ph:v1] paris-hunter 11e-12e 3-4p unfurnished',
  notificationEnabled: true,
  token: 'qa-token',
  createdAt: new Date().toISOString(),
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
      return send(200, { 'hydra:member': [search], 'hydra:totalItems': 1 });
    }
    if (request.method === 'GET') return send(200, search);
    if (request.method === 'PUT') {
      search = { ...search, ...(parsed ?? {}) };
      return send(200, search);
    }
    if (request.method === 'POST') {
      search = { ...search, ...(parsed ?? {}) };
      return send(201, search);
    }
  }
  return send(404, { error: 'not found' });
});

server.listen(port, () => console.log(JSON.stringify({ event: 'ready', port })));

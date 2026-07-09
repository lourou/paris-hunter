/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import Fastify from 'fastify';
import { createMemorySqlite, mockSqliteConnection } from '../services/paris-hunter/memoryDb.js';

const SECRET = 'f'.repeat(48);
const holder = vi.hoisted(() => ({ current: null }));

vi.hoisted(() => {
  process.env.STREAM_ESTATE_WEBHOOK_SECRET = 'f'.repeat(48);
});

vi.mock('../../lib/services/storage/SqliteConnection.js', () => mockSqliteConnection(holder));
vi.mock('../../lib/services/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib/services/storage/jobStorage.js', () => ({
  getJobs: () => [{ id: 'job-se-1', provider: [{ id: 'streamEstate', url: 'inbox://stream-estate' }] }],
}));

import streamEstateWebhookPlugin from '../../lib/api/routes/streamEstateWebhookRoute.js';
import { bus } from '../../lib/services/events/event-bus.js';
import { toEpochMs, getParisHunterMeta } from '../../lib/services/paris-hunter/inbox.js';
import { usageKeyFor } from '../../lib/services/paris-hunter/budget.js';

const UUID1 = '11111111-1111-4111-8111-111111111111';
const fixture = (name) => JSON.parse(readFileSync(new URL(`../mocks/streamEstate/${name}`, import.meta.url), 'utf-8'));

const inboxRows = () => holder.current.query('SELECT * FROM stream_estate_inbox ORDER BY id');

let app;
let runOneEvents;
let runOneListener;

const buildApp = async () => {
  const fastify = Fastify();
  await fastify.register(streamEstateWebhookPlugin, { prefix: '/api/webhook' });
  await fastify.ready();
  return fastify;
};

const post = (kind, { secret = SECRET, payload } = {}) =>
  app.inject({
    method: 'POST',
    url: `/api/webhook/stream-estate/${secret}/${kind}`,
    payload: payload ?? fixture(kind === 'match' ? 'match.json' : 'event-price-drop.json'),
  });

beforeEach(async () => {
  holder.current = createMemorySqlite();
  runOneEvents = [];
  runOneListener = (event) => runOneEvents.push(event);
  bus.on('jobs:runOne', runOneListener);
  app = await buildApp();
});

afterEach(async () => {
  bus.off('jobs:runOne', runOneListener);
  await app.close();
});

const flushImmediates = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

describe('secret gate', () => {
  it('replies 404 on a wrong secret of the same length, without inserting', async () => {
    const res = await post('match', { secret: 'e'.repeat(48) });
    expect(res.statusCode).toBe(404);
    expect(inboxRows()).toHaveLength(0);
  });

  it('replies 404 on a wrong-length secret (no timingSafeEqual throw)', async () => {
    const res = await post('match', { secret: 'short' });
    expect(res.statusCode).toBe(404);
    expect(inboxRows()).toHaveLength(0);
  });
});

describe('POST /match', () => {
  it('acks 200 fast and lands a durable inbox row with ingress-normalized event_at (v3 A4)', async () => {
    const payload = fixture('match.json');
    const res = await post('match');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const rows = inboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('match');
    expect(rows[0].external_id).toBe(UUID1);
    expect(rows[0].event_at).toBe(toEpochMs(payload.createdAt));
    expect(JSON.parse(rows[0].payload).propertyDocument.uuid).toBe(UUID1);
    expect(rows[0].done_at).toBe(null);
  });

  it('stores event_at NULL for a malformed createdAt (suppressed downstream, still durable)', async () => {
    const payload = fixture('match.json');
    payload.createdAt = 'yesterday';
    const res = await post('match', { payload });
    expect(res.statusCode).toBe(200);
    expect(inboxRows()[0].event_at).toBe(null);
  });

  it('increments the usage counter in the same tx as the insert (v3 A7)', async () => {
    await post('match');
    await post('match');
    expect(getParisHunterMeta(usageKeyFor())).toBe('2');
  });

  it('rejects non-object JSON bodies with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhook/stream-estate/${SECRET}/match`,
      payload: 'null',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(inboxRows()).toHaveLength(0);
  });

  it('emits jobs:runOne AFTER the reply, targeting the streamEstate job', async () => {
    await post('match');
    await flushImmediates();
    expect(runOneEvents).toEqual([{ jobId: 'job-se-1' }]);
  });
});

describe('POST /event', () => {
  it('lands an event row keyed by adEvent.createdAt (v3 A4 ingress)', async () => {
    const payload = fixture('event-price-drop.json');
    const res = await post('event');

    expect(res.statusCode).toBe(200);
    const rows = inboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('event');
    expect(rows[0].external_id).toBe(UUID1);
    expect(rows[0].event_at).toBe(toEpochMs(payload.adEvent.createdAt));
  });
});

describe('GET /health (v3 A5 enablement probe)', () => {
  it('returns 200 with the correct secret and has no side effects', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/webhook/stream-estate/${SECRET}/health` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(inboxRows()).toHaveLength(0);
    expect(getParisHunterMeta(usageKeyFor())).toBe(null);
  });

  it('returns 404 with a wrong secret', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/webhook/stream-estate/${'e'.repeat(48)}/health` });
    expect(res.statusCode).toBe(404);
  });
});

describe('body limit', () => {
  it('rejects payloads above 5 MB with 413', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhook/stream-estate/${SECRET}/match`,
      payload: `{"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(413);
    expect(inboxRows()).toHaveLength(0);
  });
});

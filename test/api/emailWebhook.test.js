/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { createMemorySqlite, mockSqliteConnection } from '../services/paris-hunter/memoryDb.js';

const SECRET = 'f'.repeat(48);
const TOKEN = 'a'.repeat(40);
const RAW = 'From: annonces@alertes.seloger.com\r\nSubject: 1 nouvelle annonce : PH-main\r\n\r\n<html>...</html>';
const holder = vi.hoisted(() => ({ current: null }));

vi.hoisted(() => {
  process.env.EMAIL_WEBHOOK_SECRET = 'f'.repeat(48);
  process.env.PH_EMAIL_TOKEN = 'a'.repeat(40);
});

vi.mock('../../lib/services/storage/SqliteConnection.js', () => mockSqliteConnection(holder));
vi.mock('../../lib/services/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import emailWebhookPlugin from '../../lib/api/routes/emailWebhookRoute.js';

const inboxRows = () => holder.current.query('SELECT * FROM email_inbox ORDER BY id');

let app;

const buildApp = async () => {
  const fastify = Fastify();
  await fastify.register(emailWebhookPlugin, { prefix: '/api/webhook' });
  await fastify.ready();
  return fastify;
};

const post = ({ secret = SECRET, token = TOKEN, body = RAW } = {}) =>
  app.inject({
    method: 'POST',
    url: `/api/webhook/email/${secret}/alert`,
    headers: {
      'content-type': 'text/plain',
      ...(token != null ? { 'x-ph-email-token': token } : {}),
    },
    payload: body,
  });

beforeEach(async () => {
  holder.current = createMemorySqlite();
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('POST /email/:secret/alert', () => {
  it('stores raw MIME durably and replies 200 for valid credentials', async () => {
    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const rows = inboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('seloger');
    expect(rows[0].raw_mime).toBe(RAW);
    expect(rows[0].done_at).toBe(null);
  });

  it('replies 404 for a wrong same-length secret without inserting', async () => {
    const res = await post({ secret: 'e'.repeat(48) });
    expect(res.statusCode).toBe(404);
    expect(inboxRows()).toHaveLength(0);
  });

  it('replies 404 for a wrong-length secret without throwing or inserting', async () => {
    const res = await post({ secret: 'short' });
    expect(res.statusCode).toBe(404);
    expect(inboxRows()).toHaveLength(0);
  });

  it('replies 401 when the email token header is missing', async () => {
    const res = await post({ token: null });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false });
    expect(inboxRows()).toHaveLength(0);
  });

  it('replies 401 for a wrong email token', async () => {
    const res = await post({ token: 'b'.repeat(40) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false });
    expect(inboxRows()).toHaveLength(0);
  });

  it('replies 400 for an empty body with valid credentials', async () => {
    const res = await post({ body: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false });
    expect(inboxRows()).toHaveLength(0);
  });
});

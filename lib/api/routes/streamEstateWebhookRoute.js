/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: inbound webhook receiver for Stream Estate saved-search
 * deliveries (build plan v2 lane 2, v3 A4/A5).
 *
 * Routes (registered under prefix /api/webhook in lib/api/api.js):
 *   POST /api/webhook/stream-estate/:secret/match
 *   POST /api/webhook/stream-estate/:secret/event
 *   GET  /api/webhook/stream-estate/:secret/health   (v3 A5 — liveness probe
 *        for bootstrap --enable-notifications; same secret gate, no side effects)
 *
 * Contract: ack-fast. The inbox row IS the durable dirty flag — insert +
 * usage-count in one tx, reply 200, then emit 'jobs:runOne' post-reply. If the
 * emit is dropped (job already running) the watchdog re-emits within 15 s.
 * Payload timestamps are normalized to epoch ms AT INGRESS (v3 A4) into the
 * event_at column; nothing downstream re-parses timestamp strings.
 *
 * Security: no HMAC exists upstream — the unguessable secret path segment is
 * converted to bytes, compared by byte length, then timingSafeEqual (which
 * throws on unequal lengths); mismatch → 404. The secret is NEVER logged; log
 * lines use a redacted path. Payloads are UNTRUSTED.
 */

import crypto from 'node:crypto';
import logger from '../../services/logger.js';
import { bus } from '../../services/events/event-bus.js';
import { PH } from '../../services/paris-hunter/phConfig.js';
import { insertInbox, toEpochMs } from '../../services/paris-hunter/inbox.js';
import { failpoint } from '../../services/paris-hunter/failpoints.js';
import { getJobs } from '../../services/storage/jobStorage.js';

export const BODY_LIMIT = 512 * 1024;
const INGRESS_RATE_LIMIT = 120;
const INGRESS_WINDOW_MS = 60_000;
const REDACTED_PATH = '/api/webhook/stream-estate/<redacted>';

const timestampSchema = {
  anyOf: [{ type: 'string', minLength: 1, maxLength: 128 }, { type: 'number' }],
};
const boundedScalarSchema = {
  anyOf: [{ type: 'string', maxLength: 4096 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
};
const propertyDocumentSchema = {
  type: 'object',
  properties: {
    uuid: { type: 'string', minLength: 1, maxLength: 256 },
    title: { type: 'string', maxLength: 4096 },
    description: { type: 'string', maxLength: 65_536 },
    pictures: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 4096 } },
    adverts: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        properties: {
          url: { type: 'string', maxLength: 4096 },
          title: { type: 'string', maxLength: 4096 },
          description: { type: 'string', maxLength: 65_536 },
          pictures: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 4096 } },
        },
      },
    },
  },
};
const matchIdentitySchema = {
  type: 'object',
  properties: {
    '@id': { type: 'string', maxLength: 512 },
    property: { type: 'string', minLength: 1, maxLength: 512 },
    propertyDocument: propertyDocumentSchema,
  },
  anyOf: [
    { required: ['property'] },
    {
      required: ['propertyDocument'],
      properties: { propertyDocument: { ...propertyDocumentSchema, required: ['uuid'] } },
    },
  ],
};
const matchSchema = {
  ...matchIdentitySchema,
  required: ['createdAt'],
  properties: { ...matchIdentitySchema.properties, createdAt: timestampSchema },
};
const eventSchema = {
  type: 'object',
  required: ['event', 'adEvent', 'match'],
  properties: {
    event: { type: 'string', minLength: 1, maxLength: 256 },
    adEvent: {
      type: 'object',
      required: ['fieldName', 'fieldOldValue', 'fieldNewValue', 'percentVariation', 'createdAt'],
      properties: {
        fieldName: { type: 'string', minLength: 1, maxLength: 128 },
        fieldOldValue: boundedScalarSchema,
        fieldNewValue: boundedScalarSchema,
        percentVariation: boundedScalarSchema,
        createdAt: timestampSchema,
      },
    },
    match: matchIdentitySchema,
  },
};

const secretMatches = (candidate) => {
  const secret = PH.webhookSecret;
  if (typeof secret !== 'string' || secret.length === 0 || typeof candidate !== 'string') {
    return false;
  }
  const candidateBytes = Buffer.from(candidate);
  const secretBytes = Buffer.from(secret);
  if (candidateBytes.length !== secretBytes.length) {
    return false;
  }
  return crypto.timingSafeEqual(candidateBytes, secretBytes);
};

const payloadHasSafeBounds = (root) => {
  let nodes = 0;
  const visit = (value, depth) => {
    nodes += 1;
    if (nodes > 5000 || depth > 12) {
      return false;
    }
    if (typeof value === 'string') {
      return value.length <= 65_536;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
      return value.length <= 100 && value.every((entry) => visit(entry, depth + 1));
    }
    if (value != null && typeof value === 'object') {
      const entries = Object.entries(value);
      return entries.length <= 200 && entries.every(([key, entry]) => key.length <= 256 && visit(entry, depth + 1));
    }
    return value == null || typeof value === 'boolean';
  };
  return visit(root, 0);
};

const createIngressLimiter = (limit, windowMs) => {
  const clients = new Map();
  return (key, now = Date.now()) => {
    const boundedKey = clients.has(key) || clients.size < 1023 ? key : '<overflow>';
    let entry = clients.get(boundedKey);
    if (entry == null || now - entry.startedAt >= windowMs) {
      entry = { startedAt: now, count: 0 };
      clients.set(boundedKey, entry);
    }
    entry.count += 1;
    if (clients.size > 1024) {
      for (const [client, state] of clients) {
        if (now - state.startedAt >= windowMs) {
          clients.delete(client);
        }
      }
    }
    return {
      allowed: entry.count <= limit,
      retryAfter: Math.max(1, Math.ceil((entry.startedAt + windowMs - now) / 1000)),
    };
  };
};

/** '/properties/<uuid>' → '<uuid>' (defensive — payloads are untrusted). */
const uuidFromPropertyRef = (ref) => {
  if (typeof ref !== 'string') {
    return null;
  }
  const tail = ref.split('/').filter(Boolean).pop();
  return tail && tail.length > 0 ? tail : null;
};

let cachedJobId = null;

/**
 * Finds the job whose provider list contains streamEstate; falls back to the
 * fixed PH.jobId (bootstrap creates the job under that id). Cached.
 */
const findStreamEstateJobId = () => {
  if (cachedJobId != null) {
    return cachedJobId;
  }
  try {
    const jobs = getJobs({ includeDisabled: false });
    const hit = jobs.find((job) => Array.isArray(job.provider) && job.provider.some((p) => p?.id === 'streamEstate'));
    if (hit != null) {
      cachedJobId = hit.id;
      return cachedJobId;
    }
  } catch (error) {
    logger.debug(`paris-hunter webhook: job lookup failed (${error.message}) — falling back to '${PH.jobId}'.`);
  }
  return PH.jobId;
};

/** Post-reply trigger: never blocks or fails the response. */
const emitRunOne = () => {
  setImmediate(() => {
    try {
      bus.emit('jobs:runOne', { jobId: findStreamEstateJobId() });
    } catch (error) {
      logger.warn(`paris-hunter webhook: jobs:runOne emit failed — ${error.message}`);
    }
  });
};

const makeHandler = (kind, checkRateLimit) => async (request, reply) => {
  if (!secretMatches(request.params?.secret)) {
    logger.warn(`paris-hunter webhook: secret mismatch on POST ${REDACTED_PATH}/${kind}`);
    return reply.code(404).send();
  }
  const body = request.body;
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    logger.warn(`paris-hunter webhook: malformed ${kind} payload (not a JSON object) — rejected with 400.`);
    return reply.code(400).send({ ok: false });
  }
  if (!payloadHasSafeBounds(body)) {
    logger.warn(`paris-hunter webhook: out-of-bounds ${kind} payload rejected with 400.`);
    return reply.code(400).send({ ok: false });
  }
  const rate = checkRateLimit(request.ip);
  if (!rate.allowed) {
    logger.warn(`paris-hunter webhook: ingress rate limit exceeded on ${REDACTED_PATH}/${kind}.`);
    return reply.header('Retry-After', String(rate.retryAfter)).code(429).send({ ok: false });
  }

  // v3 A4: normalize the payload timestamp to epoch ms at ingress.
  // match payload: Match.createdAt · event payload: adEvent.createdAt
  const externalId =
    kind === 'match'
      ? (body.propertyDocument?.uuid ?? uuidFromPropertyRef(body.property))
      : (body.match?.propertyDocument?.uuid ?? uuidFromPropertyRef(body.match?.property));
  const eventAt = kind === 'match' ? toEpochMs(body.createdAt) : toEpochMs(body.adEvent?.createdAt);

  insertInbox({ kind, externalId, payload: JSON.stringify(body), eventAt });
  failpoint('after_inbox_insert');

  await reply.code(200).send({ ok: true });
  logger.debug(`paris-hunter webhook: accepted ${kind} delivery on ${REDACTED_PATH}/${kind}`);
  emitRunOne();
};

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function streamEstateWebhookPlugin(fastify, options = {}) {
  const checkRateLimit = createIngressLimiter(options.ingressRateLimit ?? INGRESS_RATE_LIMIT, INGRESS_WINDOW_MS);
  fastify.post(
    '/stream-estate/:secret/match',
    { bodyLimit: BODY_LIMIT, schema: { body: matchSchema } },
    makeHandler('match', checkRateLimit),
  );
  fastify.post(
    '/stream-estate/:secret/event',
    { bodyLimit: BODY_LIMIT, schema: { body: eventSchema } },
    makeHandler('event', checkRateLimit),
  );

  // v3 A5: receiver liveness probe used by bootstrap.js --enable-notifications.
  fastify.get('/stream-estate/:secret/health', async (request, reply) => {
    if (!secretMatches(request.params?.secret)) {
      return reply.code(404).send();
    }
    return reply.code(200).send({ ok: true });
  });
}

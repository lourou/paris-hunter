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
 * compared length-first then timingSafeEqual (it throws on unequal lengths);
 * mismatch → 404 (don't leak that the route exists). The secret is NEVER
 * logged; log lines use a redacted path. Payloads are UNTRUSTED.
 */

import crypto from 'node:crypto';
import logger from '../../services/logger.js';
import { bus } from '../../services/events/event-bus.js';
import { PH } from '../../services/paris-hunter/phConfig.js';
import { insertInbox, toEpochMs } from '../../services/paris-hunter/inbox.js';
import { failpoint } from '../../services/paris-hunter/failpoints.js';
import { getJobs } from '../../services/storage/jobStorage.js';

const BODY_LIMIT = 5 * 1024 * 1024;
const REDACTED_PATH = '/api/webhook/stream-estate/<redacted>';

const secretMatches = (candidate) => {
  const secret = PH.webhookSecret;
  if (typeof secret !== 'string' || secret.length === 0 || typeof candidate !== 'string') {
    return false;
  }
  if (candidate.length !== secret.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(secret));
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

const makeHandler = (kind) => async (request, reply) => {
  if (!secretMatches(request.params?.secret)) {
    logger.warn(`paris-hunter webhook: secret mismatch on POST ${REDACTED_PATH}/${kind}`);
    return reply.code(404).send();
  }
  const body = request.body;
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    logger.warn(`paris-hunter webhook: malformed ${kind} payload (not a JSON object) — rejected with 400.`);
    return reply.code(400).send({ ok: false });
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
export default async function streamEstateWebhookPlugin(fastify) {
  fastify.post('/stream-estate/:secret/match', { bodyLimit: BODY_LIMIT }, makeHandler('match'));
  fastify.post('/stream-estate/:secret/event', { bodyLimit: BODY_LIMIT }, makeHandler('event'));

  // v3 A5: receiver liveness probe used by bootstrap.js --enable-notifications.
  fastify.get('/stream-estate/:secret/health', async (request, reply) => {
    if (!secretMatches(request.params?.secret)) {
      return reply.code(404).send();
    }
    return reply.code(200).send({ ok: true });
  });
}

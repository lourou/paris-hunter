/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: inbound webhook receiver for Stream Estate saved-search deliveries.
 *
 * Routes (registered under prefix /api/webhook in lib/api/api.js):
 *   POST /api/webhook/stream-estate/:secret/match
 *   POST /api/webhook/stream-estate/:secret/event
 *
 * STUB — returns 501 until lane 2 lands the real handler:
 *   secret check (crypto.timingSafeEqual vs PH.webhookSecret, mismatch -> 404),
 *   minimal shape validation -> insertInbox(...) -> reply 200 fast ->
 *   bus.emit('jobs:runOne', { jobId }).
 * Payloads are UNTRUSTED (Stream Estate has no HMAC) — treat all fields defensively.
 */

const BODY_LIMIT = 5 * 1024 * 1024;

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function streamEstateWebhookPlugin(fastify) {
  fastify.post('/stream-estate/:secret/match', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    return reply.code(501).send({ error: 'not implemented' });
  });

  fastify.post('/stream-estate/:secret/event', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    return reply.code(501).send({ error: 'not implemented' });
  });
}

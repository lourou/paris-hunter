/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: inbound raw-email webhook receiver.
 *
 * The endpoint acknowledges only after the unparsed MIME has been stored in
 * the durable email inbox. Secrets, tokens, and MIME contents are never logged.
 */

import crypto from 'node:crypto';
import logger from '../../services/logger.js';
import { PH } from '../../services/paris-hunter/phConfig.js';
import { insertEmailInbox } from '../../services/paris-hunter/emailInbox.js';

export const BODY_LIMIT = 2 * 1024 * 1024;
const REDACTED_PATH = '/api/webhook/email/<redacted>';

/**
 * @param {unknown} candidate
 * @returns {boolean}
 */
const secretMatches = (candidate) => {
  const secret = PH.emailWebhookSecret;
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

/**
 * @param {unknown} candidate
 * @returns {boolean}
 */
const tokenMatches = (candidate) => {
  const token = PH.emailWebhookToken;
  if (typeof token !== 'string' || token.length === 0 || typeof candidate !== 'string') {
    return false;
  }
  const candidateBytes = Buffer.from(candidate);
  const tokenBytes = Buffer.from(token);
  if (candidateBytes.length !== tokenBytes.length) {
    return false;
  }
  return crypto.timingSafeEqual(candidateBytes, tokenBytes);
};

/**
 * @param {import('fastify').FastifyRequest} request
 * @param {string} body
 * @param {(error: Error|null, body?: string) => void} done
 * @returns {void}
 */
const parseRawBody = (request, body, done) => {
  void request;
  done(null, body);
};

/**
 * @param {Error & { statusCode?: number }} error
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @returns {void}
 */
const handleWebhookError = (error, request, reply) => {
  const status = error.statusCode ?? 500;
  logger.warn(
    `paris-hunter email webhook: ${request.method} ${REDACTED_PATH}/alert rejected with ${status} — ${error.message}`,
  );
  reply.code(status).send({ ok: false });
};

/**
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @returns {Promise<import('fastify').FastifyReply|void>}
 */
const handleEmailWebhook = async (request, reply) => {
  if (!secretMatches(request.params?.secret)) {
    logger.warn(`paris-hunter email webhook: secret mismatch on POST ${REDACTED_PATH}/alert`);
    return reply.code(404).send();
  }
  if (!tokenMatches(request.headers['x-ph-email-token'])) {
    // Uniform 404 (identical to the secret-mismatch response) so a probe with a
    // correct path secret but wrong/missing token cannot distinguish that the
    // secret was valid. Auth failures are indistinguishable from a dead route.
    logger.warn(`paris-hunter email webhook: token mismatch on POST ${REDACTED_PATH}/alert`);
    return reply.code(404).send();
  }
  const rawMime = request.body;
  if (typeof rawMime !== 'string' || rawMime.length === 0) {
    logger.warn(`paris-hunter email webhook: empty or invalid body on POST ${REDACTED_PATH}/alert`);
    return reply.code(400).send({ ok: false });
  }

  insertEmailInbox({ source: 'seloger', rawMime });

  await reply.code(200).send({ ok: true });
  logger.info(
    `paris-hunter email webhook: accepted delivery on ${REDACTED_PATH}/alert ` +
      `(bytes=${rawMime.length}) — 200, inbox row inserted.`,
  );
  // jobs:runOne emission is deferred until the Increment 2 email provider exists.
};

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} [options]
 * @returns {Promise<void>}
 */
export default async function emailWebhookPlugin(fastify, options = {}) {
  void options;
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { parseAs: 'string', bodyLimit: BODY_LIMIT }, parseRawBody);
  fastify.setErrorHandler(handleWebhookError);
  fastify.post('/email/:secret/alert', { bodyLimit: BODY_LIMIT }, handleEmailWebhook);
}

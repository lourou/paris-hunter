/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: convos_outbox delivery state machine (plan v2 lane 3 #5/#15 + v3 A1/A6).
 *
 * Delivery guarantee is AT-LEAST-ONCE (v3 A1): duplicates are permitted ONLY in
 * the crash-at-send-boundary window (process death between a completed network
 * send and the matching *_state='sent' write) and EVERY such resend is
 * WARN-logged with the exact phrase "possible duplicate" (QA greps for it).
 * node-sdk 6.0.0 has NO idempotency support — the outbox PK + persisted
 * per-message states (pending -> sending -> sent) are the whole mechanism.
 *
 * Concurrency (v3 A6):
 *  - process-wide single-flight with trailing coalescing: bus events, adapter
 *    send() triggers and the 60 s timer all funnel into flushOutbox(); overlap
 *    is structurally impossible.
 *  - SQL CAS on every state transition (UPDATE ... WHERE state='<from>') as
 *    defense-in-depth under the mutex.
 *  - 'sending' recovery is BOOT-ONLY (recoverSendingRows, called by
 *    initConvosAdapter BEFORE any flush trigger is wired). At runtime a
 *    'sending' row outside the running flush indicates a bug: ERROR, untouched.
 */

import crypto from 'node:crypto';
import SqliteConnection from '../../storage/SqliteConnection.js';
import logger from '../../logger.js';
import { failpoint } from '../failpoints.js';

const MAX_ATTEMPTS = 10;

/**
 * Wired by initConvosAdapter(). All fields are functions:
 *   getSendContext(): Promise<conversation|null>  null = not ready/unhealthy (no attempts counted)
 *   sendText(conversation, text): Promise<messageId>
 *   sendRemoteAttachment(conversation, remoteAttachment): Promise<messageId>
 *   fetchAndPrepareImage(url): Promise<Buffer>
 *   encryptAttachment(attachment): Promise<EncryptedAttachment>|EncryptedAttachment
 *   uploadAttachment(payloadBytes, key, mimeType): Promise<url>
 */
let deps = null;
let running = false;
let queued = false;

export const setOutboxDeps = (newDeps) => {
  deps = newDeps;
};

/** Test-only: reset module state between vitest cases. */
export const __resetOutboxForTests = () => {
  deps = null;
  running = false;
  queued = false;
};

const db = () => SqliteConnection.getConnection();

const shortHash = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

/**
 * enc_meta JSON (persisted ONCE after the first successful encrypt+upload, #15):
 * {url, contentDigest, secret, salt, nonce (base64), contentLength, filename, scheme}
 */
const encodeEncMeta = (encrypted, url, filename) =>
  JSON.stringify({
    url,
    contentDigest: encrypted.contentDigest,
    secret: Buffer.from(encrypted.secret).toString('base64'),
    salt: Buffer.from(encrypted.salt).toString('base64'),
    nonce: Buffer.from(encrypted.nonce).toString('base64'),
    contentLength: encrypted.payload.length,
    filename,
    scheme: 'https',
  });

/** @param {string} encMetaJson @returns {object} RemoteAttachment for the send wrapper */
export const remoteAttachmentFromEncMeta = (encMetaJson) => {
  const meta = JSON.parse(encMetaJson);
  return {
    url: meta.url,
    contentDigest: meta.contentDigest,
    secret: Uint8Array.from(Buffer.from(meta.secret, 'base64')),
    salt: Uint8Array.from(Buffer.from(meta.salt, 'base64')),
    nonce: Uint8Array.from(Buffer.from(meta.nonce, 'base64')),
    scheme: meta.scheme ?? 'https',
    contentLength: meta.contentLength,
    filename: meta.filename,
  };
};

/**
 * SQL CAS on a per-message state column (v3 A6). Returns true only when THIS
 * call performed the transition.
 *
 * @param {string} id outbox row id (= dedupKey)
 * @param {'image_state'|'text_state'} column
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export const casMessageState = (id, column, from, to) => {
  if (column !== 'image_state' && column !== 'text_state') {
    throw new Error(`invalid outbox state column: ${column}`);
  }
  const info = db()
    .prepare(`UPDATE convos_outbox SET ${column} = @to WHERE id = @id AND ${column} = @from`)
    .run({ id, to, from });
  return info.changes === 1;
};

/**
 * BOOT-ONLY (v3 A6): rows stuck in 'sending' mean the process died between a
 * completed network send and the state write — the documented residual window
 * where a duplicate is possible (v3 A1). Reset them to 'pending' (resend
 * preferred over loss for rental alerts) with a mandatory WARN per row.
 * MUST run once in initConvosAdapter() BEFORE any flush trigger is wired.
 *
 * @returns {number} number of rows reset
 */
export const recoverSendingRows = () => {
  const rows = db()
    .prepare(
      `SELECT id, dedup_key, image_state, text_state FROM convos_outbox WHERE image_state = 'sending' OR text_state = 'sending'`,
    )
    .all();
  for (const row of rows) {
    const legs = [row.image_state === 'sending' ? 'image' : null, row.text_state === 'sending' ? 'text' : null]
      .filter(Boolean)
      .join('+');
    logger.warn(
      `convos: possible duplicate for ${row.dedup_key} (crash at ${legs} send boundary — resetting to pending, will resend)`,
    );
    db()
      .prepare(`UPDATE convos_outbox SET image_state = 'pending' WHERE id = @id AND image_state = 'sending'`)
      .run({ id: row.id });
    db()
      .prepare(`UPDATE convos_outbox SET text_state = 'pending' WHERE id = @id AND text_state = 'sending'`)
      .run({ id: row.id });
  }
  if (rows.length > 0) {
    logger.warn(`convos: reset ${rows.length} in-flight ('sending') outbox row(s) at boot`);
  }
  return rows.length;
};

/** @returns {boolean} whether a flush is currently running (used by shutdown) */
export const isFlushRunning = () => running;

/**
 * Process-wide single-flight flush with trailing coalescing (v3 A6, verbatim
 * mechanism): if a flush is running, remember that another one was requested
 * and run exactly one more afterwards.
 *
 * @returns {Promise<void>}
 */
export const flushOutbox = async () => {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  try {
    await runFlush();
  } catch (error) {
    logger.error(`convos: outbox flush failed — ${error.message}`);
  } finally {
    running = false;
    if (queued) {
      queued = false;
      void flushOutbox();
    }
  }
};

const runFlush = async () => {
  if (deps == null) {
    return; // adapter not initialized — rows stay queued
  }
  const conversation = await deps.getSendContext();
  if (conversation == null) {
    return; // not ready / degraded / membership unhealthy — attempts NOT incremented (#15)
  }
  const rows = db()
    .prepare(
      `SELECT * FROM convos_outbox WHERE state = 'queued' AND sent_at IS NULL AND attempts < @maxAttempts ORDER BY created_at ASC, id ASC`,
    )
    .all({ maxAttempts: MAX_ATTEMPTS });
  for (const row of rows) {
    if (row.image_state === 'sending' || row.text_state === 'sending') {
      // Under the single-flight mutex nothing can legitimately be 'sending' here;
      // recovery is boot-only (v3 A6). Leave the row untouched.
      logger.error(
        `convos: outbox row ${row.dedup_key} is 'sending' outside the running flush — bug? leaving untouched`,
      );
      continue;
    }
    try {
      await deliverRow(conversation, row);
    } catch (error) {
      recordFailure(row, error);
    }
  }
};

const deliverRow = async (conversation, row) => {
  let encMeta = row.enc_meta;
  let imageState = row.image_state;

  // 1. Encrypt + upload ONCE (#15) — retries below reuse the persisted enc_meta.
  if (row.image_url && imageState === 'pending' && !encMeta) {
    let prepared = null;
    try {
      prepared = await deps.fetchAndPrepareImage(row.image_url);
    } catch (error) {
      logger.warn(
        `convos: image for ${row.dedup_key} unfetchable/invalid — sending text without photo (${error.message})`,
      );
      if (casMessageState(row.id, 'image_state', 'pending', 'skipped')) {
        imageState = 'skipped';
      }
    }
    if (prepared != null) {
      const filenameBase = `listing-${shortHash(row.dedup_key)}`;
      const encrypted = await deps.encryptAttachment({
        filename: `${filenameBase}.jpg`,
        mimeType: 'image/jpeg',
        content: prepared,
      });
      const key = `attachments/${filenameBase}-${encrypted.contentDigest.slice(0, 8)}.jpg`;
      const url = await deps.uploadAttachment(encrypted.payload, key, 'image/jpeg');
      encMeta = encodeEncMeta(encrypted, url, `${filenameBase}.jpg`);
      db()
        .prepare(`UPDATE convos_outbox SET enc_meta = @encMeta WHERE id = @id AND enc_meta IS NULL`)
        .run({ id: row.id, encMeta });
      failpoint('after_upload');
    }
  }

  // 2. Photo first (iOS renders image bubble + text bubble; no caption field exists).
  if (imageState === 'pending' && encMeta) {
    if (!casMessageState(row.id, 'image_state', 'pending', 'sending')) {
      logger.error(`convos: CAS pending->sending lost for image of ${row.dedup_key} — skipping row`);
      return;
    }
    let messageId;
    try {
      messageId = await deps.sendRemoteAttachment(conversation, remoteAttachmentFromEncMeta(encMeta));
    } catch (error) {
      // A cleanly-failed send is indistinguishable from sent-then-errored, so the
      // retry is WARN-marked as a possible duplicate too (v3 A1 posture).
      logger.warn(
        `convos: possible duplicate for ${row.dedup_key} (image send errored — reverting to pending, will retry)`,
      );
      casMessageState(row.id, 'image_state', 'sending', 'pending');
      throw error;
    }
    failpoint('after_image_send'); // crash HERE = the documented residual duplicate window
    db()
      .prepare(
        `UPDATE convos_outbox SET image_state = 'sent', image_message_id = @messageId WHERE id = @id AND image_state = 'sending'`,
      )
      .run({ id: row.id, messageId });
  }

  // 3. Text leg.
  if (row.text_state === 'pending') {
    if (!casMessageState(row.id, 'text_state', 'pending', 'sending')) {
      logger.error(`convos: CAS pending->sending lost for text of ${row.dedup_key} — skipping row`);
      return;
    }
    let messageId;
    try {
      messageId = await deps.sendText(conversation, row.text);
    } catch (error) {
      logger.warn(
        `convos: possible duplicate for ${row.dedup_key} (text send errored — reverting to pending, will retry)`,
      );
      casMessageState(row.id, 'text_state', 'sending', 'pending');
      throw error;
    }
    failpoint('after_text_send'); // crash HERE = the documented residual duplicate window
    db()
      .prepare(
        `UPDATE convos_outbox SET text_state = 'sent', text_message_id = @messageId WHERE id = @id AND text_state = 'sending'`,
      )
      .run({ id: row.id, messageId });
  }

  // 4. Terminal: text sent AND image sent-or-skipped (or no image at all).
  db()
    .prepare(
      `UPDATE convos_outbox SET sent_at = @now
       WHERE id = @id AND sent_at IS NULL AND text_state = 'sent'
         AND (image_url IS NULL OR image_state IN ('sent', 'skipped'))`,
    )
    .run({ id: row.id, now: Date.now() });
};

const recordFailure = (row, error) => {
  const message = String(error?.message ?? error).slice(0, 500);
  db()
    .prepare(`UPDATE convos_outbox SET attempts = attempts + 1, last_error = @message WHERE id = @id`)
    .run({ id: row.id, message });
  const updated = db().prepare(`SELECT attempts FROM convos_outbox WHERE id = @id`).get({ id: row.id });
  const attempts = updated?.attempts ?? row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    db().prepare(`UPDATE convos_outbox SET state = 'parked' WHERE id = @id`).run({ id: row.id });
    logger.error(
      `convos: outbox row ${row.dedup_key} PARKED after ${attempts} attempts (last error: ${message}) — operator: tools/paris-hunter/qa/requeue-outbox.js`,
    );
  } else {
    logger.warn(`convos: send attempt ${attempts}/${MAX_ATTEMPTS} failed for ${row.dedup_key} — ${message}`);
  }
};

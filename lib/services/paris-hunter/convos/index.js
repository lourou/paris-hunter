/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: convos adapter runtime (lane 3 — plan v2 lane-3 + v3 A1/A6/A10).
 *
 * initConvosAdapter() — called ONLY by initParisHunter() (no module-top-level
 * side effects): exclusive data-dir lock (single writer, contract §1; a second
 * process on the same dir exits non-zero) -> BOOT-ONLY 'sending' recovery (v3 A6,
 * before ANY flush trigger is wired) -> flush triggers (bus 'convos:flush' +
 * 60 s timer) -> attachment store -> identity -> XMTP client -> boot state
 * machine (contract §4: NEVER re-run the JOIN flow while a healthy
 * adapter-state.json exists) -> background syncAll every 10 min.
 *
 * whenReady() — shared readiness promise: resolves when the adapter can send,
 * rejects on degraded mode (rows stay queued; Fredy keeps running).
 * flushOutbox() — re-exported single-flight drain (outbox.js).
 */

import logger from '../../logger.js';
import { bus } from '../../events/event-bus.js';
import { acquireDataDirLock, releaseDataDirLock } from './lock.js';
import { loadOrCreateIdentity, patchIdentity, loadAdapterState, saveAdapterState } from './identity.js';
import { flushOutbox, recoverSendingRows, setOutboxDeps, isFlushRunning } from './outbox.js';

export { flushOutbox };

const adapter = {
  status: 'uninitialized', // uninitialized | initializing | ready | degraded
  reason: null,
  client: null,
  conversationId: null,
  store: null,
  dataDir: null,
  timers: [],
};

let readyResolve;
let readyReject;
const readyPromise = new Promise((resolve, reject) => {
  readyResolve = resolve;
  readyReject = reject;
});
readyPromise.catch(() => {}); // nobody awaiting must not become an unhandled rejection

/** @returns {Promise<void>} resolves when sends are possible; rejects on degraded mode */
export const whenReady = () => readyPromise;

/** @returns {{status: string, reason: string|null, conversationId: string|null}} health surface for logs/QA */
export const getAdapterStatus = () => ({
  status: adapter.status,
  reason: adapter.reason,
  conversationId: adapter.conversationId,
});

const degrade = (reason, message) => {
  adapter.status = 'degraded';
  adapter.reason = reason;
  logger.error(`convos adapter: degraded(${reason}) — ${message} (Fredy keeps running; outbox rows stay queued)`);
  readyReject(new Error(`convos adapter degraded(${reason}): ${message}`));
};

const becomeReady = () => {
  adapter.status = 'ready';
  adapter.reason = null;
  logger.info(`convos adapter: healthy — conversation ${adapter.conversationId}`);
  readyResolve();
};

/**
 * Pre-send context (outbox dep): sync + membership health before each batch
 * (contract §6c/§7). Returns null when sending must not happen — the outbox
 * does NOT count attempts for that (#15).
 */
const getSendContext = async () => {
  if (adapter.status !== 'ready' || adapter.client == null || adapter.conversationId == null) {
    return null;
  }
  try {
    await adapter.client.conversations.sync();
    const conversation = await adapter.client.conversations.getConversationById(adapter.conversationId);
    if (conversation == null || conversation.isActive === false) {
      logger.error(
        'convos adapter: membership lost (removed from group or state lost) — sends parked, operator action required',
      );
      return null;
    }
    await conversation.sync(); // cheap; folds in pending membership/epoch commits
    return conversation;
  } catch (error) {
    logger.error(`convos: pre-send sync failed — ${error.message}`);
    return null;
  }
};

/**
 * Does the operator-provided invite differ from the one recorded in state?
 * (contract §4 — only a DIFFERENT invite may trigger a re-join after removal).
 * Unparseable invite => false (never join on garbage); missing recorded tag =>
 * true (cannot prove sameness; the operator explicitly provided an invite for
 * recovery).
 */
const inviteDiffersFromState = async (inviteUrl, state) => {
  try {
    const convosCli = await import('@xmtp/convos-cli');
    const invite = convosCli.parseInvite(inviteUrl);
    const tag = invite?.tag ?? null;
    if (tag != null && state?.inviteTag != null) {
      return tag !== state.inviteTag;
    }
    return true;
  } catch (error) {
    logger.error(`convos: cannot parse CONVOS_INVITE_URL — ${error.message}`);
    return false;
  }
};

const joinViaInvite = async (inviteUrl, dataDir) => {
  const profileName = process.env.CONVOS_PROFILE_NAME ?? 'Paris Hunter';
  const { runJoinFlow, sendProfileUpdateBestEffort } = await import('./join.js');
  logger.info('convos adapter: running one-shot JOIN flow (nothing is sent to the group during join)');
  const result = await runJoinFlow({ client: adapter.client, inviteUrl, profileName });
  // Persist BEFORE reporting success (contract §5) — this is what makes the
  // never-re-redeem invariant hold across restarts.
  saveAdapterState(dataDir, {
    conversationId: result.conversationId,
    inviteTag: result.inviteTag ?? null,
    joinedAt: new Date().toISOString(),
  });
  adapter.conversationId = result.conversationId;
  await sendProfileUpdateBestEffort(result.group, profileName);
  becomeReady();
};

const addTimer = (fn, intervalMs) => {
  const timer = setInterval(fn, intervalMs);
  timer.unref?.();
  adapter.timers.push(timer);
  return timer;
};

let shutdownStarted = false;
/**
 * Graceful shutdown (contract §8; compose stop_grace_period 30 s): stop timers,
 * let an in-flight flush finish, close the client, release the lock, exit 0.
 *
 * @param {string} signal
 * @param {{exit?: boolean}} [options]
 */
export const shutdownConvosAdapter = async (signal, { exit = true } = {}) => {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  logger.info(`convos adapter: ${signal} — draining and closing`);
  for (const timer of adapter.timers) {
    clearInterval(timer);
  }
  adapter.timers = [];
  const waitUntil = Date.now() + 25_000;
  while (isFlushRunning() && Date.now() < waitUntil) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    await adapter.client?.close?.();
  } catch (error) {
    logger.warn(`convos: client close failed — ${error.message}`);
  }
  if (adapter.dataDir != null) {
    releaseDataDirLock(adapter.dataDir);
  }
  if (exit) {
    process.exit(0);
  }
};

/**
 * @returns {Promise<void>} resolves when init finished (ready OR degraded);
 * initParisHunter() fires-and-logs it so Fredy boot is never blocked.
 */
export const initConvosAdapter = async () => {
  if (adapter.status !== 'uninitialized') {
    return;
  }
  adapter.status = 'initializing';

  const dataDir = process.env.CONVOS_DATA_DIR;
  const xmtpEnv = process.env.XMTP_ENV ?? 'production';
  if (dataDir == null || dataDir.trim() === '') {
    degrade('config', 'CONVOS_DATA_DIR is not set');
    return;
  }
  if (!['dev', 'production', 'local'].includes(xmtpEnv)) {
    degrade(
      'config',
      `XMTP_ENV must be 'dev' or 'production' (got '${xmtpEnv}') and MUST match the app that created the invite`,
    );
    return;
  }
  adapter.dataDir = dataDir;

  // Single writer (contract §1): exactly one adapter process per data dir, EVER.
  try {
    acquireDataDirLock(dataDir);
  } catch (error) {
    logger.error(`convos adapter: could not acquire the exclusive lock on ${dataDir} — ${error.message}`);
    process.exit(1);
  }

  // v3 A6: boot-only 'sending' recovery BEFORE any flush trigger exists.
  try {
    recoverSendingRows();
  } catch (error) {
    degrade('db', `boot 'sending' recovery failed — ${error.message}`);
    return;
  }

  const onFlushTrigger = () => {
    void flushOutbox();
  };
  bus.on('convos:flush', onFlushTrigger);
  addTimer(onFlushTrigger, 60_000);

  try {
    const { createAttachmentStore, selfTestStore } = await import('./attachmentStore.js');
    adapter.store = createAttachmentStore();
    if (adapter.store.kind === 'local') {
      try {
        adapter.store.sweepRetention();
      } catch (error) {
        logger.warn(`convos: retention sweep failed — ${error.message}`);
      }
      addTimer(
        () => {
          try {
            adapter.store.sweepRetention();
          } catch (error) {
            logger.warn(`convos: retention sweep failed — ${error.message}`);
          }
        },
        24 * 60 * 60 * 1000,
      );
    }
    if (process.env.PH_SELFTEST === '1') {
      await selfTestStore(adapter.store);
    }

    const identity = await loadOrCreateIdentity(dataDir);
    const { createConvosClient, sendConversationText, sendConversationRemoteAttachment } = await import('./client.js');
    adapter.client = await createConvosClient({ identity, dataDir, env: xmtpEnv });
    if (identity.inboxId == null && adapter.client.inboxId != null) {
      patchIdentity(dataDir, { inboxId: adapter.client.inboxId }); // best effort
    }

    setOutboxDeps({
      getSendContext,
      sendText: sendConversationText,
      sendRemoteAttachment: sendConversationRemoteAttachment,
      fetchAndPrepareImage: async (url) => {
        const { preparePhoto } = await import('./photo.js');
        return preparePhoto(url);
      },
      encryptAttachment: async (attachment) => {
        const { encryptAttachment } = await import('@xmtp/node-sdk');
        return encryptAttachment(attachment);
      },
      uploadAttachment: (payloadBytes, key, mimeType) => adapter.store.upload(payloadBytes, key, mimeType),
    });

    // Boot state machine (contract §4).
    const state = loadAdapterState(dataDir);
    const inviteUrl = (process.env.CONVOS_INVITE_URL ?? '').trim() || null;
    if (state?.conversationId) {
      const { checkMembership } = await import('./health.js');
      const membership = await checkMembership(adapter.client, state.conversationId);
      if (membership === 'healthy') {
        adapter.conversationId = state.conversationId;
        becomeReady();
      } else {
        logger.error(
          `convos adapter: membership check = '${membership}' — removed from group or state lost; operator action required`,
        );
        if (inviteUrl != null && (await inviteDiffersFromState(inviteUrl, state))) {
          await joinViaInvite(inviteUrl, dataDir);
        } else {
          degrade(`membership-${membership}`, 'set a NEW CONVOS_INVITE_URL to re-join');
        }
      }
    } else if (inviteUrl != null) {
      await joinViaInvite(inviteUrl, dataDir);
    } else {
      degrade('no-invite', 'first run requires CONVOS_INVITE_URL (adapter-state.json is absent)');
    }
  } catch (error) {
    degrade('init-error', error.message);
    return;
  } finally {
    process.once('SIGTERM', () => {
      void shutdownConvosAdapter('SIGTERM');
    });
  }

  if (adapter.status === 'ready') {
    addTimer(
      () => {
        adapter.client.conversations
          .syncAll()
          .catch((error) => logger.warn(`convos: background syncAll failed — ${error.message}`));
      },
      10 * 60 * 1000,
    ); // keeps MLS epoch/membership current, consumes no inbound messages (§6c)
    void flushOutbox();
  }
};

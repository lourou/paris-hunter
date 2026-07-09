/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: one-shot, headless Convos JOIN flow (contract §5).
 *
 * The join request travels over a DM to the invite creator; the GROUP receives
 * NOTHING during the join (silence rule — the first group message is the first
 * real listing notification). The request is sent ONCE and never re-sent inside
 * the poll window (creator-side dedup is per messageId — a resend would be a
 * brand-new request). The caller persists adapter-state.json BEFORE reporting
 * success and must NEVER run this flow while a healthy state file exists.
 */

import logger from '../../logger.js';

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Best-effort fail-fast: scan the DM for a terminal invite_join_error reply
 * (expired / used / denied) so we can abort instead of waiting out 24 h.
 *
 * @param {object} dm
 * @returns {Promise<string|null>} the error content when found
 */
const scanForJoinError = async (dm) => {
  try {
    const messages = await dm.messages();
    for (const message of messages ?? []) {
      const typeId = message?.contentType?.typeId ?? '';
      if (String(typeId).includes('invite_join_error')) {
        return String(message.content ?? 'invite_join_error');
      }
    }
  } catch {
    // best effort only
  }
  return null;
};

/**
 * Redeem an invite and poll until the creator's device adds us to the group.
 *
 * @param {{
 *   client: object,
 *   inviteUrl: string,
 *   profileName: string,
 *   pollIntervalMs?: number,
 *   windowMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} options sleep/now are injectable for tests
 * @returns {Promise<{conversationId: string, inviteTag: string|null, group: object}>}
 */
export const runJoinFlow = async ({
  client,
  inviteUrl,
  profileName,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  windowMs = DEFAULT_WINDOW_MS,
  sleep = defaultSleep,
  now = Date.now,
}) => {
  const convosCli = await import('@xmtp/convos-cli');

  const invite = convosCli.parseInvite(inviteUrl); // accepts full URL or bare slug
  if (!(await convosCli.verifyInvite(invite))) {
    throw new Error('invite signature verification failed');
  }
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < now()) {
    throw new Error('invite is expired — mint a fresh one from the Convos app');
  }

  const dm = await client.conversations.createDm(invite.creatorInboxId);
  await client.conversations.sync();
  const preJoin = new Set((await client.conversations.list()).map((conversation) => conversation.id)); // includes dm.id

  const slug = convosCli.inviteToSlug(invite);
  await dm.send(
    new convosCli.JoinRequestCodec().encode({
      inviteSlug: slug,
      profile: { name: profileName, memberKind: 'agent' },
    }),
  );
  await dm.sendText(slug); // plaintext fallback for older clients — ONE argument (node-sdk 6.0.0 boolean trap)

  logger.info('convos: join request sent — polling for acceptance (creator-side push accepts in near-real-time)');
  const deadline = now() + windowMs;
  while (now() < deadline) {
    await client.conversations.sync();
    const joined = (await client.conversations.list()).find(
      (conversation) => conversation.id !== dm.id && !preJoin.has(conversation.id),
    );
    if (joined) {
      logger.info(`convos: joined conversation ${joined.id}`);
      return { conversationId: joined.id, inviteTag: invite.tag ?? null, group: joined };
    }
    const joinError = await scanForJoinError(dm);
    if (joinError != null) {
      throw new Error(`invite redemption rejected by creator (${joinError}) — mint a fresh invite`);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `join window (${Math.round(windowMs / 3_600_000)} h) expired without acceptance — do NOT resend automatically`,
  );
};

/**
 * Post-join best-effort profile update so the group shows a proper agent name.
 * Called AFTER adapter-state.json is persisted; never throws.
 *
 * @param {object} group
 * @param {string} profileName
 */
export const sendProfileUpdateBestEffort = async (group, profileName) => {
  try {
    const convosCli = await import('@xmtp/convos-cli');
    await convosCli.sendProfileUpdate(group, { name: profileName, memberKind: convosCli.MemberKind.Agent });
  } catch (error) {
    logger.warn(`convos: profile update failed (non-fatal) — ${error.message}`);
  }
};

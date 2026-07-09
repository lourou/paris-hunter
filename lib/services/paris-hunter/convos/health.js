/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: convos group membership health check (contract §7).
 * Run at boot (§4) and before each send batch; surfaced in Fredy logs.
 */

/**
 * @param {object} client XMTP client
 * @param {string} conversationId
 * @returns {Promise<'healthy'|'removed'|'missing'>}
 */
export const checkMembership = async (client, conversationId) => {
  await client.conversations.sync();
  const conversation = await client.conversations.getConversationById(conversationId);
  if (!conversation) {
    return 'missing'; // never had it in this installation / state lost
  }
  if (conversation.isActive === false) {
    return 'removed'; // we were removed from the MLS group
  }
  return 'healthy';
};

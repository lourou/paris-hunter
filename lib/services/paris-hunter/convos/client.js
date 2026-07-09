/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: XMTP client construction + SAFE send wrappers (contract §3).
 *
 * NORMATIVE (@xmtp/node-sdk 6.0.0, CP0-verified): there is NO idempotencyKey on
 * any send path, and EVERY typed send helper — sendText AND sendRemoteAttachment —
 * takes `isOptimistic?: boolean` as its second argument, NOT an options object.
 * Passing an options object coerces truthy => accidental optimistic send (the
 * message is queued locally and never published). ALL group sends MUST go through
 * the two wrappers below; a unit test guards their argument shapes.
 *
 * Heavy deps (@xmtp/node-sdk native bindings, viem, convos-cli) are imported
 * lazily inside createConvosClient so that merely importing this module (e.g.
 * from tests asserting the wrapper guards) stays cheap and side-effect-free.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Send a text message. EXACTLY ONE argument is forwarded — never add a second
 * one (boolean isOptimistic on node-sdk 6.0.0; an object would coerce truthy).
 *
 * @param {object} conversation XMTP conversation
 * @param {string} text
 * @returns {Promise<string>} message id
 */
export const sendConversationText = (conversation, text) => conversation.sendText(text);

/**
 * Send a remote attachment. The second argument is the LITERAL BOOLEAN false
 * (isOptimistic) — node-sdk 6.0.0 has no options object on this path either.
 *
 * @param {object} conversation XMTP conversation
 * @param {object} remoteAttachment {url, contentDigest, secret, salt, nonce, scheme, contentLength, filename}
 * @returns {Promise<string>} message id
 */
export const sendConversationRemoteAttachment = (conversation, remoteAttachment) =>
  conversation.sendRemoteAttachment(remoteAttachment, false);

/**
 * EOA signer over a viem account (contract §3).
 *
 * @param {{address: string, signMessage: (args: {message: string}) => Promise<string>}} account
 */
export const buildEoaSigner = (account) => ({
  type: 'EOA',
  getIdentifier: () => ({ identifierKind: 0, identifier: account.address.toLowerCase() }),
  signMessage: async (message) =>
    Uint8Array.from(Buffer.from((await account.signMessage({ message })).slice(2), 'hex')),
});

/**
 * Build the long-lived XMTP client (ONE per process; close on SIGTERM).
 * First run auto-registers the inbox (one signature); later runs with the same
 * dbPath are cheap local rebuilds.
 *
 * @param {{identity: {walletKey: string, dbEncryptionKey: string}, dataDir: string, env: string}} options
 * @returns {Promise<object>} XMTP client
 */
export const createConvosClient = async ({ identity, dataDir, env }) => {
  const { privateKeyToAccount } = await import('viem/accounts');
  const { Client } = await import('@xmtp/node-sdk');
  const { AttachmentCodec, RemoteAttachmentCodec } = await import('@xmtp/content-type-remote-attachment');
  // Convos content-type codecs: root re-exports (CP0-verified; subpath is utils/invite, singular).
  const { JoinRequestCodec, ProfileUpdateCodec, ProfileSnapshotCodec } = await import('@xmtp/convos-cli');

  const account = privateKeyToAccount(identity.walletKey);
  const signer = buildEoaSigner(account);
  const dbDir = path.join(dataDir, 'db', env);
  fs.mkdirSync(dbDir, { recursive: true });

  return Client.create(signer, {
    env,
    dbPath: path.join(dbDir, 'main.db3'),
    dbEncryptionKey: Uint8Array.from(Buffer.from(identity.dbEncryptionKey, 'hex')),
    codecs: [
      new AttachmentCodec(),
      new RemoteAttachmentCodec(),
      new ProfileUpdateCodec(),
      new ProfileSnapshotCodec(),
      new JoinRequestCodec(),
    ],
    appVersion: 'paris-hunter/0.1.0',
  });
};

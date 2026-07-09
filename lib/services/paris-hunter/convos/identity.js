/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: convos adapter identity + adapter-state persistence (contract §1).
 *
 * ${CONVOS_DATA_DIR}/identity.json      { walletKey, dbEncryptionKey, inboxId?, createdAt }
 * ${CONVOS_DATA_DIR}/adapter-state.json { conversationId, inviteTag, joinedAt }
 *
 * Both files are written atomically (tmp + rename); identity.json is chmod 600.
 * Deleting identity.json = brand new identity (needs a fresh invite). Losing db/
 * while keeping identity.json = new XMTP installation, no longer in the group.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IDENTITY_FILENAME = 'identity.json';
const STATE_FILENAME = 'adapter-state.json';

/**
 * Atomic JSON write: tmp file in the same dir + rename.
 *
 * @param {string} filePath
 * @param {object} value
 * @param {number} [mode]
 */
const writeJsonAtomic = (filePath, value, mode = 0o600) => {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // best effort — mode was already applied on create
  }
};

const readJsonIfExists = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`cannot read ${filePath}: ${error.message}`, { cause: error });
  }
};

/**
 * Load the identity, creating it on first run (viem key + 32-byte db key).
 *
 * @param {string} dataDir
 * @returns {Promise<{walletKey: string, dbEncryptionKey: string, inboxId?: string, createdAt: string}>}
 */
export const loadOrCreateIdentity = async (dataDir) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const identityPath = path.join(dataDir, IDENTITY_FILENAME);
  const existing = readJsonIfExists(identityPath);
  if (existing != null) {
    if (typeof existing.walletKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(existing.walletKey)) {
      throw new Error(`${identityPath} exists but walletKey is malformed — refusing to overwrite an identity`);
    }
    if (typeof existing.dbEncryptionKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(existing.dbEncryptionKey)) {
      throw new Error(`${identityPath} exists but dbEncryptionKey is malformed — refusing to overwrite an identity`);
    }
    return existing;
  }
  const { generatePrivateKey } = await import('viem/accounts');
  const identity = {
    walletKey: generatePrivateKey(),
    dbEncryptionKey: crypto.randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(identityPath, identity, 0o600);
  return identity;
};

/**
 * Best-effort patch of identity.json (e.g. persisting inboxId after Client.create).
 *
 * @param {string} dataDir
 * @param {object} patch
 */
export const patchIdentity = (dataDir, patch) => {
  const identityPath = path.join(dataDir, IDENTITY_FILENAME);
  const existing = readJsonIfExists(identityPath);
  if (existing == null) {
    return;
  }
  writeJsonAtomic(identityPath, { ...existing, ...patch }, 0o600);
};

/**
 * @param {string} dataDir
 * @returns {{conversationId: string, inviteTag: string|null, joinedAt: string}|null}
 */
export const loadAdapterState = (dataDir) => {
  const state = readJsonIfExists(path.join(dataDir, STATE_FILENAME));
  if (state == null || typeof state.conversationId !== 'string' || state.conversationId.length === 0) {
    return state == null ? null : null;
  }
  return state;
};

/**
 * Persisted atomically BEFORE the join flow reports success (contract §5) —
 * a present, healthy adapter-state.json means the JOIN flow must NEVER re-run
 * (re-redemption re-DMs the creator and can burn a single-use invite).
 *
 * @param {string} dataDir
 * @param {{conversationId: string, inviteTag: string|null, joinedAt: string}} state
 */
export const saveAdapterState = (dataDir, state) => {
  fs.mkdirSync(dataDir, { recursive: true });
  writeJsonAtomic(path.join(dataDir, STATE_FILENAME), state, 0o600);
};

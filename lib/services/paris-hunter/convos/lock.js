/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: kernel-enforced single-writer lock on CONVOS_DATA_DIR.
 *
 * Node has no portable flock/fcntl API and the dependency manifests are
 * intentionally frozen. Instead, a dedicated SQLite database holds a
 * BEGIN EXCLUSIVE transaction for the adapter's entire lifetime. SQLite's OS
 * file locks provide cross-process and cross-PID-namespace exclusion, and the
 * kernel releases them automatically on crash. The uncommitted owner row is
 * useful while inspecting a live process but never needs stale-file cleanup.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

export const LOCK_FILENAME = 'adapter-lock.sqlite';

/** @type {Map<string, import('better-sqlite3').Database>} */
const heldLocks = new Map();

/**
 * Acquire the exclusive data-dir lock or throw immediately.
 *
 * @param {string} dataDir
 * @returns {string} the dedicated lock database path
 */
export const acquireDataDirLock = (dataDir) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, LOCK_FILENAME);
  if (heldLocks.has(lockPath)) {
    throw new Error(`data dir ${dataDir} is already locked by this process`);
  }

  const db = new Database(lockPath, { timeout: 0 });
  try {
    fs.chmodSync(lockPath, 0o600);
    // Keep rollback-journal mode: BEGIN EXCLUSIVE then takes an OS-level lock
    // that excludes every other connection, including readers.
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 0');
    db.exec(`
      CREATE TABLE IF NOT EXISTS adapter_locks (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      )
    `);
    db.exec('BEGIN EXCLUSIVE');
    db.prepare('INSERT OR REPLACE INTO adapter_locks (name, owner, acquired_at) VALUES (?, ?, ?)').run(
      'convos-adapter',
      crypto.randomUUID(),
      new Date().toISOString(),
    );
    heldLocks.set(lockPath, db);
    return lockPath;
  } catch (error) {
    db.close();
    if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') {
      throw new Error(
        `data dir ${dataDir} is locked by another adapter process — never run two adapters on one data dir`,
        { cause: error },
      );
    }
    throw error;
  }
};

/**
 * Release a lock held by this process. The database file intentionally stays:
 * unlinking lock files creates an inode-replacement race with a new owner.
 *
 * @param {string} dataDir
 */
export const releaseDataDirLock = (dataDir) => {
  const lockPath = path.join(dataDir, LOCK_FILENAME);
  const db = heldLocks.get(lockPath);
  if (db == null) {
    return;
  }
  heldLocks.delete(lockPath);
  try {
    db.exec('ROLLBACK');
  } catch {
    // A failed init may already have ended the transaction.
  }
  db.close();
};

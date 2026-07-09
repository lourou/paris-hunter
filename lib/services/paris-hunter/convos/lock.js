/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: single-writer lock on CONVOS_DATA_DIR (contract §1).
 *
 * Exactly one adapter process per data dir, ever. We open a lockfile with the
 * 'wx' flag (fails when it already exists) and keep the fd open for the process
 * lifetime. The lockfile records our pid so a crashed process (SIGKILL leaves
 * the file behind) can be detected as stale on the next boot and cleaned up —
 * the "lockfile-fallback staleness path" exercised by QA AC6.
 */

import fs from 'node:fs';
import path from 'node:path';

const LOCK_FILENAME = 'adapter.lock';

/** @type {Map<string, number>} lock path -> open fd held by this process */
const heldLocks = new Map();

/**
 * @param {number} pid
 * @returns {boolean} whether a process with this pid is alive (EPERM counts as alive)
 */
const isProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};

const tryOpenLock = (lockPath) => {
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  fs.fsyncSync(fd);
  return fd;
};

/**
 * Acquire the exclusive data-dir lock or throw. A stale lockfile (owner pid no
 * longer alive) is removed and re-acquired once.
 *
 * @param {string} dataDir
 * @returns {string} the lock file path
 */
export const acquireDataDirLock = (dataDir) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, LOCK_FILENAME);
  try {
    heldLocks.set(lockPath, tryOpenLock(lockPath));
    return lockPath;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  // Lockfile exists — stale (crashed process) or live contention?
  let ownerPid = null;
  try {
    ownerPid = JSON.parse(fs.readFileSync(lockPath, 'utf8'))?.pid ?? null;
  } catch {
    // Unreadable/corrupt lockfile: treat as stale.
  }
  if (ownerPid != null && ownerPid !== process.pid && isProcessAlive(ownerPid)) {
    throw new Error(
      `data dir ${dataDir} is locked by a live process (pid ${ownerPid}) — never run two adapters on one data dir`,
    );
  }
  fs.unlinkSync(lockPath);
  heldLocks.set(lockPath, tryOpenLock(lockPath));
  return lockPath;
};

/**
 * Release a lock held by this process (close fd + unlink). Safe to call twice.
 *
 * @param {string} dataDir
 */
export const releaseDataDirLock = (dataDir) => {
  const lockPath = path.join(dataDir, LOCK_FILENAME);
  const fd = heldLocks.get(lockPath);
  if (fd == null) {
    return;
  }
  heldLocks.delete(lockPath);
  try {
    fs.closeSync(fd);
  } catch {
    // already closed
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already removed
  }
};

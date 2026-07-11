/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: shared self-init prelude for the operator tools (v3 A11).
 *
 * Replicates index.js's exact boot prelude IN ORDER so bootstrap.js / seed.js
 * can run standalone (host or `docker compose run`):
 *   checkIfConfigIsAccessible() → ensure/create default conf/config.json →
 *   SqliteConnection.init() → refreshConfig() → computeDbPath() + mkdir →
 *   runMigrations() → ensureAdminUserExists()
 * One helper, all tool consumers — drift-proof. (setup-bucket.js needs no DB
 * and deliberately does not use this.)
 *
 * DB-contention discipline (live incident 2026-07-11: seed run with the
 * receiver up): tools must FAIL FAST and LOUD when the shared sqlite volume
 * is held, never sit on a lock. Two layers:
 *   - assertReceiverStopped() detects a RUNNING receiver explicitly (try-lock
 *     on the convos adapter-lock DB — held BEGIN EXCLUSIVE for the receiver's
 *     whole lifetime — plus an in-network HTTP probe of the fredy service)
 *     and refuses with a copy-pastable remedy. Opt-in per tool: seed.js
 *     requires a stopped receiver (§5 stop-first); bootstrap.js does NOT
 *     (--enable-notifications and §7bis reconcile legitimately run alongside).
 *   - A short busy_timeout (TOOL_BUSY_TIMEOUT_MS) on the tool's listings.db
 *     connection + withReceiverHint() so any residual SQLITE_BUSY surfaces in
 *     seconds with the same remedy instead of a raw 'database is locked'.
 *
 * Invoke tools as: node --env-file-if-exists=.env tools/paris-hunter/<tool>.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { checkIfConfigIsAccessible, refreshConfig } from '../../../lib/utils.js';
import SqliteConnection, { computeDbPath } from '../../../lib/services/storage/SqliteConnection.js';
import { runMigrations } from '../../../lib/services/storage/migrations/migrate.js';
import { ensureAdminUserExists } from '../../../lib/services/storage/userStorage.js';
import { DEFAULT_CONFIG } from '../../../lib/defaultConfig.js';
import { LOCK_FILENAME } from '../../../lib/services/paris-hunter/convos/lock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const TOOL_BUSY_TIMEOUT_MS = 2500;

export const RECEIVER_HINT =
  'the receiver appears to be running — stop it first: docker compose stop fredy (restart afterwards with docker compose up -d)';

/** @returns {boolean} true when the error is sqlite lock contention */
export const isSqliteBusyError = (error) =>
  typeof error?.code === 'string' && (error.code.startsWith('SQLITE_BUSY') || error.code === 'SQLITE_LOCKED');

/**
 * Translate raw sqlite contention ('database is locked') into an actionable
 * operator message; every other error passes through untouched.
 *
 * @param {Error} error
 * @returns {Error}
 */
export const withReceiverHint = (error) =>
  isSqliteBusyError(error) ? new Error(`${error.message} — ${RECEIVER_HINT}`, { cause: error }) : error;

/**
 * Refuse to proceed when the receiver is running. Two independent probes, both
 * cheap, both side-effect-free when the receiver never existed:
 *   1. adapter-lock try-lock: the receiver's convos adapter holds BEGIN
 *      EXCLUSIVE on ${CONVOS_DATA_DIR}/adapter-lock.sqlite for its whole
 *      lifetime (lib/services/paris-hunter/convos/lock.js) — if that database
 *      refuses an immediate exclusive transaction, the receiver is alive.
 *      Probed ONLY when the lock file already exists (never creates dirs).
 *   2. HTTP probe of the fredy service ('http://fredy:9998/' inside the
 *      compose network; override via PH_RECEIVER_PROBE_URL) — catches a
 *      running receiver whose adapter is degraded and holds no lock. Any
 *      network error (DNS, refused, timeout) means "not running" — on an
 *      operator host the name simply never resolves.
 *
 * @param {{ dataDir?: string|null, probeUrl?: string|null, fetchImpl?: typeof fetch }} options
 * @returns {Promise<void>} resolves when no receiver was detected
 */
export const assertReceiverStopped = async ({
  dataDir = process.env.CONVOS_DATA_DIR ?? null,
  probeUrl = process.env.PH_RECEIVER_PROBE_URL ?? 'http://fredy:9998/',
  fetchImpl = fetch,
} = {}) => {
  if (dataDir != null && dataDir !== '') {
    const lockPath = path.join(dataDir, LOCK_FILENAME);
    if (fs.existsSync(lockPath)) {
      let db = null;
      try {
        db = new Database(lockPath, { timeout: 0 });
        db.pragma('busy_timeout = 0');
        db.exec('BEGIN EXCLUSIVE');
        db.exec('ROLLBACK');
      } catch (error) {
        if (isSqliteBusyError(error)) {
          throw new Error(`adapter lock ${lockPath} is HELD — ${RECEIVER_HINT}`, { cause: error });
        }
        // Any other probe failure is inconclusive — fall through to probe 2.
      } finally {
        try {
          db?.close();
        } catch {
          /* already closed */
        }
      }
    }
  }

  if (probeUrl != null && probeUrl !== '') {
    let response = null;
    try {
      response = await fetchImpl(probeUrl, { signal: AbortSignal.timeout(1500) });
    } catch {
      // Unreachable/unresolvable = receiver not running: proceed.
    }
    if (response != null) {
      throw new Error(`receiver answered ${probeUrl} (HTTP ${response.status}) — ${RECEIVER_HINT}`);
    }
  }
};

/**
 * @param {{ requireReceiverStopped?: boolean }} options seed.js passes true
 *   (§5 stop-first discipline); bootstrap.js legitimately runs alongside the
 *   receiver (--enable-notifications, §7bis) and keeps the default.
 * @returns {Promise<void>} resolves once the tool can safely touch the DB
 */
export const initToolContext = async ({ requireReceiverStopped = false } = {}) => {
  if (requireReceiverStopped) {
    await assertReceiverStopped();
  }

  const accessible = await checkIfConfigIsAccessible();
  if (!accessible) {
    console.error('paris-hunter tool: conf/config.json exists but is not readable — fix file permissions.');
    process.exit(1);
  }

  const confDir = path.join(ROOT, 'conf');
  const confPath = path.join(confDir, 'config.json');
  if (!fs.existsSync(confPath)) {
    fs.mkdirSync(confDir, { recursive: true });
    fs.writeFileSync(confPath, JSON.stringify({ ...DEFAULT_CONFIG }));
    console.error('paris-hunter tool: created default conf/config.json');
  }

  await SqliteConnection.init();
  await refreshConfig();

  const { dir } = await computeDbPath();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Fail FAST on contention: a one-off tool must never sit multiple seconds
  // on someone else's lock before erroring (see withReceiverHint).
  SqliteConnection.getConnection().pragma(`busy_timeout = ${TOOL_BUSY_TIMEOUT_MS}`);

  await runMigrations();
  ensureAdminUserExists();
};

/**
 * @returns {string} id of an admin user (bootstrap owns the paris-hunter job)
 */
export const getAdminUserId = () => {
  const row = SqliteConnection.query('SELECT id FROM users WHERE is_admin = 1 ORDER BY last_login DESC LIMIT 1');
  if (row.length === 0) {
    throw new Error('no admin user found — did initToolContext() run?');
  }
  return row[0].id;
};

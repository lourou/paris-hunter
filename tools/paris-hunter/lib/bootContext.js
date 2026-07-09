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
 * Invoke tools as: node --env-file-if-exists=.env tools/paris-hunter/<tool>.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkIfConfigIsAccessible, refreshConfig } from '../../../lib/utils.js';
import SqliteConnection, { computeDbPath } from '../../../lib/services/storage/SqliteConnection.js';
import { runMigrations } from '../../../lib/services/storage/migrations/migrate.js';
import { ensureAdminUserExists } from '../../../lib/services/storage/userStorage.js';
import { DEFAULT_CONFIG } from '../../../lib/defaultConfig.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * @returns {Promise<void>} resolves once the tool can safely touch the DB
 */
export const initToolContext = async () => {
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

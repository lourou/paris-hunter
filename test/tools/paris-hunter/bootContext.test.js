/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter tools: DB-contention fast-fail + running-receiver refusal
 * (live incident 2026-07-11: seed.js run while the receiver was up).
 *
 * These tests spawn REAL holder child processes so the sqlite locks under
 * test are genuine cross-process kernel locks, not simulations.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  assertReceiverStopped,
  isSqliteBusyError,
  withReceiverHint,
  RECEIVER_HINT,
  TOOL_BUSY_TIMEOUT_MS,
} from '../../../tools/paris-hunter/lib/bootContext.js';
import {
  acquireDataDirLock,
  releaseDataDirLock,
  LOCK_FILENAME,
} from '../../../lib/services/paris-hunter/convos/lock.js';

const require = createRequire(import.meta.url);
const BETTER_SQLITE = require.resolve('better-sqlite3');
const LOCK_MODULE = new URL('../../../lib/services/paris-hunter/convos/lock.js', import.meta.url).href;

const children = [];
const tmpDirs = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const mkTmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-bootctx-'));
  tmpDirs.push(dir);
  return dir;
};

/** Spawns a node child and resolves once it prints `readyToken`. */
const spawnUntil = (nodeArgs, readyToken, env = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, { env: { ...process.env, ...env } });
    children.push(child);
    let out = '';
    const timer = setTimeout(() => reject(new Error(`holder never printed ${readyToken}: ${out}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      if (out.includes(readyToken)) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`holder exited early: ${out}`));
    });
  });

describe('busy-DB fast-fail (a locked listings.db must error in seconds, never hang)', () => {
  it('a write against a DB held by another PROCESS fails fast with SQLITE_BUSY and gets the receiver hint', async () => {
    const dir = mkTmp();
    const dbPath = path.join(dir, 'listings.db');
    const setup = new Database(dbPath);
    setup.pragma('journal_mode = WAL');
    setup.exec('CREATE TABLE paris_hunter_meta (key TEXT PRIMARY KEY, value TEXT)');
    setup.close();

    // Real cross-process holder: BEGIN IMMEDIATE held for its lifetime.
    await spawnUntil(
      [
        '-e',
        `const D = require(${JSON.stringify(BETTER_SQLITE)});
         const db = new D(process.env.PH_TEST_DB);
         db.exec('BEGIN IMMEDIATE');
         db.prepare("INSERT OR REPLACE INTO paris_hunter_meta VALUES ('holder','1')").run();
         console.log('HELD ' + db.inTransaction);
         setInterval(() => {}, 1000);`,
      ],
      'HELD true',
      { PH_TEST_DB: dbPath },
    );

    const probe = new Database(dbPath, { timeout: TOOL_BUSY_TIMEOUT_MS });
    const startedAt = Date.now();
    let caught = null;
    try {
      probe.prepare("INSERT OR REPLACE INTO paris_hunter_meta VALUES ('probe','1')").run();
    } catch (error) {
      caught = error;
    } finally {
      probe.close();
    }

    expect(caught).not.toBe(null);
    expect(isSqliteBusyError(caught)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(TOOL_BUSY_TIMEOUT_MS + 2000); // fast, not a hang
    const hinted = withReceiverHint(caught);
    expect(hinted.message).toContain('docker compose stop fredy');
    expect(hinted.cause).toBe(caught);
  }, 20_000);

  it('withReceiverHint passes non-busy errors through untouched', () => {
    const plain = new Error('boom');
    expect(withReceiverHint(plain)).toBe(plain);
    expect(isSqliteBusyError(plain)).toBe(false);
  });
});

describe('assertReceiverStopped (seed refuses to run alongside the receiver)', () => {
  it('throws while another PROCESS holds the adapter lock', async () => {
    const dataDir = mkTmp();
    await spawnUntil(
      [
        '--input-type=module',
        '-e',
        `const { acquireDataDirLock } = await import(${JSON.stringify(LOCK_MODULE)});
         acquireDataDirLock(process.env.PH_TEST_DATA_DIR);
         console.log('LOCKED');
         setInterval(() => {}, 1000);`,
      ],
      'LOCKED',
      { PH_TEST_DATA_DIR: dataDir },
    );

    await expect(assertReceiverStopped({ dataDir, probeUrl: null })).rejects.toThrow(RECEIVER_HINT);
  }, 20_000);

  it('passes when the lock file exists but is NOT held (receiver stopped)', async () => {
    const dataDir = mkTmp();
    acquireDataDirLock(dataDir);
    releaseDataDirLock(dataDir);
    expect(fs.existsSync(path.join(dataDir, LOCK_FILENAME))).toBe(true);

    await expect(assertReceiverStopped({ dataDir, probeUrl: null })).resolves.toBeUndefined();
  });

  it('passes when the data dir has no lock file, and never creates one', async () => {
    const dataDir = mkTmp();
    await expect(assertReceiverStopped({ dataDir, probeUrl: null })).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dataDir, LOCK_FILENAME))).toBe(false);
  });

  it('throws when the receiver answers the HTTP probe; passes when the port is closed', async () => {
    const server = http.createServer((request, response) => response.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const probeUrl = `http://127.0.0.1:${port}/`;

    await expect(assertReceiverStopped({ dataDir: null, probeUrl })).rejects.toThrow(RECEIVER_HINT);

    await new Promise((resolve) => server.close(resolve));
    await expect(assertReceiverStopped({ dataDir: null, probeUrl })).resolves.toBeUndefined();
  });
});

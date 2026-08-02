/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter test helper: a REAL better-sqlite3 in-memory database exposing
 * the SqliteConnection static API, with migrations 22 and 23 applied. Lane-2
 * tests exercise true transactional semantics (CAS completion, per-row atomic
 * decision tx) instead of SQL-string assertions.
 *
 * Usage (per test file):
 *   const holder = vi.hoisted(() => ({ current: null }));
 *   vi.mock('<path>/SqliteConnection.js', () => mockSqliteConnection(holder));
 *   beforeEach(() => { holder.current = createMemorySqlite(); });
 */

import Database from 'better-sqlite3';
import { up } from '../../../lib/services/storage/migrations/sql/22.paris-hunter.js';
import { up as upEmailInbox } from '../../../lib/services/storage/migrations/sql/23.email-inbox.js';

export const createMemorySqlite = () => {
  const db = new Database(':memory:');
  up(db);
  upEmailInbox(db);
  return {
    raw: db,
    getConnection: () => db,
    execute: (sql, params = {}) => db.prepare(sql).run(params),
    query: (sql, params = {}) => db.prepare(sql).all(params),
    tableExists: (name) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null,
    withTransaction: (callback) => db.transaction((cb) => cb(db))(callback),
  };
};

/**
 * Builds the module factory for vi.mock of SqliteConnection.js, delegating to
 * whatever `holder.current` points at (fresh per test via beforeEach).
 */
export const mockSqliteConnection = (holder) => ({
  default: {
    init: async () => {},
    getConnection: () => holder.current.getConnection(),
    execute: (sql, params) => holder.current.execute(sql, params),
    query: (sql, params) => holder.current.query(sql, params),
    tableExists: (name) => holder.current.tableExists(name),
    withTransaction: (callback) => holder.current.withTransaction(callback),
    optimize: () => {},
    close: () => {},
  },
  computeDbPath: async () => ({ dir: '/tmp', dbPath: '/tmp/listings.db' }),
});

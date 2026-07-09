/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: Stream Estate item-budget guard (build plan v2 #13, v3 A7).
 *
 * The usage counter ('usage:<YYYY-MM>' in paris_hunter_meta) is incremented
 * ATOMICALLY inside the same transaction as the inbox insert (inbox.js calls
 * recordUsageInTx) — counter and rows can never diverge. When the counter
 * crosses PH_MONTHLY_ITEM_BUDGET × BUDGET_HEADROOM, 'disable_required' is
 * persisted in that SAME transaction; the enforcement loop then disables the
 * saved search server-side (PUT notificationEnabled:false) and only clears the
 * flag after a GET confirms the search is OFF. Ingest continues past the
 * ceiling — only server-side delivery is shut off.
 *
 * NOTE: this module deliberately does NOT import inbox.js (no import cycle);
 * meta access uses SqliteConnection directly.
 *
 * LIVE PATH: enforceBudgetDisable() calls the Stream Estate API. It only ever
 * runs when 'disable_required' has been persisted (budget ceiling crossed in a
 * live deployment) — it is unreachable in offline tests/dev unless the flag is
 * planted. Search-management calls are not item-billed per recon, but the whole
 * path stays behind the go-live checklist regardless.
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';
import { buildPhConfig, PH } from './phConfig.js';

/**
 * Headroom factor: auto-disable acts at budget × headroom (v3 A7). Code
 * constant, overridable via PH_BUDGET_HEADROOM (deliberately NOT in the frozen
 * .env.example — documented in the build plan only).
 */
export const BUDGET_HEADROOM = 0.9;
/** Warn threshold as a fraction of the full budget. */
export const WARN_RATIO = 0.7;

const MONITOR_INTERVAL_MS = 60_000;
const DAILY_SUMMARY_MS = 24 * 60 * 60 * 1000;
export const DISABLE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Stream Estate API base. STREAM_ESTATE_API_BASE overrides for QA (lane 6's
 * mock server drives the budget disable drill against it); defaults to the
 * real production base.
 *
 * @returns {string}
 */
export const streamEstateApiBase = () =>
  (process.env.STREAM_ESTATE_API_BASE ?? 'https://api.stream.estate').replace(/\/+$/, '');

/** @returns {number} effective headroom factor (env override or code default) */
export const budgetHeadroom = (env = process.env) => {
  const raw = Number(env.PH_BUDGET_HEADROOM);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : BUDGET_HEADROOM;
};

/** @param {number} [nowMs] @returns {string} meta key for the current month */
export const usageKeyFor = (nowMs = Date.now()) => `usage:${new Date(nowMs).toISOString().slice(0, 7)}`;

/** Integer item count at which delivery must be disabled. */
export const budgetThreshold = (env = process.env) =>
  Math.ceil(buildPhConfig(env).monthlyItemBudget * budgetHeadroom(env));

/** Confirmation version changes with the month or effective threshold. */
const budgetVersion = (nowMs = Date.now(), env = process.env) =>
  `${usageKeyFor(nowMs)}:threshold=${budgetThreshold(env)}`;

const getMetaOn = (db, key) => {
  const row = db.prepare('SELECT value FROM paris_hunter_meta WHERE key = @key').get({ key });
  return row?.value ?? null;
};

const setMetaOn = (db, key, value) => {
  db.prepare(
    'INSERT INTO paris_hunter_meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value',
  ).run({ key, value });
};

/**
 * Atomic usage increment + threshold bookkeeping. MUST be called inside the
 * inbox-insert transaction with the raw better-sqlite3 handle (v3 A7).
 *
 * @param {import('better-sqlite3').Database} db raw handle inside the open tx
 * @param {number} nowMs
 * @returns {number} the counter value after the increment
 */
export const recordUsageInTx = (db, nowMs) => {
  const key = usageKeyFor(nowMs);
  db.prepare(
    "INSERT INTO paris_hunter_meta (key, value) VALUES (@key, '1') " +
      'ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)',
  ).run({ key });
  const count = Number(getMetaOn(db, key));

  const ceiling = buildPhConfig().monthlyItemBudget;
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    return count;
  }

  const warnAt = Math.ceil(ceiling * WARN_RATIO);
  if (count === warnAt) {
    logger.warn(
      `paris-hunter budget: usage ${count}/${ceiling} items this month (>= ${Math.round(WARN_RATIO * 100)}%) — approaching PH_MONTHLY_ITEM_BUDGET.`,
    );
  }

  if (count >= budgetThreshold()) {
    const alreadyRequired = getMetaOn(db, 'disable_required') != null;
    const confirmed = getMetaOn(db, 'disable_confirmed');
    const confirmedForThreshold = typeof confirmed === 'string' && confirmed.startsWith(`${budgetVersion(nowMs)}:`);
    if (!alreadyRequired && !confirmedForThreshold) {
      setMetaOn(db, 'disable_required', '1');
      logger.error(
        `paris-hunter budget: usage ${count} crossed ${ceiling} × ${budgetHeadroom()} headroom — disable_required persisted; the budget monitor will disable the saved search server-side.`,
      );
    }
  }
  return count;
};

/**
 * @deprecated superseded by v3 A7 — the usage counter is incremented inside the
 * inbox-insert transaction (recordUsageInTx). Kept as a no-op for the lane-1
 * stub contract; calling it never double-counts.
 * @returns {void}
 */
export const recordItem = () => {};

/**
 * Refuse enablement when it would immediately violate the effective budget.
 * Returns the values for operator-facing reporting and tests.
 */
export const assertBudgetAllowsEnable = ({ env = process.env, nowMs = Date.now() } = {}) => {
  const db = SqliteConnection.getConnection();
  const usage = Number(getMetaOn(db, usageKeyFor(nowMs)) ?? 0);
  const threshold = budgetThreshold(env);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error('PH_MONTHLY_ITEM_BUDGET must produce a positive effective threshold');
  }
  if (usage >= threshold) {
    throw new Error(
      `current usage ${usage} is already at or above the effective budget threshold ${threshold} — raise PH_MONTHLY_ITEM_BUDGET before enabling notifications`,
    );
  }
  return { usage, threshold };
};

/** Clear the old disable confirmation only after remote enable was GET-verified. */
export const confirmBudgetReenabled = () => {
  SqliteConnection.execute("DELETE FROM paris_hunter_meta WHERE key = 'disable_confirmed'");
};

const fetchWithTimeout = async (fetchImpl, url, options, label, timeoutMs, readJson = true) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${label} returned ${response.status}`);
    }
    return readJson ? await response.json() : null;
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Enforcement step (v3 A7): while 'disable_required' is set, PUT the canonical
 * search to notificationEnabled:false, GET-verify, and only then persist
 * 'disable_confirmed' and clear the flag. Any failure keeps the flag so the
 * next tick retries. Exported for tests.
 *
 * @param {{ fetchImpl?: typeof fetch, nowMs?: number, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>} true when the disable was verified this call
 */
const enforceBudgetDisableOnce = async ({
  fetchImpl = fetch,
  nowMs = Date.now(),
  timeoutMs = DISABLE_REQUEST_TIMEOUT_MS,
} = {}) => {
  const db = SqliteConnection.getConnection();
  if (getMetaOn(db, 'disable_required') !== '1') {
    return false;
  }
  const searchId = getMetaOn(db, 'searchId');
  const apiKey = process.env.STREAM_ESTATE_API_KEY;
  if (searchId == null || apiKey == null || apiKey === '') {
    logger.error(
      'paris-hunter budget: disable_required set but searchId/STREAM_ESTATE_API_KEY missing — cannot disable; will retry.',
    );
    return false;
  }
  const searchPath = searchId.startsWith('/') ? searchId : `/searches/${searchId}`;
  const url = `${streamEstateApiBase()}${searchPath}`;
  const headers = { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' };
  try {
    // LIVE Stream Estate calls (search management — reached only past the budget ceiling).
    const body = await fetchWithTimeout(fetchImpl, url, { headers }, 'GET search', timeoutMs);
    await fetchWithTimeout(
      fetchImpl,
      url,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ ...body, notificationEnabled: false }),
      },
      'PUT search',
      timeoutMs,
      false,
    );
    const verified = await fetchWithTimeout(fetchImpl, url, { headers }, 'verify GET', timeoutMs);
    if (verified?.notificationEnabled !== false) {
      throw new Error('verify GET still reports notificationEnabled != false');
    }
    SqliteConnection.withTransaction((txDb) => {
      setMetaOn(txDb, 'disable_confirmed', `${budgetVersion(nowMs)}:${nowMs}`);
      txDb.prepare("DELETE FROM paris_hunter_meta WHERE key = 'disable_required'").run();
    });
    logger.error(
      'paris-hunter budget: saved search DISABLED server-side (budget ceiling) — verified OFF via GET. Raise PH_MONTHLY_ITEM_BUDGET and re-enable via bootstrap.js --enable-notifications.',
    );
    return true;
  } catch (error) {
    logger.error(
      `paris-hunter budget: disable attempt failed (${error.message}) — disable_required kept, retrying next tick.`,
    );
    return false;
  }
};

let disableRun = null;
let trailingRequested = false;
let trailingOptions = null;

/**
 * Serialized enforcement with trailing coalescing. Concurrent timer/webhook
 * triggers never overlap; at least one trailing attempt runs after the active
 * request settles (including after an abort timeout).
 *
 * @param {{ fetchImpl?: typeof fetch, nowMs?: number, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>} whether any coalesced attempt verified disable
 */
export const enforceBudgetDisable = (options = {}) => {
  if (disableRun != null) {
    trailingRequested = true;
    trailingOptions = options;
    return disableRun;
  }
  disableRun = (async () => {
    let verified = false;
    let currentOptions = options;
    do {
      trailingRequested = false;
      verified = (await enforceBudgetDisableOnce(currentOptions)) || verified;
      currentOptions = trailingOptions ?? currentOptions;
      trailingOptions = null;
    } while (trailingRequested);
    return verified;
  })().finally(() => {
    disableRun = null;
  });
  return disableRun;
};

let monitorTimer = null;
let summaryTimer = null;

const logDailySummary = () => {
  try {
    const rows = SqliteConnection.query(
      "SELECT decision, COUNT(1) AS c FROM stream_estate_inbox WHERE decision LIKE 'quarantine:%' OR decision LIKE 'dead-letter:%' GROUP BY decision",
    );
    const usage = SqliteConnection.query('SELECT value FROM paris_hunter_meta WHERE key = @key', {
      key: usageKeyFor(),
    })[0]?.value;
    const parts = rows.map((r) => `${r.decision}=${r.c}`).join(', ');
    logger.info(
      `paris-hunter daily summary: usage ${usage ?? 0}/${PH.monthlyItemBudget} — ${parts || 'no quarantine/dead-letter rows'}`,
    );
  } catch (error) {
    logger.warn(`paris-hunter daily summary failed: ${error.message}`);
  }
};

/**
 * Budget monitor (v3 A7 enforcement loop): runs the enforcement step at boot
 * and every 60 s, plus a daily quarantine/dead-letter summary. Idempotent.
 *
 * @returns {void}
 */
export const startBudgetMonitor = () => {
  if (monitorTimer != null) {
    return;
  }
  void enforceBudgetDisable().catch((error) => logger.error(`paris-hunter budget monitor: ${error.message}`));
  monitorTimer = setInterval(() => {
    void enforceBudgetDisable().catch((error) => logger.error(`paris-hunter budget monitor: ${error.message}`));
  }, MONITOR_INTERVAL_MS);
  monitorTimer.unref?.();
  summaryTimer = setInterval(logDailySummary, DAILY_SUMMARY_MS);
  summaryTimer.unref?.();
};

/** Test/shutdown helper: stops the monitor timers. @returns {void} */
export const stopBudgetMonitor = () => {
  if (monitorTimer != null) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  if (summaryTimer != null) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
};

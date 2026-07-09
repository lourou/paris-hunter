/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: inbox watchdog (build plan v2 #2, v3 A2/A3).
 *
 * The undone inbox rows themselves are the durable dirty flag: this covers
 * dropped 'jobs:runOne' emits (upstream skips them while isRunning) AND
 * crashed-run leases.
 *
 * - FIRST action: recoverDeadLeases() — dead-boot recovery lives here so the
 *   lane-1-owned init.js needs no edit (v3 flag resolution).
 * - Immediate retrigger: on 'jobs:status' running:false for our job, re-emit
 *   'jobs:runOne' when claimable rows exist — a webhook that landed mid-run is
 *   picked up in ~0 s instead of 15 s (v3 A3).
 * - 15 s poll stays as the backstop.
 * - SIGTERM: orderly lease release (v3 A2).
 */

import { bus } from '../events/event-bus.js';
import logger from '../logger.js';
import { PH } from './phConfig.js';
import { countClaimable, recoverDeadLeases, releaseLeases } from './inbox.js';

const POLL_INTERVAL_MS = 15_000;

let timer = null;
let statusListener = null;
let sigtermListener = null;

const emitRunOne = () => {
  try {
    if (countClaimable() > 0) {
      bus.emit('jobs:runOne', { jobId: PH.jobId });
    }
  } catch (error) {
    logger.warn(`paris-hunter watchdog: ${error.message}`);
  }
};

/**
 * Starts the watchdog. Idempotent.
 * @returns {void}
 */
export const startInboxWatchdog = () => {
  if (timer != null) {
    return;
  }

  // v3 A2/A12: dead-boot recovery MUST run before anything can claim.
  try {
    recoverDeadLeases();
  } catch (error) {
    logger.error(`paris-hunter watchdog: dead-lease recovery failed — ${error.message}`);
  }

  statusListener = ({ jobId, running }) => {
    if (running === false && jobId === PH.jobId) {
      emitRunOne();
    }
  };
  bus.on('jobs:status', statusListener);

  timer = setInterval(emitRunOne, POLL_INTERVAL_MS);
  timer.unref?.();

  sigtermListener = () => {
    try {
      releaseLeases();
    } catch {
      // shutting down — nothing useful to do
    }
  };
  process.once('SIGTERM', sigtermListener);
};

/**
 * Test/shutdown helper: stops the timer and detaches listeners.
 * @returns {void}
 */
export const stopInboxWatchdog = () => {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
  if (statusListener != null) {
    bus.off('jobs:status', statusListener);
    statusListener = null;
  }
  if (sigtermListener != null) {
    process.off('SIGTERM', sigtermListener);
    sigtermListener = null;
  }
};

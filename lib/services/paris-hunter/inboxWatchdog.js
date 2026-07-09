/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: inbox watchdog (build plan v2 #2).
 *
 * STUB (lane 1) — real implementation is owned by lane 2:
 *   every 15 s: countPending() > 0 -> bus.emit('jobs:runOne', { jobId }).
 *   The undone inbox rows themselves are the durable dirty flag — this covers
 *   dropped 'jobs:runOne' emits (upstream skips them while isRunning) AND
 *   crashed-run leases (5-min lease expiry).
 *
 * @returns {void}
 */
export const startInboxWatchdog = () => {
  // TODO(lane 2): 15 s interval, re-emit while undone+unleased rows exist.
};

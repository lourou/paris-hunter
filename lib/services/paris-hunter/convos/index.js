/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: convos adapter runtime entry points (build plan v2 #4/#5).
 *
 * STUB (lane 1) — real implementation is owned by lane 3:
 *   initConvosAdapter(): lock -> identity -> client -> health/join (background,
 *   non-blocking) -> bus.on('convos:flush', flushOutbox) -> 60 s flush timer ->
 *   daily sweepRetention() when store=local. Called ONLY by initParisHunter()
 *   (no module-top-level side effects).
 *   whenReady(): shared readiness promise awaited by all send paths; rejection =
 *   degraded mode, outbox rows stay queued.
 *   flushOutbox(): singleton drain of convos_outbox with persisted per-message
 *   states (pending -> sending -> sent); NO idempotencyKey exists on node-sdk
 *   6.0.0 — sendText takes a BOOLEAN second arg, never pass an options object.
 */

/** @returns {Promise<void>} */
export const initConvosAdapter = async () => {
  // TODO(lane 3): implement per build plan v2 lane 3.
};

/** @returns {Promise<void>} */
export const whenReady = () => {
  // TODO(lane 3): shared readiness promise (resolved stub keeps callers safe —
  // flushOutbox below is a no-op until lane 3 lands).
  return Promise.resolve();
};

/** @returns {Promise<void>} */
export const flushOutbox = async () => {
  // TODO(lane 3): drain convos_outbox (exactly-once via outbox PK + states).
};

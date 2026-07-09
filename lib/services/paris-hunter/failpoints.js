/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: deterministic failpoints for crash-recovery QA (build plan v2 #14).
 * Inert unless PH_FAILPOINT is set (QA only — never in production). Known names:
 * after_inbox_insert | after_claim | after_decision_tx | after_upload |
 * after_image_send | after_text_send.
 *
 * @param {string} name
 */
export const failpoint = (name) => {
  if (process.env.PH_FAILPOINT === name) {
    console.error('FAILPOINT ' + name);
    process.exit(137);
  }
};

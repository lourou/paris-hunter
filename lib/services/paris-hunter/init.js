/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: explicit boot initializer (build plan v2 #2/#4/#13/#17).
 * Called from index.js AFTER runMigrations(), before the API is imported.
 * No paris-hunter module may have top-level side effects — everything starts here.
 *
 * Order: env fail-fast validation (boot-fatal) → inbox watchdog → convos adapter
 * init (fire-and-log, join must NOT block Fredy boot) → budget monitor.
 */

import logger from '../logger.js';
import { PH, assertValidSecret, assertHttpsBaseUrl } from './phConfig.js';
import { startInboxWatchdog } from './inboxWatchdog.js';
import { startBudgetMonitor } from './budget.js';
import { initConvosAdapter } from './convos/index.js';

/**
 * Boot-fatal when the paris-hunter env is invalid (unless PARIS_HUNTER_ENABLED=false).
 * Secrets are never printed — assert helpers throw secret-free messages.
 *
 * @returns {Promise<void>}
 */
export const initParisHunter = async () => {
  // Upstream test suites must stay side-effect-free (vitest sets TEST_MODE).
  if (process.env.TEST_MODE) {
    return;
  }
  if (process.env.PARIS_HUNTER_ENABLED === 'false') {
    logger.info('paris-hunter: disabled via PARIS_HUNTER_ENABLED=false — skipping init.');
    return;
  }

  try {
    assertValidSecret();
    if (process.env.NODE_ENV === 'production') {
      assertHttpsBaseUrl();
    }
    if ((process.env.ATTACHMENT_STORE ?? 's3') === 's3') {
      const missing = ['SCW_S3_ENDPOINT', 'SCW_S3_REGION', 'SCW_S3_BUCKET', 'SCW_ACCESS_KEY', 'SCW_SECRET_KEY'].filter(
        (key) => process.env[key] == null || process.env[key].trim() === '',
      );
      if (missing.length > 0) {
        throw new Error(
          `ATTACHMENT_STORE=s3 requires Scaleway credentials — missing env: ${missing.join(', ')} ` +
            '(see .env.example; or set ATTACHMENT_STORE=local for dev/QA).',
        );
      }
    }
  } catch (error) {
    logger.error(`paris-hunter: invalid environment — ${error.message}`);
    process.exit(1);
  }

  startInboxWatchdog();

  if (PH.convosEnabled) {
    // Fire and log: identity/client/join run in the background and must never
    // block Fredy boot. Failures degrade the adapter; outbox rows stay queued.
    initConvosAdapter().catch((error) => {
      logger.error(`paris-hunter: convos adapter init failed — ${error.message}`);
    });
  } else {
    logger.info('paris-hunter: convos adapter disabled (CONVOS_ENABLED != true).');
  }

  startBudgetMonitor();

  logger.info('paris-hunter: initialized (watchdog, budget monitor, convos adapter).');
};

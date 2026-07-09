/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it, vi } from 'vitest';

const order = vi.hoisted(() => []);

vi.mock('../../../lib/services/paris-hunter/phConfig.js', () => ({
  PH: { convosEnabled: true },
  assertValidSecret: vi.fn(),
  assertHttpsBaseUrl: vi.fn(),
}));
vi.mock('../../../lib/services/paris-hunter/convos/index.js', () => ({
  initConvosAdapter: vi.fn(() => {
    order.push('adapter-lock');
    return Promise.resolve();
  }),
}));
vi.mock('../../../lib/services/paris-hunter/inboxWatchdog.js', () => ({
  startInboxWatchdog: vi.fn(() => order.push('dead-lease-recovery')),
}));
vi.mock('../../../lib/services/paris-hunter/budget.js', () => ({
  startBudgetMonitor: vi.fn(),
}));
vi.mock('../../../lib/services/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initParisHunter } from '../../../lib/services/paris-hunter/init.js';

describe('paris-hunter init ordering', () => {
  it('acquires the adapter lock before dead-lease recovery', async () => {
    const savedTestMode = process.env.TEST_MODE;
    const savedAttachmentStore = process.env.ATTACHMENT_STORE;
    delete process.env.TEST_MODE;
    process.env.ATTACHMENT_STORE = 'local';
    order.length = 0;

    try {
      await initParisHunter();

      expect(order).toEqual(['adapter-lock', 'dead-lease-recovery']);
    } finally {
      if (savedTestMode == null) {
        delete process.env.TEST_MODE;
      } else {
        process.env.TEST_MODE = savedTestMode;
      }
      if (savedAttachmentStore == null) {
        delete process.env.ATTACHMENT_STORE;
      } else {
        process.env.ATTACHMENT_STORE = savedAttachmentStore;
      }
    }
  });
});

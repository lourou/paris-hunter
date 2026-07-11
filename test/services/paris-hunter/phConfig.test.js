/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import { buildPhConfig, assertValidSecret, assertHttpsBaseUrl } from '../../../lib/services/paris-hunter/phConfig.js';

describe('paris-hunter phConfig', () => {
  it('applies defaults on an empty env', () => {
    const ph = buildPhConfig({});
    expect(ph.zips).toEqual(['75009', '75010', '75011', '75012', '75013', '75017', '75020']);
    expect(ph.budgetHcMin).toBe(2000);
    expect(ph.budgetHcMax).toBe(3100);
    // Server band deliberately wider than the notify band (see phConfig.js).
    expect(ph.serverBudgetMin).toBe(1900);
    expect(ph.serverBudgetMax).toBe(3350);
    expect(ph.roomsMin).toBe(3);
    expect(ph.roomsMax).toBe(4);
    expect(ph.monthlyItemBudget).toBe(900);
    expect(ph.capTableOverride).toBeNull();
    expect(ph.webhookSecret).toBeNull();
    expect(ph.jobId).toBe('paris-hunter');
  });

  it('reads overrides from env', () => {
    const ph = buildPhConfig({
      PH_ZIPS: '75010, 75020',
      PH_BUDGET_HC_MIN: '1000',
      PH_MONTHLY_ITEM_BUDGET: '3',
      PH_CAP_TABLE_JSON: '{"75011":34}',
      CONVOS_ENABLED: 'true',
      FREDY_SKIP_CHROMIUM: 'true',
    });
    expect(ph.zips).toEqual(['75010', '75020']);
    expect(ph.budgetHcMin).toBe(1000);
    expect(ph.monthlyItemBudget).toBe(3);
    expect(ph.capTableOverride).toEqual({ 75011: 34 });
    expect(ph.convosEnabled).toBe(true);
    expect(ph.skipChromium).toBe(true);
  });

  it('ignores invalid PH_CAP_TABLE_JSON instead of throwing', () => {
    const ph = buildPhConfig({ PH_CAP_TABLE_JSON: '{not-json' });
    expect(ph.capTableOverride).toBeNull();
  });

  it('assertValidSecret rejects missing/short secrets without leaking the value', () => {
    expect(() => assertValidSecret(null)).toThrow(/32 characters/);
    expect(() => assertValidSecret('shortsecret')).toThrow(/STREAM_ESTATE_WEBHOOK_SECRET/);
    try {
      assertValidSecret('shortsecret');
    } catch (error) {
      expect(error.message).not.toContain('shortsecret');
    }
    expect(() => assertValidSecret('a'.repeat(32))).not.toThrow();
  });

  it('assertHttpsBaseUrl requires an https URL', () => {
    expect(() => assertHttpsBaseUrl(undefined)).toThrow(/https/);
    expect(() => assertHttpsBaseUrl('http://hunter.example.com')).toThrow(/https/);
    expect(() => assertHttpsBaseUrl('https://hunter.example.com')).not.toThrow();
  });
});

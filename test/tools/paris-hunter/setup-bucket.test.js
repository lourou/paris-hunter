/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import {
  mergeLifecycleRules,
  PH_RULE_ID,
  PH_RULE_ID_PREFIX,
  PH_PREFIX,
  RETENTION_DAYS,
} from '../../../tools/paris-hunter/setup-bucket.js';

describe('setup-bucket mergeLifecycleRules', () => {
  it('exposes the 180-day rule constants', () => {
    expect(PH_RULE_ID).toBe('ph-attachments-180d');
    expect(PH_RULE_ID.startsWith(PH_RULE_ID_PREFIX)).toBe(true);
    expect(RETENTION_DAYS).toBe(180);
    expect(PH_PREFIX).toBe('attachments/');
  });

  it('adds our rule to an empty bucket (no NoncurrentVersionExpiration when unversioned)', () => {
    const merged = mergeLifecycleRules([], false);
    expect(merged).toEqual([
      {
        ID: PH_RULE_ID,
        Status: 'Enabled',
        Filter: { Prefix: PH_PREFIX },
        Expiration: { Days: RETENTION_DAYS },
      },
    ]);
  });

  it('adds NoncurrentVersionExpiration iff versioning is enabled', () => {
    const merged = mergeLifecycleRules([], true);
    expect(merged).toHaveLength(1);
    expect(merged[0].NoncurrentVersionExpiration).toEqual({ NoncurrentDays: RETENTION_DAYS });
  });

  it('REMOVES the superseded ph-attachments-30d rule (shorter expiry must not survive)', () => {
    const oldRule = {
      ID: 'ph-attachments-30d',
      Status: 'Enabled',
      Filter: { Prefix: 'attachments/' },
      Expiration: { Days: 30 },
    };
    const merged = mergeLifecycleRules([oldRule], false);
    const phRules = merged.filter((rule) => rule.ID.startsWith(PH_RULE_ID_PREFIX));
    expect(phRules).toHaveLength(1);
    expect(phRules[0].ID).toBe(PH_RULE_ID);
    expect(phRules[0].Expiration).toEqual({ Days: RETENTION_DAYS });
  });

  it('is idempotent: re-merging replaces our current rule without duplicating it', () => {
    const once = mergeLifecycleRules([], true);
    const twice = mergeLifecycleRules(once, true);
    expect(twice).toEqual(once);
  });

  it('preserves foreign rules verbatim (including ID-less rules)', () => {
    const foreign = {
      ID: 'backup-cleanup',
      Status: 'Enabled',
      Filter: { Prefix: 'backups/' },
      Expiration: { Days: 7 },
    };
    const idless = { Status: 'Disabled', Filter: { Prefix: 'misc/' }, Expiration: { Days: 1 } };
    const oldRule = { ID: 'ph-attachments-30d', Status: 'Enabled', Filter: { Prefix: 'attachments/' } };
    const merged = mergeLifecycleRules([foreign, idless, oldRule], false);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toBe(foreign); // verbatim, same reference
    expect(merged[1]).toBe(idless);
    expect(merged[2].ID).toBe(PH_RULE_ID);
  });
});

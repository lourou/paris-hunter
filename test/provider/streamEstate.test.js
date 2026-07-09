/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { mockFredy } from '../utils.js';
import { get as getNotification } from '../mocks/mockNotification.js';
import { createMemorySqlite, mockSqliteConnection } from '../services/paris-hunter/memoryDb.js';

const holder = vi.hoisted(() => ({ current: null }));
const flags = vi.hoisted(() => ({ breakBuildMessage: false }));

vi.hoisted(() => {
  process.env.STREAM_ESTATE_WEBHOOK_SECRET = 'f'.repeat(48);
  process.env.PUBLIC_BASE_URL = 'https://hunter.test';
});

vi.mock('../../lib/services/storage/SqliteConnection.js', () => mockSqliteConnection(holder));
// Passthrough with a controllable failure — drives the A8 attempts/dead-letter path.
vi.mock('../../lib/services/paris-hunter/messageFormat.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    buildMessage: (listing) => {
      if (flags.breakBuildMessage) {
        throw new Error('boom');
      }
      return actual.buildMessage(listing);
    },
  };
});

import * as provider from '../../lib/provider/streamEstate.js';
import { insertInbox, setParisHunterMeta, toEpochMs } from '../../lib/services/paris-hunter/inbox.js';
import { currentConfigRev } from '../../lib/services/paris-hunter/searchConfig.js';
import { getProviders } from '../../lib/utils.js';

const UUID1 = '11111111-1111-4111-8111-111111111111';
const fixture = (name) => JSON.parse(readFileSync(new URL(`../mocks/streamEstate/${name}`, import.meta.url), 'utf-8'));

const MATCH_EVENT_AT = toEpochMs('2026-07-08T10:00:05+02:00');
const DROP_EVENT_AT = toEpochMs('2026-07-08T12:00:00+02:00');

const insertFixture = (name, { kind = name.startsWith('event') ? 'event' : 'match', eventAt, payload } = {}) => {
  const body = payload ?? fixture(name);
  const resolvedEventAt =
    eventAt !== undefined ? eventAt : kind === 'match' ? toEpochMs(body.createdAt) : toEpochMs(body.adEvent?.createdAt);
  const externalId = kind === 'match' ? body.propertyDocument?.uuid : body.match?.propertyDocument?.uuid;
  return insertInbox({ kind, externalId: externalId ?? null, payload: JSON.stringify(body), eventAt: resolvedEventAt });
};

/** Seeds a VALID watermark bound to the current search identity (v3 A5). */
const seedGate = ({ cutoffMs = MATCH_EVENT_AT - 60_000, searchId = '/searches/1', configRev } = {}) => {
  setParisHunterMeta('searchId', searchId);
  setParisHunterMeta('seededAt', String(Date.now()));
  setParisHunterMeta(
    'notifyWatermark',
    JSON.stringify({ cutoffMs, searchId, configRev: configRev ?? currentConfigRev() }),
  );
};

const decisions = () =>
  holder.current.query('SELECT id, decision, error, attempts FROM stream_estate_inbox ORDER BY id');
const outboxRows = () => holder.current.query('SELECT * FROM convos_outbox ORDER BY id');
const seenCount = () => holder.current.query('SELECT COUNT(1) AS c FROM ph_seen')[0].c;

beforeEach(() => {
  holder.current = createMemorySqlite();
  flags.breakBuildMessage = false;
  provider.init({ id: 'streamEstate', url: 'inbox://stream-estate', enabled: true }, []);
});

describe('provider discovery + module contract (v2 #7)', () => {
  it('is discovered by the REAL getProviders()', async () => {
    const providers = await getProviders();
    const found = providers.find((p) => p.metaInformation?.id === 'streamEstate');
    expect(found).toBeTruthy();
    expect(typeof found.init).toBe('function');
    expect(typeof found.config.getListings).toBe('function');
    expect(typeof found.config.normalize).toBe('function');
    expect(typeof found.config.filter).toBe('function');
    expect(found.config.requiredFieldNames).toEqual(['id', 'link', 'title']);
  });
});

describe('decision tx — replay / dedup semantics (v2 #1/#8)', () => {
  it('outboxes a fresh in-band match exactly once', async () => {
    seedGate();
    insertFixture('match.json');

    const raws = await provider.config.getListings();

    expect(decisions()).toHaveLength(1);
    expect(decisions()[0].decision).toBe('outboxed');
    const outbox = outboxRows();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].id).toBe(`se:${UUID1}`);
    expect(outbox[0].kind).toBe('match');
    expect(outbox[0].image_url).toMatch(/^https:\/\//);
    expect(outbox[0].text.length).toBeGreaterThan(10);
    expect(seenCount()).toBe(1);
    expect(raws).toHaveLength(1);
  });

  it('replay 3× → decisions outboxed, duplicate, duplicate and ONE outbox row (tx layer)', async () => {
    seedGate();
    insertFixture('match.json');
    insertFixture('match.json');
    insertFixture('match.json');

    await provider.config.getListings();

    expect(decisions().map((r) => r.decision)).toEqual(['outboxed', 'duplicate', 'duplicate']);
    expect(outboxRows()).toHaveLength(1);
    expect(seenCount()).toBe(1);
  });

  it('drains until empty across claim batches (v3 A3) — 210 rows in one run', async () => {
    seedGate();
    for (let i = 0; i < 210; i += 1) {
      insertFixture('match.json');
    }

    await provider.config.getListings();

    const rows = decisions();
    expect(rows).toHaveLength(210);
    expect(rows.every((r) => r.decision != null)).toBe(true);
    expect(rows.filter((r) => r.decision === 'outboxed')).toHaveLength(1);
    expect(outboxRows()).toHaveLength(1);
  });
});

describe('watermark gate boundaries (v3 A4/A5)', () => {
  it('event_at === cutoffMs → suppressed:watermark', async () => {
    seedGate({ cutoffMs: MATCH_EVENT_AT });
    insertFixture('match.json');
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe('suppressed:watermark');
    expect(outboxRows()).toHaveLength(0);
  });

  it('event_at === cutoffMs + 1 → suppressed; cutoffMs - 1 → notifies', async () => {
    seedGate({ cutoffMs: MATCH_EVENT_AT + 1 });
    insertFixture('match.json');
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe('suppressed:watermark');

    holder.current = createMemorySqlite();
    seedGate({ cutoffMs: MATCH_EVENT_AT - 1 });
    insertFixture('match.json');
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe('outboxed');
  });

  it('missing/invalid ingress timestamp → suppressed:invalid-timestamp, no seen, no outbox', async () => {
    seedGate();
    insertFixture('match.json', { eventAt: null });
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe('suppressed:invalid-timestamp');
    expect(seenCount()).toBe(0);
    expect(outboxRows()).toHaveLength(0);
  });

  it('no watermark at all → suppressed:unseeded (fail-silent)', async () => {
    insertFixture('match.json');
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe('suppressed:unseeded');
    expect(outboxRows()).toHaveLength(0);
  });

  it('watermark minted for another configRev → suppressed:unseeded (v3 A5 binding)', async () => {
    seedGate({ configRev: 'deadbeef'.repeat(8) });
    insertFixture('match.json');
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe('suppressed:unseeded');
  });

  it('watermark minted for another searchId → suppressed:unseeded', async () => {
    setParisHunterMeta('searchId', '/searches/2');
    setParisHunterMeta(
      'notifyWatermark',
      JSON.stringify({ cutoffMs: MATCH_EVENT_AT - 60_000, searchId: '/searches/1', configRev: currentConfigRev() }),
    );
    insertFixture('match.json');
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe('suppressed:unseeded');
  });

  it('malformed watermark JSON → suppressed:unseeded', async () => {
    setParisHunterMeta('searchId', '/searches/1');
    setParisHunterMeta('notifyWatermark', 'not json');
    insertFixture('match.json');
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe('suppressed:unseeded');
  });
});

describe('price events (v2 #8, v3 A9)', () => {
  it('price drop → outboxed under the canonical event-identity key', async () => {
    seedGate();
    insertFixture('event-price-drop.json');
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe('outboxed');
    expect(outboxRows()[0].id).toBe(`se:${UUID1}:price:${DROP_EVENT_AT}:2950->2850`);
    expect(outboxRows()[0].kind).toBe('price_drop');
  });

  it('webhook retry of the SAME event → identical key → duplicate', async () => {
    seedGate();
    insertFixture('event-price-drop.json');
    insertFixture('event-price-drop.json');
    await provider.config.getListings();
    expect(decisions().map((r) => r.decision)).toEqual(['outboxed', 'duplicate']);
    expect(outboxRows()).toHaveLength(1);
  });

  it('a later DISTINCT re-drop to a previously-seen price re-notifies (v3 A9)', async () => {
    seedGate();
    insertFixture('event-price-drop.json');
    const later = fixture('event-price-drop.json');
    later.adEvent.createdAt = '2026-07-08T18:00:00+02:00';
    insertFixture('event-price-drop.json', { payload: later });

    await provider.config.getListings();
    expect(decisions().map((r) => r.decision)).toEqual(['outboxed', 'outboxed']);
    expect(outboxRows()).toHaveLength(2);
  });

  it('match then price drop on the SAME property → exactly one re-notification', async () => {
    seedGate();
    insertFixture('match.json');
    insertFixture('event-price-drop.json');
    await provider.config.getListings();
    expect(decisions().map((r) => r.decision)).toEqual(['outboxed', 'outboxed']);
    expect(outboxRows()).toHaveLength(2);
  });

  it('price increase → skip:price_increase, never normalized, no seen row', async () => {
    seedGate();
    insertFixture('event-price-increase.json');
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe('skip:price_increase');
    expect(seenCount()).toBe(0);
    expect(outboxRows()).toHaveLength(0);
  });
});

describe('fail-closed hard filters (v2 #9)', () => {
  const expectDecision = async (name, expected, mutate) => {
    seedGate();
    const payload = fixture(name);
    if (mutate) {
      mutate(payload);
    }
    insertFixture(name, { payload });
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe(expected);
    expect(outboxRows()).toHaveLength(0);
  };

  it('meublé in the text → excluded:meuble', async () => {
    await expectDecision('match-meuble.json', 'excluded:meuble');
  });

  it('"non meublé" negation counter-case → notifies', async () => {
    seedGate();
    insertFixture('match-non-meuble.json');
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe('outboxed');
  });

  it('structured furnished:true → excluded:furnished (independent of the regex)', async () => {
    await expectDecision('match-furnished-true.json', 'excluded:furnished');
  });

  it('priceHc outside the band → excluded:band', async () => {
    await expectDecision('match-out-of-band.json', 'excluded:band');
  });

  it('zip not allowed → excluded:zip', async () => {
    await expectDecision('match.json', 'excluded:zip', (payload) => {
      payload.propertyDocument.city.zipcode = '75015';
    });
  });

  it('missing rooms → quarantine:rooms (seen, never notified)', async () => {
    await expectDecision('match-missing-rooms.json', 'quarantine:rooms');
    expect(seenCount()).toBe(1);
  });

  it('underivable price → quarantine:price', async () => {
    await expectDecision('match-missing-price.json', 'quarantine:price');
  });
});

describe('per-row exceptions + dead-letter (v3 A8)', () => {
  it('unparseable JSON payload → dead-letter immediately', async () => {
    seedGate();
    insertInbox({ kind: 'match', externalId: 'x', payload: 'not json {{', eventAt: MATCH_EVENT_AT });
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe('dead-letter:SyntaxError');
    expect(decisions()[0].error).toBeTruthy();
  });

  it('payload without a property uuid → dead-letter immediately (retries pointless)', async () => {
    seedGate();
    insertInbox({ kind: 'match', externalId: null, payload: '{}', eventAt: MATCH_EVENT_AT });
    await provider.config.getListings();
    expect(decisions()[0].decision).toBe('dead-letter:no-external-id');
  });

  it('a poison row retries with attempts and dead-letters at 5 WITHOUT aborting the batch', async () => {
    seedGate();
    insertFixture('match.json'); // poison target (buildMessage throws)
    const clean = fixture('match-non-meuble.json');
    insertFixture('match-non-meuble.json', { payload: clean });
    flags.breakBuildMessage = true;

    // buildMessage only runs for rows that reach the outbox insert; the clean
    // row also hits it, so break both, then verify the clean row survives as a
    // decision that never needed buildMessage.
    await provider.config.getListings();

    const rows = decisions();
    expect(rows[0].decision).toBe('dead-letter:Error');
    expect(rows[0].attempts).toBe(5);
    expect(rows[1].decision).toBe('dead-letter:Error');

    // ph_seen must NOT contain the poison keys (row-tx rolled back each time).
    expect(seenCount()).toBe(0);
    expect(outboxRows()).toHaveLength(0);

    // After the poison clears, a replayed row decides normally.
    flags.breakBuildMessage = false;
    insertFixture('match.json');
    await provider.config.getListings();
    expect(decisions()[2].decision).toBe('outboxed');
  });
});

describe('normalize + filter through the REAL Fredy pipeline (v2 #7/#8)', () => {
  const mockedJob = { id: 'paris-hunter', notificationAdapter: null, specFilter: null, spatialFilter: null };
  // Stateless stand-in: the real similarityCache keeps module state across tests
  // and would flag the second identical fixture as similar.
  const similarityCache = { checkAndAddEntry: () => false };

  it('unseeded deploy stores listings but notifies NOTHING (belt-and-braces)', async () => {
    insertFixture('match.json'); // no watermark, no seededAt
    const Fredy = await mockFredy();
    const fredy = new Fredy(provider.config, mockedJob, provider.metaInformation.id, similarityCache, undefined);
    await fredy.execute();
    expect(getNotification().payload).toBeUndefined();
    expect(decisions()[0].decision).toBe('suppressed:unseeded');
  });

  it('seeded run flows webhook → inbox → provider → outbox → notify handoff', async () => {
    seedGate();
    insertFixture('match.json');

    const Fredy = await mockFredy();
    const fredy = new Fredy(provider.config, mockedJob, provider.metaInformation.id, similarityCache, undefined);
    const listings = await fredy.execute();

    expect(listings).toHaveLength(1);
    expect(outboxRows()).toHaveLength(1);
    const notified = getNotification();
    expect(notified.serviceName).toBe('streamEstate');
    expect(notified.payload).toHaveLength(1);
    expect(notified.payload[0].ph.dedupKey).toBe(`se:${UUID1}`);
  });

  it('normalize(raw) rebuilds ParsedListing + ph and passes filter', async () => {
    seedGate();
    insertFixture('match.json');
    const raws = await provider.config.getListings();
    const listing = provider.config.normalize(raws[0]);

    expect(listing.id).toBe(`se:${UUID1}`);
    expect(listing.ph.kind).toBe('match');
    expect(listing.ph.priceHc).toBe(2700);
    expect(listing.ph.charges).toBe(150);
    expect(listing.ph.priceCc).toBe(2850);
    expect(listing.ph.surface).toBe(72);
    expect(listing.ph.rooms).toBe(3);
    expect(listing.ph.zipcode).toBe('75011');
    expect(listing.ph.phone).toBe('0612345678');
    expect(listing.ph.createdAtMs).toBe(MATCH_EVENT_AT);
    expect(Array.isArray(listing.ph.photoUrls)).toBe(true);
    expect(listing.ph.score).toBeTruthy();
    expect(listing.link).toMatch(/^https:\/\//);
    expect(provider.config.filter(listing)).toBe(true);
  });

  it('normalize of garbage raw degrades to a droppable listing (null id)', () => {
    const listing = provider.config.normalize({ kind: 'match', payload: {}, eventAt: MATCH_EVENT_AT });
    expect(listing.id).toBe(null);
  });
});

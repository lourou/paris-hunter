/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Real better-sqlite3, in-memory: the CAS/transaction semantics under test are
// real SQL semantics (v3 A6), not mocks. Schema = build plan v2 shared contract 3.
vi.mock('../../../lib/services/storage/SqliteConnection.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE convos_outbox (
      id TEXT PRIMARY KEY,
      dedup_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      image_url TEXT,
      enc_meta TEXT,
      image_state TEXT NOT NULL DEFAULT 'pending',
      text_state  TEXT NOT NULL DEFAULT 'pending',
      image_message_id TEXT, text_message_id TEXT,
      state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      last_error TEXT
    );
  `);
  return { default: { getConnection: () => db } };
});

vi.mock('../../../lib/services/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { default: SqliteConnection } = await import('../../../lib/services/storage/SqliteConnection.js');
const { default: logger } = await import('../../../lib/services/logger.js');
const {
  flushOutbox,
  setOutboxDeps,
  recoverSendingRows,
  casMessageState,
  remoteAttachmentFromEncMeta,
  isFlushRunning,
  __resetOutboxForTests,
} = await import('../../../lib/services/paris-hunter/convos/outbox.js');

const db = SqliteConnection.getConnection();

const insertRow = (overrides = {}) => {
  const row = {
    id: 'se:uuid-1',
    dedup_key: 'se:uuid-1',
    kind: 'match',
    text: '🏠 3P · 72 m² · 2 850 € HC',
    image_url: 'https://images.example.com/photo.jpg',
    enc_meta: null,
    image_state: 'pending',
    text_state: 'pending',
    state: 'queued',
    attempts: 0,
    created_at: Date.now(),
    ...overrides,
  };
  db.prepare(
    `INSERT INTO convos_outbox (id, dedup_key, kind, text, image_url, enc_meta, image_state, text_state, state, attempts, created_at)
     VALUES (@id, @dedup_key, @kind, @text, @image_url, @enc_meta, @image_state, @text_state, @state, @attempts, @created_at)`,
  ).run(row);
  return row;
};

const getRow = (id = 'se:uuid-1') => db.prepare('SELECT * FROM convos_outbox WHERE id = ?').get(id);

const fakeEncrypted = (content = 'ciphertext') => ({
  payload: Uint8Array.from(Buffer.from(content)),
  contentDigest: 'deadbeefcafebabe0123456789abcdef',
  secret: Uint8Array.from(Buffer.alloc(32, 1)),
  salt: Uint8Array.from(Buffer.alloc(32, 2)),
  nonce: Uint8Array.from(Buffer.alloc(12, 3)),
  contentLength: content.length,
});

const makeDeps = (overrides = {}) => {
  const conversation = { id: 'conv-1' };
  const deps = {
    getSendContext: vi.fn(async () => conversation),
    sendText: vi.fn(async () => `text-msg-${Math.random()}`),
    sendRemoteAttachment: vi.fn(async () => `img-msg-${Math.random()}`),
    fetchAndPrepareImage: vi.fn(async () => Buffer.from('jpeg-bytes')),
    encryptAttachment: vi.fn(async () => fakeEncrypted()),
    uploadAttachment: vi.fn(async (payload, key) => `https://paris-hunter.s3.fr-par.scw.cloud/${key}`),
    ...overrides,
  };
  return { conversation, deps };
};

const warnMessages = () => logger.warn.mock.calls.map((call) => String(call[0]));
const errorMessages = () => logger.error.mock.calls.map((call) => String(call[0]));

describe('convos outbox delivery state machine', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM convos_outbox').run();
    __resetOutboxForTests();
    vi.clearAllMocks();
  });

  it('is a safe no-op when the adapter has not been initialized (no deps wired)', async () => {
    insertRow();
    await flushOutbox();
    const row = getRow();
    expect(row.text_state).toBe('pending');
    expect(row.attempts).toBe(0);
  });

  it('delivers photo-then-text, persists enc_meta once and marks the row terminal', async () => {
    insertRow();
    const { conversation, deps } = makeDeps();
    setOutboxDeps(deps);

    await flushOutbox();

    const row = getRow();
    expect(row.image_state).toBe('sent');
    expect(row.text_state).toBe('sent');
    expect(row.sent_at).not.toBeNull();
    expect(row.image_message_id).toMatch(/^img-msg-/);
    expect(row.text_message_id).toMatch(/^text-msg-/);

    // photo first, then text; text goes through the ONE-argument wrapper contract
    expect(deps.sendRemoteAttachment.mock.invocationCallOrder[0]).toBeLessThan(
      deps.sendText.mock.invocationCallOrder[0],
    );
    expect(deps.sendText).toHaveBeenCalledWith(conversation, row.text);

    // upload key: attachments/listing-<16 hex>-<digest8>.jpg
    const uploadedKey = deps.uploadAttachment.mock.calls[0][1];
    expect(uploadedKey).toMatch(/^attachments\/listing-[0-9a-f]{16}-deadbeef\.jpg$/);

    // enc_meta persisted and rebuildable into a RemoteAttachment with Uint8Array fields
    const meta = JSON.parse(row.enc_meta);
    expect(meta.url).toBe(`https://paris-hunter.s3.fr-par.scw.cloud/${uploadedKey}`);
    const remoteAttachment = deps.sendRemoteAttachment.mock.calls[0][1];
    expect(remoteAttachment.secret).toBeInstanceOf(Uint8Array);
    expect(remoteAttachment.salt).toBeInstanceOf(Uint8Array);
    expect(remoteAttachment.nonce).toBeInstanceOf(Uint8Array);
    expect(remoteAttachment.scheme).toBe('https');
  });

  it('sends text-only rows without touching the image pipeline', async () => {
    insertRow({ image_url: null });
    const { deps } = makeDeps();
    setOutboxDeps(deps);

    await flushOutbox();

    const row = getRow();
    expect(row.text_state).toBe('sent');
    expect(row.sent_at).not.toBeNull();
    expect(deps.fetchAndPrepareImage).not.toHaveBeenCalled();
    expect(deps.sendRemoteAttachment).not.toHaveBeenCalled();
  });

  it('single-flight: concurrent triggers coalesce and never double-send (v3 A6)', async () => {
    insertRow({ image_url: null });
    let releaseFirstSend;
    const firstSendGate = new Promise((resolve) => {
      releaseFirstSend = resolve;
    });
    let sendCount = 0;
    const { deps } = makeDeps({
      sendText: vi.fn(async () => {
        sendCount += 1;
        if (sendCount === 1) {
          await firstSendGate;
        }
        return `text-msg-${sendCount}`;
      }),
    });
    setOutboxDeps(deps);

    const first = flushOutbox();
    // let the first run reach the in-flight send
    await vi.waitFor(() => expect(sendCount).toBe(1));
    expect(isFlushRunning()).toBe(true);

    // 4 concurrent triggers while running: all must coalesce into ONE trailing run
    const extra = Promise.all([flushOutbox(), flushOutbox(), flushOutbox(), flushOutbox()]);
    // a row that lands mid-run is picked up by the trailing run without another trigger
    insertRow({ id: 'se:uuid-2', dedup_key: 'se:uuid-2', image_url: null });

    releaseFirstSend();
    await first;
    await extra;
    await vi.waitFor(() => expect(getRow('se:uuid-2').text_state).toBe('sent'));

    expect(getRow('se:uuid-1').text_state).toBe('sent');
    // exactly 2 sends total (one per row) despite 5 triggers
    expect(deps.sendText).toHaveBeenCalledTimes(2);
  });

  it('casMessageState performs the transition exactly once (SQL CAS)', () => {
    insertRow();
    expect(casMessageState('se:uuid-1', 'image_state', 'pending', 'sending')).toBe(true);
    expect(casMessageState('se:uuid-1', 'image_state', 'pending', 'sending')).toBe(false);
    expect(getRow().image_state).toBe('sending');
    expect(() => casMessageState('se:uuid-1', 'state', 'queued', 'parked')).toThrow(/invalid outbox state column/);
  });

  it("boot recovery resets 'sending' rows to pending with the mandatory 'possible duplicate' WARN (v3 A1/A6)", async () => {
    const encMeta = JSON.stringify({
      url: 'https://paris-hunter.s3.fr-par.scw.cloud/attachments/listing-x.jpg',
      contentDigest: 'deadbeefcafebabe',
      secret: Buffer.alloc(32, 1).toString('base64'),
      salt: Buffer.alloc(32, 2).toString('base64'),
      nonce: Buffer.alloc(12, 3).toString('base64'),
      contentLength: 10,
      filename: 'listing-x.jpg',
      scheme: 'https',
    });
    insertRow({ image_state: 'sending', enc_meta: encMeta });
    insertRow({ id: 'se:uuid-2', dedup_key: 'se:uuid-2', image_url: null, text_state: 'sending' });

    const recovered = recoverSendingRows();
    expect(recovered).toBe(2);
    const warns = warnMessages();
    expect(warns.filter((m) => m.includes('possible duplicate'))).toHaveLength(2);
    expect(warns.some((m) => m.includes('se:uuid-1'))).toBe(true);
    expect(warns.some((m) => m.includes('se:uuid-2'))).toBe(true);
    expect(getRow('se:uuid-1').image_state).toBe('pending');
    expect(getRow('se:uuid-2').text_state).toBe('pending');

    // resume: the resend happens exactly once and reuses the persisted enc_meta (no re-upload)
    const { deps } = makeDeps();
    setOutboxDeps(deps);
    await flushOutbox();
    expect(deps.fetchAndPrepareImage).not.toHaveBeenCalled();
    expect(deps.uploadAttachment).not.toHaveBeenCalled();
    expect(deps.sendRemoteAttachment).toHaveBeenCalledTimes(1);
    expect(getRow('se:uuid-1').image_state).toBe('sent');
    expect(getRow('se:uuid-1').text_state).toBe('sent');
    expect(getRow('se:uuid-2').text_state).toBe('sent');
  });

  it("runtime flush NEVER touches 'sending' rows — ERROR log, row untouched (v3 A6)", async () => {
    insertRow({ text_state: 'sending', image_url: null });
    const { deps } = makeDeps();
    setOutboxDeps(deps);

    await flushOutbox();

    expect(deps.sendText).not.toHaveBeenCalled();
    expect(getRow().text_state).toBe('sending');
    expect(errorMessages().some((m) => m.includes('outside the running flush'))).toBe(true);
  });

  it('crash-after-upload boundary: enc_meta is reused, upload happens exactly once (#15)', async () => {
    const encMeta = JSON.stringify({
      url: 'https://paris-hunter.s3.fr-par.scw.cloud/attachments/listing-y.jpg',
      contentDigest: 'cafebabe',
      secret: Buffer.alloc(32, 1).toString('base64'),
      salt: Buffer.alloc(32, 2).toString('base64'),
      nonce: Buffer.alloc(12, 3).toString('base64'),
      contentLength: 10,
      filename: 'listing-y.jpg',
      scheme: 'https',
    });
    insertRow({ enc_meta: encMeta });
    const { deps } = makeDeps();
    setOutboxDeps(deps);

    await flushOutbox();

    expect(deps.uploadAttachment).not.toHaveBeenCalled();
    const sentAttachment = deps.sendRemoteAttachment.mock.calls[0][1];
    expect(sentAttachment.url).toBe('https://paris-hunter.s3.fr-par.scw.cloud/attachments/listing-y.jpg');
    expect(getRow().sent_at).not.toBeNull();
  });

  it('unfetchable/invalid image => image skipped, text still delivered, no retry of the fetch', async () => {
    insertRow();
    const { deps } = makeDeps({
      fetchAndPrepareImage: vi.fn(async () => {
        throw new Error('SSRF: non-public address');
      }),
    });
    setOutboxDeps(deps);

    await flushOutbox();
    let row = getRow();
    expect(row.image_state).toBe('skipped');
    expect(row.text_state).toBe('sent');
    expect(row.sent_at).not.toBeNull();
    expect(row.attempts).toBe(0);

    await flushOutbox();
    expect(deps.fetchAndPrepareImage).toHaveBeenCalledTimes(1);
    row = getRow();
    expect(row.image_state).toBe('skipped');
  });

  it('send error: WARN possible duplicate, revert to pending, attempts++, then succeed on retry', async () => {
    insertRow({ image_url: null });
    let attempt = 0;
    const { deps } = makeDeps({
      sendText: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('network reset');
        }
        return 'text-msg-retry';
      }),
    });
    setOutboxDeps(deps);

    await flushOutbox();
    let row = getRow();
    expect(row.text_state).toBe('pending'); // reverted, not stuck in 'sending'
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('network reset');
    expect(warnMessages().some((m) => m.includes('possible duplicate') && m.includes('se:uuid-1'))).toBe(true);

    await flushOutbox();
    row = getRow();
    expect(row.text_state).toBe('sent');
    expect(row.sent_at).not.toBeNull();
    expect(row.attempts).toBe(1); // successful retry does not add an attempt
  });

  it('parks a row after 10 real attempts and never selects it again', async () => {
    insertRow({ image_url: null, attempts: 9 });
    const { deps } = makeDeps({
      sendText: vi.fn(async () => {
        throw new Error('still down');
      }),
    });
    setOutboxDeps(deps);

    await flushOutbox();
    const row = getRow();
    expect(row.attempts).toBe(10);
    expect(row.state).toBe('parked');
    expect(errorMessages().some((m) => m.includes('PARKED') && m.includes('se:uuid-1'))).toBe(true);

    await flushOutbox();
    expect(deps.sendText).toHaveBeenCalledTimes(1); // parked rows are out of the drain
  });

  it('unhealthy/not-ready adapter parks nothing and counts no attempts (#15)', async () => {
    insertRow({ image_url: null });
    const { deps } = makeDeps({ getSendContext: vi.fn(async () => null) });
    setOutboxDeps(deps);

    await flushOutbox();

    const row = getRow();
    expect(row.text_state).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(deps.sendText).not.toHaveBeenCalled();
  });

  it('outbox PK is INSERT OR IGNORE-safe (decision-exactly-once foundation)', () => {
    insertRow({ image_url: null });
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO convos_outbox (id, dedup_key, kind, text, created_at) VALUES ('se:uuid-1', 'se:uuid-1', 'match', 'dup', 0)`,
      )
      .run();
    expect(info.changes).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM convos_outbox').get().n).toBe(1);
    expect(getRow().text).not.toBe('dup');
  });

  it('remoteAttachmentFromEncMeta round-trips base64 fields to Uint8Array', () => {
    const encrypted = fakeEncrypted('payload-bytes');
    const meta = {
      url: 'https://example.com/attachments/a.jpg',
      contentDigest: encrypted.contentDigest,
      secret: Buffer.from(encrypted.secret).toString('base64'),
      salt: Buffer.from(encrypted.salt).toString('base64'),
      nonce: Buffer.from(encrypted.nonce).toString('base64'),
      contentLength: 13,
      filename: 'a.jpg',
      scheme: 'https',
    };
    const remoteAttachment = remoteAttachmentFromEncMeta(JSON.stringify(meta));
    expect(Buffer.from(remoteAttachment.secret).equals(Buffer.from(encrypted.secret))).toBe(true);
    expect(Buffer.from(remoteAttachment.nonce).equals(Buffer.from(encrypted.nonce))).toBe(true);
    expect(remoteAttachment.contentLength).toBe(13);
  });
});

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const s3Calls = { configs: [], commands: [] };

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor(config) {
      s3Calls.configs.push(config);
    }
    async send(command) {
      s3Calls.commands.push(command.input);
      return {};
    }
  }
  class PutObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  return { S3Client, PutObjectCommand };
});

vi.mock('../../../lib/services/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createAttachmentStore, toAttachmentKey, ATTACHMENTS_PREFIX } =
  await import('../../../lib/services/paris-hunter/convos/attachmentStore.js');

const s3Env = {
  SCW_S3_ENDPOINT: 'https://s3.fr-par.scw.cloud',
  SCW_S3_REGION: 'fr-par',
  SCW_S3_BUCKET: 'paris-hunter',
  SCW_ACCESS_KEY: 'SCWXXXXXXXXXXXXXXXXX',
  SCW_SECRET_KEY: 'secret',
};

describe('attachmentStore provider selection', () => {
  it('defaults to s3 when ATTACHMENT_STORE is unset or empty', () => {
    expect(createAttachmentStore({ ...s3Env }).kind).toBe('s3');
    expect(createAttachmentStore({ ...s3Env, ATTACHMENT_STORE: '' }).kind).toBe('s3');
    expect(createAttachmentStore({ ...s3Env, ATTACHMENT_STORE: 's3' }).kind).toBe('s3');
  });

  it('rejects convos-api and pinata with a clear error (deliberately unsupported)', () => {
    for (const kind of ['convos-api', 'pinata', 'ipfs']) {
      expect(() => createAttachmentStore({ ATTACHMENT_STORE: kind })).toThrow(/not supported/);
    }
  });

  it('s3 arm fails fast when Scaleway credentials are missing', () => {
    expect(() => createAttachmentStore({ ATTACHMENT_STORE: 's3' })).toThrow(/SCW_S3_ENDPOINT/);
    expect(() => createAttachmentStore({ ...s3Env, SCW_SECRET_KEY: ' ' })).toThrow(/SCW_SECRET_KEY/);
  });

  it('local arm fails fast without ATTACHMENTS_PUBLIC_BASE or ATTACHMENTS_DIR', () => {
    expect(() => createAttachmentStore({ ATTACHMENT_STORE: 'local', ATTACHMENTS_DIR: '/tmp/x' })).toThrow(
      /ATTACHMENTS_PUBLIC_BASE/,
    );
    expect(() =>
      createAttachmentStore({ ATTACHMENT_STORE: 'local', ATTACHMENTS_PUBLIC_BASE: 'http://127.0.0.1:8787' }),
    ).toThrow(/ATTACHMENTS_DIR/);
  });
});

describe('attachment key hygiene (#11)', () => {
  it('prefixes attachments/ exactly once and refuses traversal', () => {
    expect(toAttachmentKey('listing-abc.jpg')).toBe('attachments/listing-abc.jpg');
    expect(toAttachmentKey('attachments/listing-abc.jpg')).toBe('attachments/listing-abc.jpg');
    expect(ATTACHMENTS_PREFIX).toBe('attachments/');
    expect(() => toAttachmentKey('attachments/../secrets.txt')).toThrow(/unsafe/);
    expect(() => toAttachmentKey('attachments//x')).toThrow(/unsafe/);
    expect(() => toAttachmentKey('')).toThrow(/non-empty/);
  });
});

describe('s3 store (Scaleway)', () => {
  beforeEach(() => {
    s3Calls.configs.length = 0;
    s3Calls.commands.length = 0;
  });

  it('uploads with MANDATORY ONEZONE_IA + public-read and virtual-host client config', async () => {
    const store = createAttachmentStore({ ...s3Env });
    const payload = Uint8Array.from(Buffer.from('ciphertext-bytes'));
    const url = await store.upload(payload, 'listing-abc-12345678.jpg', 'image/jpeg');

    expect(s3Calls.configs[0]).toMatchObject({
      endpoint: 'https://s3.fr-par.scw.cloud',
      region: 'fr-par',
      forcePathStyle: false,
      credentials: { accessKeyId: 'SCWXXXXXXXXXXXXXXXXX', secretAccessKey: 'secret' },
    });
    expect(s3Calls.commands).toHaveLength(1);
    expect(s3Calls.commands[0]).toEqual({
      Bucket: 'paris-hunter',
      Key: 'attachments/listing-abc-12345678.jpg',
      Body: payload,
      ContentType: 'image/jpeg',
      StorageClass: 'ONEZONE_IA',
      ACL: 'public-read',
    });
    expect(url).toBe('https://paris-hunter.s3.fr-par.scw.cloud/attachments/listing-abc-12345678.jpg');
  });

  it('sets ONEZONE_IA + public-read on EVERY upload, prefixed keys included', async () => {
    const store = createAttachmentStore({ ...s3Env });
    await store.upload(Uint8Array.from([1]), 'attachments/a.bin', 'application/octet-stream');
    await store.upload(Uint8Array.from([2]), 'b.bin', 'application/octet-stream');
    expect(s3Calls.commands).toHaveLength(2);
    for (const command of s3Calls.commands) {
      expect(command.StorageClass).toBe('ONEZONE_IA');
      expect(command.ACL).toBe('public-read');
      expect(command.Key.startsWith('attachments/')).toBe(true);
      expect(command.Key.includes('attachments/attachments/')).toBe(false);
    }
  });

  it('honours ATTACHMENTS_PUBLIC_BASE override (trailing slash normalized)', async () => {
    const store = createAttachmentStore({ ...s3Env, ATTACHMENTS_PUBLIC_BASE: 'https://cdn.example.com/' });
    const url = await store.upload(Uint8Array.from([1]), 'c.bin', 'application/octet-stream');
    expect(url).toBe('https://cdn.example.com/attachments/c.bin');
  });
});

describe('local store (dev/QA fallback)', () => {
  let baseDir;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-attachments-'));
  });

  const localEnv = () => ({
    ATTACHMENT_STORE: 'local',
    ATTACHMENTS_DIR: baseDir,
    ATTACHMENTS_PUBLIC_BASE: 'http://127.0.0.1:8787',
    ATTACHMENTS_RETENTION_DAYS: '30',
  });

  it('writes atomically under attachments/ and returns the public URL', async () => {
    const store = createAttachmentStore(localEnv());
    const payload = Buffer.from('encrypted-payload');
    const url = await store.upload(payload, 'listing-xyz.jpg', 'image/jpeg');

    expect(url).toBe('http://127.0.0.1:8787/attachments/listing-xyz.jpg');
    const stored = fs.readFileSync(path.join(baseDir, 'attachments', 'listing-xyz.jpg'));
    expect(stored.equals(payload)).toBe(true);
    // atomic write: no tmp files left behind
    const leftovers = fs.readdirSync(path.join(baseDir, 'attachments')).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('sweepRetention deletes only files older than the retention window', async () => {
    const store = createAttachmentStore(localEnv());
    await store.upload(Buffer.from('old'), 'old.bin', 'application/octet-stream');
    await store.upload(Buffer.from('fresh'), 'fresh.bin', 'application/octet-stream');
    const oldPath = path.join(baseDir, 'attachments', 'old.bin');
    const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldPath, past, past);

    const deleted = store.sweepRetention();

    expect(deleted).toBe(1);
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'attachments', 'fresh.bin'))).toBe(true);
  });

  it('sweepRetention tolerates a missing attachments dir', () => {
    const store = createAttachmentStore(localEnv());
    expect(store.sweepRetention()).toBe(0);
  });
});

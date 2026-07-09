/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Boot state machine (contract §4) with the heavy edges mocked: outbox (DB),
// XMTP client factory and the join flow. lock.js / identity.js / health.js run REAL.
vi.mock('../../../lib/services/paris-hunter/convos/outbox.js', () => ({
  flushOutbox: vi.fn(async () => {}),
  recoverSendingRows: vi.fn(() => 0),
  setOutboxDeps: vi.fn(),
  isFlushRunning: vi.fn(() => false),
}));

vi.mock('../../../lib/services/paris-hunter/convos/client.js', () => ({
  createConvosClient: vi.fn(async () => globalThis.__phFakeClient),
  sendConversationText: vi.fn(),
  sendConversationRemoteAttachment: vi.fn(),
}));

vi.mock('../../../lib/services/paris-hunter/convos/join.js', () => ({
  runJoinFlow: vi.fn(async () => ({ conversationId: 'conv-joined', inviteTag: 'tag2', group: { id: 'conv-joined' } })),
  sendProfileUpdateBestEffort: vi.fn(async () => {}),
}));

vi.mock('@xmtp/convos-cli', () => ({
  parseInvite: vi.fn((url) => {
    if (url.includes('unparseable')) {
      throw new Error('bad invite');
    }
    return { tag: url.includes('tag2') ? 'tag2' : 'tag1', creatorInboxId: 'creator-inbox' };
  }),
  sendProfileUpdate: vi.fn(),
  MemberKind: { Agent: 'agent' },
}));

vi.mock('../../../lib/services/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const makeFakeClient = () => ({
  inboxId: 'inbox-1',
  conversations: {
    sync: vi.fn(async () => {}),
    syncAll: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    getConversationById: vi.fn(async (id) => {
      if (globalThis.__phMembership === 'healthy') {
        return { id, isActive: true, sync: vi.fn(async () => {}) };
      }
      if (globalThis.__phMembership === 'removed') {
        return { id, isActive: false };
      }
      return null;
    }),
  },
  close: vi.fn(async () => {}),
});

describe('convos adapter boot state machine (contract §4)', () => {
  let dataDir;
  let exitSpy;
  let indexModule;

  const ENV_KEYS = [
    'CONVOS_DATA_DIR',
    'CONVOS_INVITE_URL',
    'CONVOS_PROFILE_NAME',
    'XMTP_ENV',
    'ATTACHMENT_STORE',
    'ATTACHMENTS_DIR',
    'ATTACHMENTS_PUBLIC_BASE',
    'PH_SELFTEST',
  ];
  const savedEnv = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-convos-'));
    process.env.CONVOS_DATA_DIR = dataDir;
    process.env.XMTP_ENV = 'dev';
    process.env.CONVOS_PROFILE_NAME = 'Paris Hunter QA';
    process.env.ATTACHMENT_STORE = 'local';
    process.env.ATTACHMENTS_DIR = path.join(dataDir, 'attachments-store');
    process.env.ATTACHMENTS_PUBLIC_BASE = 'http://127.0.0.1:8787';
    delete process.env.CONVOS_INVITE_URL;
    delete process.env.PH_SELFTEST;
    globalThis.__phFakeClient = makeFakeClient();
    globalThis.__phMembership = 'healthy';
    vi.clearAllMocks(); // mock factories survive resetModules — reset their call history
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.resetModules();
    indexModule = null;
  });

  afterEach(async () => {
    if (indexModule != null) {
      await indexModule.shutdownConvosAdapter('test-cleanup', { exit: false });
    }
    exitSpy.mockRestore();
    process.removeAllListeners('SIGTERM');
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  const boot = async () => {
    indexModule = await import('../../../lib/services/paris-hunter/convos/index.js');
    await indexModule.initConvosAdapter();
    return indexModule;
  };

  const statePath = () => path.join(dataDir, 'adapter-state.json');
  const writeState = (state) => fs.writeFileSync(statePath(), JSON.stringify(state));
  const joinMock = async () => (await import('../../../lib/services/paris-hunter/convos/join.js')).runJoinFlow;

  it('first run without CONVOS_INVITE_URL degrades (no join, sends parked)', async () => {
    const mod = await boot();
    expect(mod.getAdapterStatus().status).toBe('degraded');
    expect(mod.getAdapterStatus().reason).toBe('no-invite');
    await expect(mod.whenReady()).rejects.toThrow(/degraded/);
    expect(await joinMock()).not.toHaveBeenCalled();
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it('first run with an invite runs the JOIN flow and persists adapter-state.json before ready', async () => {
    process.env.CONVOS_INVITE_URL = 'https://dev.convos.org/v2?i=tag2-slug';
    const mod = await boot();
    expect(await joinMock()).toHaveBeenCalledTimes(1);
    expect(mod.getAdapterStatus()).toMatchObject({ status: 'ready', conversationId: 'conv-joined' });
    await expect(mod.whenReady()).resolves.toBeUndefined();
    const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    expect(state.conversationId).toBe('conv-joined');
    expect(state.inviteTag).toBe('tag2');
    expect(state.joinedAt).toBeTruthy();
  });

  it('healthy adapter-state NEVER re-runs the join flow, even with an invite set (never-re-redeem)', async () => {
    writeState({ conversationId: 'conv-existing', inviteTag: 'tag1', joinedAt: '2026-07-09T00:00:00Z' });
    process.env.CONVOS_INVITE_URL = 'https://dev.convos.org/v2?i=tag1-slug';
    globalThis.__phMembership = 'healthy';
    const mod = await boot();
    expect(await joinMock()).not.toHaveBeenCalled();
    expect(mod.getAdapterStatus()).toMatchObject({ status: 'ready', conversationId: 'conv-existing' });
  });

  it('removed from group + no invite => degraded, keeps process alive, no join', async () => {
    writeState({ conversationId: 'conv-existing', inviteTag: 'tag1', joinedAt: '2026-07-09T00:00:00Z' });
    globalThis.__phMembership = 'removed';
    const mod = await boot();
    expect(await joinMock()).not.toHaveBeenCalled();
    expect(mod.getAdapterStatus().status).toBe('degraded');
    expect(mod.getAdapterStatus().reason).toBe('membership-removed');
  });

  it('removed + SAME invite tag recorded in state => degraded (a same invite must not be re-redeemed)', async () => {
    writeState({ conversationId: 'conv-existing', inviteTag: 'tag1', joinedAt: '2026-07-09T00:00:00Z' });
    process.env.CONVOS_INVITE_URL = 'https://dev.convos.org/v2?i=tag1-slug';
    globalThis.__phMembership = 'removed';
    const mod = await boot();
    expect(await joinMock()).not.toHaveBeenCalled();
    expect(mod.getAdapterStatus().status).toBe('degraded');
  });

  it('removed + DIFFERENT invite => recovery join runs and state is replaced', async () => {
    writeState({ conversationId: 'conv-existing', inviteTag: 'tag1', joinedAt: '2026-07-09T00:00:00Z' });
    process.env.CONVOS_INVITE_URL = 'https://dev.convos.org/v2?i=tag2-slug';
    globalThis.__phMembership = 'removed';
    const mod = await boot();
    expect(await joinMock()).toHaveBeenCalledTimes(1);
    expect(mod.getAdapterStatus()).toMatchObject({ status: 'ready', conversationId: 'conv-joined' });
    expect(JSON.parse(fs.readFileSync(statePath(), 'utf8')).inviteTag).toBe('tag2');
  });

  it("missing conversation ('missing') + unparseable invite => degraded, no join on garbage", async () => {
    writeState({ conversationId: 'conv-existing', inviteTag: 'tag1', joinedAt: '2026-07-09T00:00:00Z' });
    process.env.CONVOS_INVITE_URL = 'https://dev.convos.org/v2?i=unparseable';
    globalThis.__phMembership = 'missing';
    const mod = await boot();
    expect(await joinMock()).not.toHaveBeenCalled();
    expect(mod.getAdapterStatus().reason).toBe('membership-missing');
  });

  it("runs boot-only 'sending' recovery BEFORE any flush trigger is wired (v3 A6)", async () => {
    writeState({ conversationId: 'conv-existing', inviteTag: 'tag1', joinedAt: '2026-07-09T00:00:00Z' });
    const mod = await boot();
    const outbox = await import('../../../lib/services/paris-hunter/convos/outbox.js');
    expect(outbox.recoverSendingRows).toHaveBeenCalledTimes(1);
    expect(outbox.flushOutbox).toHaveBeenCalled(); // initial flush once ready
    expect(outbox.recoverSendingRows.mock.invocationCallOrder[0]).toBeLessThan(
      outbox.flushOutbox.mock.invocationCallOrder[0],
    );
    // bus event is wired as a trigger
    const previousCalls = outbox.flushOutbox.mock.calls.length;
    const { bus } = await import('../../../lib/services/events/event-bus.js');
    bus.emit('convos:flush');
    expect(outbox.flushOutbox.mock.calls.length).toBe(previousCalls + 1);
    expect(mod.getAdapterStatus().status).toBe('ready');
  });

  it('a second process on the same data dir exits non-zero (single-writer lock, contract §1)', async () => {
    // pid 1 is always alive — simulates a live foreign adapter process
    fs.writeFileSync(path.join(dataDir, 'adapter.lock'), JSON.stringify({ pid: 1 }));
    indexModule = await import('../../../lib/services/paris-hunter/convos/index.js');
    await expect(indexModule.initConvosAdapter()).rejects.toThrow('process.exit(1)');
    indexModule = null; // nothing to shut down
  });

  it('a STALE lock (dead pid) is reclaimed and boot proceeds', async () => {
    fs.writeFileSync(path.join(dataDir, 'adapter.lock'), JSON.stringify({ pid: 999999 }));
    writeState({ conversationId: 'conv-existing', inviteTag: 'tag1', joinedAt: '2026-07-09T00:00:00Z' });
    const mod = await boot();
    expect(mod.getAdapterStatus().status).toBe('ready');
    const lock = JSON.parse(fs.readFileSync(path.join(dataDir, 'adapter.lock'), 'utf8'));
    expect(lock.pid).toBe(process.pid);
  });

  it('creates identity.json on first run (0600, valid keys) and reuses it afterwards', async () => {
    process.env.CONVOS_INVITE_URL = 'https://dev.convos.org/v2?i=tag2-slug';
    await boot();
    const identityPath = path.join(dataDir, 'identity.json');
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    expect(identity.walletKey).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(identity.dbEncryptionKey).toMatch(/^[0-9a-f]{64}$/i);
    expect(fs.statSync(identityPath).mode & 0o777).toBe(0o600);

    // second boot in a fresh module registry must NOT mint a new identity
    await indexModule.shutdownConvosAdapter('test-cleanup', { exit: false });
    process.removeAllListeners('SIGTERM');
    vi.resetModules();
    globalThis.__phFakeClient = makeFakeClient();
    const again = await boot();
    const identityAgain = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    expect(identityAgain.walletKey).toBe(identity.walletKey);
    expect(again.getAdapterStatus().status).toBe('ready'); // state file from run 1 + healthy membership
  });
});

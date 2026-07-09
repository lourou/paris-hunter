/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/services/paris-hunter/convos/index.js', () => ({
  flushOutbox: vi.fn(async () => {}),
  whenReady: vi.fn(() => Promise.resolve()),
  initConvosAdapter: vi.fn(async () => {}),
}));

const { flushOutbox } = await import('../../lib/services/paris-hunter/convos/index.js');
const adapter = await import('../../lib/notification/adapter/convos.js');
const { sendConversationText, sendConversationRemoteAttachment, buildEoaSigner } =
  await import('../../lib/services/paris-hunter/convos/client.js');

describe('convos notification adapter shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the Fredy adapter contract (id, name, readme, empty fields)', () => {
    expect(adapter.config.id).toBe('convos');
    expect(adapter.config.name).toBe('Convos (XMTP)');
    expect(typeof adapter.config.description).toBe('string');
    expect(adapter.config.fields).toEqual({});
    expect(adapter.config.readme).toContain('Convos');
  });

  it('send() is a pure flush trigger: ignores listing data and returns []', () => {
    // Fredy-mutated listings (nanoid ids, stringified fields) must never be read (#8):
    // pass hostile shapes and expect no throw and no inspection.
    const result = adapter.send({
      serviceName: 'streamEstate',
      newListings: [{ id: 'nanoid-mutated', price: '2 850 €', ph: undefined }, null, 42],
      notificationConfig: [{ id: 'convos', fields: {} }],
      jobKey: 'paris-hunter',
    });
    expect(result).toEqual([]);
    expect(flushOutbox).toHaveBeenCalledTimes(1);
    expect(flushOutbox).toHaveBeenCalledWith(); // no arguments — outbox is the sole source
  });
});

describe('node-sdk 6.0.0 boolean-trap send wrappers (CP0-verified, NORMATIVE)', () => {
  it('sendConversationText forwards EXACTLY ONE argument — never an options object', async () => {
    const conversation = { sendText: vi.fn(async () => 'msg-1') };
    const messageId = await sendConversationText(conversation, 'hello group');
    expect(messageId).toBe('msg-1');
    expect(conversation.sendText).toHaveBeenCalledTimes(1);
    const args = conversation.sendText.mock.calls[0];
    expect(args).toHaveLength(1); // a 2nd arg would be isOptimistic — an object coerces truthy
    expect(args[0]).toBe('hello group');
  });

  it('sendConversationRemoteAttachment passes the LITERAL BOOLEAN false as 2nd arg', async () => {
    const conversation = { sendRemoteAttachment: vi.fn(async () => 'msg-2') };
    const remoteAttachment = { url: 'https://x/attachments/a.jpg', scheme: 'https' };
    const messageId = await sendConversationRemoteAttachment(conversation, remoteAttachment);
    expect(messageId).toBe('msg-2');
    const args = conversation.sendRemoteAttachment.mock.calls[0];
    expect(args).toHaveLength(2);
    expect(args[0]).toBe(remoteAttachment);
    expect(args[1]).toBe(false); // strictly boolean false — NOT { optimistic: false }
    expect(typeof args[1]).toBe('boolean');
  });

  it('buildEoaSigner shapes the EOA signer per contract §3', async () => {
    const account = {
      address: '0xAbCdEf0123456789aBcDeF0123456789ABCDEF01',
      signMessage: vi.fn(async () => `0x${'ab'.repeat(65)}`),
    };
    const signer = buildEoaSigner(account);
    expect(signer.type).toBe('EOA');
    expect(signer.getIdentifier()).toEqual({
      identifierKind: 0,
      identifier: '0xabcdef0123456789abcdef0123456789abcdef01',
    });
    const signature = await signer.signMessage('challenge');
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature).toHaveLength(65);
    expect(account.signMessage).toHaveBeenCalledWith({ message: 'challenge' });
  });
});

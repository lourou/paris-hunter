/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi } from 'vitest';
import {
  safeFetch,
  preparePhoto,
  isPublicUnicastAddress,
  buildPinnedLookup,
  SsrfError,
} from '../../../lib/services/paris-hunter/convos/photo.js';

const bodyFrom = (chunks) =>
  (async function* generate() {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();

const makeResponse = ({ status = 200, headers = {}, chunks = [Buffer.from('image-bytes')] } = {}) => ({
  statusCode: status,
  headers,
  body: bodyFrom(chunks),
  close: vi.fn(async () => {}),
});

const publicAnswer = [{ address: '93.184.216.34', family: 4 }];

describe('isPublicUnicastAddress (v2 #10 list)', () => {
  it.each([
    ['127.0.0.1', false], // loopback
    ['10.0.0.1', false], // RFC1918
    ['172.16.0.1', false], // RFC1918
    ['172.31.255.255', false], // RFC1918 upper edge
    ['172.32.0.1', true], // just OUTSIDE 172.16/12
    ['192.168.1.1', false], // RFC1918
    ['169.254.169.254', false], // link-local / cloud metadata
    ['100.64.0.1', false], // CGNAT
    ['0.0.0.0', false],
    ['224.0.0.1', false], // multicast
    ['255.255.255.255', false], // broadcast
    ['198.18.0.1', false], // benchmarking
    ['192.0.2.10', false], // TEST-NET-1
    ['8.8.8.8', true],
    ['93.184.216.34', true],
    ['::1', false], // v6 loopback
    ['::', false], // unspecified
    ['fe80::1', false], // link-local
    ['fc00::1', false], // ULA
    ['fd12:3456::1', false], // ULA
    ['ff02::1', false], // multicast
    ['2001:db8::1', false], // documentation
    ['64:ff9b::a00:1', false], // NAT64
    ['2002::1', false], // 6to4
    ['::ffff:10.0.0.1', false], // v4-mapped private
    ['::ffff:8.8.8.8', true], // v4-mapped public
    ['2600:1f18::1', true], // plain public v6
    ['not-an-ip', false],
  ])('%s -> %s', (address, expected) => {
    expect(isPublicUnicastAddress(address)).toBe(expected);
  });
});

describe('buildPinnedLookup (v3 A10 pinning primitive)', () => {
  it('answers ONLY the pre-validated address, whatever hostname the socket asks for', () => {
    const lookup = buildPinnedLookup({ address: '93.184.216.34', family: 4 });
    const seen = [];
    lookup('evil-rebinder.example.com', { all: true }, (err, addresses) => seen.push([err, addresses]));
    lookup('another-host.example.com', {}, (err, address, family) => seen.push([err, address, family]));
    lookup('callback-style.example.com', (err, address, family) => seen.push([err, address, family]));
    expect(seen[0]).toEqual([null, [{ address: '93.184.216.34', family: 4 }]]);
    expect(seen[1]).toEqual([null, '93.184.216.34', 4]);
    expect(seen[2]).toEqual([null, '93.184.216.34', 4]);
  });
});

describe('safeFetch SSRF guards', () => {
  it('rejects non-https URLs', async () => {
    await expect(safeFetch('http://images.example.com/a.jpg')).rejects.toThrow(SsrfError);
    await expect(safeFetch('ftp://images.example.com/a.jpg')).rejects.toThrow(/non-https/);
  });

  it('rejects URLs with embedded credentials', async () => {
    await expect(safeFetch('https://user:pass@images.example.com/a.jpg')).rejects.toThrow(/credentials/);
  });

  it('rejects private IPv4 literals without ever connecting', async () => {
    const performRequest = vi.fn();
    for (const target of [
      'https://10.0.0.1/a.jpg',
      'https://127.0.0.1/a.jpg',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      await expect(safeFetch(target, { performRequest })).rejects.toThrow(/non-public address/);
    }
    expect(performRequest).not.toHaveBeenCalled();
  });

  it('rejects private/special IPv6 literals (incl. v4-mapped)', async () => {
    const performRequest = vi.fn();
    for (const target of ['https://[::1]/a.jpg', 'https://[fd00::1]/a.jpg', 'https://[::ffff:192.168.0.1]/a.jpg']) {
      await expect(safeFetch(target, { performRequest })).rejects.toThrow(/non-public address/);
    }
    expect(performRequest).not.toHaveBeenCalled();
  });

  it('accepts a public IPv6 literal and pins its address', async () => {
    const performRequest = vi.fn(async () => makeResponse({ headers: { 'content-type': 'image/jpeg' } }));
    await safeFetch('https://[2600:1f18::1]/a.jpg', { performRequest });
    expect(performRequest.mock.calls[0][1]).toEqual({ address: '2600:1f18::1', family: 6 });
  });

  it('rejects when a hostname resolves to a private address', async () => {
    const resolveAddresses = vi.fn(async () => [{ address: '192.168.0.10', family: 4 }]);
    const performRequest = vi.fn();
    await expect(safeFetch('https://internal.example.com/a.jpg', { resolveAddresses, performRequest })).rejects.toThrow(
      /non-public address/,
    );
    expect(performRequest).not.toHaveBeenCalled();
  });

  it('rejects when ANY resolved address is private (multi-A rebinding defence)', async () => {
    const resolveAddresses = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ]);
    const performRequest = vi.fn();
    await expect(safeFetch('https://mixed.example.com/a.jpg', { resolveAddresses, performRequest })).rejects.toThrow(
      /non-public address 10\.0\.0\.7/,
    );
    expect(performRequest).not.toHaveBeenCalled();
  });

  it('pins the connect to the ONE validated address — no second resolution within a hop (v3 A10)', async () => {
    const resolveAddresses = vi.fn(async () => publicAnswer);
    const performRequest = vi.fn(async (url, pinned) => {
      expect(pinned).toEqual({ address: '93.184.216.34', family: 4 });
      expect(url.hostname).toBe('images.example.com'); // SNI/Host stay the hostname
      return makeResponse({ headers: { 'content-type': 'image/jpeg' } });
    });
    const result = await safeFetch('https://images.example.com/a.jpg', { resolveAddresses, performRequest });
    expect(resolveAddresses).toHaveBeenCalledTimes(1); // resolved once, validated once, pinned once
    expect(performRequest).toHaveBeenCalledTimes(1);
    expect(result.buffer.toString()).toBe('image-bytes');
  });

  it('rebinding via same-host redirect: the second resolution turning private is caught at hop 2', async () => {
    const answers = [publicAnswer, [{ address: '10.13.37.1', family: 4 }]];
    const resolveAddresses = vi.fn(async () => answers.shift());
    const performRequest = vi.fn(async () =>
      makeResponse({ status: 302, headers: { location: 'https://rebind.example.com/step2' }, chunks: [] }),
    );
    await expect(safeFetch('https://rebind.example.com/a.jpg', { resolveAddresses, performRequest })).rejects.toThrow(
      /non-public address 10\.13\.37\.1/,
    );
    expect(resolveAddresses).toHaveBeenCalledTimes(2); // every hop re-resolves and re-validates
    expect(performRequest).toHaveBeenCalledTimes(1); // hop 2 never connects
  });

  it('redirect to a private host is rejected; redirect to http is rejected', async () => {
    const resolveAddresses = vi.fn(async (hostname) =>
      hostname === 'public.example.com' ? publicAnswer : [{ address: '172.16.0.9', family: 4 }],
    );
    const redirectTo = (location) =>
      vi.fn(async () => makeResponse({ status: 301, headers: { location }, chunks: [] }));

    await expect(
      safeFetch('https://public.example.com/a.jpg', {
        resolveAddresses,
        performRequest: redirectTo('https://intranet.example.com/b.jpg'),
      }),
    ).rejects.toThrow(/non-public address/);

    await expect(
      safeFetch('https://public.example.com/a.jpg', {
        resolveAddresses,
        performRequest: redirectTo('http://public.example.com/b.jpg'),
      }),
    ).rejects.toThrow(/non-https/);
  });

  it('follows at most 3 redirects', async () => {
    const resolveAddresses = vi.fn(async () => publicAnswer);
    const performRequest = vi.fn(async (url) =>
      makeResponse({ status: 302, headers: { location: `${url.href}x` }, chunks: [] }),
    );
    await expect(safeFetch('https://loop.example.com/a', { resolveAddresses, performRequest })).rejects.toThrow(
      /too many redirects/,
    );
    expect(performRequest).toHaveBeenCalledTimes(4); // initial + 3 followed hops
  });

  it('caps and destroys an oversized redirect body before following the next hop', async () => {
    const resolveAddresses = vi.fn(async () => publicAnswer);
    const body = bodyFrom([Buffer.alloc(5)]);
    body.destroy = vi.fn();
    const performRequest = vi.fn(async () => ({
      statusCode: 302,
      headers: { location: 'https://images.example.com/next.jpg' },
      body,
      close: vi.fn(async () => {}),
    }));

    await expect(
      safeFetch('https://images.example.com/start.jpg', { maxBytes: 4, resolveAddresses, performRequest }),
    ).rejects.toThrow(/byte cap/);
    expect(body.destroy).toHaveBeenCalledOnce();
    expect(performRequest).toHaveBeenCalledTimes(1);
  });

  it('enforces the 8 MB cap while streaming and from content-length', async () => {
    const resolveAddresses = vi.fn(async () => publicAnswer);
    const big = Buffer.alloc(1024 * 1024, 7);
    const streaming = vi.fn(async () =>
      makeResponse({ headers: { 'content-type': 'image/jpeg' }, chunks: Array(9).fill(big) }),
    );
    await expect(
      safeFetch('https://big.example.com/a.jpg', { resolveAddresses, performRequest: streaming }),
    ).rejects.toThrow(/byte cap/);

    const declared = vi.fn(async () =>
      makeResponse({
        headers: { 'content-type': 'image/jpeg', 'content-length': String(9 * 1024 * 1024) },
        chunks: [],
      }),
    );
    await expect(
      safeFetch('https://big.example.com/a.jpg', { resolveAddresses, performRequest: declared }),
    ).rejects.toThrow(/content-length/);
  });

  it('rejects non-200 terminal statuses', async () => {
    const resolveAddresses = vi.fn(async () => publicAnswer);
    const performRequest = vi.fn(async () => makeResponse({ status: 404, chunks: [] }));
    await expect(safeFetch('https://gone.example.com/a.jpg', { resolveAddresses, performRequest })).rejects.toThrow(
      /unexpected status 404/,
    );
  });
});

describe('preparePhoto validation + downscale', () => {
  const resolveAddresses = vi.fn(async () => publicAnswer);

  it('rejects non-image content types', async () => {
    const performRequest = vi.fn(async () =>
      makeResponse({ headers: { 'content-type': 'text/html' }, chunks: [Buffer.from('<html/>')] }),
    );
    await expect(
      preparePhoto('https://images.example.com/a.jpg', { resolveAddresses, performRequest }),
    ).rejects.toThrow(/not an image/);
  });

  it('rejects bytes sharp cannot decode (final validation, v2 #10)', async () => {
    const performRequest = vi.fn(async () =>
      makeResponse({ headers: { 'content-type': 'image/jpeg' }, chunks: [Buffer.from('definitely-not-a-jpeg')] }),
    );
    await expect(
      preparePhoto('https://images.example.com/a.jpg', { resolveAddresses, performRequest }),
    ).rejects.toThrow();
  });

  it('downscales an oversized image to <= 1600 px JPEG', async () => {
    const sharp = (await import('sharp')).default;
    const source = await sharp({
      create: { width: 2400, height: 1800, channels: 3, background: { r: 200, g: 100, b: 50 } },
    })
      .jpeg()
      .toBuffer();
    const performRequest = vi.fn(async () =>
      makeResponse({ headers: { 'content-type': 'image/jpeg' }, chunks: [source] }),
    );
    const output = await preparePhoto('https://images.example.com/big.jpg', { resolveAddresses, performRequest });
    const meta = await sharp(output).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(1600);
  });
});

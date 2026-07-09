/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: SSRF-guarded, DNS-rebinding-safe image fetch + downscale
 * (build plan v2 #10 + v3 A10).
 *
 * safeFetch(url): per hop — resolve ALL A/AAAA, validate EVERY address as
 * public-unicast, then connect to ONE of the validated IPs (not the hostname):
 * an undici Agent whose connect.lookup returns ONLY the pinned address, so no
 * second DNS resolution can occur between validation and connect (TLS
 * servername/SNI and the Host header stay the original hostname because the
 * request still targets the original URL). Redirects are handled manually and
 * EVERY hop repeats resolve -> validate -> pin. HTTPS-only, 10 s overall
 * deadline, hard streaming byte cap.
 *
 * preparePhoto(url): safeFetch + content-type image/* gate + sharp decode as
 * final validation (v2 supersedes v1's "fall back to original bytes" — a buffer
 * sharp cannot decode is treated as invalid) + downscale to <= 1600 px JPEG.
 */

import net from 'node:net';
import dns from 'node:dns/promises';

export class SsrfError extends Error {}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

/** @param {string} ip dotted-quad */
const v4ToInt = (ip) => ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0) >>> 0;

/** Non-public IPv4 ranges (v2 #10 list): loopback, RFC1918, link-local incl. 169.254.169.254, CGNAT, and friends. */
const BLOCKED_V4 = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. 169.254.169.254 metadata)
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
].map(([base, bits]) => [v4ToInt(base), bits]);

const inCidr4 = (ipInt, baseInt, bits) => ipInt >>> (32 - bits) === baseInt >>> (32 - bits);

const isPublicV4 = (address) => {
  const ipInt = v4ToInt(address);
  return !BLOCKED_V4.some(([baseInt, bits]) => inCidr4(ipInt, baseInt, bits));
};

/** Expand an IPv6 address (incl. '::' and embedded dotted-quad tail) to a BigInt. */
const v6ToBigInt = (address) => {
  let addr = address;
  const zoneIndex = addr.indexOf('%');
  if (zoneIndex !== -1) {
    addr = addr.slice(0, zoneIndex);
  }
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':');
    const tailInt = v4ToInt(addr.slice(lastColon + 1));
    addr = `${addr.slice(0, lastColon + 1)}${(tailInt >>> 16).toString(16)}:${(tailInt & 0xffff).toString(16)}`;
  }
  const [head, tail = ''] = addr.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const groups = [
    ...headGroups,
    ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'),
    ...tailGroups,
  ];
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(Number.parseInt(group === '' ? '0' : group, 16));
  }
  return value;
};

const inCidr6 = (value, baseValue, bits) => value >> BigInt(128 - bits) === baseValue >> BigInt(128 - bits);

/** Non-public IPv6 prefixes; v4-mapped/translated forms delegate to the v4 list or are blocked outright. */
const BLOCKED_V6 = [
  ['::', 127], // unspecified + loopback (::/128 and ::1/128)
  ['64:ff9b::', 96], // NAT64 (embedded v4 — block outright)
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embedded v4 — block outright)
  ['fc00::', 7], // ULA
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
].map(([base, bits]) => [v6ToBigInt(base), bits]);

const V4_MAPPED_PREFIX = v6ToBigInt('::ffff:0:0');

const isPublicV6 = (address) => {
  const value = v6ToBigInt(address);
  if (value >> 32n === V4_MAPPED_PREFIX >> 32n) {
    // ::ffff:a.b.c.d — validate the embedded IPv4 address.
    const embedded = Number(value & 0xffffffffn);
    return !BLOCKED_V4.some(([baseInt, bits]) => inCidr4(embedded, baseInt, bits));
  }
  return !BLOCKED_V6.some(([baseValue, bits]) => inCidr6(value, baseValue, bits));
};

/**
 * Public-unicast gate for a single resolved address (v2 #10 list).
 *
 * @param {string} address IPv4 or IPv6 literal
 * @returns {boolean}
 */
export const isPublicUnicastAddress = (address) => {
  const family = net.isIP(address);
  if (family === 4) {
    return isPublicV4(address);
  }
  if (family === 6) {
    return isPublicV6(address);
  }
  return false;
};

/**
 * Resolve ALL A/AAAA records (no CNAME shortcuts, no OS resolver caching layer).
 *
 * @param {string} hostname
 * @returns {Promise<Array<{address: string, family: 4|6}>>}
 */
const defaultResolveAddresses = async (hostname) => {
  const [v4, v6] = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const addresses = [];
  if (v4.status === 'fulfilled') {
    addresses.push(...v4.value.map((address) => ({ address, family: 4 })));
  }
  if (v6.status === 'fulfilled') {
    addresses.push(...v6.value.map((address) => ({ address, family: 6 })));
  }
  if (addresses.length === 0) {
    throw new SsrfError(`DNS resolution failed for ${hostname}`);
  }
  return addresses;
};

/**
 * Build a net/tls lookup function that answers ONLY the pre-validated address,
 * whatever hostname the socket layer asks for (v3 A10 pinning primitive).
 * Exported for the unit test that proves no second resolution can slip in.
 *
 * @param {{address: string, family: 4|6}} pinned
 */
export const buildPinnedLookup = (pinned) => (hostname, options, callback) => {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : (options ?? {});
  if (opts.all) {
    cb(null, [{ address: pinned.address, family: pinned.family }]);
  } else {
    cb(null, pinned.address, pinned.family);
  }
};

/**
 * One pinned GET via undici: custom connect.lookup returns only the validated
 * address; SNI + Host header remain the original hostname (we request the
 * original URL). maxRedirections is 0 — redirects are re-validated by the caller.
 *
 * @param {URL} url
 * @param {{address: string, family: 4|6}} pinned
 * @param {{signal: AbortSignal, timeoutMs: number}} options
 */
const defaultPerformRequest = async (url, pinned, { signal, timeoutMs }) => {
  const { Agent, request } = await import('undici');
  const agent = new Agent({
    connect: {
      timeout: timeoutMs,
      lookup: buildPinnedLookup(pinned),
    },
  });
  try {
    const res = await request(url, {
      method: 'GET',
      dispatcher: agent,
      signal,
      maxRedirections: 0,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    return {
      statusCode: res.statusCode,
      headers: res.headers,
      body: res.body,
      close: () => agent.close(),
    };
  } catch (error) {
    await agent.close().catch(() => {});
    throw error;
  }
};

const readCapped = async (body, maxBytes) => {
  if (body == null) {
    return Buffer.alloc(0);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > maxBytes) {
      if (typeof body.destroy === 'function') {
        body.destroy(new Error('byte cap exceeded'));
      }
      throw new SsrfError(`response exceeds the ${maxBytes} byte cap`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const headerValue = (headers, name) => {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : (value ?? null);
};

/**
 * SSRF/rebinding-safe fetch of an untrusted URL (v2 #10 + v3 A10).
 *
 * @param {string} url
 * @param {{
 *   maxRedirects?: number, maxBytes?: number, timeoutMs?: number,
 *   resolveAddresses?: (hostname: string) => Promise<Array<{address: string, family: 4|6}>>,
 *   performRequest?: typeof defaultPerformRequest,
 * }} [options] resolveAddresses/performRequest are injectable for tests
 * @returns {Promise<{buffer: Buffer, contentType: string|null, finalUrl: string}>}
 */
export const safeFetch = async (url, options = {}) => {
  const {
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    resolveAddresses = defaultResolveAddresses,
    performRequest = defaultPerformRequest,
  } = options;

  let current;
  try {
    current = new URL(url);
  } catch {
    throw new SsrfError(`invalid URL: ${url}`);
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new SsrfError(`timeout after ${timeoutMs} ms`)), timeoutMs);
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (current.protocol !== 'https:') {
        throw new SsrfError(`refusing non-https URL (${current.protocol}//…)`);
      }
      if (current.username !== '' || current.password !== '') {
        throw new SsrfError('credentials in URL are not allowed');
      }
      const bareHost = current.hostname.replace(/^\[|\]$/g, '');
      const literalFamily = net.isIP(bareHost);
      const addresses = literalFamily
        ? [{ address: bareHost, family: literalFamily }]
        : await resolveAddresses(bareHost);
      if (!Array.isArray(addresses) || addresses.length === 0) {
        throw new SsrfError(`no addresses resolved for ${bareHost}`);
      }
      for (const entry of addresses) {
        if (!isPublicUnicastAddress(entry.address)) {
          throw new SsrfError(`non-public address ${entry.address} for host ${bareHost}`);
        }
      }
      const pinned = addresses[0];
      const res = await performRequest(current, pinned, { signal: controller.signal, timeoutMs });
      try {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          const location = headerValue(res.headers, 'location');
          if (!location) {
            throw new SsrfError(`redirect ${res.statusCode} without a location header`);
          }
          // Redirect bodies are untrusted too. Read them through the same hard
          // cap (which destroys the stream on overflow) before opening the
          // next hop, so a redirect cannot bypass the 8 MB bandwidth bound.
          await readCapped(res.body, maxBytes);
          current = new URL(location, current); // next hop re-runs resolve -> validate -> pin
          continue;
        }
        if (res.statusCode !== 200) {
          throw new SsrfError(`unexpected status ${res.statusCode}`);
        }
        const contentLength = headerValue(res.headers, 'content-length');
        if (contentLength != null && Number(contentLength) > maxBytes) {
          throw new SsrfError(`declared content-length ${contentLength} exceeds the ${maxBytes} byte cap`);
        }
        const buffer = await readCapped(res.body, maxBytes);
        return { buffer, contentType: headerValue(res.headers, 'content-type'), finalUrl: current.href };
      } finally {
        await res.close?.().catch?.(() => {});
      }
    }
    throw new SsrfError(`too many redirects (> ${maxRedirects})`);
  } finally {
    clearTimeout(deadline);
  }
};

/**
 * Fetch + validate + downscale a listing photo to a JPEG suitable for a remote
 * attachment (<= maxEdge px, quality ladder until <= maxOutputBytes).
 *
 * @param {string} url untrusted webhook-supplied photo URL
 * @param {{maxEdge?: number, maxOutputBytes?: number} & Parameters<typeof safeFetch>[1]} [options]
 * @returns {Promise<Buffer>} JPEG bytes
 */
export const preparePhoto = async (url, options = {}) => {
  const { maxEdge = 1600, maxOutputBytes = 1.5 * 1024 * 1024, ...fetchOptions } = options;
  const { buffer, contentType } = await safeFetch(url, fetchOptions);
  if (contentType == null || !contentType.toLowerCase().startsWith('image/')) {
    throw new SsrfError(`not an image (content-type: ${contentType ?? 'missing'})`);
  }
  const sharp = (await import('sharp')).default;
  const pipeline = (quality) =>
    sharp(buffer)
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
  // sharp decode doubles as the final content validation (v2 #10) — a decode
  // failure throws and the caller skips the photo.
  let output = await pipeline(80);
  for (const quality of [60, 40]) {
    if (output.length <= maxOutputBytes) {
      break;
    }
    output = await pipeline(quality);
  }
  if (output.length > maxOutputBytes) {
    throw new SsrfError(`image still exceeds ${maxOutputBytes} bytes after downscale`);
  }
  return output;
};

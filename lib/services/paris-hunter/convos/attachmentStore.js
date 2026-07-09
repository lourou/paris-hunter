/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: ciphertext attachment store behind one interface
 * upload(payloadBytes, filename, mimeType) -> Promise<url>   (build plan v2 #11/#16)
 *
 * Selected by ATTACHMENT_STORE:
 *  - 's3' (DEFAULT): Scaleway Object Storage via @aws-sdk/client-s3. EVERY upload
 *    carries StorageClass ONEZONE_IA + ACL public-read (user decision — blobs are
 *    ciphertext, public-read leaks nothing but size). convos-cli's own s3 provider
 *    is deliberately NOT used (its hand-rolled SigV4 cannot set these headers).
 *  - 'local': dev/QA fallback — atomic write + retention sweep; requires
 *    ATTACHMENTS_PUBLIC_BASE (receivers fetch over plain HTTPS/HTTP).
 *  - 'convos-api' / 'pinata': rejected with a clear error (platform-internal).
 *
 * All object keys/filenames are prefixed 'attachments/' (#11) so the bucket
 * lifecycle rule ph-attachments-180d (Filter.Prefix='attachments/') matches them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import logger from '../../logger.js';

export const ATTACHMENTS_PREFIX = 'attachments/';

/**
 * @param {string} filename
 * @returns {string} key guaranteed to live under attachments/ with no traversal
 */
export const toAttachmentKey = (filename) => {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('attachment filename must be a non-empty string');
  }
  const key = filename.startsWith(ATTACHMENTS_PREFIX) ? filename : `${ATTACHMENTS_PREFIX}${filename}`;
  if (key.includes('..') || key.includes('//') || key.endsWith('/')) {
    throw new Error(`unsafe attachment key: ${key}`);
  }
  return key;
};

const stripTrailingSlash = (value) => value.replace(/\/+$/, '');

const createS3Store = (env) => {
  const required = ['SCW_S3_ENDPOINT', 'SCW_S3_REGION', 'SCW_S3_BUCKET', 'SCW_ACCESS_KEY', 'SCW_SECRET_KEY'];
  const missing = required.filter((key) => env[key] == null || env[key].trim() === '');
  if (missing.length > 0) {
    throw new Error(`ATTACHMENT_STORE=s3 requires env: ${missing.join(', ')} (see .env.example)`);
  }
  const bucket = env.SCW_S3_BUCKET;
  const region = env.SCW_S3_REGION;
  const publicBase = stripTrailingSlash(
    env.ATTACHMENTS_PUBLIC_BASE && env.ATTACHMENTS_PUBLIC_BASE.trim() !== ''
      ? env.ATTACHMENTS_PUBLIC_BASE
      : `https://${bucket}.s3.${region}.scw.cloud`,
  );
  const client = new S3Client({
    endpoint: env.SCW_S3_ENDPOINT,
    region,
    credentials: { accessKeyId: env.SCW_ACCESS_KEY, secretAccessKey: env.SCW_SECRET_KEY },
    forcePathStyle: false, // virtual-host style so the public URL matches the upload target
  });
  return {
    kind: 's3',
    /**
     * @param {Uint8Array} payloadBytes ciphertext
     * @param {string} filename becomes the object key (made unique by the caller)
     * @param {string} mimeType
     * @returns {Promise<string>} public URL
     */
    upload: async (payloadBytes, filename, mimeType) => {
      const key = toAttachmentKey(filename);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: payloadBytes,
          ContentType: mimeType,
          StorageClass: 'ONEZONE_IA', // MANDATORY on every upload (user decision)
          ACL: 'public-read', // MANDATORY — receivers fetch(url) unauthenticated
        }),
      );
      return `${publicBase}/${key}`;
    },
  };
};

const createLocalStore = (env) => {
  const publicBase = env.ATTACHMENTS_PUBLIC_BASE;
  if (publicBase == null || publicBase.trim() === '') {
    throw new Error(
      'ATTACHMENT_STORE=local requires ATTACHMENTS_PUBLIC_BASE (receivers must be able to fetch the URL)',
    );
  }
  const baseDir = env.ATTACHMENTS_DIR;
  if (baseDir == null || baseDir.trim() === '') {
    throw new Error('ATTACHMENT_STORE=local requires ATTACHMENTS_DIR');
  }
  const retentionDays = Number.parseInt(env.ATTACHMENTS_RETENTION_DAYS ?? '180', 10) || 180;
  const rootDir = path.resolve(baseDir);
  return {
    kind: 'local',
    upload: async (payloadBytes, filename, mimeType) => {
      void mimeType;
      const key = toAttachmentKey(filename);
      const target = path.resolve(rootDir, key);
      if (!target.startsWith(rootDir + path.sep)) {
        throw new Error(`attachment path escapes ${rootDir}: ${key}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmpPath = `${target}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmpPath, payloadBytes);
      fs.renameSync(tmpPath, target);
      return `${stripTrailingSlash(publicBase)}/${key}`;
    },
    /**
     * Delete stored blobs older than the retention window (local store only —
     * the s3 arm relies on the bucket lifecycle rule instead).
     *
     * @returns {number} number of files deleted
     */
    sweepRetention: () => {
      const dir = path.join(rootDir, ATTACHMENTS_PREFIX);
      let deleted = 0;
      let entries;
      try {
        entries = fs.readdirSync(dir);
      } catch (error) {
        if (error.code === 'ENOENT') {
          return 0;
        }
        throw error;
      }
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        const filePath = path.join(dir, entry);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            deleted += 1;
          }
        } catch {
          // raced with another delete — ignore
        }
      }
      if (deleted > 0) {
        logger.info(`convos: attachment retention sweep deleted ${deleted} file(s) older than ${retentionDays}d`);
      }
      return deleted;
    },
  };
};

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{kind: string, upload: (payloadBytes: Uint8Array, filename: string, mimeType: string) => Promise<string>, sweepRetention?: () => number}}
 */
export const createAttachmentStore = (env = process.env) => {
  const kind = env.ATTACHMENT_STORE == null || env.ATTACHMENT_STORE.trim() === '' ? 's3' : env.ATTACHMENT_STORE;
  if (kind === 's3') {
    return createS3Store(env);
  }
  if (kind === 'local') {
    return createLocalStore(env);
  }
  throw new Error(
    `ATTACHMENT_STORE=${kind} is not supported — use 's3' (Scaleway) or 'local'; ` +
      "the Convos presigned API ('convos-api') and 'pinata' are deliberately not implemented",
  );
};

/**
 * Optional live self-test (v1 F11): upload a tiny blob under the QA prefix and
 * GET it back unauthenticated. Run only when PH_SELFTEST=1 (QA).
 *
 * @param {{upload: Function, kind: string}} store
 * @returns {Promise<string>} the public URL that round-tripped
 */
export const selfTestStore = async (store) => {
  const probe = Buffer.from(`paris-hunter self-test ${Date.now()}`);
  const url = await store.upload(probe, `qa-selftest-${Date.now()}.bin`, 'application/octet-stream');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`self-test GET ${url} returned ${response.status}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (!body.equals(probe)) {
    throw new Error(`self-test GET ${url} returned different bytes`);
  }
  logger.info(`convos: attachment store self-test OK (${store.kind}) — ${url}`);
  return url;
};

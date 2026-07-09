/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: one-shot, idempotent Scaleway Object Storage bucket setup.
 *
 * What it does (and deliberately does NOT do):
 *   - NEVER creates the bucket — it is user-owned. HeadBucket must succeed or we abort.
 *   - MERGES lifecycle rules: every foreign pre-existing rule is preserved verbatim; we
 *     upsert OUR rule (ID 'ph-attachments-180d'), scoped to Filter.Prefix 'attachments/'
 *     so it can never expire foreign objects in the bucket. Any other 'ph-attachments-*'
 *     rule (e.g. the superseded 'ph-attachments-30d') is OURS and is REMOVED on apply —
 *     otherwise both rules would coexist and the shorter expiry would win.
 *   - Adds NoncurrentVersionExpiration (180 days) to our rule iff bucket versioning is enabled.
 *
 * Credentials (see docs/DEPLOY.md, "Credential split"):
 *   - Uses SCW_LIFECYCLE_ACCESS_KEY / SCW_LIFECYCLE_SECRET_KEY when BOTH are set
 *     (recommended: an admin-scoped pair kept OFF the VPS), else falls back to
 *     SCW_ACCESS_KEY / SCW_SECRET_KEY from the repo .env.
 *   - Intended to run ONCE from the operator machine, not the VPS:
 *       node --env-file-if-exists=.env tools/paris-hunter/setup-bucket.js [--dry-run]
 *
 * Flags: --dry-run  print the merged lifecycle config without PUTting it
 *        --help     usage
 */

/* eslint-disable no-console */

import {
  S3Client,
  HeadBucketCommand,
  GetBucketVersioningCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';

export const PH_RULE_ID_PREFIX = 'ph-attachments-'; // every rule with this ID prefix is OURS (past or present)
export const PH_RULE_ID = 'ph-attachments-180d';
export const PH_PREFIX = 'attachments/';
export const RETENTION_DAYS = 180;

/**
 * Pure merge: keep every foreign rule verbatim, upsert ours. Any rule whose ID starts
 * with 'ph-attachments-' is treated as ours and replaced — this removes superseded
 * variants (e.g. the old 'ph-attachments-30d') so the shorter expiry cannot win.
 * @param {Array<object>} existingRules rules currently on the bucket (may be empty)
 * @param {boolean} versioningEnabled whether bucket versioning is Enabled
 * @returns {Array<object>} merged rule set to PUT
 */
export const mergeLifecycleRules = (existingRules, versioningEnabled) => {
  const phRule = {
    ID: PH_RULE_ID,
    Status: 'Enabled',
    Filter: { Prefix: PH_PREFIX },
    Expiration: { Days: RETENTION_DAYS },
    ...(versioningEnabled ? { NoncurrentVersionExpiration: { NoncurrentDays: RETENTION_DAYS } } : {}),
  };
  const kept = (existingRules ?? []).filter((rule) => !String(rule?.ID ?? '').startsWith(PH_RULE_ID_PREFIX));
  return [...kept, phRule];
};

const usage = () => {
  console.log('Usage: node --env-file-if-exists=.env tools/paris-hunter/setup-bucket.js [--dry-run|--help]');
  console.log('Idempotent: sets lifecycle rule ph-attachments-180d (prefix attachments/, 180d) on the');
  console.log('user-owned Scaleway bucket, MERGING with existing rules (superseded ph-attachments-*');
  console.log('rules are replaced; foreign rules preserved). Never creates the bucket.');
};

const resolveCredentials = (env) => {
  if (env.SCW_LIFECYCLE_ACCESS_KEY && env.SCW_LIFECYCLE_SECRET_KEY) {
    console.log('Using SCW_LIFECYCLE_* credentials (admin pair).');
    return { accessKeyId: env.SCW_LIFECYCLE_ACCESS_KEY, secretAccessKey: env.SCW_LIFECYCLE_SECRET_KEY };
  }
  if (env.SCW_ACCESS_KEY && env.SCW_SECRET_KEY) {
    console.log('Using SCW_ACCESS_KEY / SCW_SECRET_KEY credentials.');
    return { accessKeyId: env.SCW_ACCESS_KEY, secretAccessKey: env.SCW_SECRET_KEY };
  }
  console.error('ERROR: no Scaleway credentials found. Set SCW_LIFECYCLE_ACCESS_KEY/SCW_LIFECYCLE_SECRET_KEY');
  console.error('or SCW_ACCESS_KEY/SCW_SECRET_KEY (repo .env), e.g. via: node --env-file-if-exists=.env ...');
  process.exit(1);
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    usage();
    return;
  }
  const dryRun = args.includes('--dry-run');

  const env = process.env;
  const endpoint = env.SCW_S3_ENDPOINT || 'https://s3.fr-par.scw.cloud';
  const region = env.SCW_S3_REGION || 'fr-par';
  const bucket = env.SCW_S3_BUCKET || 'paris-hunter';

  const client = new S3Client({
    endpoint,
    region,
    credentials: resolveCredentials(env),
    forcePathStyle: false,
  });

  // 1. Bucket must already exist (user-owned) — never create it.
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`Bucket '${bucket}' exists at ${endpoint} (${region}).`);
  } catch (error) {
    console.error(`ERROR: bucket '${bucket}' not accessible (${error.name}). This tool never creates buckets;`);
    console.error('create it in the Scaleway console first, or fix the credentials/endpoint.');
    process.exit(1);
  }

  // 2. Versioning status decides whether our rule needs NoncurrentVersionExpiration.
  const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  const versioningEnabled = versioning.Status === 'Enabled';
  console.log(`Versioning: ${versioning.Status || 'Disabled'}.`); // Scaleway returns '' when never enabled

  // 3. Read existing rules — tolerate the no-config case.
  let existingRules = [];
  try {
    const current = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    existingRules = current.Rules ?? [];
  } catch (error) {
    if (error.name !== 'NoSuchLifecycleConfiguration') {
      throw error;
    }
  }
  console.log(
    `Existing lifecycle rules: ${existingRules.length ? existingRules.map((r) => r.ID).join(', ') : '(none)'}`,
  );

  // 4. Merge (preserve foreign rules, upsert ours) and PUT.
  const merged = mergeLifecycleRules(existingRules, versioningEnabled);
  if (dryRun) {
    console.log('[dry-run] Would PUT lifecycle configuration:');
    console.log(JSON.stringify({ Rules: merged }, null, 2));
    return;
  }
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: merged },
    }),
  );

  // 5. Verify by re-reading and print the result for the operator.
  const after = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
  console.log('Lifecycle configuration now on the bucket:');
  console.log(JSON.stringify(after.Rules, null, 2));
  const ourRules = (after.Rules ?? []).filter((rule) => String(rule?.ID ?? '').startsWith(PH_RULE_ID_PREFIX));
  if (ourRules.length !== 1 || ourRules[0].ID !== PH_RULE_ID) {
    console.error(
      `ERROR: expected exactly one '${PH_RULE_ID_PREFIX}*' rule ('${PH_RULE_ID}') after PUT, ` +
        `got: ${ourRules.map((r) => r.ID).join(', ') || '(none)'} — investigate before relying on retention.`,
    );
    process.exit(1);
  }
  console.log(`OK: rule '${PH_RULE_ID}' active (prefix '${PH_PREFIX}', ${RETENTION_DAYS} days).`);
};

// Only execute when run directly (keeps mergeLifecycleRules importable in tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

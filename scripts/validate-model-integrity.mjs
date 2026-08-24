#!/usr/bin/env node
/**
 * Model integrity validator — src/core/ModelManifest.js is the only registry.
 *
 * Checks shipped entries against local files (and optionally build output).
 * Does not claim remote Blob hashes passed unless bytes were downloaded
 * and hashed (--download-remote).
 */
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_MANIFEST } from '../src/core/ModelManifest.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const SHA256_RE = /^[0-9a-f]{64}$/;

export function isRequiredShippedModel(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.shipped === false) return false;
  if (entry.optional === true && entry.shipped !== true) return false;
  if (entry.delivery === 'optional' && entry.shipped !== true) return false;
  if (entry.sha256 == null || entry.sizeBytes == null) return false;
  return true;
}

export function shippedModelIds(manifest = MODEL_MANIFEST) {
  return Object.keys(manifest).filter((id) => isRequiredShippedModel(manifest[id]));
}

export function localPathForUrl(url, root, { build = false } = {}) {
  if (typeof url !== 'string' || !url.startsWith('/')) {
    throw new Error(`model url must be a same-origin path, got ${url}`);
  }
  const rel = url.replace(/^\//, '').replace(/\//g, path.sep);
  const base = build ? path.join(root, 'build') : path.join(root, 'public');
  // Manifest URLs are /app/models/... which live under public/app/models.
  if (rel.startsWith('app' + path.sep) || rel.startsWith('app/')) {
    return path.join(base, rel);
  }
  return path.join(base, rel);
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function inspectVercelModelRewrites(vercelJson) {
  const rewrites = Array.isArray(vercelJson?.rewrites) ? vercelJson.rewrites : [];
  const modelRewrites = rewrites.filter((r) => {
    const source = String(r?.source || '');
    return source.includes('/app/models/') || source.includes('/models/');
  });
  return {
    count: modelRewrites.length,
    hasAppModelsRewrite: modelRewrites.some((r) => String(r.source || '').includes('/app/models/')),
    usesBlobStorage: modelRewrites.some((r) => /blob\.vercel-storage\.com/i.test(String(r.destination || ''))),
    destinations: modelRewrites.map((r) => r.destination),
  };
}

function formatMismatch(entry, actualPath, actualSize, actualHash) {
  return [
    `model ${entry.id}`,
    `expected size ${entry.sizeBytes} hash ${entry.sha256}`,
    `actual size ${actualSize == null ? 'missing' : actualSize} hash ${actualHash || 'n/a'}`,
    `delivery path ${entry.url} → ${actualPath}`,
  ].join('; ');
}

/**
 * @param {{
 *   root?: string,
 *   manifest?: object,
 *   requireBuild?: boolean,
 *   downloadRemote?: boolean,
 *   vercelJson?: object|null,
 * }} [options]
 */
export function validateModelIntegrity(options = {}) {
  const root = options.root || ROOT;
  const manifest = options.manifest || MODEL_MANIFEST;
  const errors = [];
  const notices = [];
  const checked = [];

  const ids = shippedModelIds(manifest);
  if (ids.length === 0) {
    errors.push('no shipped model entries were identified in ModelManifest.js');
  }

  for (const id of Object.keys(manifest)) {
    const entry = manifest[id];
    if (isRequiredShippedModel(entry)) continue;
    if (entry?.shipped === false || entry?.optional === true || entry?.delivery === 'optional') {
      notices.push(`skip optional/unshipped model ${id}`);
    } else if (entry?.sha256 == null || entry?.sizeBytes == null) {
      notices.push(`skip unpinned model ${id} (not treated as shipped)`);
    }
  }

  for (const id of ids) {
    const entry = manifest[id];
    if (entry.id !== id) {
      errors.push(`manifest key ${id} does not match entry.id ${entry.id}`);
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) {
      errors.push(`shipped model ${id} has an invalid sha256`);
      continue;
    }
    if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes <= 0) {
      errors.push(`shipped model ${id} has an invalid sizeBytes`);
      continue;
    }
    if (typeof entry.url !== 'string' || !entry.url.startsWith('/app/models/')) {
      errors.push(`shipped model ${id} url must be same-origin /app/models/...`);
      continue;
    }

    const sourcePath = localPathForUrl(entry.url, root, { build: false });
    const result = verifyFile(entry, sourcePath);
    checked.push({ id, path: sourcePath, ...result, role: 'source' });
    if (!result.ok) errors.push(formatMismatch(entry, sourcePath, result.size, result.hash));

    if (options.requireBuild) {
      const buildPath = localPathForUrl(entry.url, root, { build: true });
      const buildResult = verifyFile(entry, buildPath);
      checked.push({ id, path: buildPath, ...buildResult, role: 'build' });
      if (!buildResult.ok) {
        errors.push(formatMismatch(entry, buildPath, buildResult.size, buildResult.hash));
      }
    }
  }

  const vercelJson = options.vercelJson === undefined
    ? readJsonIfExists(path.join(root, 'vercel.json'))
    : options.vercelJson;
  let rewrites = null;
  if (vercelJson) {
    rewrites = inspectVercelModelRewrites(vercelJson);
    if (!rewrites.hasAppModelsRewrite) {
      errors.push('vercel.json must rewrite /app/models/ as the logical Blob delivery path');
    } else if (!rewrites.usesBlobStorage) {
      notices.push('vercel.json /app/models rewrite is present but not a *.blob.vercel-storage.com destination');
    }
  } else {
    notices.push('vercel.json not present; rewrite ownership not checked');
  }

  if (options.downloadRemote) {
    notices.push('download-remote requested — caller must hash downloaded bytes before claiming a remote pass');
  } else {
    notices.push('remote Blob hashes were not downloaded and are not claimed as passed');
  }

  return {
    ok: errors.length === 0,
    errors,
    notices,
    checked,
    shippedIds: ids,
    rewrites,
  };
}

function verifyFile(entry, filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, size: null, hash: null, missing: true };
  }
  const size = fs.statSync(filePath).size;
  const hash = sha256File(filePath);
  const ok = size === entry.sizeBytes && hash === entry.sha256;
  return { ok, size, hash, missing: false };
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const options = { requireBuild: false, downloadRemote: false };
  for (const a of argv) {
    if (a === '--require-build') options.requireBuild = true;
    else if (a === '--download-remote') options.downloadRemote = true;
    else if (a === '--help' || a === '-h') options.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: node scripts/validate-model-integrity.mjs [--require-build] [--download-remote]');
    return 0;
  }
  const result = validateModelIntegrity(options);
  console.log(`[models] shipped entries: ${result.shippedIds.join(', ') || '(none)'}`);
  for (const n of result.notices) console.log(`  notice  ${n}`);
  for (const e of result.errors) console.error(`  error   ${e}`);
  if (result.ok) {
    console.log('[models] OK');
    return 0;
  }
  console.error('[models] FAILED');
  return 1;
}

const invoked = process.argv[1] && path.normalize(path.resolve(process.argv[1]));
if (invoked && path.normalize(__filename) === invoked) {
  main().then((code) => process.exit(code));
}

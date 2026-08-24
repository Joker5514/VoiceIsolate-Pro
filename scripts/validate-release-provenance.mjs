#!/usr/bin/env node
/**
 * Schema-driven release provenance validator.
 *
 * Distinguishes:
 *   - validation errors (malformed records, missing platforms, illegal claims)
 *   - recorded release state (stale / unknown) which is allowed in default mode
 *
 * Default mode (developer / CI unit tests): schema must be valid; stale or
 * unknown platform status does not fail the process.
 * --strict / --release: also fail on stale, unknown, or missing current artifacts.
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

export const REQUIRED_PLATFORMS = Object.freeze(['web', 'android', 'windows']);
export const ALLOWED_STATUSES = Object.freeze(['current', 'stale', 'unknown']);
export const ALLOWED_VERIFICATION_METHODS = Object.freeze([
  'github-release-asset',
  'vercel-deployment',
  'unknown',
]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HTTPS_RE = /^https:\/\//i;

function hasUnsupportedSameBuildClaim(text) {
  const sentences = String(text || '').split(/(?<=[.!?])\s+/);
  return sentences.some((sentence) => {
    if (!/same build/i.test(sentence)) return false;
    if (/\bnot\b/i.test(sentence) || /do\s+\*\*not\*\*/i.test(sentence)) return false;
    return /web/i.test(sentence) && /android/i.test(sentence) && /windows/i.test(sentence);
  });
}

export const AUTHORITATIVE_DOC_PATHS = Object.freeze([
  'CLAUDE.md',
  'docs/DOWNLOADS.md',
  'docs/releases/PLATFORM_SYNC.md',
  'docs/releases/release-provenance.json',
]);

function isIsoTimestamp(value) {
  return typeof value === 'string' && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

function push(errors, pathRef, message) {
  errors.push({ path: pathRef, message });
}

function filenameForPlatform(platform, version) {
  if (platform === 'android') return 'VoiceIsolate-Pro-android-debug.apk';
  if (platform === 'windows') return `VoiceIsolate-Pro-${version}-win-x64.exe`;
  return null;
}

/**
 * @param {unknown} doc
 * @param {{ strict?: boolean, reviewedMainSha?: string|null, docs?: Record<string, string> }} [options]
 * @returns {{
 *   ok: boolean,
 *   errors: Array<{ path: string, message: string }>,
 *   notices: Array<{ path: string, message: string, kind: 'stale'|'unknown' }>,
 *   strictFailures: Array<{ path: string, message: string }>,
 * }}
 */
export function validateProvenance(doc, options = {}) {
  const errors = [];
  const notices = [];
  const strictFailures = [];
  const strict = Boolean(options.strict);

  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    push(errors, '$', 'provenance document must be a JSON object');
    return { ok: false, errors, notices, strictFailures };
  }

  if (doc.schemaVersion !== 1) {
    push(errors, 'schemaVersion', 'schemaVersion must be 1');
  }
  if (typeof doc.productVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(doc.productVersion)) {
    push(errors, 'productVersion', 'productVersion must be a semver X.Y.Z string');
  }
  if (!isIsoTimestamp(doc.generatedAt)) {
    push(errors, 'generatedAt', 'generatedAt must be an ISO-8601 UTC timestamp');
  }
  if (typeof doc.reviewedMainSha !== 'string' || !GIT_SHA_RE.test(doc.reviewedMainSha)) {
    push(errors, 'reviewedMainSha', 'reviewedMainSha must be a full 40-character git SHA');
  }
  if (typeof doc.tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(doc.tag)) {
    push(errors, 'tag', 'tag must look like vX.Y.Z');
  }

  if (!doc.claims || typeof doc.claims !== 'object' || Array.isArray(doc.claims)) {
    push(errors, 'claims', 'claims must be an object');
  } else {
    for (const key of [
      'sameBuildAcrossWebAndroidWindowsMainAndTag',
      'synchronizedPublishedArtifacts',
      'tagMoved',
    ]) {
      if (typeof doc.claims[key] !== 'boolean') {
        push(errors, `claims.${key}`, `${key} must be a boolean`);
      }
    }
    if (doc.claims.tagMoved === true) {
      push(errors, 'claims.tagMoved', 'tagMoved must remain false; v25.0.2 must not be rewritten');
    }
  }

  if (!Array.isArray(doc.platforms)) {
    push(errors, 'platforms', 'platforms must be an array');
    return summarize(errors, notices, strictFailures, strict);
  }

  const seen = Object.create(null);
  for (let i = 0; i < doc.platforms.length; i++) {
    const rec = doc.platforms[i];
    const p = `platforms[${i}]`;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      push(errors, p, 'platform record must be an object');
      continue;
    }
    if (!REQUIRED_PLATFORMS.includes(rec.platform)) {
      push(errors, `${p}.platform`, `platform must be one of ${REQUIRED_PLATFORMS.join(', ')}`);
      continue;
    }
    if (seen[rec.platform]) {
      push(errors, `${p}.platform`, `duplicate platform record for ${rec.platform}`);
      continue;
    }
    seen[rec.platform] = rec;
    validatePlatformRecord(rec, p, doc, errors, notices, strictFailures);
  }

  for (const name of REQUIRED_PLATFORMS) {
    if (!seen[name]) {
      push(errors, 'platforms', `missing required platform record: ${name}`);
    }
  }

  const currentShas = REQUIRED_PLATFORMS
    .map((name) => seen[name])
    .filter((rec) => rec && rec.status === 'current')
    .map((rec) => rec.sourceSha);
  const allCurrent = REQUIRED_PLATFORMS.every((name) => seen[name]?.status === 'current');
  const identicalCurrentSha = allCurrent
    && currentShas.length === REQUIRED_PLATFORMS.length
    && currentShas.every((sha) => sha && sha === currentShas[0] && sha === doc.reviewedMainSha);

  if (doc.claims?.sameBuildAcrossWebAndroidWindowsMainAndTag === true && !identicalCurrentSha) {
    push(
      errors,
      'claims.sameBuildAcrossWebAndroidWindowsMainAndTag',
      'cannot claim the same build across Web, Android, Windows, main, and the release tag unless every platform is current at reviewedMainSha',
    );
  }
  if (doc.claims?.synchronizedPublishedArtifacts === true && !allCurrent) {
    push(
      errors,
      'claims.synchronizedPublishedArtifacts',
      'cannot claim synchronized published artifacts while any platform is stale or unknown',
    );
  }

  if (options.docs && typeof options.docs === 'object') {
    for (const [rel, text] of Object.entries(options.docs)) {
      if (typeof text !== 'string') continue;
      if (doc.claims?.sameBuildAcrossWebAndroidWindowsMainAndTag === true) continue;
      if (hasUnsupportedSameBuildClaim(text)) {
        push(
          errors,
          `docs:${rel}`,
          'authoritative documentation claims Web/Android/Windows/main/tag share the same build, but provenance forbids that claim',
        );
      }
    }
  }

  return summarize(errors, notices, strictFailures, strict);
}

function validatePlatformRecord(rec, p, doc, errors, notices, strictFailures) {
  if (!ALLOWED_STATUSES.includes(rec.status)) {
    push(errors, `${p}.status`, `status must be one of ${ALLOWED_STATUSES.join(', ')}`);
  }
  if (typeof rec.version !== 'string' || rec.version !== doc.productVersion) {
    push(errors, `${p}.version`, `version must match productVersion ${doc.productVersion}`);
  }

  const artifact = rec.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    push(errors, `${p}.artifact`, 'artifact must be an object');
    return;
  }

  const verification = rec.verification;
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    push(errors, `${p}.verification`, 'verification must be an object');
  } else {
    if (!ALLOWED_VERIFICATION_METHODS.includes(verification.method)) {
      push(
        errors,
        `${p}.verification.method`,
        `verification.method must be one of ${ALLOWED_VERIFICATION_METHODS.join(', ')}`,
      );
    }
    if (verification.method === 'repository-head') {
      push(
        errors,
        `${p}.verification.method`,
        'repository-head is not a valid verification method; deployed Web SHA must not be inferred from git HEAD',
      );
    }
    if (typeof verification.evidence !== 'string' || verification.evidence.trim().length < 8) {
      push(errors, `${p}.verification.evidence`, 'verification.evidence must be a non-empty string');
    }
  }

  if (rec.platform === 'web') {
    if (verification?.method === 'repository-head') {
      push(errors, `${p}.verification.method`, 'web provenance must not use repository-head');
    }
    if (
      rec.sourceSha
      && rec.sourceSha === doc.reviewedMainSha
      && verification?.method !== 'vercel-deployment'
    ) {
      push(
        errors,
        `${p}.sourceSha`,
        'web sourceSha matches reviewedMainSha without vercel-deployment verification; refusing to infer deployed Web from repository HEAD',
      );
    }
  }

  if (rec.status === 'current') {
    validateCurrentRecord(rec, p, doc, errors);
  } else if (rec.status === 'stale' || rec.status === 'unknown') {
    notices.push({
      path: p,
      kind: rec.status,
      message: `${rec.platform} is recorded as ${rec.status}`,
    });
    strictFailures.push({
      path: `${p}.status`,
      message: `${rec.platform} status ${rec.status} fails strict release mode`,
    });
    if (rec.sourceSha != null && rec.sourceSha !== '' && !GIT_SHA_RE.test(rec.sourceSha)) {
      push(errors, `${p}.sourceSha`, 'sourceSha must be a full 40-character git SHA when present');
    }
    if (rec.builtAt != null && rec.builtAt !== '' && !isIsoTimestamp(rec.builtAt)) {
      push(errors, `${p}.builtAt`, 'builtAt must be an ISO-8601 UTC timestamp when present');
    }
    if (artifact.sha256 != null && artifact.sha256 !== '' && !SHA256_RE.test(artifact.sha256)) {
      push(errors, `${p}.artifact.sha256`, 'sha256 must be 64 lowercase hex characters when present');
    }
    if (artifact.url != null && artifact.url !== '' && !HTTPS_RE.test(artifact.url)) {
      push(errors, `${p}.artifact.url`, 'artifact.url must be an https URL when present');
    }
    if (rec.platform === 'android' || rec.platform === 'windows') {
      const expectedName = filenameForPlatform(rec.platform, doc.productVersion);
      if (artifact.filename && artifact.filename !== expectedName) {
        push(errors, `${p}.artifact.filename`, `expected filename ${expectedName}`);
      }
    }
  }
}

function validateCurrentRecord(rec, p, doc, errors) {
  if (typeof rec.sourceSha !== 'string' || !GIT_SHA_RE.test(rec.sourceSha)) {
    push(errors, `${p}.sourceSha`, 'current records require a full 40-character sourceSha');
  }
  if (!isIsoTimestamp(rec.builtAt)) {
    push(errors, `${p}.builtAt`, 'current records require builtAt as an ISO-8601 UTC timestamp');
  }
  const artifact = rec.artifact;
  if (rec.platform === 'web') {
    if (!HTTPS_RE.test(artifact.url || '')) {
      push(errors, `${p}.artifact.url`, 'current web records require an https artifact.url');
    }
    if (rec.verification?.method !== 'vercel-deployment') {
      push(
        errors,
        `${p}.verification.method`,
        'current web records require verification.method vercel-deployment',
      );
    }
  } else {
    const expectedName = filenameForPlatform(rec.platform, doc.productVersion);
    if (artifact.filename !== expectedName) {
      push(errors, `${p}.artifact.filename`, `current records require filename ${expectedName}`);
    }
    if (!HTTPS_RE.test(artifact.url || '')) {
      push(errors, `${p}.artifact.url`, 'current records require an https artifact.url');
    }
    if (typeof artifact.sha256 !== 'string' || !SHA256_RE.test(artifact.sha256)) {
      push(errors, `${p}.artifact.sha256`, 'current native records require a 64-character sha256');
    }
    if (!Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) {
      push(errors, `${p}.artifact.sizeBytes`, 'current native records require a positive sizeBytes');
    }
  }
}

function summarize(errors, notices, strictFailures, strict) {
  const ok = errors.length === 0 && (!strict || strictFailures.length === 0);
  return { ok, errors, notices, strictFailures };
}

export function parseProvenanceJson(text) {
  try {
    return { doc: JSON.parse(text), error: null };
  } catch (err) {
    return { doc: null, error: err.message };
  }
}

export function loadAuthoritativeDocs(root = ROOT) {
  const docs = {};
  for (const rel of AUTHORITATIVE_DOC_PATHS) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) docs[rel] = fs.readFileSync(abs, 'utf8');
  }
  return docs;
}

export function validateProvenanceFile(filePath, options = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  const { doc, error } = parseProvenanceJson(text);
  if (error) {
    return {
      ok: false,
      errors: [{ path: filePath, message: `invalid JSON: ${error}` }],
      notices: [],
      strictFailures: [],
    };
  }
  const root = options.root || ROOT;
  const docs = options.docs === null ? undefined : (options.docs || loadAuthoritativeDocs(root));
  return validateProvenance(doc, { ...options, docs });
}

function printReport(result, { strict, filePath }) {
  const mode = strict ? 'strict/release' : 'default';
  console.log(`[provenance] ${filePath} (${mode})`);
  for (const n of result.notices) {
    console.log(`  notice  ${n.path}: ${n.message}`);
  }
  for (const e of result.errors) {
    console.error(`  error   ${e.path}: ${e.message}`);
  }
  if (strict) {
    for (const e of result.strictFailures) {
      console.error(`  strict  ${e.path}: ${e.message}`);
    }
  }
  if (result.ok) {
    console.log('[provenance] OK');
    if (result.notices.length && !strict) {
      console.log('[provenance] recorded stale/unknown release state is allowed in default mode');
    }
  } else {
    console.error('[provenance] FAILED');
  }
}

function parseArgs(argv) {
  const options = { strict: false, file: path.join(ROOT, 'docs/releases/release-provenance.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict' || a === '--release') options.strict = true;
    else if (a === '--file' || a === '-f') options.file = path.resolve(argv[++i]);
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
    console.log('Usage: node scripts/validate-release-provenance.mjs [--strict|--release] [--file path]');
    return 0;
  }
  if (!fs.existsSync(options.file)) {
    console.error(`[provenance] missing file: ${options.file}`);
    return 1;
  }
  const result = validateProvenanceFile(options.file, { strict: options.strict, root: ROOT });
  printReport(result, { strict: options.strict, filePath: options.file });
  return result.ok ? 0 : 1;
}

const invoked = process.argv[1] && path.normalize(path.resolve(process.argv[1]));
if (invoked && path.normalize(__filename) === invoked) {
  main().then((code) => process.exit(code));
}

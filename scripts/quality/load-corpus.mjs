#!/usr/bin/env node
/**
 * load-corpus.mjs — real-recording quality corpus validator (VIP-006).
 *
 * Validates <root>/corpus-manifest.json against the v1 schema, verifies every
 * clip's SHA-256 against the recorded bytes, enforces the license policy, and
 * reports dataset version + metric eligibility. Exit code 0 = the corpus may
 * enter the quality program; anything else = it may not (reasons printed).
 *
 * Usage:
 *   node scripts/quality/load-corpus.mjs --root <dir> [--json <out.json>]
 *     [--allow-private] [--min-clips N] [--min-classes N]
 *
 * --min-clips/--min-classes lower the acceptance bar (>=30 clips / >=4
 * classes) for smoke tests and development corpora; production runs must
 * keep the defaults.
 */
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const allowPrivate = args.includes('--allow-private');
const root = arg('root');
const minClips = Math.max(1, Number(arg('min-clips')) || 30);
const minClasses = Math.max(1, Number(arg('min-classes')) || 4);

const CATEGORIES = new Set([
  'clean-speech', 'quiet-speech', 'whispered-speech',
  'noisy-speech/white', 'noisy-speech/hvac', 'noisy-speech/hum',
  'noisy-speech/babble', 'noisy-speech/street',
  'overlapping-speakers', 'music-with-vocals', 'field-recording',
]);
const SHA_RE = /^[0-9a-f]{64}$/;

function fail(errors) {
  for (const e of errors) console.error(`[corpus] FAIL ${e}`);
  process.exit(1);
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function validateClip(clip, rootDir, errors, allowPriv) {
  const where = `clip ${clip?.id || '<missing id>'}`;
  if (!clip || typeof clip !== 'object') { errors.push(`${where}: not an object`); return null; }
  for (const field of ['id', 'path', 'sha256', 'source', 'license', 'redistribution', 'category']) {
    if (typeof clip[field] !== 'string' || !clip[field].length) errors.push(`${where}: missing ${field}`);
  }
  if (clip.id && !/^[a-z0-9][a-z0-9._-]*$/i.test(clip.id)) errors.push(`${where}: id must be filename-safe`);
  if (clip.sha256 && !SHA_RE.test(String(clip.sha256).toLowerCase())) errors.push(`${where}: sha256 malformed`);
  if (clip.category && !CATEGORIES.has(clip.category)) errors.push(`${where}: unknown category '${clip.category}'`);
  if (clip.redistribution && !['allowed', 'private-only'].includes(clip.redistribution)) {
    errors.push(`${where}: redistribution must be allowed|private-only`);
  }
  if (clip.redistribution === 'private-only' && !allowPriv) {
    errors.push(`${where}: redistribution is private-only (pass --allow-private for local-only runs)`);
  }
  if (clip.path && !String(clip.path).startsWith('audio/')) {
    errors.push(`${where}: path must live under audio/ (got ${clip.path})`);
  }
  // Byte verification is the admission ticket.
  if (clip.path && clip.sha256) {
    const abs = path.join(rootDir, clip.path);
    if (!fs.existsSync(abs)) {
      errors.push(`${where}: file missing at ${clip.path}`);
    } else {
      const actual = sha256File(abs);
      if (actual !== String(clip.sha256).toLowerCase()) {
        errors.push(`${where}: sha256 mismatch (recorded ${clip.sha256}, actual ${actual})`);
      }
    }
  }
  if (clip.reference && clip.reference.alignedTargetPath && clip.reference.alignedTargetSha256) {
    const abs = path.join(rootDir, clip.reference.alignedTargetPath);
    if (!fs.existsSync(abs)) {
      errors.push(`${where}: reference target missing at ${clip.reference.alignedTargetPath}`);
    } else if (sha256File(abs) !== String(clip.reference.alignedTargetSha256).toLowerCase()) {
      errors.push(`${where}: reference target sha256 mismatch`);
    }
    if (!['sample-accurate', 'approximate', 'none'].includes(clip.reference.alignment)) {
      errors.push(`${where}: reference.alignment must be sample-accurate|approximate|none`);
    }
  }
  return {
    id: clip.id,
    category: clip.category,
    license: clip.license,
    redistribution: clip.redistribution,
    metrics: {
      siSdr: Boolean(clip.reference && clip.reference.alignment === 'sample-accurate' && clip.reference.alignedTargetPath),
      stoi: Boolean(clip.reference && clip.reference.alignment === 'sample-accurate' && clip.reference.alignedTargetPath),
      pesq: Boolean(clip.reference && clip.reference.alignment === 'sample-accurate' && clip.reference.alignedTargetPath),
      wer: false, // offline ASR not bundled — recorded honestly, never claimed
      levelAndRuntime: true,
    },
  };
}

function main() {
  if (!root) fail(['--root <corpus-root> is required']);
  const rootDir = path.resolve(root);
  const manifestPath = path.join(rootDir, 'corpus-manifest.json');
  if (!fs.existsSync(manifestPath)) fail([`no corpus-manifest.json under ${rootDir}`]);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail([`corpus-manifest.json is not valid JSON: ${err.message}`]);
    return;
  }

  const errors = [];
  if (manifest.schema !== 'vip-quality-corpus') errors.push(`unknown schema '${manifest.schema}'`);
  if (manifest.schemaVersion !== 1) errors.push(`unsupported schemaVersion ${manifest.schemaVersion}`);
  if (typeof manifest.datasetVersion !== 'string' || !manifest.datasetVersion) errors.push('datasetVersion is required');
  if (!Array.isArray(manifest.clips) || manifest.clips.length === 0) errors.push('clips must be a non-empty array');

  const clips = (manifest.clips || []).map((c) => validateClip(c, rootDir, errors, allowPrivate)).filter(Boolean);
  const categories = new Set(clips.map((c) => c.category));
  if (clips.length < minClips) errors.push(`acceptance bar is >= ${minClips} clips (have ${clips.length})`);
  if (categories.size < minClasses) errors.push(`acceptance bar is >= ${minClasses} noise/content classes (have ${categories.size})`);

  if (errors.length) fail(errors);

  const report = {
    datasetVersion: manifest.datasetVersion,
    root: rootDir,
    clips: clips.length,
    categories: [...categories].sort(),
    metricEligibility: {
      referenceAlignedClips: clips.filter((c) => c.metrics.siSdr).length,
      werCapableClips: 0,
      note: 'WER requires a pinned offline ASR (not bundled). PESQ/STOI tooling versions must be recorded at run time.',
    },
    licensePolicy: manifest.licensePolicy || null,
  };
  const jsonOut = arg('json');
  if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[corpus] OK dataset ${report.datasetVersion}: ${report.clips} clips, ${report.categories.length} classes, ${report.metricEligibility.referenceAlignedClips} reference-aligned`);
}

main();

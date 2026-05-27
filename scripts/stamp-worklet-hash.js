#!/usr/bin/env node
/**
 * scripts/stamp-worklet-hash.js
 * ------------------------------
 * Computes the SHA-256 of public/app/dsp-processor.js and stamps it into
 * public/app/pipeline-orchestrator.js so the Vercel Blob CDN integrity check
 * always matches the current deployed worklet.
 *
 * Source match: /WORKLET_SOURCE_SHA256 = '[0-9a-f]{64}'/
 * The constant must already exist in pipeline-orchestrator.js (idempotent).
 *
 * Run by Vercel buildCommand AFTER dsp-processor.js is finalised:
 *   node scripts/stamp-worklet-hash.js
 *
 * Build ID source priority (same pattern as stamp-sw-version.js):
 *   1. VERCEL_GIT_COMMIT_SHA  — Vercel build env
 *   2. GITHUB_SHA             — GitHub Actions
 *   3. git rev-parse --short HEAD
 *   4. ISO date fallback
 *
 * WORKLET_BUILD_STAMP is also stamped into pipeline-orchestrator.js next to the
 * hash so the UI tooltip can display which build the blob was pinned from.
 */

'use strict';
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { execSync } = require('child_process');

const WORKLET_SRC  = path.join(__dirname, '..', 'public', 'app', 'dsp-processor.js');
const ORCH_SRC     = path.join(__dirname, '..', 'public', 'app', 'pipeline-orchestrator.js');

// ── Helpers ──────────────────────────────────────────────────────────────────
function resolveBuildId() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  if (process.env.GITHUB_SHA)            return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 12);
  }
}

function sha256Hex(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  // Guard: both files must exist
  if (!fs.existsSync(WORKLET_SRC)) {
    console.error('[stamp-worklet-hash] FATAL: dsp-processor.js not found at', WORKLET_SRC);
    process.exit(1);
  }
  if (!fs.existsSync(ORCH_SRC)) {
    console.error('[stamp-worklet-hash] FATAL: pipeline-orchestrator.js not found at', ORCH_SRC);
    process.exit(1);
  }

  const newHash   = sha256Hex(WORKLET_SRC);
  const buildId   = resolveBuildId();
  const buildDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let src = fs.readFileSync(ORCH_SRC, 'utf8');

  // ── 1. Stamp WORKLET_SOURCE_SHA256 ──────────────────────────────────────
  const hashRe = /(const WORKLET_SOURCE_SHA256\s*=\s*')[0-9a-f]{64}(')/;
  if (!hashRe.test(src)) {
    console.error(
      '[stamp-worklet-hash] FATAL: WORKLET_SOURCE_SHA256 constant not found in pipeline-orchestrator.js.\n' +
      '  Expected pattern: const WORKLET_SOURCE_SHA256 = \'<64 hex chars>\''
    );
    process.exit(1);
  }
  src = src.replace(hashRe, `$1${newHash}$2`);

  // ── 2. Stamp WORKLET_BUILD_STAMP (create if absent, update if present) ──
  // Format: const WORKLET_BUILD_STAMP = 'abc1234 · 2026-05-26';
  const stampValue = `${buildId} \u00b7 ${buildDate}`;
  const stampRe    = /(const WORKLET_BUILD_STAMP\s*=\s*')[^']*(')/;
  if (stampRe.test(src)) {
    src = src.replace(stampRe, `$1${stampValue}$2`);
  } else {
    // Insert immediately after the WORKLET_SOURCE_SHA256 line
    src = src.replace(
      /(const WORKLET_SOURCE_SHA256\s*=\s*'[0-9a-f]{64}';)/,
      `$1\nconst WORKLET_BUILD_STAMP = '${stampValue}';`
    );
  }

  fs.writeFileSync(ORCH_SRC, src, 'utf8');

  console.info(`[stamp-worklet-hash] WORKLET_SOURCE_SHA256 -> '${newHash}'`);
  console.info(`[stamp-worklet-hash] WORKLET_BUILD_STAMP   -> '${stampValue}'`);
}

main();

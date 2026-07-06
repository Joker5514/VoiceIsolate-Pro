#!/usr/bin/env node
'use strict';

/**
 * VoiceIsolate Pro — AudioWorklet packaging verifier
 *
 * Ensures all registered worklets:
 *   1. Exist at canonical source paths with registerProcessor()
 *   2. Are present in build/ after `pnpm build` (when build/ exists)
 *   3. Match SHA-256 pins in public/app/models-manifest.json (when present)
 *   4. Are listed in public/app/sw.js APP_SHELL for offline precache
 *
 * Used by: pnpm validate, CI release-build, tests/worklet-packaging.test.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(__dirname, 'worklet-manifest.json');
const MODELS_MANIFEST = path.join(ROOT, 'public', 'app', 'models-manifest.json');
const SW_PATH = path.join(ROOT, 'public', 'app', 'sw.js');

/** LF-normalized SHA-256 so Windows CRLF working copies match Linux CI / git blobs. */
function sha256File(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  const normalized = raw.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function loadWorkletManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function loadModelsManifestWorklets() {
  if (!fs.existsSync(MODELS_MANIFEST)) return {};
  const doc = JSON.parse(fs.readFileSync(MODELS_MANIFEST, 'utf8'));
  return doc.worklets || {};
}

function extractAppShellUrls(swSrc) {
  const block = swSrc.match(/const APP_SHELL\s*=\s*\[([\s\S]*?)\];/);
  if (!block) return [];
  const urls = [];
  const re = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(block[1]))) urls.push(m[1]);
  return urls;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.requireBuild=false] Fail if build/ copies are missing
 * @param {boolean} [options.requireAndroid=false] Fail if cap-sync android assets missing
 * @param {boolean} [options.quiet=false]
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function verifyWorklets(options = {}) {
  const { requireBuild = false, requireAndroid = false, quiet = false } = options;
  const errors = [];
  const warnings = [];
  const log = (msg) => { if (!quiet) console.log(msg); };

  log('\n🔊 VoiceIsolate Pro — AudioWorklet Verifier\n');

  const registry = loadWorkletManifest();
  const modelsWorklets = loadModelsManifestWorklets();
  const swSrc = fs.existsSync(SW_PATH) ? fs.readFileSync(SW_PATH, 'utf8') : '';
  const appShell = extractAppShellUrls(swSrc);

  for (const entry of registry.worklets) {
    const srcAbs = path.join(ROOT, entry.source);
    log(`  ${entry.id} (${entry.role})`);

    if (!fs.existsSync(srcAbs)) {
      errors.push(`Missing source: ${entry.source}`);
      continue;
    }

    const srcBody = fs.readFileSync(srcAbs, 'utf8');
    if (!srcBody.includes(`registerProcessor('${entry.processorName}'`)) {
      errors.push(`${entry.source}: missing registerProcessor('${entry.processorName}')`);
    } else {
      log(`    ✓ source + registerProcessor`);
    }

    const hash = sha256File(srcAbs);
    const manifestKey = entry.id === 'vip-gate' ? 'gate_processor'
      : entry.id === 'vip-deesser' ? 'deesser_processor'
      : entry.id;
    const manifestEntry = modelsWorklets[manifestKey] || modelsWorklets[entry.id.replace(/-/g, '_')];
    if (manifestEntry) {
      const pinned = manifestEntry.sources?.[0]?.sha256 || manifestEntry.sha256;
      if (pinned && pinned !== hash) {
        errors.push(`${entry.source}: SHA-256 mismatch (manifest ${pinned.slice(0, 12)}… vs actual ${hash.slice(0, 12)}…). Run: pnpm worklets:hash`);
      } else if (pinned) {
        log(`    ✓ SHA-256 matches models-manifest.json`);
      }
    } else if (entry.role === 'active') {
      warnings.push(`No models-manifest.json entry for active worklet '${entry.id}'`);
    }

    if (!appShell.includes(entry.url)) {
      errors.push(`${entry.url} missing from public/app/sw.js APP_SHELL precache`);
    } else {
      log(`    ✓ APP_SHELL precache`);
    }

    const buildAbs = path.join(ROOT, entry.buildPath);
    if (fs.existsSync(buildAbs)) {
      if (sha256File(buildAbs) !== hash) {
        errors.push(`${entry.buildPath}: out of sync with ${entry.source} — run pnpm build`);
      } else {
        log(`    ✓ build/ copy in sync`);
      }
    } else if (requireBuild) {
      errors.push(`Missing build copy: ${entry.buildPath} (run pnpm build)`);
    } else {
      log(`    ℹ  build/ copy not checked (${entry.buildPath} absent — run pnpm build locally)`);
    }

    const androidAbs = path.join(ROOT, entry.androidAssetPath);
    if (fs.existsSync(androidAbs)) {
      if (sha256File(androidAbs) !== hash) {
        errors.push(`${entry.androidAssetPath}: out of sync — run pnpm build && npx cap sync android`);
      } else {
        log(`    ✓ Android assets in sync`);
      }
    } else if (requireAndroid) {
      errors.push(`Missing Android asset: ${entry.androidAssetPath} (run pnpm build && npx cap sync android)`);
    }
  }

  if (warnings.length) {
    log('\nWarnings:');
    warnings.forEach((w) => log(`  ⚠ ${w}`));
  }

  if (errors.length) {
    log('\n❌ Worklet verification failed:\n');
    errors.forEach((e) => log(`  ✗ ${e}`));
    return { ok: false, errors, warnings };
  }

  log('\n✅ All worklets verified\n');
  return { ok: true, errors, warnings };
}

if (require.main === module) {
  const requireBuild = process.argv.includes('--require-build');
  const requireAndroid = process.argv.includes('--require-android');
  const result = verifyWorklets({ requireBuild, requireAndroid });
  process.exit(result.ok ? 0 : 1);
}

module.exports = { verifyWorklets, loadWorkletManifest, sha256File };
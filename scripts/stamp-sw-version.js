#!/usr/bin/env node
/**
 * scripts/stamp-sw-version.js
 * ---------------------------
 * Stamps a unique build identifier into public/app/sw.js so the
 * service-worker cache invalidates on every deploy.
 *
 * Source matches /'vip-app-[^']+'/ (idempotent: replaces v1 OR a prior stamp).
 * Build ID source priority:
 *   1. VERCEL_GIT_COMMIT_SHA  (Vercel build env, set automatically)
 *   2. GITHUB_SHA             (GitHub Actions)
 *   3. `git rev-parse --short HEAD`
 *   4. ISO date stamp (last-resort fallback for offline builds)
 *
 * Run by Vercel buildCommand (vercel.json), NOT postinstall — local dev keeps
 * the source value to avoid a dirty git state.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SW_PATH = path.join(__dirname, '..', 'public', 'app', 'sw.js');

function resolveBuildId() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  }
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA.slice(0, 7);
  }
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 12);
  }
}

function main() {
  if (!fs.existsSync(SW_PATH)) {
    console.error('[stamp-sw-version] FATAL: sw.js not found at', SW_PATH);
    process.exit(1);
  }

  const buildId = resolveBuildId();
  const newVersion = `vip-app-${buildId}`;
  const src = fs.readFileSync(SW_PATH, 'utf8');

  const re = /'vip-app-[^']+'/;
  if (!re.test(src)) {
    console.error('[stamp-sw-version] FATAL: no CACHE_VERSION literal matching /\'vip-app-[^\']+\'/ found in sw.js');
    process.exit(1);
  }

  const updated = src.replace(re, `'${newVersion}'`);
  fs.writeFileSync(SW_PATH, updated);
  console.info(`[stamp-sw-version] CACHE_VERSION -> '${newVersion}'`);
}

main();

#!/usr/bin/env node
/**
 * Apply CI workflow patches from docs/ci-patches/ → .github/workflows/
 *
 * Why: some CI agents cannot push `.github/workflows/*` without OAuth
 * `workflow` scope. Maintainers with that scope run this then commit/push.
 *
 * Usage:
 *   node scripts/apply-ci-patches.mjs
 *   node scripts/apply-ci-patches.mjs --check   # exit 1 if out of date
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const patches = [
  ['docs/ci-patches/deploy.yml', '.github/workflows/deploy.yml'],
  ['docs/ci-patches/release-build.yml', '.github/workflows/release-build.yml'],
];

const checkOnly = process.argv.includes('--check');
let dirty = false;

for (const [fromRel, toRel] of patches) {
  const from = path.join(root, fromRel);
  const to = path.join(root, toRel);
  if (!fs.existsSync(from)) {
    console.error(`[apply-ci-patches] missing source: ${fromRel}`);
    process.exit(1);
  }
  const next = fs.readFileSync(from, 'utf8');
  const prev = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : '';
  if (prev === next) {
    console.log(`[apply-ci-patches] up to date: ${toRel}`);
    continue;
  }
  dirty = true;
  if (checkOnly) {
    console.error(`[apply-ci-patches] out of date: ${toRel}`);
    continue;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, next, 'utf8');
  console.log(`[apply-ci-patches] wrote ${toRel}`);
}

if (checkOnly && dirty) process.exit(1);
if (!checkOnly && dirty) {
  console.log(`
Next (requires GitHub OAuth scope "workflow"):
  git add .github/workflows/
  git commit -m "fix(ci): unbreak deploy.yml and Android release install"
  git push
`);
} else if (!dirty) {
  console.log('[apply-ci-patches] nothing to do');
}

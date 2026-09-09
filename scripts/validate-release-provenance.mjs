#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_ML_MODEL_IDS, DENOISE_CHAIN_MODEL_IDS } from '../src/core/ml-defaults.js';
import { MODEL_MANIFEST } from '../src/core/ModelManifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const provenance = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/releases/release-provenance.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const downloads = fs.readFileSync(path.join(ROOT, 'docs/DOWNLOADS.md'), 'utf8');
const sync = fs.readFileSync(path.join(ROOT, 'docs/releases/PLATFORM_SYNC.md'), 'utf8');
const errors = [];
const warnings = [];
const sha = /^[0-9a-f]{40}$/;

if (provenance.productVersion !== pkg.version) errors.push(`productVersion ${provenance.productVersion} != package ${pkg.version}`);
if (provenance.releaseTag?.name !== `v${pkg.version}`) errors.push('release tag does not match package version');
if (!sha.test(provenance.releaseTag?.sourceCommit || '')) errors.push('release tag sourceCommit must be a full SHA');
for (const platform of provenance.platforms || []) {
  if (platform.publicVersion !== pkg.version) errors.push(`${platform.platform}: publicVersion differs from package`);
  if (platform.sourceCommit !== null && !sha.test(platform.sourceCommit)) errors.push(`${platform.platform}: sourceCommit must be null or full SHA`);
  if (!['current', 'stale', 'unknown'].includes(platform.status)) errors.push(`${platform.platform}: invalid status`);
  if (platform.status !== 'current') warnings.push(`${platform.platform}: ${platform.status}`);
  if (!platform.artifactSha256) warnings.push(`${platform.platform}: artifact SHA-256 unknown`);
}
if (/\*\*same\*\* `build\/` shell/.test(downloads) || /Native = web/.test(sync)) {
  errors.push('documentation makes unsupported native/Web same-build claim');
}
const chainText = (ids) => `\`[${ids.map((id) => `'${id}'`).join(', ')}]\``;
const defaultText = chainText(DEFAULT_ML_MODEL_IDS);
const maximumText = chainText(DENOISE_CHAIN_MODEL_IDS);
if (!claude.includes(`**Default isolation chain:** ${defaultText}`)) errors.push(`CLAUDE.md default chain must be ${defaultText}`);
if (!claude.includes(`**Optional maximum chain:** ${maximumText}`)) errors.push(`CLAUDE.md maximum chain must be ${maximumText}`);
for (const id of DEFAULT_ML_MODEL_IDS) {
  const model = MODEL_MANIFEST[id];
  if (!model || model.optional || model.shipped === false || !model.sha256) errors.push(`default model ${id} is not pinned and shipped`);
}

for (const warning of warnings) console.warn(`[provenance] WARN ${warning}`);
for (const error of errors) console.error(`[provenance] ERROR ${error}`);
if (errors.length || (process.argv.includes('--strict') && warnings.length)) process.exit(1);
console.log(`[provenance] valid (${warnings.length} explicit stale/unknown fields)`);

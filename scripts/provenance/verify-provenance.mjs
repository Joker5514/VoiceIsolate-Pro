#!/usr/bin/env node
/**
 * VIP-038 — per-artifact release provenance (verifier). Fails closed.
 *
 * Recomputes the artifact checksum from the sidecar and compares it;
 * checks the sidecar's schema, commit format, and version presence;
 * and, when run inside the source repo, recomputes the lockfile and
 * model-manifest bindings and fails on mismatch. Any failure exits 1
 * with the reasons printed — verification never warns-and-continues.
 *
 * What the verifier cannot do: prove the sidecar itself was written
 * by an authorized builder (it is unsigned — see
 * docs/guides/RELEASE_PROVENANCE.md). It proves the artifact matches
 * the sidecar and the sidecar's bindings match this repo, nothing more.
 *
 * Usage:
 *   node scripts/provenance/verify-provenance.mjs --sidecar <path>
 *     [--artifact <path>]   (defaults to the path recorded in the sidecar)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const shaFile = (file) => {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
};
const shaText = (text) => crypto.createHash('sha256').update(text).digest('hex');
const walk = (dir, base = dir) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
};

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] ?? true;
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (!args.sidecar) {
  console.error('usage: verify-provenance.mjs --sidecar <path> [--artifact <path>]');
  process.exit(2);
}
const sidecarPath = path.resolve(ROOT, args.sidecar);
const failures = [];
if (!fs.existsSync(sidecarPath)) {
  console.error(`FAIL: sidecar not found: ${sidecarPath}`);
  process.exit(1);
}
let sidecar;
try {
  sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
} catch (e) {
  console.error(`FAIL: sidecar is not valid JSON: ${e.message}`);
  process.exit(1);
}
if (sidecar.schema !== 'vip-artifact-provenance' || sidecar.schemaVersion !== 1) failures.push(`unsupported schema ${sidecar.schema}/${sidecar.schemaVersion}`);
if (!sidecar.source?.commit || !/^[0-9a-f]{40}$/.test(sidecar.source.commit)) failures.push('missing or malformed source commit');
if (!sidecar.source?.version) failures.push('missing application version');
if (!sidecar.artifact?.path || !sidecar.artifact?.kind) failures.push('missing artifact binding');
if (sidecar.signature != null) failures.push('unexpected signature field (this scheme is unsigned; a signature claim would be a forgery risk)');
const artifactPath = args.artifact ? path.resolve(ROOT, args.artifact) : path.join(ROOT, sidecar.artifact.path);
if (!fs.existsSync(artifactPath)) {
  failures.push(`artifact not found: ${artifactPath}`);
} else if (sidecar.artifact.kind === 'file') {
  const actual = shaFile(artifactPath);
  if (actual !== sidecar.artifact.sha256) failures.push(`file checksum mismatch: artifact ${actual.slice(0, 12)}… != sidecar ${String(sidecar.artifact.sha256).slice(0, 12)}…`);
} else if (sidecar.artifact.kind === 'directory') {
  // The sidecar itself lives inside the artifact dir by default; it is
  // not part of the manifest (it did not exist when the manifest was
  // computed) and must be excluded, or verification can never pass.
  const recorded = new Map((sidecar.artifact.files || []).map((f) => [f.path, f.sha256]));
  const actualFiles = walk(artifactPath).filter((f) => path.join(artifactPath, f) !== sidecarPath);
  const actual = new Map(actualFiles.map((f) => [f, shaFile(path.join(artifactPath, f))]));
  for (const [f, sha] of recorded) {
    if (!actual.has(f)) failures.push(`missing file in artifact: ${f}`);
    else if (actual.get(f) !== sha) failures.push(`checksum mismatch: ${f}`);
  }
  for (const f of actual.keys()) {
    if (!recorded.has(f)) failures.push(`unrecorded file in artifact: ${f}`);
  }
  const manifest = [...recorded.entries()].map(([p, sha256]) => ({ path: p, sha256 })).sort((a, b) => (a.path < b.path ? -1 : 1));
  if (shaText(JSON.stringify(manifest)) !== sidecar.artifact.manifestSha256) failures.push('manifest root hash mismatch');
}
// Repo bindings, when the repo files are present to check against.
for (const [key, rel] of [['lockfileSha256', 'pnpm-lock.yaml'], ['modelManifestSha256', 'src/core/ModelManifest.js']]) {
  const recorded = sidecar.bindings?.[key];
  const p = path.join(ROOT, rel);
  if (recorded == null) failures.push(`missing binding: ${key}`);
  else if (fs.existsSync(p) && shaFile(p) !== recorded) failures.push(`binding mismatch: ${key} (repo file changed since the sidecar was written)`);
}
if (failures.length) {
  console.error('FAIL: provenance verification failed (fail closed):');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS: ${path.relative(ROOT, sidecarPath)} matches artifact ${path.relative(ROOT, artifactPath)} (commit ${sidecar.source.commit.slice(0, 8)}, platform ${sidecar.artifact.platform})`);

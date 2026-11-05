#!/usr/bin/env node
/**
 * VIP-038 — per-artifact release provenance (generator).
 *
 * Binds one built artifact to everything needed to trace it back to
 * its exact source:
 *
 *   - repository + exact source commit (git rev-parse HEAD)
 *   - application version (package.json) + build id when present
 *   - artifact checksum: a single file's SHA-256, or for a directory
 *     a manifest of every file's SHA-256 plus a root hash over it
 *   - toolchain: Node version, generator version
 *   - dependency/model bindings: SHA-256 of pnpm-lock.yaml and of
 *     src/core/ModelManifest.js (when those files exist in the repo
 *     the artifact was built from)
 *   - build workflow/run when the caller supplies them (--workflow,
 *     --run); these are recorded as supplied, never invented — a
 *     sidecar without them says so ("unknown"), it does not guess.
 *
 * What this is NOT: a signature. Nothing here is cryptographically
 * signed by the project; the sidecar is an integrity binding
 * (recompute-and-compare), not an attestation. See
 * docs/guides/RELEASE_PROVENANCE.md for what is and is not
 * independently attestable.
 *
 * Usage:
 *   node scripts/provenance/generate-provenance.mjs \
 *     --artifact build/ --platform web [--workflow ci.yml --run 123] \
 *     [--out build/provenance.sidecar.json]
 * Default --out is <artifact>.provenance.json for a file, or
 * <artifact>/provenance.sidecar.json for a directory.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = 'vip-artifact-provenance';
const SCHEMA_VERSION = 1;

const shaFile = (file) => {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
};
const shaText = (text) => crypto.createHash('sha256').update(text).digest('hex');
const shaIfExists = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? shaFile(p) : null;
};
const git = (args) => {
  try { return execSync(`git ${args}`, { cwd: ROOT }).toString().trim(); } catch { return null; }
};
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
if (!args.artifact || !args.platform) {
  console.error('usage: generate-provenance.mjs --artifact <path> --platform <web|android|windows> [--workflow <name> --run <id> --out <path>]');
  process.exit(2);
}
const artifactPath = path.resolve(ROOT, args.artifact);
if (!fs.existsSync(artifactPath)) {
  console.error(`artifact not found: ${artifactPath}`);
  process.exit(1);
}
const stat = fs.statSync(artifactPath);
let artifact;
if (stat.isFile()) {
  artifact = { kind: 'file', sha256: shaFile(artifactPath), bytes: stat.size };
} else if (stat.isDirectory()) {
  const files = walk(artifactPath);
  // Globally sorted by path so the root hash is stable and the
  // verifier's reconstruction matches byte-for-byte.
  const manifest = files
    .map((f) => ({ path: f, sha256: shaFile(path.join(artifactPath, f)) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  artifact = {
    kind: 'directory',
    fileCount: manifest.length,
    manifestSha256: shaText(JSON.stringify(manifest)),
    files: manifest,
  };
} else {
  console.error('artifact must be a file or directory');
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const sidecar = {
  schema: SCHEMA,
  schemaVersion: SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  generator: 'scripts/provenance/generate-provenance.mjs',
  artifact: {
    platform: args.platform,
    path: path.relative(ROOT, artifactPath),
    ...artifact,
  },
  source: {
    repository: git('config --get remote.origin.url'),
    commit: git('rev-parse HEAD'),
    version: pkg.version || null,
  },
  toolchain: {
    node: process.version,
  },
  bindings: {
    lockfileSha256: shaIfExists('pnpm-lock.yaml'),
    modelManifestSha256: shaIfExists('src/core/ModelManifest.js'),
    modelsManifestSha256: shaIfExists('public/app/models/models-manifest.json'),
  },
  build: {
    workflow: args.workflow || 'unknown',
    run: args.run || 'unknown',
  },
  signature: null,
};
if (!sidecar.source.commit || !/^[0-9a-f]{40}$/.test(sidecar.source.commit)) {
  console.error('refusing to generate provenance without an exact source commit (not a git checkout?)');
  process.exit(1);
}
const out = args.out
  ? path.resolve(ROOT, args.out)
  : stat.isFile()
    ? `${artifactPath}.provenance.json`
    : path.join(artifactPath, 'provenance.sidecar.json');
fs.writeFileSync(out, `${JSON.stringify(sidecar, null, 2)}\n`);
console.log(`[provenance] wrote ${path.relative(ROOT, out)} for ${sidecar.artifact.path} (${sidecar.artifact.kind}, platform ${args.platform}, commit ${sidecar.source.commit.slice(0, 8)})`);

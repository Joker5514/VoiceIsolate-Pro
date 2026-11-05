/**
 * tests/model-manifest-sync.test.js
 *
 * VIP-003 / VIP-012 (IMPLEMENTATION_READINESS_AUDIT_2026-11-02):
 *  - the packaging registry (public/app/models-manifest.json) is a generated
 *    artifact of the canonical src/core/ModelManifest.js — `--check` proves the
 *    tree is in sync;
 *  - optional/unshipped model entries never block delivery validation;
 *  - required (shipped) entries still fail on missing / stub / unreachable;
 *  - prod:verify keeps byte-integrity in the hermetic static tier and remote
 *    delivery liveness in the opt-in network tier;
 *  - the hand-maintained model-card document covers every shipped file.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG_MANIFEST = path.join(ROOT, 'public', 'app', 'models-manifest.json');
const CARD_MANIFEST = path.join(ROOT, 'public', 'app', 'models', 'models-manifest.json');

let sync; // scripts/sync-model-manifests.mjs (ESM)
let MODEL_MANIFEST;
let classifyResult; // scripts/validate-onnx-models.js (CJS)
let integrity; // scripts/validate-model-integrity.mjs (ESM) — canonical "shipped" predicates

beforeAll(async () => {
  sync = await import('../scripts/sync-model-manifests.mjs');
  ({ MODEL_MANIFEST } = await import('../src/core/ModelManifest.js'));
  ({ classifyResult } = require('../scripts/validate-onnx-models.js'));
  integrity = await import('../scripts/validate-model-integrity.mjs');
});

describe('packaging model registry generation (VIP-012)', () => {
  test('public/app/models-manifest.json is in sync with ModelManifest.js', () => {
    let out = '';
    let status = 0;
    try {
      out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-model-manifests.mjs'), '--check'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    } catch (err) {
      status = err.status;
      out = `${err.stdout || ''}${err.stderr || ''}`;
    }
    expect(status).toBe(0);
    expect(out).toContain('OK');
  });

  test('generated models section is exactly the deliverable set plus documented legacy aliases', () => {
    const file = JSON.parse(fs.readFileSync(PKG_MANIFEST, 'utf8'));
    const rebuilt = sync.buildModelsSection(MODEL_MANIFEST, file.models);
    // Deterministic: regenerating from the canonical registry reproduces the file.
    expect(file.models).toEqual(rebuilt);
    const canonicalIds = sync.deliverables(MODEL_MANIFEST).map(([id]) => id);
    for (const id of canonicalIds) {
      expect(file.models[id]).toBeDefined();
    }
    // Aliases are byte-identical copies of their canonical entries.
    for (const [alias, canonical] of Object.entries(sync.LEGACY_ALIASES)) {
      expect(file.models[alias]).toEqual(file.models[canonical]);
    }
  });

  test('placeholder entries with sizeBytes null never enter the packaging registry', () => {
    const file = JSON.parse(fs.readFileSync(PKG_MANIFEST, 'utf8'));
    for (const id of ['bsrnn_complex', 'sam_audio', 'universal_separator']) {
      expect(MODEL_MANIFEST[id].sizeBytes).toBeNull();
      expect(file.models[id]).toBeUndefined();
    }
  });

  test('every shipped canonical model exists on disk with the exact pinned size', () => {
    // "Shipped" means exactly what scripts/validate-model-integrity.mjs means
    // by it (isRequiredShippedModel) — one definition, no drift.
    const shippedIds = integrity.shippedModelIds(MODEL_MANIFEST);
    expect(shippedIds.length).toBeGreaterThan(0);
    for (const id of shippedIds) {
      const entry = MODEL_MANIFEST[id];
      if (integrity.isCompositeModel(entry)) {
        for (const partId of Object.values(entry.parts)) {
          const part = MODEL_MANIFEST[partId];
          const file = path.join(ROOT, 'public', part.url.replace(/^\//, ''));
          expect(fs.existsSync(file)).toBe(true);
          expect(fs.statSync(file).size).toBe(part.sizeBytes);
        }
        continue;
      }
      const file = path.join(ROOT, 'public', entry.url.replace(/^\//, ''));
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).size).toBe(entry.sizeBytes);
    }
  });

  test('optional/unshipped packaging entries carry explicit flags', () => {
    const file = JSON.parse(fs.readFileSync(PKG_MANIFEST, 'utf8'));
    for (const id of ['demucs', 'ecapa_tdnn']) {
      expect(file.models[id].optional).toBe(true);
      expect(file.models[id].shipped).toBe(false);
    }
  });

  test('hand-maintained model-card document covers every shipped file (drift guard)', () => {
    const cards = JSON.parse(fs.readFileSync(CARD_MANIFEST, 'utf8'));
    const cardFiles = new Set(cards.models.map((m) => m.filename));
    for (const [, entry] of Object.entries(MODEL_MANIFEST)) {
      if (integrity.isExplicitlyOptional(entry)) continue;
      if (integrity.isCompositeModel(entry)) continue;
      expect(cardFiles.has(path.basename(entry.url))).toBe(true);
    }
  });
});

describe('delivery validation classification (VIP-003)', () => {
  const base = { min_bytes: 1000 };

  test('required entry passes on a real binary', () => {
    expect(classifyResult({ ...base, status: 200, contentLength: 5000 })).toBe('ok');
  });

  test('required entry reports unreachable / missing / stub as failures', () => {
    expect(classifyResult({ ...base, status: 0, contentLength: 0, error: 'timeout' })).toBe('unreachable');
    expect(classifyResult({ ...base, status: 404, contentLength: 0 })).toBe('missing');
    expect(classifyResult({ ...base, status: 200, contentLength: 500 })).toBe('stub');
  });

  test('optional or unshipped entry never blocks: unreachable / 404 / stub all skip', () => {
    for (const flags of [{ optional: true }, { shipped: false }, { optional: true, shipped: false }]) {
      expect(classifyResult({ ...base, ...flags, status: 0, contentLength: 0, error: 'ECONN' })).toBe('skipped-optional');
      expect(classifyResult({ ...base, ...flags, status: 404, contentLength: 0 })).toBe('skipped-optional');
      expect(classifyResult({ ...base, ...flags, status: 200, contentLength: 10 })).toBe('skipped-optional');
    }
  });

  test('optional entry still reports success and unverified states', () => {
    expect(classifyResult({ ...base, optional: true, status: 200, contentLength: 5000 })).toBe('ok');
    expect(classifyResult({ ...base, optional: true, status: 200, contentLength: 0 })).toBe('unverified');
    expect(classifyResult({ ...base, status: 200, contentLength: 0 })).toBe('unverified');
  });

  test('requiring the validator module does not execute its CLI main', () => {
    // If main() ran on require, this suite would already have exited non-zero
    // (or printed the banner). The export existing is the guard.
    expect(typeof classifyResult).toBe('function');
  });
});

describe('production gate tiering (VIP-003)', () => {
  const prodVerifySrc = fs.readFileSync(path.join(ROOT, 'scripts', 'prod-verify.mjs'), 'utf8');

  test('byte-integrity check stays in the hermetic static tier', () => {
    expect(prodVerifySrc).toMatch(/\['models',\s*'static',\s*'model integrity',\s*node\('scripts\/validate-model-integrity\.mjs'\)\]/);
  });

  test('remote delivery liveness runs only in the opt-in network tier', () => {
    expect(prodVerifySrc).toMatch(/\['model-delivery',\s*'network',/);
    expect(prodVerifySrc).not.toMatch(/\['model-delivery',\s*'static',/);
  });

  test('shipped-bytes verifier is unaffected (still hash-pins shipped models)', () => {
    const integrity = fs.readFileSync(path.join(ROOT, 'scripts', 'validate-model-integrity.mjs'), 'utf8');
    expect(integrity).toMatch(/sha256/i);
  });
});

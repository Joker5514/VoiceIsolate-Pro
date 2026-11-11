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

let generator;
let MODEL_MANIFEST;
let integrity; // scripts/validate-model-integrity.mjs (ESM) — canonical "shipped" predicates

beforeAll(async () => {
  generator = await import('../scripts/generate-model-manifests.mjs');
  ({ MODEL_MANIFEST } = await import('../src/core/ModelManifest.js'));
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

  test('generated models section is every pinned file plus the legacy alias keys', () => {
    const file = JSON.parse(fs.readFileSync(PKG_MANIFEST, 'utf8'));
    const rebuilt = generator.packagingModels(MODEL_MANIFEST);
    expect(file.models).toEqual(rebuilt);
    for (const id of ['vad', 'bsrnn_vocals', 'rnnoise', 'dfn3_enc', 'dfn3_erb_dec', 'dfn3_df_dec']) {
      expect(file.models[id]).toMatchObject({ shipped: true, modelId: id });
    }
    // Alias copies keep the canonical modelId. silero_vad stays the eager boot key.
    expect(file.models.silero_vad).toEqual(rebuilt.silero_vad);
    expect(file.models.silero_vad.modelId).toBe('vad');
    expect(file.models.silero_vad.eager).toBe(true);
    expect(file.models.bsrnn.modelId).toBe('bsrnn_vocals');
    expect(file.models.vad.eager).toBe(false);
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

describe('delivery validation uses the integrity helper (VIP-003)', () => {
  test('shipped DeepFilterNet3 parts are required and unshipped weights are not', () => {
    expect(integrity.isRequiredShippedModel(MODEL_MANIFEST.dfn3_enc)).toBe(true);
    expect(integrity.isRequiredShippedModel(MODEL_MANIFEST.dfn3_erb_dec)).toBe(true);
    expect(integrity.isRequiredShippedModel(MODEL_MANIFEST.dfn3_df_dec)).toBe(true);
    expect(integrity.isRequiredShippedModel(MODEL_MANIFEST.bsrnn_vocals)).toBe(true);
    expect(integrity.isExplicitlyOptional(MODEL_MANIFEST.ecapa_tdnn)).toBe(true);
    expect(integrity.isExplicitlyOptional(MODEL_MANIFEST.demucs)).toBe(true);
    expect(integrity.isExplicitlyOptional(MODEL_MANIFEST.bsrnn_complex)).toBe(true);
    expect(integrity.isRequiredShippedModel(MODEL_MANIFEST.bsrnn_complex)).toBe(false);
    expect(integrity.isCompositeModel(MODEL_MANIFEST.deepfilternet3)).toBe(true);
  });

  test('local integrity accepts the shipped files, including the three DeepFilterNet3 parts', () => {
    const local = integrity.validateModelIntegrity({ root: ROOT });
    expect(local.errors || []).toEqual([]);
    expect(local.ok).toBe(true);
  });

  test('requiring the validator module does not execute its CLI main', () => {
    const { execFileSync: exec } = require('child_process');
    const out = exec(process.execPath, ['-e', "require('./scripts/validate-onnx-models.js')"], {
      cwd: ROOT, encoding: 'utf8',
    });
    expect(out).not.toMatch(/model-delivery/);
    const cli = require('../scripts/validate-onnx-models.js');
    expect(typeof cli.main).toBe('function');
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

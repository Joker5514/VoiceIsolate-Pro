'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let generator, canonical;
beforeAll(async () => {
  generator = await import('../scripts/generate-model-manifests.mjs');
  canonical = await import('../src/core/ModelManifest.js');
});

test('packaging projections are deterministic, complete and strict (no warning-only drift mode)', () => {
  expect(generator.checkModelManifests(ROOT)).toEqual([]);
  const first = generator.generateModelManifests(ROOT);
  expect(generator.generateModelManifests(ROOT)).toEqual(first);
  const delivery = JSON.parse(first.find(([p]) => p === generator.MODEL_MANIFEST_PATH)[1]);
  const inventory = JSON.parse(first.find(([p]) => p === generator.MODEL_INVENTORY_PATH)[1]);
  const files = Object.values(canonical.MODEL_MANIFEST).filter((m) => !m.composite);
  expect(inventory.models).toHaveLength(files.length);
  for (const m of files) {
    const row = inventory.models.find((x) => x.modelId === m.id);
    expect(row).toMatchObject({ filename: path.basename(m.url), sizeBytes: m.sizeBytes, sha256: m.sha256, shipped: m.shipped !== false, optional: m.optional === true });
  }
  for (const m of Object.values(delivery.models)) {
    expect(canonical.MODEL_MANIFEST[m.modelId]).toMatchObject({ sizeBytes: m.sizeBytes, sha256: m.sha256 });
  }
  expect(delivery.models.demucs).toMatchObject({ shipped: false, optional: true });
  expect(delivery.models.bsrnn_vocals_complex).toMatchObject({ shipped: false, optional: true, sha256: null });
  expect(delivery.models.dfn3_enc).toMatchObject({ shipped: true, optional: false, filename: 'dfn3_enc.onnx' });
  expect(delivery.models.dfn3_erb_dec).toMatchObject({ shipped: true, filename: 'dfn3_erb_dec.onnx' });
  expect(delivery.models.dfn3_df_dec).toMatchObject({ shipped: true, filename: 'dfn3_df_dec.onnx' });
  expect(delivery.models.ecapa_tdnn).toMatchObject({ shipped: false, optional: true });
  expect(delivery.models.bsrnn.modelId).toBe('bsrnn_vocals');
  expect(delivery.models.silero_vad).toMatchObject({ modelId: 'vad', eager: true });
});

test('legacy aliases resolve to generated entries, never to a second pin table', () => {
  const text = fs.readFileSync(path.join(ROOT, generator.MODEL_COMPAT_PATH), 'utf8');
  const registry = JSON.parse(text.match(/root\.VIPModelRegistry=(.*);}\)/)[1]);
  for (const [alias, key] of Object.entries(registry.aliases)) {
    expect(registry.models[key]).toBeDefined();
    if (registry.models[key].shipped) expect(registry.models[key].sha256).toMatch(/^[a-f0-9]{64}$/);
    else expect(registry.models[key].optional).toBe(true);
    expect(alias).toBeTruthy();
  }
  const worker = fs.readFileSync(path.join(ROOT, 'public/app/ml-worker.js'), 'utf8');
  const cache = fs.readFileSync(path.join(ROOT, 'public/app/ml-worker-fetch-cache.js'), 'utf8');
  expect(worker).toContain('self.VIPModelRegistry');
  expect(cache).toContain('globalThis.VIPModelRegistry');
  expect(worker).not.toMatch(/const MODEL_SHA256\s*=/);
  expect(cache).not.toMatch(/sizeBytes:\s*\d/);
});

test('Android and desktop required lists come from canonical shipped files', () => {
  const required = generator.requiredModelFiles().map((m) => path.basename(m.url));
  expect(required).toEqual(expect.arrayContaining(['bsrnn_vocals.onnx', 'rnnoise_suppressor.onnx', 'silero_vad.onnx', 'dfn3_enc.onnx', 'dfn3_erb_dec.onnx', 'dfn3_df_dec.onnx']));
  expect(required).not.toContain('demucs_v4_quantized.onnx');
  expect(generator.androidModelFiles().map((m) => m.id)).not.toContain('vad_int8');
  const android = fs.readFileSync(path.join(ROOT, 'scripts/prepare-android-complete.mjs'), 'utf8');
  const desktop = fs.readFileSync(path.join(ROOT, 'scripts/electron-build-win.mjs'), 'utf8');
  expect(android).toContain('androidModelFiles()');
  expect(desktop).toContain('requiredModelFiles()');
});

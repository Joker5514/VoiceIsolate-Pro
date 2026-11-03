#!/usr/bin/env node
/** Deterministic packaging projections of the canonical core registry.
 * Compatibility keys/eagerness are packaging policy, not model definitions.
 * Worklets have their own canonical registry (scripts/worklet-manifest.json).
 * Usage: node scripts/generate-model-manifests.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MODEL_MANIFEST } from '../src/core/ModelManifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MODEL_MANIFEST_PATH = 'public/app/models-manifest.json';
export const MODEL_INVENTORY_PATH = 'public/app/models/models-manifest.json';
export const MODEL_COMPAT_PATH = 'public/app/model-registry.generated.js';
const LEGACY_KEYS = Object.freeze({ bsrnn_vocals: 'bsrnn', vad: 'silero_vad', demucs: 'demucs', bsrnn_complex: 'bsrnn_vocals_complex' });
const EAGER = new Set(['rnnoise', 'vad']);
// Compatibility keys are projections, not a second registry. Legacy consumers
// filter shipped/optional and never infer that a canonical strategy is supported.
const LEGACY_PACKAGING = new Set(['bsrnn_vocals', 'rnnoise', 'vad', 'vad_int8', 'demucs', 'bsrnn_complex']);
const INVENTORY_KEYS = Object.freeze({ vad: 'silero_vad', demucs: 'demucs_v4', bsrnn_complex: 'bsrnn_vocals_complex' });

export function modelFiles(manifest = MODEL_MANIFEST) {
  return Object.values(manifest).filter((entry) => !entry.composite);
}
export function requiredModelFiles(manifest = MODEL_MANIFEST) {
  return modelFiles(manifest).filter((entry) => entry.shipped !== false && !entry.optional && entry.delivery !== 'optional');
}
export function androidModelFiles(manifest = MODEL_MANIFEST) {
  // vad_int8 remains an optional size/speed alternative, as in the existing APK.
  return requiredModelFiles(manifest).filter((entry) => entry.id !== 'vad_int8');
}
export function workletPackaging(root = ROOT) {
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'scripts/worklet-manifest.json'), 'utf8'));
  const keys = { 'vip-gate': 'gate_processor', 'vip-deesser': 'deesser_processor', 'dsp-processor': 'dsp_processor' };
  return Object.fromEntries(registry.worklets.map((entry) => {
    const bytes = fs.readFileSync(path.join(root, entry.source));
    const sha256 = crypto.createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
    return [keys[entry.id] || entry.id, {
      filename: path.basename(entry.source), processorName: entry.processorName,
      role: entry.role, contentType: 'application/javascript',
      sources: [{ provider: 'same-origin', url: entry.url, sha256 }],
    }];
  }));
}

export function generateModelManifests(root = ROOT) {
  const models = {};
  for (const entry of modelFiles().filter((item) => LEGACY_PACKAGING.has(item.id))) {
    models[LEGACY_KEYS[entry.id] || entry.id] = {
      modelId: entry.id, filename: path.basename(entry.url), sizeBytes: entry.sizeBytes,
      sha256: entry.sha256, eager: EAGER.has(entry.id), optional: entry.optional === true,
      shipped: entry.shipped !== false,
      sources: [{ provider: 'same-origin', url: entry.url }],
    };
  }
  const delivery = {
    _note: 'Generated from src/core/ModelManifest.js by pnpm models:manifests. Do not edit model definitions here. All runtime URLs are same-origin; audio never leaves the device.',
    schemaVersion: 2, models,
    _sha256_note: 'Model hashes: pnpm models:manifests. Worklet hashes: pnpm worklets:hash (also regenerates this projection).',
    worklets: workletPackaging(root),
  };
  const inventory = {
    version: '2.2.0',
    description: 'Generated packaging inventory. src/core/ModelManifest.js owns model IDs, URLs, sizes, hashes and inference contracts. Training and license notes: public/app/models/README.md and docs/guides/MODEL_DELIVERY.md.',
    models: modelFiles().map((entry) => ({
      id: INVENTORY_KEYS[entry.id] || entry.id, modelId: entry.id,
      filename: path.basename(entry.url), path: entry.url, purpose: entry.name,
      sizeBytes: entry.sizeBytes, sha256: entry.sha256,
      sample_rate: entry.sampleRate, strategy: entry.strategy,
      load_priority: EAGER.has(entry.id) ? 'eager' : 'lazy',
      delivery: entry.shipped === false ? 'optional' : 'repo_committed',
      status: entry.shipped === false ? 'not-shipped' : 'committed',
      optional: entry.optional === true, shipped: entry.shipped !== false,
      license: entry.license || null,
    })),
    delivery_notes: [
      'Only entries with shipped:true are required by the static gate. Optional weights are never downloaded or redistributed by this generator.',
      'Model ONNX/WASM bytes are runtime-cached after SHA-256 verification, not service-worker precached. The JSON projections are precached.',
      'Android excludes optional Demucs and SAM weights; its required files come from the same canonical registry.',
    ],
  };
  const compat = { models, aliases: { vad: 'silero_vad', silero: 'silero_vad', 'silero-vad': 'silero_vad', demucs: 'demucs', 'demucs-v4': 'demucs', demucs_v4: 'demucs', bsrnn: 'bsrnn', bsrnn_vocals: 'bsrnn', bsrnn_complex: 'bsrnn_vocals_complex' } };
  return [
    [MODEL_MANIFEST_PATH, `${JSON.stringify(delivery, null, 2)}\n`],
    [MODEL_INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`],
    [MODEL_COMPAT_PATH, `// Generated by pnpm models:manifests from src/core/ModelManifest.js. Do not edit.\n(function(root){root.VIPModelRegistry=${JSON.stringify(compat)};})(typeof globalThis!=='undefined'?globalThis:this);\n`],
  ];
}

export function checkModelManifests(root = ROOT) {
  return generateModelManifests(root).flatMap(([rel, text]) => {
    const abs = path.join(root, rel);
    const actual = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    return actual === text ? [] : [`${rel} is ${actual === null ? 'missing' : 'stale'}; run pnpm models:manifests`];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  if (check) {
    const errors = checkModelManifests();
    errors.forEach((error) => console.error(`[model-manifests] ${error}`));
    if (errors.length) process.exit(1);
    console.log('[model-manifests] deterministic packaging projections match ModelManifest.js');
  } else {
    for (const [rel, text] of generateModelManifests()) {
      fs.writeFileSync(path.join(ROOT, rel), text);
      console.log(`[model-manifests] wrote ${rel}`);
    }
  }
}

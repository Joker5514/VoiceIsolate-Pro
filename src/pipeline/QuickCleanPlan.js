/** Outcome translation and device preflight. No audio or inference during preflight. */
import { MODEL_MANIFEST } from '../core/ModelManifest.js';
import { SAMPLE_RATE } from '../core/audio-config.js';

export const QUICK_CLEAN_OUTCOMES = Object.freeze([
  Object.freeze({ id: 'bsrnn_vocals', label: 'Clean Speech',
    description: 'Extract speech with the standard local model.', modelIds: Object.freeze(['bsrnn_vocals']), background: 0 }),
  Object.freeze({ id: 'max_isolation', label: 'Maximum Isolation',
    description: 'Add noise suppression. Slower; listen for lost detail or artifacts.', modelIds: Object.freeze(['bsrnn_vocals', 'rnnoise']), background: 0 }),
  Object.freeze({ id: 'rnnoise', label: 'Preserve Ambience',
    description: 'Suppress noise gently, then blend background back in. Some room sound remains.', modelIds: Object.freeze(['rnnoise']), background: 30 }),
]);

export function resolveQuickCleanPlan(id, { manifest = MODEL_MANIFEST, backend = 'wasm' } = {}) {
  const outcome = QUICK_CLEAN_OUTCOMES.find((item) => item.id === id);
  if (!outcome) throw new Error('Choose an available outcome.');
  if (!['wasm', 'webgpu'].includes(backend)) throw new Error('Local processing is not ready. Retry, or use a supported browser.');
  const models = outcome.modelIds.map((modelId) => manifest[modelId]);
  if (models.some((model) => !model || model.shipped === false || model.optional
    || model.delivery === 'optional' || !/^[a-f0-9]{64}$/.test(model.sha256 || '')
    || model.strategy !== 'spectral-mask' || model.sampleRate !== SAMPLE_RATE
    || !Number.isFinite(model.sizeBytes) || model.sizeBytes <= 0)) {
    throw new Error('This outcome has no shipped, integrity-pinned model chain. Choose another outcome.');
  }
  return Object.freeze({ outcome: outcome.id, label: outcome.label,
    modelIds: Object.freeze([...outcome.modelIds]), sampleRate: SAMPLE_RATE,
    background: outcome.background, downloadBytes: models.reduce((sum, model) => sum + model.sizeBytes, 0) });
}

export async function inspectQuickCleanDevice({ navigator: nav = globalThis.navigator } = {}) {
  let storage = null;
  let timer;
  try {
    storage = await Promise.race([
      nav?.storage?.estimate?.() ?? null,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3000); }),
    ]);
  } catch { /* Quota reporting is optional; never describe an unknown quota as sufficient. */ }
  finally { clearTimeout(timer); }
  return { online: nav?.onLine !== false,
    freeBytes: Number.isFinite(storage?.quota) && Number.isFinite(storage?.usage)
      ? Math.max(0, storage.quota - storage.usage) : null };
}

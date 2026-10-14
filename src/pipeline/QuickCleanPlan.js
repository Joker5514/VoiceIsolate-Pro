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
  Object.freeze({ id: 'enhance_speech', label: 'Enhance Speech',
    description: 'DeepFilterNet3 speech enhancement. Strongest on recorded speech in noise; it removes music beds and can suppress whispers.', modelIds: Object.freeze(['deepfilternet3']), background: 0 }),
]);

/** Strategies whose fixed 48 kHz chain a Quick Clean outcome may use. */
const QUICK_CLEAN_STRATEGIES = new Set(['spectral-mask', 'deepfilternet']);

export function resolveQuickCleanPlan(id, { manifest = MODEL_MANIFEST, backend = 'wasm' } = {}) {
  const outcome = QUICK_CLEAN_OUTCOMES.find((item) => item.id === id);
  if (!outcome) throw new Error('Choose an available outcome.');
  if (!['wasm', 'webgpu'].includes(backend)) throw new Error('Local processing is not ready. Retry, or use a supported browser.');
  const models = outcome.modelIds.map((modelId) => manifest[modelId]);
  const unshipped = (model) => !model || model.shipped === false || model.optional || model.delivery === 'optional';
  // A composite entry (DeepFilterNet3) owns no file: its parts are the downloads.
  const files = models.flatMap((model) => (model?.parts
    ? Object.values(model.parts).map((partId) => manifest[partId])
    : [model]));
  if (models.some((model) => unshipped(model)
    || !QUICK_CLEAN_STRATEGIES.has(model.strategy) || model.sampleRate !== SAMPLE_RATE)
    || files.some((file) => unshipped(file) || !/^[a-f0-9]{64}$/.test(file.sha256 || '')
      || !Number.isFinite(file.sizeBytes) || file.sizeBytes <= 0)) {
    throw new Error('This outcome has no shipped, integrity-pinned model chain. Choose another outcome.');
  }
  return Object.freeze({ outcome: outcome.id, label: outcome.label,
    modelIds: Object.freeze([...outcome.modelIds]), sampleRate: SAMPLE_RATE,
    background: outcome.background, downloadBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0) });
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

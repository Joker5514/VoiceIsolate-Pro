/**
 * VoiceIsolate Pro — Models Loader
 * Reads models-manifest.json and orchestrates eager/lazy ONNX model loading
 * via onnxruntime-web. Respects the single-pass spectral architecture constraint:
 * all ML inference runs in ml-worker.js off the audio thread.
 *
 * Usage (from ml-worker.js):
 *   import { ModelsLoader } from './models-loader.js';
 *   const loader = new ModelsLoader('./models/models-manifest.json');
 *   await loader.initEager(ortEnv);   // loads VAD + RNNoise on startup
 *   const demucs = await loader.getModel('demucs_v4', ortEnv); // lazy load
 */

'use strict';

export class ModelsLoader {
  /**
   * @param {string} manifestPath - Relative URL to models-manifest.json
   */
  constructor(manifestPath = './models/models-manifest.json') {
    this.manifestPath = manifestPath;
    this.manifest = null;
    /** @type {Map<string, ort.InferenceSession>} */
    this._sessions = new Map();
    /** @type {Map<string, Promise<ort.InferenceSession>>} */
    this._pending = new Map();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch and parse the manifest JSON.
   * Must be called once before any load operations.
   */
  async loadManifest() {
    if (this.manifest) return this.manifest;
    const res = await fetch(this.manifestPath);
    if (!res.ok) throw new Error(`[ModelsLoader] Cannot fetch manifest: ${res.status} ${this.manifestPath}`);
    this.manifest = await res.json();
    console.info(`[ModelsLoader] Manifest v${this.manifest.version} loaded — ${this.manifest.models.length} models registered`);
    return this.manifest;
  }

  /**
   * Load all eager-priority models. Call this once during ml-worker init.
   * @param {object} ort - The onnxruntime-web namespace (passed in from worker)
   * @param {string[]} [preferredEPs=['webgpu','wasm']] - Execution provider preference order
   */
  async initEager(ort, preferredEPs = ['webgpu', 'wasm']) {
    await this.loadManifest();
    const eagerModels = this.manifest.models.filter(m => m.load_priority === 'eager');
    console.info(`[ModelsLoader] Loading ${eagerModels.length} eager models...`);
    await Promise.all(eagerModels.map(m => this._load(m, ort, preferredEPs)));
    console.info('[ModelsLoader] Eager model init complete.');
  }

  /**
   * Get a model session by ID. Lazy-loads if not yet in memory.
   * @param {string} modelId - e.g. 'demucs_v4', 'silero_vad'
   * @param {object} ort - onnxruntime-web namespace
   * @param {string[]} [preferredEPs]
   * @returns {Promise<ort.InferenceSession>}
   */
  async getModel(modelId, ort, preferredEPs = ['webgpu', 'wasm']) {
    if (this._sessions.has(modelId)) return this._sessions.get(modelId);
    await this.loadManifest();
    const meta = this.manifest.models.find(m => m.id === modelId);
    if (!meta) throw new Error(`[ModelsLoader] Unknown model id: ${modelId}`);
    return this._load(meta, ort, preferredEPs);
  }

  /**
   * Release a model session to free GPU/WASM memory.
   * @param {string} modelId
   */
  async releaseModel(modelId) {
    const session = this._sessions.get(modelId);
    if (session) {
      await session.release?.();
      this._sessions.delete(modelId);
      console.info(`[ModelsLoader] Released model: ${modelId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Core load logic — deduplicates concurrent requests via pending map.
   * @param {object} meta - Model entry from manifest
   * @param {object} ort
   * @param {string[]} preferredEPs
   * @returns {Promise<ort.InferenceSession>}
   */
  _load(meta, ort, preferredEPs) {
    if (this._sessions.has(meta.id)) {
      return Promise.resolve(this._sessions.get(meta.id));
    }
    if (this._pending.has(meta.id)) {
      return this._pending.get(meta.id);
    }

    const promise = this._doLoad(meta, ort, preferredEPs);
    this._pending.set(meta.id, promise);
    return promise;
  }

  async _doLoad(meta, ort, preferredEPs) {
    // Intersect preferred EPs with what this model supports
    const eps = preferredEPs
      .filter(ep => meta.execution_provider_preference.includes(ep) || meta.execution_provider_preference.length === 0);

    const modelUrl = new URL(meta.path, self.location.href).href;
    console.info(`[ModelsLoader] Loading ${meta.id} (${meta.size_mb} MB) from ${modelUrl} via EP: ${eps}`);

    let session = null;
    let lastError = null;

    for (const ep of eps) {
      try {
        session = await ort.InferenceSession.create(modelUrl, {
          executionProviders: [ep],
          graphOptimizationLevel: 'all',
          enableCpuMemArena: true,
          enableMemPattern: true,
          executionMode: 'sequential',
        });
        console.info(`[ModelsLoader] ✅ ${meta.id} loaded via ${ep}`);
        break;
      } catch (err) {
        console.warn(`[ModelsLoader] EP '${ep}' failed for ${meta.id}: ${err.message}`);
        lastError = err;
      }
    }

    if (!session) {
      // Final fallback — attempt raw WASM with no EP hint
      try {
        session = await ort.InferenceSession.create(modelUrl, {
          executionProviders: ['wasm'],
        });
        console.warn(`[ModelsLoader] ⚠️ ${meta.id} loaded via wasm fallback`);
      } catch (err) {
        this._pending.delete(meta.id);
        throw new Error(`[ModelsLoader] ❌ Failed to load ${meta.id}: ${err.message}`);
      }
    }

    this._sessions.set(meta.id, session);
    this._pending.delete(meta.id);
    return session;
  }
}

/**
 * Singleton factory — returns the same loader instance across imports
 * within a single worker context.
 */
let _instance = null;
export function getModelsLoader(manifestPath) {
  if (!_instance) _instance = new ModelsLoader(manifestPath);
  return _instance;
}

/**
 * VoiceIsolate Pro v9.0 - ML Model Manager
 *
 * Handles ONNX Runtime Web model loading, caching via IndexedDB,
 * and lifecycle management for all ML models used by the application.
 *
 * Supported models:
 *   - Demucs v4 INT8   : source separation
 *   - ECAPA-TDNN        : speaker embedding extraction
 *   - Silero VAD        : voice activity detection
 */

const DB_NAME = 'voiceisolate-models';
const DB_VERSION = 1;
const STORE_NAME = 'models';

/**
 * Registry of all available models.
 * URLs are placeholders -- replace with actual CDN endpoints before deployment.
 */
const MODEL_REGISTRY = Object.freeze({
  'demucs-v4': {
    name: 'Demucs v4 INT8',
    size: '~100MB',
    url: 'https://cdn.voiceisolate.pro/models/demucs-v4-int8.onnx',
    description: 'Source separation - isolates vocals from instrumental tracks',
  },
  'ecapa-tdnn': {
    name: 'ECAPA-TDNN',
    size: '~2.5MB',
    url: 'https://cdn.voiceisolate.pro/models/ecapa-tdnn.onnx',
    description: 'Speaker embeddings - generates voiceprint vectors for speaker identification',
  },
  'silero-vad': {
    name: 'Silero VAD',
    size: '~350KB',
    url: 'https://cdn.voiceisolate.pro/models/silero-vad.onnx',
    description: 'Voice activity detection - determines speech vs silence segments',
  },
});

class ModelManager {
  /** @type {IDBDatabase | null} */
  #db = null;

  /** @type {Map<string, any>} loaded InferenceSessions keyed by modelId */
  #sessions = new Map();

  /** @type {boolean} */
  #onnxAvailable = false;

  /** @type {Promise<void> | null} */
  #dbReady = null;

  constructor() {
    this.#dbReady = this.#initDB();
    this.#onnxAvailable = typeof globalThis.ort !== 'undefined';
  }

  // ---------------------------------------------------------------------------
  // IndexedDB initialisation
  // ---------------------------------------------------------------------------

  /**
   * Open (or create) the IndexedDB database used for model caching.
   * @returns {Promise<void>}
   */
  async #initDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        console.warn('[ModelManager] IndexedDB not available -- model caching disabled');
        resolve();
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = /** @type {IDBOpenDBRequest} */ (event.target).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = (event) => {
        this.#db = /** @type {IDBOpenDBRequest} */ (event.target).result;

        // Handle unexpected close (e.g. browser clearing storage).
        this.#db.onclose = () => {
          this.#db = null;
        };

        resolve();
      };

      request.onerror = (event) => {
        console.error('[ModelManager] Failed to open IndexedDB:', event);
        // Non-fatal -- we can still fetch models from the network.
        resolve();
      };
    });
  }

  /**
   * Ensure the database is ready before any cache operation.
   */
  async #ensureDB() {
    if (this.#dbReady) {
      await this.#dbReady;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API -- model loading
  // ---------------------------------------------------------------------------

  /**
   * Load a model on demand.  Checks IndexedDB cache first, then fetches
   * from the CDN.  Returns an ONNX InferenceSession (or throws).
   *
   * @param {string} modelId   One of the keys in MODEL_REGISTRY.
   * @param {object} [options]
   * @param {function(number):void} [options.onProgress] Download progress callback (0-1).
   * @param {object} [options.sessionOptions]  Extra options forwarded to InferenceSession.create().
   * @returns {Promise<any>} ONNX InferenceSession
   */
  async loadModel(modelId, options = {}) {
    const { onProgress, sessionOptions = {} } = options;

    // Already loaded -- return the cached session.
    if (this.#sessions.has(modelId)) {
      return this.#sessions.get(modelId);
    }

    const info = MODEL_REGISTRY[modelId];
    if (!info) {
      throw new Error(`[ModelManager] Unknown model id: "${modelId}"`);
    }

    // Check ONNX Runtime availability.
    if (!this.#onnxAvailable) {
      // Re-check in case it was loaded lazily.
      this.#onnxAvailable = typeof globalThis.ort !== 'undefined';
    }
    if (!this.#onnxAvailable) {
      throw new Error(
        '[ModelManager] ONNX Runtime Web (ort) is not available. ' +
          'Include ort.min.js before loading models.',
      );
    }

    // Attempt to load from cache.
    let modelBuffer = await this.getCachedModel(modelId);

    if (!modelBuffer) {
      // Fetch from CDN.
      modelBuffer = await this.#fetchModel(info.url, onProgress);
      // Store in cache for future use (fire-and-forget).
      this.cacheModel(modelId, modelBuffer).catch((err) => {
        console.warn(`[ModelManager] Failed to cache model "${modelId}":`, err);
      });
    } else if (onProgress) {
      // Model was cached -- immediately report 100 %.
      onProgress(1);
    }

    // Create ONNX session.
    const session = await globalThis.ort.InferenceSession.create(modelBuffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      ...sessionOptions,
    });

    this.#sessions.set(modelId, session);
    return session;
  }

  // ---------------------------------------------------------------------------
  // Public API -- cache management
  // ---------------------------------------------------------------------------

  /**
   * Store a model binary in IndexedDB.
   *
   * @param {string} modelId
   * @param {ArrayBuffer} buffer
   * @returns {Promise<void>}
   */
  async cacheModel(modelId, buffer) {
    await this.#ensureDB();
    if (!this.#db) return;

    return new Promise((resolve, reject) => {
      try {
        const tx = this.#db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        const entry = {
          modelId,
          buffer,
          cachedAt: Date.now(),
          size: buffer.byteLength,
        };

        const request = store.put(entry, modelId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Retrieve a cached model binary from IndexedDB.
   *
   * @param {string} modelId
   * @returns {Promise<ArrayBuffer|null>}
   */
  async getCachedModel(modelId) {
    await this.#ensureDB();
    if (!this.#db) return null;

    return new Promise((resolve, reject) => {
      try {
        const tx = this.#db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(modelId);

        request.onsuccess = () => {
          const entry = request.result;
          if (entry && entry.buffer) {
            resolve(entry.buffer);
          } else {
            resolve(null);
          }
        };

        request.onerror = () => {
          console.warn(`[ModelManager] Cache read error for "${modelId}":`, request.error);
          resolve(null);
        };
      } catch (err) {
        console.warn(`[ModelManager] Cache access error:`, err);
        resolve(null);
      }
    });
  }

  /**
   * Delete a model from cache and release its InferenceSession.
   *
   * @param {string} modelId
   * @returns {Promise<void>}
   */
  async deleteModel(modelId) {
    // Release the session if loaded.
    if (this.#sessions.has(modelId)) {
      const session = this.#sessions.get(modelId);
      try {
        await session.release();
      } catch {
        // Some ONNX builds don't expose release().
      }
      this.#sessions.delete(modelId);
    }

    await this.#ensureDB();
    if (!this.#db) return;

    return new Promise((resolve, reject) => {
      try {
        const tx = this.#db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.delete(modelId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Public API -- model info
  // ---------------------------------------------------------------------------

  /**
   * Return metadata for a model.
   *
   * @param {string} modelId
   * @returns {{ name: string, size: string, description: string, loaded: boolean } | null}
   */
  getModelInfo(modelId) {
    const info = MODEL_REGISTRY[modelId];
    if (!info) return null;

    return {
      name: info.name,
      size: info.size,
      description: info.description,
      loaded: this.#sessions.has(modelId),
    };
  }

  /**
   * Check whether a model's InferenceSession is currently loaded.
   *
   * @param {string} modelId
   * @returns {boolean}
   */
  isModelLoaded(modelId) {
    return this.#sessions.has(modelId);
  }

  /**
   * Return a list of all registered model ids.
   *
   * @returns {string[]}
   */
  get availableModels() {
    return Object.keys(MODEL_REGISTRY);
  }

  /**
   * Return the full registry (read-only snapshot).
   *
   * @returns {Record<string, { name: string, size: string, url: string, description: string }>}
   */
  get registry() {
    return { ...MODEL_REGISTRY };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch a model from its URL with progress reporting.
   *
   * @param {string} url
   * @param {function(number):void} [onProgress]
   * @returns {Promise<ArrayBuffer>}
   */
  async #fetchModel(url, onProgress) {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`[ModelManager] Failed to fetch model: ${response.status} ${response.statusText}`);
    }

    const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);

    // If we cannot determine length or no progress callback, use simple arrayBuffer().
    if (!onProgress || !contentLength || !response.body) {
      if (onProgress) onProgress(1);
      return response.arrayBuffer();
    }

    // Stream with progress.
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      received += value.length;

      const progress = Math.min(received / contentLength, 1);
      try {
        onProgress(progress);
      } catch {
        // Progress callback errors are non-fatal.
      }
    }

    // Combine chunks into a single ArrayBuffer.
    const combined = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    return combined.buffer;
  }
}

export default ModelManager;

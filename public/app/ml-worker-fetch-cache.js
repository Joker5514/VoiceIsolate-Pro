/* =============================================================================
   VoiceIsolate Pro — ML Worker: Model Fetch + IndexedDB Cache
   File: public/app/ml-worker-fetch-cache.js
   Threads from Space v11 | Cache v1.0
   ─────────────────────────────────────────────────────────────────────────────
   PURPOSE
   -------
   Adds persistent model caching + chunked download with progress UI.

   Flow:
     1. On first run: fetch model from local path, stream to IndexedDB.
     2. On subsequent runs: serve model directly from IDB as an ArrayBuffer.
     3. Convert ArrayBuffer → Object URL → pass to ort.InferenceSession.create()
        so the ml-worker loads from memory without re-fetching.
     4. Emit download progress events consumed by the pipeline stage UI.

   CONSTRAINTS
   -----------
   ✅ Privacy-first — audio processing is 100% local, zero cloud inference
   ✅ CDN used only for one-time model download (models cached in IDB after first fetch)
   ✅ Non-destructive — does NOT modify ml-worker.js
   ✅ Works with existing Worker message protocol
   ✅ Single-Pass STFT architecture unchanged

   INTEGRATION
   -----------
   1. Add to index.html AFTER app.js, BEFORE pipeline-orchestrator.js:
        <script src="ml-worker-fetch-cache.js"></script>
   2. In vip-boot.js or app.js, after worker construction:
        await window._vipPreloadModels(['silero_vad', 'deepfilter', 'demucs']);
        // Then init worker — it will use Object URLs for already-cached models.
   ============================================================================= */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const VIP_IDB_NAME    = 'vip-model-cache';
const VIP_IDB_VERSION = 2;   // Bump to invalidate cache on model updates
const VIP_IDB_STORE   = 'models';

/**
 * Model file registry — single source of truth for paths + expected sizes.
 * Sizes used for progress calculation when Content-Length header is absent.
 * @type {Record<string, { path: string, sizeBytes: number, integrity?: string }>}
 */
const MODEL_REGISTRY = {
  silero_vad: {
    path: 'models/silero_vad.onnx',
    sizeBytes: 1_747_968
    // No cdnUrl needed — file is already committed
  },
  deepfilter: {
    path: 'models/deepfilter-int8.onnx',
    sizeBytes: 9_437_184,
    cdnUrl: 'https://huggingface.co/onnx-community/DeepFilterNet2_onnx/resolve/main/model_int8.onnx'
  },
  demucs: {
    path: 'models/demucs-v4-int8.onnx',
    sizeBytes: 85_983_232,
    cdnUrl: 'https://huggingface.co/onnx-community/demucs/resolve/main/htdemucs_ft_int8.onnx'
  },
  bsrnn: {
    path: 'models/bsrnn-int8.onnx',
    sizeBytes: 38_797_312,
    cdnUrl: 'https://huggingface.co/onnx-community/ConvTasNet_Libri2Mix_sepclean_16k/resolve/main/model_int8.onnx'
  },
  ecapa_tdnn: {
    path: 'models/ecapa-tdnn-int8.onnx',
    sizeBytes: 20_971_520,
    cdnUrl: 'https://huggingface.co/onnx-community/ecapa-tdnn/resolve/main/model_int8.onnx'
  },
  dns2_conformer_small: {
    path: 'models/dns2_conformer_small.onnx',
    sizeBytes: 14_680_064,
    cdnUrl: 'https://huggingface.co/onnx-community/dns2-conformer-small/resolve/main/model_int8.onnx'
  },
  noise_classifier: {
    path: 'models/noise_classifier.onnx',
    sizeBytes: 2_621_440,
    cdnUrl: 'https://huggingface.co/onnx-community/yamnet/resolve/main/model_int8.onnx'
  },
  convtasnet: {
    path: 'models/convtasnet-int8.onnx',
    sizeBytes: 18_874_368,
    cdnUrl: 'https://huggingface.co/onnx-community/ConvTasNet_Libri2Mix_sepclean_16k/resolve/main/model_int8.onnx'
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  INDEXEDDB HELPERS
// ─────────────────────────────────────────────────────────────────────────────

let _db = null;

/**
 * Open (or create) the IndexedDB model cache.
 * @returns {Promise<IDBDatabase>}
 */
async function openModelDB() {
  if (_db) return _db;

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VIP_IDB_NAME, VIP_IDB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(VIP_IDB_STORE)) {
        // keyPath = modelKey (e.g. 'demucs'), value = { buffer: ArrayBuffer, ts: number, size: number }
        db.createObjectStore(VIP_IDB_STORE, { keyPath: 'key' });
      }
    };

    req.onsuccess  = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror    = (e) => reject(new Error(`IDB open failed: ${e.target.error?.message}`));
    req.onblocked  = ()  => reject(new Error('IDB open blocked — close other tabs'));
  });
}

/**
 * Read a model ArrayBuffer from IDB cache.
 * @param {string} key
 * @returns {Promise<ArrayBuffer|null>}
 */
async function idbGet(key) {
  const db = await openModelDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(VIP_IDB_STORE, 'readonly');
    const req = tx.objectStore(VIP_IDB_STORE).get(key);
    req.onsuccess = (e) => resolve(e.target.result?.buffer ?? null);
    req.onerror   = (e) => reject(new Error(`IDB get failed: ${e.target.error?.message}`));
  });
}

/**
 * Write a model ArrayBuffer to IDB cache.
 * @param {string} key
 * @param {ArrayBuffer} buffer
 * @returns {Promise<void>}
 */
async function idbPut(key, buffer) {
  const db = await openModelDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(VIP_IDB_STORE, 'readwrite');
    const store = tx.objectStore(VIP_IDB_STORE);
    const req   = store.put({ key, buffer, ts: Date.now(), size: buffer.byteLength });
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(new Error(`IDB put failed: ${e.target.error?.message}`));
  });
}

/**
 * Delete a cached model from IDB (use when invalidating / re-downloading).
 * @param {string} key
 * @returns {Promise<void>}
 */
async function idbDelete(key) {
  const db = await openModelDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(VIP_IDB_STORE, 'readwrite');
    const req = tx.objectStore(VIP_IDB_STORE).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(new Error(`IDB delete failed: ${e.target.error?.message}`));
  });
}

/**
 * List all cached model keys.
 * @returns {Promise<string[]>}
 */
async function idbListKeys() {
  const db = await openModelDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(VIP_IDB_STORE, 'readonly');
    const req = tx.objectStore(VIP_IDB_STORE).getAllKeys();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(new Error(`IDB listKeys failed: ${e.target.error?.message}`));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  CHUNKED DOWNLOADER WITH PROGRESS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a model file with streaming progress.
 *
 * Emits CustomEvents on window:
 *   'vip:modelDownloadProgress' — { detail: { key, loaded, total, pct } }
 *   'vip:modelDownloadComplete' — { detail: { key, buffer, fromCache } }
 *   'vip:modelDownloadError'    — { detail: { key, error } }
 *
 * @param {string} key          - Model registry key (e.g. 'demucs')
 * @param {object} opts
 * @param {boolean} [opts.forceRefresh=false] - Skip IDB cache and re-download
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchModelWithProgress(key, opts = {}) {
  const { forceRefresh = false } = opts;
  const meta = MODEL_REGISTRY[key];
  if (!meta) throw new Error(`Unknown model key: "${key}"`);

  // ── 1. Try IDB cache first
  if (!forceRefresh) {
    try {
      const cached = await idbGet(key);
      if (cached && cached.byteLength > 0) {
        _emitProgress(key, cached.byteLength, cached.byteLength, 100);
        _emitComplete(key, cached, true);
        return cached;
      }
    } catch (e) {
      console.warn(`[VIP cache] IDB read failed for "${key}", re-fetching:`, e.message);
    }
  }

  // ── 2. Fetch — try local first, CDN fallback if placeholder/missing
  let response;
  let usedCDN = false;

  try {
    response = await fetch(meta.path);
  } catch (netErr) {
    response = null;
  }

  // Treat as placeholder if: fetch failed, non-ok, or file is suspiciously tiny (stub)
  const isPlaceholder = !response || !response.ok ||
    parseInt(response.headers.get('Content-Length') || '0', 10) < 1000;

  if (isPlaceholder) {
    if (!meta.cdnUrl) {
      const err = new Error(
        `Model file not found: "${meta.path}" and no CDN fallback configured. ` +
        `Place the .onnx file in public/app/models/ and reload.`
      );
      _emitError(key, err);
      throw err;
    }
    console.info(`[VIP fetch] "${key}" local file absent/stub — fetching from CDN: ${meta.cdnUrl}`);
    try {
      response = await fetch(meta.cdnUrl);
      usedCDN = true;
    } catch (cdnErr) {
      const err = new Error(`CDN fetch failed for "${key}": ${cdnErr.message}`);
      _emitError(key, err);
      throw err;
    }
    if (!response.ok) {
      const err = new Error(`CDN returned HTTP ${response.status} for "${key}": ${meta.cdnUrl}`);
      _emitError(key, err);
      throw err;
    }
  }

  // Emit a console note so devs know which path was used
  if (usedCDN) {
    console.info(`[VIP fetch] Downloading "${key}" from CDN (will cache in IDB for future loads)...`);
  }

  const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
  const total         = contentLength || meta.sizeBytes;   // fallback to manifest size
  let   loaded        = 0;
  const chunks        = [];

  const reader = response.body.getReader();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let done, value;
    try {
      ({ done, value } = await reader.read());
    } catch (readErr) {
      const err = new Error(`Stream read error for "${key}": ${readErr.message}`);
      _emitError(key, err);
      throw err;
    }

    if (done) break;

    chunks.push(value);
    loaded += value.byteLength;
    const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : -1;
    _emitProgress(key, loaded, total, pct);
  }

  // ── 3. Assemble ArrayBuffer
  const buffer = _concatBuffers(chunks, loaded);

  // ── 4. Persist to IDB (non-blocking — don't await to avoid blocking caller)
  idbPut(key, buffer).catch(e =>
    console.warn(`[VIP cache] IDB write failed for "${key}":`, e.message)
  );

  _emitComplete(key, buffer, false, usedCDN ? 'cdn' : 'local');
  return buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
//  OBJECT URL MANAGER
// ─────────────────────────────────────────────────────────────────────────────

/** Map of modelKey → active ObjectURL (so we can revoke them on cleanup) */
const _objectURLs = new Map();

/**
 * Get (or create) a blob Object URL for a model, loading from cache or fetching.
 *
 * Pass the returned URL to ort.InferenceSession.create() in the ml-worker:
 *   worker.postMessage({ type: 'init', modelPaths: { demucs: demucsObjURL } });
 *
 * @param {string} key
 * @param {object} [opts]
 * @returns {Promise<string>} Object URL
 */
async function getModelObjectURL(key, opts = {}) {
  if (_objectURLs.has(key)) return _objectURLs.get(key);

  const buffer = await fetchModelWithProgress(key, opts);
  const blob   = new Blob([buffer], { type: 'application/octet-stream' });
  const url    = URL.createObjectURL(blob);
  _objectURLs.set(key, url);
  return url;
}

/**
 * Revoke all active Object URLs (call on page unload or major state reset).
 */
function revokeAllModelURLs() {
  for (const [key, url] of _objectURLs.entries()) {
    URL.revokeObjectURL(url);
    _objectURLs.delete(key);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BATCH PRELOAD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Preload a prioritized list of models (or all if omitted), returning a map
 * of modelKey → ObjectURL ready to pass to the ml-worker init message.
 *
 * Loads models sequentially (not parallel) to avoid saturating memory on
 * low-RAM devices.
 *
 * @param {string[]|null} [keys=null] - Model keys to load. null = all.
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh=false]
 * @param {function} [opts.onProgress] - (key, pct, loaded, total) => void
 * @returns {Promise<Record<string, string>>}  modelKey → ObjectURL
 */
window._vipPreloadModels = async function preloadModels(keys = null, opts = {}) {
  const { forceRefresh = false, onProgress } = opts;
  const targets = keys ?? Object.keys(MODEL_REGISTRY);
  const modelPaths = {};
  const results    = { ok: [], failed: [] };

  // Show download progress panel
  _ensureProgressPanel(targets);

  for (const key of targets) {
    _updateProgressRow(key, 0, 'Downloading...');
    try {
      const url = await getModelObjectURL(key, { forceRefresh });
      modelPaths[key] = url;
      results.ok.push(key);
      _updateProgressRow(key, 100, 'Ready ✓');
      if (typeof onProgress === 'function') onProgress(key, 100, 1, 1);
    } catch (err) {
      results.failed.push({ key, error: err.message });
      _updateProgressRow(key, -1, `Absent — DSP fallback`);
      console.warn(`[VIP preload] "${key}" unavailable:`, err.message);
      // Continue — missing models degrade gracefully
    }
  }

  _finalizeProgressPanel(results);

  // Dispatch completion event for vip-boot.js to pick up
  window.dispatchEvent(new CustomEvent('vip:modelsPreloaded', {
    detail: { modelPaths, results }
  }));

  return modelPaths;
};

// ─────────────────────────────────────────────────────────────────────────────
//  CACHE MANAGEMENT UTILITIES (exposed for devtools)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clear the entire model cache from IndexedDB.
 * Call from devtools: await window._vipClearModelCache()
 */
window._vipClearModelCache = async function clearModelCache() {
  const keys = await idbListKeys();
  for (const key of keys) await idbDelete(key);
  revokeAllModelURLs();
  console.info('[VIP cache] All models cleared from IDB cache.');
  return keys;
};

/**
 * Report cache status to console.
 * Call from devtools: await window._vipCacheStatus()
 */
window._vipCacheStatus = async function cacheStatus() {
  const db    = await openModelDB();
  const store = new Promise((res, rej) => {
    const tx  = db.transaction(VIP_IDB_STORE, 'readonly');
    const req = tx.objectStore(VIP_IDB_STORE).getAll();
    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = (e) => rej(e.target.error);
  });
  const entries = await store;
  const totalMB = entries.reduce((a, e) => a + (e.size || 0), 0) / 1_048_576;
  console.group('[VIP cache] IndexedDB Model Cache Status');
  console.table(entries.map(e => ({
    key:  e.key,
    size: `${(e.size / 1_048_576).toFixed(1)} MB`,
    cached: new Date(e.ts).toLocaleString()
  })));
  console.log(`Total cached: ${totalMB.toFixed(1)} MB`);
  console.groupEnd();
  return entries;
};

// ─────────────────────────────────────────────────────────────────────────────
//  PROGRESS UI
/**
 * Create or reset a small on-page progress panel and populate it with one row per model key.
 *
 * The panel is inserted into document.body with id "vip-model-load-panel" (or cleared if already present),
 * includes a scoped style block, an accessible heading, a progress row for each key (label, track/fill with
 * id `vip-mlp-fill-<key>`, and status with id `vip-mlp-status-<key>`), and a footer hint about missing files.
 *
 * @param {string[]} keys - Array of model keys to display as individual progress rows.
 */

function _ensureProgressPanel(keys) {
  let panel = document.getElementById('vip-model-load-panel');
  if (panel) { panel.innerHTML = ''; } else {
    panel = document.createElement('div');
    panel.id = 'vip-model-load-panel';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    panel.setAttribute('aria-label', 'Model loading progress');

    const style = document.createElement('style');
    style.textContent = `
      #vip-model-load-panel {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: #0e0e0e;
        border: 1px solid #333;
        border-radius: 8px;
        padding: 20px 24px;
        min-width: 340px;
        max-width: 90vw;
        z-index: 10000;
        box-shadow: 0 8px 40px rgba(0,0,0,0.7);
        font-family: 'JetBrains Mono', 'Fira Mono', monospace;
        font-size: 12px;
        color: #ccc;
      }
      #vip-model-load-panel h4 {
        font-size: 13px;
        font-weight: 700;
        color: #fff;
        margin-bottom: 12px;
        letter-spacing: 0.05em;
      }
      .vip-mlp-row {
        display: grid;
        grid-template-columns: 120px 1fr 60px;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .vip-mlp-label { color: #aaa; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .vip-mlp-track {
        height: 4px;
        background: #2a2a2a;
        border-radius: 99px;
        overflow: hidden;
      }
      .vip-mlp-fill {
        height: 100%;
        width: 0%;
        background: #22c55e;
        border-radius: 99px;
        transition: width 0.2s ease;
      }
      .vip-mlp-fill.absent { background: #f59e0b; width: 100%; }
      .vip-mlp-status { font-size: 10px; color: #666; text-align: right; }
      .vip-mlp-status.ready { color: #22c55e; }
      .vip-mlp-status.absent { color: #f59e0b; }
      .vip-mlp-footer {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid #222;
        color: #555;
        font-size: 10px;
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panel);
  }

  const title = document.createElement('h4');
  title.textContent = '⚡ VoiceIsolate Pro — Loading ML Models';
  panel.appendChild(title);

  for (const key of keys) {
    const row = document.createElement('div');
    row.className = 'vip-mlp-row';
    row.id = `vip-mlp-row-${key}`;

    const label = document.createElement('span');
    label.className = 'vip-mlp-label';
    label.title = key;
    label.textContent = key;

    const track = document.createElement('div');
    track.className = 'vip-mlp-track';
    const fill = document.createElement('div');
    fill.className = 'vip-mlp-fill';
    fill.id = `vip-mlp-fill-${key}`;
    track.appendChild(fill);

    const status = document.createElement('span');
    status.className = 'vip-mlp-status';
    status.id = `vip-mlp-status-${key}`;
    status.textContent = 'Pending';

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(status);
    panel.appendChild(row);
  }

  const footer = document.createElement('div');
  footer.className = 'vip-mlp-footer';
  footer.textContent = 'Missing files → place .onnx in public/app/models/, reload.';
  panel.appendChild(footer);
}

function _updateProgressRow(key, pct, statusText) {
  const fill   = document.getElementById(`vip-mlp-fill-${key}`);
  const status = document.getElementById(`vip-mlp-status-${key}`);
  if (!fill || !status) return;

  if (pct === -1) {
    fill.classList.add('absent');
    status.classList.add('absent');
    status.textContent = statusText;
  } else {
    fill.style.width = `${pct}%`;
    status.textContent = statusText;
    if (pct === 100) {
      status.classList.add('ready');
    }
  }
}

function _finalizeProgressPanel(results) {
  // Auto-dismiss after 1.5s if all loaded, 4s if any failed
  const delay = results.failed.length > 0 ? 4000 : 1500;
  setTimeout(() => {
    const panel = document.getElementById('vip-model-load-panel');
    if (panel) panel.remove();
  }, delay);
}

// ─────────────────────────────────────────────────────────────────────────────
//  GLOBAL PROGRESS EVENT LISTENERS
// ─────────────────────────────────────────────────────────────────────────────

window.addEventListener('vip:modelDownloadProgress', (e) => {
  const { key, pct } = e.detail;
  _updateProgressRow(key, pct, pct >= 0 ? `${pct}%` : 'Streaming...');
});

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _emitProgress(key, loaded, total, pct) {
  window.dispatchEvent(new CustomEvent('vip:modelDownloadProgress', {
    detail: { key, loaded, total, pct }
  }));
}

function _emitComplete(key, buffer, fromCache) {
  window.dispatchEvent(new CustomEvent('vip:modelDownloadComplete', {
    detail: { key, buffer, fromCache }
  }));
}

function _emitError(key, error) {
  window.dispatchEvent(new CustomEvent('vip:modelDownloadError', {
    detail: { key, error: error.message }
  }));
}

/**
 * Concatenate multiple Uint8Array chunks into a single ArrayBuffer.
 * @param {Uint8Array[]} chunks
 * @param {number} totalSize
 * @returns {ArrayBuffer}
 */
function _concatBuffers(chunks, totalSize) {
  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
//  VIPBOOT INTEGRATION HOOK
// ─────────────────────────────────────────────────────────────────────────────
//
//  vip-boot.js should call:
//
//    // 1. Fire model pre-check (HEAD requests only, fast)
//    const presence = await window._checkModelFiles();
//
//    // 2. Preload in priority order (uses IDB cache, shows progress UI)
//    const modelPaths = await window._vipPreloadModels([
//      'silero_vad', 'deepfilter', 'dns2_conformer_small',
//      'ecapa_tdnn',  'convtasnet',  'bsrnn', 'demucs'
//    ]);
//
//    // 3. Pass Object URLs to ml-worker init so it skips re-fetching
//    mlWorker.postMessage({
//      type: 'init',
//      models: Object.keys(modelPaths),
//      modelPaths  // e.g. { demucs: 'blob:...', bsrnn: 'blob:...' }
//    });
//
//    // 4. Wrap worker with graceful-degradation patch
//    window._mlWorkerPatch(mlWorker, {
//      onWarning: (stageId, modelKey, meta) => {
//        console.warn(`Stage ${stageId}: ${modelKey} absent — passthrough active`);
//      }
//    });
//
// ─────────────────────────────────────────────────────────────────────────────

// Expose registry for external introspection
window._vipModelRegistry = MODEL_REGISTRY;

console.debug('[VIP] ml-worker-fetch-cache.js loaded — IDB cache + chunked download ready.');

// ─────────────────────────────────────────────────────────────────────────────
//  ML Worker: Model Absence Graceful Degradation
//  (merged from ml-worker-models-patch.js)
//
//  PURPOSE: Non-destructive monkey-patch applied to the ML Worker AFTER
//  construction, BEFORE the 'init' postMessage is sent.
//
//  When .onnx model files are absent from public/app/models/:
//    • Intercepts ml-worker.js 'modelMissing' messages
//    • Stamps ⚠ DSP badges on affected pipeline stage UI elements
//    • Shows a dismissible banner listing absent files + source links
//    • DSP passthrough continues — pipeline produces output on all stages
//
//  INTEGRATION: window._mlWorkerPatch(worker, { logToConsole, onWarning, onManifest });
//
//  CONSTRAINTS:
//    ✅ 100% local — no fetch to external URLs
//    ✅ Non-destructive — does NOT modify ml-worker.js prototype
//    ✅ Works with or without model files present
// ─────────────────────────────────────────────────────────────────────────────

// MODEL MANIFEST — single source of truth for stage↔model mapping.
// Keys MUST match MODEL_REGISTRY keys above.
const MODEL_MANIFEST = {
  noise_classifier:    { stageId: 'S04', stageName: 'S04 Noise Classification',     filename: 'noise_classifier.onnx',    sizeLabel: '~2.5 MB', sourceUrl: 'https://github.com/karolpiczak/ESC-50' },
  silero_vad:          { stageId: 'S05', stageName: 'S05 Voice Activity Detection',  filename: 'silero_vad.onnx',          sizeLabel: '~1.7 MB', sourceUrl: 'https://github.com/snakers4/silero-vad/tree/master/files' },
  deepfilter:          { stageId: 'S08', stageName: 'S08 Deep Spectral Filter',      filename: 'deepfilter-int8.onnx',     sizeLabel: '~9 MB',   sourceUrl: 'https://github.com/Rikorose/DeepFilterNet/releases' },
  dns2_conformer_small:{ stageId: 'S10', stageName: 'S10 DNS2 Noise Suppression',   filename: 'dns2_conformer_small.onnx',sizeLabel: '~14 MB',  sourceUrl: 'https://github.com/microsoft/DNS-Challenge' },
  bsrnn:               { stageId: 'S11', stageName: 'S11 BSRNN Source Separation',  filename: 'bsrnn-int8.onnx',          sizeLabel: '~37 MB',  sourceUrl: 'https://github.com/bytedance/music_source_separation' },
  demucs:              { stageId: 'S13', stageName: 'S13 Demucs v4 Voice Isolation', filename: 'demucs-v4-int8.onnx',      sizeLabel: '~82 MB',  sourceUrl: 'https://github.com/facebookresearch/demucs' },
  ecapa_tdnn:          { stageId: 'S17', stageName: 'S17 ECAPA-TDNN Speaker ID',     filename: 'ecapa-tdnn-int8.onnx',    sizeLabel: '~20 MB',  sourceUrl: 'https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb' },
  convtasnet:          { stageId: 'S22', stageName: 'S22 ConvTasNet Speaker Sep.',   filename: 'convtasnet-int8.onnx',    sizeLabel: '~18 MB',  sourceUrl: 'https://github.com/asteroid-team/asteroid' }
};

// Normalise worker model keys → manifest keys (worker may use shorter aliases)
function _normalizeKey(key) {
  const map = {
    vad:       'silero_vad',
    silero:    'silero_vad',
    df:        'deepfilter',
    dns:       'dns2_conformer_small',
    dns2:      'dns2_conformer_small',
    ecapa:     'ecapa_tdnn',
    noise:     'noise_classifier',
    classifier:'noise_classifier'
  };
  return map[key] || key;
}

// ── BANNER UI ──────────────────────────────────────────────────────────────────
function _ensureBanner(absentModels) {
  const BANNER_ID = 'vip-missing-models-banner';
  let banner = document.getElementById(BANNER_ID);
  if (banner) banner.remove();
  if (absentModels.length === 0) return;

  banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'alert');
  banner.setAttribute('aria-live', 'polite');
  banner.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
    'background:#1c1a14', 'border-bottom:1px solid #f59e0b',
    'color:#fde68a', 'font:500 12px/1.4 "Courier New",monospace',
    'padding:8px 12px', 'display:flex', 'align-items:flex-start',
    'gap:12px', 'max-height:160px', 'overflow-y:auto'
  ].join(';');

  const icon = document.createElement('span');
  icon.textContent = '⚠';
  icon.style.cssText = 'color:#f59e0b;font-size:16px;flex-shrink:0;margin-top:1px;';

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-width:0;';

  const title = document.createElement('strong');
  title.textContent = `VoiceIsolate Pro — ${absentModels.length} ML model(s) absent. Running DSP passthrough on affected stages.`;
  title.style.display = 'block';
  title.style.marginBottom = '4px';

  const list = document.createElement('ul');
  list.style.cssText = 'margin:0;padding-left:16px;list-style:disc;';
  absentModels.forEach(key => {
    const meta = MODEL_MANIFEST[key];
    if (!meta) return;
    const li   = document.createElement('li');
    li.style.marginBottom = '2px';
    li.innerHTML =
      `<b>${meta.stageId}</b> — <code>${meta.filename}</code> (${meta.sizeLabel}) ` +
      `<a href="${meta.sourceUrl}" target="_blank" rel="noopener noreferrer" ` +
      `style="color:#7dd3fc;text-decoration:underline;">source ↗</a>`;
    list.appendChild(li);
  });

  const hint = document.createElement('p');
  hint.style.cssText = 'margin:4px 0 0;color:#a3a19a;font-size:11px;';
  hint.textContent = 'Place .onnx files in public/app/models/ — see models/README.md for conversion scripts.';

  body.appendChild(title);
  body.appendChild(list);
  body.appendChild(hint);

  const close = document.createElement('button');
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss model warning');
  close.style.cssText = [
    'background:none', 'border:none', 'color:#a3a19a', 'cursor:pointer',
    'font-size:14px', 'padding:0', 'flex-shrink:0', 'align-self:flex-start',
    'line-height:1'
  ].join(';');
  close.onclick = () => banner.remove();

  banner.appendChild(icon);
  banner.appendChild(body);
  banner.appendChild(close);
  document.body.appendChild(banner);
}

// ── STAGE BADGE STAMPING ──────────────────────────────────────────────────────
// Stamps ⚠ DSP or ● ML badges on pipeline stage UI elements.
// Called by pipeline-orchestrator.js onManifest callback + exposed globally.

/**
 * Stamp all stage badges based on manifest status.
 * @param {Record<string, 'present'|'absent'>} manifest  key → status
 */
window._stampPipelineStages = function stampPipelineStages(manifest) {
  // Validate: warn on unmapped manifest keys
  const unmapped = Object.keys(MODEL_MANIFEST).filter(k => {
    const normK = _normalizeKey(k);
    return !(normK in manifest) && !(k in manifest);
  });
  if (unmapped.length) {
    console.warn('[VIP patch] Manifest keys not returned by worker:', unmapped);
  }

  Object.entries(MODEL_MANIFEST).forEach(([modelKey, meta]) => {
    const status   = manifest[modelKey] || manifest[_normalizeKey(modelKey)] || 'absent';
    const isAbsent = status === 'absent';

    // Try multiple selector strategies
    const selectors = [
      `[data-stage-id="${meta.stageId}"]`,
      `[data-stage="${meta.stageId}"]`,
      `[data-stage-id="${meta.stageId.toLowerCase()}"]`
    ];
    let el = null;
    for (const sel of selectors) {
      el = document.querySelector(sel);
      if (el) break;
    }
    if (!el) return;

    const existing = el.querySelector('.vip-stage-ml-status');
    if (existing) existing.remove();

    const badge = document.createElement('span');
    badge.className    = 'vip-stage-ml-status';
    badge.style.cssText =
      `color:${isAbsent ? '#f59e0b' : '#34d399'};` +
      'font-size:10px;font-weight:700;margin-left:4px;' +
      'cursor:help;vertical-align:middle;';
    badge.textContent  = isAbsent ? '⚠ DSP' : '● ML';
    badge.title = isAbsent
      ? `${meta.stageName}: model absent (${meta.filename})\nDSP passthrough active.`
      : `${meta.stageName}: ML inference active (${meta.filename})`;

    const label =
      el.querySelector('.stage-name,.stage-label,.stage-title,h4,h3,span') || el;
    label.appendChild(badge);
  });
};

// ── MODEL FILE PRESENCE CHECK (HEAD requests — fast, no download) ─────────────

/**
 * HEAD-check all model files. Returns map of key → 'present'|'absent'.
 * @returns {Promise<Record<string, 'present'|'absent'>>}
 */
window._checkModelFiles = async function checkModelFiles() {
  const results = {};
  await Promise.allSettled(
    Object.entries(MODEL_MANIFEST).map(async ([key, meta]) => {
      try {
        const r = await fetch(`models/${meta.filename}`, { method: 'HEAD' });
        results[key] = r.ok ? 'present' : 'absent';
      } catch {
        results[key] = 'absent';
      }
    })
  );
  return results;
};

// ── CORE PATCH FUNCTION ───────────────────────────────────────────────────────
// Intercepts worker messages and wires onWarning / onManifest callbacks.

/**
 * Apply graceful-degradation patch to an ML Worker instance.
 *
 * @param {Worker} worker          The ml-worker.js Worker instance
 * @param {object} [opts]
 * @param {boolean} [opts.logToConsole=true]
 * @param {function} [opts.onWarning]   (stageId, modelKey, meta) => void
 * @param {function} [opts.onManifest]  (manifest) => void
 */
window._mlWorkerPatch = function mlWorkerPatch(worker, opts = {}) {
  const { logToConsole = true, onWarning, onManifest } = opts;

  const absentKeys   = new Set();
  const manifestSeen = {};

  // Wrap the existing onmessage handler (if any) — non-destructive
  const _prevOnMessage = worker.onmessage;

  worker.onmessage = function patchedOnMessage(e) {
    const { type } = e.data || {};

    // ── Handle 'modelMissing' notifications from ml-worker.js ─────────────
    if (type === 'modelMissing') {
      const rawKey  = e.data.model || e.data.key || '';
      const normKey = _normalizeKey(rawKey);
      const meta    = MODEL_MANIFEST[normKey] || MODEL_MANIFEST[rawKey] || {};

      absentKeys.add(normKey);
      manifestSeen[normKey] = 'absent';

      if (logToConsole) {
        console.warn(
          `[VIP patch] ML stage missing model: "${rawKey}" (stage ${meta.stageId || '?'}) — DSP passthrough active`
        );
      }
      if (typeof onWarning === 'function') {
        onWarning(meta.stageId || rawKey, normKey, meta);
      }
    }

    // ── Handle 'modelLoaded' confirmations ────────────────────────────────
    if (type === 'modelLoaded') {
      const rawKey  = e.data.model || e.data.key || '';
      const normKey = _normalizeKey(rawKey);
      manifestSeen[normKey] = 'present';
      if (logToConsole) {
        const meta = MODEL_MANIFEST[normKey] || {};
        console.info(`[VIP patch] ML model loaded: "${rawKey}" (${meta.stageName || normKey})`);
      }
    }

    // ── Handle 'ready' — fire manifest callback + show banner ─────────────
    if (type === 'ready') {
      // Merge any model status the worker reported in ready payload
      if (e.data.models && Array.isArray(e.data.models)) {
        e.data.models.forEach(k => {
          const normK = _normalizeKey(k);
          if (!(normK in manifestSeen)) manifestSeen[normK] = 'present';
        });
      }
      // Fill in absent status for any manifest keys not yet seen
      Object.keys(MODEL_MANIFEST).forEach(k => {
        if (!(k in manifestSeen)) manifestSeen[k] = 'absent';
      });

      if (typeof onManifest === 'function') {
        onManifest({ ...manifestSeen });
      }
      // Stamp all stage badges
      if (typeof window._stampPipelineStages === 'function') {
        window._stampPipelineStages({ ...manifestSeen });
      }
      // Show missing-model banner
      const absent = Object.entries(manifestSeen)
        .filter(([, v]) => v === 'absent')
        .map(([k]) => k);
      _ensureBanner(absent);
    }

    // ── Pass through to original handler ──────────────────────────────────
    if (typeof _prevOnMessage === 'function') {
      _prevOnMessage.call(worker, e);
    }
  };

  // ── Run immediate file-presence check (HEAD-only, fast) ─────────────────
  // This gives us early badge/banner state before the worker fires 'ready'.
  window._checkModelFiles().then((presence) => {
    Object.assign(manifestSeen, presence);

    const earlyAbsent = Object.entries(presence)
      .filter(([, v]) => v === 'absent')
      .map(([k]) => k);

    if (earlyAbsent.length > 0) {
      _ensureBanner(earlyAbsent);
      if (typeof window._stampPipelineStages === 'function') {
        window._stampPipelineStages(presence);
      }
      if (logToConsole) {
        console.warn(
          '[VIP patch] Absent model files detected:',
          earlyAbsent.map(k => MODEL_MANIFEST[k]?.filename || k)
        );
      }
    }
  });
};

console.debug('[VIP] ml-worker graceful-degradation patch ready (v2.1).');

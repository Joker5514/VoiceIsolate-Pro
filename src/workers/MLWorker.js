/**
 * VoiceIsolate Pro — ML Inference Worker (Layer 2: Workers)
 *
 * Classic Web Worker that owns the entire offline-inference lifecycle:
 *
 *   1. Fetch the .onnx model named by the manifest entry (same-origin /models)
 *   2. Verify its SHA-256 against the pinned manifest hash
 *   3. Cache verified bytes in IndexedDB (re-verified on every load)
 *   4. Run offline ONNX Runtime inference over the full file using
 *      overlap-add / segment-crossfade reconstruction
 *   5. Post back two stems as transferable Float32Arrays:
 *        clean  — the model's voice estimate
 *        noise  — the residual (input − clean)
 *
 * Protocol (postMessage):
 *   → { type: 'init', manifest: ManifestEntry[] }
 *   ← { type: 'ready', backend: 'webgpu'|'wasm' }
 *   → { type: 'process', requestId, modelId, channelData: Float32Array[], sampleRate }
 *   ← { type: 'progress', requestId, percent }
 *   ← { type: 'stems', requestId, clean: Float32Array[], noise: Float32Array[],
 *       sampleRate, passthrough: boolean }
 *   ← { type: 'error', requestId?, message }
 *
 * This worker NEVER touches the DOM, never opens a microphone, and never
 * re-runs on slider changes — inference happens exactly once per file.
 * The manifest arrives via the init message (single source of truth lives in
 * src/core/ModelManifest.js; classic workers cannot import ES modules).
 */
'use strict';

importScripts('/lib/ort.min.js');

const IDB_NAME = 'vip-model-cache';
const IDB_STORE = 'models';
const IDB_VERSION = 1;

/** Map of modelId → manifest entry, populated by 'init'. */
let MANIFEST = Object.create(null);

/** Map of modelId → InferenceSession (lazy, persistent for worker lifetime). */
const SESSIONS = Object.create(null);

/** Resolved execution backend, decided once. */
let BACKEND = null;

// ─── IndexedDB model byte-cache ──────────────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbPut(key, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ─── Integrity ───────────────────────────────────────────────────────────────

async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verify model bytes against the manifest. A null manifest hash disables
 * verification with a loud warning (development only — see CLAUDE.md §3).
 */
async function verifyIntegrity(entry, bytes) {
  if (entry.sha256 === null || entry.sha256 === undefined) {
    console.warn(
      `[VIP][MLWorker] Model '${entry.id}' has no pinned SHA-256 — ` +
      'integrity verification SKIPPED. Pin the hash before shipping.'
    );
    return;
  }
  const actual = await sha256Hex(bytes);
  if (actual !== entry.sha256) {
    throw new Error(
      `[VIP][MLWorker] Integrity failure for '${entry.id}': ` +
      `expected ${entry.sha256}, got ${actual}. Refusing to load.`
    );
  }
}

// ─── Model loading ───────────────────────────────────────────────────────────

async function fetchModelBytes(entry) {
  const cacheKey = `${entry.id}:${entry.sha256 || 'unpinned'}`;

  const cached = await idbGet(cacheKey).catch(() => null);
  if (cached) {
    try {
      await verifyIntegrity(entry, cached);
      return cached;
    } catch (err) {
      console.warn(`[VIP][MLWorker] Cached bytes for '${entry.id}' failed verification; refetching.`, err);
    }
  }

  const res = await fetch(entry.url);
  if (!res.ok) {
    throw new Error(`[VIP][MLWorker] Fetch failed for ${entry.url}: HTTP ${res.status}`);
  }
  const bytes = await res.arrayBuffer();
  await verifyIntegrity(entry, bytes);
  await idbPut(cacheKey, bytes).catch((err) => {
    console.warn('[VIP][MLWorker] IndexedDB cache write failed (non-fatal):', err);
  });
  return bytes;
}

async function resolveBackend() {
  if (BACKEND) return BACKEND;
  // WebGPU preferred; WASM (SIMD/threaded) fallback. Probe via adapter request
  // because ort silently falls back in ways that hide misconfiguration.
  let webgpuOk = false;
  try {
    webgpuOk = Boolean(self.navigator?.gpu && await self.navigator.gpu.requestAdapter());
  } catch { webgpuOk = false; }
  BACKEND = webgpuOk ? 'webgpu' : 'wasm';
  return BACKEND;
}

async function getSession(entry) {
  if (SESSIONS[entry.id]) return SESSIONS[entry.id];
  const bytes = await fetchModelBytes(entry);
  const backend = await resolveBackend();
  const opts = {
    executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
    graphOptimizationLevel: 'all',
  };
  const session = await ort.InferenceSession.create(bytes, opts);
  SESSIONS[entry.id] = session;
  return session;
}

// ─── DSP helpers (windowed reconstruction) ───────────────────────────────────

/** Hann window of length n (cached per length). */
const _hannCache = Object.create(null);
function hann(n) {
  if (_hannCache[n]) return _hannCache[n];
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  _hannCache[n] = w;
  return w;
}

/**
 * Frame-based overlap-add enhancement (DeepFilterNet-style models).
 * Slides a frameSize window with hopSize stride, runs the model per frame,
 * and reconstructs via Hann-weighted overlap-add.
 *
 * @param {object} entry     manifest entry (frameSize, hopSize, io)
 * @param {object} session   ort.InferenceSession
 * @param {Float32Array} samples  one channel
 * @param {(p: number) => void} onProgress  0..1
 * @returns {Promise<Float32Array>} enhanced channel
 */
async function runOverlapAdd(entry, session, samples, onProgress) {
  const N = entry.frameSize;
  const hop = entry.hopSize;
  const win = hann(N);
  const out = new Float32Array(samples.length);
  const norm = new Float32Array(samples.length);
  const frame = new Float32Array(N);
  const totalFrames = Math.max(1, Math.ceil((samples.length - N) / hop) + 1);

  for (let f = 0; f < totalFrames; f++) {
    const start = f * hop;
    frame.fill(0);
    const avail = Math.min(N, samples.length - start);
    if (avail <= 0) break;
    frame.set(samples.subarray(start, start + avail));

    const input = new ort.Tensor('float32', frame.slice(), [1, N]);
    const results = await session.run({ [entry.io.input]: input });
    const enhanced = results[entry.io.output]?.data;
    if (!enhanced || enhanced.length < avail) {
      throw new Error(`[VIP][MLWorker] '${entry.id}' returned a malformed output tensor.`);
    }

    for (let i = 0; i < avail; i++) {
      out[start + i] += enhanced[i] * win[i];
      norm[start + i] += win[i] * win[i];
    }
    if (f % 16 === 0) onProgress(f / totalFrames);
  }

  for (let i = 0; i < out.length; i++) {
    if (norm[i] > 1e-8) out[i] /= norm[i];
  }
  onProgress(1);
  return out;
}

/**
 * Segment-based waveform separation with linear cross-fades (MDX-Net-style).
 * Channels are processed jointly: tensor shape [1, channels, segmentSamples].
 *
 * @param {object} entry
 * @param {object} session
 * @param {Float32Array[]} channelData
 * @param {(p: number) => void} onProgress
 * @returns {Promise<Float32Array[]>} clean (vocal) channels
 */
async function runSegmentCrossfade(entry, session, channelData, onProgress) {
  const seg = entry.segmentSamples;
  const overlap = entry.overlapSamples;
  const stride = seg - overlap;
  const channels = channelData.length;
  const length = channelData[0].length;
  const out = channelData.map(() => new Float32Array(length));
  const totalSegs = Math.max(1, Math.ceil(Math.max(1, length - overlap) / stride));

  for (let s = 0; s < totalSegs; s++) {
    const start = s * stride;
    if (start >= length) break;
    const avail = Math.min(seg, length - start);

    // Pack [1, channels, seg] (zero-padded tail).
    const packed = new Float32Array(channels * seg);
    for (let ch = 0; ch < channels; ch++) {
      packed.set(channelData[ch].subarray(start, start + avail), ch * seg);
    }
    const input = new ort.Tensor('float32', packed, [1, channels, seg]);
    const results = await session.run({ [entry.io.input]: input });
    const vocals = results[entry.io.output]?.data;
    if (!vocals || vocals.length < channels * avail) {
      throw new Error(`[VIP][MLWorker] '${entry.id}' returned a malformed output tensor.`);
    }

    // Linear cross-fade against the previous segment in the overlap zone.
    for (let ch = 0; ch < channels; ch++) {
      const dst = out[ch];
      for (let i = 0; i < avail; i++) {
        const idx = start + i;
        const v = vocals[ch * seg + i];
        if (s > 0 && i < overlap) {
          const fade = i / overlap;
          dst[idx] = dst[idx] * (1 - fade) + v * fade;
        } else {
          dst[idx] = v;
        }
      }
    }
    onProgress((s + 1) / totalSegs);
  }
  return out;
}

// ─── Stem assembly ───────────────────────────────────────────────────────────

/** noise = input − clean, computed sample-wise per channel. */
function residual(channelData, cleanChannels) {
  return channelData.map((input, ch) => {
    const clean = cleanChannels[ch];
    const noise = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) noise[i] = input[i] - clean[i];
    return noise;
  });
}

async function processRequest({ requestId, modelId, channelData, sampleRate }) {
  const entry = MANIFEST[modelId];
  if (!entry) {
    throw new Error(`[VIP][MLWorker] Unknown model '${modelId}'. Did 'init' run?`);
  }

  const onProgress = (p) => {
    self.postMessage({ type: 'progress', requestId, percent: Math.round(p * 100) });
  };

  let clean;
  let passthrough = false;
  try {
    const session = await getSession(entry);
    if (entry.strategy === 'segment-crossfade') {
      clean = await runSegmentCrossfade(entry, session, channelData, onProgress);
    } else {
      clean = [];
      for (let ch = 0; ch < channelData.length; ch++) {
        clean.push(await runOverlapAdd(entry, session, channelData[ch], (p) =>
          onProgress((ch + p) / channelData.length)
        ));
      }
    }
  } catch (err) {
    // Graceful degradation: the UI must keep working without a model.
    // Passthrough stems: clean = input, noise = silence.
    console.error(`[VIP][MLWorker] Inference failed for '${modelId}'; emitting passthrough stems.`, err);
    clean = channelData.map((c) => new Float32Array(c));
    passthrough = true;
  }

  const noise = passthrough
    ? channelData.map((c) => new Float32Array(c.length))
    : residual(channelData, clean);

  const transfers = [...clean, ...noise].map((a) => a.buffer);
  self.postMessage(
    { type: 'stems', requestId, clean, noise, sampleRate, passthrough },
    transfers
  );
}

// ─── Message loop ────────────────────────────────────────────────────────────

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    switch (msg.type) {
      case 'init': {
        MANIFEST = Object.create(null);
        for (const entry of msg.manifest || []) MANIFEST[entry.id] = entry;
        if (typeof ort !== 'undefined' && ort.env?.wasm) {
          ort.env.wasm.wasmPaths = '/lib/';
          ort.env.wasm.numThreads = Math.min(4, self.navigator?.hardwareConcurrency || 1);
        }
        const backend = await resolveBackend();
        self.postMessage({ type: 'ready', backend });
        break;
      }
      case 'process':
        await processRequest(msg);
        break;
      default:
        self.postMessage({ type: 'error', message: `Unknown message type '${msg.type}'` });
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      requestId: msg.requestId,
      message: err?.message || String(err),
    });
  }
};

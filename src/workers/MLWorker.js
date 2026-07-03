/**
 * VoiceIsolate Pro — ML Inference Worker (Layer 2: Workers)
 *
 * Classic Web Worker that owns the entire offline-inference lifecycle:
 *
 *   1. Fetch the .onnx model named by the manifest entry (same-origin
 *      /app/models — committed, trained spectral-mask networks)
 *   2. Verify its SHA-256 against the pinned manifest hash
 *   3. Cache verified bytes in IndexedDB (re-verified on every load)
 *   4. Run offline ONNX Runtime inference over the full file: STFT →
 *      batched magnitude-mask inference → masked iSTFT overlap-add
 *   5. Post back two stems as transferable Float32Arrays:
 *        clean  — the model's voice estimate
 *        noise  — the residual (input − clean)
 *
 * Protocol (postMessage):
 *   → { type: 'init', manifest: ManifestEntry[] }
 *   ← { type: 'ready', backend: 'webgpu'|'wasm' }
 *   → { type: 'process', requestId, modelId, channelData: Float32Array[], sampleRate }
 *   → { type: 'process', requestId, modelIds: string[], channelData, sampleRate }
 *        (chain — runs models in series, e.g. vocals → denoise, for maximum
 *         isolation; each stage's clean output feeds the next)
 *   ← { type: 'progress', requestId, percent }
 *   ← { type: 'stage', requestId, stage, percent, modelId?, label? }
 *   ← { type: 'stems', requestId, clean: Float32Array[], noise: Float32Array[],
 *       sampleRate, passthrough: boolean }
 *   → { type: 'warmup', modelIds: string[] }
 *   ← { type: 'warmed', modelIds: string[] }
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

/** Map of sessionKey → InferenceSession (lazy, persistent for worker lifetime). */
const SESSIONS = Object.create(null);

/** Resolved execution backend, decided once. */
let BACKEND = null;

/** Active process request id for stage/progress messages. */
let ACTIVE_REQUEST_ID = null;

// ─── IndexedDB model byte-cache (single connection — no open/close per op) ───

let _idb = null;
let _idbPromise = null;

function openDb() {
  if (_idb) return Promise.resolve(_idb);
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => { _idb = req.result; resolve(_idb); };
    req.onerror = () => reject(req.error);
  });
  return _idbPromise;
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function postStage(stage, percent, extra = {}) {
  if (ACTIVE_REQUEST_ID == null) return;
  self.postMessage({ type: 'stage', requestId: ACTIVE_REQUEST_ID, stage, percent, ...extra });
}

function effectiveBatchFrames(entry) {
  const base = entry.maxBatchFrames || 32;
  return BACKEND === 'webgpu' ? Math.min(128, base * 2) : base;
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

async function createSessionFromBytes(entry, bytes) {
  const backend = await resolveBackend();
  const opts = {
    executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
    graphOptimizationLevel: 'all',
  };
  return ort.InferenceSession.create(bytes, opts);
}

async function getSession(entry, sessionKey = entry.id, { quiet = false } = {}) {
  if (SESSIONS[sessionKey]) return SESSIONS[sessionKey];
  if (!quiet) postStage('load', 0, { modelId: entry.id, label: `Loading ${entry.name || entry.id}…` });
  const bytes = await fetchModelBytes(entry);
  if (!quiet) postStage('load', 50, { modelId: entry.id });
  const session = await createSessionFromBytes(entry, bytes);
  SESSIONS[sessionKey] = session;
  if (!quiet) postStage('load', 100, { modelId: entry.id });
  return session;
}

/** Cache bytes + compile ONNX sessions off the hot path (boot / during decode). */
async function warmupModels(modelIds) {
  const ids = (Array.isArray(modelIds) ? modelIds : [])
    .filter((id) => typeof id === 'string' && MANIFEST[id]);
  await Promise.all(ids.map(async (id) => {
    const entry = MANIFEST[id];
    try {
      await getSession(entry, entry.id, { quiet: true });
    } catch (err) {
      console.warn(`[VIP][MLWorker] Warmup failed for '${id}':`, err);
    }
  }));
  self.postMessage({ type: 'warmed', modelIds: ids });
}

// ─── DSP helpers (STFT / mask / iSTFT reconstruction) ────────────────────────

/** Hann window of length n (cached per length). */
const _hannCache = Object.create(null);
function hann(n) {
  if (_hannCache[n]) return _hannCache[n];
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  _hannCache[n] = w;
  return w;
}

/** Precomputed FFT tables (bit-reversal permutation + twiddles) per size. */
const _fftCache = Object.create(null);
function fftTables(n) {
  if (_fftCache[n]) return _fftCache[n];
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  _fftCache[n] = { rev, cos, sin };
  return _fftCache[n];
}

/**
 * In-place iterative radix-2 complex FFT (power-of-two n).
 * Forward uses e^{-i2πk/n}; inverse conjugates twiddles and scales by 1/n.
 */
function fftInPlace(re, im, inverse) {
  const n = re.length;
  const { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const r = rev[i];
    if (r > i) {
      let t = re[i]; re[i] = re[r]; re[r] = t;
      t = im[i]; im[i] = im[r]; im[r] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k];
        const wi = inverse ? -sin[k] : sin[k];
        const a = i + j;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/**
 * Spectral-mask inference: the contract shared by both shipped models
 * (BiGRU noise suppressor, BSRNN vocal extractor).
 *
 *   1. STFT the channel (fftSize, hopSize, Hann)
 *   2. Batch magnitude frames into [batch, bins] tensors
 *   3. session.run → sigmoid mask per frame
 *   4. Multiply mask into the complex spectrum, inverse STFT, overlap-add
 *
 * @param {object} entry     manifest entry (fftSize, hopSize, bins, io)
 * @param {object} session   ort.InferenceSession
 * @param {Float32Array} samples  one channel at 48 kHz
 * @param {(p: number) => void} onProgress  0..1
 * @returns {Promise<Float32Array>} masked (clean) channel
 */
async function runSpectralMask(entry, session, samples, onProgress) {
  const N = entry.fftSize;
  const hop = entry.hopSize;
  const bins = entry.bins || (N / 2 + 1);
  const batchMax = effectiveBatchFrames(entry);
  const win = hann(N);
  // Cover every sample: full frames plus a zero-padded tail frame.
  const totalFrames = Math.max(1, Math.ceil(Math.max(0, samples.length - N) / hop) + 1);

  const out = new Float32Array(samples.length);
  const norm = new Float32Array(samples.length);

  // Scratch buffers reused across the whole file — no per-frame allocation.
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const batchMags = new Float32Array(batchMax * bins);
  const batchRe = new Float32Array(batchMax * bins);
  const batchIm = new Float32Array(batchMax * bins);

  for (let f0 = 0; f0 < totalFrames; f0 += batchMax) {
    const count = Math.min(batchMax, totalFrames - f0);

    // ── Forward STFT for this batch ─────────────────────────────────────
    for (let b = 0; b < count; b++) {
      const start = (f0 + b) * hop;
      const avail = Math.max(0, Math.min(N, samples.length - start));
      re.fill(0); im.fill(0);
      for (let i = 0; i < avail; i++) re[i] = samples[start + i] * win[i];
      fftInPlace(re, im, false);
      const off = b * bins;
      for (let k = 0; k < bins; k++) {
        batchRe[off + k] = re[k];
        batchIm[off + k] = im[k];
        batchMags[off + k] = Math.hypot(re[k], im[k]);
      }
    }

    // ── Mask inference (dynamic batch) ──────────────────────────────────
    const input = new ort.Tensor('float32', batchMags.subarray(0, count * bins), [count, bins]);
    const results = await session.run({ [entry.io.input]: input });
    const mask = results[entry.io.output]?.data;
    if (!mask || mask.length < count * bins) {
      throw new Error(`[VIP][MLWorker] '${entry.id}' returned a malformed output tensor.`);
    }

    // ── Masked inverse STFT + overlap-add ───────────────────────────────
    for (let b = 0; b < count; b++) {
      const off = b * bins;
      // Rebuild the full Hermitian spectrum from the masked half-spectrum.
      for (let k = 0; k < bins; k++) {
        const m = mask[off + k];
        re[k] = batchRe[off + k] * m;
        im[k] = batchIm[off + k] * m;
      }
      for (let k = bins; k < N; k++) {
        re[k] = re[N - k];
        im[k] = -im[N - k];
      }
      fftInPlace(re, im, true);

      const start = (f0 + b) * hop;
      const avail = Math.max(0, Math.min(N, samples.length - start));
      for (let i = 0; i < avail; i++) {
        out[start + i] += re[i] * win[i];
        norm[start + i] += win[i] * win[i];
      }
    }
    onProgress(Math.min(1, (f0 + count) / totalFrames));
  }

  for (let i = 0; i < out.length; i++) {
    if (norm[i] > 1e-8) out[i] /= norm[i];
  }
  onProgress(1);
  return out;
}

/** Linear resample mono PCM between sample rates. */
function resampleLinear(samples, fromSr, toSr) {
  if (fromSr === toSr) return new Float32Array(samples);
  const ratio = toSr / fromSr;
  const outLen = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/**
 * Waveform strategy — Demucs vocal-ratio mask [1,1,T] applied to input PCM.
 * Processes fixed-length segments (default 344520 @ 44.1 kHz ≈ 7.8 s).
 */
async function runWaveformMask(entry, session, samples, sampleRate, onProgress) {
  const modelSr = entry.sampleRate || 44100;
  let pcm = sampleRate === modelSr ? samples : resampleLinear(samples, sampleRate, modelSr);
  const segmentLen = entry.segmentSamples || 344520;
  const inName = entry.io?.input || 'input';
  const outName = entry.io?.output || 'output';
  const out = new Float32Array(pcm.length);
  const totalSegs = Math.ceil(pcm.length / segmentLen) || 1;
  const chunk = new Float32Array(segmentLen);

  for (let seg = 0; seg < totalSegs; seg++) {
    const offset = seg * segmentLen;
    const len = Math.min(segmentLen, pcm.length - offset);
    chunk.fill(0);
    chunk.set(pcm.subarray(offset, offset + len));
    const input = new ort.Tensor('float32', chunk, [1, 1, segmentLen]);
    const result = await session.run({ [inName]: input });
    const maskTensor = result[outName] || result.output;
    if (!maskTensor?.data) {
      throw new Error(`[VIP][MLWorker] '${entry.id}' returned no mask tensor.`);
    }
    const mask = maskTensor.data;
    for (let i = 0; i < len; i++) {
      const m = Math.max(0, Math.min(1, mask[i]));
      out[offset + i] = chunk[i] * m;
    }
    onProgress((seg + 1) / totalSegs);
  }

  if (sampleRate !== modelSr) {
    const back = resampleLinear(out, modelSr, sampleRate);
    const fixed = new Float32Array(samples.length);
    fixed.set(back.subarray(0, Math.min(back.length, samples.length)));
    return fixed;
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

async function processRequest({ requestId, modelId, modelIds, channelData, sampleRate }) {
  // A chain (`modelIds`) runs models in series for maximum isolation —
  // e.g. ['bsrnn_vocals', 'rnnoise'] extracts the voice, then strips any
  // residual background. A single `modelId` is the one-pass case. Each stage
  // feeds its clean output into the next; the noise stem is always the
  // sample-wise residual against the ORIGINAL input (input − final clean).
  const chain = (Array.isArray(modelIds) && modelIds.length ? modelIds : [modelId])
    .filter((id) => typeof id === 'string' && id);
  if (chain.length === 0) {
    throw new Error("[VIP][MLWorker] No model specified. Did 'init' run?");
  }
  for (const id of chain) {
    if (!MANIFEST[id]) {
      throw new Error(`[VIP][MLWorker] Unknown model '${id}'. Did 'init' run?`);
    }
  }

  ACTIVE_REQUEST_ID = requestId;
  let lastProgressSent = -1;
  const onProgress = (p) => {
    const pct = Math.round(p * 100);
    if (pct === lastProgressSent) return;
    if (pct < 100 && lastProgressSent >= 0 && pct - lastProgressSent < 2) return;
    lastProgressSent = pct;
    self.postMessage({ type: 'progress', requestId, percent: pct });
  };

  const totalSteps = chain.length * channelData.length;
  let stepBase = 0;
  let current = channelData;
  try {
    for (let ci = 0; ci < chain.length; ci++) {
      const id = chain[ci];
      const entry = MANIFEST[id];
      const nextId = chain[ci + 1];
      const nextWarm = nextId && MANIFEST[nextId]
        ? getSession(MANIFEST[nextId], MANIFEST[nextId].id, { quiet: true }).catch(() => {})
        : null;
      postStage('separate', Math.round((stepBase / totalSteps) * 100), { modelId: id });
      const next = await Promise.all(current.map(async (samples, ch) => {
        const sessionKey = current.length > 1 ? `${entry.id}:ch${ch}` : entry.id;
        const session = await getSession(entry, sessionKey);
        const step = stepBase + ch;
        const progress = (p) => onProgress((step + p) / totalSteps);
        if (entry.strategy === 'spectral-mask') {
          return runSpectralMask(entry, session, samples, progress);
        }
        if (entry.strategy === 'waveform') {
          return runWaveformMask(entry, session, samples, sampleRate, progress);
        }
        throw new Error(`[VIP][MLWorker] Unsupported strategy '${entry.strategy}' for '${entry.id}'.`);
      }));
      current = next;
      stepBase += channelData.length;
      if (nextWarm) await nextWarm;
    }
  } finally {
    ACTIVE_REQUEST_ID = null;
  }
  const clean = current;
  const noise = residual(channelData, clean);

  const transfers = [...clean, ...noise].map((a) => a.buffer);
  self.postMessage(
    { type: 'stems', requestId, clean, noise, sampleRate, passthrough: false },
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
          const cores = self.navigator?.hardwareConcurrency || 4;
          ort.env.wasm.numThreads = Math.min(8, Math.max(1, cores - 1));
        }
        const backend = await resolveBackend();
        self.postMessage({ type: 'ready', backend });
        break;
      }
      case 'process':
        await processRequest(msg);
        break;
      case 'warmup':
        await warmupModels(msg.modelIds);
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

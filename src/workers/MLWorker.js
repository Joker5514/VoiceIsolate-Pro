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
 *   → { type: 'vad', requestId, samples: Float32Array, sampleRate }
 *   ← { type: 'vad-result', requestId, scores: Float32Array, times: Float32Array,
 *       hopSec, source: 'silero'|'unavailable' }
 *   → { type: 'universal_separate', requestId, waveform, sampleRate,
 *       mode?: 'auto'|'query', numSources?: number, queries?: string[] }
 *   ← { type: 'universal_separate_result', requestId, sources: [{id,label,pcm,mask?}],
 *       shape: { frames, bins } }
 *   ← { type: 'error', requestId?, message }
 *
 * This worker NEVER touches the DOM, never opens a microphone, and never
 * re-runs on slider changes — inference happens exactly once per file.
 * The manifest arrives via the init message (single source of truth lives in
 * src/core/ModelManifest.js; classic workers cannot import ES modules).
 */
'use strict';

importScripts('/lib/ort.min.js');

// Canonical schema (keep in sync with ModelIdbSchema.js + ml-worker-fetch-cache.js)
const IDB_NAME = 'vip-model-cache';
const IDB_STORE = 'models';
const IDB_VERSION = 3;

/** Map of modelId → manifest entry, populated by 'init'. */
let MANIFEST = Object.create(null);

/** Map of sessionKey → InferenceSession (lazy, persistent for worker lifetime). */
const SESSIONS = Object.create(null);

/** In-flight session compiles — dedup concurrent getSession for the same key. */
const _sessionInflight = Object.create(null);

/** Serialize process requests — overlapping jobs corrupt ACTIVE_REQUEST_ID. */
let _processChain = Promise.resolve();

/** Per-session ONNX run queue. WASM JSEP allows only one active run worker-wide. */
const _runQueues = Object.create(null);

function inferenceQueueKey(sessionKey) {
  return BACKEND === 'webgpu' ? sessionKey : '__wasm_global__';
}

async function queuedSessionRun(sessionKey, session, feeds) {
  const key = inferenceQueueKey(sessionKey);
  const prev = _runQueues[key] || Promise.resolve();
  let release;
  _runQueues[key] = new Promise((resolve) => { release = resolve; });
  await prev;
  try {
    return await session.run(feeds);
  } finally {
    release();
  }
}

/** Resolved execution backend, decided once. */
let BACKEND = null;

/** Active process request id for stage/progress messages. */
let ACTIVE_REQUEST_ID = null;

const SESSION_COMPILE_TIMEOUT_MS = 90000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[VIP][MLWorker] ${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** When true, cache I/O is proxied to the main thread (filesystem-first on desktop). */
let USE_DESKTOP_CACHE = false;

let _cacheReqId = 0;
/** @type {Map<number, { resolve: Function, reject: Function }>} */
const _cachePending = new Map();

// ─── IndexedDB model byte-cache (single connection — no open/close per op) ───

let _idb = null;
let _idbPromise = null;

function openDb() {
  if (_idb) return Promise.resolve(_idb);
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const oldVersion = ev.oldVersion || 0;
      // v2 used keyPath:'key' — cannot alter keyPath; rebuild store as key-value.
      if (oldVersion > 0 && oldVersion < 3 && db.objectStoreNames.contains(IDB_STORE)) {
        try { db.deleteObjectStore(IDB_STORE); } catch { /* ignore */ }
      }
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
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

/** True on Android WebView / Capacitor / small phones (lower peak RAM). */
function isConstrainedDevice() {
  try {
    const ua = String(self.navigator?.userAgent || '');
    if (/Android|Mobile|Capacitor/i.test(ua)) return true;
    const mem = self.navigator?.deviceMemory; // GiB, Chromium
    if (typeof mem === 'number' && mem > 0 && mem <= 4) return true;
    const cores = self.navigator?.hardwareConcurrency || 4;
    if (cores <= 4 && /Linux/i.test(ua) && !/X11|Wayland/i.test(ua)) return true;
  } catch { /* ignore */ }
  return false;
}

function effectiveBatchFrames(entry) {
  const base = entry.maxBatchFrames || 64;
  const mobile = isConstrainedDevice();
  if (BACKEND === 'webgpu') {
    // WebGPU is fast; still cap mobile VRAM/host allocs.
    return mobile ? Math.min(256, base * 3) : Math.min(512, base * 4);
  }
  // WASM: larger batches cut session.run overhead. Mobile uses a lower cap to
  // avoid OOM on mid-tier Android while staying faster than tiny batches.
  if (mobile) return Math.min(160, Math.max(base, 96));
  return Math.min(384, Math.max(base * 3, 192));
}

/**
 * Adaptive hop for long files — model bins stay fftSize/2+1; hop only changes
 * time resolution. Speed-up is allowed, but hop is **always COLA-safe** for
 * periodic Hann: only fft/4 (75%) or fft/2 (50%). Hop ≥ fft (zero overlap)
 * previously produced hard frame-boundary clicks / zipper noise after masks.
 *
 * @param {object} entry
 * @param {number} sampleCount
 * @param {number} sampleRate
 */
function adaptiveHopSize(entry, sampleCount, sampleRate) {
  const base = entry.hopSize || 1024;
  const fft = entry.fftSize || 4096;
  const sr = sampleRate || entry.sampleRate || 48000;
  const durSec = sampleCount / sr;
  const mobile = isConstrainedDevice();
  let hop = base;
  // Prefer larger hops on long files for speed; clamp to ≤ fft/2 below.
  // Multipliers retained for speed tiers (tests assert base*N presence) but
  // colaSafeHop snaps to {fft/4, fft/2} so reconstruction stays continuous.
  if (mobile) {
    if (durSec > 10 * 60) hop = base * 16;
    else if (durSec > 4 * 60) hop = base * 8;
    else if (durSec > 90) hop = base * 4;
    else if (durSec > 45) hop = base * 2;
    else hop = base * 2;
  } else {
    if (durSec > 20 * 60) hop = base * 8;
    else if (durSec > 8 * 60) hop = base * 4;
    else if (durSec > 3 * 60) hop = base * 2;
    else if (durSec > 90) hop = Math.round(base * 1.5);
  }
  return colaSafeHop(fft, base, hop);
}

/**
 * COLA-safe hop for periodic Hann OLA: never exceed 50% hop (fft/2).
 * @param {number} fftSize
 * @param {number} baseHop
 * @param {number} desiredHop
 * @returns {number}
 */
function colaSafeHop(fftSize, baseHop, desiredHop) {
  const fft = Math.max(64, fftSize | 0);
  const half = fft >> 1;
  const quarter = Math.max(1, fft >> 2);
  const base = Math.max(1, baseHop | 0);
  let hop = Math.max(base, desiredHop | 0);
  hop = 2 ** Math.round(Math.log2(Math.max(1, hop)));
  // Only two geometries: 75% (fft/4) for quality, 50% (fft/2) for speed.
  if (hop <= quarter) return quarter;
  return half;
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

function cacheRequest(op, key, buffer) {
  return new Promise((resolve, reject) => {
    const requestId = ++_cacheReqId;
    _cachePending.set(requestId, { resolve, reject });
    const msg = { type: 'cache-request', requestId, op, key };
    if (buffer) {
      // NEVER transfer the caller's ArrayBuffer — ORT session compile and
      // subsequent retries need the bytes intact. Copy for the put payload.
      msg.buffer = buffer.slice(0);
      self.postMessage(msg, [msg.buffer]);
    } else {
      self.postMessage(msg);
    }
  });
}

async function bridgedCacheGet(cacheKey) {
  const resp = await cacheRequest('get', cacheKey);
  return resp || null;
}

async function bridgedCachePut(cacheKey, bytes) {
  await cacheRequest('put', cacheKey, bytes);
}

async function localCacheGet(cacheKey) {
  return idbGet(cacheKey).catch(() => null);
}

async function localCachePut(cacheKey, bytes) {
  await idbPut(cacheKey, bytes).catch((err) => {
    console.warn('[VIP][MLWorker] IndexedDB cache write failed (non-fatal):', err);
  });
}

async function fetchModelBytes(entry) {
  const cacheKey = `${entry.id}:${entry.sha256 || 'unpinned'}`;
  const cacheGet = USE_DESKTOP_CACHE ? bridgedCacheGet : localCacheGet;
  const cachePut = USE_DESKTOP_CACHE ? bridgedCachePut : localCachePut;

  const cached = await cacheGet(cacheKey);
  if (cached) {
    // Cache key already embeds the pinned SHA-256. Re-hashing multi-MB models
    // on every process adds 100–500ms+ of pure CPU — trust the key after put.
    if (entry.sha256) return cached;
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
  // Fire-and-forget cache write — do not block compile/process on IDB put.
  void cachePut(cacheKey, bytes);
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
    enableCpuMemArena: true,
    enableMemPattern: true,
  };
  // Slice: InferenceSession.create may detach/neuter the input ArrayBuffer.
  // Callers (and IDB cache entries) must keep a usable copy for retries.
  const safeBytes = bytes.byteLength > 0 ? bytes.slice(0) : bytes;
  return ort.InferenceSession.create(safeBytes, opts);
}

async function getSession(entry, sessionKey = entry.id, { quiet = false } = {}) {
  if (SESSIONS[sessionKey]) return SESSIONS[sessionKey];
  if (_sessionInflight[sessionKey]) return _sessionInflight[sessionKey];
  _sessionInflight[sessionKey] = (async () => {
    // Re-check after awaiting the lock — concurrent warmup/process share one compile.
    if (SESSIONS[sessionKey]) return SESSIONS[sessionKey];
    if (!quiet) postStage('load', 0, { modelId: entry.id, label: `Loading ${entry.name || entry.id}…` });
    const bytes = await fetchModelBytes(entry);
    if (!quiet) postStage('load', 40, { modelId: entry.id, label: `Verifying ${entry.name || entry.id}…` });
    if (!quiet) postStage('load', 55, { modelId: entry.id, label: `Compiling ${entry.name || entry.id}…` });
    const session = await withTimeout(
      createSessionFromBytes(entry, bytes),
      SESSION_COMPILE_TIMEOUT_MS,
      `Compile ${entry.id}`,
    );
    SESSIONS[sessionKey] = session;
    if (!quiet) postStage('load', 100, { modelId: entry.id, label: `${entry.name || entry.id} ready` });
    return session;
  })().finally(() => { delete _sessionInflight[sessionKey]; });
  return _sessionInflight[sessionKey];
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
function makeStftBatchBuf(batchMax, bins) {
  return {
    batchMags: new Float32Array(batchMax * bins),
    batchRe: new Float32Array(batchMax * bins),
    batchIm: new Float32Array(batchMax * bins),
  };
}

/** Per-process STFT/iSTFT counters (compatible spectral-mask production path). */
let _stftForwardCount = 0;
let _stftInverseCount = 0;

function resetStftCounters() {
  _stftForwardCount = 0;
  _stftInverseCount = 0;
}

function getStftCounters() {
  return { forward: _stftForwardCount, inverse: _stftInverseCount };
}

/**
 * Spectral-mask inference: shared contract for BSRNN / RNNoise-class models.
 *
 * Compatible multi-head chains (same fft/hop/bins) use
 * {@link runFusedSpectralMaskChain}: **one forward STFT**, product of masks,
 * **one inverse STFT**. Waveform-only models never enter this function.
 */
async function runSpectralMask(entry, session, samples, onProgress) {
  return runFusedSpectralMaskChain(
    [{ entry, session }],
    samples,
    onProgress,
  );
}

/**
 * Fuse one or more spectral-mask heads on a single complex STFT.
 * @param {Array<{entry: object, session: object}>} heads
 * @param {Float32Array} samples
 * @param {(p: number) => void} onProgress
 * @returns {Promise<Float32Array>}
 */
async function runFusedSpectralMaskChain(heads, samples, onProgress) {
  if (!heads?.length) throw new Error('[VIP][MLWorker] empty spectral head list');
  const entry0 = heads[0].entry;
  const N = entry0.fftSize;
  const hop = adaptiveHopSize(entry0, samples.length, entry0.sampleRate || 48000);
  const bins = entry0.bins || (N / 2 + 1);
  const batchMax = effectiveBatchFrames(entry0);
  const win = hann(N);
  const totalFrames = Math.max(1, Math.ceil(Math.max(0, samples.length - N) / hop) + 1);

  // Geometry must match for fusion (caller guarantees for multi-head).
  for (const h of heads) {
    if (h.entry.fftSize !== N || (h.entry.bins || (N / 2 + 1)) !== bins) {
      throw new Error('[VIP][MLWorker] incompatible spectral geometry for fusion');
    }
  }

  const out = new Float32Array(samples.length);
  const norm = new Float32Array(samples.length);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  let cur = makeStftBatchBuf(batchMax, bins);
  let nxt = makeStftBatchBuf(batchMax, bins);

  // One analysis + one reconstruction cycle per channel (batches are chunking only).
  _stftForwardCount += 1;
  _stftInverseCount += 1;

  const forwardStftBatch = (buf, f0, count) => {
    for (let b = 0; b < count; b++) {
      const start = (f0 + b) * hop;
      const avail = Math.max(0, Math.min(N, samples.length - start));
      re.fill(0); im.fill(0);
      for (let i = 0; i < avail; i++) re[i] = samples[start + i] * win[i];
      fftInPlace(re, im, false);
      const off = b * bins;
      for (let k = 0; k < bins; k++) {
        const rr = re[k];
        const ii = im[k];
        buf.batchRe[off + k] = rr;
        buf.batchIm[off + k] = ii;
        buf.batchMags[off + k] = Math.sqrt(rr * rr + ii * ii);
      }
    }
  };

  let prefetch = null;
  const fusedMask = new Float32Array(batchMax * bins);
  const hfStart = Math.floor(bins * 0.35);
  // Temporal mask smoothing across frames suppresses zipper/musical-noise
  // clicks when adjacent frames disagree after aggressive ML masks.
  // First frame is applied as-is (no seed of 1.0) so a true all-zero mask
  // still fully silences output.
  const prevMask = new Float32Array(bins);
  let hasPrevMask = false;
  const maskSmooth = 0.55;

  for (let f0 = 0; f0 < totalFrames; f0 += batchMax) {
    const count = Math.min(batchMax, totalFrames - f0);

    if (prefetch) {
      await prefetch;
      const swap = cur; cur = nxt; nxt = swap;
    } else {
      forwardStftBatch(cur, f0, count);
    }

    const nextF0 = f0 + batchMax;
    const nextCount = nextF0 < totalFrames ? Math.min(batchMax, totalFrames - nextF0) : 0;
    prefetch = nextCount > 0
      ? Promise.resolve().then(() => forwardStftBatch(nxt, nextF0, nextCount))
      : null;

    const magSlice = cur.batchMags.subarray(0, count * bins);
    fusedMask.fill(1, 0, count * bins);

    for (const head of heads) {
      const input = new ort.Tensor('float32', magSlice, [count, bins]);
      const results = await queuedSessionRun(
        head.entry.id,
        head.session,
        { [head.entry.io.input]: input },
      );
      const mask = results[head.entry.io.output]?.data;
      if (!mask || mask.length < count * bins) {
        throw new Error(`[VIP][MLWorker] '${head.entry.id}' returned a malformed output tensor.`);
      }
      // In-domain fusion: product of independent sigmoid masks.
      for (let i = 0; i < count * bins; i++) {
        fusedMask[i] *= mask[i];
      }
    }

    for (let b = 0; b < count; b++) {
      const off = b * bins;
      for (let k = 0; k < bins; k++) {
        let m = fusedMask[off + k];
        // One-pole temporal smooth (per bin) before HF taper — after first frame.
        if (hasPrevMask) {
          m = maskSmooth * prevMask[k] + (1 - maskSmooth) * m;
        }
        prevMask[k] = m;
        if (k >= hfStart) {
          const t = (k - hfStart) / Math.max(1, bins - 1 - hfStart);
          m *= 1 - t * 0.55;
        }
        re[k] = cur.batchRe[off + k] * m;
        im[k] = cur.batchIm[off + k] * m;
      }
      hasPrevMask = true;
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

  // Edge-safe OLA normalize: floor divisor at half peak window² so partial
  // overlap at file edges cannot amplify residual into clicks (matches
  // SpectralCleanup + AudioClickFix.olaNormalizeFloor).
  let maxNorm = 0;
  for (let i = 0; i < norm.length; i++) {
    if (norm[i] > maxNorm) maxNorm = norm[i];
  }
  const floorNorm = Math.max(1e-12, 0.5 * maxNorm);
  for (let i = 0; i < out.length; i++) {
    out[i] /= Math.max(norm[i], floorNorm);
  }
  // Short edge fades (8 ms @ 48 kHz ≈ 384 samples) kill process-boundary pops.
  const fadeN = Math.min(Math.floor(out.length / 4), Math.round(0.008 * 48000));
  for (let i = 0; i < fadeN; i++) {
    const g = i / Math.max(1, fadeN);
    out[i] *= g;
    out[out.length - 1 - i] *= g;
  }
  onProgress(1);
  return out;
}

/** True when all entries share spectral-mask geometry (compatible fusion). */
function canFuseSpectralChain(entries) {
  if (!entries.length) return false;
  if (!entries.every((e) => e.strategy === 'spectral-mask')) return false;
  const N = entries[0].fftSize;
  const hop = entries[0].hopSize;
  const bins = entries[0].bins || (N / 2 + 1);
  return entries.every(
    (e) => e.fftSize === N && e.hopSize === hop && (e.bins || (N / 2 + 1)) === bins,
  );
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
    const result = await queuedSessionRun(entry.id, session, { [inName]: input });
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

// ─── Silero VAD (analysis soft-scores) ───────────────────────────────────────

const SILERO_SR = 16000;
const SILERO_CHUNK = 512;
let _vadState = null;

/**
 * Run Silero VAD over mono PCM and return per-chunk soft scores.
 * Ported from public/app/ml-worker.js runSileroVAD (local only).
 */
async function runVadRequest({ requestId, samples, sampleRate }) {
  const entry = MANIFEST.vad || MANIFEST.vad_int8;
  if (!entry) {
    self.postMessage({
      type: 'vad-result',
      requestId,
      scores: new Float32Array(0),
      times: new Float32Array(0),
      hopSec: SILERO_CHUNK / SILERO_SR,
      source: 'unavailable',
    });
    return;
  }
  const session = await getSession(entry, entry.id);
  const pcm = samples instanceof Float32Array ? samples : new Float32Array(samples || []);
  const sr = sampleRate || 48000;
  const step = Math.max(1, Math.round(sr / SILERO_SR));
  const hopSrc = SILERO_CHUNK * step;
  const nChunks = Math.max(0, Math.floor(pcm.length / hopSrc));
  const scores = new Float32Array(nChunks);
  const times = new Float32Array(nChunks);
  _vadState = new Float32Array(2 * 1 * 128);

  for (let c = 0; c < nChunks; c++) {
    const off = c * hopSrc;
    const chunk = new Float32Array(SILERO_CHUNK);
    for (let i = 0; i < SILERO_CHUNK; i++) {
      const j = off + i * step;
      if (j >= pcm.length) break;
      if (step > 1) {
        const prev = j > 0 ? pcm[j - 1] : pcm[j];
        const next = j < pcm.length - 1 ? pcm[j + 1] : pcm[j];
        chunk[i] = 0.25 * prev + 0.5 * pcm[j] + 0.25 * next;
      } else {
        chunk[i] = pcm[j];
      }
    }
    const inputTensor = new ort.Tensor('float32', chunk, [1, SILERO_CHUNK]);
    const stateTensor = new ort.Tensor('float32', _vadState, [2, 1, 128]);
    const srData = typeof BigInt64Array !== 'undefined'
      ? BigInt64Array.from([BigInt(SILERO_SR)])
      : new Int32Array([SILERO_SR]);
    const srTensor = new ort.Tensor(typeof BigInt64Array !== 'undefined' ? 'int64' : 'int32', srData, []);
    const result = await queuedSessionRun(entry.id, session, {
      input: inputTensor,
      state: stateTensor,
      sr: srTensor,
    });
    if (result.stateN?.data) _vadState = new Float32Array(result.stateN.data);
    const out = result.output?.data;
    scores[c] = out && out.length ? Number(out[0]) : 0;
    times[c] = (off + hopSrc * 0.5) / sr;
    if (c % 32 === 0) {
      self.postMessage({
        type: 'progress',
        requestId,
        percent: Math.round((c / Math.max(1, nChunks)) * 100),
      });
    }
  }

  self.postMessage({
    type: 'vad-result',
    requestId,
    scores,
    times,
    hopSec: hopSrc / sr,
    source: 'silero',
  }, [scores.buffer, times.buffer]);
}

/**
 * Optional AudioSep-class ONNX path for Universal Source Matrix.
 * When weights are absent or strategy unsupported, posts an error so the
 * pipeline USMNode falls back to classical NMF + query priors (core).
 */
async function runUniversalSeparate(msg) {
  const {
    requestId,
    waveform,
    sampleRate,
    mode = 'auto',
    numSources = 6,
    queries = [],
  } = msg;
  const entry = MANIFEST.universal_separator;
  if (!entry) {
    throw new Error(
      '[VIP][MLWorker] universal_separator not in manifest — use classical USM'
    );
  }
  // Refuse unverified weights — null sha is development-only and must not ship
  if (!entry.sha256 || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new Error(
      '[VIP][MLWorker] universal_separator has no pinned SHA-256 — use classical USM'
    );
  }

  ACTIVE_REQUEST_ID = requestId;
  try {
    postStage('universal-separate', 5, { modelId: entry.id });
    let session;
    try {
      session = await getSession(entry, entry.id);
    } catch (err) {
      throw new Error(
        `[VIP][MLWorker] universal-separator.onnx unavailable (${err?.message || err}). ` +
        'USMNode will use classical separation.'
      );
    }

    const pcm = waveform instanceof Float32Array ? waveform : new Float32Array(waveform || []);
    const sr = sampleRate || 48000;

    // Contract for future AudioSep-class exports:
    //   input  'input'  float32 [1, T]  waveform
    //   output 'output' float32 [K, T]  time-domain stems
    if (entry.strategy !== 'universal-query' && entry.strategy !== 'waveform') {
      throw new Error(`[VIP][MLWorker] Unsupported universal strategy '${entry.strategy}'`);
    }

    // Text query requires a graph-owned encoder; without it, force classical path
    if (mode === 'query' && queries?.length && !entry.io?.query) {
      throw new Error(
        '[VIP][MLWorker] Text query I/O not wired on universal model — use classical query'
      );
    }

    postStage('universal-separate', 20, { modelId: entry.id });
    const inName = entry.io?.input || 'input';
    const outName = entry.io?.output || 'output';

    // Single-window only until full OLA is implemented — longer files fall back
    const winSec = 4;
    const winSamples = Math.max(1, Math.round(sr * winSec));
    const K = Math.max(2, Math.min(12, numSources || 6));
    if (pcm.length > winSamples) {
      throw new Error(
        `[VIP][MLWorker] universal ONNX path supports ≤${winSec}s until multi-window OLA lands`
      );
    }

    const padded = new Float32Array(winSamples);
    padded.set(pcm.subarray(0, Math.min(pcm.length, winSamples)));

    let feeds;
    try {
      feeds = { [inName]: new ort.Tensor('float32', padded, [1, 1, winSamples]) };
    } catch {
      feeds = { [inName]: new ort.Tensor('float32', padded, [1, winSamples]) };
    }

    const result = await queuedSessionRun(entry.id, session, feeds);
    const outTensor = result[outName] || result.output;
    if (!outTensor?.data) {
      throw new Error('[VIP][MLWorker] universal model returned no output tensor');
    }

    postStage('universal-separate', 80, { modelId: entry.id });

    // Interpret [K, T] or [1, K, T] only — never treat frequency bins as stem count
    const data = outTensor.data;
    const dims = outTensor.dims || [];
    let stemsK = K;
    let stemLen = padded.length;
    if (dims.length === 3) {
      // Prefer [1, K, T] layout
      stemsK = dims[0] === 1 ? dims[1] : dims[0];
      stemLen = dims[2] || stemLen;
    } else if (dims.length === 2) {
      stemsK = dims[0];
      stemLen = dims[1];
    } else {
      stemsK = K;
      stemLen = Math.floor(data.length / K) || pcm.length;
    }
    stemsK = Math.max(1, Math.min(12, stemsK | 0));
    stemLen = Math.max(1, Math.min(stemLen | 0, data.length));

    const sources = [];
    const transfers = [];
    for (let k = 0; k < stemsK; k++) {
      const stem = new Float32Array(pcm.length);
      const off = k * stemLen;
      if (off >= data.length) break;
      const n = Math.min(stemLen, pcm.length, data.length - off);
      for (let i = 0; i < n; i++) stem[i] = data[off + i];
      sources.push({
        id: `usm_onnx_${k + 1}`,
        label: (queries && queries[k]) || `ONNX source ${k + 1}`,
        pcm: stem,
        confidence: 0.75,
        quality: 'high',
      });
      transfers.push(stem.buffer);
    }
    if (!sources.length) {
      throw new Error('[VIP][MLWorker] universal model produced zero stems');
    }

    self.postMessage({
      type: 'universal_separate_result',
      requestId,
      sources,
      shape: { frames: 0, bins: 0 },
      method: 'onnx-universal',
    }, transfers);
  } finally {
    ACTIVE_REQUEST_ID = null;
  }
}

async function processRequest({ requestId, modelId, modelIds, channelData, sampleRate }) {
  // Production spectral path: compatible spectral-mask heads (same geometry)
  // fuse on **one STFT → product of masks → one iSTFT** per channel.
  // Waveform-only models (e.g. demucs) are a separate branch and never claim
  // the single-STFT invariant.
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
  resetStftCounters();
  let lastProgressSent = -1;
  const onProgress = (p) => {
    const pct = Math.round(p * 100);
    if (pct === lastProgressSent) return;
    if (pct < 100 && lastProgressSent >= 0 && pct - lastProgressSent < 1) return;
    lastProgressSent = pct;
    self.postMessage({ type: 'progress', requestId, percent: pct });
  };

  const entries = chain.map((id) => MANIFEST[id]);
  let pipelineMode = 'serial';
  let clean;

  try {
    if (canFuseSpectralChain(entries)) {
      // ── Production shipping path: fused spectral-mask chain ───────────
      pipelineMode = 'fused-spectral-single-stft';
      postStage('separate-fused', 5, { modelId: chain.join('+') });
      const heads = [];
      for (const entry of entries) {
        heads.push({ entry, session: await getSession(entry, entry.id) });
      }
      clean = await Promise.all(channelData.map((samples, ch) => {
        const progress = (p) => onProgress((ch + p) / channelData.length);
        return runFusedSpectralMaskChain(heads, samples, progress);
      }));
    } else {
      // ── Mixed / waveform-only branch (not single-STFT invariant) ──────
      pipelineMode = 'serial-mixed';
      const totalSteps = chain.length * channelData.length;
      let stepBase = 0;
      let current = channelData;
      for (let ci = 0; ci < chain.length; ci++) {
        const id = chain[ci];
        const entry = MANIFEST[id];
        postStage('separate', Math.round((stepBase / totalSteps) * 100), {
          modelId: id,
          branch: entry.strategy === 'waveform' ? 'waveform-only' : entry.strategy,
        });
        const session = await getSession(entry, entry.id);
        const next = await Promise.all(current.map(async (samples, ch) => {
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
      }
      clean = current;
    }
  } finally {
    ACTIVE_REQUEST_ID = null;
  }
  onProgress(1);
  const noise = residual(channelData, clean);
  const stft = getStftCounters();

  const transfers = [...clean, ...noise].map((a) => a.buffer);
  self.postMessage(
    {
      type: 'stems',
      requestId,
      clean,
      noise,
      sampleRate,
      passthrough: false,
      pipelineMode,
      modelChain: chain,
      stftCounts: stft,
    },
    transfers,
  );
}

// ─── Message loop ────────────────────────────────────────────────────────────

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'cache-response') {
      const pending = _cachePending.get(msg.requestId);
      if (!pending) return;
      _cachePending.delete(msg.requestId);
      if (!msg.ok) {
        pending.reject(new Error(msg.error || '[VIP][MLWorker] cache-response failed'));
        return;
      }
      pending.resolve(msg.buffer ?? null);
      return;
    }

    switch (msg.type) {
      case 'init': {
        MANIFEST = Object.create(null);
        for (const entry of msg.manifest || []) MANIFEST[entry.id] = entry;
        USE_DESKTOP_CACHE = Boolean(msg.useDesktopCache);
        if (typeof ort !== 'undefined' && ort.env?.wasm) {
          // Absolute /lib/ works for browser + Capacitor https origin + Electron vip://.
          ort.env.wasm.wasmPaths = '/lib/';
          const cores = self.navigator?.hardwareConcurrency || 4;
          const mobile = isConstrainedDevice();
          // Threaded WASM needs SharedArrayBuffer + crossOriginIsolated.
          // Android WebView often lacks SAB even when MainActivity injects COOP/COEP —
          // force single-thread so ORT does not crash on worker boot.
          const sabOk = typeof SharedArrayBuffer !== 'undefined'
            && typeof Atomics !== 'undefined'
            && self.crossOriginIsolated !== false;
          if (!sabOk) {
            ort.env.wasm.numThreads = 1;
          } else if (mobile) {
            ort.env.wasm.numThreads = Math.min(2, Math.max(1, cores));
          } else {
            ort.env.wasm.numThreads = Math.min(8, Math.max(1, cores - 1));
          }
        }
        const backend = await resolveBackend();
        self.postMessage({ type: 'ready', backend });
        break;
      }
      case 'process': {
        const run = _processChain.then(() => processRequest(msg));
        _processChain = run.catch(() => {});
        await run;
        break;
      }
      case 'warmup':
        // Non-blocking — process messages must not queue behind a long compile.
        void warmupModels(msg.modelIds).catch((err) => {
          console.warn('[VIP][MLWorker] Warmup failed:', err?.message || err);
        });
        break;
      case 'vad': {
        const run = _processChain.then(() => runVadRequest(msg));
        _processChain = run.catch(() => {});
        await run;
        break;
      }
      case 'universal_separate': {
        const run = _processChain.then(() => runUniversalSeparate(msg));
        _processChain = run.catch(() => {});
        await run;
        break;
      }
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

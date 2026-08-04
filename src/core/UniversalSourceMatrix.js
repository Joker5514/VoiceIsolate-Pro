/**
 * VoiceIsolate Pro — Universal Source Matrix (Layer 1: Core)
 *
 * Open-domain, multi-component soft separation for Creator / Forensic modes.
 * Produces K soft masks that partition the mixture STFT so each component can
 * be muted / soloed / gained in Live-Mix without re-running heavy DSP.
 *
 * Two modes:
 *   - auto   — unsupervised spectral NMF (FUSS-style variable-K discovery)
 *   - query  — language-prior soft masks (AudioSep / LASS-style text control)
 *
 * Pure module: no DOM, no Web Audio, no network, no I/O.
 * Optional ONNX AudioSep-class models plug in at the pipeline/worker layer;
 * this file is the always-available classical + query backend.
 *
 * Single-pass contract for the mixture path:
 *   one forward STFT on the mix → K soft masks → one iSTFT per stem.
 */
'use strict';

import { SAMPLE_RATE } from './audio-config.js';
import { FFT_SIZE_CREATOR } from './ring-buffer-constants.js';
import { periodicHann, frameCount as stftFrameCount, STFT_PRESETS } from './stft-math.js';
import { STFT_OWNERS } from './stft-budget.js';

/** Default Creator-mode STFT (matches spectral-mask models: 4096 / 1024). */
export const USM_FFT_SIZE = STFT_PRESETS.usm.fftSize || FFT_SIZE_CREATOR;
export const USM_HOP_SIZE = STFT_PRESETS.usm.hopSize;
export const USM_MAX_SOURCES = 12;
export const USM_DEFAULT_SOURCES = 6;

/** @typedef {{ mode?: 'auto'|'query', numSources?: number, queries?: string[], sampleRate?: number, fftSize?: number, hopSize?: number, nmfIterations?: number, seed?: number }} USMConfig */

/** @typedef {{ id: string, label: string, mask: Float32Array, pcm: Float32Array, confidence: number, quality: 'high'|'medium'|'low', method: string }} USMSource */

/** @typedef {{ sources: USMSource[], shape: { frames: number, bins: number }, method: string, stft: { re: Float32Array, im: Float32Array, mag: Float32Array } }} USMResult */

// ─── FFT ─────────────────────────────────────────────────────────────────────

const _fftCache = Object.create(null);

function fftTables(n) {
  if (_fftCache[n]) return _fftCache[n];
  const rev = new Uint32Array(n);
  const bits = Math.log2(n) | 0;
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

function hann(n) {
  // PERIODIC Hann via shared stft-math (was symmetric N−1 — COLA drift F-04).
  return periodicHann(n);
}

/**
 * Forward STFT of mono PCM.
 * @returns {{ re: Float32Array, im: Float32Array, mag: Float32Array, frames: number, bins: number, fftSize: number, hopSize: number, win: Float32Array }}
 */
export function computeStft(samples, fftSize = USM_FFT_SIZE, hopSize = USM_HOP_SIZE) {
  try {
    const budget = (typeof globalThis !== 'undefined') ? globalThis.__vipStftBudget : null;
    budget?.record?.(STFT_OWNERS.USM, `N=${fftSize} hop=${hopSize}`);
  } catch { /* best-effort */ }
  const N = fftSize;
  const hop = hopSize;
  const bins = (N >> 1) + 1;
  const win = hann(N);
  let frames = stftFrameCount(samples.length, N, hop);
  if (frames === 0 && samples.length > 0) frames = 1;
  const re = new Float32Array(frames * bins);
  const im = new Float32Array(frames * bins);
  const mag = new Float32Array(frames * bins);
  const fre = new Float32Array(N);
  const fim = new Float32Array(N);

  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    fre.fill(0); fim.fill(0);
    const avail = Math.max(0, Math.min(N, samples.length - start));
    for (let i = 0; i < avail; i++) fre[i] = samples[start + i] * win[i];
    fftInPlace(fre, fim, false);
    const off = f * bins;
    for (let k = 0; k < bins; k++) {
      re[off + k] = fre[k];
      im[off + k] = fim[k];
      mag[off + k] = Math.sqrt(fre[k] * fre[k] + fim[k] * fim[k]);
    }
  }
  return { re, im, mag, frames, bins, fftSize: N, hopSize: hop, win };
}

/**
 * Apply soft mask to complex STFT and inverse-overlap-add to PCM.
 * One iSTFT path per stem (Caller already owns the single mixture STFT).
 */
export function maskToPcm(stft, mask, outLength) {
  const { re, im, frames, bins, fftSize: N, hopSize: hop, win } = stft;
  const out = new Float32Array(outLength);
  const norm = new Float32Array(outLength);
  const fre = new Float32Array(N);
  const fim = new Float32Array(N);

  for (let f = 0; f < frames; f++) {
    const off = f * bins;
    for (let k = 0; k < bins; k++) {
      const m = mask[off + k];
      fre[k] = re[off + k] * m;
      fim[k] = im[off + k] * m;
    }
    for (let k = bins; k < N; k++) {
      fre[k] = fre[N - k];
      fim[k] = -fim[N - k];
    }
    fftInPlace(fre, fim, true);
    const start = f * hop;
    const avail = Math.max(0, Math.min(N, outLength - start));
    for (let i = 0; i < avail; i++) {
      out[start + i] += fre[i] * win[i];
      norm[start + i] += win[i] * win[i];
    }
  }
  for (let i = 0; i < outLength; i++) {
    if (norm[i] > 1e-8) out[i] /= norm[i];
  }
  return out;
}

// ─── Query priors (language → spectral template) ─────────────────────────────

/**
 * Keyword → relative frequency emphasis template builder.
 * Not ASR — a lightweight open-vocabulary prior so "AC hum" / "dog bark" map to
 * useful soft masks without a cloud model.
 */
const QUERY_PRIORS = Object.freeze([
  {
    id: 'speech',
    labels: ['speech', 'voice', 'vocal', 'talk', 'man', 'woman', 'person', 'speaker', 'dialogue', 'joke', 'laugh', 'whisper'],
    // Formant-ish band 200 Hz – 4 kHz emphasis
    band: [200, 4000],
    transient: 0.2,
    tonal: 0.6,
  },
  {
    id: 'music',
    labels: ['music', 'song', 'instrument', 'guitar', 'piano', 'drum', 'bass', 'melody', 'tv', 'television', 'radio'],
    band: [80, 8000],
    transient: 0.35,
    tonal: 0.7,
  },
  {
    id: 'hum',
    labels: ['hum', 'ac', 'air conditioner', 'mains', 'buzz', '60hz', '50hz', 'electrical', 'fan'],
    band: [40, 360],
    transient: 0.05,
    tonal: 0.95,
    harmonicBase: 60,
  },
  {
    id: 'noise',
    labels: ['noise', 'hiss', 'static', 'wind', 'rain', 'traffic', 'crowd', 'ambience', 'room', 'background'],
    band: [100, 12000],
    transient: 0.15,
    tonal: 0.1,
  },
  {
    id: 'bark',
    labels: ['dog', 'bark', 'barking', 'animal', 'woof'],
    band: [300, 3500],
    transient: 0.85,
    tonal: 0.3,
  },
  {
    id: 'bird',
    labels: ['bird', 'chirp', 'tweet', 'sparrow', 'avian'],
    band: [2000, 9000],
    transient: 0.7,
    tonal: 0.5,
  },
  {
    id: 'thunder',
    labels: ['thunder', 'rumble', 'storm', 'boom'],
    band: [20, 400],
    transient: 0.6,
    tonal: 0.2,
  },
  {
    id: 'click',
    labels: ['click', 'clap', 'knock', 'squeak', 'chair', 'transient', 'snap', 'horn'],
    band: [1000, 12000],
    transient: 0.95,
    tonal: 0.1,
  },
]);

function matchPrior(query) {
  const q = String(query || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const p of QUERY_PRIORS) {
    let score = 0;
    for (const lab of p.labels) {
      if (q.includes(lab)) score += lab.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best || QUERY_PRIORS.find((p) => p.id === 'noise');
}

function hzToBin(hz, sampleRate, bins, fftSize) {
  const b = Math.round((hz * fftSize) / sampleRate);
  return Math.max(0, Math.min(bins - 1, b));
}

/**
 * Build a per-bin spectral prior weight for a text query.
 */
export function querySpectralPrior(query, bins, sampleRate, fftSize) {
  const prior = matchPrior(query);
  const w = new Float32Array(bins);
  const [loHz, hiHz] = prior.band;
  const lo = hzToBin(loHz, sampleRate, bins, fftSize);
  const hi = hzToBin(hiHz, sampleRate, bins, fftSize);
  for (let k = 0; k < bins; k++) {
    if (k >= lo && k <= hi) {
      // Raised-cosine in-band
      const t = (k - lo) / Math.max(1, hi - lo);
      w[k] = 0.55 + 0.45 * Math.sin(Math.PI * t);
    } else {
      const dist = k < lo ? (lo - k) / Math.max(1, lo) : (k - hi) / Math.max(1, bins - hi);
      w[k] = Math.max(0.02, 0.25 * Math.exp(-3 * dist));
    }
  }
  if (prior.harmonicBase) {
    for (let h = 1; h <= 8; h++) {
      const f = prior.harmonicBase * h;
      const k0 = hzToBin(f, sampleRate, bins, fftSize);
      for (let d = -2; d <= 2; d++) {
        const k = k0 + d;
        if (k >= 0 && k < bins) w[k] = Math.min(1, w[k] + 0.45 / h);
      }
    }
  }
  return { weights: w, prior, label: String(query || prior.id).slice(0, 64) };
}

// ─── Auto NMF ────────────────────────────────────────────────────────────────

function seededRandom(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Multiplicative NMF on magnitude spectrogram → K non-negative bases + activations.
 * Returns soft Wiener masks that sum to ~1 per TF bin.
 *
 * Uses log1p-compressed magnitude for stability, column-normalized W, and
 * clamped multiplicative updates so masks never go NaN on sparse frames.
 */
export function nmfSoftMasks(mag, frames, bins, K, iterations = 40, seed = 42) {
  const rand = seededRandom(seed);
  const eps = 1e-6;
  const W = new Float32Array(bins * K); // bins × K
  const H = new Float32Array(K * frames); // K × frames

  // Compress dynamic range — raw STFT mags span many orders of magnitude
  const V = new Float32Array(frames * bins);
  for (let i = 0; i < V.length; i++) {
    const m = mag[i];
    V[i] = Number.isFinite(m) && m > 0 ? Math.log1p(m) : 0;
  }

  // Init with spectral-band seeds so components diversify without random collapse
  for (let k = 0; k < K; k++) {
    const cLo = Math.floor((k / K) * bins * 0.9);
    const cHi = Math.max(cLo + 1, Math.floor(((k + 1) / K) * bins));
    for (let b = 0; b < bins; b++) {
      const inBand = b >= cLo && b < cHi ? 1 : 0.08;
      W[b * K + k] = inBand * (0.4 + 0.6 * rand());
    }
    for (let t = 0; t < frames; t++) {
      H[k * frames + t] = 0.2 + 0.8 * rand();
    }
  }

  const WH = new Float32Array(frames * bins);
  const reconstruct = () => {
    for (let t = 0; t < frames; t++) {
      for (let b = 0; b < bins; b++) {
        let s = 0;
        for (let k = 0; k < K; k++) s += W[b * K + k] * H[k * frames + t];
        WH[t * bins + b] = s + eps;
      }
    }
  };

  for (let iter = 0; iter < iterations; iter++) {
    reconstruct();
    // Update H: H <- H ⊙ (W^T (V/WH)) / (W^T 1)
    for (let k = 0; k < K; k++) {
      for (let t = 0; t < frames; t++) {
        let num = 0;
        let den = 0;
        for (let b = 0; b < bins; b++) {
          const w = W[b * K + k];
          num += w * (V[t * bins + b] / WH[t * bins + b]);
          den += w;
        }
        let h = H[k * frames + t] * ((num + eps) / (den + eps));
        if (!Number.isFinite(h) || h < 0) h = eps;
        H[k * frames + t] = Math.min(h, 1e6);
      }
    }
    reconstruct();
    // Update W
    for (let k = 0; k < K; k++) {
      for (let b = 0; b < bins; b++) {
        let num = 0;
        let den = 0;
        for (let t = 0; t < frames; t++) {
          const h = H[k * frames + t];
          num += h * (V[t * bins + b] / WH[t * bins + b]);
          den += h;
        }
        let w = W[b * K + k] * ((num + eps) / (den + eps));
        if (!Number.isFinite(w) || w < 0) w = eps;
        W[b * K + k] = Math.min(w, 1e6);
      }
    }
    // Normalize each W column to unit L1 so scale lives in H
    for (let k = 0; k < K; k++) {
      let col = 0;
      for (let b = 0; b < bins; b++) col += W[b * K + k];
      if (col < eps) {
        for (let b = 0; b < bins; b++) W[b * K + k] = 1 / bins;
      } else {
        for (let b = 0; b < bins; b++) W[b * K + k] /= col;
        for (let t = 0; t < frames; t++) H[k * frames + t] *= col;
      }
    }
  }

  // Wiener soft masks M_k = (W_k H_k) / sum_j W_j H_j  (on compressed space; fine for partitioning)
  const masks = [];
  for (let k = 0; k < K; k++) masks.push(new Float32Array(frames * bins));
  const parts = new Float32Array(K); // reuse per-bin buffer

  for (let t = 0; t < frames; t++) {
    for (let b = 0; b < bins; b++) {
      let sum = 0;
      for (let k = 0; k < K; k++) {
        let p = W[b * K + k] * H[k * frames + t];
        if (!Number.isFinite(p) || p < 0) p = 0;
        parts[k] = p;
        sum += p;
      }
      if (sum < eps) {
        // Silent bin — equal split keeps partition valid
        const eq = 1 / K;
        for (let k = 0; k < K; k++) masks[k][t * bins + b] = eq;
      } else {
        for (let k = 0; k < K; k++) {
          const m = parts[k] / sum;
          masks[k][t * bins + b] = Number.isFinite(m) ? m : 1 / K;
        }
      }
    }
  }

  // Spectral centroid per component for labeling
  const centroids = new Float32Array(K);
  const energies = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    let e = 0;
    let c = 0;
    for (let t = 0; t < frames; t++) {
      for (let b = 0; b < bins; b++) {
        const p = masks[k][t * bins + b] * mag[t * bins + b];
        if (!Number.isFinite(p)) continue;
        e += p;
        c += p * b;
      }
    }
    energies[k] = e;
    centroids[k] = e > eps ? c / e : bins / 2;
  }

  // Residual partner so soft masks form a partition (same idea as query path).
  const residual = new Float32Array(frames * bins);
  for (let i = 0; i < frames * bins; i++) {
    let used = 0;
    for (let k = 0; k < K; k++) used += masks[k][i];
    residual[i] = Math.max(0, 1 - Math.min(1, used));
  }
  masks.push(residual);
  const residualEnergy = (() => {
    let e = 0;
    for (let i = 0; i < residual.length; i++) e += residual[i] * mag[i];
    return e;
  })();
  // Extend centroid/energy arrays conceptually via parallel arrays on return.
  return {
    masks,
    centroids,
    energies,
    residualIndex: K,
    residualEnergy,
    W,
    H,
  };
}

function labelFromCentroid(centroidBin, bins, sampleRate, fftSize, rankByEnergy) {
  const hz = (centroidBin * sampleRate) / fftSize;
  if (hz < 120) return rankByEnergy === 0 ? 'low rumble / hum' : 'bass / thunder';
  if (hz < 400) return 'body / low speech';
  if (hz < 1500) return 'speech / mid band';
  if (hz < 4000) return 'presence / mid-high';
  if (hz < 8000) return 'air / sibilance / birds';
  return 'high noise / clicks';
}

// ─── Query masks ─────────────────────────────────────────────────────────────

/**
 * Soft mask for a text query using spectral prior × magnitude, plus optional
 * residual partner so the partition remains invertible.
 */
export function querySoftMasks(mag, frames, bins, queries, sampleRate, fftSize) {
  const list = (Array.isArray(queries) && queries.length ? queries : ['speech'])
    .map((q) => String(q || '').trim())
    .filter(Boolean)
    .slice(0, USM_MAX_SOURCES);

  const masks = [];
  const labels = [];
  const eps = 1e-8;

  // Frame energy + flux for transient priors
  const frameEnergy = new Float32Array(frames);
  const flux = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    let e = 0;
    for (let b = 0; b < bins; b++) e += mag[t * bins + b];
    frameEnergy[t] = e;
    if (t > 0) {
      let fl = 0;
      for (let b = 0; b < bins; b++) {
        const d = mag[t * bins + b] - mag[(t - 1) * bins + b];
        if (d > 0) fl += d;
      }
      flux[t] = fl;
    }
  }
  let maxFlux = eps;
  for (let t = 0; t < frames; t++) if (flux[t] > maxFlux) maxFlux = flux[t];

  for (const q of list) {
    const { weights, prior, label } = querySpectralPrior(q, bins, sampleRate, fftSize);
    const mask = new Float32Array(frames * bins);
    for (let t = 0; t < frames; t++) {
      const trans = flux[t] / maxFlux;
      const gate = prior.transient * trans + (1 - prior.transient) * 0.55
        + prior.tonal * 0.25;
      for (let b = 0; b < bins; b++) {
        const m = weights[b] * Math.min(1.5, gate);
        mask[t * bins + b] = Math.max(0, Math.min(1, m));
      }
    }
    masks.push(mask);
    labels.push(label);
  }

  // Normalize so query masks + residual sum to 1 (Wiener partition)
  const K = masks.length;
  const residual = new Float32Array(frames * bins);
  for (let i = 0; i < frames * bins; i++) {
    let s = 0;
    for (let k = 0; k < K; k++) s += masks[k][i];
    const scale = s > 1 ? 1 / s : 1;
    let used = 0;
    for (let k = 0; k < K; k++) {
      masks[k][i] *= scale;
      used += masks[k][i];
    }
    residual[i] = Math.max(0, 1 - used);
  }
  masks.push(residual);
  labels.push('residual / other');

  return { masks, labels };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Separate mono (or first-channel) PCM into K semantic sources.
 *
 * @param {Float32Array} samples
 * @param {number} [sampleRate]
 * @param {USMConfig} [config]
 * @returns {USMResult}
 */
function isPowerOfTwo(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export function separateUniversal(samples, sampleRate = SAMPLE_RATE, config = {}) {
  if (!(samples instanceof Float32Array) && !ArrayBuffer.isView(samples)) {
    throw new TypeError('[VIP][USM] samples must be a Float32Array');
  }
  const pcm = samples instanceof Float32Array ? samples : new Float32Array(samples);
  const sr = sampleRate || SAMPLE_RATE;
  const fftSize = config.fftSize || USM_FFT_SIZE;
  const hopSize = config.hopSize || USM_HOP_SIZE;
  if (!isPowerOfTwo(fftSize) || fftSize < 256) {
    throw new TypeError(`[VIP][USM] fftSize must be a power of two ≥ 256 (got ${fftSize})`);
  }
  if (!Number.isInteger(hopSize) || hopSize < 1 || hopSize > fftSize) {
    throw new TypeError(`[VIP][USM] hopSize must be an integer in [1, fftSize] (got ${hopSize})`);
  }
  const mode = config.mode === 'query' ? 'query' : 'auto';
  const Kreq = Math.max(2, Math.min(USM_MAX_SOURCES, config.numSources || USM_DEFAULT_SOURCES));
  const iterations = Math.max(8, Math.min(80, config.nmfIterations || 32));

  const stft = computeStft(pcm, fftSize, hopSize);
  const { mag, frames, bins } = stft;

  /** @type {Float32Array[]} */
  let masks;
  /** @type {string[]} */
  let labels;
  let method = 'classical-nmf';

  if (mode === 'query' && Array.isArray(config.queries) && config.queries.length) {
    const q = querySoftMasks(mag, frames, bins, config.queries, sr, fftSize);
    masks = q.masks;
    labels = q.labels;
    method = 'query-prior';
  } else {
    const nmf = nmfSoftMasks(mag, frames, bins, Kreq, iterations, config.seed ?? 42);
    // Sort NMF components by energy; keep residual last with a stable label (F residual).
    // NOTE: do not use Float32Array.map for object tuples — it returns a
    // Float32Array and coerces objects to NaN.
    const residualIndex = nmf.residualIndex;
    const componentIdx = [];
    for (let i = 0; i < nmf.masks.length; i++) {
      if (i !== residualIndex) componentIdx.push(i);
    }
    const order = componentIdx
      .map((i) => ({ e: Number(nmf.energies[i]) || 0, i }))
      .sort((a, b) => b.e - a.e)
      .map((x) => x.i);
    masks = order.map((i) => nmf.masks[i]);
    labels = order.map((i, rank) =>
      labelFromCentroid(nmf.centroids[i], bins, sr, fftSize, rank));
    if (residualIndex != null && nmf.masks[residualIndex]) {
      masks.push(nmf.masks[residualIndex]);
      labels.push('residual / other');
    }
    method = 'classical-nmf';
  }

  const sources = masks.map((mask, i) => {
    // Sanitize mask before iSTFT
    for (let j = 0; j < mask.length; j++) {
      const m = mask[j];
      if (!Number.isFinite(m) || m < 0) mask[j] = 0;
      else if (m > 1) mask[j] = 1;
    }
    const stem = maskToPcm(stft, mask, pcm.length);
    // Confidence from mask sharpness
    let sharp = 0;
    for (let j = 0; j < mask.length; j++) sharp += mask[j] * mask[j];
    const conf = Math.max(0.15, Math.min(0.95, 0.35 + sharp / (mask.length + 1e-8)));
    return {
      id: `usm_${i + 1}`,
      label: labels[i] || `Source ${i + 1}`,
      mask,
      pcm: stem,
      confidence: Number.isFinite(conf) ? conf : 0.5,
      quality: 'medium',
      method,
    };
  });

  return {
    sources,
    shape: { frames, bins },
    method,
    stft: { re: stft.re, im: stft.im, mag: stft.mag },
  };
}

/**
 * Mix sources with mute / solo / gain (linear gain, not dB).
 * Live-Mix contract: pure sample math — no ML, no STFT.
 *
 * @param {Array<{ pcm: Float32Array, mute?: boolean, solo?: boolean, gain?: number }>} sources
 * @param {number} length
 * @returns {Float32Array}
 */
export function mixSources(sources, length) {
  const out = new Float32Array(length);
  if (!sources?.length) return out;
  const anySolo = sources.some((s) => s.solo);
  for (const s of sources) {
    if (!s?.pcm) continue;
    if (s.mute) continue;
    if (anySolo && !s.solo) continue;
    const g = s.gain == null ? 1 : Number(s.gain);
    const pcm = s.pcm;
    const n = Math.min(length, pcm.length);
    for (let i = 0; i < n; i++) out[i] += pcm[i] * g;
  }
  return out;
}

/**
 * dB → linear gain. -Infinity / mute → 0.
 */
export function dbToGain(db) {
  if (db == null || db === -Infinity || Number(db) <= -120) return 0;
  return Math.pow(10, Number(db) / 20);
}

/**
 * Identity check helper: sum of auto masks ≈ 1 (for tests).
 */
export function maskPartitionError(masks, frames, bins) {
  let maxErr = 0;
  let sumErr = 0;
  let n = 0;
  for (let i = 0; i < frames * bins; i++) {
    let s = 0;
    for (const m of masks) s += m[i];
    const e = Math.abs(s - 1);
    maxErr = Math.max(maxErr, e);
    sumErr += e;
    n++;
  }
  return { maxErr, meanErr: sumErr / Math.max(1, n) };
}

export default {
  separateUniversal,
  mixSources,
  dbToGain,
  computeStft,
  maskToPcm,
  querySpectralPrior,
  nmfSoftMasks,
  maskPartitionError,
  USM_FFT_SIZE,
  USM_HOP_SIZE,
  USM_MAX_SOURCES,
  USM_DEFAULT_SOURCES,
};

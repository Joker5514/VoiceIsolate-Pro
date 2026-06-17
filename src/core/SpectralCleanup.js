/**
 * VoiceIsolate Pro — Spectral Cleanup (Layer 1: Core)
 *
 * Pure, offline STFT-domain enhancement run **once per file** during Phase-1
 * ingestion (CLAUDE.md §1) — NOT real-time playback DSP. Two non-ML passes
 * that complement the ML stems:
 *
 *   • reduceNoise() — spectral-subtraction denoise with a per-bin noise floor
 *     estimated by minimum statistics, plus temporal gain smoothing to suppress
 *     musical noise. Strips stationary hiss/hum the mask network leaves behind.
 *   • dereverb()    — single-channel reverb suppression: subtract a per-bin
 *     decaying-tail estimate so late reverberation between onsets is attenuated.
 *
 * Both take the `amount` (0–1) as a *processing parameter* decided before the
 * pass, never a live slider — they are heavy STFT passes and must not re-run on
 * UI events (that is what the Live-Mix Web Audio graph is for). The result is a
 * new, cleaner Float32Array stem that then feeds the playback graph.
 *
 * Pure module: no DOM, no Web Audio, no I/O. Importable from Node, workers, and
 * the browser. Operates on a single channel; the worker maps over channels.
 */
'use strict';

import { SAMPLE_RATE, FRAME_SIZE, HOP_SIZE } from './audio-config.js';

// ─── FFT primitives (radix-2, power-of-two) ──────────────────────────────────
// Self-contained copy of the proven transform: src/core/ must not depend on the
// classic MLWorker (which can't export ESM), so the math lives here too.

const _hannCache = Object.create(null);
function hann(n) {
  if (_hannCache[n]) return _hannCache[n];
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  _hannCache[n] = w;
  return w;
}

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

/** In-place iterative radix-2 complex FFT; inverse conjugates twiddles + scales 1/n. */
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

// ─── STFT scaffolding ────────────────────────────────────────────────────────

function frameCount(length, N, hop) {
  return Math.max(1, Math.ceil(Math.max(0, length - N) / hop) + 1);
}

/**
 * Forward-STFT a channel, invoking visit(re, im, bins, frameIndex) per frame
 * with the Hann-windowed half-spectrum. Reconstruction is the caller's job
 * (used by the noise-floor pre-pass, which needs magnitudes only).
 */
function forwardSTFT(samples, N, hop, visit) {
  const win = hann(N);
  const bins = N / 2 + 1;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const frames = frameCount(samples.length, N, hop);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    const avail = Math.max(0, Math.min(N, samples.length - start));
    re.fill(0); im.fill(0);
    for (let i = 0; i < avail; i++) re[i] = samples[start + i] * win[i];
    fftInPlace(re, im, false);
    visit(re, im, bins, f);
  }
}

/**
 * STFT → per-frame transform → masked iSTFT overlap-add. `transform(re, im,
 * bins, frame)` mutates the half-spectrum bins [0, bins) in place; the upper
 * half is rebuilt by Hermitian symmetry before the inverse FFT. COLA is
 * restored by dividing the accumulated output by the summed window² envelope.
 *
 * @returns {Float32Array} reconstructed channel, same length as `samples`
 */
function overlapProcess(samples, N, hop, transform) {
  const win = hann(N);
  const bins = N / 2 + 1;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const out = new Float32Array(samples.length);
  const norm = new Float32Array(samples.length);
  const frames = frameCount(samples.length, N, hop);

  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    const avail = Math.max(0, Math.min(N, samples.length - start));
    re.fill(0); im.fill(0);
    for (let i = 0; i < avail; i++) re[i] = samples[start + i] * win[i];
    fftInPlace(re, im, false);

    transform(re, im, bins, f);

    // Rebuild the Hermitian-symmetric upper half from the modified lower half.
    for (let k = bins; k < N; k++) {
      re[k] = re[N - k];
      im[k] = -im[N - k];
    }
    fftInPlace(re, im, true);

    for (let i = 0; i < avail; i++) {
      out[start + i] += re[i] * win[i];
      norm[start + i] += win[i] * win[i];
    }
  }
  // Normalize by the summed window² envelope. At the very edges only one or two
  // frames overlap, so dividing by that tiny norm would amplify the per-bin
  // gain's frame-edge ringing into a click. Floor the divisor at half the
  // steady-state overlap: edges are gently attenuated instead of blown up.
  let maxNorm = 0;
  for (let i = 0; i < norm.length; i++) if (norm[i] > maxNorm) maxNorm = norm[i];
  const floorNorm = 0.5 * maxNorm;
  if (floorNorm > 0) {
    for (let i = 0; i < out.length; i++) out[i] /= Math.max(norm[i], floorNorm);
  }
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** Replace any non-finite sample with 0 so a bad frame can't poison playback. */
function sanitize(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (!Number.isFinite(buf[i])) buf[i] = 0;
  }
  return buf;
}

// ─── Noise reduction (spectral subtraction + minimum statistics) ─────────────

/**
 * Estimate a per-bin noise magnitude floor by minimum statistics: track the
 * running minimum of a lightly time-smoothed power spectrum (the smoothing
 * keeps the minimum off momentary spectral nulls), then bias-compensate upward
 * (minimum statistics underestimates the true noise level).
 */
function estimateNoiseMag(samples, N, hop) {
  const bins = N / 2 + 1;
  const win = hann(N);
  const frames = frameCount(samples.length, N, hop);

  // Pass 1 (time domain, cheap): per-frame windowed energy → an adaptive
  // activity floor. Without it, minimum statistics is sabotaged not only by
  // absolute digital silence (which would pin every bin's minimum at 0 and
  // disable reduction for the whole file) but also by partial edge frames whose
  // only signal sits where the Hann window ≈ 0 — tiny-but-nonzero energy that
  // still drags the per-bin minimum far below the true noise floor. Excluding
  // frames below a fraction of the median energy handles silence, fades, and
  // those partial frames in one robust step.
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    const avail = Math.max(0, Math.min(N, samples.length - start));
    let e = 0;
    for (let i = 0; i < avail; i++) { const s = samples[start + i] * win[i]; e += s * s; }
    energy[f] = e;
  }
  const active = Array.from(energy).filter((e) => e > 1e-12).sort((a, b) => a - b);
  const median = active.length ? active[active.length >> 1] : 0;
  const threshold = median * 0.1;

  // Pass 2 (FFT): minimum statistics over active frames only.
  const smooth = new Float32Array(bins);
  const minPow = new Float32Array(bins).fill(Infinity);
  let first = true;
  forwardSTFT(samples, N, hop, (re, im, _bins, f) => {
    if (energy[f] <= 0 || energy[f] < threshold) return;
    for (let k = 0; k < bins; k++) {
      const pow = re[k] * re[k] + im[k] * im[k];
      smooth[k] = first ? pow : 0.7 * smooth[k] + 0.3 * pow;
      if (smooth[k] < minPow[k]) minPow[k] = smooth[k];
    }
    first = false;
  });
  const noiseMag = new Float32Array(bins);
  const BIAS = 1.4; // compensate the downward bias of minimum statistics
  for (let k = 0; k < bins; k++) {
    noiseMag[k] = Number.isFinite(minPow[k]) ? Math.sqrt(minPow[k]) * BIAS : 0;
  }
  return noiseMag;
}

/**
 * Spectral noise reduction. Estimates a stationary per-bin noise floor, then
 * applies a smoothed spectral-subtraction gain so bins near the floor are
 * attenuated while louder content passes. `amount` blends the gain toward unity
 * so 0 is fully transparent and 1 is maximally aggressive.
 *
 * @param {Float32Array} samples  one channel at SAMPLE_RATE
 * @param {object} [opts]
 * @param {number} [opts.amount=0]      0–1 reduction strength (0 = off)
 * @param {number} [opts.sampleRate]    informational; STFT is rate-agnostic
 * @param {number} [opts.frameSize=FRAME_SIZE]
 * @param {number} [opts.hopSize=HOP_SIZE]
 * @returns {Float32Array} denoised channel (new buffer, same length)
 */
export function reduceNoise(samples, opts = {}) {
  const input = samples instanceof Float32Array ? samples : new Float32Array(samples || []);
  const amount = clamp01(opts.amount ?? 0);
  if (amount <= 0 || input.length === 0) return new Float32Array(input);

  const N = opts.frameSize || FRAME_SIZE;
  const hop = opts.hopSize || HOP_SIZE;
  const bins = N / 2 + 1;
  const noiseMag = estimateNoiseMag(input, N, hop);

  const oversub = 1.5 + amount;     // β: over-subtraction factor 1.5 → 2.5
  const FLOOR = 0.05;               // residual gain — leaves a touch of noise (no pumping)
  const GSMOOTH = 0.5;              // temporal gain smoothing (musical-noise suppression)
  const prevGain = new Float32Array(bins).fill(1);

  const out = overlapProcess(input, N, hop, (re, im) => {
    for (let k = 0; k < bins; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]); // sqrt: hypot's overflow guard isn't needed here
      let g = mag > 1e-12 ? (mag - oversub * noiseMag[k]) / mag : 0;
      g = clamp01(g);
      if (g < FLOOR) g = FLOOR;
      g = GSMOOTH * prevGain[k] + (1 - GSMOOTH) * g;
      prevGain[k] = g;
      const blended = 1 - amount * (1 - g); // amount 0 → 1 (transparent)
      re[k] *= blended;
      im[k] *= blended;
    }
  });
  return sanitize(out);
}

// ─── Dereverberation (decaying-tail spectral subtraction) ────────────────────

/**
 * Single-channel reverb suppression. Models late reverberation per bin as a
 * decaying envelope of past energy and subtracts it, so the lingering tail
 * after each onset is attenuated while fresh onsets (which exceed the decayed
 * estimate) pass through. `amount` sets both the over-subtraction and a blend
 * toward unity, so 0 is transparent.
 *
 * @param {Float32Array} samples  one channel at SAMPLE_RATE
 * @param {object} [opts]
 * @param {number} [opts.amount=0]       0–1 suppression strength (0 = off)
 * @param {number} [opts.rt60=0.4]       assumed reverb decay time (seconds)
 * @param {number} [opts.sampleRate=SAMPLE_RATE]
 * @param {number} [opts.frameSize=FRAME_SIZE]
 * @param {number} [opts.hopSize=HOP_SIZE]
 * @returns {Float32Array} dereverberated channel (new buffer, same length)
 */
export function dereverb(samples, opts = {}) {
  const input = samples instanceof Float32Array ? samples : new Float32Array(samples || []);
  const amount = clamp01(opts.amount ?? 0);
  if (amount <= 0 || input.length === 0) return new Float32Array(input);

  const N = opts.frameSize || FRAME_SIZE;
  const hop = opts.hopSize || HOP_SIZE;
  const sr = opts.sampleRate || SAMPLE_RATE;
  const rt60 = opts.rt60 || 0.4;
  const bins = N / 2 + 1;

  // Per-hop tail decay on POWER (tail holds re²+im²): a 60 dB power decay over
  // rt60 is a factor of 10⁻⁶, so the per-frame factor loses (6·hop)/(rt60·sr)
  // decades. (−3 would model a 30 dB power decay → an effective RT60 of 2·rt60.)
  const hopTime = hop / sr;
  const decay = Math.pow(10, -6 * hopTime / rt60);
  const beta = 1 + amount;   // over-subtraction of the tail estimate
  const FLOOR = 0.1;         // keep ≥ -20 dB so onsets/timbre survive

  // Prediction delay (frames): the late-reverb estimate lags the signal so the
  // DIRECT sound of an onset is never subtracted by its own energy — only the
  // tail it leaves behind is. `tail` is a per-bin decaying power envelope; we
  // subtract a copy from D frames ago, projected forward by the decay.
  const D = 3;
  const decayD = Math.pow(decay, D);
  const tail = new Float32Array(bins);
  const ring = Array.from({ length: D }, () => new Float32Array(bins));
  let ringPos = 0;

  const out = overlapProcess(input, N, hop, (re, im) => {
    const delayed = ring[ringPos];
    for (let k = 0; k < bins; k++) {
      const pow = re[k] * re[k] + im[k] * im[k];
      const predictedTail = decayD * delayed[k];     // reverb level now from D frames ago
      const reverbPart = Math.min(pow, predictedTail);
      let cleanPow = pow - beta * reverbPart;
      if (cleanPow < FLOOR * pow) cleanPow = FLOOR * pow;
      const g = pow > 1e-12 ? Math.sqrt(cleanPow / pow) : 1;
      const blended = 1 - amount * (1 - g);
      re[k] *= blended;
      im[k] *= blended;
      // The reverberant input feeds the decaying tail envelope for later frames.
      tail[k] = Math.max(decay * tail[k], pow);
    }
    delayed.set(tail);                  // snapshot this frame's tail …
    ringPos = (ringPos + 1) % D;        // … to be read D frames from now
  });
  return sanitize(out);
}

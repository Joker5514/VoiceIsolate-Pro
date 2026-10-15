/*
 * VoiceIsolate Pro — DeepFilterNet3 speech enhancement (Layer 2 classic-worker helper)
 *
 * Loaded by MLWorker with importScripts(); MLWorker owns the three ONNX
 * sessions (enc, erb_dec, df_dec) and passes a `run(part, feeds)` adapter.
 * Offline only: one pass per Process, never from a slider.
 *
 * Reproduces libDF / DeepFilterNet 0.5.6 at 48 kHz (pinned by
 * tests/deepfilternet.test.js against libdf):
 *   STFT    960-point, hop 480, Vorbis window, spectrum × 1/960, zero history
 *   ERB     32 bands (libDF widths), 10·log10(mean |X|² + 1e-10), then
 *           exponential mean norm (α 0.99, state from -60 to -90 dB) / 40
 *   complex first 96 bins / sqrt(exponential mean |X|), state 0.001 → 0.0001
 *   model   features shifted 2 frames ahead (conv lookahead), enc → ERB mask
 *           on all bins, order-5 deep filter (frames t-2..t+2) on bins < 96
 *   iSTFT   irfft × 960 × window, overlap-add; output delayed by 480 samples
 *
 * This is a separate branch from the fused spectral-mask chain (its own
 * STFT/iSTFT), like the waveform models; it does not claim that invariant.
 *
 * The exported graphs have no recurrent-state inputs, so long files run in
 * chunks of CHUNK frames with LEFT frames of re-processed context for the
 * GRUs to settle. Feature normalisation is causal and carried across chunks,
 * so features equal a single full-length pass; memory is O(chunk).
 */
'use strict';

(function installDeepFilterNet(scope) {
  const SR = 48000;
  const FFT = 960;
  const HOP = 480;
  const BINS = FFT / 2 + 1; // 481
  const NB_ERB = 32;
  const NB_DF = 96;
  const ORDER = 5;
  const DF_LOOKAHEAD = 2;
  const CONV_LOOKAHEAD = 2;
  const ALPHA = 0.99; // round(exp(-hop / sr / tau = 1 s), 3)
  const ERB_WIDTHS = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 5, 5, 7, 7, 8, 10, 12, 13, 15, 18, 20, 24, 28, 31, 37, 42, 50, 56, 67];
  const CHUNK = 1000; // 10 s of frames per inference call
  const LEFT = 300; // 3 s of warm-up context per chunk
  const RIGHT = 4; // > CONV_LOOKAHEAD: frames the last kept output can see

  // ── FFT: complex 480 = 2^5 × 15 (radix-2 DIT over naive 15-point DFTs) ──
  const M = FFT / 2; // 480
  const BASE = 15;
  let plan = null;
  function getPlan() {
    if (plan) return plan;
    const window = new Float64Array(FFT);
    for (let i = 0; i < FFT; i++) {
      const s = Math.sin((Math.PI * (i + 0.5)) / FFT);
      window[i] = Math.sin(0.5 * Math.PI * s * s);
    }
    const twR = new Float64Array(M);
    const twI = new Float64Array(M);
    for (let k = 0; k < M; k++) {
      twR[k] = Math.cos((-2 * Math.PI * k) / M);
      twI[k] = Math.sin((-2 * Math.PI * k) / M);
    }
    const bR = new Float64Array(BASE * BASE);
    const bI = new Float64Array(BASE * BASE);
    for (let k = 0; k < BASE; k++) {
      for (let n = 0; n < BASE; n++) {
        bR[k * BASE + n] = Math.cos((-2 * Math.PI * k * n) / BASE);
        bI[k * BASE + n] = Math.sin((-2 * Math.PI * k * n) / BASE);
      }
    }
    // Real-FFT untangle twiddles for N = 960.
    const uR = new Float64Array(M + 1);
    const uI = new Float64Array(M + 1);
    for (let k = 0; k <= M; k++) {
      uR[k] = Math.cos((-2 * Math.PI * k) / FFT);
      uI[k] = Math.sin((-2 * Math.PI * k) / FFT);
    }
    // Input order for the DIT: bit-reversal over the 5 radix-2 levels.
    const order = new Uint16Array(M);
    const levels = 5;
    for (let i = 0; i < M; i++) {
      // i = n * 32 + r? DIT splits even/odd repeatedly: sub-sequence r (0..31)
      // takes samples r' + 32 * n where r' is r bit-reversed.
      const r = Math.floor(i / BASE);
      const n = i % BASE;
      let rev = 0;
      for (let b = 0; b < levels; b++) if (r & (1 << b)) rev |= 1 << (levels - 1 - b);
      order[i] = rev + 32 * n;
    }
    plan = { window, twR, twI, bR, bI, uR, uI, order, sR: new Float64Array(M), sI: new Float64Array(M) };
    return plan;
  }

  /** In-place complex FFT of length 480 (forward). */
  function fft480(re, im, p) {
    const { sR, sI, order, bR, bI, twR, twI } = p;
    for (let i = 0; i < M; i++) { sR[i] = re[order[i]]; sI[i] = im[order[i]]; }
    // 32 naive 15-point DFTs.
    for (let blk = 0; blk < 32; blk++) {
      const o = blk * BASE;
      for (let k = 0; k < BASE; k++) {
        let ar = 0;
        let ai = 0;
        const row = k * BASE;
        for (let n = 0; n < BASE; n++) {
          const xr = sR[o + n];
          const xi = sI[o + n];
          ar += xr * bR[row + n] - xi * bI[row + n];
          ai += xr * bI[row + n] + xi * bR[row + n];
        }
        re[o + k] = ar;
        im[o + k] = ai;
      }
    }
    // Radix-2 combine: sizes 30, 60, ..., 480.
    for (let size = 2 * BASE; size <= M; size *= 2) {
      const half = size / 2;
      const step = M / size;
      for (let s = 0; s < M; s += size) {
        for (let k = 0; k < half; k++) {
          const wr = twR[k * step];
          const wi = twI[k * step];
          const a = s + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  /** Real forward FFT of a 960-sample frame → 481 bins (unscaled). */
  function rfft960(frame, outR, outI, p, zr, zi) {
    for (let i = 0; i < M; i++) { zr[i] = frame[2 * i]; zi[i] = frame[2 * i + 1]; }
    fft480(zr, zi, p);
    for (let k = 0; k <= M; k++) {
      const k1 = k % M;
      const k2 = (M - k) % M;
      const er = 0.5 * (zr[k1] + zr[k2]);
      const ei = 0.5 * (zi[k1] - zi[k2]);
      const or = 0.5 * (zi[k1] + zi[k2]);
      const oi = -0.5 * (zr[k1] - zr[k2]);
      outR[k] = er + p.uR[k] * or - p.uI[k] * oi;
      outI[k] = ei + p.uR[k] * oi + p.uI[k] * or;
    }
  }

  /** Inverse real FFT (481 bins → 960 samples), unnormalised like realfft c2r. */
  function irfft960(inR, inI, out, p, zr, zi) {
    for (let k = 0; k < M; k++) {
      const ar = inR[k];
      const ai = k === 0 ? 0 : inI[k];
      const br = inR[M - k];
      const bi = -(M - k === M ? 0 : inI[M - k]);
      // E = (X[k] + conj(X[M-k])) / 2 ; O = (X[k] - conj(X[M-k])) * conj(w) / 2
      const er = 0.5 * (ar + br);
      const ei = 0.5 * (ai + bi);
      const dr = 0.5 * (ar - br);
      const di = 0.5 * (ai - bi);
      const or = dr * p.uR[k] + di * p.uI[k];
      const oi = di * p.uR[k] - dr * p.uI[k];
      // Z = E + i·O, inverse via conj-forward-conj.
      zr[k] = er - oi;
      zi[k] = -(ei + or);
    }
    fft480(zr, zi, p);
    for (let i = 0; i < M; i++) {
      out[2 * i] = 2 * zr[i];
      out[2 * i + 1] = -2 * zi[i];
    }
  }

  // ── Streaming analysis + features ──────────────────────────────────────

  function createAnalyzer(samples, length) {
    const p = getPlan();
    const frame = new Float64Array(FFT);
    const zr = new Float64Array(M);
    const zi = new Float64Array(M);
    const erbState = new Float64Array(NB_ERB);
    const unitState = new Float64Array(NB_DF);
    for (let b = 0; b < NB_ERB; b++) erbState[b] = -60 - (30 * b) / (NB_ERB - 1);
    for (let f = 0; f < NB_DF; f++) unitState[f] = 0.001 - (0.0009 * f) / (NB_DF - 1);
    const sample = (i) => (i >= 0 && i < samples.length ? samples[i] : 0);

    /** Spectrum of frame t: samples [t·480 - 480, t·480 + 480), scaled 1/960. */
    function spectrum(t, outR, outI) {
      const start = t * HOP - HOP;
      for (let i = 0; i < FFT; i++) frame[i] = (start + i < length ? sample(start + i) : 0) * p.window[i];
      rfft960(frame, outR, outI, p, zr, zi);
      for (let k = 0; k < BINS; k++) { outR[k] /= FFT; outI[k] /= FFT; }
    }

    /** Next frame's normalised features (advances the causal states). */
    function features(specR, specI, erbOut, specOut, oE, oS, frames) {
      let bin = 0;
      for (let b = 0; b < NB_ERB; b++) {
        let e = 0;
        for (let k = 0; k < ERB_WIDTHS[b]; k++, bin++) e += specR[bin] * specR[bin] + specI[bin] * specI[bin];
        const db = 10 * Math.log10(e / ERB_WIDTHS[b] + 1e-10);
        erbState[b] = db * (1 - ALPHA) + erbState[b] * ALPHA;
        erbOut[oE + b] = (db - erbState[b]) / 40;
      }
      for (let f = 0; f < NB_DF; f++) {
        const mag = Math.hypot(specR[f], specI[f]);
        unitState[f] = mag * (1 - ALPHA) + unitState[f] * ALPHA;
        const s = Math.sqrt(unitState[f]);
        specOut[oS + f] = specR[f] / s; // channel 0: real, [1, 2, S, 96]
        specOut[oS + frames * NB_DF + f] = specI[f] / s; // channel 1: imag
      }
    }

    const snapshot = () => ({ erb: Float64Array.from(erbState), unit: Float64Array.from(unitState) });
    const restore = (s) => { erbState.set(s.erb); unitState.set(s.unit); };
    return { spectrum, features, snapshot, restore };
  }

  /**
   * @param {Float32Array} samples mono 48 kHz
   * @param {(part: 'enc'|'erb_dec'|'df_dec', feeds: Record<string, { data: Float32Array, dims: number[] }>) => Promise<Record<string, Float32Array>>} run
   * @param {{ onProgress?: (p: number) => void, yieldFn?: () => Promise<void>|void, chunkFrames?: number, leftFrames?: number }} [opts]
   * @returns {Promise<Float32Array>} enhanced, same length as input
   */
  async function runDeepFilterNet(samples, run, opts = {}) {
    const chunk = opts.chunkFrames || CHUNK;
    const left = opts.leftFrames ?? LEFT;
    const n = samples.length;
    // libDF enhance(): pad by FFT zeros, frames = floor(len / hop), trim the 480-sample delay.
    const padded = n + FFT;
    const T = Math.floor(padded / HOP);
    const an = createAnalyzer(samples, n);
    const p = getPlan();
    const out = new Float32Array(T * HOP);
    const synthMem = new Float64Array(HOP);
    const zr = new Float64Array(M);
    const zi = new Float64Array(M);
    const tmp = new Float64Array(FFT);
    let synthT = 0;
    let state = an.snapshot();
    let stateFrame = 0; // features computed up to (excluding) this frame for `state`

    for (let c = 0; c < T; c += chunk) {
      const keepEnd = Math.min(T, c + chunk);
      const ctxStart = Math.max(0, c - left);
      // Features for frames [ctxStart, keepEnd + RIGHT), shifted CONV_LOOKAHEAD ahead.
      const featEnd = Math.min(T, keepEnd + RIGHT + CONV_LOOKAHEAD);
      const S = keepEnd + RIGHT - ctxStart; // model frames this chunk
      const frames = Math.max(S, 1);
      const erbFeat = new Float32Array(frames * NB_ERB);
      const specFeat = new Float32Array(2 * frames * NB_DF);
      an.restore(state);
      const sr = new Float64Array(BINS);
      const si = new Float64Array(BINS);
      const nextStart = keepEnd - left; // the next chunk's ctxStart
      let nextState = null;
      for (let t = stateFrame; t < featEnd; t++) {
        if (t === Math.max(0, nextStart)) nextState = an.snapshot();
        an.spectrum(t, sr, si);
        const row = t - CONV_LOOKAHEAD - ctxStart; // feature t drives model frame t - 2
        if (row >= 0 && row < frames) {
          an.features(sr, si, erbFeat, specFeat, row * NB_ERB, row * NB_DF, frames);
        } else {
          // Still advance the causal norms for frames before the window.
          an.features(sr, si, new Float32Array(NB_ERB), new Float32Array(2 * NB_DF), 0, 0, 1);
        }
      }
      if (keepEnd < T) {
        if (!nextState) nextState = an.snapshot();
        state = nextState;
        stateFrame = Math.max(0, nextStart);
      }

      const enc = await run('enc', {
        feat_erb: { data: erbFeat, dims: [1, 1, frames, NB_ERB] },
        feat_spec: { data: specFeat, dims: [1, 2, frames, NB_DF] },
      });
      const dims = (name) => enc[`${name}__dims`];
      const m = (await run('erb_dec', {
        emb: { data: enc.emb, dims: dims('emb') },
        e3: { data: enc.e3, dims: dims('e3') },
        e2: { data: enc.e2, dims: dims('e2') },
        e1: { data: enc.e1, dims: dims('e1') },
        e0: { data: enc.e0, dims: dims('e0') },
      })).m; // [1, 1, frames, 32]
      const coefs = (await run('df_dec', {
        emb: { data: enc.emb, dims: dims('emb') },
        c0: { data: enc.c0, dims: dims('c0') },
      })).coefs; // [1, frames, 96, 10]

      // Apply to frames [c, keepEnd) and synthesise in order.
      const hist = [];
      const histT = [];
      const specAt = (t) => {
        const i = histT.indexOf(t);
        if (i >= 0) return hist[i];
        const r = new Float64Array(BINS);
        const im = new Float64Array(BINS);
        if (t >= 0 && t < T) an.spectrum(t, r, im);
        hist.push([r, im]); histT.push(t);
        if (hist.length > ORDER + 1) { hist.shift(); histT.shift(); }
        return [r, im];
      };
      const yR = new Float64Array(BINS);
      const yI = new Float64Array(BINS);
      for (let t = c; t < keepEnd; t++) {
        const row = t - ctxStart;
        const [xR, xI] = specAt(t);
        let bin = 0;
        for (let b = 0; b < NB_ERB; b++) {
          const g = m[row * NB_ERB + b];
          for (let k = 0; k < ERB_WIDTHS[b]; k++, bin++) { yR[bin] = xR[bin] * g; yI[bin] = xI[bin] * g; }
        }
        for (let f = 0; f < NB_DF; f++) { yR[f] = 0; yI[f] = 0; }
        for (let o = 0; o < ORDER; o++) {
          const [hR, hI] = specAt(t - (ORDER - 1 - DF_LOOKAHEAD) + o);
          const base = (row * NB_DF) * ORDER * 2;
          for (let f = 0; f < NB_DF; f++) {
            const cr = coefs[base + (f * ORDER + o) * 2];
            const ci = coefs[base + (f * ORDER + o) * 2 + 1];
            yR[f] += hR[f] * cr - hI[f] * ci;
            yI[f] += hR[f] * ci + hI[f] * cr;
          }
        }
        // iSTFT with OLA (DC/Nyquist imaginary parts dropped, as realfft does).
        irfft960(yR, yI, tmp, p, zr, zi);
        const o = synthT * HOP;
        for (let i = 0; i < HOP; i++) {
          out[o + i] = tmp[i] * p.window[i] + synthMem[i];
          synthMem[i] = tmp[HOP + i] * p.window[HOP + i];
        }
        synthT++;
      }
      opts.onProgress?.(keepEnd / T);
      if (opts.yieldFn) await opts.yieldFn();
    }
    return out.slice(FFT - HOP, FFT - HOP + n);
  }

  scope.runDeepFilterNet = runDeepFilterNet;
  scope.VipDeepFilterNet = Object.freeze({
    SR, FFT, HOP, NB_ERB, NB_DF, ERB_WIDTHS, CHUNK, LEFT,
    // Exposed for tests only.
    _rfft960: (x, outR, outI) => rfft960(x, outR, outI, getPlan(), new Float64Array(M), new Float64Array(M)),
    _irfft960: (inR, inI, out) => irfft960(inR, inI, out, getPlan(), new Float64Array(M), new Float64Array(M)),
  });
})(typeof self !== 'undefined' ? self : globalThis);

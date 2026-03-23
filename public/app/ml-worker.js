'use strict';
/**
 * VoiceIsolate Pro — ML Worker
 * Runs in a dedicated Web Worker context (no DOM access).
 *
 * Pipeline:
 *   audio → [Silero VAD] → [DeepFilterNet3 enhance] → [Demucs v4 separate] → isolated voice
 *
 * Models (all optional, graceful fallback):
 *   silero_vad.onnx   — 2 MB  — speech activity detection
 *   enc.onnx          — ~10 MB — DeepFilterNet3 encoder
 *   erb_dec.onnx      — ~10 MB — DeepFilterNet3 ERB mask decoder
 *   df_dec.onnx       — ~15 MB — DeepFilterNet3 deep-filter decoder
 *   demucs_v4.onnx    — ~150 MB — vocal stem separation (WebGPU recommended)
 */

importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js');

const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';

// ── DeepFilterNet3 (low-latency variant) constants ────────────────────────
const DF_SR      = 48000;
const DF_FFT     = 960;    // 20 ms frame @ 48 kHz
const DF_HOP     = 480;    // 10 ms hop  → 50 % overlap
const DF_N_ERB   = 32;     // ERB frequency bands
const DF_N_DF    = 96;     // deep-filter bins  (0 – ~4.8 kHz)
const DF_ORDER   = 5;      // deep-filter FIR order

// ── Session handles ────────────────────────────────────────────────────────
let vadSession    = null;
let dfEnc         = null;
let dfErbDec      = null;
let dfDfDec       = null;
let demucsSession = null;

// ── Recurrent hidden states (reset per file) ───────────────────────────────
let dfState = null;

function initDFState() {
  return {
    erb_hidden: new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]),
    df_hidden:  new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]),
  };
}

// ── Model loader ───────────────────────────────────────────────────────────
async function initModels() {
  ort.env.wasm.wasmPaths = ORT_CDN;
  ort.env.logLevel = 'warning';
  const EP = (typeof navigator !== 'undefined' && navigator.gpu)
    ? ['webgpu', 'wasm'] : ['wasm'];

  const results = { vad: false, deepfilter: false, demucs: false };

  // Silero VAD v5
  try {
    vadSession = await ort.InferenceSession.create('./models/silero_vad.onnx', { executionProviders: EP });
    results.vad = true;
  } catch (e) {
    log('warn', 'VAD unavailable: ' + e.message);
  }

  // DeepFilterNet3 (three-part model — all three must load together)
  try {
    const [enc, erb, df] = await Promise.all([
      ort.InferenceSession.create('./models/enc.onnx',     { executionProviders: EP }),
      ort.InferenceSession.create('./models/erb_dec.onnx', { executionProviders: EP }),
      ort.InferenceSession.create('./models/df_dec.onnx',  { executionProviders: EP }),
    ]);
    dfEnc = enc; dfErbDec = erb; dfDfDec = df;
    dfState = initDFState();
    results.deepfilter = true;
  } catch (e) {
    log('warn', 'DeepFilterNet3 unavailable: ' + e.message);
  }

  // Demucs v4 (optional, large — WebGPU recommended)
  try {
    demucsSession = await ort.InferenceSession.create('./models/demucs_v4.onnx', { executionProviders: EP });
    results.demucs = true;
  } catch (e) {
    log('warn', 'Demucs v4 unavailable: ' + e.message);
  }

  self.postMessage({ type: 'ready', models: results });
}

// ── ERB filterbank (Moore & Glasberg) ─────────────────────────────────────
// Precomputed once — maps each FFT bin to an ERB band index.
const ERB_BIN_MAP = buildErbFilterbank();

function hzToErb(hz) { return 21.4 * Math.log10(1 + hz / 228.7); }
function erbToHz(erb) { return 228.7 * (Math.pow(10, erb / 21.4) - 1); }

function buildErbFilterbank() {
  const nBins = DF_FFT / 2 + 1;
  const binFreq = Array.from({ length: nBins }, (_, k) => k * DF_SR / DF_FFT);
  const loErb = hzToErb(0);
  const hiErb = hzToErb(DF_SR / 2);
  const step  = (hiErb - loErb) / (DF_N_ERB + 1);

  // For each bin, find its ERB band (unmapped bins are marked as -1)
  const map = new Int16Array(nBins).fill(-1);
  const bands = Array.from({ length: DF_N_ERB }, () => []);

  for (let k = 0; k < nBins; k++) {
    const erbK = hzToErb(binFreq[k]);
    const b = Math.floor((erbK - loErb) / step) - 1;
    if (b >= 0 && b < DF_N_ERB) { map[k] = b; bands[b].push(k); }
  }
  return { map, bands };
}

function toErbFeatures(mag) {
  // mag: Float32Array[nBins] → log-energy per ERB band: Float32Array[DF_N_ERB]
  const erb = new Float32Array(DF_N_ERB);
  const counts = new Uint16Array(DF_N_ERB);
  for (let k = 0; k < mag.length; k++) {
    const b = ERB_BIN_MAP.map[k];
    if (b >= 0) { erb[b] += mag[k] * mag[k]; counts[b]++; }
  }
  for (let b = 0; b < DF_N_ERB; b++) {
    erb[b] = Math.log(Math.max(counts[b] > 0 ? erb[b] / counts[b] : 0, 1e-10));
  }
  return erb;
}

// ── Hann window (precomputed) ──────────────────────────────────────────────
const HANN = Float32Array.from({ length: DF_FFT }, (_, i) =>
  0.5 * (1 - Math.cos(2 * Math.PI * i / DF_FFT)));

// ── Radix-2 FFT ───────────────────────────────────────────────────────────
function fftInPlace(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang  = sign * 2 * Math.PI / len;
    const wRe  = Math.cos(ang);
    const wIm  = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len >> 1; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + (len >> 1)] * curRe - im[i + j + (len >> 1)] * curIm;
        const vIm = re[i + j + (len >> 1)] * curIm + im[i + j + (len >> 1)] * curRe;
        re[i + j]            = uRe + vRe;  im[i + j]            = uIm + vIm;
        re[i + j + (len>>1)] = uRe - vRe;  im[i + j + (len>>1)] = uIm - vIm;
        const nr = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nr;
      }
    }
  }
}

// ── STFT / iSTFT ──────────────────────────────────────────────────────────
function stft(signal) {
  // Returns array of { re, im } per frame (half-spectrum, nBins = FFT/2+1)
  const nBins   = DF_FFT / 2 + 1;
  const nFrames = Math.max(1, Math.floor((signal.length - DF_FFT) / DF_HOP) + 1);
  const frames  = [];
  const tmpRe   = new Float32Array(DF_FFT);
  const tmpIm   = new Float32Array(DF_FFT);
  const flatRe  = new Float32Array(nFrames * nBins);
  const flatIm  = new Float32Array(nFrames * nBins);

  for (let f = 0; f < nFrames; f++) {
    const off = f * DF_HOP;
    tmpIm.fill(0);
    for (let i = 0; i < DF_FFT; i++) {
      tmpRe[i] = (off + i < signal.length ? signal[off + i] : 0) * HANN[i];
    }
    fftInPlace(tmpRe, tmpIm, false);

    const offset = f * nBins;
    flatRe.set(tmpRe.subarray(0, nBins), offset);
    flatIm.set(tmpIm.subarray(0, nBins), offset);

    const re = flatRe.subarray(offset, offset + nBins);
    const im = flatIm.subarray(offset, offset + nBins);
    frames.push({ re, im });
  }
  return frames;
}

function istft(frames, outLen) {
  const nBins  = DF_FFT / 2 + 1;
  const output = new Float32Array(outLen);
  const norm   = new Float32Array(outLen);
  const tmpRe  = new Float32Array(DF_FFT);
  const tmpIm  = new Float32Array(DF_FFT);

  for (let f = 0; f < frames.length; f++) {
    const off = f * DF_HOP;
    const { re, im } = frames[f];
    tmpRe.fill(0); tmpIm.fill(0);
    for (let k = 0; k < nBins; k++) { tmpRe[k] = re[k]; tmpIm[k] = im[k]; }
    // Hermitian symmetry
    for (let k = 1; k < DF_FFT / 2; k++) {
      tmpRe[DF_FFT - k] =  re[k];
      tmpIm[DF_FFT - k] = -im[k];
    }
    fftInPlace(tmpRe, tmpIm, true);
    for (let i = 0; i < DF_FFT; i++) {
      if (off + i >= outLen) break;
      output[off + i] += (tmpRe[i] / DF_FFT) * HANN[i];
      norm[off + i]   += HANN[i] * HANN[i];
    }
  }
  for (let i = 0; i < outLen; i++) {
    if (norm[i] > 1e-8) output[i] /= norm[i];
  }
  return output;
}

// ── DeepFilterNet3 inference ───────────────────────────────────────────────
async function runDeepFilter(signal) {
  if (!dfEnc || !dfErbDec || !dfDfDec) return signal;

  const frames   = stft(signal);
  const nBins    = DF_FFT / 2 + 1;
  const enhanced = frames.map(f => ({ re: new Float32Array(f.re), im: new Float32Array(f.im) }));

  for (let f = 0; f < frames.length; f++) {
    const { re, im } = frames[f];

    // Magnitude spectrum
    const mag = new Float32Array(nBins);
    for (let k = 0; k < nBins; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);

    // ERB log-energy features  [1, 1, 1, n_erb]
    const erbFeat  = toErbFeatures(mag);
    const featErb  = new ort.Tensor('float32', erbFeat, [1, 1, 1, DF_N_ERB]);

    // Complex spectral features for DF bins  [1, 2*n_df, 1, 1]
    const specFeat = new Float32Array(2 * DF_N_DF);
    for (let k = 0; k < DF_N_DF && k < nBins; k++) {
      specFeat[k]            = re[k];
      specFeat[k + DF_N_DF]  = im[k];
    }
    const featSpec = new ort.Tensor('float32', specFeat, [1, 2 * DF_N_DF, 1, 1]);

    try {
      // ── Encoder
      const encOut = await dfEnc.run({ feat_erb: featErb, feat_spec: featSpec });
      const { e0, e1, e2, e3, emb, c0 } = encOut;

      // ── ERB mask decoder  →  m [1, 1, 1, n_erb] in [0,1]
      const erbDecOut = await dfErbDec.run({ emb, e0, e1, e2, e3, hidden: dfState.erb_hidden });
      const erbMask   = erbDecOut.m.data;
      dfState.erb_hidden = erbDecOut.hidden;

      // ── Deep-filter coefficient decoder  →  coefs [1, 1, n_df, df_order, 2]
      const dfDecOut = await dfDfDec.run({ emb, c0, hidden: dfState.df_hidden });
      const coefs    = dfDecOut.coefs.data;
      dfState.df_hidden = dfDecOut.hidden;

      // Apply ERB mask to all bins in each band
      for (let b = 0; b < DF_N_ERB; b++) {
        const gain = Math.min(1.0, Math.max(0.0, erbMask[b]));
        for (const k of ERB_BIN_MAP.bands[b]) {
          enhanced[f].re[k] = re[k] * gain;
          enhanced[f].im[k] = im[k] * gain;
        }
      }

      // Apply deep filtering to first n_df bins (order-1 complex multiply)
      for (let k = 0; k < DF_N_DF && k < nBins; k++) {
        const base = k * DF_ORDER * 2;
        const cr   = coefs[base];
        const ci   = coefs[base + 1];
        const inR  = enhanced[f].re[k];
        const inI  = enhanced[f].im[k];
        enhanced[f].re[k] = inR * cr - inI * ci;
        enhanced[f].im[k] = inR * ci + inI * cr;
      }
    } catch (e) {
      // Inference error on this frame — pass through unchanged
      enhanced[f].re = re;
      enhanced[f].im = im;
    }
  }

  return istft(enhanced, signal.length);
}

// ── Silero VAD ─────────────────────────────────────────────────────────────
async function runVAD(signal, sr) {
  if (!vadSession) return null;
  const frameSize = Math.floor(sr / 100); // 10 ms
  const result    = [];
  let h = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
  let c = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
  for (let i = 0; i + frameSize <= signal.length; i += frameSize) {
    const frame    = signal.slice(i, i + frameSize);
    const input    = new ort.Tensor('float32', frame, [1, frame.length]);
    const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(sr)]), [1]);
    try {
      const out = await vadSession.run({ input, sr: srTensor, h, c });
      result.push(out.output.data[0] > 0.5);
      h = out.hn; c = out.cn;
    } catch (_) { result.push(true); }
  }
  return result;
}

// ── Demucs v4 — vocals stem ────────────────────────────────────────────────
async function runDemucs(signal) {
  if (!demucsSession) return signal;
  try {
    // Demucs expects stereo input [1, 2, samples]; pad mono→stereo
    const stereo = new Float32Array(2 * signal.length);
    stereo.set(signal, 0);
    stereo.set(signal, signal.length);
    const input  = new ort.Tensor('float32', stereo, [1, 2, signal.length]);
    const out    = await demucsSession.run({ input });
    // Output [1, 4, 2, samples]: stems = [drums, bass, other, vocals]
    const vocalsOffset = 3 * 2 * signal.length; // vocals stem, left channel
    return Float32Array.from(out.output.data.slice(vocalsOffset, vocalsOffset + signal.length));
  } catch (e) {
    log('warn', 'Demucs inference failed: ' + e.message);
    return signal;
  }
}

// ── Linear resampler ───────────────────────────────────────────────────────
function resampleLinear(signal, fromSR, toSR) {
  if (fromSR === toSR) return signal;
  const ratio  = fromSR / toSR;
  const outLen = Math.round(signal.length / ratio);
  const out    = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos  = i * ratio;
    const lo   = Math.floor(pos);
    const hi   = Math.min(lo + 1, signal.length - 1);
    const frac = pos - lo;
    out[i] = signal[lo] * (1 - frac) + signal[hi] * frac;
  }
  return out;
}

// ── Main processing pipeline ───────────────────────────────────────────────
async function processAudio({ signal, sampleRate, params }) {
  progress('VAD', 5);

  // Resample to 48 kHz for DeepFilterNet if needed
  const needResample = sampleRate !== DF_SR && dfEnc !== null;
  let working = needResample ? resampleLinear(signal, sampleRate, DF_SR) : signal;
  const workSR = needResample ? DF_SR : sampleRate;

  // 1. Silero VAD — speech activity mask
  const vadMask = await runVAD(working, workSR);
  progress('DeepFilter', 20);

  // 2. DeepFilterNet3 — denoising + de-reverberation
  if (dfEnc) {
    dfState  = initDFState(); // reset recurrent state per file
    working  = await runDeepFilter(working);
  }
  progress('Demucs', 60);

  // 3. Demucs v4 — vocal stem separation
  if (demucsSession) {
    working = await runDemucs(working);
  }
  progress('Finalising', 88);

  // 4. Resample back to original SR
  let output = needResample ? resampleLinear(working, DF_SR, sampleRate) : working;

  // 5. VAD gating — attenuate non-speech frames when voiceIso is set
  if (vadMask && params && params.voiceIso > 0) {
    const frameSize = Math.floor(sampleRate / 100);
    const floor     = 1 - (params.voiceIso / 100) * 0.9; // min gain 10% at 100%
    for (let i = 0; i < vadMask.length; i++) {
      if (!vadMask[i]) {
        const start = i * frameSize;
        const end   = Math.min(start + frameSize, output.length);
        for (let j = start; j < end; j++) output[j] *= floor;
      }
    }
  }

  // 6. Peak-normalise to −1 dBFS
  let peak = 0;
  for (let i = 0; i < output.length; i++) {
    const a = Math.abs(output[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0 && peak < 0.891) {
    const g = 0.891 / peak; // ~−1 dBFS
    for (let i = 0; i < output.length; i++) output[i] *= g;
  }

  progress('Done', 100);
  self.postMessage({ type: 'result', signal: output, sampleRate }, [output.buffer]);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function log(level, msg) {
  self.postMessage({ type: 'log', level, msg });
}

function progress(stage, pct) {
  self.postMessage({ type: 'progress', stage, pct });
}

// ── Message handler ────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  const { type } = e.data;
  try {
    if (type === 'init') {
      await initModels();
    } else if (type === 'process') {
      await processAudio(e.data);
    } else if (type === 'reset') {
      dfState = dfEnc ? initDFState() : null;
    }
  } catch (err) {
    self.postMessage({ type: 'error', msg: err.message });
  }
};

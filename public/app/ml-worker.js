/**
 * VoiceIsolate Pro — ML Worker
 * Off-main-thread ONNX Runtime inference for all ML models.
 * Communicates with app.js via postMessage / onmessage.
 *
 * Supported message types (main → worker):
 *   { type: 'loadModel',    model: 'vad'|'deepfilter'|'demucs'|'bsrnn'|'ecapa'|'hifigan'|'conformer', wasmRoot }
 *   { type: 'runVAD',       id, signal: Float32Array, sampleRate }
 *   { type: 'runEnhance',   id, signal: Float32Array, sampleRate }   ← DeepFilterNet3
 *   { type: 'runSeparation',id, signal: Float32Array, sampleRate, model: 'demucs'|'bsrnn' }
 *   { type: 'runVocoder',   id, mel: Float32Array, hopLength }
 *
 * Supported message types (worker → main):
 *   { type: 'modelLoaded',  model, ok: true }
 *   { type: 'modelError',   model, error }
 *   { type: 'result',       id, data }        – Float32Array or boolean[] depending on op
 *   { type: 'error',        id, error }
 *   { type: 'progress',     model, loaded, total }
 *
 * DeepFilterNet3 pipeline (VAD chunks → enhance → separate):
 *   loadModel('deepfilter') loads enc.onnx + erb_dec.onnx + df_dec.onnx from
 *   ./models/deepfilter/ (~35 MB total).  runEnhance passes through silently if
 *   the sessions are absent, so the Demucs fallback remains unaffected.
 */

'use strict';

// ---- ONNX Runtime bootstrap ------------------------------------------------
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js';

let ortLoaded = false;
let ort = null;

function ensureOrt() {
  if (ortLoaded) return true;
  try {
    importScripts(ORT_CDN);
    ort = globalThis.ort;
    ort.env.wasm.numThreads = 1; // Workers share one thread, keep deterministic
    ortLoaded = true;
    return true;
  } catch (e) {
    postMessage({ type: 'error', id: null, error: 'Failed to load ONNX Runtime: ' + e.message });
    return false;
  }
}

// ---- Model registry --------------------------------------------------------
const MODEL_PATHS = {
  vad:        './models/silero_vad.onnx',
  demucs:     './models/demucs_v4.onnx',
  bsrnn:      './models/bsrnn.onnx',
  ecapa:      './models/ecapa_tdnn.onnx',
  hifigan:    './models/hifigan_v2.onnx',
  conformer:  './models/conformer.onnx',
  // DeepFilterNet3 sub-models (loaded together via model: 'deepfilter')
  df_enc:     './models/deepfilter/enc.onnx',
  df_erb_dec: './models/deepfilter/erb_dec.onnx',
  df_dec:     './models/deepfilter/df_dec.onnx',
};

const sessions = {}; // model-key → InferenceSession

// ---- DeepFilterNet3 config -------------------------------------------------
// Matches DeepFilterNet3 default config (48 kHz, 20 ms frames, 10 ms hop).
const DF_CFG = {
  sr:      48000,
  frame:   960,   // 20 ms at 48 kHz
  hop:     480,   // 10 ms
  fftSz:   1024,  // next power-of-2; the 960-sample frame is zero-padded here
  bins:    481,   // frame/2 + 1 (one-sided bins from 960-pt DFT, first 481 of 513)
  nErb:    32,    // ERB filterbank bands
  dfOrd:   5,     // deep-filter FIR order
  nDfBins: 96,    // bins processed by complex DF filter (lower frequencies)
};

let _erbMatrix = null; // lazily built triangular ERB filterbank
let _dfState   = null; // recurrent LSTM state across frames within one file

// ---- Execution provider selection ------------------------------------------
function getProviders() {
  // Workers can't access navigator.gpu directly in all environments; try
  // webgpu first and fall back gracefully to wasm.
  return ['webgpu', 'wasm'];
}

// ===========================================================================
// DSP utilities — STFT / iSTFT / ERB filterbank / linear resampler
// ===========================================================================

/** Returns a Hann window of length n as Float32Array. */
function _hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
  return w;
}

/**
 * In-place radix-2 Cooley-Tukey DIT FFT.
 * re[], im[] must have power-of-2 length.
 * Pass inverse=true for IFFT (result scaled by 1/n).
 */
function _fft(re, im, inverse) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang  = sign * 2 * Math.PI / len;
    const wRe0 = Math.cos(ang);
    const wIm0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < (len >> 1); j++) {
        const idx = i + j + (len >> 1);
        const ur = re[idx] * curRe - im[idx] * curIm;
        const ui = re[idx] * curIm + im[idx] * curRe;
        re[idx] = re[i + j] - ur;
        im[idx] = im[i + j] - ui;
        re[i + j] += ur;
        im[i + j] += ui;
        const nr = curRe * wRe0 - curIm * wIm0;
        curIm    = curRe * wIm0 + curIm * wRe0;
        curRe    = nr;
      }
    }
  }
  if (inverse) { for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; } }
}

/**
 * Short-Time Fourier Transform.
 * Returns { reSpec, imSpec, nFrames, bins } where each spec is an Array of
 * Float32Array[bins] (one-sided, DC…Nyquist).  The frame is zero-padded to
 * fftSz before the FFT.
 */
function _stft(signal, frame, hop, fftSz) {
  const win    = _hannWindow(frame);
  const bins   = fftSz / 2 + 1;
  const nFrames = Math.max(0, Math.floor((signal.length - frame) / hop) + 1);
  const reSpec = new Array(nFrames);
  const imSpec = new Array(nFrames);
  const re = new Float32Array(fftSz);
  const im = new Float32Array(fftSz);
  for (let f = 0; f < nFrames; f++) {
    re.fill(0); im.fill(0);
    const start = f * hop;
    for (let i = 0; i < frame; i++) {
      re[i] = (start + i < signal.length ? signal[start + i] : 0) * win[i];
    }
    _fft(re, im, false);
    reSpec[f] = re.slice(0, bins);
    imSpec[f] = im.slice(0, bins);
  }
  return { reSpec, imSpec, nFrames, bins };
}

/**
 * Inverse STFT with Hann-squared overlap-add normalisation.
 * reSpec / imSpec — Arrays of Float32Array[bins] (one-sided).
 */
function _istft(reSpec, imSpec, frame, hop, fftSz, outLen) {
  const win    = _hannWindow(frame);
  const nFrames = reSpec.length;
  const bins   = fftSz / 2 + 1;
  const out    = new Float32Array(outLen);
  const norm   = new Float32Array(outLen);
  const re = new Float32Array(fftSz);
  const im = new Float32Array(fftSz);
  for (let f = 0; f < nFrames; f++) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < bins; i++) { re[i] = reSpec[f][i]; im[i] = imSpec[f][i]; }
    // Hermitian symmetry → real-output IFFT
    for (let i = 1; i < bins - 1; i++) { re[fftSz - i] = re[i]; im[fftSz - i] = -im[i]; }
    _fft(re, im, true);
    const start = f * hop;
    for (let i = 0; i < frame && start + i < outLen; i++) {
      out[start + i]  += re[i] * win[i];
      norm[start + i] += win[i] * win[i];
    }
  }
  for (let i = 0; i < outLen; i++) { if (norm[i] > 1e-9) out[i] /= norm[i]; }
  return out;
}

/**
 * Build a triangular ERB filterbank matrix of shape [nErb × bins].
 * Uses the Glasberg & Moore (1990) ERB scale.
 * Result is cached in _erbMatrix after the first call.
 */
function _buildErbMatrix(bins, nErb, sr, fftSz) {
  const erb  = f => 24.7 * (4.37 * f / 1000 + 1);
  const iErb = e => (e / 24.7 - 1) / 4.37 * 1000;
  const nyq  = sr / 2;
  const erbMin = erb(20);
  const erbMax = erb(nyq);

  const centers = new Float32Array(nErb);
  for (let b = 0; b < nErb; b++) {
    centers[b] = iErb(erbMin + (erbMax - erbMin) * b / (nErb - 1));
  }

  const freqs = new Float32Array(bins);
  for (let i = 0; i < bins; i++) freqs[i] = i * sr / fftSz;

  const matrix = Array.from({ length: nErb }, () => new Float32Array(bins));
  for (let b = 0; b < nErb; b++) {
    const fc = centers[b];
    const fl = b > 0        ? centers[b - 1] : 0;
    const fh = b < nErb - 1 ? centers[b + 1] : nyq;
    for (let i = 0; i < bins; i++) {
      const f = freqs[i];
      if      (f >= fl && f <= fc) matrix[b][i] = (f - fl) / Math.max(fc - fl, 1e-8);
      else if (f >  fc && f <= fh) matrix[b][i] = (fh - f) / Math.max(fh - fc, 1e-8);
    }
  }
  return matrix;
}

/**
 * Linear interpolation resampler.
 * Sufficient quality for broadband speech; avoids dependency on WebAudio in Worker.
 */
function _resample(signal, fromRate, toRate) {
  if (fromRate === toRate) return signal;
  const ratio  = toRate / fromRate;
  const outLen = Math.round(signal.length * ratio);
  const out    = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src  = i / ratio;
    const lo   = Math.floor(src);
    const frac = src - lo;
    const a    = lo     < signal.length ? signal[lo]     : 0;
    const b    = lo + 1 < signal.length ? signal[lo + 1] : 0;
    out[i]     = a + frac * (b - a);
  }
  return out;
}

// ===========================================================================
// loadModel
// ===========================================================================

async function loadModel(model, wasmRoot) {
  if (!ensureOrt()) return;
  if (wasmRoot) ort.env.wasm.wasmPaths = wasmRoot;

  // 'deepfilter' is a logical alias that loads all three sub-model files.
  if (model === 'deepfilter') {
    const subs = ['df_enc', 'df_erb_dec', 'df_dec'];
    let allOk = true;
    for (const sub of subs) {
      if (sessions[sub]) continue;
      try {
        sessions[sub] = await ort.InferenceSession.create(MODEL_PATHS[sub], {
          executionProviders: getProviders(),
        });
      } catch (e) {
        postMessage({ type: 'modelError', model: sub, error: e.message });
        allOk = false;
      }
    }
    if (allOk) postMessage({ type: 'modelLoaded', model: 'deepfilter', ok: true });
    return;
  }

  if (sessions[model]) {
    postMessage({ type: 'modelLoaded', model, ok: true });
    return;
  }
  const path = MODEL_PATHS[model];
  if (!path) {
    postMessage({ type: 'modelError', model, error: 'Unknown model key: ' + model });
    return;
  }
  try {
    sessions[model] = await ort.InferenceSession.create(path, {
      executionProviders: getProviders(),
    });
    postMessage({ type: 'modelLoaded', model, ok: true });
  } catch (e) {
    postMessage({ type: 'modelError', model, error: e.message });
  }
}

// ===========================================================================
// runVAD
// ===========================================================================

// Returns boolean[] at 100 fps (one bool per 10 ms frame).
async function runVAD(id, signal, sampleRate) {
  if (!sessions.vad) {
    postMessage({ type: 'error', id, error: 'VAD model not loaded' });
    return;
  }
  try {
    const frameSize = Math.floor(sampleRate / 100); // 10 ms
    const result = [];
    let h = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
    let c = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
    const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(sampleRate)]), [1]);

    for (let i = 0; i + frameSize <= signal.length; i += frameSize) {
      const frame = signal.slice(i, i + frameSize);
      const input = new ort.Tensor('float32', frame, [1, frame.length]);
      const out = await sessions.vad.run({ input, sr, h, c });
      result.push(out.output.data[0] > 0.5);
      h = out.hn;
      c = out.cn;
    }
    postMessage({ type: 'result', id, data: result });
  } catch (e) {
    postMessage({ type: 'error', id, error: e.message });
  }
}

// ===========================================================================
// runEnhance — DeepFilterNet3 speech enhancement
// ===========================================================================
/**
 * Enhances mono Float32Array with DeepFilterNet3.
 *
 * Pipeline per frame:
 *   STFT → ERB log-magnitude → enc.onnx → erb_dec.onnx (gains)
 *                                        → df_dec.onnx  (complex filter coefs)
 *   → apply gains/filter to spectrum → iSTFT
 *
 * Model interface (DeepFilterNet3 streaming ONNX, v0.5.6 release):
 *   enc.onnx      : feat_erb [1,1,nErb,1] + state tensors → emb + state'
 *   erb_dec.onnx  : emb + state tensors → erb_gains [1,1,nErb,1] + state'
 *   df_dec.onnx   : emb + state tensors → coefs [1,dfOrd,nDfBins,1,2] + state'
 *
 * Falls back to lossless pass-through if sessions are not loaded, so
 * the Demucs separation step is unaffected.
 */
async function runEnhance(id, signal, sampleRate) {
  // Graceful pass-through when DeepFilterNet files are absent
  if (!sessions.df_enc || !sessions.df_erb_dec || !sessions.df_dec) {
    const copy = new Float32Array(signal);
    postMessage({ type: 'result', id, data: copy }, [copy.buffer]);
    return;
  }
  try {
    const { sr: dfSr, frame, hop, fftSz, nErb, dfOrd, nDfBins } = DF_CFG;

    // --- Resample to 48 kHz if needed ---
    const input48 = _resample(signal, sampleRate, dfSr);

    // --- STFT ---
    const { reSpec, imSpec, nFrames, bins } = _stft(input48, frame, hop, fftSz);

    // --- Build ERB filterbank once per worker lifetime ---
    if (!_erbMatrix) _erbMatrix = _buildErbMatrix(bins, nErb, dfSr, fftSz);

    // Reset recurrent state at the start of each new clip
    _dfState = { enc: {}, erb_dec: {}, df_dec: {} };

    const enhRe = new Array(nFrames);
    const enhIm = new Array(nFrames);

    for (let f = 0; f < nFrames; f++) {
      // --- Compute ERB log-magnitude features [1, 1, nErb, 1] ---
      const erbFeat = new Float32Array(nErb);
      for (let b = 0; b < nErb; b++) {
        let e = 0;
        for (let i = 0; i < bins; i++) {
          e += _erbMatrix[b][i] * Math.sqrt(reSpec[f][i] ** 2 + imSpec[f][i] ** 2);
        }
        erbFeat[b] = Math.log1p(e); // log(1 + magnitude) for numerical stability
      }

      // --- Encoder ---
      const encIn = Object.assign(
        { feat_erb: new ort.Tensor('float32', erbFeat, [1, 1, nErb, 1]) },
        _dfState.enc,
      );
      const encOut = await sessions.df_enc.run(encIn);
      // Pick embedding: first output key that is not a recurrent state
      const embKey = Object.keys(encOut).find(k => !k.startsWith('enc_state')) ?? Object.keys(encOut)[0];
      const emb    = encOut[embKey];
      _dfState.enc = {};
      for (const [k, v] of Object.entries(encOut)) { if (k !== embKey) _dfState.enc[k] = v; }

      // --- ERB decoder → per-band real gains ---
      const erbDecIn  = Object.assign({ emb }, _dfState.erb_dec);
      const erbDecOut = await sessions.df_erb_dec.run(erbDecIn);
      const gainsKey  = Object.keys(erbDecOut).find(k => !k.startsWith('erb_state')) ?? Object.keys(erbDecOut)[0];
      const erbGains  = erbDecOut[gainsKey];
      _dfState.erb_dec = {};
      for (const [k, v] of Object.entries(erbDecOut)) { if (k !== gainsKey) _dfState.erb_dec[k] = v; }

      // --- DF decoder → complex FIR coefs for low-frequency bins ---
      const dfDecIn  = Object.assign({ emb }, _dfState.df_dec);
      const dfDecOut = await sessions.df_dec.run(dfDecIn);
      const coefsKey = Object.keys(dfDecOut).find(k => !k.startsWith('df_state')) ?? Object.keys(dfDecOut)[0];
      const coefs    = dfDecOut[coefsKey]; // may be null if df_dec_out name differs
      _dfState.df_dec = {};
      for (const [k, v] of Object.entries(dfDecOut)) { if (k !== coefsKey) _dfState.df_dec[k] = v; }

      // --- Map ERB gains back to per-bin gains via filterbank ---
      const gainBin = new Float32Array(bins).fill(0);
      const normBin = new Float32Array(bins).fill(1e-9);
      const gd = erbGains.data;
      for (let b = 0; b < nErb; b++) {
        const g = Math.max(0, gd[b]); // ReLU: gains are non-negative
        for (let i = 0; i < bins; i++) {
          gainBin[i] += _erbMatrix[b][i] * g;
          normBin[i] += _erbMatrix[b][i];
        }
      }
      for (let i = 0; i < bins; i++) gainBin[i] /= normBin[i];

      // --- Apply gains and DF filter to spectrum ---
      const eRe = new Float32Array(bins);
      const eIm = new Float32Array(bins);
      const nDf = Math.min(nDfBins, bins);
      const cd  = coefs ? coefs.data : null;

      for (let i = 0; i < bins; i++) {
        if (cd && i < nDf) {
          // Apply first tap of the complex FIR filter.
          // Full overlap-save (dfOrd taps) requires buffering the previous
          // dfOrd-1 spectral frames per bin — omitted here for simplicity.
          const cRe = cd[i * dfOrd * 2];
          const cIm = cd[i * dfOrd * 2 + 1];
          eRe[i] = reSpec[f][i] * cRe - imSpec[f][i] * cIm;
          eIm[i] = reSpec[f][i] * cIm + imSpec[f][i] * cRe;
        } else {
          eRe[i] = reSpec[f][i] * gainBin[i];
          eIm[i] = imSpec[f][i] * gainBin[i];
        }
      }

      enhRe[f] = eRe;
      enhIm[f] = eIm;
    }

    // --- iSTFT and resample back to original rate ---
    const enhanced48 = _istft(enhRe, enhIm, frame, hop, fftSz, input48.length);
    const enhanced   = _resample(enhanced48, dfSr, sampleRate);

    postMessage({ type: 'result', id, data: enhanced }, [enhanced.buffer]);
  } catch (e) {
    postMessage({ type: 'error', id, error: 'DeepFilterNet: ' + e.message });
  }
}

// ===========================================================================
// runSeparation — Demucs v4 / BSRNN
// ===========================================================================
// Accepts mono Float32Array at 44100 Hz, returns separated Float32Array.
// For source separation these models expect chunked input; we send the full
// signal and let the model handle buffering internally (works for models up
// to ~30 s at 44100 Hz before WASM heap limits are hit).
async function runSeparation(id, signal, sampleRate, model) {
  const key = model === 'bsrnn' ? 'bsrnn' : 'demucs';
  if (!sessions[key]) {
    postMessage({ type: 'error', id, error: `${key} model not loaded` });
    return;
  }
  try {
    // Both Demucs v4 and BSRNN accept shape [1, 1, T] for mono input.
    const input = new ort.Tensor('float32', signal, [1, 1, signal.length]);
    const out = await sessions[key].run({ input });
    // The first output is the foreground (voice) track.
    const outputKey = Object.keys(out)[0];
    const separated = new Float32Array(out[outputKey].data);
    postMessage({ type: 'result', id, data: separated }, [separated.buffer]);
  } catch (e) {
    postMessage({ type: 'error', id, error: e.message });
  }
}

// ===========================================================================
// runVocoder — HiFi-GAN v2
// ===========================================================================
// Accepts mel-spectrogram Float32Array and hopLength, returns waveform Float32Array.
async function runVocoder(id, mel, hopLength) {
  if (!sessions.hifigan) {
    postMessage({ type: 'error', id, error: 'HiFi-GAN model not loaded' });
    return;
  }
  try {
    // HiFi-GAN expects [1, n_mels, T_mel]
    const nMels = 80;
    const tMel  = Math.floor(mel.length / nMels);
    const input = new ort.Tensor('float32', mel, [1, nMels, tMel]);
    const out = await sessions.hifigan.run({ input });
    const outputKey = Object.keys(out)[0];
    const waveform = new Float32Array(out[outputKey].data);
    postMessage({ type: 'result', id, data: waveform }, [waveform.buffer]);
  } catch (e) {
    postMessage({ type: 'error', id, error: e.message });
  }
}

// ===========================================================================
// Message dispatcher
// ===========================================================================
self.onmessage = async function (e) {
  const msg = e.data;
  switch (msg.type) {
    case 'loadModel':
      await loadModel(msg.model, msg.wasmRoot);
      break;
    case 'runVAD':
      await runVAD(msg.id, msg.signal, msg.sampleRate);
      break;
    case 'runEnhance':
      await runEnhance(msg.id, msg.signal, msg.sampleRate);
      break;
    case 'runSeparation':
      await runSeparation(msg.id, msg.signal, msg.sampleRate, msg.model);
      break;
    case 'runVocoder':
      await runVocoder(msg.id, msg.mel, msg.hopLength);
      break;
    default:
      postMessage({ type: 'error', id: msg.id || null, error: 'Unknown message type: ' + msg.type });
  }
};

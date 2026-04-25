/**
 * VoiceIsolate Pro — ML Worker
 * Off-main-thread ONNX Runtime inference for all ML models.
 * Communicates with app.js via postMessage / onmessage.
 *
 * Supported message types (main → worker):
 *   { type: 'loadModel',    model: 'vad'|'demucs'|'bsrnn'|'ecapa'|'hifigan'|'conformer', wasmRoot }
 *   { type: 'runVAD',       id, signal: Float32Array, sampleRate }
 *   { type: 'runSeparation',id, signal: Float32Array, sampleRate, model: 'demucs'|'bsrnn' }
 *   { type: 'runVocoder',   id, mel: Float32Array, hopLength }
 *
 * Supported message types (worker → main):
 *   { type: 'modelLoaded',  model, ok: true }
 *   { type: 'modelError',   model, error }
 *   { type: 'result',       id, data }        – Float32Array or boolean[] depending on op
 *   { type: 'error',        id, error }
 *   { type: 'progress',     model, loaded, total }
 */

'use strict';

// ---- ONNX Runtime bootstrap ------------------------------------------------
// importScripts is synchronous inside a Worker and loads the ort global.
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js';

let ortLoaded = false;
let ort = null; // populated after importScripts

function ensureOrt() {
  if (ortLoaded) return true;
  try {
    importScripts(ORT_CDN);
    // After importScripts ort is on globalThis
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
  vad:      './models/silero_vad.onnx',
  demucs:   './models/demucs_v4.onnx',
  bsrnn:    './models/bsrnn.onnx',
  ecapa:    './models/ecapa_tdnn.onnx',
  hifigan:  './models/hifigan_v2.onnx',
  conformer:'./models/conformer.onnx',
};

const sessions = {};   // model → InferenceSession

// ---- Execution provider selection -----------------------------------------
function getProviders() {
  // Workers can't access navigator.gpu directly in all environments, so try
  // webgpu first and fall back gracefully to wasm.
  return ['webgpu', 'wasm'];
}

// ---- loadModel -------------------------------------------------------------
async function loadModel(model, wasmRoot) {
  if (!ensureOrt()) return;
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
    if (wasmRoot) ort.env.wasm.wasmPaths = wasmRoot;
    sessions[model] = await ort.InferenceSession.create(path, {
      executionProviders: getProviders(),
    });
    postMessage({ type: 'modelLoaded', model, ok: true });
  } catch (e) {
    postMessage({ type: 'modelError', model, error: e.message });
  }
}

// ---- runVAD ----------------------------------------------------------------
// Returns boolean[] at 100 fps (one bool per 10ms frame).
async function runVAD(id, signal, sampleRate) {
  if (!sessions.vad) {
    postMessage({ type: 'error', id, error: 'VAD model not loaded' });
    return;
  }
  try {
    const frameSize = Math.floor(sampleRate / 100); // 10ms
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

// ---- runSeparation (Demucs / BSRNN) ----------------------------------------
// Accepts mono Float32Array at 44100 Hz, returns separated Float32Array.
// For source separation these models expect chunked input; we send the full
// signal and let the model handle buffering internally (works for models up
// to ~30s at 44100 Hz before WASM heap limits are hit).
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

// ---- runVocoder (HiFi-GAN v2) ----------------------------------------------
// Accepts mel-spectrogram Float32Array and hopLength, returns waveform Float32Array.
async function runVocoder(id, mel, hopLength) {
  if (!sessions.hifigan) {
    postMessage({ type: 'error', id, error: 'HiFi-GAN model not loaded' });
    return;
  }
  try {
    // HiFi-GAN expects [1, n_mels, T_mel]
    const nMels = 80;
    const tMel = Math.floor(mel.length / nMels);
    const input = new ort.Tensor('float32', mel, [1, nMels, tMel]);
    const out = await sessions.hifigan.run({ input });
    const outputKey = Object.keys(out)[0];
    const waveform = new Float32Array(out[outputKey].data);
    postMessage({ type: 'result', id, data: waveform }, [waveform.buffer]);
  } catch (e) {
    postMessage({ type: 'error', id, error: e.message });
  }
}

// ---- Message dispatcher ----------------------------------------------------
self.onmessage = async function (e) {
  const msg = e.data;
  switch (msg.type) {
    case 'loadModel':
      await loadModel(msg.model, msg.wasmRoot);
      break;
    case 'runVAD':
      await runVAD(msg.id, msg.signal, msg.sampleRate);
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

// src/main.js — Dispatcher: owns the SAB, bootstraps all threads, wires UI events
import { createParamBuffer, gainMap, PARAMS } from './shared/param-buffer.js';
import { initVisualizer, updateVisualizer } from './visualizer.js';

// ── SharedArrayBuffer: single source of truth for all DSP params ──────────────
const paramBuf = createParamBuffer();

// ── AudioContext + AudioWorklet ───────────────────────────────────────────────
const audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });

async function initAudio() {
  await audioCtx.audioWorklet.addModule('src/dsp-processor.js');

  const workletNode = new AudioWorkletNode(audioCtx, 'dsp-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { paramSab: paramBuf.buffer },
  });

  // Receive FFT frames from the worklet for visualization + ONNX dispatch
  workletNode.port.onmessage = ({ data }) => {
    if (data.type === 'FFT_FRAME') {
      updateVisualizer(data.magnitude, data.similarity ?? 0.5);
      dispatchToWorker({ type: 'INFER_ECAPA', frame: data.magnitude });
    }
  };

  return workletNode;
}

// ── Worker Pool (ONNX Demucs + ECAPA-TDNN) ───────────────────────────────────
const POOL_SIZE = Math.max(2, (navigator.hardwareConcurrency || 4) - 2);

const workerPool = Array.from({ length: POOL_SIZE }, (_, i) => {
  const w = new Worker(new URL('./worker-pool.js', import.meta.url), { type: 'module' });
  w.postMessage({ type: 'INIT', paramSab: paramBuf.buffer, workerId: i });
  w.onmessage = ({ data }) => {
    if (data.type === 'SIMILARITY') {
      // Feed similarity score back to visualizer
      updateVisualizer(null, data.score);
    }
    if (data.type === 'ENROLLED') {
      document.getElementById('btn-enroll').textContent = 'Voiceprint ✓';
    }
  };
  return w;
});

let _rrIndex = 0;
function dispatchToWorker(payload) {
  workerPool[_rrIndex++ % POOL_SIZE].postMessage(payload);
}

// ── Mic → Worklet → Speakers ──────────────────────────────────────────────────
let workletNode = null;

document.getElementById('btn-start').addEventListener('click', async () => {
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

  workletNode = workletNode || await initAudio();
  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(workletNode);
  workletNode.connect(audioCtx.destination);

  document.getElementById('btn-start').textContent = 'Processing...';
  document.getElementById('btn-start').disabled = true;
});

// ── Voiceprint Enrollment ─────────────────────────────────────────────────────
document.getElementById('btn-enroll').addEventListener('click', () => {
  dispatchToWorker({ type: 'ENROLL_VOICEPRINT' });
});

// ── Sliders → SAB (decoupled: UI never calls DSP directly) ───────────────────
const SLIDER_MAP = [
  { id: 'slider-noise',     param: PARAMS.NOISE_REDUCTION,  map: (s) => s },
  { id: 'slider-isolation', param: PARAMS.VOICE_ISOLATION,  map: (s) => s },
  { id: 'slider-volume',    param: PARAMS.VOLUME_GAIN,      map: gainMap },
];

for (const { id, param, map } of SLIDER_MAP) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener('input', (e) => {
    const s = Number(e.target.value) / 100;
    const mapped = map(s);
    // Write as scaled integer for Atomics compatibility
    Atomics.store(new Int32Array(paramBuf.buffer), param, Math.round(mapped * 10000));
  });
}

// ── 3D Visualizer ─────────────────────────────────────────────────────────────
const canvas = document.getElementById('spectrogram-canvas');
if (canvas) initVisualizer(canvas);

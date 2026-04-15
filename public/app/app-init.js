// public/app/app-init.js
// VoiceIsolate Pro — Threads from Space v8
// Boot sequence: Auth → SharedArrayBuffers → AudioWorklet → ML Worker → 52 Sliders
// Import map is handled by index.html — this file is loaded as type="module"

import {
  requireAuth,
  logout,
  getCaps,
  getAllowedStages,
  checkFileSizeLimit,
  incrementFileUsage
} from './auth.js';

// ─── 1. AUTH GATE ────────────────────────────────────────────────────────────
// Blocks all execution. requireAuth renders the login modal if no session exists.
const session = await requireAuth();
const caps    = getCaps(session.tier);

const footerTier = document.getElementById('auth-footer-tier');
if (footerTier) footerTier.textContent = `${session.displayName} · ${session.tier}`;

const logoutBtn = document.getElementById('btn-logout');
if (logoutBtn) {
  logoutBtn.style.display = 'inline-flex';
  logoutBtn.addEventListener('click', logout);
}

// File size guard on the upload input
document.getElementById('fileBtn')?.addEventListener('change', e => {
  const file = e.target.files?.[0];
  if (!file) return;
  const sizeMB = file.size / (1024 * 1024);
  if (!checkFileSizeLimit(sizeMB)) {
    alert(
      `Your ${session.tier} tier allows files up to ` +
      `${caps.maxFileSizeMB === Infinity ? 'unlimited' : caps.maxFileSizeMB + ' MB'}. ` +
      `This file is ${sizeMB.toFixed(1)} MB.`
    );
    e.target.value = '';
  }
});

// ─── 2. SHARED ARRAY BUFFERS ─────────────────────────────────────────────────
// Layout (bytes):
//   inputSAB  [0 .. NUMBINS*4-1]  Float32 magnitudes written by dsp-processor
//             [NUMBINS*4 .. +7]   Int32[0]=frameCounter, Int32[1]=reserved
//   outputSAB [0 .. NUMBINS*4-1]  Float32 mask written by ml-worker
//             [NUMBINS*4 .. +7]   Int32[0]=maskReady flag
const FFTSIZE  = 4096;
const NUMBINS  = FFTSIZE / 2 + 1;   // 2049
const F32BYTES = NUMBINS * 4;

const inputSAB  = new SharedArrayBuffer(F32BYTES + 16);
const outputSAB = new SharedArrayBuffer(F32BYTES + 16);

// ─── 3. APP STATE ────────────────────────────────────────────────────────────
const App = {
  ctx:             null,
  workletNode:     null,
  mlWorker:        null,
  liveStream:      null,
  liveSource:      null,
  fileBuffer:      null,
  processedBuffer: null
};

// ─── 4. AUDIO CONTEXT + WORKLET ──────────────────────────────────────────────
async function initAudio() {
  if (App.ctx) {
    if (App.ctx.state === 'suspended') await App.ctx.resume();
    return;
  }

  App.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });

  // Load the AudioWorkletProcessor (single-pass STFT, inline Cooley-Tukey FFT)
  await App.ctx.audioWorklet.addModule('./dsp-processor.js');

  App.workletNode = new AudioWorkletNode(App.ctx, 'dsp-processor', {
    numberOfInputs:     1,
    numberOfOutputs:    1,
    outputChannelCount: [1],
    processorOptions:   { inputSAB, outputSAB }
  });

  App.workletNode.connect(App.ctx.destination);

  // Receive RMS meter events from the worklet
  App.workletNode.port.onmessage = ev => {
    if (ev.data?.type === 'meter') {
      const db = 20 * Math.log10(Math.max(ev.data.rms, 1e-9));
      const el = document.getElementById('meter-rms');
      if (el) el.textContent = db.toFixed(1);
    }
    if (ev.data?.type === 'pipeline-stage') {
      const el = document.getElementById('pipelineStage');
      if (el) el.textContent = ev.data.stage;
    }
  };

  // Push current slider state immediately
  pushSliderParams();
}

// ─── 5. ML WORKER ────────────────────────────────────────────────────────────
function initMLWorker() {
  if (App.mlWorker) {
    App.mlWorker.terminate();
    App.mlWorker = null;
  }

  App.mlWorker = new Worker('./ml-worker.js', { type: 'module' });

  App.mlWorker.postMessage({
    type: 'init',
    payload: {
      inputSAB,
      outputSAB,
      modelBasePath:      './models/',
      preferredProviders: ['webgpu', 'wasm'],
      allowedModels:      caps.mlModels,
      allowedStages:      getAllowedStages()
    }
  });

  App.mlWorker.onmessage = ev => {
    const { type, modelId, providers, latencyMs, error } = ev.data ?? {};
    if (type === 'model-loaded') {
      console.info(`[ml-worker] ✓ ${modelId} via ${providers?.join(',') ?? '?'}`);
      const el = document.getElementById('stat-worker-latency');
      if (el && latencyMs != null) el.textContent = latencyMs.toFixed(0);
    }
    if (type === 'model-error') {
      console.warn(`[ml-worker] ✗ ${modelId}: ${error}`);
    }
    if (type === 'ready') {
      const pill = document.getElementById('pipelineStage');
      if (pill) pill.textContent = 'ML Ready';
    }
  };

  App.mlWorker.onerror = err => console.error('[ml-worker] fatal:', err);
}

// ─── 6. 52-SLIDER AUTO-DISCOVERY ─────────────────────────────────────────────
// Convention: <input type="range" id="slider-gate-thresh"> → key "gateThresh"
// Every slider with id^="slider-" is auto-mapped. No manual wiring needed.
function camel(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function collectParams() {
  const params = {};
  document.querySelectorAll('input[type="range"][id^="slider-"]').forEach(el => {
    params[camel(el.id.replace('slider-', ''))] = parseFloat(el.value);
  });
  return params;
}

function pushSliderParams() {
  if (!App.workletNode) return;
  App.workletNode.port.postMessage({ type: 'params', params: collectParams() });
}

// Attach live listeners to all 52 sliders
document.querySelectorAll('input[type="range"][id^="slider-"]').forEach(el => {
  el.addEventListener('input', () => {
    // Update sibling display span: id="slider-foo" → id="slider-foo-val"
    const display = document.getElementById(el.id + '-val');
    if (display) display.textContent = el.value;
    pushSliderParams();
  });
});

// ─── 7. LIVE MODE ────────────────────────────────────────────────────────────
const liveBtn = document.getElementById('btn-live');
if (liveBtn) {
  liveBtn.addEventListener('click', async () => {
    await initAudio();

    // Toggle off
    if (App.liveStream) {
      App.liveStream.getTracks().forEach(t => t.stop());
      App.liveSource?.disconnect();
      App.liveStream = null;
      App.liveSource  = null;
      liveBtn.textContent = 'Start Live';
      liveBtn.classList.remove('vip-btn--active');
      return;
    }

    try {
      App.liveStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation:  false,
          noiseSuppression:  false,
          autoGainControl:   false,
          sampleRate:        48000,
          channelCount:      1
        }
      });
      App.liveSource = App.ctx.createMediaStreamSource(App.liveStream);
      App.liveSource.connect(App.workletNode);
      liveBtn.textContent = 'Stop Live';
      liveBtn.classList.add('vip-btn--active');

      // Boot the ML worker once mic is confirmed live
      initMLWorker();
    } catch (err) {
      alert('Microphone access denied: ' + err.message);
    }
  });
}

// ─── 8. FILE LOAD (drag-drop + input) ────────────────────────────────────────
async function loadFile(file) {
  const sizeMB = file.size / (1024 * 1024);
  if (!checkFileSizeLimit(sizeMB)) {
    alert(
      `File too large for your ${session.tier} tier. ` +
      `Max: ${caps.maxFileSizeMB === Infinity ? 'unlimited' : caps.maxFileSizeMB + ' MB'}, ` +
      `got: ${sizeMB.toFixed(1)} MB.`
    );
    return;
  }

  const setStatus = msg => {
    const el = document.getElementById('pipelineStage');
    if (el) el.textContent = msg;
  };

  setStatus('Decoding…');
  try {
    const arrayBuffer = await file.arrayBuffer();
    const tmpCtx = new AudioContext();
    App.fileBuffer = await tmpCtx.decodeAudioData(arrayBuffer);
    await tmpCtx.close();

    drawWaveform(App.fileBuffer, 'inputCanvas');

    const srEl = document.getElementById('stat-sr');
    const chEl = document.getElementById('stat-channels');
    if (srEl) srEl.textContent = App.fileBuffer.sampleRate;
    if (chEl) chEl.textContent = App.fileBuffer.numberOfChannels;

    document.getElementById('btn-process')?.removeAttribute('disabled');
    setStatus('Ready');
  } catch (err) {
    setStatus('Decode error');
    console.error('[loadFile]', err);
  }
}

// Drag-drop
const dropzone = document.getElementById('dropzone');
if (dropzone) {
  ['dragenter', 'dragover'].forEach(ev =>
    dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('over'); })
  );
  ['dragleave', 'drop'].forEach(ev =>
    dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('over'); })
  );
  dropzone.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });
}

// File input button
document.getElementById('fileBtn')?.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) loadFile(file);
}, { capture: false });

// ─── 9. CREATOR / FORENSIC MODE (OfflineAudioContext) ───────────────────────
const processBtn = document.getElementById('btn-process');
if (processBtn) {
  processBtn.addEventListener('click', async () => {
    if (!App.fileBuffer) return;

    const setStage = s => {
      const el = document.getElementById('pipelineStage');
      if (el) el.textContent = s;
    };
    const fillBar = pct => {
      const el = document.getElementById('pipelineFill');
      if (el) el.style.width = pct + '%';
    };

    await initAudio();
    initMLWorker();
    incrementFileUsage();

    setStage('Rendering…'); fillBar(10);

    const { numberOfChannels, length, sampleRate } = App.fileBuffer;
    const offline = new OfflineAudioContext(numberOfChannels, length, sampleRate);

    await offline.audioWorklet.addModule('./dsp-processor.js');

    const offlineNode = new AudioWorkletNode(offline, 'dsp-processor', {
      numberOfInputs:     1,
      numberOfOutputs:    1,
      outputChannelCount: [numberOfChannels],
      processorOptions:   { inputSAB, outputSAB }
    });

    // Send current slider params to the offline worklet
    offlineNode.port.postMessage({ type: 'params', params: collectParams() });

    const src = offline.createBufferSource();
    src.buffer = App.fileBuffer;
    src.connect(offlineNode);
    offlineNode.connect(offline.destination);
    src.start(0);

    fillBar(40); setStage('DSP pass…');
    App.processedBuffer = await offline.startRendering();

    fillBar(100); setStage('Done ✓');
    drawWaveform(App.processedBuffer, 'outputCanvas');
    document.getElementById('btn-export')?.removeAttribute('disabled');
  });
}

// ─── 10. WAV EXPORT ──────────────────────────────────────────────────────────
document.getElementById('btn-export')?.addEventListener('click', () => {
  if (!App.processedBuffer) return;
  const wav = encodeWAV(App.processedBuffer);
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const a   = Object.assign(document.createElement('a'), {
    href:     url,
    download: 'voiceisolate-pro-output.wav'
  });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
});

// ─── 11. A/B TOGGLE ──────────────────────────────────────────────────────────
let abMode = 'processed';
document.getElementById('btn-ab')?.addEventListener('click', () => {
  abMode = abMode === 'processed' ? 'original' : 'processed';
  const buf = abMode === 'processed' ? App.processedBuffer : App.fileBuffer;
  if (!buf) return;
  drawWaveform(buf, 'outputCanvas');
  const el = document.getElementById('btn-ab');
  if (el) el.textContent = abMode === 'processed' ? 'A/B: Processed' : 'A/B: Original';
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function drawWaveform(buffer, canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx2d = canvas.getContext('2d');
  const data  = buffer.getChannelData(0);
  const W = canvas.width  || canvas.offsetWidth  || 512;
  const H = canvas.height || canvas.offsetHeight || 128;
  ctx2d.clearRect(0, 0, W, H);
  ctx2d.strokeStyle = '#dc2626';
  ctx2d.lineWidth   = 1;
  ctx2d.beginPath();
  const step = Math.ceil(data.length / W);
  for (let i = 0; i < W; i++) {
    let min = 1, max = -1;
    for (let j = 0; j < step; j++) {
      const v = data[i * step + j] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const yTop = ((1 - max) / 2) * H;
    const yBot = ((1 - min) / 2) * H;
    i === 0 ? ctx2d.moveTo(i, yTop) : ctx2d.lineTo(i, yTop);
    ctx2d.lineTo(i, yBot);
  }
  ctx2d.stroke();
}

function encodeWAV(buffer) {
  const numCh  = buffer.numberOfChannels;
  const sr     = buffer.sampleRate;
  const numSmp = buffer.length;
  const bitsPS = 16;
  const byteRate = sr * numCh * (bitsPS / 8);
  const dataLen  = numSmp * numCh * (bitsPS / 8);
  const ab   = new ArrayBuffer(44 + dataLen);
  const view = new DataView(ab);

  const w = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  w(0,  'RIFF'); view.setUint32(4,  36 + dataLen, true);
  w(8,  'WAVE'); w(12, 'fmt ');
  view.setUint32(16, 16,        true);
  view.setUint16(20, 1,         true);  // PCM
  view.setUint16(22, numCh,     true);
  view.setUint32(24, sr,        true);
  view.setUint32(28, byteRate,  true);
  view.setUint16(32, numCh * (bitsPS / 8), true);
  view.setUint16(34, bitsPS,    true);
  w(36, 'data'); view.setUint32(40, dataLen, true);

  let offset = 44;
  for (let i = 0; i < numSmp; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return ab;
}

// Expose App for DevTools inspection
window._VIPApp = App;

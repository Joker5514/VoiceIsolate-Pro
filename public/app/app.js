/**
 * VoiceIsolate Pro — app.js
 * Main thread orchestrator for the 32-stage Octa-Pass DSP pipeline.
 *
 * Architecture: Threads from Space v8
 *   • Live mode  : AudioWorklet (dsp-processor.js) + SharedArrayBuffer ring buffer
 *   • Creator mode: OfflineAudioContext + ml-worker.js for heavy ML
 *   • ONNX models : onnxruntime-web, WebGPU → WASM fallback
 *   • 52 sliders  : built by slider-map.js → dispatched via dispatchParam()
 *
 * Single-Pass Spectral Contract (MUST hold end-to-end):
 *   ONE forward STFT  (inside dsp-processor.js AudioWorklet)
 *   In-place spectral ops
 *   ONE inverse STFT  (inside dsp-processor.js AudioWorklet)
 *
 * No cloud APIs. 100% local processing.
 */

import { buildPanels, runAudit, dispatchParam, SLIDER_REGISTRY } from './slider-map.js';

// ---------------------------------------------------------------------------
// 1. Module-level state  (replaces any global window pollution where possible)
// ---------------------------------------------------------------------------
const VIP = {
  ctx: null,           // AudioContext
  sourceNode: null,    // MediaElementSourceNode | MediaStreamSourceNode
  workletNode: null,   // AudioWorkletNode (dsp-processor)
  mlWorker: null,      // Worker (ml-worker.js)
  onnxSessions: {},    // { modelKey: ort.InferenceSession }
  mode: 'idle',        // 'idle' | 'live' | 'creator' | 'forensic'
  initialized: false,
  sharedParams: null,  // SharedArrayBuffer view (Float32Array) if SAB available
};

// Expose for dispatchParam() lookups in slider-map.js
window._vipApp = VIP;

// ---------------------------------------------------------------------------
// 2. ONNX Runtime initialisation
// ---------------------------------------------------------------------------
async function initOnnxRuntime() {
  if (typeof ort === 'undefined') {
    console.warn('[VIP] onnxruntime-web not loaded. Skipping ONNX init.');
    return;
  }

  // Prefer WebGPU, fall back to WASM
  const hasWebGPU = !!(navigator.gpu);
  ort.env.executionProviders = hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'];

  // Point WASM binaries at the local lib/ directory (served as static assets)
  ort.env.wasm.wasmPaths = '/lib/';
  ort.env.wasm.numThreads = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
  ort.env.wasm.simd = true;

  console.info(`[VIP] ONNX Runtime ready. Provider: ${hasWebGPU ? 'WebGPU+WASM' : 'WASM'}, threads: ${ort.env.wasm.numThreads}`);
}

// Lazy-load an ONNX model session the first time it is needed.
async function getOnnxSession(modelKey, modelPath) {
  if (VIP.onnxSessions[modelKey]) return VIP.onnxSessions[modelKey];
  if (typeof ort === 'undefined') throw new Error('onnxruntime-web not available');
  try {
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ort.env.executionProviders,
      graphOptimizationLevel: 'all',
    });
    VIP.onnxSessions[modelKey] = session;
    console.info(`[VIP] Loaded ONNX model: ${modelKey}`);
    return session;
  } catch (err) {
    console.error(`[VIP] Failed to load model ${modelKey}:`, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 3. AudioContext + AudioWorklet setup
// ---------------------------------------------------------------------------
async function initAudioContext() {
  if (VIP.ctx && VIP.ctx.state !== 'closed') return;

  VIP.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });

  // AudioWorklet needs SharedArrayBuffer for safe cross-thread comms.
  // COOP/COEP headers (already set in vercel.json) enable SAB.
  const sabSize = 4096 * Float32Array.BYTES_PER_ELEMENT;
  if (typeof SharedArrayBuffer !== 'undefined') {
    const sab = new SharedArrayBuffer(sabSize);
    VIP.sharedParams = new Float32Array(sab);
    // Slot 0 = bypass flag (0 = process, 1 = bypass)
    // Slots 1-52 = per-slider values (written by main thread, read by worklet)
  }

  // Register the DSP worklet
  await VIP.ctx.audioWorklet.addModule('/app/dsp-processor.js');

  VIP.workletNode = new AudioWorkletNode(VIP.ctx, 'dsp-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      sampleRate: VIP.ctx.sampleRate,
      sharedParamsBuffer: VIP.sharedParams?.buffer ?? null,
    },
  });

  // Route worklet messages (metering, debug) back to the main thread
  VIP.workletNode.port.onmessage = handleWorkletMessage;

  console.info('[VIP] AudioWorklet loaded — dsp-processor.js');
}

function handleWorkletMessage({ data }) {
  if (!data) return;
  switch (data.type) {
    case 'meter':
      updateMeterUI(data.peak, data.rms);
      break;
    case 'stft_ready':
      // Worklet signals that the forward STFT frame is ready in SAB
      // Main thread can now run heavy ONNX inference and write results back
      runOnnxOnFrame(data);
      break;
    case 'log':
      console.debug('[worklet]', data.msg);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 4. ML Worker setup (heavy off-thread inference)
// ---------------------------------------------------------------------------
function initMlWorker() {
  if (VIP.mlWorker) return;
  VIP.mlWorker = new Worker('/app/ml-worker.js', { type: 'module' });
  VIP.mlWorker.onmessage = handleWorkerMessage;
  VIP.mlWorker.onerror = (e) => console.error('[VIP] ml-worker error:', e);

  // Send initial params so worker starts with correct values
  const initPayload = {};
  for (const s of SLIDER_REGISTRY) initPayload[s.key] = s.transform ? s.transform(getSliderValue(s.id)) : getSliderValue(s.id);
  VIP.mlWorker.postMessage({ type: 'init', params: initPayload });
}

function handleWorkerMessage({ data }) {
  if (!data) return;
  switch (data.type) {
    case 'result':
      // Worker completed ML processing for Creator mode; write result buffer back
      if (VIP.workletNode) {
        VIP.workletNode.port.postMessage({ type: 'ml_result', buffer: data.buffer }, [data.buffer]);
      }
      break;
    case 'progress':
      updateProgressUI(data.pct, data.label);
      break;
    case 'error':
      console.error('[ml-worker]', data.msg);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 5. Slider wiring (52 sliders → buildPanels from slider-map.js)
// ---------------------------------------------------------------------------
function initSliders() {
  // buildPanels injects .sr-row elements into the 8 tab panels defined in index.html
  buildPanels(document, (spec, rawVal, inputEl, valueEl) => {
    // Sync real-time sliders into the SharedArrayBuffer slot if available
    if (VIP.sharedParams && spec.rt) {
      const slotIdx = SLIDER_REGISTRY.findIndex(s => s.id === spec.id);
      if (slotIdx >= 0) VIP.sharedParams[slotIdx + 1] = rawVal; // slot 0 = bypass
    }
  });

  // Post-build audit (dev console only)
  const audit = runAudit(document);
  if (audit.fail > 0) {
    console.warn('[VIP] Slider audit FAILURES:', audit.checks);
  } else {
    console.info(`[VIP] Slider audit PASSED — ${audit.checks.sliderCount} sliders ready.`);
  }
}

// Helper: read the current numeric value of a built slider
function getSliderValue(sliderId) {
  const el = document.getElementById('sl_' + sliderId);
  return el ? parseFloat(el.value) : (window.VIP_PARAMS?.[sliderId] ?? 0);
}

// ---------------------------------------------------------------------------
// 6. Audio routing helpers
// ---------------------------------------------------------------------------
async function connectSource(sourceNode) {
  await resumeCtx();
  if (VIP.sourceNode) {
    try { VIP.sourceNode.disconnect(); } catch (_) {}
  }
  VIP.sourceNode = sourceNode;
  sourceNode.connect(VIP.workletNode);
  VIP.workletNode.connect(VIP.ctx.destination);
}

async function resumeCtx() {
  if (VIP.ctx?.state === 'suspended') await VIP.ctx.resume();
}

// ---------------------------------------------------------------------------
// 7. ONNX inference callback (called when worklet posts stft_ready)
// ---------------------------------------------------------------------------
async function runOnnxOnFrame(data) {
  // Heavy ONNX inference is delegated to the ml-worker to avoid audio dropout
  if (!VIP.mlWorker) return;
  VIP.mlWorker.postMessage(
    { type: 'infer', frameData: data.frameData, params: window.VIP_PARAMS },
    data.frameData ? [data.frameData.buffer] : []
  );
}

// ---------------------------------------------------------------------------
// 8. File upload (Creator mode)
// ---------------------------------------------------------------------------
function handleFileUpload(file) {
  if (!file || !file.type.startsWith('audio/')) {
    showToast('Please drop a valid audio file.', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      await ensureInit();
      const audioBuffer = await VIP.ctx.decodeAudioData(e.target.result.slice(0));
      // Creator mode: use OfflineAudioContext for non-real-time processing
      await processCreatorMode(audioBuffer);
    } catch (err) {
      console.error('[VIP] File decode error:', err);
      showToast('Failed to decode audio file.', 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

async function processCreatorMode(audioBuffer) {
  updateProgressUI(0, 'Starting Creator pipeline…');
  VIP.mode = 'creator';

  const offline = new OfflineAudioContext(
    audioBuffer.numberOfChannels,
    audioBuffer.length,
    audioBuffer.sampleRate
  );

  // Register worklet in offline context too
  await offline.audioWorklet.addModule('/app/dsp-processor.js');
  const offlineWorklet = new AudioWorkletNode(offline, 'dsp-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [audioBuffer.numberOfChannels],
    processorOptions: {
      sampleRate: offline.sampleRate,
      mode: 'offline',
      params: { ...window.VIP_PARAMS },
    },
  });

  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offlineWorklet);
  offlineWorklet.connect(offline.destination);
  src.start();

  const rendered = await offline.startRendering();
  updateProgressUI(100, 'Processing complete');
  VIP.mode = 'idle';

  // Offer rendered buffer for download
  exportBufferAsWav(rendered);
}

// ---------------------------------------------------------------------------
// 9. Live mic mode
// ---------------------------------------------------------------------------
async function startLiveMode() {
  try {
    await ensureInit();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const srcNode = VIP.ctx.createMediaStreamSource(stream);
    await connectSource(srcNode);
    VIP.mode = 'live';
    console.info('[VIP] Live mode active.');
    setModeUI('live');
  } catch (err) {
    console.error('[VIP] Mic access error:', err);
    showToast('Microphone access denied.', 'error');
  }
}

async function stopLiveMode() {
  if (VIP.sourceNode) {
    try { VIP.sourceNode.mediaStream?.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { VIP.sourceNode.disconnect(); } catch (_) {}
  }
  VIP.sourceNode = null;
  VIP.mode = 'idle';
  setModeUI('idle');
}

// ---------------------------------------------------------------------------
// 10. Initialisation gate — call once before any audio work
// ---------------------------------------------------------------------------
async function ensureInit() {
  if (VIP.initialized) {
    await resumeCtx();
    return;
  }
  await initOnnxRuntime();
  await initAudioContext();
  initMlWorker();
  VIP.initialized = true;
  window.__vipAppReady = true;
  window.dispatchEvent(new CustomEvent('app:ready'));
  console.info('[VIP] Pipeline initialised.');
}

// ---------------------------------------------------------------------------
// 11. WAV export utility
// ---------------------------------------------------------------------------
function exportBufferAsWav(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  const numSamples = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numCh * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const bufferSize = 44 + dataSize;
  const arrayBuf = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuf);

  function writeString(off, str) { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); }
  writeString(0, 'RIFF');
  view.setUint32(4, bufferSize - 8, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }

  const blob = new Blob([arrayBuf], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'voice-isolated-' + Date.now() + '.wav';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------
// 12. Minimal UI helpers (non-framework; integrates with existing style.css)
// ---------------------------------------------------------------------------
function updateMeterUI(peak, rms) {
  const peakEl = document.getElementById('meter-peak');
  const rmsEl = document.getElementById('meter-rms');
  if (peakEl) peakEl.style.setProperty('--level', `${Math.max(0, (peak + 60) / 60 * 100).toFixed(1)}%`);
  if (rmsEl)  rmsEl.style.setProperty('--level', `${Math.max(0, (rms  + 60) / 60 * 100).toFixed(1)}%`);
}

function updateProgressUI(pct, label) {
  const bar = document.getElementById('progress-bar');
  const lbl = document.getElementById('progress-label');
  if (bar) bar.style.width = `${pct}%`;
  if (lbl) lbl.textContent = label || '';
}

function setModeUI(mode) {
  document.querySelectorAll('[data-mode-indicator]').forEach(el => {
    el.dataset.activeMode = mode;
  });
  const liveDot = document.getElementById('live-indicator');
  if (liveDot) liveDot.classList.toggle('active', mode === 'live');
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container') ?? (() => {
    const el = document.createElement('div');
    el.id = 'toast-container';
    el.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;display:flex;flex-direction:column;gap:0.5rem';
    document.body.appendChild(el);
    return el;
  })();
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ---------------------------------------------------------------------------
// 13. Bypass toggle (pass-through during debug)
// ---------------------------------------------------------------------------
function setBypass(enabled) {
  if (VIP.sharedParams) VIP.sharedParams[0] = enabled ? 1 : 0;
  if (VIP.workletNode) VIP.workletNode.port.postMessage({ type: 'bypass', enabled });
}

// ---------------------------------------------------------------------------
// 14. DOM bootstrap — runs after DOMContentLoaded
// ---------------------------------------------------------------------------
function bootstrap() {
  // ---- Build 52 sliders into their tab panels ----
  initSliders();

  // ---- File drop zone ----
  const dropZone = document.getElementById('drop-zone');
  if (dropZone) {
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      handleFileUpload(e.dataTransfer.files[0]);
    });
  }

  // ---- File input fallback ----
  const fileInput = document.getElementById('file-input');
  if (fileInput) {
    fileInput.addEventListener('change', e => handleFileUpload(e.target.files[0]));
  }

  // ---- Live mode button ----
  const liveBtn = document.getElementById('btn-live');
  if (liveBtn) {
    liveBtn.addEventListener('click', async () => {
      if (VIP.mode === 'live') {
        await stopLiveMode();
        liveBtn.textContent = 'Start Live';
      } else {
        await startLiveMode();
        liveBtn.textContent = 'Stop Live';
      }
    });
  }

  // ---- Process (Creator) button ----
  const processBtn = document.getElementById('btn-process');
  if (processBtn) {
    processBtn.addEventListener('click', async () => {
      // Trigger file picker if no file loaded yet
      if (!fileInput?.files?.length) {
        fileInput?.click();
      }
    });
  }

  // ---- Bypass toggle ----
  const bypassBtn = document.getElementById('btn-bypass');
  if (bypassBtn) {
    let bypassed = false;
    bypassBtn.addEventListener('click', () => {
      bypassed = !bypassed;
      setBypass(bypassed);
      bypassBtn.classList.toggle('active', bypassed);
      bypassBtn.setAttribute('aria-pressed', String(bypassed));
    });
  }

  // ---- Initialise lazily on first user gesture (required for AudioContext) ----
  const initOnGesture = () => {
    ensureInit().catch(err => console.error('[VIP] Init error:', err));
    document.removeEventListener('click', initOnGesture);
    document.removeEventListener('keydown', initOnGesture);
  };
  document.addEventListener('click', initOnGesture, { once: true });
  document.addEventListener('keydown', initOnGesture, { once: true });

  console.info('[VIP] app.js bootstrap complete.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

// ---------------------------------------------------------------------------
// 15. Public API for console / test harness
// ---------------------------------------------------------------------------
export {
  VIP,
  ensureInit,
  startLiveMode,
  stopLiveMode,
  handleFileUpload,
  setBypass,
  getOnnxSession,
  exportBufferAsWav,
};

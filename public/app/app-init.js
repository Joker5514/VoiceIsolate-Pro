// ─────────────────────────────────────────────────────────────────────────────
//  app-init.js  —  VoiceIsolate Pro v24.0 / Threads from Space v12
//  app-init.js  —  VoiceIsolate Pro v24.0 · Threads from Space v12
//
//  Entry point wiring:
//    ① Auth gate (requireAuth)
//    ② SharedArrayBuffer allocation
//    ③ AudioContext + AudioWorklet (dsp-processor.js)
//    ④ ML Worker (ml-worker.js)
//    ⑤ 52-slider → WorkletNode param bridge
//    ⑥ Live mode (getUserMedia) + Creator/Forensic mode (OfflineAudioContext)
//    ⑦ RMS meter → UI level bar
//
//  Add to index.html:
//    <script type="module" src="./app-init.js"></script>
// ─────────────────────────────────────────────────────────────────────────────

import {
  requireAuth,
  getCaps,
  checkFileSizeLimit,
  checkFilesRemaining,
  incrementFileUsage,
  logout,
} from './auth.js';

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

const NUM_BINS       = 2049;          // (FFT_SIZE/2) + 1 — must match dsp-processor.js
const SAB_BYTE_SIZE  = (NUM_BINS + 4) * Float32Array.BYTES_PER_ELEMENT;
                                       // NUM_BINS floats + 4 Int32 flags
const MODEL_BASE     = './models/';    // served from public/app/models/
const WORKLET_PATH   = './dsp-processor.js';
const WORKER_PATH    = './ml-worker.js';

// ── Module-level state ───────────────────────────────────────────────────────────

let audioCtx     = null;   // AudioContext (Live mode)
let workletNode  = null;   // AudioWorkletNode
let mlWorker     = null;   // Web Worker
let inputSAB     = null;   // SharedArrayBuffer: DSP → ML
let outputSAB    = null;   // SharedArrayBuffer: ML → DSP
let liveStream   = null;   // MediaStream (microphone)
let liveSource   = null;   // MediaStreamAudioSourceNode
let session      = null;   // Auth session object
let caps         = null;   // Tier capabilities
let isLive       = false;  // Live mode active?

// Accumulated slider params — sent to worklet on every change
const sliderParams = {};

// ─────────────────────────────────────────────────────────────────────────────
//  ① Bootstrap — runs immediately on module load
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  // 1. Auth gate — blocks until login succeeds
  session = await requireAuth();
  caps    = getCaps(session.tier);

  // 2. Wire logout button if present
  document.getElementById('btn-logout')
    ?.addEventListener('click', logout);

  // 3. Allocate SharedArrayBuffers
  //    (requires COOP + COEP headers — already in vercel.json)
  inputSAB  = new SharedArrayBuffer(SAB_BYTE_SIZE);
  outputSAB = new SharedArrayBuffer(SAB_BYTE_SIZE);

  // 4. Spin up the ML Worker (if tier has any models)
  if (caps.mlModels.length > 0) {
    await initMLWorker();
  }

  // 5. Wire all 52 sliders
  wireSliders();

  // 6. Wire mode buttons
  wireModeButtons();

  // 7. Wire file drop / upload
  wireFileInput();

  // 8. Mark app as ready
  setStatus('ready', '🟢 Ready');
  console.info(
    `[VIP] Booted. Tier: ${session.tier} | ` +
    `Models: ${caps.mlModels.join(', ') || 'none'} | ` +
    `Max stages: ${caps.maxStages}`
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
//  ② AudioContext + AudioWorklet init
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates (or reuses) the AudioContext and loads the AudioWorklet module.
 * Must be called from a user-gesture handler (click) for autoplay policy.
 * Safe to call multiple times — no-ops if already initialized.
 */
async function ensureAudioContext() {
  if (audioCtx && audioCtx.state !== 'closed') {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    return;
  }

  audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });

  // Load the AudioWorkletProcessor
  await audioCtx.audioWorklet.addModule(WORKLET_PATH);

  // Create the worklet node (stereo in/out)
  workletNode = new AudioWorkletNode(audioCtx, 'dsp-processor', {
    numberOfInputs:    1,
    numberOfOutputs:   1,
    outputChannelCount:[2],
    processorOptions: {
      inputSAB,
      outputSAB,
    },
  });

  // Connect to speakers
  workletNode.connect(audioCtx.destination);

  // Listen to meter events from the processor
  workletNode.port.onmessage = handleWorkletMessage;

  // Push current slider state immediately
  sendParamsToWorklet();

  console.info('[VIP] AudioWorklet ready @ 48kHz');
}

// ─────────────────────────────────────────────────────────────────────────────
//  ③ ML Worker init
// ─────────────────────────────────────────────────────────────────────────────

async function initMLWorker() {
  return new Promise((resolve, reject) => {
    mlWorker = new Worker(WORKER_PATH);

    mlWorker.onmessage = (ev) => {
      const { type, modelId, models, error } = ev.data;

      if (type === 'ready') {
        // models is an object { modelId: bool } in v8 ml-worker
        const loadedIds = typeof models === 'object' && !Array.isArray(models)
          ? Object.keys(models).filter(k => models[k])
          : (Array.isArray(models) ? models : []);
        console.info(`[VIP] ML Worker ready. Sessions: ${loadedIds.join(', ') || 'none'}`);
        updateModelStatusUI(loadedIds);
        resolve();
      }
      if (type === 'model_loaded') {
        console.info(`[VIP] Model loaded: ${modelId}`);
        setModelBadge(modelId, 'loaded');
      }
      if (type === 'model_error') {
        console.warn(`[VIP] Model error: ${modelId} — ${error}`);
        setModelBadge(modelId, 'error');
      }
      if (type === 'log') {
        const { level, msg } = ev.data;
        console[level] ? console[level](`[ml-worker] ${msg}`) : console.warn(`[ml-worker] ${msg}`);
      }
    };

    mlWorker.onerror = (err) => {
      console.error('[VIP] ML Worker error:', err);
      reject(err);
    };

    // Send init payload with SABs and tier-gated model list
    mlWorker.postMessage({
      type: 'init',
      payload: {
        inputSAB,
        outputSAB,
        modelBasePath:      MODEL_BASE,
        preferredProviders: ['webgpu', 'wasm'],
        allowedModels:      caps.mlModels,
        allowedStages:      caps.maxStages,
      },
    });

    // Timeout safety: resolve after 30s even if models fail to load
    setTimeout(resolve, 30_000);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  ④ 52-Slider wiring
//
//  Each slider in index.html should carry:
//    data-param="paramName"      ← maps to this._params key in dsp-processor
//    data-min="0" data-max="1"   ← normalised range (0–1 or custom)
//
//  If a slider uses id="slider-{name}" convention instead of data-param,
//  we normalise the id to a camelCase param name automatically.
// ─────────────────────────────────────────────────────────────────────────────

// Full param → slider-id mapping for all 52 sliders (Engineer Mode v19)
// Keys = data-param or derived camelCase name; values = human label (for debugging)
const SLIDER_MAP = {
  // ─ Noise Tab ──────────────────────────────────────────────────────────────
  noiseReduce:       'Noise Reduction',
  spectralFloor:     'Spectral Floor',
  wienerAmount:      'Wiener Strength',
  gateThresh:        'Gate Threshold',
  gateRange:         'Gate Range',
  humReduce:         'Hum Reduction',
  humQ:              'Hum Notch Q',
  noiseLearnRate:    'Noise Learn Rate',
  noiseOverSub:      'Over-Subtraction',
  noiseSmoothing:    'Smoothing',
  // ─ Voice EQ Tab ───────────────────────────────────────────────────────
  hpfFreq:           'HP Filter Freq',
  lpfFreq:           'LP Filter Freq',
  hpfQ:              'HP Filter Q',
  lpfQ:              'LP Filter Q',
  presenceBoost:     'Presence Boost',
  warmthBoost:       'Warmth',
  airBoost:          'Air',
  bodyBoost:         'Body',
  lowMidCut:         'Low-Mid Cut',
  boxinessCut:       'Boxiness Cut',
  // ─ Dynamics Tab ───────────────────────────────────────────────────────
  compThresh:        'Compressor Threshold',
  compRatio:         'Compressor Ratio',
  compAttack:        'Compressor Attack',
  compRelease:       'Compressor Release',
  compKnee:          'Compressor Knee',
  compMakeup:        'Makeup Gain',
  limiterThresh:     'Limiter Threshold',
  limiterRelease:    'Limiter Release',
  expanderThresh:    'Expander Threshold',
  expanderRatio:     'Expander Ratio',
  // ─ Spectral Tab ───────────────────────────────────────────────────────
  spectralSubAmount: 'Spectral Sub Depth',
  spectralGateAlpha: 'Gate Attack',
  spectralGateBeta:  'Gate Release',
  dereverb:          'De-reverb',
  deverbDelay:       'Reverb Tail Delay',
  deessFreq:         'De-ess Frequency',
  deessThresh:       'De-ess Threshold',
  deessRatio:        'De-ess Ratio',
  harmonicEnhance:   'Harmonic Enhancement',
  harmonicOrder:     'Harmonic Order',
  // ─ ML / AI Tab ────────────────────────────────────────────────────────
  mlMaskStrength:    'ML Mask Strength',
  vadSensitivity:    'VAD Sensitivity',
  demucsStrength:    'Demucs Strength',
  voiceprintMatch:   'Voiceprint Match',
  rnnoiseBlend:      'RNNoise Blend',
  // ─ Output / FX Tab ────────────────────────────────────────────────────
  outGain:           'Output Gain',
  dryWet:            'Dry/Wet Mix',
  stereoWidth:       'Stereo Width',
  lufsTarget:        'LUFS Target',
  truePeakLimit:     'True Peak Limit',
  reverbSend:        'Reverb Send',
  delayTime:         'Delay Time',
  bypass:            'Bypass (master)',
};

function wireSliders() {
  // Attempt 1: elements with data-param attribute
  document.querySelectorAll('input[type="range"][data-param]').forEach(el => {
    const param = el.getAttribute('data-param');
    if (!SLIDER_MAP[param]) return;
    sliderParams[param] = parseFloat(el.value);
    el.addEventListener('input', () => {
      sliderParams[param] = parseFloat(el.value);
      sendParamsToWorklet();
      updateSliderValueDisplay(el, param);
    });
  });

  // Attempt 2: elements with id="slider-{kebab-name}" convention
  document.querySelectorAll('input[type="range"][id^="slider-"]').forEach(el => {
    const kebab = el.id.replace('slider-', '');
    const param = kebabToCamel(kebab);
    if (!SLIDER_MAP[param]) return;
    if (sliderParams[param] !== undefined) return; // already wired via data-param
    sliderParams[param] = parseFloat(el.value);
    el.addEventListener('input', () => {
      sliderParams[param] = parseFloat(el.value);
      sendParamsToWorklet();
      updateSliderValueDisplay(el, param);
    });
  });

  // Attempt 3: elements with id="{paramName}-slider" convention
  document.querySelectorAll('input[type="range"]').forEach(el => {
    const match = el.id?.match(/^(.+)-slider$/);
    if (!match) return;
    const param = kebabToCamel(match[1]);
    if (!SLIDER_MAP[param]) return;
    if (sliderParams[param] !== undefined) return;
    sliderParams[param] = parseFloat(el.value);
    el.addEventListener('input', () => {
      sliderParams[param] = parseFloat(el.value);
      sendParamsToWorklet();
      updateSliderValueDisplay(el, param);
    });
  });

  const count = Object.keys(sliderParams).length;
  console.info(`[VIP] Wired ${count} sliders`);
}

function sendParamsToWorklet() {
  if (!workletNode) return;
  workletNode.port.postMessage({ type: 'params', params: { ...sliderParams } });
}

function updateSliderValueDisplay(el, param) {
  // Look for a sibling or nearby <output> or <span data-value-for="paramName">
  const display =
    el.parentElement?.querySelector(`[data-value-for="${param}"]`) ||
    el.nextElementSibling;
  if (display && (display.tagName === 'OUTPUT' || display.tagName === 'SPAN')) {
    display.textContent = parseFloat(el.value).toFixed(2);
  }
}

function kebabToCamel(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────────
//  ⑤ Mode buttons
// ─────────────────────────────────────────────────────────────────────────────

function wireModeButtons() {
  // Live mode toggle (microphone)
  document.getElementById('btn-live-mode')
    ?.addEventListener('click', toggleLiveMode);

  // Creator mode (process uploaded file with OfflineAudioContext)
  document.getElementById('btn-creator-mode')
    ?.addEventListener('click', () => processOffline('creator'));

  // Forensic mode (ENTERPRISE only)
  document.getElementById('btn-forensic-mode')
    ?.addEventListener('click', () => processOffline('forensic'));

  // Bypass toggle
  document.getElementById('btn-bypass')
    ?.addEventListener('click', () => {
      sliderParams.bypass = !sliderParams.bypass;
      sendParamsToWorklet();
      document.getElementById('btn-bypass')
        ?.classList.toggle('active', sliderParams.bypass);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  ⑥ Live Mode (AudioWorklet + getUserMedia)
// ─────────────────────────────────────────────────────────────────────────────

async function toggleLiveMode() {
  if (isLive) {
    // Stop live mode
    liveSource?.disconnect();
    liveStream?.getTracks().forEach(t => t.stop());
    liveSource = null;
    liveStream = null;
    isLive = false;
    setStatus('ready', '🟢 Ready');
    document.getElementById('btn-live-mode')
      ?.classList.remove('active');
    return;
  }

  try {
    setStatus('loading', '⏳ Requesting mic…');

    // Initialise AudioContext on first user gesture
    await ensureAudioContext();

    liveStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate:       48000,
        channelCount:     2,
        echoCancellation: false,  // we handle this ourselves
        noiseSuppression: false,  // same
        autoGainControl:  false,
      },
    });

    liveSource = audioCtx.createMediaStreamSource(liveStream);
    liveSource.connect(workletNode);

    isLive = true;
    setStatus('live', '🔴 LIVE');
    document.getElementById('btn-live-mode')
      ?.classList.add('active');

    console.info('[VIP] Live mode active');
  } catch (err) {
    setStatus('error', '❌ Mic error');
    console.error('[VIP] getUserMedia failed:', err);
    showToast(`Microphone error: ${err.message}`, 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ⑦ Creator / Forensic Mode (OfflineAudioContext)
//
//  processOffline() decodes the user-loaded file, runs it through
//  the full offline pipeline, then returns an AudioBuffer for export.
//  The classical DSP is applied inline here (not via AudioWorklet),
//  since OfflineAudioContext runs faster-than-realtime.
// ─────────────────────────────────────────────────────────────────────────────

let _pendingFileBuffer = null; // Set by wireFileInput() when a file is loaded

async function processOffline(mode = 'creator') {
  if (mode === 'forensic' && session?.tier !== 'ENTERPRISE') {
    showToast('Forensic mode requires the ENTERPRISE plan.', 'error');
    return;
  }
  if (!_pendingFileBuffer) {
    showToast('Drop or select an audio file first.', 'warning');
    return;
  }

  if (!checkFilesRemaining()) {
    showToast('Monthly file limit reached. Upgrade your plan.', 'error');
    return;
  }

  setStatus('processing', '⏳ Processing…');

  try {
    // Decode to raw PCM
    const tempCtx  = new AudioContext({ sampleRate: 48000 });
    const decoded  = await tempCtx.decodeAudioData(_pendingFileBuffer.slice(0));
    await tempCtx.close();

    const sr          = decoded.sampleRate;
    const numChannels = decoded.numberOfChannels;
    const length      = decoded.length;

    // Create an OfflineAudioContext at the same sample rate
    const offlineCtx  = new OfflineAudioContext(numChannels, length, sr);

    // Load the AudioWorklet into the offline context too
    await offlineCtx.audioWorklet.addModule(WORKLET_PATH);

    const offlineWorklet = new AudioWorkletNode(offlineCtx, 'dsp-processor', {
      numberOfInputs:    1,
      numberOfOutputs:   1,
      outputChannelCount:[numChannels],
      processorOptions: {
        inputSAB,
        outputSAB,
      },
    });

    // Push current slider state into offline worklet
    offlineWorklet.port.postMessage({ type: 'params', params: { ...sliderParams } });

    const source = offlineCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineWorklet);
    offlineWorklet.connect(offlineCtx.destination);
    source.start(0);

    const rendered = await offlineCtx.startRendering();

    incrementFileUsage();
    setStatus('ready', '🟢 Done');
    showToast(`Processed — ${(length / sr).toFixed(1)}s audio ready.`, 'success');

    // Hand off to export module (exportWav is expected from the existing app.js)
    if (typeof window.exportWav === 'function') {
      window.exportWav(rendered, mode);
    } else {
      window._processedBuffer = rendered;
      console.info('[VIP] Rendered buffer stored at window._processedBuffer');
    }
  } catch (err) {
    setStatus('error', '❌ Processing failed');
    console.error('[VIP] Offline processing error:', err);
    showToast(`Processing failed: ${err.message}`, 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ⑧ File input wiring
// ─────────────────────────────────────────────────────────────────────────────

function wireFileInput() {
  const dropZone  = document.getElementById('drop-zone') ||
                    document.querySelector('.drop-zone, .upload-area');
  const fileInput = document.getElementById('file-input') ||
                    document.querySelector('input[type="file"]');

  async function handleFile(file) {
    if (!file) return;

    const sizeMB = file.size / (1024 * 1024);
    if (!checkFileSizeLimit(sizeMB)) {
      showToast(
        `File too large (${sizeMB.toFixed(1)} MB). ` +
        `Your tier allows ${caps.maxFileSizeMB} MB max.`,
        'error'
      );
      return;
    }

    _pendingFileBuffer = await file.arrayBuffer();
    setFileLabel(file.name, sizeMB);
    showToast(`Loaded: ${file.name}`, 'success');
  }

  fileInput?.addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });

  if (dropZone) {
    dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop',      (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      handleFile(e.dataTransfer.files[0]);
    });
  }
}

function setFileLabel(name, sizeMB) {
  const label = document.getElementById('file-label') ||
                document.querySelector('.file-name, .drop-label');
  if (label) label.textContent = `${name} (${sizeMB.toFixed(1)} MB)`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ⑨ Worklet message handler (meter / RMS → UI)
// ─────────────────────────────────────────────────────────────────────────────

function handleWorkletMessage(ev) {
  const { type, rms, frame } = ev.data;

  if (type === 'meter') {
    updateLevelMeter(rms);
  }
}

function updateLevelMeter(rms) {
  // Convert RMS → dBFS
  const db  = rms > 0 ? 20 * Math.log10(rms) : -96;
  const pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100)); // -60dBFS = 0%, 0dBFS = 100%

  const bar = document.getElementById('level-bar') ||
              document.querySelector('.meter-fill, .level-meter-fill');
  if (bar) {
    bar.style.width  = `${pct}%`;
    bar.style.background =
      pct > 90 ? '#ef4444' :
      pct > 70 ? '#f59e0b' : '#10b981';
  }

  const dbDisplay = document.getElementById('level-db');
  if (dbDisplay) dbDisplay.textContent = `${db.toFixed(1)} dBFS`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ⑩ UI utilities
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_MAP = {
  ready:      { icon: '🟢', cls: 'status-ready'      },
  live:       { icon: '🔴', cls: 'status-live'       },
  loading:    { icon: '⏳', cls: 'status-loading'    },
  processing: { icon: '⏳', cls: 'status-processing' },
  error:      { icon: '❌', cls: 'status-error'      },
};

function setStatus(state, text) {
  const el = document.getElementById('status-indicator') ||
             document.querySelector('.status-badge, .pipeline-status');
  if (!el) return;
  Object.values(STATUS_MAP).forEach(s => el.classList.remove(s.cls));
  const s = STATUS_MAP[state];
  if (s) el.classList.add(s.cls);
  el.textContent = text || (s ? `${s.icon} ${state}` : state);
}

function showToast(message, type = 'info') {
  const existing = document.getElementById('vip-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'vip-toast';
  const colors = { success: '#10b981', error: '#ef4444', warning: '#f59e0b', info: '#6366f1' };
  toast.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; z-index: 99998;
    background: ${colors[type] || colors.info};
    color: #fff; padding: 12px 20px; border-radius: 10px;
    font-family: system-ui; font-size: 0.9rem; font-weight: 600;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    animation: vip-toast-in 0.3s ease;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function updateModelStatusUI(loadedModels) {
  loadedModels.forEach(id => setModelBadge(id, 'loaded'));
}

function setModelBadge(modelId, state) {
  const el = document.querySelector(
    `[data-model="${modelId}"], #model-${modelId}, #badge-${modelId}`
  );
  if (!el) return;
  el.classList.remove('model-loading', 'model-loaded', 'model-error');
  el.classList.add(`model-${state}`);
  el.title = `${modelId}: ${state}`;
}

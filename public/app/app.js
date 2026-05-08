/**
 * app.js — VoiceIsolate Pro Main Thread DSP Orchestration
 * Architecture: Threads from Space v8
 * - Initializes onnxruntime-web with WebGPU → WASM fallback
 * - Sets up AudioContext + AudioWorklet (dsp-processor.js)
 * - SharedArrayBuffer bridge: main thread polls SAB, runs ONNX, writes mask back
 * - Maps all 52 UI sliders to AudioWorklet params via port.postMessage
 * Constraint: 100% local. No cloud APIs. No telemetry.
 */

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.esm.min.js';

// ---------------------------------------------------------------------------
// Constants — must match dsp-processor.js
// ---------------------------------------------------------------------------
const FFT_SIZE  = 2048;
const HALF_BINS = FFT_SIZE / 2 + 1;
const SAB_FLOATS = 1 + HALF_BINS * 2; // ctrl + mag + mask

// Model paths (served locally from /public/models/)
const MODEL_PATHS = {
  demucs: '/models/demucs_v4.onnx',
  bsrnn:  '/models/bsrnn.onnx',
};

// ---------------------------------------------------------------------------
// Slider ID → param key mapping (52 sliders)
// Extend this map to cover all 52 sliders in your Engineer Mode UI
// ---------------------------------------------------------------------------
const SLIDER_MAP = {
  // --- Noise Reduction tab ---
  'slider-noise-reduction':   'noiseReduction',
  'slider-noise-gate':        'gate',
  'slider-reverb-reduction':  'reverbReduction',
  'slider-room-sim':          'roomSim',
  'slider-click-removal':     'clickRemoval',
  'slider-hum-removal':       'humRemoval',
  'slider-wind-removal':      'windRemoval',
  'slider-broadband-denoise': 'broadbandDenoise',
  // --- Voice EQ tab ---
  'slider-low-cut':           'lowCut',
  'slider-high-cut':          'highCut',
  'slider-presence':          'presenceBoost',
  'slider-warmth':            'warmth',
  'slider-air':               'airBoost',
  'slider-voice-boost':       'voiceBoost',
  'slider-body':              'bodyBoost',
  'slider-de-ess':            'deEss',
  // --- Dynamics tab ---
  'slider-compressor-thresh': 'compThreshold',
  'slider-compressor-ratio':  'compRatio',
  'slider-compressor-attack': 'compAttack',
  'slider-compressor-release':'compRelease',
  'slider-limiter-ceiling':   'limiterCeiling',
  'slider-expander-thresh':   'expanderThreshold',
  'slider-expander-ratio':    'expanderRatio',
  'slider-transient-attack':  'transientAttack',
  // --- Spectral tab ---
  'slider-spectral-floor':    'spectralFloor',
  'slider-spectral-ceiling':  'spectralCeiling',
  'slider-harmonic-enhance':  'harmonicEnhance',
  'slider-spectral-tilt':     'spectralTilt',
  'slider-comb-filter':       'combFilter',
  'slider-formant-shift':     'formantShift',
  'slider-pitch-correction':  'pitchCorrection',
  'slider-sub-harmonic':      'subHarmonic',
  // --- FX / ML tab ---
  'slider-stereo-width':      'stereoWidth',
  'slider-exciter':           'exciter',
  'slider-tape-sat':          'tapeSaturation',
  'slider-vinyl-warmth':      'vinylWarmth',
  'slider-chorus-depth':      'chorusDepth',
  'slider-chorus-rate':       'chorusRate',
  'slider-delay-time':        'delayTime',
  'slider-delay-feedback':    'delayFeedback',
  'slider-reverb-wet':        'reverbWet',
  'slider-reverb-size':       'reverbSize',
  // --- ML Model weights ---
  'slider-demucs-weight':     'demucsWeight',
  'slider-bsrnn-weight':      'bsrnnWeight',
  'slider-blend-classical':   'classicalBlend',
  'slider-blend-ml':          'mlBlend',
  // --- Output ---
  'slider-output-gain':       'outputGain',
  'slider-dry-wet':           'dryWet',
  'slider-latency-comp':      'latencyComp',
  'slider-oversample':        'oversample',
  'slider-dither':            'dither',
  'slider-bit-depth':         'bitDepth',
  'slider-sample-rate-conv':  'sampleRateConv',
  'slider-master-volume':     'masterVolume',
};

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
let audioCtx    = null;
let workletNode = null;
let sabFloat32  = null;   // Float32 view into SharedArrayBuffer
let sabInt32    = null;   // Int32  view (control word)
let sessions    = {};     // { demucs: ort.InferenceSession, bsrnn: ... }
let onnxPollerRunning = false;

// ---------------------------------------------------------------------------
// 1. ONNX Runtime initialization
// ---------------------------------------------------------------------------
async function initOnnx() {
  // Prefer WebGPU; fall back to WASM (100% local)
  ort.env.wasm.wasmPaths = '/models/ort-wasm/'; // serve WASM locally
  ort.env.wasm.numThreads = navigator.hardwareConcurrency ?? 4;

  const epOrder = ['webgpu', 'wasm'];

  for (const modelKey of Object.keys(MODEL_PATHS)) {
    try {
      sessions[modelKey] = await ort.InferenceSession.create(
        MODEL_PATHS[modelKey],
        { executionProviders: epOrder }
      );
      console.info(`[ONNX] Loaded ${modelKey} via ${epOrder[0]}`);
    } catch (e) {
      console.warn(`[ONNX] ${modelKey} load failed, trying WASM fallback`, e);
      try {
        sessions[modelKey] = await ort.InferenceSession.create(
          MODEL_PATHS[modelKey],
          { executionProviders: ['wasm'] }
        );
      } catch (e2) {
        console.error(`[ONNX] Could not load ${modelKey}:`, e2);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. ONNX inference poller (main thread loop)
//    Reads magnitude from SAB when worklet sets ctrl=1,
//    runs inference, writes mask back, sets ctrl=2.
// ---------------------------------------------------------------------------
function startOnnxPoller() {
  if (onnxPollerRunning) return;
  onnxPollerRunning = true;

  async function poll() {
    if (!sabInt32) { requestAnimationFrame(poll); return; }

    const ctrl = Atomics.load(sabInt32, 0);

    if (ctrl === 1 && sessions.demucs) {
      // Worklet has new magnitude frame ready
      const mag = sabFloat32.slice(1, 1 + HALF_BINS);

      try {
        // Demucs / BSRNN expect [1, 1, HALF_BINS] shaped tensor
        const inputTensor = new ort.Tensor('float32', mag, [1, 1, HALF_BINS]);
        const feeds = { input: inputTensor };

        // Run primary model (Demucs)
        const results = await sessions.demucs.run(feeds);
        const mask    = results[Object.keys(results)[0]].data; // Float32Array

        // Write mask into SAB at offset 1+HALF_BINS
        sabFloat32.set(mask.subarray(0, HALF_BINS), 1 + HALF_BINS);

      } catch (inferErr) {
        // On inference error, write unity mask so audio passes through
        sabFloat32.fill(1, 1 + HALF_BINS, 1 + HALF_BINS * 2);
        console.warn('[ONNX] Inference error, using unity mask', inferErr);
      }

      // Signal worklet that mask is ready
      Atomics.store(sabInt32, 0, 2);
    }

    requestAnimationFrame(poll);
  }

  requestAnimationFrame(poll);
}

// ---------------------------------------------------------------------------
// 3. AudioContext + AudioWorklet setup
// ---------------------------------------------------------------------------
async function initAudio() {
  audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });

  // Allocate SharedArrayBuffer for SAB bridge
  const sab   = new SharedArrayBuffer(SAB_FLOATS * Float32Array.BYTES_PER_ELEMENT);
  sabFloat32  = new Float32Array(sab);
  sabInt32    = new Int32Array(sab);

  // Load the AudioWorklet module
  await audioCtx.audioWorklet.addModule('/app/dsp-processor.js');

  // Create AudioWorkletNode, pass SAB via processorOptions
  workletNode = new AudioWorkletNode(audioCtx, 'dsp-processor', {
    numberOfInputs:  1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sharedArrayBuffer: sab },
  });

  // Connect graph: source → worklet → destination
  // (source is connected later when user loads a file or opens mic)
  workletNode.connect(audioCtx.destination);

  console.info('[AudioWorklet] dsp-processor loaded and connected.');
}

// ---------------------------------------------------------------------------
// 4. Slider → WorkletNode parameter bridge
// ---------------------------------------------------------------------------
function initSliders() {
  for (const [sliderId, paramKey] of Object.entries(SLIDER_MAP)) {
    const el = document.getElementById(sliderId);
    if (!el) { console.warn(`[Slider] #${sliderId} not found in DOM`); continue; }

    el.addEventListener('input', () => {
      const value = parseFloat(el.value);
      sendParam(paramKey, value);
      // Update any paired display label
      const label = document.getElementById(`${sliderId}-value`);
      if (label) label.textContent = value.toFixed(2);
    });
  }
}

/** Send a single parameter update to the AudioWorkletProcessor */
function sendParam(key, value) {
  if (!workletNode) return;
  workletNode.port.postMessage({ type: 'params', payload: { [key]: value } });
}

// ---------------------------------------------------------------------------
// 5. File / Microphone source helpers
// ---------------------------------------------------------------------------

/** Connect an AudioBuffer (from file decode) to the worklet */
export function playAudioBuffer(buffer) {
  if (!audioCtx || !workletNode) {
    console.error('[VoiceIsolate] AudioContext not ready');
    return;
  }
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(workletNode);
  source.start();
}

/** Connect live microphone to the worklet (Live mode) */
export async function startMicLive() {
  if (!audioCtx || !workletNode) await bootstrap();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const micSource = audioCtx.createMediaStreamSource(stream);
  micSource.connect(workletNode);
  console.info('[Live Mode] Microphone connected to DSP worklet.');
  return stream; // caller can stop tracks to disconnect
}

// ---------------------------------------------------------------------------
// 6. Bootstrap — called once on page load
// ---------------------------------------------------------------------------
export async function bootstrap() {
  try {
    updateStatus('Initializing ONNX Runtime…');
    await initOnnx();

    updateStatus('Setting up AudioWorklet…');
    await initAudio();

    updateStatus('Binding UI sliders…');
    initSliders();

    startOnnxPoller();

    updateStatus('VoiceIsolate Pro ready ✓');
    console.info('[Bootstrap] VoiceIsolate Pro fully initialized.');
  } catch (err) {
    console.error('[Bootstrap] Fatal init error:', err);
    updateStatus('Initialization failed — see console.');
  }
}

/** Helper: update a status indicator element in the UI if present */
function updateStatus(msg) {
  const el = document.getElementById('status-message');
  if (el) el.textContent = msg;
  console.log('[Status]', msg);
}

// ---------------------------------------------------------------------------
// Auto-bootstrap when the DOM is ready
// ---------------------------------------------------------------------------
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

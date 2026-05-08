/**
 * app.js — VoiceIsolate Pro Main Thread DSP Orchestration
 * Architecture: Threads from Space v8
 * - Spawns ml-worker.js (Web Worker) for off-thread ONNX inference
 * - Sets up AudioContext + AudioWorklet (dsp-processor.js)
 * - SharedArrayBuffer bridge: worklet writes magnitude → ml-worker infers → mask returned
 * - Maps all 54 UI sliders to AudioWorklet params via port.postMessage
 * Constraint: 100% local. No cloud APIs. No CDN imports. No telemetry.
 */

// ─── No CDN imports. ORT is loaded inside ml-worker.js via /lib/ort.min.js ──

// ---------------------------------------------------------------------------
// Constants — must match dsp-processor.js
// ---------------------------------------------------------------------------
const FFT_SIZE  = 2048;
const HALF_BINS = FFT_SIZE / 2 + 1;    // 1025
const SAB_FLOATS = 1 + HALF_BINS * 2;  // ctrl + mag + mask

// ---------------------------------------------------------------------------
// Slider ID → param key mapping (54 sliders)
// ---------------------------------------------------------------------------
const SLIDER_MAP = {
  // --- Noise Reduction ---
  'slider-noise-reduction':   'noiseReduction',
  'slider-noise-gate':        'gate',
  'slider-reverb-reduction':  'reverbReduction',
  'slider-room-sim':          'roomSim',
  'slider-click-removal':     'clickRemoval',
  'slider-hum-removal':       'humRemoval',
  'slider-wind-removal':      'windRemoval',
  'slider-broadband-denoise': 'broadbandDenoise',
  // --- Voice EQ ---
  'slider-low-cut':           'lowCut',
  'slider-high-cut':          'highCut',
  'slider-presence':          'presenceBoost',
  'slider-warmth':            'warmth',
  'slider-air':               'airBoost',
  'slider-voice-boost':       'voiceBoost',
  'slider-body':              'bodyBoost',
  'slider-de-ess':            'deEss',
  // --- Dynamics ---
  'slider-compressor-thresh': 'compThreshold',
  'slider-compressor-ratio':  'compRatio',
  'slider-compressor-attack': 'compAttack',
  'slider-compressor-release':'compRelease',
  'slider-limiter-ceiling':   'limiterCeiling',
  'slider-expander-thresh':   'expanderThreshold',
  'slider-expander-ratio':    'expanderRatio',
  'slider-transient-attack':  'transientAttack',
  // --- Spectral ---
  'slider-spectral-floor':    'spectralFloor',
  'slider-spectral-ceiling':  'spectralCeiling',
  'slider-harmonic-enhance':  'harmonicEnhance',
  'slider-spectral-tilt':     'spectralTilt',
  'slider-comb-filter':       'combFilter',
  'slider-formant-shift':     'formantShift',
  'slider-pitch-correction':  'pitchCorrection',
  'slider-sub-harmonic':      'subHarmonic',
  // --- FX / ML ---
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
let mlWorker    = null;   // Web Worker running ml-worker.js
let mlReady     = false;  // true once worker sends { type: 'ready' }

// Pending SAB magnitude frames queued before ml-worker is ready
const _pendingFrames = [];

// ---------------------------------------------------------------------------
// 1. ML Worker — spawn ml-worker.js and wire SAB magnitude forwarding
// ---------------------------------------------------------------------------
function spawnMlWorker() {
  if (mlWorker) return;

  mlWorker = new Worker('/app/ml-worker.js');

  mlWorker.onmessage = (ev) => {
    const { type } = ev.data || {};

    if (type === 'ready') {
      mlReady = true;
      updateStatus('ML worker ready ✓');

      // Forward any frames that arrived before the worker was ready
      for (const frame of _pendingFrames) _forwardFrameToWorker(frame);
      _pendingFrames.length = 0;

      // Hand the worker the SAB so it can poll directly (optional fast-path)
      if (sabFloat32 && sabInt32) {
        mlWorker.postMessage({
          type: 'init',
          payload: {
            inputSAB:  sabFloat32.buffer,
            outputSAB: sabFloat32.buffer,
            fftSize:   FFT_SIZE,
            halfN:     HALF_BINS,
            sampleRate: audioCtx ? audioCtx.sampleRate : 48000,
            allowedModels: ['demucs', 'bsrnn', 'rnnoise', 'vad'],
            allowedStages: 14,
          },
        });
      }
    } else if (type === 'mask') {
      // Write returned mask into SAB so the AudioWorklet can apply it
      const { mask } = ev.data;
      if (mask && sabFloat32) {
        sabFloat32.set(mask.subarray(0, HALF_BINS), 1 + HALF_BINS);
        Atomics.store(sabInt32, 0, 2); // signal worklet: mask ready
      }
    } else if (type === 'error') {
      console.warn('[ML Worker]', ev.data.message || ev.data.msg);
    }
  };

  mlWorker.onerror = (err) => {
    console.error('[ML Worker] Fatal error:', err.message);
    updateStatus('ML worker error — falling back to classical DSP');
  };
}

/** Forward a magnitude frame to the ML worker via postMessage (Transferable). */
function _forwardFrameToWorker(mag) {
  if (!mlWorker || !mlReady) { _pendingFrames.push(mag); return; }
  const copy = new Float32Array(mag);
  mlWorker.postMessage({ type: 'infer', model: 'demucs', mag: copy }, [copy.buffer]);
}

// ---------------------------------------------------------------------------
// 2. AudioContext + AudioWorklet setup
// ---------------------------------------------------------------------------
async function initAudio() {
  audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });

  // Allocate SharedArrayBuffer for SAB bridge
  const sab  = new SharedArrayBuffer(SAB_FLOATS * Float32Array.BYTES_PER_ELEMENT);
  sabFloat32 = new Float32Array(sab);
  sabInt32   = new Int32Array(sab);

  // Load the AudioWorklet module (only pipeline-orchestrator.js may also do this
  // if the full pipeline is active — this path is used for direct mic/file mode)
  await audioCtx.audioWorklet.addModule('/app/dsp-processor.js');

  workletNode = new AudioWorkletNode(audioCtx, 'dsp-processor', {
    numberOfInputs:  1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sharedArrayBuffer: sab },
  });

  // Relay magnitude frames from the worklet to the ML worker
  workletNode.port.onmessage = (ev) => {
    if (ev.data && ev.data.type === 'magnitude' && ev.data.mag) {
      _forwardFrameToWorker(ev.data.mag);
    }
  };

  workletNode.connect(audioCtx.destination);
  console.info('[AudioWorklet] dsp-processor loaded and connected.');
}

// ---------------------------------------------------------------------------
// 3. Slider → WorkletNode parameter bridge
// ---------------------------------------------------------------------------
function initSliders() {
  for (const [sliderId, paramKey] of Object.entries(SLIDER_MAP)) {
    const el = document.getElementById(sliderId);
    if (!el) { console.warn(`[Slider] #${sliderId} not found in DOM`); continue; }

    el.addEventListener('input', () => {
      const value = parseFloat(el.value);
      sendParam(paramKey, value);
      const label = document.getElementById(`${sliderId}-value`);
      if (label) label.textContent = value.toFixed(2);
    });
  }
}

/** Send a single parameter update to the AudioWorkletProcessor and ML worker */
function sendParam(key, value) {
  if (workletNode) {
    workletNode.port.postMessage({ type: 'params', payload: { [key]: value } });
  }
  if (mlWorker && mlReady) {
    mlWorker.postMessage({ type: 'setParams', payload: { [key]: value } });
  }
}

// ---------------------------------------------------------------------------
// 4. File / Microphone source helpers
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
  return stream;
}

// ---------------------------------------------------------------------------
// 5. Creator / Forensic mode — offline single-pass pipeline
//    Uses OfflineAudioContext + single STFT → spectral ops → iSTFT
//    Architecture constraint: exactly ONE forward FFT and ONE iFFT per path.
// ---------------------------------------------------------------------------

/**
 * Process an AudioBuffer through the full offline pipeline.
 * Single-pass: OfflineAudioContext renders time-domain processing,
 * then one forward STFT → spectral operations → one iSTFT.
 *
 * @param {AudioBuffer} audioBuffer — decoded source
 * @param {Object}      params      — slider values (from SLIDER_MAP)
 * @returns {Promise<AudioBuffer>}
 */
export async function processOffline(audioBuffer, params = {}) {
  const { sampleRate, length, numberOfChannels } = audioBuffer;
  const p = { ...params };

  // ── Stage 1: OfflineAudioContext rendering (time-domain stages) ──────────
  const offCtx = new OfflineAudioContext(numberOfChannels, length, sampleRate);
  const src     = offCtx.createBufferSource();
  src.buffer    = audioBuffer;

  // HP filter (low-cut)
  const hpFilter = offCtx.createBiquadFilter();
  hpFilter.type = 'highpass';
  hpFilter.frequency.value = Math.max(20, parseFloat(p.lowCut) || 80);
  hpFilter.Q.value = 0.707;

  // LP filter (high-cut)
  const lpFilter = offCtx.createBiquadFilter();
  lpFilter.type = 'lowpass';
  lpFilter.frequency.value = Math.min(sampleRate / 2 - 1, parseFloat(p.highCut) || 16000);
  lpFilter.Q.value = 0.707;

  // Dynamics compressor
  const comp = offCtx.createDynamicsCompressor();
  comp.threshold.value = parseFloat(p.compThreshold) || -24;
  comp.ratio.value     = parseFloat(p.compRatio)     || 4;
  comp.attack.value    = (parseFloat(p.compAttack)   || 10)  / 1000;
  comp.release.value   = (parseFloat(p.compRelease)  || 100) / 1000;
  comp.knee.value      = 6;

  // Output gain
  const gainNode = offCtx.createGain();
  gainNode.gain.value = Math.pow(10, (parseFloat(p.outputGain) || 0) / 20);

  src.connect(hpFilter);
  hpFilter.connect(lpFilter);
  lpFilter.connect(comp);
  comp.connect(gainNode);
  gainNode.connect(offCtx.destination);
  src.start(0);

  const rendered = await offCtx.startRendering();

  // ── Stage 2: Single-pass spectral processing ─────────────────────────────
  // Use DSP global from dsp-core.js when available; otherwise bypass.
  const DSP = (typeof window !== 'undefined' && window.DSP) ? window.DSP : null;
  if (!DSP || typeof DSP.forwardSTFT !== 'function') {
    // dsp-core not loaded in this execution context — return time-domain result
    console.warn('[processOffline] DSP core not available; returning time-domain output');
    return rendered;
  }

  const noiseReduce   = Math.max(0, Math.min(1, (parseFloat(p.noiseReduction) || 50) / 100));
  const spectralFloor = Math.max(0, Math.min(0.05, (parseFloat(p.spectralFloor) || 5) / 1000));
  const dryWet        = Math.max(0, Math.min(1,  (parseFloat(p.dryWet)        || 100) / 100));

  // Process each channel independently through single STFT pass
  const outCtx    = new OfflineAudioContext(numberOfChannels, length, sampleRate);
  const outBuffer = outCtx.createBuffer(numberOfChannels, length, sampleRate);

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const pcm = rendered.getChannelData(ch);

    // ── ONE forward STFT ──────────────────────────────────────────────────
    const spectral = DSP.forwardSTFT(pcm);

    // ── In-place spectral operations ──────────────────────────────────────
    // Wiener noise reduction
    if (noiseReduce > 0 && spectral.magnitude) {
      const mag  = spectral.magnitude;
      const nLen = mag.length;
      // Estimate noise floor as 10th-percentile magnitude across spectrum
      const sorted = mag.slice().sort();
      const noiseFloor = sorted[Math.floor(nLen * 0.10)] * (1 + noiseReduce);
      for (let k = 0; k < nLen; k++) {
        const snr  = mag[k] / Math.max(noiseFloor, 1e-9);
        const gain = Math.max(spectralFloor, Math.min(1, snr / (snr + 1)));
        if (spectral.real) spectral.real[k] *= gain;
        if (spectral.imag) spectral.imag[k] *= gain;
        if (spectral.magnitude) spectral.magnitude[k] *= gain;
      }
    }

    // ── ONE inverse STFT ─────────────────────────────────────────────────
    const processedPcm = DSP.inverseSTFT(spectral);

    // Dry/wet mix
    const outData = outBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const dry = pcm[i] || 0;
      const wet = processedPcm[i] || 0;
      outData[i] = dry * (1 - dryWet) + wet * dryWet;
    }
  }

  return outBuffer;
}

// ---------------------------------------------------------------------------
// 6. Bootstrap — called once on page load
// ---------------------------------------------------------------------------
export async function bootstrap() {
  try {
    updateStatus('Spawning ML worker…');
    spawnMlWorker();

    updateStatus('Setting up AudioWorklet…');
    await initAudio();

    updateStatus('Binding UI sliders…');
    initSliders();

    updateStatus('VoiceIsolate Pro ready ✓');
    console.info('[Bootstrap] VoiceIsolate Pro fully initialized.');
  } catch (err) {
    console.error('[Bootstrap] Fatal init error:', err);
    updateStatus('Initialization failed — see console.');
  }
}

/** Update a status indicator element in the UI if present */
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

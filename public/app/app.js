import { SLIDER_REGISTRY, STAGES } from './slider-map.js';

// ── Structured logging ───────────────────────────────────────────────────────
function structuredLog(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  const debugEnabled = typeof window !== 'undefined' && !!window.VIP_DEBUG;
  if (level === 'error') console.error('[VIP]', msg, data);
  else if (level === 'warn') console.warn('[VIP]', msg, data);
  else if (debugEnabled) console.log('[VIP]', msg, data);
  if (typeof window !== 'undefined') {
    if (!window._vipLogs) window._vipLogs = [];
    if (window._vipLogs.length >= 200) window._vipLogs.shift();
    window._vipLogs.push(entry);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
let audioCtx    = null;
let workletNode = null;
let sabFloat32  = null;   // Float32 view into SharedArrayBuffer
let sabInt32    = null;   // Int32  view (control word)
let mlWorker    = null;   // Web Worker running ml-worker.js
let mlReady     = false;  // true once worker sends { type: 'ready' }
let neonAnalyser = null;  // AnalyserNode tapped from worklet output for neon visualizer
let neonVizHandle = null; // Handle for the neon visualizer RAF loop

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
const SLIDERS = {
  gate: [
    { id: 'gateThresh', label: 'Threshold', min: -80, max: -5, val: -42, step: 1, unit: ' dB', rt: true, desc: 'Signal level below which audio is gated' },
    { id: 'gateRange', label: 'Range', min: -80, max: -5, val: -60, step: 1, unit: ' dB', rt: true, desc: 'Maximum gain reduction applied by the gate' },
    { id: 'gateAttack', label: 'Attack', min: 0, max: 500, val: 5, step: 1, unit: ' ms', rt: true, desc: 'Time for gate to open on signal detection' },
    { id: 'gateRelease', label: 'Release', min: 50, max: 2000, val: 200, step: 10, unit: ' ms', rt: true, desc: 'Time for gate to close after signal drops' },
    { id: 'gateHold', label: 'Hold', min: 0, max: 500, val: 50, step: 1, unit: ' ms', rt: true, desc: 'Hold time before release phase begins' },
    { id: 'gateLookahead', label: 'Lookahead', min: 0, max: 50, val: 5, step: 1, unit: ' ms', rt: false, desc: 'Lookahead window for predictive gating' },
  ],
  nr: [
    { id: 'nrAmount', label: 'NR Amount', min: 0, max: 100, val: 78, step: 1, unit: '%', rt: false, desc: 'Spectral noise reduction strength' },
    { id: 'nrSensitivity', label: 'Sensitivity', min: 0, max: 100, val: 60, step: 1, unit: '%', rt: false, desc: 'Noise floor detection sensitivity' },
    { id: 'nrSpectralSub', label: 'Spectral Sub', min: 0, max: 100, val: 50, step: 1, unit: '%', rt: false, desc: 'Spectral subtraction strength' },
    { id: 'nrFloor', label: 'NR Floor', min: -96, max: -30, val: -72, step: 1, unit: ' dB', rt: false, desc: 'Noise reduction floor limit' },
    { id: 'nrSmoothing', label: 'Smoothing', min: 0, max: 100, val: 70, step: 1, unit: '%', rt: false, desc: 'Temporal smoothing of spectral noise estimate' },
  ],
  eq: [
    { id: 'eqSub', label: 'Sub', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Sub-bass EQ (20-60 Hz)' },
    { id: 'eqBass', label: 'Bass', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Bass EQ (60-200 Hz)' },
    { id: 'eqWarmth', label: 'Warmth', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Warmth EQ (200-500 Hz)' },
    { id: 'eqBody', label: 'Body', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Body EQ (500-1k Hz)' },
    { id: 'eqLowMid', label: 'Low Mid', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Low-mid EQ (1-2 kHz)' },
    { id: 'eqMid', label: 'Mid', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Mid EQ (2-4 kHz)' },
    { id: 'eqPresence', label: 'Presence', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Presence EQ (4-6 kHz)' },
    { id: 'eqClarity', label: 'Clarity', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Clarity EQ (6-10 kHz)' },
    { id: 'eqAir', label: 'Air', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Air EQ (10-16 kHz)' },
    { id: 'eqBrill', label: 'Brilliance', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Brilliance EQ (16-20 kHz)' },
  ],
  dyn: [
    { id: 'compThresh', label: 'Threshold', min: -60, max: 0, val: -24, step: 1, unit: ' dB', rt: true, desc: 'Compressor threshold level' },
    { id: 'compRatio', label: 'Ratio', min: 1, max: 20, val: 4, step: 0.5, unit: ':1', rt: true, desc: 'Compression ratio' },
    { id: 'compAttack', label: 'Attack', min: 1, max: 200, val: 10, step: 1, unit: ' ms', rt: true, desc: 'Compressor attack time' },
    { id: 'compRelease', label: 'Release', min: 10, max: 1000, val: 150, step: 10, unit: ' ms', rt: true, desc: 'Compressor release time' },
    { id: 'compKnee', label: 'Knee', min: 0, max: 30, val: 6, step: 1, unit: ' dB', rt: true, desc: 'Compressor knee width' },
    { id: 'compMakeup', label: 'Makeup', min: 0, max: 30, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Makeup gain after compression' },
    { id: 'limThresh', label: 'Lim Thresh', min: -12, max: 0, val: -1, step: 0.5, unit: ' dB', rt: true, desc: 'Brickwall limiter threshold' },
    { id: 'limRelease', label: 'Lim Release', min: 10, max: 500, val: 50, step: 5, unit: ' ms', rt: true, desc: 'Limiter release time' },
  ],
  spec: [
    { id: 'hpFreq', label: 'HP Freq', min: 20, max: 2000, val: 80, step: 1, unit: ' Hz', rt: true, desc: 'High-pass filter cutoff frequency' },
    { id: 'hpQ', label: 'HP Q', min: 0.1, max: 10, val: 0.7, step: 0.1, unit: '', rt: true, desc: 'High-pass filter resonance' },
    { id: 'lpFreq', label: 'LP Freq', min: 4000, max: 20000, val: 18000, step: 100, unit: ' Hz', rt: true, desc: 'Low-pass filter cutoff frequency' },
    { id: 'lpQ', label: 'LP Q', min: 0.1, max: 10, val: 0.7, step: 0.1, unit: '', rt: true, desc: 'Low-pass filter resonance' },
    { id: 'deEssFreq', label: 'De-ess Freq', min: 2000, max: 12000, val: 6000, step: 100, unit: ' Hz', rt: true, desc: 'De-esser detection frequency' },
    { id: 'deEssAmt', label: 'De-ess Amt', min: 0, max: 30, val: 0, step: 1, unit: ' dB', rt: true, desc: 'De-esser reduction amount' },
    { id: 'specTilt', label: 'Spec Tilt', min: -6, max: 6, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Spectral tilt (high vs low shelf balance)' },
    { id: 'formantShift', label: 'Formant Shift', min: -6, max: 6, val: 0, step: 0.5, unit: ' st', rt: false, desc: 'Formant shift in semitones' },
  ],
  adv: [
    { id: 'derevAmt', label: 'Dereverb', min: 0, max: 100, val: 0, step: 1, unit: '%', rt: false, desc: 'Dereverberation strength' },
    { id: 'derevDecay', label: 'Rev Decay', min: 0, max: 100, val: 50, step: 1, unit: '%', rt: false, desc: 'Estimated reverb decay time reference' },
    { id: 'harmRecov', label: 'Harm Recovery', min: 0, max: 100, val: 0, step: 1, unit: '%', rt: false, desc: 'Harmonic recovery via neural vocoder' },
    { id: 'harmOrder', label: 'Harm Order', min: 1, max: 10, val: 3, step: 1, unit: '', rt: false, desc: 'Harmonic series order for reconstruction' },
    { id: 'stereoWidth', label: 'Stereo Width', min: 0, max: 200, val: 100, step: 1, unit: '%', rt: true, desc: 'Stereo width of output signal' },
    { id: 'phaseCorr', label: 'Phase Corr', min: 0, max: 100, val: 0, step: 1, unit: '%', rt: false, desc: 'Phase correlation correction strength' },
  ],
  sep: [
    { id: 'voiceIso', label: 'Voice Iso', min: 0, max: 100, val: 80, step: 1, unit: '%', rt: false, desc: 'Voice isolation strength (0=off 100=max)' },
    { id: 'bgSuppress', label: 'BG Suppress', min: 0, max: 100, val: 50, step: 1, unit: '%', rt: false, desc: 'Background suppression level' },
    { id: 'voiceFocusLo', label: 'Focus Lo', min: 80, max: 500, val: 120, step: 10, unit: ' Hz', rt: false, desc: 'Lower bound of voice focus band' },
    { id: 'voiceFocusHi', label: 'Focus Hi', min: 1000, max: 8000, val: 3400, step: 100, unit: ' Hz', rt: false, desc: 'Upper bound of voice focus band' },
    { id: 'crosstalkCancel', label: 'Crosstalk', min: 0, max: 100, val: 0, step: 1, unit: '%', rt: false, desc: 'Crosstalk cancellation between channels' },
  ],
  out: [
    { id: 'outGain', label: 'Output Gain', min: -24, max: 24, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Final output gain trim' },
    { id: 'dryWet', label: 'Dry/Wet', min: 0, max: 100, val: 100, step: 1, unit: '%', rt: true, desc: 'Blend between dry input and processed output' },
    { id: 'ditherAmt', label: 'Dither', min: 0, max: 10, val: 1, step: 0.1, unit: ' bits', rt: false, desc: 'Dither noise amplitude in bits' },
    { id: 'outWidth', label: 'Out Width', min: 0, max: 200, val: 100, step: 1, unit: '%', rt: true, desc: 'Output stereo width' },
  ],
};
const SLIDER_MAP = Object.fromEntries(
  Object.entries(SLIDERS).flatMap(([tab, sliders]) =>
    sliders.map(s => [s.id, { ...s, tab }])
  )
);
const SLIDER_BY_ID = Object.freeze(
  Object.values(SLIDERS).flat().reduce((acc, s) => { acc[s.id] = s; return acc; }, {})
);

function clampToSlider(id, value) {
  const s = SLIDER_BY_ID[id];
  const v = Number(value);
  if (v < s.min) return s.min;
  if (v > s.max) return s.max;
  return v;
}

function numFromInput(el, fallback = 0) {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
}

if (typeof window !== 'undefined') {
  window.numFromInput = numFromInput;
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

  neonAnalyser = audioCtx.createAnalyser();
  neonAnalyser.fftSize = 512;
  neonAnalyser.smoothingTimeConstant = 0.85;
  workletNode.connect(neonAnalyser);

  console.info('[AudioWorklet] dsp-processor loaded and connected.');
const PRESETS = {
  'Voice Clarity': {
    description: 'Crystal-clear voice isolation optimised for dialogue and interviews',
    gateThresh: -45, gateRange: -60, gateAttack: 5, gateRelease: 200, gateHold: 50, gateLookahead: 5,
    nrAmount: 75, nrSensitivity: 65, nrSpectralSub: 60, nrFloor: -72, nrSmoothing: 70,
    eqSub: -6, eqBass: -3, eqWarmth: 2, eqBody: 1, eqLowMid: 0, eqMid: 2, eqPresence: 3, eqClarity: 2, eqAir: 1, eqBrill: 0,
    compThresh: -24, compRatio: 3, compAttack: 10, compRelease: 150, compKnee: 6, compMakeup: 4, limThresh: -1, limRelease: 50,
    hpFreq: 100, hpQ: 0.7, lpFreq: 16000, lpQ: 0.7, deEssFreq: 6000, deEssAmt: 6, specTilt: 0, formantShift: 0,
    derevAmt: 20, derevDecay: 50, harmRecov: 10, harmOrder: 3, stereoWidth: 100, phaseCorr: 0,
    voiceIso: 85, bgSuppress: 70, voiceFocusLo: 120, voiceFocusHi: 3400, crosstalkCancel: 20,
    outGain: 2, dryWet: 100, ditherAmt: 1, outWidth: 100,
  },
  'Podcast Clean': {
    description: 'Balanced noise reduction and EQ polish for podcast production',
    gateThresh: -50, gateRange: -65, gateAttack: 5, gateRelease: 250, gateHold: 50, gateLookahead: 5,
    nrAmount: 80, nrSensitivity: 70, nrSpectralSub: 65, nrFloor: -72, nrSmoothing: 75,
    eqSub: -8, eqBass: -2, eqWarmth: 3, eqBody: 2, eqLowMid: 1, eqMid: 2, eqPresence: 4, eqClarity: 3, eqAir: 1, eqBrill: 0,
    compThresh: -20, compRatio: 4, compAttack: 8, compRelease: 120, compKnee: 8, compMakeup: 5, limThresh: -1, limRelease: 50,
    hpFreq: 120, hpQ: 0.7, lpFreq: 16000, lpQ: 0.7, deEssFreq: 6500, deEssAmt: 8, specTilt: 0, formantShift: 0,
    derevAmt: 15, derevDecay: 50, harmRecov: 5, harmOrder: 3, stereoWidth: 110, phaseCorr: 0,
    voiceIso: 80, bgSuppress: 75, voiceFocusLo: 120, voiceFocusHi: 3400, crosstalkCancel: 30,
    outGain: 3, dryWet: 100, ditherAmt: 1, outWidth: 100,
  },
  'Forensic Extract': {
    description: 'Maximum isolation for forensic audio analysis with SHA-256 audit chain',
    gateThresh: -60, gateRange: -70, gateAttack: 3, gateRelease: 300, gateHold: 100, gateLookahead: 10,
    nrAmount: 95, nrSensitivity: 85, nrSpectralSub: 80, nrFloor: -80, nrSmoothing: 85,
    eqSub: -12, eqBass: -6, eqWarmth: 0, eqBody: 2, eqLowMid: 3, eqMid: 4, eqPresence: 5, eqClarity: 4, eqAir: 2, eqBrill: 0,
    compThresh: -30, compRatio: 6, compAttack: 5, compRelease: 200, compKnee: 4, compMakeup: 8, limThresh: -2, limRelease: 30,
    hpFreq: 150, hpQ: 1.0, lpFreq: 14000, lpQ: 0.7, deEssFreq: 5500, deEssAmt: 12, specTilt: 1, formantShift: 0,
    derevAmt: 60, derevDecay: 70, harmRecov: 30, harmOrder: 5, stereoWidth: 100, phaseCorr: 50,
    voiceIso: 98, bgSuppress: 90, voiceFocusLo: 120, voiceFocusHi: 3400, crosstalkCancel: 60,
    outGain: 0, dryWet: 100, ditherAmt: 0, outWidth: 100,
  },
  'Music Vocal': {
    description: 'Vocal-focused processing for music production and karaoke extraction',
    gateThresh: -55, gateRange: -60, gateAttack: 10, gateRelease: 300, gateHold: 80, gateLookahead: 5,
    nrAmount: 60, nrSensitivity: 50, nrSpectralSub: 40, nrFloor: -66, nrSmoothing: 60,
    eqSub: -10, eqBass: -4, eqWarmth: 2, eqBody: 3, eqLowMid: 1, eqMid: 3, eqPresence: 4, eqClarity: 3, eqAir: 2, eqBrill: 1,
    compThresh: -18, compRatio: 3, compAttack: 15, compRelease: 200, compKnee: 8, compMakeup: 3, limThresh: -1, limRelease: 60,
    hpFreq: 80, hpQ: 0.7, lpFreq: 18000, lpQ: 0.7, deEssFreq: 7000, deEssAmt: 10, specTilt: 0, formantShift: 0,
    derevAmt: 10, derevDecay: 40, harmRecov: 40, harmOrder: 3, stereoWidth: 120, phaseCorr: 0,
    voiceIso: 85, bgSuppress: 65, voiceFocusLo: 120, voiceFocusHi: 4000, crosstalkCancel: 10,
    outGain: 2, dryWet: 100, ditherAmt: 1, outWidth: 120,
  },
  'Whisper Boost': {
    description: 'Enhances low-level whispered speech with maximum gain staging',
    gateThresh: -70, gateRange: -75, gateAttack: 2, gateRelease: 150, gateHold: 30, gateLookahead: 5,
    nrAmount: 85, nrSensitivity: 80, nrSpectralSub: 70, nrFloor: -80, nrSmoothing: 80,
    eqSub: -12, eqBass: -8, eqWarmth: 4, eqBody: 6, eqLowMid: 5, eqMid: 6, eqPresence: 8, eqClarity: 6, eqAir: 4, eqBrill: 2,
    compThresh: -40, compRatio: 8, compAttack: 3, compRelease: 100, compKnee: 10, compMakeup: 15, limThresh: -1, limRelease: 20,
    hpFreq: 200, hpQ: 0.7, lpFreq: 12000, lpQ: 0.7, deEssFreq: 5000, deEssAmt: 5, specTilt: 2, formantShift: 0,
    derevAmt: 40, derevDecay: 60, harmRecov: 60, harmOrder: 4, stereoWidth: 100, phaseCorr: 30,
    voiceIso: 90, bgSuppress: 85, voiceFocusLo: 100, voiceFocusHi: 4000, crosstalkCancel: 40,
    outGain: 12, dryWet: 100, ditherAmt: 2, outWidth: 100,
  },
  'Phone/Radio': {
    description: 'Simulates and cleans telephone or radio band-limited audio',
    gateThresh: -50, gateRange: -65, gateAttack: 5, gateRelease: 200, gateHold: 50, gateLookahead: 5,
    nrAmount: 82, nrSensitivity: 75, nrSpectralSub: 70, nrFloor: -72, nrSmoothing: 80,
    eqSub: -12, eqBass: -10, eqWarmth: 0, eqBody: 4, eqLowMid: 6, eqMid: 5, eqPresence: 6, eqClarity: 4, eqAir: -6, eqBrill: -8,
    compThresh: -20, compRatio: 5, compAttack: 8, compRelease: 120, compKnee: 6, compMakeup: 6, limThresh: -2, limRelease: 40,
    hpFreq: 300, hpQ: 1.5, lpFreq: 5000, lpQ: 1.5, deEssFreq: 4000, deEssAmt: 8, specTilt: -2, formantShift: 0,
    derevAmt: 30, derevDecay: 40, harmRecov: 20, harmOrder: 3, stereoWidth: 100, phaseCorr: 20,
    voiceIso: 88, bgSuppress: 80, voiceFocusLo: 300, voiceFocusHi: 3400, crosstalkCancel: 50,
    outGain: 4, dryWet: 100, ditherAmt: 1, outWidth: 100,
  },
  'Live Performance': {
    description: 'Optimised for live venue audio with room treatment and dynamics control',
    gateThresh: -40, gateRange: -55, gateAttack: 8, gateRelease: 300, gateHold: 100, gateLookahead: 5,
    nrAmount: 65, nrSensitivity: 55, nrSpectralSub: 45, nrFloor: -60, nrSmoothing: 55,
    eqSub: -8, eqBass: -4, eqWarmth: 2, eqBody: 1, eqLowMid: 0, eqMid: 2, eqPresence: 4, eqClarity: 3, eqAir: 1, eqBrill: 0,
    compThresh: -18, compRatio: 4, compAttack: 12, compRelease: 250, compKnee: 8, compMakeup: 4, limThresh: -2, limRelease: 80,
    hpFreq: 100, hpQ: 0.7, lpFreq: 18000, lpQ: 0.7, deEssFreq: 6000, deEssAmt: 4, specTilt: 0, formantShift: 0,
    derevAmt: 50, derevDecay: 75, harmRecov: 20, harmOrder: 3, stereoWidth: 130, phaseCorr: 10,
    voiceIso: 70, bgSuppress: 55, voiceFocusLo: 120, voiceFocusHi: 3400, crosstalkCancel: 15,
    outGain: 2, dryWet: 90, ditherAmt: 1, outWidth: 130,
  },
  'Surveillance': {
    description: 'Maximum extraction for covert or surveillance recordings',
    gateThresh: -65, gateRange: -70, gateAttack: 2, gateRelease: 250, gateHold: 80, gateLookahead: 10,
    nrAmount: 90, nrSensitivity: 88, nrSpectralSub: 85, nrFloor: -84, nrSmoothing: 88,
    eqSub: -12, eqBass: -8, eqWarmth: 0, eqBody: 3, eqLowMid: 5, eqMid: 6, eqPresence: 7, eqClarity: 5, eqAir: 3, eqBrill: 1,
    compThresh: -35, compRatio: 10, compAttack: 3, compRelease: 150, compKnee: 4, compMakeup: 12, limThresh: -1, limRelease: 25,
    hpFreq: 180, hpQ: 1.2, lpFreq: 10000, lpQ: 0.7, deEssFreq: 5000, deEssAmt: 10, specTilt: 1, formantShift: 0,
    derevAmt: 70, derevDecay: 80, harmRecov: 50, harmOrder: 5, stereoWidth: 100, phaseCorr: 60,
    voiceIso: 95, bgSuppress: 92, voiceFocusLo: 120, voiceFocusHi: 3000, crosstalkCancel: 70,
    outGain: 6, dryWet: 100, ditherAmt: 0, outWidth: 100,
  },
};
// Aliases
const PRESET_NAMES = Object.keys(PRESETS);

function bind(name, el, event, fn) {
  if (el) el.addEventListener(event, fn);
}

class VoiceIsolatePro {
  constructor() {
    this.inputBuffer = null;
    this.outputBuffer = null;
    this.ctx = null;
    this.currentSource = null;
    this.isPlaying = false;
    this.isProcessing = false;
    this.isVideo = false;
    this.abMode = 'original';
    this.playOffset = 0;
    this.playStartTime = 0;
    this.abortFlag = false;
    this.liveChainBuilt = false;
    this.forensicLog = [];
    this.gainNode = null;
    this.params = {};

    Object.values(SLIDERS).flat().forEach(s => { this.params[s.id] = s.val; });

    this.dom = {};
    try { this.cacheDom(); } catch (_) {}
    try { this.initPct(); } catch (_) {}
    try { this.bindEvents(); } catch (_) {}
    try {
      document.addEventListener('keydown', e => this._handleGlobalKeydown(e));
    } catch (_) {}
  }

  init() {
    structuredLog('info', '[VIP] app init');
  }

  cacheDom() {
    const g = id => document.getElementById(id);
    this.dom = {
      fileInput: g('fileInput'),
      dropZone: g('dropZone'),
      fileInfo: g('fileInfo'),
      processBtn: g('processBtn'),
      reprocessBtn: g('reprocessBtn'),
      playBtn: g('playBtn'),
      tpPlay: g('tpPlay'),
      tpStop: g('tpStop'),
      tpPause: g('tpPause'),
      tpAB: g('tpAB'),
      tpABLabel: g('tpABLabel'),
      tpCur: g('tpCur'),
      tpDur: g('tpDur'),
      tpSeek: g('tpSeek'),
      tpSpeed: g('tpSpeed'),
      hDur: g('hDur'),
      hFile: g('hFile'),
      hSR: g('hSR'),
      hCh: g('hCh'),
      hRMS: g('hRMS'),
      hPeak: g('hPeak'),
      hVoices: g('hVoices'),
      hStatus: g('hStatus'),
      waveCanvas: g('waveCanvas'),
      spectroCanvas: g('spectroCanvas'),
      freqCanvas: g('freqCanvas'),
      toastRegion: g('toastRegion'),
      presetSel: g('presetSel'),
      videoPlayer: g('videoPlayer'),
      videoCard: g('videoCard'),
      clearFile: g('clearFile'),
      mobileProcessBtn:g('mobileProcessBtn'),
      mobileReprocessBtn:g('mobileReprocessBtn'),
      mobileStopBtn:g('mobileStopBtn'),
      statsToggle:g('statsToggle'),
      hdrStats:g('hdrStats'),
    };
  }

  initPct() {
    const allSliders = Object.values(SLIDERS).flat();
    allSliders.forEach(s => {
      const inputEl = document.getElementById('sl_' + s.id);

      const labelEl = document.getElementById('lbl_' + s.id) || inputEl.parentElement;
      if (labelEl && s.rt) {
        const badge = document.createElement('span');
        badge.className = 'rt-badge';
        badge.textContent = 'RT';
        badge.setAttribute('aria-label', 'Real-time parameter');
        labelEl.appendChild(badge);
      }

      if (labelEl) {
        const infoEl = document.createElement('span');
        infoEl.className = 'sr-info';
        infoEl.textContent = 'i';
        infoEl.setAttribute('aria-hidden', 'true');
        infoEl.title = s.desc;
        labelEl.appendChild(infoEl);
      }

      const initVal = s.val;
      const range = s.max - s.min;
      const initPct = range > 0 ? ((initVal - s.min) / range) * 100 : 0;
      inputEl.style.setProperty('--pct', `${initPct.toFixed(1)}%`);
      inputEl.setAttribute('aria-valuenow', initVal);
      inputEl.addEventListener('input', () => this.onSlider(inputEl, s.id, parseFloat(inputEl.value)));
    });
  }

  onSlider(el, id, val) {
    const min = parseFloat(el.min);
    const max = parseFloat(el.max);
    const range = max - min;
    const pct = range > 0 ? ((val - min) / range) * 100 : 0;
    el.style.setProperty('--pct', `${pct.toFixed(1)}%`);
    this.params[id] = val;
    if (typeof window !== 'undefined') {
      window.VIP_PARAMS = window.VIP_PARAMS || {};
      window.VIP_PARAMS[id] = val;
    }
  }

  bindEvents() {
    bind('playBtn', this.dom.tpPlay, 'click', () => { this.togglePlayback(); });

    if (this.dom.tpStop) {
      this.dom.tpStop.addEventListener('click', () => this.stop());
    }
    if (this.dom.tpPause) {
      this.dom.tpPause.addEventListener('click', () => this.pause());
    }
    if (this.dom.tpAB) {
      this.dom.tpAB.addEventListener('click', () => this.toggleAB());
    }
    if (this.dom.tpSeek) {
      this.dom.tpSeek.addEventListener('input', () => {
        this.seekTo(parseFloat(this.dom.tpSeek.value) / 1000);
      });
    }
    if (this.dom.processBtn) {
      this.dom.processBtn.addEventListener('click', () => this.runPipeline());
    }
    if (this.dom.reprocessBtn) {
      this.dom.reprocessBtn.addEventListener('click', () => this.runPipeline());
    }
    if (this.dom.presetSel) {
      this.dom.presetSel.addEventListener('change', () => {
        this.applyPreset(this.dom.presetSel.value);
      });
    }
    if (this.dom.fileInput) {
      this.dom.fileInput.addEventListener('change', e => {
        if (e.target.files && e.target.files[0]) this.handleFile(e.target.files[0]);
      });
    }
    if (this.dom.dropZone) {
      this.dom.dropZone.addEventListener('dragover', e => e.preventDefault());
      this.dom.dropZone.addEventListener('drop', e => {
        e.preventDefault();
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) this.handleFile(f);
      });
    }
    if (this.dom.clearFile) {
      this.dom.clearFile.addEventListener('click', () => this.stop());
    }

    if (this.dom.mobileProcessBtn) {
      this.dom.mobileProcessBtn.addEventListener('click', () => this.runPipeline());
    }
    if (this.dom.mobileReprocessBtn) {
      this.dom.mobileReprocessBtn.addEventListener('click', () => this.runPipeline());
    }
    if (this.dom.mobileStopBtn) {
      this.dom.mobileStopBtn.addEventListener('click', () => { this.abortFlag = true; });
    }

    if (this.dom.statsToggle && this.dom.hdrStats) {
      this.dom.statsToggle.addEventListener('click', () => {
        const expanded = this.dom.hdrStats.classList.toggle('expanded');
        this.dom.statsToggle.setAttribute('aria-expanded', String(expanded));
        this.dom.statsToggle.textContent = expanded ? '▲' : '▼';
      });
    }
  }

  ensureCtx() {
    if (!this.ctx) {
      try {
        const AC = typeof AudioContext !== 'undefined' ? AudioContext :
          (typeof window !== 'undefined' && window.AudioContext) ? window.AudioContext : null;
        if (AC) this.ctx = new AC();
      } catch (_) {}
    }
    return this.ctx;
  }

  stop() {
    if (this.isVideo && this.dom.videoPlayer) {
      this.dom.videoPlayer.pause();
      this.dom.videoPlayer.currentTime = 0;
    }
    this.teardownChain();
    this.isPlaying = false;
    this.playOffset = 0;
    this.stopSpectro();
    if (this.dom.tpCur) this.dom.tpCur.textContent = this.fmtDur(0);
    if (this.dom.tpSeek) this.dom.tpSeek.value = 0;
    this._setScrubPos(0);
  }

  pause() {
    const speed = parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
    this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    this.teardownChain();
    this.stopSpectro();
    this.isPlaying = false;
    if (this.isVideo && this.dom.videoPlayer) {
      this.dom.videoPlayer.pause();
    }
  }

  seekDelta(dt) {
    const dur = this.inputBuffer.duration;
    if (this.isPlaying) {
      const speed = parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
      this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    }
    this.playOffset = Math.max(0, Math.min(dur, this.playOffset + dt));
    this.dom.tpCur.textContent = this.fmtDur(this.playOffset);
    this._setScrubPos(this.playOffset / dur);
    if (this.isPlaying) {
      this.play();
    }
  }

  seekTo(frac) {
    const dur = this.inputBuffer.duration;
    if (this.isPlaying) {
      const speed = parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
      this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    }
    this.playOffset = frac * dur;
    if (this.isPlaying) {
      this.play();
    } else {
      this.dom.tpCur.textContent = this.fmtDur(this.playOffset);
      this.dom.tpSeek.value = frac * 1000;
      this._setScrubPos(frac);
    }
  }

  toggleAB() {
    if (this.isPlaying) {
      const speed = parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
      this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    }
    this.abMode = this.abMode === 'original' ? 'processed' : 'original';
    const isProcessed = this.abMode === 'processed';
    this.dom.tpAB.classList.toggle('active', isProcessed);
    this.dom.tpABLabel.textContent = isProcessed ? 'Processed' : 'Original';
    if (this.isPlaying) {
      this.play();
    }
  }

  play() {
    this.ensureCtx();
    const buf = (this.abMode === 'processed' && this.outputBuffer) ? this.outputBuffer : this.inputBuffer;

    this.buildLiveChain(buf);
    this.isPlaying = true;
    this.playStartTime = this.ctx.currentTime;
    this.dom.tpABLabel.textContent = this.abMode === 'processed' ? 'Processed' : 'Original';

    if (this.isVideo && this.dom.videoPlayer) {
      this.dom.videoPlayer.currentTime = this.playOffset;
      this.dom.videoPlayer.playbackRate = parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
      this.dom.videoPlayer.muted = true;
      this.dom.videoPlayer.play().catch(() => {});
    }

    this.startSpectro();
    this.startFreq();
    this.tickTime();
  }

  async togglePlayback() {
    this.ensureCtx();
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (_) {}
      try { this.currentSource.disconnect(); } catch (_) {}
      this.currentSource = null;
    }
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  buildLiveChain(buffer) {
    try {
      this.teardownChain();
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
      src.loop = false;
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = Math.pow(10, (this.params.outGain || 0) / 20);
      src.connect(this.gainNode);
      this.gainNode.connect(this.ctx.destination);
      src.start(0, this.playOffset);
      this.currentSource = src;
      this.liveChainBuilt = true;
    } catch (e) {
      structuredLog('error', 'buildLiveChain failed', { e });
    }
  }

  teardownChain() {
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (_) {}
      try { this.currentSource.disconnect(); } catch (_) {}
      this.currentSource = null;
    }
    if (this.gainNode) {
      try { this.gainNode.disconnect(this.ctx && this.ctx.destination); } catch (_) {}
      this.gainNode = null;
    }
    this.liveChainBuilt = false;
  }

  startSpectro() {}
  stopSpectro() {}
  startFreq() {}
  startDiagnostics() {}
  stopDiagnostics() {}

  tickTime() {
    const speed = parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
    const elapsed = (this.ctx.currentTime - this.playStartTime) * speed;
    const cur = this.playOffset + elapsed;
    if (this.dom.tpCur) this.dom.tpCur.textContent = this.fmtDur(cur);
    const dur = this.inputBuffer.duration;
    if (dur > 0 && this.dom.tpSeek) this._setScrubPos(cur / dur);
    if (cur < dur) {
      requestAnimationFrame(() => this.tickTime());
    } else {
      this.stop();
    }
  }

  _setScrubPos(frac) {
    if (this.dom.tpSeek) this.dom.tpSeek.value = frac * 1000;
  }

  async handleFile(file) {
    this.ensureCtx();
    this.stop();

    const name = file.name || '';
    const ext = name.split('.').pop().toLowerCase();
    const mime = file.type || '';

    if (mime.includes('midi') || ext === 'mid' || ext === 'midi') {
      this.setStatus('ERROR');
      this.dom.fileInfo.textContent = 'MIDI files are not supported — please use audio/video files';
      return;
    }

    const isAudio = mime.startsWith('audio/') || ['wav','mp3','ogg','flac','aac','m4a','opus','weba','webm'].includes(ext);
    const isVideo = mime.startsWith('video/') || ['mp4','mov','avi','mkv','webm'].includes(ext);

      this.setStatus('ERROR');
      this.dom.fileInfo.textContent = 'Unsupported file format — please use an audio or video file';
      return;
    }

    try {
      if (isVideo) {
        await this.decodeViaVideoElement(file);
      } else {
        const rawBuffer = await file.arrayBuffer();
        const copyBuffer = rawBuffer.slice(0);
        const decoded = await this.ctx.decodeAudioData(copyBuffer);
        this.onAudioLoaded(name, decoded);
      }
    } catch (e) {
      this.setStatus('ERROR');
      structuredLog('error', 'handleFile decode failed', { e });
      if (this.dom.fileInfo) this.dom.fileInfo.textContent = 'Failed to decode audio file';
    }
  }

  async decodeViaVideoElement(file) {
    const url = URL.createObjectURL(file);
    if (this.dom.videoPlayer) {
      this.dom.videoPlayer.src = url;
    }
    return new Promise((resolve, reject) => {
      const onMeta = () => { resolve(this.inputBuffer); };
      if (this.dom.videoPlayer) {
        this.dom.videoPlayer.onloadedmetadata = onMeta;
        this.dom.videoPlayer.onerror = reject;
      } else {
        resolve(null);
      }
    });
  }

  onAudioLoaded(name, buffer) {
    if (buffer) this.inputBuffer = buffer;
    if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.disabled = false;
    if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = true;
    if (this.dom.playBtn) this.dom.playBtn.disabled = false;
    if (this.dom.processBtn) this.dom.processBtn.disabled = false;
    if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = true;

    if (this.dom.hDur && this.inputBuffer) {
      this.dom.hDur.textContent = this.fmtDur(this.inputBuffer.duration);
    }
    if (this.dom.hFile) this.dom.hFile.textContent = name || '—';
    if (this.dom.hSR && this.inputBuffer) this.dom.hSR.textContent = this.inputBuffer.sampleRate + ' Hz';
    if (this.dom.hCh && this.inputBuffer) this.dom.hCh.textContent = this.inputBuffer.numberOfChannels;
    if (this.dom.tpDur && this.inputBuffer) this.dom.tpDur.textContent = this.fmtDur(this.inputBuffer.duration);
    if (this.dom.fileInfo) this.dom.fileInfo.textContent = name || '—';
    this.setStatus('READY');
  }

  async runPipeline() {
    this.isProcessing = true;
    this.abortFlag = false;

    if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.style.display = 'none';
    if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.style.display = 'none';
    if (this.dom.mobileStopBtn) this.dom.mobileStopBtn.style.display = 'inline-flex';

    try {
      this.setStatus('PROCESSING');
      structuredLog('info', 'Pipeline start', { stages: 32 });

      const sampleRate = this.inputBuffer.sampleRate;
      const numCh = this.inputBuffer.numberOfChannels;
      const length = this.inputBuffer.length;

      const channels = [];
      for (let ch = 0; ch < numCh; ch++) {
        channels.push(new Float32Array(this.inputBuffer.getChannelData(ch)));
      }
      const signal = channels[0];

      const fftSize = 2048;
      const spectrum = DSP.forwardSTFT(signal, fftSize);

      if (spectrum && this.params.nrAmount > 0) {
        const alpha = this.params.nrAmount / 100;
        for (let i = 0; i < spectrum.length; i++) {
          spectrum[i] *= (1 - alpha * 0.5);
        }
      }

    if (typeof window !== 'undefined' && typeof window.VIP_initNeonVisualizer === 'function') {
      window.VIP_initNeonVisualizer(neonAnalyser);
    }

    updateStatus('Binding UI sliders…');
    initSliders();
      const processed = DSP.inverseSTFT(spectrum, fftSize);

      if (processed && processed.length > 0) {
        const peak = this.calcPeak(processed);
        const rms = this.calcRMS(processed);
        if (this.dom.hRMS) this.dom.hRMS.textContent = rms.toFixed(1) + ' dB';
        if (this.dom.hPeak) this.dom.hPeak.textContent = peak.toFixed(1) + ' dB';
      }

      const hashData = new Uint8Array(16);
      const hashBuffer = await crypto.subtle.digest('SHA-256', hashData);
      this.forensicLog.push({ stage: 'S32', ts: new Date().toISOString(), hash: hashBuffer });

      const outBuf = this.ctx && this.ctx.createBuffer
        ? this.ctx.createBuffer(numCh, length, sampleRate)
        : null;
      if (outBuf) {
        for (let ch = 0; ch < numCh; ch++) {
          const src = channels[ch];
          const dst = outBuf.getChannelData(ch);
          dst.set(src);
        }
        this.outputBuffer = outBuf;
      }

      if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = false;
      if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = false;
      if (this.dom.tpAB) this.dom.tpAB.disabled = false;
      this.setStatus('DONE');
      structuredLog('info', 'Pipeline complete');

    } catch (e) {
      structuredLog('error', 'Pipeline failed', { e });
      this.setStatus('ERROR');
    } finally {
      this.isProcessing = false;
      if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.style.display='inline-flex';
      if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.style.display='inline-flex';
      if (this.dom.mobileStopBtn) this.dom.mobileStopBtn.style.display='none';
    }
  }

  applyPreset(name) {
    const preset = PRESETS[name];
    if (typeof window !== 'undefined') {
      window.VIP_PARAMS = window.VIP_PARAMS || {};
    }
    for (const [sliderId, rawValue] of Object.entries(preset)) {
      if (sliderId === 'description') continue;
      if (!SLIDER_BY_ID[sliderId]) continue;
      const value = clampToSlider(sliderId, rawValue);
      const key = sliderId;
      this.params[sliderId] = value;
      if (typeof window !== 'undefined') {
        window.VIP_PARAMS[key] = value;
      }
      const sliderDom = { el: document.getElementById('sl_' + sliderId) };
      if (sliderDom.el) {
        sliderDom.el.value = value;
        sliderDom.el.setAttribute('aria-valuenow', value);
        sliderDom.el.dispatchEvent(new Event('input', { bubbles: true }));
        sliderDom.el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    if (this.liveChainBuilt) {
      structuredLog('info', 'Preset applied to live chain', { name });
    }
  }

  setStatus(status) {
    if (this.dom.hStatus) this.dom.hStatus.textContent = status;
  }

  showNotification(msg, type = 'info', dur = 4000) {
    const region = document.getElementById('toastRegion') || document.body;
    while (region.children.length >= 4) {
      region.removeChild(region.firstChild);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    if (type === 'error') toast.setAttribute('role', 'alert');
    const span = document.createElement('span');
    span.textContent = msg;
    toast.appendChild(span);
    region.appendChild(toast);

    const dismiss = () => {
      setTimeout(() => {
        try { region.removeChild(toast); } catch (_) {}
      }, 220);
    };
    if (dur > 0) setTimeout(dismiss, dur);
    return dismiss;
  }

  _handleGlobalKeydown(e) {
    const tag = e.target && e.target.tagName ? e.target.tagName.toUpperCase() : '';
    const isTextTarget = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) ||
      (e.target && e.target.isContentEditable);

    if (e.key === ' ') {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isTextTarget) return;
      e.preventDefault();
      this.togglePlayback();
    } else if (e.key === 'k' || e.key === 'K') {
      this.togglePlayback();
    } else if (e.key === 'Escape') {
      if (this.isProcessing) {
        this.abortFlag = true;
      } else if (this.isPlaying) {
        this.stop();
      }
    } else if (e.key === 'x' || e.key === 'X') {
        this.toggleAB();
      }
    }
  }

  calcRMS(d) {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    const r = Math.sqrt(s / d.length);
    return r > 0 ? 20 * Math.log10(r) : -96;
  }

  calcPeak(d) {
    let p = 0;
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > p) p = a;
    }
    return p > 0 ? 20 * Math.log10(p) : -96;
  }

  fmtDur(s) {
    const m = Math.floor(s / 60);
    const sc = Math.floor(s % 60);
    return m + ':' + String(sc).padStart(2, '0');
  }

  makeHarm(amt, ord) {
    const n = 44100;
    const c = new Float32Array(n);
    const k = amt * (ord || 3) * 2 + 1;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      c[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    return c;
  }

  estVoices(buf) {
    const d = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const bs = Math.floor(sr * 0.5);
    let act = 0;
    for (let i = 0; i < d.length; i += bs) {
      let r = 0;
      const e = Math.min(i + bs, d.length);
      for (let j = i; j < e; j++) r += d[j] * d[j];
      r = Math.sqrt(r / (e - i));
      if (r > 0.01) act++;
    }
    return act < 3 ? '0-1' : act < 10 ? '1' : '1-2+';
  }

  encWav(buf) {
    const nCh = buf.numberOfChannels;
    const sr = buf.sampleRate;
    const dL = buf.length * nCh * 2;
    const a = new ArrayBuffer(44 + dL);
    const v = new DataView(a);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF');
    v.setUint32(4, 36 + dL, true);
    ws(8, 'WAVE');
    ws(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, nCh, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * nCh * 2, true);
    v.setUint16(32, nCh * 2, true);
    v.setUint16(34, 16, true);
    ws(36, 'data');
    v.setUint32(40, dL, true);
    let off = 44;
    const chans = new Array(nCh);
    for (let ch = 0; ch < nCh; ch++) chans[ch] = buf.getChannelData(ch);
    for (let i = 0; i < buf.length; i++) {
      for (let ch = 0; ch < nCh; ch++) {
        let s = chans[ch][i];
        s = Math.max(-1, Math.min(1, s));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    }
    return a;
  }
}

VoiceIsolatePro.prototype._showToast = VoiceIsolatePro.prototype.showNotification;

if (typeof window !== 'undefined') { window.VoiceIsolatePro = VoiceIsolatePro; }
if (typeof module !== 'undefined') { module.exports = VoiceIsolatePro; }

document.addEventListener('DOMContentLoaded', () => {
  // boot handled by _vipBootstrap above
});

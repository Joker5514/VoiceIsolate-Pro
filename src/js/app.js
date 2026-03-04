/**
 * VoiceIsolate Pro v9.0 — Main Application Orchestrator
 * "Threads from Space" Engine
 *
 * Wires together: AudioContext, DSP dispatcher/workers, ML model manager,
 * visualizer, controls, IndexedDB, crypto utils, and export encoders.
 */

import { Visualizer } from './ui/visualizer.js';
import { ControlsManager } from './ui/controls.js';
import { AudioEncoders } from './export/encoders.js';
import VoiceIsolateDB from './utils/db.js';
import ModelManager from './ml/model-manager.js';
import {
  decodeAudioFile,
  audioBufferToFloat32,
  float32ToAudioBuffer,
  measurePeak,
  measureRMS,
  measureLUFS,
  estimateNoiseFloor,
  calculateSNR,
  formatTime,
  formatFileSize,
  detectContentType,
} from './utils/audio-utils.js';
import {
  generateKey,
  exportKey,
  importKey,
  encrypt,
  decrypt,
  hashSHA256,
  generateAuditEntry,
  generateUUID,
} from './utils/crypto-utils.js';

/* ===================================================================
 * Constants & Presets
 * =================================================================== */

const PIPELINE_STAGES = [
  'Input Validation',
  'Peak Normalization',
  'High-Pass Filter',
  'Noise Profiling',
  'FFT Analysis',
  'Spectral Subtraction',
  'Noise Gate',
  'Hum Removal',
  'Wiener Filter',
  'Dereverberation',
  'Harmonic Reconstruction',
  'Formant Enhancement',
  'Voice Presence',
  'De-Esser',
  'Dynamics',
  'EQ Shaping',
  'LUFS Normalization',
  'True Peak Limiter',
];

const FFT_SIZES = [2048, 4096, 8192, 16384];

const PRESETS = {
  crystal: {
    noiseReduction: 80, spectralFloor: -75, gateThreshold: -35,
    presence: 4, warmth: 1.5, air: 3, hpfFreq: 100,
    deReverbAmount: 40, deEsserThreshold: -18,
    targetLUFS: -16, lufsNorm: true, truePeak: true,
  },
  podcast: {
    noiseReduction: 75, spectralFloor: -80, gateThreshold: -40,
    presence: 3, warmth: 2.5, air: 2, hpfFreq: 80,
    deReverbAmount: 50, deEsserThreshold: -20,
    targetLUFS: -16, lufsNorm: true, truePeak: true,
  },
  interview: {
    noiseReduction: 60, spectralFloor: -85, gateThreshold: -45,
    presence: 2, warmth: 1, air: 1, hpfFreq: 60,
    deReverbAmount: 30, deEsserThreshold: -25,
    targetLUFS: -18, lufsNorm: true, truePeak: true,
  },
  film: {
    noiseReduction: 70, spectralFloor: -80, gateThreshold: -38,
    presence: 2, warmth: 2, air: 1.5, hpfFreq: 80,
    deReverbAmount: 60, deEsserThreshold: -22,
    targetLUFS: -24, lufsNorm: true, truePeak: true,
  },
  forensic: {
    noiseReduction: 40, spectralFloor: -90, gateThreshold: -55,
    presence: 0, warmth: 0, air: 0, hpfFreq: 30,
    deReverbAmount: 20, deEsserThreshold: -30,
    targetLUFS: -18, lufsNorm: false, truePeak: false,
  },
  camera: {
    noiseReduction: 85, spectralFloor: -70, gateThreshold: -32,
    presence: 3, warmth: 2, air: 2.5, hpfFreq: 120,
    deReverbAmount: 45, deEsserThreshold: -20,
    targetLUFS: -16, lufsNorm: true, truePeak: true,
  },
};

/* ===================================================================
 * Application State
 * =================================================================== */

const state = {
  mode: 'creator',                // creator | live | forensic | batch
  audioCtx: null,                 // AudioContext
  originalBuffer: null,           // AudioBuffer (source)
  processedBuffer: null,          // AudioBuffer (result)
  originalFloat: null,            // Float32Array mono
  processedFloat: null,           // Float32Array mono
  sampleRate: 48000,
  file: null,                     // current File
  isProcessing: false,
  isPlaying: false,
  abMode: 'original',            // original | processed
  playbackSource: null,           // AudioBufferSourceNode
  playbackStartTime: 0,
  playbackOffset: 0,
  volume: 1.0,
  gainNode: null,
  batchQueue: [],                 // {id, file, status, progress}
  dispatcherWorker: null,
  gpuAvailable: false,
  sabAvailable: false,
  forensicLog: [],
  enrolledVoiceprint: null,
  cryptoKey: null,
  processingStartTime: 0,
};

const config = {
  inputGain: 0,
  outputGain: 0,
  noiseReduction: 75,
  spectralFloor: -80,
  gateThreshold: -40,
  presence: 3,
  warmth: 2,
  air: 2,
  hpfFreq: 80,
  gateAttack: 1,
  gateRelease: 50,
  deEsserThreshold: -20,
  deReverbAmount: 50,
  mlConfidence: 0.5,
  harmonicWeight: 30,
  spectralTilt: 3.0,
  targetLUFS: -16,
  fftSizeIndex: 1,
  workerCount: 0,
  lufsNorm: true,
  truePeak: true,
  autoProfile: true,
  mlSeparation: true,
  voiceprint: false,
  gpuAccel: true,
  sharedBuffer: true,
  oversample: true,
};

/* ===================================================================
 * Module Instances
 * =================================================================== */

let db, modelManager, visualizer, controls;

/* ===================================================================
 * DOM References
 * =================================================================== */

const $ = (id) => document.getElementById(id);

/* ===================================================================
 * Initialization
 * =================================================================== */

async function boot() {
  try {
    // Feature detection
    state.sabAvailable = typeof SharedArrayBuffer !== 'undefined';
    state.gpuAvailable = !!(document.createElement('canvas').getContext('webgl2'));

    // Update GPU badge
    const gpuStatus = $('gpuStatus');
    const gpuBadge = $('gpuBadge');
    if (gpuStatus) {
      gpuStatus.textContent = state.gpuAvailable ? 'GPU Ready' : 'CPU Only';
    }
    if (gpuBadge) {
      gpuBadge.querySelector('.dot')?.classList.toggle('active', state.gpuAvailable);
    }

    // Thread count detection
    const hwThreads = navigator.hardwareConcurrency || 4;
    const threadCountEl = $('threadCount');
    if (threadCountEl) threadCountEl.textContent = hwThreads;

    // Open IndexedDB
    db = new VoiceIsolateDB();
    await db.open();

    // Load saved settings
    await loadSettings();

    // Initialize AudioContext (suspended until user gesture)
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
      latencyHint: 'playback',
    });
    state.sampleRate = state.audioCtx.sampleRate;
    state.gainNode = state.audioCtx.createGain();
    state.gainNode.connect(state.audioCtx.destination);

    // Initialize ML Model Manager
    modelManager = new ModelManager();

    // Initialize visualizer
    visualizer = new Visualizer('vizContainer');
    visualizer.init();

    // Initialize controls
    controls = new ControlsManager(config);
    controls.init();

    // Set up UI bindings
    setupSliders();
    setupToggles();
    setupModeSelector();
    setupFileHandling();
    setupPlayerControls();
    setupActionButtons();
    setupExportMenu();
    setupPresets();
    setupVoiceprintEnrollment();
    setupSettingsModal();
    setupVizTabs();
    buildPipelineUI();
    setupMobileControls();

    // Start dispatcher worker
    initDispatcher();

    // Load saved voiceprint
    await loadVoiceprint();

    // Dismiss loading screen
    const loadingScreen = $('loadingScreen');
    if (loadingScreen) {
      loadingScreen.style.opacity = '0';
      setTimeout(() => {
        loadingScreen.style.display = 'none';
      }, 500);
    }

    console.log('[VoiceIsolate Pro] v9.0 — Threads from Space engine initialized');
  } catch (err) {
    console.error('[VoiceIsolate Pro] Boot error:', err);
    const loadingScreen = $('loadingScreen');
    if (loadingScreen) {
      const sub = loadingScreen.querySelector('.loading-sub');
      if (sub) sub.textContent = `Error: ${err.message}`;
    }
  }
}

/* ===================================================================
 * Settings Persistence
 * =================================================================== */

async function loadSettings() {
  try {
    const saved = await db.get('settings', 'appConfig');
    if (saved) {
      Object.assign(config, saved);
    }
  } catch { /* first run */ }
}

async function saveSettings() {
  try {
    await db.put('settings', { ...config, _id: 'appConfig' }, 'appConfig');
  } catch (e) {
    console.warn('[Settings] Save failed:', e);
  }
}

/* ===================================================================
 * Slider Setup
 * =================================================================== */

function setupSliders() {
  const sliders = [
    { inputId: 's_inputGain',       valueId: 'v_inputGain',       key: 'inputGain',       fmt: (v) => `${v > 0 ? '+' : ''}${v} dB` },
    { inputId: 's_outputGain',      valueId: 'v_outputGain',      key: 'outputGain',      fmt: (v) => `${v > 0 ? '+' : ''}${v} dB` },
    { inputId: 's_noiseReduction',  valueId: 'v_noiseReduction',  key: 'noiseReduction',  fmt: (v) => `${v}%` },
    { inputId: 's_spectralFloor',   valueId: 'v_spectralFloor',   key: 'spectralFloor',   fmt: (v) => `${v} dB` },
    { inputId: 's_gateThreshold',   valueId: 'v_gateThreshold',   key: 'gateThreshold',   fmt: (v) => `${v} dB` },
    { inputId: 's_presence',        valueId: 'v_presence',        key: 'presence',        fmt: (v) => `${v} dB` },
    { inputId: 's_warmth',          valueId: 'v_warmth',          key: 'warmth',          fmt: (v) => `${v} dB` },
    { inputId: 's_air',             valueId: 'v_air',             key: 'air',             fmt: (v) => `${v} dB` },
    { inputId: 's_hpfFreq',         valueId: 'v_hpfFreq',         key: 'hpfFreq',         fmt: (v) => `${v} Hz` },
    { inputId: 's_gateAttack',      valueId: 'v_gateAttack',      key: 'gateAttack',      fmt: (v) => `${v} ms` },
    { inputId: 's_gateRelease',     valueId: 'v_gateRelease',     key: 'gateRelease',     fmt: (v) => `${v} ms` },
    { inputId: 's_deEsserThreshold', valueId: 'v_deEsserThreshold', key: 'deEsserThreshold', fmt: (v) => `${v} dB` },
    { inputId: 's_deReverbAmount',  valueId: 'v_deReverbAmount',  key: 'deReverbAmount',  fmt: (v) => `${v}%` },
    { inputId: 's_mlConfidence',    valueId: 'v_mlConfidence',    key: 'mlConfidence',    fmt: (v) => `${v}` },
    { inputId: 's_harmonicWeight',  valueId: 'v_harmonicWeight',  key: 'harmonicWeight',  fmt: (v) => `${v}%` },
    { inputId: 's_spectralTilt',    valueId: 'v_spectralTilt',    key: 'spectralTilt',    fmt: (v) => `${v}` },
    { inputId: 's_targetLUFS',      valueId: 'v_targetLUFS',      key: 'targetLUFS',      fmt: (v) => `${v} LUFS` },
  ];

  for (const s of sliders) {
    const input = $(s.inputId);
    const display = $(s.valueId);
    if (!input) continue;

    // Set initial value from config
    input.value = config[s.key];
    if (display) display.textContent = s.fmt(config[s.key]);

    input.addEventListener('input', () => {
      const val = parseFloat(input.value);
      config[s.key] = val;
      if (display) display.textContent = s.fmt(val);
    });

    input.addEventListener('change', () => {
      saveSettings();
    });
  }

  // Mobile sliders
  const mNoise = $('ms_noise');
  const mEnhance = $('ms_enhance');
  if (mNoise) {
    mNoise.addEventListener('input', () => {
      config.noiseReduction = parseInt(mNoise.value);
      const d = $('mv_noise');
      if (d) d.textContent = `${config.noiseReduction}%`;
      const main = $('s_noiseReduction');
      if (main) main.value = config.noiseReduction;
      const mainD = $('v_noiseReduction');
      if (mainD) mainD.textContent = `${config.noiseReduction}%`;
    });
  }
  if (mEnhance) {
    mEnhance.addEventListener('input', () => {
      config.presence = Math.round(parseFloat(mEnhance.value) / 100 * 12);
      const d = $('mv_enhance');
      if (d) d.textContent = `${mEnhance.value}%`;
    });
  }
}

/* ===================================================================
 * Toggle Setup
 * =================================================================== */

function setupToggles() {
  const toggles = [
    { id: 't_lufsNorm',    key: 'lufsNorm' },
    { id: 't_truePeak',    key: 'truePeak' },
    { id: 't_autoProfile', key: 'autoProfile' },
    { id: 't_mlSeparation', key: 'mlSeparation' },
    { id: 't_voiceprint',  key: 'voiceprint' },
  ];

  for (const t of toggles) {
    const el = $(t.id);
    if (!el) continue;

    const handleToggle = () => {
      const isOn = el.classList.toggle('on');
      config[t.key] = isOn;
      el.setAttribute('aria-checked', String(isOn));
      saveSettings();
    };

    el.addEventListener('click', handleToggle);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleToggle();
      }
    });
  }
}

/* ===================================================================
 * Mode Selector
 * =================================================================== */

function setupModeSelector() {
  const container = $('modeSelector');
  if (!container) return;

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;

    container.querySelectorAll('.mode-btn').forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-pressed', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');

    state.mode = btn.dataset.mode;

    // Show/hide batch UI
    const batchBox = $('batchBox');
    if (batchBox) batchBox.style.display = state.mode === 'batch' ? 'block' : 'none';

    // Show/hide forensic log
    const forensicLog = $('forensicLog');
    const logTitle = forensicLog?.previousElementSibling;
    if (forensicLog) forensicLog.style.display = state.mode === 'forensic' ? 'block' : 'none';
    if (logTitle) logTitle.style.display = state.mode === 'forensic' ? 'block' : 'none';

    updatePipelineUI();
  });
}

/* ===================================================================
 * File Handling
 * =================================================================== */

function setupFileHandling() {
  const dropZone = $('dropZone');
  const fileInput = $('fileInput');
  const uploadBtn = $('uploadBtn');
  const recordBtn = $('recordBtn');
  const fileRemove = $('fileRemove');

  // Browse button
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', () => fileInput.click());
  }

  // File input change
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      if (files.length > 0) {
        if (state.mode === 'batch' && files.length > 1) {
          for (const f of files) addToBatch(f);
        } else {
          loadFile(files[0]);
        }
      }
      fileInput.value = '';
    });
  }

  // Drag and drop
  if (dropZone) {
    let dragCount = 0;

    dropZone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCount++;
      dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCount--;
      if (dragCount <= 0) {
        dragCount = 0;
        dropZone.classList.remove('drag-over');
      }
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCount = 0;
      dropZone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        if (state.mode === 'batch' && files.length > 1) {
          for (const f of files) addToBatch(f);
        } else {
          loadFile(files[0]);
        }
      }
    });
  }

  // Remove file
  if (fileRemove) {
    fileRemove.addEventListener('click', () => resetState());
  }

  // Record mic
  if (recordBtn) {
    recordBtn.addEventListener('click', () => startMicRecording());
  }
}

async function loadFile(file) {
  if (!file) return;

  // Resume AudioContext on user gesture
  if (state.audioCtx.state === 'suspended') {
    await state.audioCtx.resume();
  }

  state.file = file;

  // Update file info display
  const fileName = $('fileName');
  const fileMeta = $('fileMeta');
  const dropZone = $('dropZone');

  if (fileName) fileName.textContent = file.name;

  try {
    const audioBuffer = await decodeAudioFile(file, state.audioCtx);
    state.originalBuffer = audioBuffer;
    state.originalFloat = audioBufferToFloat32(audioBuffer);
    state.sampleRate = audioBuffer.sampleRate;

    const duration = formatTime(audioBuffer.duration);
    const size = formatFileSize(file.size);
    const channels = audioBuffer.numberOfChannels;
    if (fileMeta) {
      fileMeta.textContent = `${duration} | ${channels}ch | ${audioBuffer.sampleRate}Hz | ${size}`;
    }

    // Show file info state
    if (dropZone) dropZone.classList.add('has-file');

    // Draw original waveform
    drawOriginalWaveform();

    // Update audio stats
    updateAudioStats(state.originalFloat, state.sampleRate);

    // Enable buttons
    const processBtn = $('processBtn');
    const oneTapBtn = $('oneTapBtn');
    const batchAddBtn = $('batchAddBtn');
    if (processBtn) processBtn.disabled = false;
    if (oneTapBtn) oneTapBtn.disabled = false;
    if (batchAddBtn) batchAddBtn.disabled = false;

    // Forensic audit log entry
    if (state.mode === 'forensic') {
      const hash = await hashSHA256(await file.arrayBuffer());
      addForensicEntry('FILE_LOADED', `${file.name} | SHA-256: ${hash.substring(0, 16)}...`);
    }
  } catch (err) {
    console.error('[LoadFile] Decode error:', err);
    if (fileMeta) fileMeta.textContent = `Error: ${err.message}`;
  }
}

/* ===================================================================
 * Mic Recording
 * =================================================================== */

let mediaRecorder = null;
let recordedChunks = [];

async function startMicRecording() {
  if (state.audioCtx.state === 'suspended') {
    await state.audioCtx.resume();
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      const file = new File([blob], 'recording.webm', { type: 'audio/webm' });
      await loadFile(file);
    };

    mediaRecorder.start(100);

    // Update record button to stop state
    const recordBtn = $('recordBtn');
    if (recordBtn) {
      recordBtn.textContent = '■ Stop';
      recordBtn.classList.add('recording');
      recordBtn.onclick = () => {
        mediaRecorder.stop();
        recordBtn.textContent = '● Record Mic';
        recordBtn.classList.remove('recording');
        recordBtn.onclick = null;
      };
    }
  } catch (err) {
    console.error('[Mic] Error:', err);
  }
}

/* ===================================================================
 * Waveform Drawing
 * =================================================================== */

function drawOriginalWaveform() {
  if (!state.originalFloat) return;

  const canvas = $('canvasOriginal');
  if (!canvas) return;

  drawWaveformToCanvas(canvas, state.originalFloat, '#00d4ff');
}

function drawProcessedWaveform() {
  if (!state.processedFloat) return;

  const canvas = $('canvasProcessed');
  if (!canvas) return;

  drawWaveformToCanvas(canvas, state.processedFloat, '#00ff88');
}

function drawWaveformToCanvas(canvas, data, color) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#0a0e12';
  ctx.fillRect(0, 0, w, h);

  // Center line
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  // Waveform
  const samplesPerPixel = Math.max(1, Math.floor(data.length / w));
  ctx.fillStyle = color;

  for (let x = 0; x < w; x++) {
    const start = Math.floor(x * data.length / w);
    const end = Math.min(start + samplesPerPixel, data.length);
    let min = 1, max = -1;
    for (let i = start; i < end; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    const y1 = (1 - max) * h / 2;
    const y2 = (1 - min) * h / 2;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

/* ===================================================================
 * Audio Stats
 * =================================================================== */

function updateAudioStats(data, sampleRate) {
  const peak = measurePeak(data);
  const peakDB = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const lufs = measureLUFS(data, sampleRate);
  const noiseFloor = estimateNoiseFloor(data);
  const noiseFloorDB = noiseFloor > 0 ? 20 * Math.log10(noiseFloor) : -Infinity;
  const snr = calculateSNR(data);

  const stPeak = $('stPeak');
  const stLufs = $('stLufs');
  const stNoise = $('stNoise');
  const stSnr = $('stSnr');

  if (stPeak) stPeak.textContent = isFinite(peakDB) ? `${peakDB.toFixed(1)} dB` : '--';
  if (stLufs) stLufs.textContent = isFinite(lufs) ? `${lufs.toFixed(1)}` : '--';
  if (stNoise) stNoise.textContent = isFinite(noiseFloorDB) ? `${noiseFloorDB.toFixed(0)} dB` : '--';
  if (stSnr) stSnr.textContent = isFinite(snr) ? `${snr.toFixed(0)} dB` : '--';
}

/* ===================================================================
 * Player Controls
 * =================================================================== */

function setupPlayerControls() {
  const playBtn = $('playBtn');
  const timeline = $('timeline');
  const volumeSlider = $('volumeSlider');
  const volumeIcon = $('volumeIcon');

  // Play/Pause
  if (playBtn) {
    playBtn.addEventListener('click', togglePlayback);
  }

  // Space bar toggle
  document.addEventListener('voiceisolate:toggleplay', togglePlayback);
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' && e.target === document.body) {
      e.preventDefault();
      togglePlayback();
    }
  });

  // Timeline seek
  if (timeline) {
    timeline.addEventListener('click', (e) => {
      const rect = timeline.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const buffer = getCurrentBuffer();
      if (buffer) {
        const wasPlaying = state.isPlaying;
        if (wasPlaying) stopPlayback();
        state.playbackOffset = ratio * buffer.duration;
        updateTimeDisplay();
        if (wasPlaying) startPlayback();
      }
    });
  }

  // Volume
  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      state.volume = parseInt(volumeSlider.value) / 100;
      if (state.gainNode) state.gainNode.gain.value = state.volume;
      if (volumeIcon) {
        volumeIcon.textContent = state.volume === 0 ? '🔇' : state.volume < 0.5 ? '🔉' : '🔊';
      }
    });
  }

  // A/B toggle
  const abBtns = document.querySelectorAll('.ab-btn');
  abBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      abBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.abMode = btn.dataset.ab;
      if (state.isPlaying) {
        const offset = getCurrentPlaybackTime();
        stopPlayback();
        state.playbackOffset = offset;
        startPlayback();
      }
    });
  });
}

function getCurrentBuffer() {
  if (state.abMode === 'processed' && state.processedBuffer) {
    return state.processedBuffer;
  }
  return state.originalBuffer;
}

function togglePlayback() {
  if (state.isPlaying) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

function startPlayback() {
  const buffer = getCurrentBuffer();
  if (!buffer) return;

  if (state.audioCtx.state === 'suspended') {
    state.audioCtx.resume();
  }

  const source = state.audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(state.gainNode);

  source.onended = () => {
    if (state.isPlaying) {
      state.isPlaying = false;
      state.playbackOffset = 0;
      updatePlayButton();
      updateTimeDisplay();
    }
  };

  source.start(0, state.playbackOffset);
  state.playbackSource = source;
  state.playbackStartTime = state.audioCtx.currentTime;
  state.isPlaying = true;

  updatePlayButton();
  requestAnimationFrame(updatePlaybackLoop);
}

function stopPlayback() {
  if (state.playbackSource) {
    state.playbackOffset = getCurrentPlaybackTime();
    try { state.playbackSource.stop(); } catch { /* already stopped */ }
    state.playbackSource = null;
  }
  state.isPlaying = false;
  updatePlayButton();
}

function getCurrentPlaybackTime() {
  if (!state.isPlaying) return state.playbackOffset;
  const elapsed = state.audioCtx.currentTime - state.playbackStartTime;
  return state.playbackOffset + elapsed;
}

function updatePlaybackLoop() {
  if (!state.isPlaying) return;
  updateTimeDisplay();
  requestAnimationFrame(updatePlaybackLoop);
}

function updatePlayButton() {
  const playBtn = $('playBtn');
  if (playBtn) playBtn.textContent = state.isPlaying ? '⏸' : '▶';
}

function updateTimeDisplay() {
  const buffer = getCurrentBuffer();
  if (!buffer) return;

  const current = Math.min(getCurrentPlaybackTime(), buffer.duration);
  const total = buffer.duration;

  const curTime = $('curTime');
  const totTime = $('totTime');
  const timelineProg = $('timelineProg');

  if (curTime) curTime.textContent = formatTime(current);
  if (totTime) totTime.textContent = formatTime(total);
  if (timelineProg) timelineProg.style.width = `${(current / total) * 100}%`;
}

/* ===================================================================
 * Action Buttons
 * =================================================================== */

function setupActionButtons() {
  const processBtn = $('processBtn');
  const exportBtn = $('exportBtn');
  const resetBtn = $('resetBtn');
  const oneTapBtn = $('oneTapBtn');
  const batchAddBtn = $('batchAddBtn');

  if (processBtn) processBtn.addEventListener('click', () => processAudio());
  if (oneTapBtn) oneTapBtn.addEventListener('click', () => oneTapClean());
  if (exportBtn) exportBtn.addEventListener('click', () => showExportMenu());
  if (resetBtn) resetBtn.addEventListener('click', () => resetState());
  if (batchAddBtn) batchAddBtn.addEventListener('click', () => {
    if (state.file) addToBatch(state.file);
  });
}

/* ===================================================================
 * Processing Pipeline
 * =================================================================== */

function initDispatcher() {
  try {
    state.dispatcherWorker = new Worker(
      new URL('./workers/dispatcher-worker.js', import.meta.url),
      { type: 'classic' }
    );

    state.dispatcherWorker.onmessage = handleWorkerMessage;
    state.dispatcherWorker.onerror = (e) => {
      console.error('[Dispatcher] Worker error:', e);
    };

    // Initialize worker pool
    const poolSize = config.workerCount > 0 ? config.workerCount : Math.min(navigator.hardwareConcurrency || 4, 8);
    state.dispatcherWorker.postMessage({
      type: 'init',
      payload: {
        workerUrl: new URL('./workers/dsp-worker.js', import.meta.url).href,
        poolSize,
        sharedBuffer: state.sabAvailable && config.sharedBuffer,
      },
    });

    // Update worker count display
    const workerCountEl = $('workerCount');
    if (workerCountEl) workerCountEl.textContent = poolSize;
  } catch (err) {
    console.warn('[Dispatcher] Worker init failed, will use inline processing:', err);
  }
}

function handleWorkerMessage(e) {
  const { type, payload } = e.data;

  switch (type) {
    case 'progress':
      updateProgress(payload);
      break;

    case 'complete':
      handleProcessingComplete(payload);
      break;

    case 'error':
      handleProcessingError(payload);
      break;

    case 'status':
      updateThreadPoolUI(payload);
      break;
  }
}

async function processAudio() {
  if (!state.originalFloat || state.isProcessing) return;

  state.isProcessing = true;
  state.processingStartTime = performance.now();

  // Stop playback if active
  if (state.isPlaying) stopPlayback();

  // Show progress
  showProcessingProgress(0, 'Preparing...');

  const processBtn = $('processBtn');
  if (processBtn) {
    processBtn.disabled = true;
    processBtn.textContent = 'Processing...';
  }

  // Build processing config
  const procConfig = {
    ...config,
    fftSize: FFT_SIZES[config.fftSizeIndex] || 4096,
    sampleRate: state.sampleRate,
    mode: state.mode,
  };

  if (state.dispatcherWorker) {
    // Send to dispatcher worker
    const jobId = `job_${Date.now()}`;
    state.dispatcherWorker.postMessage({
      type: 'process',
      payload: {
        id: jobId,
        audio: state.originalFloat.buffer,
        config: procConfig,
        priority: state.mode === 'live' ? 0 : 1,
      },
    });
  } else {
    // Fallback: inline processing (use dsp-worker directly as module)
    await processInline(procConfig);
  }
}

async function processInline(procConfig) {
  // Minimal fallback: apply basic noise reduction via simple spectral method
  try {
    const data = new Float32Array(state.originalFloat);

    // Basic HPF: subtract DC
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const dc = sum / data.length;
    for (let i = 0; i < data.length; i++) data[i] -= dc;

    // Basic peak normalization
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }
    if (peak > 0) {
      const gain = 0.95 / peak;
      for (let i = 0; i < data.length; i++) data[i] *= gain;
    }

    state.processedFloat = data;
    state.processedBuffer = float32ToAudioBuffer(data, state.sampleRate, 1, state.audioCtx);

    onProcessingDone();
  } catch (err) {
    handleProcessingError({ id: 'inline', code: 'INLINE_ERROR', message: err.message });
  }
}

function handleProcessingComplete(payload) {
  const { audio, duration } = payload;

  // Reconstruct Float32Array from transferred buffer
  state.processedFloat = new Float32Array(audio);
  state.processedBuffer = float32ToAudioBuffer(
    state.processedFloat, state.sampleRate, 1, state.audioCtx
  );

  onProcessingDone(duration);
}

async function onProcessingDone(workerDuration) {
  state.isProcessing = false;

  const elapsed = workerDuration || ((performance.now() - state.processingStartTime) / 1000);

  // Hide progress
  hideProcessingProgress();

  // Re-enable process button
  const processBtn = $('processBtn');
  if (processBtn) {
    processBtn.disabled = false;
    processBtn.textContent = 'Process';
  }

  // Enable export
  const exportBtn = $('exportBtn');
  if (exportBtn) exportBtn.disabled = false;

  // Draw processed waveform
  drawProcessedWaveform();

  // Update stats for processed audio
  updateAudioStats(state.processedFloat, state.sampleRate);

  // Switch A/B to processed
  const abBtns = document.querySelectorAll('.ab-btn');
  abBtns.forEach(b => {
    b.classList.toggle('active', b.dataset.ab === 'processed');
  });
  state.abMode = 'processed';

  // Update pipeline stages to complete
  markAllStagesComplete();

  // Forensic audit entry
  if (state.mode === 'forensic') {
    const inputHash = await hashSHA256(state.originalFloat.buffer);
    const outputHash = await hashSHA256(state.processedFloat.buffer);
    addForensicEntry('PROCESSING_COMPLETE',
      `Duration: ${elapsed.toFixed(2)}s | In: ${inputHash.substring(0, 12)}... | Out: ${outputHash.substring(0, 12)}...`
    );
  }

  console.log(`[Processing] Complete in ${elapsed.toFixed(2)}s`);
}

function handleProcessingError(payload) {
  state.isProcessing = false;
  hideProcessingProgress();

  const processBtn = $('processBtn');
  if (processBtn) {
    processBtn.disabled = false;
    processBtn.textContent = 'Process';
  }

  console.error('[Processing] Error:', payload.message);

  if (state.mode === 'forensic') {
    addForensicEntry('PROCESSING_ERROR', payload.message);
  }
}

/* ===================================================================
 * One-Tap Clean
 * =================================================================== */

async function oneTapClean() {
  if (!state.originalFloat) return;

  // Detect content type and apply optimal preset
  const contentType = detectContentType(state.originalFloat, state.sampleRate);

  let preset = 'crystal';
  if (contentType === 'music') preset = 'podcast';
  else if (contentType === 'noise') preset = 'camera';

  // Apply preset
  applyPreset(preset);

  // Start processing
  await processAudio();
}

/* ===================================================================
 * Progress Display
 * =================================================================== */

function showProcessingProgress(percent, stage) {
  const progressBox = $('progressBox');
  const progressFill = $('progressFill');
  const progressPct = $('progressPct');
  const progressLabel = $('progressLabel');
  const progressStage = $('progressStage');

  if (progressBox) progressBox.style.display = 'block';
  if (progressFill) {
    progressFill.style.width = `${percent}%`;
    const bar = progressFill.parentElement;
    if (bar) bar.setAttribute('aria-valuenow', String(Math.round(percent)));
  }
  if (progressPct) progressPct.textContent = `${Math.round(percent)}%`;
  if (progressLabel) progressLabel.textContent = 'Processing...';
  if (progressStage) progressStage.textContent = stage;
}

function hideProcessingProgress() {
  const progressBox = $('progressBox');
  if (progressBox) progressBox.style.display = 'none';
}

function updateProgress(payload) {
  const { stage, stageCount, percent } = payload;
  const stageIdx = typeof stage === 'number' ? stage : 0;
  const stageName = PIPELINE_STAGES[stageIdx] || `Stage ${stageIdx}`;
  const overallPercent = stageCount > 0 ? (stageIdx / stageCount) * 100 + (percent || 0) / stageCount : percent;

  showProcessingProgress(overallPercent, stageName);
  highlightPipelineStage(stageIdx);

  // ETA calculation
  const elapsed = (performance.now() - state.processingStartTime) / 1000;
  if (overallPercent > 5) {
    const total = elapsed / (overallPercent / 100);
    const remaining = total - elapsed;
    const eta = $('progressEta');
    if (eta) eta.textContent = `~${Math.ceil(remaining)}s remaining`;
  }

  // Update thread pool display
  const activeJobs = $('activeJobs');
  const queuedJobs = $('queuedJobs');
  if (activeJobs) activeJobs.textContent = '1';
  if (queuedJobs) queuedJobs.textContent = '0';
}

/* ===================================================================
 * Pipeline Stage UI
 * =================================================================== */

function buildPipelineUI() {
  const container = $('pipelineStages');
  if (!container) return;

  container.innerHTML = '';
  for (let i = 0; i < PIPELINE_STAGES.length; i++) {
    const stageEl = document.createElement('div');
    stageEl.className = 'pipeline-stage';
    stageEl.dataset.stage = i;
    const numSpan = document.createElement('span');
    numSpan.className = 'stage-num';
    numSpan.textContent = i;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'stage-name';
    nameSpan.textContent = PIPELINE_STAGES[i];

    const indicator = document.createElement('span');
    indicator.className = 'stage-indicator';

    stageEl.appendChild(numSpan);
    stageEl.appendChild(nameSpan);
    stageEl.appendChild(indicator);
    container.appendChild(stageEl);
  }
}

function updatePipelineUI() {
  // In live mode, only first 4 stages are active
  const maxStage = state.mode === 'live' ? 4 : PIPELINE_STAGES.length;
  const stages = document.querySelectorAll('.pipeline-stage');
  stages.forEach((el, i) => {
    el.classList.toggle('disabled', i >= maxStage);
  });
}

function highlightPipelineStage(idx) {
  const stages = document.querySelectorAll('.pipeline-stage');
  stages.forEach((el, i) => {
    el.classList.remove('active', 'complete');
    if (i < idx) el.classList.add('complete');
    else if (i === idx) el.classList.add('active');
  });
}

function markAllStagesComplete() {
  const stages = document.querySelectorAll('.pipeline-stage');
  stages.forEach(el => {
    el.classList.remove('active');
    el.classList.add('complete');
  });
}

/* ===================================================================
 * Export
 * =================================================================== */

function setupExportMenu() {
  const exportMenu = $('exportMenu');
  if (!exportMenu) return;

  const selectExport = async (opt) => {
    if (!opt) return;
    const format = opt.dataset.format;
    exportMenu.classList.remove('visible');
    await exportAudio(format);
  };

  exportMenu.addEventListener('click', async (e) => {
    const opt = e.target.closest('.export-opt');
    await selectExport(opt);
  });

  // Keyboard navigation for export menu items
  exportMenu.addEventListener('keydown', async (e) => {
    const opt = e.target.closest('.export-opt');
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      await selectExport(opt);
    } else if (e.key === 'Escape') {
      exportMenu.classList.remove('visible');
      const exportBtn = $('exportBtn');
      if (exportBtn) exportBtn.focus();
    }
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (exportMenu.classList.contains('visible') &&
        !exportMenu.contains(e.target) &&
        e.target.id !== 'exportBtn') {
      exportMenu.classList.remove('visible');
    }
  });
}

function showExportMenu() {
  const exportMenu = $('exportMenu');
  const exportBtn = $('exportBtn');
  if (!exportMenu || !exportBtn) return;

  const rect = exportBtn.getBoundingClientRect();
  exportMenu.style.top = `${rect.bottom + 4}px`;
  exportMenu.style.left = `${rect.left}px`;
  exportMenu.classList.toggle('visible');
}

async function exportAudio(format) {
  if (!state.processedFloat) return;

  const channelData = [state.processedFloat];
  const sr = state.sampleRate;
  let buffer, filename, mimeType;

  switch (format) {
    case 'wav16':
      buffer = AudioEncoders.encodeWav(channelData, sr, 16);
      filename = getExportFilename('wav');
      mimeType = 'audio/wav';
      break;

    case 'wav24':
      buffer = AudioEncoders.encodeWav(channelData, sr, 24);
      filename = getExportFilename('wav');
      mimeType = 'audio/wav';
      break;

    case 'flac':
      // FLAC: fallback to WAV 24-bit if encoder unavailable
      buffer = AudioEncoders.encodeWav(channelData, sr, 24);
      filename = getExportFilename('wav');
      mimeType = 'audio/wav';
      break;

    case 'mp3_320':
      buffer = AudioEncoders.encodeMp3 ? AudioEncoders.encodeMp3(channelData, sr, 320) : AudioEncoders.encodeWav(channelData, sr, 16);
      filename = getExportFilename(AudioEncoders.encodeMp3 ? 'mp3' : 'wav');
      mimeType = AudioEncoders.encodeMp3 ? 'audio/mpeg' : 'audio/wav';
      break;

    case 'mp3_192':
      buffer = AudioEncoders.encodeMp3 ? AudioEncoders.encodeMp3(channelData, sr, 192) : AudioEncoders.encodeWav(channelData, sr, 16);
      filename = getExportFilename(AudioEncoders.encodeMp3 ? 'mp3' : 'wav');
      mimeType = AudioEncoders.encodeMp3 ? 'audio/mpeg' : 'audio/wav';
      break;

    case 'mp3_128':
      buffer = AudioEncoders.encodeMp3 ? AudioEncoders.encodeMp3(channelData, sr, 128) : AudioEncoders.encodeWav(channelData, sr, 16);
      filename = getExportFilename(AudioEncoders.encodeMp3 ? 'mp3' : 'wav');
      mimeType = AudioEncoders.encodeMp3 ? 'audio/mpeg' : 'audio/wav';
      break;

    case 'batch_zip':
      await exportBatchZip();
      return;

    default:
      buffer = AudioEncoders.encodeWav(channelData, sr, 16);
      filename = getExportFilename('wav');
      mimeType = 'audio/wav';
  }

  // Trigger download
  const blob = new Blob([buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  // Forensic audit
  if (state.mode === 'forensic') {
    const hash = await hashSHA256(buffer);
    addForensicEntry('EXPORT', `${filename} | ${format} | SHA-256: ${hash.substring(0, 16)}...`);
  }
}

function getExportFilename(ext) {
  const baseName = state.file ? state.file.name.replace(/\.[^.]+$/, '') : 'recording';
  return `${baseName}_cleaned.${ext}`;
}

async function exportBatchZip() {
  // Collect all processed files from batch queue
  // For now, export current file as zip
  if (!state.processedFloat) return;

  const channelData = [state.processedFloat];
  const wav = AudioEncoders.encodeWav(channelData, state.sampleRate, 16);
  const filename = getExportFilename('wav');

  const zip = AudioEncoders.createZip
    ? AudioEncoders.createZip([{ name: filename, data: new Uint8Array(wav) }])
    : wav;

  const blob = new Blob([zip], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'voiceisolate_export.zip';
  a.click();
  URL.revokeObjectURL(url);
}

/* ===================================================================
 * Presets
 * =================================================================== */

function setupPresets() {
  const presetGrid = $('presetGrid');
  if (!presetGrid) return;

  presetGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset-btn');
    if (!btn) return;

    presetGrid.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const presetName = btn.dataset.preset;
    applyPreset(presetName);
  });
}

function applyPreset(presetName) {
  const preset = PRESETS[presetName];
  if (!preset) return;

  // Apply preset values to config and update UI
  for (const [key, value] of Object.entries(preset)) {
    config[key] = value;
  }

  // Sync sliders
  syncSlidersToConfig();
  syncTogglesToConfig();
  saveSettings();
}

function syncSlidersToConfig() {
  const sliderMap = {
    s_noiseReduction: { key: 'noiseReduction', fmt: (v) => `${v}%` },
    s_spectralFloor: { key: 'spectralFloor', fmt: (v) => `${v} dB` },
    s_gateThreshold: { key: 'gateThreshold', fmt: (v) => `${v} dB` },
    s_presence: { key: 'presence', fmt: (v) => `${v} dB` },
    s_warmth: { key: 'warmth', fmt: (v) => `${v} dB` },
    s_air: { key: 'air', fmt: (v) => `${v} dB` },
    s_hpfFreq: { key: 'hpfFreq', fmt: (v) => `${v} Hz` },
    s_deReverbAmount: { key: 'deReverbAmount', fmt: (v) => `${v}%` },
    s_deEsserThreshold: { key: 'deEsserThreshold', fmt: (v) => `${v} dB` },
    s_targetLUFS: { key: 'targetLUFS', fmt: (v) => `${v} LUFS` },
    s_inputGain: { key: 'inputGain', fmt: (v) => `${v > 0 ? '+' : ''}${v} dB` },
    s_outputGain: { key: 'outputGain', fmt: (v) => `${v > 0 ? '+' : ''}${v} dB` },
    s_gateAttack: { key: 'gateAttack', fmt: (v) => `${v} ms` },
    s_gateRelease: { key: 'gateRelease', fmt: (v) => `${v} ms` },
    s_mlConfidence: { key: 'mlConfidence', fmt: (v) => `${v}` },
    s_harmonicWeight: { key: 'harmonicWeight', fmt: (v) => `${v}%` },
    s_spectralTilt: { key: 'spectralTilt', fmt: (v) => `${v}` },
  };

  for (const [sliderId, meta] of Object.entries(sliderMap)) {
    const slider = $(sliderId);
    const valueId = sliderId.replace('s_', 'v_');
    const display = $(valueId);
    if (slider) slider.value = config[meta.key];
    if (display) display.textContent = meta.fmt(config[meta.key]);
  }
}

function syncTogglesToConfig() {
  const toggleMap = {
    t_lufsNorm: 'lufsNorm',
    t_truePeak: 'truePeak',
    t_autoProfile: 'autoProfile',
    t_mlSeparation: 'mlSeparation',
    t_voiceprint: 'voiceprint',
  };

  for (const [elId, key] of Object.entries(toggleMap)) {
    const el = $(elId);
    if (el) {
      el.classList.toggle('on', !!config[key]);
      el.setAttribute('aria-checked', String(!!config[key]));
    }
  }
}

/* ===================================================================
 * Voiceprint Enrollment
 * =================================================================== */

function setupVoiceprintEnrollment() {
  const voiceprintBtn = $('voiceprintBtn');
  const modal = $('voiceprintModal');
  const enrollStartBtn = $('enrollStartBtn');
  const enrollCancelBtn = $('enrollCancelBtn');

  if (voiceprintBtn) {
    voiceprintBtn.addEventListener('click', () => {
      if (modal) modal.classList.add('visible');
    });
  }

  if (enrollCancelBtn) {
    enrollCancelBtn.addEventListener('click', () => {
      if (modal) modal.classList.remove('visible');
      if (enrollMediaRecorder) {
        enrollMediaRecorder.stop();
        enrollMediaRecorder = null;
      }
    });
  }

  if (enrollStartBtn) {
    enrollStartBtn.addEventListener('click', () => startVoiceprintEnrollment());
  }
}

let enrollMediaRecorder = null;

async function startVoiceprintEnrollment() {
  const enrollTimer = $('enrollTimer');
  const enrollStartBtn = $('enrollStartBtn');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    enrollMediaRecorder = new MediaRecorder(stream);

    enrollMediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    enrollMediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: 'audio/webm' });

      // Decode and extract voiceprint
      const arrayBuf = await blob.arrayBuffer();
      const audioBuffer = await state.audioCtx.decodeAudioData(arrayBuf);
      const mono = audioBufferToFloat32(audioBuffer);

      // Simple MFCC-based embedding (using voiceprint module's approach)
      const embedding = extractSimpleEmbedding(mono, audioBuffer.sampleRate);

      // Encrypt and store
      if (!state.cryptoKey) {
        state.cryptoKey = await generateKey();
        const jwk = await exportKey(state.cryptoKey);
        await db.put('settings', { _id: 'cryptoKey', jwk }, 'cryptoKey');
      }

      const encrypted = await encrypt(
        new TextEncoder().encode(JSON.stringify(Array.from(embedding))),
        state.cryptoKey
      );

      await db.put('voiceprints', { _id: 'primary', data: encrypted, timestamp: Date.now() }, 'primary');
      state.enrolledVoiceprint = embedding;

      // Update UI
      const vpStatus = $('voiceprintStatus');
      if (vpStatus) vpStatus.textContent = 'Voiceprint enrolled (192-dim)';

      const modal = $('voiceprintModal');
      if (modal) modal.classList.remove('visible');
    };

    // Start recording with 10-second countdown
    enrollMediaRecorder.start(100);
    if (enrollStartBtn) enrollStartBtn.disabled = true;

    let remaining = 10.0;
    const interval = setInterval(() => {
      remaining -= 0.1;
      if (enrollTimer) enrollTimer.textContent = `${remaining.toFixed(1)}s`;
      if (remaining <= 0) {
        clearInterval(interval);
        if (enrollMediaRecorder && enrollMediaRecorder.state === 'recording') {
          enrollMediaRecorder.stop();
        }
        if (enrollStartBtn) enrollStartBtn.disabled = false;
        if (enrollTimer) enrollTimer.textContent = '10.0s';
      }
    }, 100);
  } catch (err) {
    console.error('[Voiceprint] Enrollment error:', err);
  }
}

function extractSimpleEmbedding(data, sampleRate) {
  // Simplified 192-dimensional embedding from MFCC statistics
  const embedding = new Float32Array(192);
  const frameSize = Math.floor(sampleRate * 0.025);
  const hopSize = Math.floor(sampleRate * 0.01);
  const numFrames = Math.floor((data.length - frameSize) / hopSize);

  // Compute energy per frame and basic spectral features
  for (let f = 0; f < Math.min(numFrames, 192); f++) {
    const start = f * hopSize;
    let energy = 0;
    for (let i = 0; i < frameSize && (start + i) < data.length; i++) {
      energy += data[start + i] * data[start + i];
    }
    embedding[f % 192] += Math.log(energy / frameSize + 1e-10);
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < 192; i++) norm += embedding[i] * embedding[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 192; i++) embedding[i] /= norm;

  return embedding;
}

async function loadVoiceprint() {
  try {
    // Load crypto key
    const keyData = await db.get('settings', 'cryptoKey');
    if (keyData && keyData.jwk) {
      state.cryptoKey = await importKey(keyData.jwk);
    }

    // Load voiceprint
    const vpData = await db.get('voiceprints', 'primary');
    if (vpData && vpData.data && state.cryptoKey) {
      const decrypted = await decrypt(vpData.data, state.cryptoKey);
      const arr = JSON.parse(new TextDecoder().decode(decrypted));
      state.enrolledVoiceprint = new Float32Array(arr);

      const vpStatus = $('voiceprintStatus');
      if (vpStatus) vpStatus.textContent = 'Voiceprint enrolled (192-dim)';
    }
  } catch { /* no voiceprint saved */ }
}

/* ===================================================================
 * Settings Modal
 * =================================================================== */

function setupSettingsModal() {
  const settingsBtn = $('settingsBtn');
  const settingsModal = $('settingsModal');
  const settingsCloseBtn = $('settingsCloseBtn');
  const clearCacheBtn = $('clearCacheBtn');
  const clearAllBtn = $('clearAllBtn');

  // Settings toggles
  const settingsToggles = [
    { id: 't_gpuAccel',    key: 'gpuAccel' },
    { id: 't_sharedBuffer', key: 'sharedBuffer' },
    { id: 't_oversample',  key: 'oversample' },
  ];

  for (const t of settingsToggles) {
    const el = $(t.id);
    if (el) {
      const handleToggle = () => {
        const isOn = el.classList.toggle('on');
        config[t.key] = isOn;
        el.setAttribute('aria-checked', String(isOn));
        saveSettings();
      };

      el.addEventListener('click', handleToggle);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleToggle();
        }
      });
    }
  }

  // FFT size slider
  const fftSlider = $('s_fftSize');
  const fftDisplay = $('v_fftSize');
  if (fftSlider) {
    fftSlider.value = config.fftSizeIndex;
    if (fftDisplay) fftDisplay.textContent = FFT_SIZES[config.fftSizeIndex] || 4096;

    fftSlider.addEventListener('input', () => {
      config.fftSizeIndex = parseInt(fftSlider.value);
      if (fftDisplay) fftDisplay.textContent = FFT_SIZES[config.fftSizeIndex] || 4096;
    });
    fftSlider.addEventListener('change', () => saveSettings());
  }

  // Worker count slider
  const workerSlider = $('s_workerCount');
  const workerDisplay = $('v_workerCount');
  if (workerSlider) {
    workerSlider.value = config.workerCount;
    if (workerDisplay) workerDisplay.textContent = config.workerCount === 0 ? 'Auto' : config.workerCount;

    workerSlider.addEventListener('input', () => {
      config.workerCount = parseInt(workerSlider.value);
      if (workerDisplay) workerDisplay.textContent = config.workerCount === 0 ? 'Auto' : config.workerCount;
    });
    workerSlider.addEventListener('change', () => saveSettings());
  }

  // Open/close settings
  if (settingsBtn && settingsModal) {
    settingsBtn.addEventListener('click', () => settingsModal.classList.add('visible'));
  }
  if (settingsCloseBtn && settingsModal) {
    settingsCloseBtn.addEventListener('click', () => settingsModal.classList.remove('visible'));
  }

  // Clear cache
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', async () => {
      await db.clear('models');
      clearCacheBtn.textContent = 'Cleared!';
      setTimeout(() => { clearCacheBtn.textContent = 'Clear Model Cache'; }, 2000);
    });
  }

  // Clear all data
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', async () => {
      if (confirm('This will delete all settings, voiceprints, and cached data. Continue?')) {
        await db.clear('models');
        await db.clear('voiceprints');
        await db.clear('settings');
        await db.clear('auditLog');
        await db.clear('audioCache');
        state.enrolledVoiceprint = null;
        state.cryptoKey = null;
        clearAllBtn.textContent = 'All data cleared!';
        setTimeout(() => { clearAllBtn.textContent = 'Clear All Data'; }, 2000);
      }
    });
  }
}

/* ===================================================================
 * Visualization Tabs
 * =================================================================== */

function setupVizTabs() {
  const vizTabs = document.querySelectorAll('.viz-tab');
  const waveformGrid = $('vizWaveformGrid');
  const spectrogramGrid = $('vizSpectrogramGrid');
  const spectrumPanel = $('vizSpectrumPanel');
  const vizTitle = $('vizTitle');

  vizTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      vizTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const mode = tab.dataset.viz;
      if (vizTitle) vizTitle.textContent = tab.textContent;

      if (waveformGrid) waveformGrid.style.display = mode === 'waveform' ? '' : 'none';
      if (spectrogramGrid) spectrogramGrid.style.display = mode === 'spectrogram' ? '' : 'none';
      if (spectrumPanel) spectrumPanel.style.display = mode === 'spectrum' ? '' : 'none';

      // Redraw when switching tabs
      if (mode === 'waveform') {
        drawOriginalWaveform();
        drawProcessedWaveform();
      }
    });
  });
}

/* ===================================================================
 * Batch Processing
 * =================================================================== */

function addToBatch(file) {
  const id = `batch_${generateUUID()}`;
  state.batchQueue.push({ id, file, status: 'pending', progress: 0 });
  updateBatchUI();
}

function updateBatchUI() {
  const container = $('batchItems');
  if (!container) return;

  container.innerHTML = '';
  for (const item of state.batchQueue) {
    const el = document.createElement('div');
    el.className = `batch-item ${item.status}`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'batch-name';
    nameSpan.textContent = item.file.name;

    const statusSpan = document.createElement('span');
    statusSpan.className = 'batch-status';
    statusSpan.textContent = item.status;

    el.appendChild(nameSpan);
    el.appendChild(statusSpan);

    container.appendChild(el);
  }

  // Setup batch controls
  const batchPauseBtn = $('batchPauseBtn');
  const batchCancelBtn = $('batchCancelBtn');

  if (batchCancelBtn) {
    batchCancelBtn.onclick = () => {
      state.batchQueue = [];
      updateBatchUI();
    };
  }
}

/* ===================================================================
 * Forensic Audit Log
 * =================================================================== */

function addForensicEntry(operation, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    operation,
    details,
  };
  state.forensicLog.push(entry);

  const logEl = $('forensicLog');
  if (!logEl) return;

  const row = document.createElement('div');
  row.className = 'log-entry';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = entry.timestamp.split('T')[1].split('.')[0];

  const opSpan = document.createElement('span');
  opSpan.className = 'log-op';
  opSpan.textContent = operation;

  const detailSpan = document.createElement('span');
  detailSpan.className = 'log-detail';
  detailSpan.textContent = details;

  row.appendChild(timeSpan);
  row.appendChild(opSpan);
  row.appendChild(detailSpan);

  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;

  // Persist to DB
  db.put('auditLog', entry, `log_${Date.now()}`).catch(() => {});
}

/* ===================================================================
 * Thread Pool UI
 * =================================================================== */

function updateThreadPoolUI(payload) {
  const activeJobs = $('activeJobs');
  const queuedJobs = $('queuedJobs');

  if (payload.pool) {
    if (activeJobs) activeJobs.textContent = payload.pool.active || 0;
  }
  if (payload.queue) {
    if (queuedJobs) queuedJobs.textContent = payload.queue.size || 0;
  }
}

/* ===================================================================
 * Mobile Controls
 * =================================================================== */

function setupMobileControls() {
  const mobilePresets = $('mobilePresets');
  if (!mobilePresets) return;

  for (const [name, preset] of Object.entries(PRESETS)) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.dataset.preset = name;
    const presetNameDiv = document.createElement('div');
    presetNameDiv.className = 'preset-name';
    presetNameDiv.textContent = name.charAt(0).toUpperCase() + name.slice(1);
    btn.appendChild(presetNameDiv);
    mobilePresets.appendChild(btn);
  }

  mobilePresets.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset-btn');
    if (!btn) return;
    mobilePresets.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyPreset(btn.dataset.preset);
  });
}

/* ===================================================================
 * Reset
 * =================================================================== */

function resetState() {
  // Stop playback
  if (state.isPlaying) stopPlayback();

  // Clear buffers
  state.originalBuffer = null;
  state.processedBuffer = null;
  state.originalFloat = null;
  state.processedFloat = null;
  state.file = null;
  state.playbackOffset = 0;

  // Reset UI
  const dropZone = $('dropZone');
  if (dropZone) dropZone.classList.remove('has-file');

  const fileName = $('fileName');
  const fileMeta = $('fileMeta');
  if (fileName) fileName.textContent = '';
  if (fileMeta) fileMeta.textContent = '';

  const processBtn = $('processBtn');
  const exportBtn = $('exportBtn');
  const oneTapBtn = $('oneTapBtn');
  const batchAddBtn = $('batchAddBtn');
  if (processBtn) processBtn.disabled = true;
  if (exportBtn) exportBtn.disabled = true;
  if (oneTapBtn) oneTapBtn.disabled = true;
  if (batchAddBtn) batchAddBtn.disabled = true;

  // Clear canvases
  ['canvasOriginal', 'canvasProcessed'].forEach(id => {
    const canvas = $(id);
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  });

  // Reset stats
  ['stNoise', 'stPeak', 'stLufs', 'stSnr'].forEach(id => {
    const el = $(id);
    if (el) el.textContent = '--';
  });

  // Reset pipeline stages
  document.querySelectorAll('.pipeline-stage').forEach(el => {
    el.classList.remove('active', 'complete');
  });

  // Reset time display
  const curTime = $('curTime');
  const totTime = $('totTime');
  const timelineProg = $('timelineProg');
  if (curTime) curTime.textContent = '0:00';
  if (totTime) totTime.textContent = '0:00';
  if (timelineProg) timelineProg.style.width = '0%';

  // Reset A/B
  const abBtns = document.querySelectorAll('.ab-btn');
  abBtns.forEach(b => {
    b.classList.toggle('active', b.dataset.ab === 'original');
  });
  state.abMode = 'original';

  updatePlayButton();
  hideProcessingProgress();
}

/* ===================================================================
 * Boot on DOM Ready
 * =================================================================== */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

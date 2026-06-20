/**
 * VoiceIsolate Pro — Landing Page Controller (Layer 4: Presentation)
 *
 * Reference integration of the Stem-Split & Live-Mix pipeline:
 *
 *   fileInput ─► ingestFile() ─► MLWorker ('process') ─► loadStems()
 *                                                          │
 *   sliders ─► SliderUI ─► PlaybackMixer AudioParams ◄─────┘ (play/pause)
 *
 * No microphone. No inline scripts. Inference runs exactly once per file.
 */
'use strict';

import { ingestFile } from '/src/pipeline/FileIngestion.js';
import { PlaybackMixer } from '/src/pipeline/PlaybackMixer.js';
import { SliderUI } from '/src/presentation/SliderUI.js';
import { SpeakerControls } from '/src/presentation/SpeakerControls.js';
import { LandingVisualizer } from '/src/presentation/LandingVisualizer.js';
import { getModel } from '/src/core/ModelManifest.js';
import { MODEL_MANIFEST } from '/src/core/ModelManifest.js';

const $ = (id) => document.getElementById(id);

const ui = {
  fileInput: $('fileInput'),
  modelSelect: $('modelSelect'),
  processBtn: $('processBtn'),
  playBtn: $('playBtn'),
  pauseBtn: $('pauseBtn'),
  stopBtn: $('stopBtn'),
  muteVoiceBtn: $('muteVoiceBtn'),
  muteNoiseBtn: $('muteNoiseBtn'),
  // Live-Mix sliders: disabled in markup until stems exist, then enabled in
  // onStems() so they are never clickable-but-inert (no audio to mix yet).
  mixSliders: [
    $('noiseReductionSlider'), $('voiceLevelSlider'), $('volumeSlider'),
    $('eqLowSlider'), $('eqHighSlider'),
    // Tier-A console
    $('eqLowMidSlider'), $('eqMidSlider'), $('eqHighMidSlider'),
    $('highpassSlider'), $('lowpassSlider'),
    $('compThresholdSlider'), $('compRatioSlider'), $('compAttackSlider'),
    $('compReleaseSlider'), $('compKneeSlider'), $('makeupGainSlider'),
    $('stereoWidthSlider'),
    // Tier-B: noise gate + de-esser
    $('gateThresholdSlider'), $('gateRangeSlider'),
    $('gateAttackSlider'), $('gateReleaseSlider'),
    $('deEsserFreqSlider'), $('deEsserAmountSlider'),
  ],
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  // Realtime processing indicator — DS ProcessLoader component mounts here.
  procLoaderMount: $('procLoaderMount'),
  timeReadout: $('timeReadout'),
  presetSelect: $('presetSelect'),
  waveCanvas: $('waveCanvas'),
  specCanvas: $('specCanvas'),
  // Video preview (shown only for video uploads; muted, mixer drives the clock).
  videoCard: $('videoCard'),
  videoPlayer: $('videoPlayer'),
  speakersPanel: $('speakersPanel'),
  speakerStatus: $('speakerStatus'),
  speakerCardsGrid: $('speakerCardsGrid'),
};

let mixer = null;
let sliderUI = null;
let speakerControls = null;
let visualizer = null;
let worker = null;
let diarWorker = null;
let ingested = null;
let requestSeq = 0;
let diarSeq = 0;
let currentJobLabel = 'Separating stems…';
/** Object URL backing the <video> preview; revoked when a new file loads. */
let videoUrl = null;

const DIARIZATION_TIMEOUT_MS = 60000;

function setStatus(msg, cls = '') {
  ui.statusText.textContent = msg;
  ui.statusDot.className = `status-dot${cls ? ` ${cls}` : ''}`;
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ─── Processing indicator (DS ProcessLoader component) ───────────────────────

// Design-system namespace populated by _ds_bundle.js (classic script, loads
// before this module so the reference is valid at module init time).
const DS = window.VoiceIsolateProDesignSystem_38f745;

const PROC_STAGES = [
  { id: 'decode',   label: 'Decode'   },
  { id: 'resample', label: 'Resample' },
  { id: 'separate', label: 'Separate' },
];

let _procState = { active: 0, progress: 0 };

function _renderProcLoader() {
  const mount = ui.procLoaderMount;
  if (!mount) return;
  mount.innerHTML = '';
  if (DS && DS.ProcessLoader) {
    try {
      const el = DS.ProcessLoader({
        stages: PROC_STAGES,
        active: _procState.active,
        progress: _procState.progress,
      });
      if (el instanceof Node) mount.appendChild(el);
    } catch (err) {
      console.warn('[VIP] ProcessLoader render error:', err);
    }
  } else {
    // Graceful fallback when the DS bundle is unavailable.
    const fb = document.createElement('div');
    fb.style.cssText = 'padding:10px 0;color:var(--text-2);font:var(--fw-medium) var(--fs-sm)/1 var(--font-ui)';
    fb.textContent = PROC_STAGES[_procState.active]
      ? `${PROC_STAGES[_procState.active].label}… ${_procState.progress > 0 ? _procState.progress + '%' : ''}`
      : 'Processing…';
    mount.appendChild(fb);
  }
}

/**
 * Show the ProcessLoader. `indeterminate` is accepted for call-site compat
 * (decode/resample have no known duration); the scan-bar animation always
 * runs so the UI remains active throughout.
 */
function showSpinner(stage, { indeterminate = false } = {}) {
  _procState = { active: stage.toLowerCase().includes('resamp') ? 1 : 0, progress: 0 };
  ui.procLoaderMount.hidden = false;
  _renderProcLoader();
}

/** Advance to the Separate stage and update the live progress percentage. */
function setProgress(percent, stage) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  _procState = { active: 2, progress: pct };
  ui.procLoaderMount.hidden = false;
  _renderProcLoader();
}

function hideSpinner() {
  ui.procLoaderMount.hidden = true;
}

// ─── Video preview (picture in sync with processed audio) ────────────────────

/** Treat as video by MIME type, or by container extension when MIME is absent. */
function isVideoFile(file) {
  if (file.type && file.type.startsWith('video/')) return true;
  return /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/i.test(file.name || '');
}

function loadVideo(file) {
  clearVideo();
  videoUrl = URL.createObjectURL(file);
  const v = ui.videoPlayer;
  v.muted = true; // audio always comes from the Web Audio mixer
  // Reveal only once the element can actually paint a frame, so we never flash
  // an empty black box; drop the preview if the container's video track can't
  // be displayed (audio-only processing still works).
  v.onloadedmetadata = () => { ui.videoCard.hidden = false; };
  v.onerror = () => clearVideo();
  v.src = videoUrl;
}

function clearVideo() {
  if (!videoUrl && ui.videoCard.hidden) return; // nothing loaded — avoid empty-src churn
  const v = ui.videoPlayer;
  // Detach handlers first: removeAttribute('src') + load() fires a spurious
  // 'error' during teardown, which would otherwise re-enter clearVideo.
  v.onloadedmetadata = null;
  v.onerror = null;
  try { v.pause(); } catch { /* not playing */ }
  v.removeAttribute('src');
  try { v.load(); } catch { /* reset is best-effort */ }
  ui.videoCard.hidden = true;
  if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = null; }
}

function hasVideo() { return Boolean(videoUrl) && !ui.videoCard.hidden; }

/**
 * Reconcile the muted <video> to the mixer, which is the single playback clock.
 * Called after every transport action and on a periodic tick so seeks from the
 * waveform (which go straight to mixer.seek) and natural end-of-stream all stay
 * in sync without the video ever driving audio.
 */
function syncVideo() {
  if (!hasVideo() || !mixer) return;
  const v = ui.videoPlayer;
  if (v.readyState < 1) return; // Ensure metadata is loaded before syncing
  const target = mixer.currentTime();
  if (mixer.isPlaying()) {
    if (Math.abs(v.currentTime - target) > 0.3) v.currentTime = target;
    // Muted playback is allowed to start without a user gesture.
    if (v.paused) v.play().catch(() => {});
  } else {
    if (!v.paused) v.pause();
    if (Math.abs(v.currentTime - target) > 0.05) v.currentTime = target;
  }
}

// ─── Worker lifecycle ────────────────────────────────────────────────────────

function getWorker() {
  if (worker) return worker;
  worker = new Worker('/src/workers/MLWorker.js');
  worker.postMessage({ type: 'init', manifest: Object.values(MODEL_MANIFEST) });
  worker.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'ready':
        console.log(`[VIP][landing] MLWorker ready (backend: ${msg.backend})`);
        break;
      case 'progress':
        // Live inference progress: ring + numeric %. The status line keeps the
        // stage label only (set once in onProcess) so the polite aria-live
        // region isn't re-announced on every frame.
        setProgress(msg.percent, currentJobLabel);
        break;
      case 'stems':
        onStems(msg);
        break;
      case 'error':
        setStatus(`Processing failed: ${msg.message}`, 'error');
        hideSpinner();
        ui.processBtn.disabled = false;
        ui.fileInput.disabled = false;
        ui.modelSelect.disabled = false;
        break;
      default:
        break;
    }
  });
  worker.addEventListener('error', (err) => {
    setStatus(`Worker error: ${err.message || 'unknown'}`, 'error');
    hideSpinner();
    ui.processBtn.disabled = false;
    ui.fileInput.disabled = false;
    ui.modelSelect.disabled = false;
  });
  return worker;
}

// ─── Speaker diarization (module worker, one-shot per file) ──────────────────

function getDiarWorker() {
  if (diarWorker) return diarWorker;
  diarWorker = new Worker('/src/workers/DiarizationWorker.js', { type: 'module' });
  return diarWorker;
}

/**
 * Diarize the clean stem off the main thread. Resolves with
 * { segments, speakers }; rejects on worker error or stall (timeout).
 */
function diarize(cleanChannel, sampleRate) {
  return new Promise((resolve, reject) => {
    const w = getDiarWorker();
    const requestId = ++diarSeq;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Diarization stalled (> ${DIARIZATION_TIMEOUT_MS / 1000}s)`));
    }, DIARIZATION_TIMEOUT_MS);
    const onMessage = (event) => {
      const msg = event.data || {};
      if (msg.requestId !== requestId) return;
      cleanup();
      if (msg.type === 'segments') resolve(msg);
      else reject(new Error(msg.message || 'Diarization failed'));
    };
    const onError = (err) => { cleanup(); reject(new Error(err.message || 'Diarization worker error')); };
    const cleanup = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    // Transfer a copy — the mixer already holds its own AudioBuffer copy.
    const samples = new Float32Array(cleanChannel);
    w.postMessage({ type: 'diarize', requestId, samples, sampleRate }, [samples.buffer]);
  });
}

async function detectSpeakers(clean, sampleRate) {
  ui.speakersPanel.hidden = false;
  ui.speakerStatus.textContent = 'Detecting speakers…';
  speakerControls.clear();
  // Staleness guard (same contract as onStems): if another file is processed
  // while diarization is in flight, its result must not touch the new mixer.
  const seq = requestSeq;
  try {
    const { segments, speakers } = await diarize(clean[0], sampleRate);
    if (seq !== requestSeq) return;
    mixer.loadSpeakerSegments(segments);
    const count = speakerControls.render(speakers);
    ui.speakerStatus.textContent = count === 0
      ? 'No distinct speakers detected.'
      : `${count} speaker${count === 1 ? '' : 's'} detected · ${segments.length} segments`;
  } catch (err) {
    if (seq !== requestSeq) return;
    // Graceful degradation: stems + global mutes keep working without it.
    console.error('[VIP][landing] diarization failed:', err);
    mixer.loadSpeakerSegments([]);
    ui.speakerStatus.textContent = `Speaker detection unavailable: ${err.message}`;
  }
}

// ─── Slider value readouts ───────────────────────────────────────────────────

const READOUTS = [
  ['noiseReductionSlider', 'noiseReductionVal', (v) => `${v}%`],
  ['voiceLevelSlider', 'voiceLevelVal', (v) => `${v}%`],
  ['volumeSlider', 'volumeVal', (v) => `${v}%`],
  ['eqLowSlider', 'eqLowVal', (v) => `${v} dB`],
  ['eqHighSlider', 'eqHighVal', (v) => `${v} dB`],
  ['eqLowMidSlider', 'eqLowMidVal', (v) => `${v} dB`],
  ['eqMidSlider', 'eqMidVal', (v) => `${v} dB`],
  ['eqHighMidSlider', 'eqHighMidVal', (v) => `${v} dB`],
  ['highpassSlider', 'highpassVal', (v) => `${v} Hz`],
  ['lowpassSlider', 'lowpassVal', (v) => `${v} Hz`],
  ['compThresholdSlider', 'compThresholdVal', (v) => `${v} dB`],
  ['compRatioSlider', 'compRatioVal', (v) => `${v}:1`],
  ['compAttackSlider', 'compAttackVal', (v) => `${v} ms`],
  ['compReleaseSlider', 'compReleaseVal', (v) => `${v} ms`],
  ['compKneeSlider', 'compKneeVal', (v) => `${v} dB`],
  ['makeupGainSlider', 'makeupGainVal', (v) => `${v} dB`],
  ['stereoWidthSlider', 'stereoWidthVal', (v) => `${v}%`],
  ['gateThresholdSlider', 'gateThresholdVal', (v) => `${v} dB`],
  ['gateRangeSlider', 'gateRangeVal', (v) => `${v} dB`],
  ['gateAttackSlider', 'gateAttackVal', (v) => `${v} ms`],
  ['gateReleaseSlider', 'gateReleaseVal', (v) => `${v} ms`],
  ['deEsserFreqSlider', 'deEsserFreqVal', (v) => `${v} Hz`],
  ['deEsserAmountSlider', 'deEsserAmountVal', (v) => `${v}%`],
];

function wireReadouts() {
  for (const [sliderId, valId, fmt] of READOUTS) {
    const slider = $(sliderId);
    const val = $(valId);
    if (!slider || !val) continue;
    slider.addEventListener('input', () => { val.textContent = fmt(slider.value); });
  }
}

// ─── Presets (preloaded mix calibrations) ────────────────────────────────────
// Values are slider positions, applied by dispatching 'input' events so they
// flow through SliderUI's rAF-coalesced path exactly like a manual drag.
const PRESETS = {
  'voice-clarity':    { noiseReductionSlider: 100, voiceLevelSlider: 115, volumeSlider: 100, eqLowSlider: -4, eqHighSlider: 3 },
  'balanced':         { noiseReductionSlider: 70,  voiceLevelSlider: 100, volumeSlider: 100, eqLowSlider: 0,  eqHighSlider: 1 },
  'podcast-warm':     { noiseReductionSlider: 90,  voiceLevelSlider: 110, volumeSlider: 95,  eqLowSlider: 3,  eqHighSlider: 1 },
  'residual-monitor': { noiseReductionSlider: 0,   voiceLevelSlider: 0,   volumeSlider: 100, eqLowSlider: 0,  eqHighSlider: 0 },
  'original':         { noiseReductionSlider: 0,   voiceLevelSlider: 100, volumeSlider: 100, eqLowSlider: 0,  eqHighSlider: 0 },
};

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  for (const [sliderId, value] of Object.entries(preset)) {
    const el = $(sliderId);
    if (!el) continue;
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// ─── Pipeline glue ───────────────────────────────────────────────────────────

async function onFileChosen() {
  const file = ui.fileInput.files && ui.fileInput.files[0];
  if (!file) return;
  ui.processBtn.disabled = true;
  // Show the picture immediately for videos; hide the player for audio files.
  if (isVideoFile(file)) loadVideo(file); else clearVideo();
  try {
    showSpinner('Decoding…', { indeterminate: true });
    setStatus(`Decoding “${file.name}”…`, 'warn');
    ingested = await ingestFile(file, {
      onProgress: (stage) => {
        if (stage === 'resampling') {
          showSpinner('Resampling to 48 kHz…', { indeterminate: true });
          setStatus('Resampling to 48 kHz…', 'warn');
        }
      },
    });
    hideSpinner();
    setStatus(`Ready: ${ingested.sourceName} · ${fmtTime(ingested.duration)} · ${ingested.numberOfChannels} ch`, '');
    ui.processBtn.disabled = false;
  } catch (err) {
    hideSpinner();
    clearVideo(); // nothing to play — don't leave a dangling preview/object URL
    console.error('[VIP][landing] ingestion failed:', err);
    setStatus(err.message, 'error');
    ingested = null;
  }
}

// UI-level model chains: run several models in series for maximum isolation.
// Keys are <select> values that are NOT single manifest entries; the worker
// receives the resolved `modelIds` array (see MLWorker chain support).
const MODEL_CHAINS = Object.freeze({
  max_isolation: ['bsrnn_vocals', 'rnnoise'], // extract voice, then strip residual noise
});

function onProcess() {
  if (!ingested) return;
  const selection = ui.modelSelect.value;
  const chain = MODEL_CHAINS[selection];
  ui.processBtn.disabled = true;
  ui.fileInput.disabled = true;
  ui.modelSelect.disabled = true;
  currentJobLabel = chain ? 'Maximum isolation (2 passes)…' : 'Separating stems…';
  setProgress(0, currentJobLabel);
  setStatus(currentJobLabel, 'warn');

  // Channel copies are transferred — keep our reference for re-processing.
  const channelData = ingested.channelData.map((c) => new Float32Array(c));
  const msg = { type: 'process', requestId: ++requestSeq, channelData, sampleRate: ingested.sampleRate };
  if (chain) msg.modelIds = chain;
  else msg.modelId = getModel(selection).id;
  getWorker().postMessage(msg, channelData.map((c) => c.buffer));
}

function onStems({ requestId, clean, noise, sampleRate, passthrough }) {
  if (requestId !== requestSeq) return; // stale response
  hideSpinner();
  ui.processBtn.disabled = false;
  ui.fileInput.disabled = false;
  ui.modelSelect.disabled = false;

  if (!mixer) {
    mixer = new PlaybackMixer();
    sliderUI = new SliderUI(mixer);
    sliderUI.bind();
    speakerControls = new SpeakerControls(mixer, ui.speakerCardsGrid);
    visualizer = new LandingVisualizer(mixer, ui.waveCanvas, ui.specCanvas);
    // Read-only diagnostics handle for smoke tests and the debug console.
    globalThis.__vipDiagnostics = { mixer, sliderUI, speakerControls, visualizer };
  }
  mixer.loadStems(clean, noise, sampleRate);
  visualizer.loadStems(clean, noise, mixer.duration());
  syncMuteButtons();

  for (const el of [ui.playBtn, ui.pauseBtn, ui.stopBtn,
    ui.muteVoiceBtn, ui.muteNoiseBtn, ui.presetSelect,
    ...ui.mixSliders]) {
    if (el) el.disabled = false;
  }
  setStatus(
    passthrough
      ? 'Model unavailable — passthrough stems loaded (original audio). Check that /app/models is being served.'
      : 'Stems ready — press Play and mix in real time.',
    passthrough ? 'warn' : 'active'
  );

  // Per-speaker isolation runs on the clean stem; passthrough stems carry the
  // raw mix, so speaker features would be meaningless noise — skip.
  if (passthrough) {
    ui.speakersPanel.hidden = false;
    ui.speakerStatus.textContent = 'Speaker detection skipped — model unavailable (passthrough stems).';
    speakerControls.clear();
  } else {
    detectSpeakers(clean, sampleRate);
  }
}

// ─── Stem mute toggles ───────────────────────────────────────────────────────

function syncMuteButtons() {
  if (!mixer) return;
  const paint = (btn, muted, label) => {
    btn.textContent = muted ? `Unmute ${label}` : `Mute ${label}`;
    btn.classList.toggle('active', muted);
    btn.setAttribute('aria-pressed', String(muted));
  };
  paint(ui.muteVoiceBtn, mixer.isVoiceMuted(), 'Voice');
  paint(ui.muteNoiseBtn, mixer.isNoiseMuted(), 'Background');
}

function wireMuteButtons() {
  ui.muteVoiceBtn.addEventListener('click', () => {
    if (!mixer) return;
    mixer.setVoiceMuted(!mixer.isVoiceMuted());
    syncMuteButtons();
  });
  ui.muteNoiseBtn.addEventListener('click', () => {
    if (!mixer) return;
    mixer.setNoiseMuted(!mixer.isNoiseMuted());
    syncMuteButtons();
  });
}

function wireTransport() {
  ui.playBtn.addEventListener('click', async () => {
    try { await mixer.play(); syncVideo(); } catch (err) { setStatus(err.message, 'error'); }
  });
  ui.pauseBtn.addEventListener('click', () => { if (mixer) { mixer.pause(); syncVideo(); } });
  ui.stopBtn.addEventListener('click', () => { if (mixer) { mixer.stop(); syncVideo(); } });

  // One ticker drives the time readout and keeps the muted video aligned with
  // the mixer clock (covers waveform click-to-seek and natural end-of-stream).
  setInterval(() => {
    if (!mixer) return;
    ui.timeReadout.textContent = `${fmtTime(mixer.currentTime())} / ${fmtTime(mixer.duration())}`;
    syncVideo();
  }, 200);
}

// ─── Boot ────────────────────────────────────────────────────────────────────

ui.fileInput.addEventListener('change', onFileChosen);
ui.processBtn.addEventListener('click', onProcess);
ui.presetSelect.addEventListener('change', () => applyPreset(ui.presetSelect.value));
wireReadouts();
wireTransport();
wireMuteButtons();
setStatus('Idle — choose a file to begin', '');

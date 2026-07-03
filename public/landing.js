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
import { LANDING_PRESETS, calibrateFromStems } from '/src/core/MixCalibration.js';
import { SpeakerControls } from '/src/presentation/SpeakerControls.js';
import { LandingVisualizer } from '/src/presentation/LandingVisualizer.js';
import { getModel } from '/src/core/ModelManifest.js';
import { MODEL_MANIFEST } from '/src/core/ModelManifest.js';
import { detectSpeakers as detectSpeakersPipeline } from '/src/pipeline/SpeakerDetection.js';
import { SLIDER_HINTS } from '/app/slider-map.js';
import { buildHintPanel } from '/app/slider-hint-ui.js';

const $ = (id) => document.getElementById(id);

/** Maps landing slider DOM ids → engineer-mode SLIDER_HINTS keys (or _custom). */
const LANDING_HINT_MAP = Object.freeze({
  noiseReductionSlider: 'nrAmount',
  voiceLevelSlider: '_voiceLevel',
  volumeSlider: 'outGain',
  eqLowSlider: 'eqBass',
  eqHighSlider: 'eqAir',
  eqLowMidSlider: 'eqLowMid',
  eqMidSlider: 'eqMid',
  eqHighMidSlider: 'eqPresence',
  highpassSlider: 'hpFreq',
  lowpassSlider: 'lpFreq',
  compThresholdSlider: 'compThresh',
  compRatioSlider: 'compRatio',
  compAttackSlider: 'compAttack',
  compReleaseSlider: 'compRelease',
  compKneeSlider: 'compKnee',
  makeupGainSlider: 'compMakeup',
  stereoWidthSlider: 'stereoWidth',
  gateThresholdSlider: 'gateThresh',
  gateRangeSlider: 'gateRange',
  gateAttackSlider: 'gateAttack',
  gateReleaseSlider: 'gateRelease',
  deEsserFreqSlider: 'deEssFreq',
  deEsserAmountSlider: '_deEsserPct',
});

const LANDING_CUSTOM_HINTS = Object.freeze({
  _voiceLevel: 'Sets how loud the isolated voice sits against the removed noise stem. Raise toward 130% when the voice feels buried after separation.',
  _deEsserPct: 'Limits how much harsh “S” and “T” sounds are pulled down in the live mix. Raise toward 40% for bright podcast mics; keep near 0% for already-smooth sources.',
});

const ui = {
  fileInput: $('fileInput'),
  uploadZone: $('uploadZone'),
  browseBtn: $('browseBtn'),
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
  // DS StatusPill mounts here (setStatus re-renders it); the Badge and
  // LevelMeter mount points are likewise populated by landing.js.
  statusPillMount: $('statusPillMount'),
  statusText: $('statusText'),
  archBadgeMount: $('archBadgeMount'),
  outputMeterMount: $('outputMeterMount'),
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
  // Upload panel — used as the drag-and-drop target.
  uploadPanel: $('uploadPanel'),
};

let mixer = null;
let sliderUI = null;
let speakerControls = null;
let visualizer = null;
let worker = null;

let ingested = null;
let requestSeq = 0;
let ingestSeq = 0;

let currentJobLabel = 'Separating stems…';
/** Object URL backing the <video> preview; revoked when a new file loads. */
let videoUrl = null;



function setStatus(msg, cls = '') {
  renderStatusPill(STATE_FOR_CLS[cls] || 'pending', msg);
  const legacy = ui.statusText || document.getElementById('statusText');
  if (legacy) legacy.textContent = msg;
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ─── Processing indicator (DS ProcessLoader component) ───────────────────────

// Design-system namespace populated by _ds_bundle.js (classic script, loads
// before this module so the reference is valid at module init time).
const DS = window.VoiceIsolateProDesignSystem_38f745;

// Map the legacy status classes ('', 'warn', 'error', 'active') to the DS
// StatusPill's data-state values.
const STATE_FOR_CLS = { '': 'pending', warn: 'warn', error: 'error', active: 'active' };

/** Render the DS StatusPill into the status row (falls back to dot + text). */
function renderStatusPill(state, msg) {
  const mount = ui.statusPillMount;
  if (!mount) return;
  if (DS && DS.StatusPill) {
    try {
      const el = DS.StatusPill({ state, children: msg });
      if (el instanceof Node) { mount.replaceChildren(el); return; }
    } catch (err) {
      console.warn('[VIP] StatusPill render error:', err);
    }
  }
  // Graceful fallback when the DS bundle is unavailable.
  const dot = document.createElement('span');
  dot.className = `status-dot${state === 'pending' ? '' : ` ${state}`}`;
  const txt = document.createElement('span');
  txt.textContent = msg;
  mount.replaceChildren(dot, txt);
}

/** Swap the static header text badge for the DS Badge component when present. */
function mountBadge() {
  const mount = ui.archBadgeMount;
  if (!mount || !(DS && DS.Badge)) return; // fallback: the static .arch-badge text
  try {
    const el = DS.Badge({ variant: 'accent', dot: true, children: 'STEM-SPLIT & LIVE-MIX' });
    if (el instanceof Node) { mount.classList.remove('arch-badge'); mount.replaceChildren(el); }
  } catch (err) {
    console.warn('[VIP] Badge render error:', err);
  }
}

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
function showSpinner(stage, { indeterminate: _indeterminate = false } = {}) {
  _procState = { active: stage.toLowerCase().includes('resamp') ? 1 : 0, progress: 0 };
  ui.procLoaderMount.hidden = false;
  _renderProcLoader();
}

/** Advance to the Separate stage and update the live progress percentage. */
function setProgress(percent, _stage) {
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
      case 'ready': {
        let debugEnabled = false;
        try {
          debugEnabled = typeof localStorage !== 'undefined' && localStorage.getItem('vip_debug') === '1';
        } catch (_) {}
        if (debugEnabled) {
          console.log('[VIP][landing] MLWorker ready (backend: ' + msg.backend + ')');
        }
        break;
      }
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

async function detectSpeakers(clean, sampleRate) {
  ui.speakersPanel.hidden = false;
  ui.speakerStatus.textContent = 'Detecting speakers…';
  speakerControls.clear();
  const seq = requestSeq;
  try {
    const { segments, speakers, method } = await detectSpeakersPipeline(clean, sampleRate);
    if (seq !== requestSeq) return;
    mixer.loadSpeakerSegments(segments);
    const count = speakerControls.render(speakers);
    const methodLabel = method === 'onnx' ? 'ONNX embeddings' : 'spectral fingerprint';
    ui.speakerStatus.textContent = count === 0
      ? 'No distinct speakers detected.'
      : `${count} speaker${count === 1 ? '' : 's'} detected · ${segments.length} segments (${methodLabel})`;
  } catch (err) {
    if (seq !== requestSeq) return;
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

/** Paint the DS ParamSlider red value-fill (--pct) from the slider position. */
function paintSliderFill(slider) {
  const min = Number(slider.min) || 0;
  const span = Number(slider.max) - min;
  const pct = span > 0 ? ((Number(slider.value) - min) / span) * 100 : 0;
  slider.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`);
}

function resolveLandingHint(sliderId) {
  const key = LANDING_HINT_MAP[sliderId];
  if (!key) return '';
  if (key.startsWith('_')) return LANDING_CUSTOM_HINTS[key] || '';
  return SLIDER_HINTS[key] || '';
}

/** Collapsed hint panels — tap “i” after each value readout to expand. */
function wireSliderHints() {
  const grid = document.querySelector('.slider-grid');
  if (!grid) return;

  grid.querySelectorAll('.slider-row').forEach((row) => {
    if (row.querySelector('.slider-hint-btn')) return;
    const input = row.querySelector('input[type="range"]');
    if (!input) return;
    const hintText = resolveLandingHint(input.id);
    if (!hintText) return;

    const hintBtn = document.createElement('button');
    hintBtn.type = 'button';
    hintBtn.className = 'slider-hint-btn';
    hintBtn.textContent = 'i';
    hintBtn.setAttribute('aria-label', `Explain ${row.querySelector('label')?.textContent || input.id}`);
    hintBtn.setAttribute('aria-expanded', 'false');

    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const value = Number(input.value) || min;
    const hintPanel = buildHintPanel({
      id: `landing_hint_${input.id}`,
      text: hintText,
      min,
      max,
      value,
      unit: '',
      onApplyExample: (val) => {
        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        paintSliderFill(input);
      },
    });
    input.setAttribute('aria-describedby', hintPanel.id);

    hintBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const wasOpen = row.classList.contains('hint-open');
      grid.querySelectorAll('.slider-row.hint-open').forEach((r) => {
        r.classList.remove('hint-open');
        const b = r.querySelector('.slider-hint-btn');
        if (b) b.setAttribute('aria-expanded', 'false');
      });
      if (!wasOpen) {
        row.classList.add('hint-open');
        hintBtn.setAttribute('aria-expanded', 'true');
      }
    });

    row.appendChild(hintBtn);
    row.appendChild(hintPanel);
  });

  if (!grid.dataset.hintDismissBound) {
    grid.dataset.hintDismissBound = '1';
    document.addEventListener('click', (e) => {
      if (e.target.closest('.slider-hint-btn') || e.target.closest('.slider-hint')) return;
      grid.querySelectorAll('.slider-row.hint-open').forEach((r) => {
        r.classList.remove('hint-open');
        const b = r.querySelector('.slider-hint-btn');
        if (b) b.setAttribute('aria-expanded', 'false');
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      grid.querySelectorAll('.slider-row.hint-open').forEach((r) => {
        r.classList.remove('hint-open');
        const b = r.querySelector('.slider-hint-btn');
        if (b) b.setAttribute('aria-expanded', 'false');
      });
    });
  }
}

function wireReadouts() {
  for (const [sliderId, valId, fmt] of READOUTS) {
    const slider = $(sliderId);
    const val = $(valId);
    if (!slider || !val) continue;
    // Adopt the DS ParamSlider track (red value-fill) on the existing input —
    // non-destructive: same id/range, so SliderUI binding + presets still apply.
    slider.classList.add('vip-slider__input');
    paintSliderFill(slider);
    slider.addEventListener('input', () => {
      val.textContent = fmt(slider.value);
      paintSliderFill(slider);
    });
  }
}

// ─── Presets (canonical 23-slider calibrations from MixCalibration.js) ─────
const PRESETS = LANDING_PRESETS;

function applyPreset(name, sliderMap = PRESETS[name]) {
  const preset = sliderMap;
  if (!preset) return;
  for (const [sliderId, value] of Object.entries(preset)) {
    const el = $(sliderId);
    if (!el) continue;
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** Auto-calibrate all real-time sliders from the clean stem loudness profile. */
function autoCalibrateMix(clean, sampleRate) {
  const { preset, level, rmsDb, sliders } = calibrateFromStems(clean, sampleRate);
  applyPreset(preset, sliders);
  if (ui.presetSelect) {
    const hasOption = [...ui.presetSelect.options].some((o) => o.value === preset);
    ui.presetSelect.value = hasOption ? preset : ui.presetSelect.value;
  }
  console.info(`[VIP][landing] Auto-calibrated (${level}, ${rmsDb.toFixed(1)} dBFS) → preset "${preset}"`);
  return { preset, level, rmsDb };
}

// ─── Pipeline glue ───────────────────────────────────────────────────────────

/**
 * Shared ingestion entry point used by both the file-input change handler and
 * the drag-and-drop drop handler. Guards against concurrent calls by disabling
 * the file input for the duration, and resets its value in `finally` so the
 * same file can be re-selected after a failed decode.
 */
async function ingestFrom(file) {
  if (!file || ui.fileInput.disabled) return;
  const seq = ++ingestSeq;
  ui.processBtn.disabled = true;
  ui.fileInput.disabled = true;
  // Show the picture immediately for videos; hide the player for audio files.
  if (isVideoFile(file)) loadVideo(file); else clearVideo();
  try {
    showSpinner('Decoding…', { indeterminate: true });
    setStatus(`Decoding “${file.name}”…`, 'warn');
    const next = await ingestFile(file, {
      onProgress: (stage) => {
        if (seq !== ingestSeq) return;
        if (stage === 'resampling') {
          showSpinner('Resampling to 48 kHz…', { indeterminate: true });
          setStatus('Resampling to 48 kHz…', 'warn');
        }
      },
    });
    if (seq !== ingestSeq) return;
    ingested = next;
    hideSpinner();
    setStatus(`Ready: ${ingested.sourceName} · ${fmtTime(ingested.duration)} · ${ingested.numberOfChannels} ch`, '');
    ui.processBtn.disabled = false;
  } catch (err) {
    if (seq !== ingestSeq) return;
    hideSpinner();
    clearVideo(); // nothing to play — don't leave a dangling preview/object URL
    console.error('[VIP][landing] ingestion failed:', err);
    setStatus(err.message, 'error');
    ingested = null;
    ui.processBtn.disabled = true;
  } finally {
    // Re-enable the input unconditionally so the user can always pick again.
    // Resetting the value lets the browser fire 'change' even if the same
    // file is re-chosen (e.g. after a failed decode or an external edit).
    ui.fileInput.disabled = false;
    ui.fileInput.value = '';
  }
}

async function onFileChosen() {
  await ingestFrom(ui.fileInput.files && ui.fileInput.files[0]);
}

function wireUploadDropZone() {
  const zone = ui.uploadZone;
  if (!zone) return;

  const openPicker = () => ui.fileInput && ui.fileInput.click();
  zone.addEventListener('click', (event) => {
    if (event.target.closest('#browseBtn')) return;
    openPicker();
  });
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker();
    }
  });
  if (ui.browseBtn) {
    ui.browseBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openPicker();
    });
  }

  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('drag-over');
    const file = event.dataTransfer?.files?.[0];
    if (file) ingestFrom(file);
  });
}

function warnIfNotServed() {
  if (location.protocol === 'file:') {
    setStatus('Open via the dev server (pnpm dev → http://localhost:3000), not as a local file.', 'error');
  }
}

// UI-level model chains: run several models in series for maximum isolation.
// Keys are <select> values that are NOT single manifest entries; the worker
// receives the resolved `modelIds` array (see MLWorker chain support).
const MODEL_CHAINS = Object.freeze({
  max_isolation: ['demucs', 'rnnoise'],
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

  if (passthrough) {
    setStatus('Isolation failed — models could not run. Check /app/models is being served (Demucs ~149 MB on first load).', 'error');
    speakerControls?.clear();
    ui.speakersPanel.hidden = true;
    return;
  }

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
  startOutputMeter();

  for (const el of [ui.playBtn, ui.pauseBtn, ui.stopBtn,
    ui.muteVoiceBtn, ui.muteNoiseBtn, ui.presetSelect,
    ...ui.mixSliders]) {
    if (el) el.disabled = false;
  }
  const cal = autoCalibrateMix(clean, sampleRate);
  const calLabel = ` · calibrated: ${cal.preset} (${cal.level})`;
  setStatus(`Stems ready — press Play and mix in real time${calLabel}.`, 'active');
  detectSpeakers(clean, sampleRate);
}

// ─── Stem mute toggles ───────────────────────────────────────────────────────

function syncMuteButtons() {
  if (!mixer) return;
  // DS Switch visual state: thumb position (--on) + aria-checked. The label
  // stays static ("Mute Voice"/"Mute Background"); the thumb shows on/off.
  const paint = (btn, muted) => {
    btn.classList.toggle('vip-switch--on', muted);
    btn.setAttribute('aria-checked', String(muted));
  };
  paint(ui.muteVoiceBtn, mixer.isVoiceMuted());
  paint(ui.muteNoiseBtn, mixer.isNoiseMuted());
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

// ─── Output level meter (DS LevelMeter, real RMS from the mixer analyser) ────

let _meterEl = null;     // mounted .vip-meter node
let _meterFill = null;   // cached .vip-meter__fill (driven each frame)
let _meterRead = null;   // cached .vip-meter__val
let _meterRAF = 0;
let _meterTd = null;     // reusable time-domain scratch buffer
let _meterIdle = false;  // true once the meter has been zeroed while paused

/** dBFS amplitude (0..1) → LevelMeter 0..100 (value-100 = dBFS, -100 floor). */
function meterValue(amp) {
  if (amp <= 1e-5) return 0;
  return Math.max(0, Math.min(100, 100 + 20 * Math.log10(amp)));
}

function _meterTick() {
  _meterRAF = requestAnimationFrame(_meterTick);
  if (!mixer || !_meterEl) return;
  // Idle when paused/stopped: drop to the floor once, then skip the analyser
  // read and DOM writes until playback resumes (no work on a silent graph).
  if (!mixer.isPlaying()) {
    if (_meterIdle) return;
    _meterIdle = true;
    if (_meterFill) _meterFill.style.width = '0%';
    if (_meterRead) _meterRead.textContent = '-∞';
    return;
  }
  _meterIdle = false;
  let analyser;
  try { analyser = mixer.getAnalyser(); } catch { return; }
  if (!analyser) return;
  const n = analyser.fftSize;
  if (!_meterTd || _meterTd.length !== n) _meterTd = new Float32Array(n);
  analyser.getFloatTimeDomainData(_meterTd);
  let sumSq = 0;
  for (let i = 0; i < n; i++) { const s = _meterTd[i]; sumSq += s * s; }
  const v = meterValue(Math.sqrt(sumSq / n));
  if (_meterFill) _meterFill.style.width = `${v}%`;
  if (_meterRead) _meterRead.textContent = v <= 0 ? '-∞' : (v - 100).toFixed(1);
}

/** Reveal + mount the DS LevelMeter once; the RAF loop drives it from real audio. */
function startOutputMeter() {
  const mount = ui.outputMeterMount;
  if (!mount) return;
  mount.hidden = false;
  if (!_meterEl && DS && DS.LevelMeter) {
    try {
      const el = DS.LevelMeter({ label: 'Output', value: 0, unit: 'dB' });
      if (el instanceof Node) {
        mount.replaceChildren(el);
        _meterEl = el;
        // Cache the dynamic nodes once so the RAF loop never re-queries the DOM.
        _meterFill = el.querySelector('.vip-meter__fill');
        _meterRead = el.querySelector('.vip-meter__val');
      }
    } catch (err) {
      console.warn('[VIP] LevelMeter render error:', err);
    }
  }
  if (!_meterRAF && _meterEl) _meterRAF = requestAnimationFrame(_meterTick);
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

// ─── Drag-and-drop upload ────────────────────────────────────────────────────

function wireDragAndDrop() {
  const zone = ui.uploadPanel;
  if (!zone) return;

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('upload-panel--dragging');
  });

  zone.addEventListener('dragleave', () => {
    // pointer-events:none on .upload-panel--dragging > * (see landing.css)
    // prevents child elements from absorbing drag events, so dragleave only
    // fires when the pointer genuinely exits the panel — no relatedTarget
    // check needed (and relatedTarget is null on Safari anyway).
    zone.classList.remove('upload-panel--dragging');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('upload-panel--dragging');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) ingestFrom(file);
  });
}

// ─── Boot ────────────────────────────────────────────────────────────────────

ui.fileInput.addEventListener('change', onFileChosen);
wireUploadDropZone();
warnIfNotServed();
window.addEventListener('error', (event) => {
  if (event.message && !String(event.message).includes('ResizeObserver')) {
    setStatus(`App error: ${event.message}`, 'error');
  }
});
window.addEventListener('unhandledrejection', (event) => {
  const msg = event.reason?.message || String(event.reason || 'unknown');
  setStatus(`Upload failed: ${msg}`, 'error');
});
ui.processBtn.addEventListener('click', onProcess);
ui.presetSelect.addEventListener('change', () => applyPreset(ui.presetSelect.value));
wireReadouts();
wireSliderHints();
wireTransport();
wireMuteButtons();
wireDragAndDrop();
mountBadge();
setStatus('Idle — choose a file to begin', '');

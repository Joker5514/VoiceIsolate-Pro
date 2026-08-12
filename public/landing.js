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

import { ingestFile, assertIngestible, isDesktopShell, pickAudioFile } from '/src/pipeline/FileIngestion.js';
import { openFilePicker, primeAudioGesture, fixUploadTouchTargets } from '/src/presentation/UploadWiring.js';
import { PlaybackMixer } from '/src/pipeline/PlaybackMixer.js';
import { SliderUI } from '/src/presentation/SliderUI.js';
import { LANDING_PRESETS, calibrateFromStems } from '/src/core/MixCalibration.js';
import { SpeakerControls } from '/src/presentation/SpeakerControls.js';
import { LandingVisualizer } from '/src/presentation/LandingVisualizer.js';
import { getModel } from '/src/core/ModelManifest.js';
import { isVideoSource } from '/src/core/media-types.js';
import { saveExportBlob, filtersForFilename } from '/src/core/DesktopBridge.js';
import {
  exportVideoWithProcessedAudio,
  triggerBlobDownload,
} from '/src/pipeline/video-export.js';

import { detectSpeakers as detectSpeakersPipeline } from '/src/pipeline/SpeakerDetection.js';
import { DEFAULT_ML_MODEL_IDS } from '/src/core/ml-defaults.js';
import { createMLWorker, initMLWorker } from '/src/pipeline/MLWorkerHost.js';
import { clearStemCache, getCachedStems, setCachedStems, stemCacheKey } from '/src/pipeline/MLStemCache.js';
import { resetTimings, stageEnd, stageStart } from '/src/pipeline/PipelineTiming.js';
import { paintSeekFill, wireTransportRegion } from '/src/presentation/TransportRegionControls.js';
import { SLIDER_HINTS } from '/app/slider-map.js';
import { buildHintPanel } from '/app/slider-hint-ui.js';
import * as FileLibrary from '/src/core/FileLibrary.js';

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
  seekSlider: $('seekSlider'),
  loopBtn: $('loopBtn'),
  cropInBtn: $('cropInBtn'),
  cropOutBtn: $('cropOutBtn'),
  cropClearBtn: $('cropClearBtn'),
  regionBar: $('landingRegionBar'),
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
  exportRow: $('exportRow'),
  downloadBtn: $('downloadBtn'),
  downloadStatus: $('downloadStatus'),
};

let mixer = null;
let sliderUI = null;
let speakerControls = null;
let visualizer = null;
let worker = null;
/** @type {ReturnType<typeof import('/src/presentation/TargetSpeakerUI.js').mountTargetSpeakerUI>|null} */
let targetSpeakerUi = null;

let ingested = null;
/** @type {File|Blob|null} original upload retained for video remux export */
let sourceFile = null;
let requestSeq = 0;
let ingestSeq = 0;
let ingestInFlight = false;
let processingInFlight = false;
let downloadInFlight = false;

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
  { id: 'load',     label: 'Load model' },
  { id: 'separate', label: 'Separate' },
];

const STAGE_INDEX = Object.freeze({
  decode: 0,
  resample: 1,
  load: 2,
  separate: 3,
});

/** Unified 0–100% weights: decode → resample → model load → inference. */
const PIPELINE_WEIGHTS = Object.freeze({
  decode: [0, 12],
  resample: [12, 20],
  load: [20, 35],
  separate: [35, 100],
});

let _procState = { active: 0, progress: 0 };
let _procRenderRAF = 0;
let _procFallbackEl = null;

function mapPipelinePercent(stage, localPercent = 0) {
  const w = PIPELINE_WEIGHTS[stage];
  if (!w) return Math.max(0, Math.min(100, Math.round(localPercent)));
  const pct = w[0] + (Math.max(0, Math.min(100, localPercent)) / 100) * (w[1] - w[0]);
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function scheduleProcRender() {
  if (_procRenderRAF) return;
  _procRenderRAF = requestAnimationFrame(() => {
    _procRenderRAF = 0;
    _renderProcLoader();
  });
}

function setProcStage(stage, localPercent = 0, statusLabel, { updateJobLabel = true } = {}) {
  const idx = STAGE_INDEX[stage] ?? 0;
  _procState = { active: idx, progress: mapPipelinePercent(stage, localPercent) };
  ui.procLoaderMount.hidden = false;
  if (statusLabel) {
    if (updateJobLabel) currentJobLabel = statusLabel;
    setStatus(statusLabel, 'warn');
  }
  scheduleProcRender();
}

function _renderProcLoader() {
  const mount = ui.procLoaderMount;
  if (!mount) return;
  if (DS && DS.ProcessLoader) {
    try {
      mount.innerHTML = '';
      const el = DS.ProcessLoader({
        stages: PROC_STAGES,
        active: _procState.active,
        progress: _procState.progress,
      });
      if (el instanceof Node) mount.appendChild(el);
      _procFallbackEl = null;
      return;
    } catch (err) {
      console.warn('[VIP] ProcessLoader render error:', err);
    }
  }
  if (!_procFallbackEl || !_procFallbackEl.isConnected) {
    mount.innerHTML = '';
    _procFallbackEl = document.createElement('div');
    _procFallbackEl.style.cssText = 'padding:10px 0;color:var(--text-2);font:var(--fw-medium) var(--fs-sm)/1 var(--font-ui)';
    mount.appendChild(_procFallbackEl);
  }
  const stage = PROC_STAGES[_procState.active];
  _procFallbackEl.textContent = stage
    ? `${stage.label}… ${_procState.progress}%`
    : `Processing… ${_procState.progress}%`;
}

/**
 * Show the ProcessLoader. `indeterminate` is accepted for call-site compat
 * (decode/resample have no known duration); the scan-bar animation always
 * runs so the UI remains active throughout.
 */
function showSpinner(stage, { indeterminate: _indeterminate = false } = {}) {
  const key = stage.toLowerCase().includes('resamp') ? 'resample' : 'decode';
  setProcStage(key, _indeterminate ? 5 : 50, stage);
}

/** Map inference-local percent into the unified pipeline bar. */
function setProgress(percent) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  setProcStage('separate', pct, currentJobLabel);
}

function hideSpinner() {
  ui.procLoaderMount.hidden = true;
  if (_procRenderRAF) {
    cancelAnimationFrame(_procRenderRAF);
    _procRenderRAF = 0;
  }
}

// ─── Video preview (picture in sync with processed audio) ────────────────────

/** Treat as video by MIME type, or by container extension when MIME is absent. */
function isVideoFile(file) {
  return isVideoSource(file);
}

function loadVideo(file) {
  clearVideo();
  if (!ui.videoPlayer || !ui.videoCard) return;
  videoUrl = URL.createObjectURL(file);
  const v = ui.videoPlayer;
  v.muted = true; // audio always comes from the Web Audio mixer
  // Reveal only once the element can actually paint a frame, so we never flash
  // an empty black box; drop the preview if the container's video track can't
  // be displayed (audio-only processing still works).
  v.onloadedmetadata = () => {
    // Prefer videoWidth so pure-audio .webm with a video MIME still hides.
    if ((v.videoWidth || 0) > 0 || (v.readyState || 0) >= 1) {
      ui.videoCard.hidden = false;
    }
  };
  v.onerror = () => clearVideo();
  v.src = videoUrl;
  try { v.load(); } catch { /* best-effort */ }
}

function clearVideo() {
  if (!videoUrl && (!ui.videoCard || ui.videoCard.hidden)) return; // nothing loaded
  const v = ui.videoPlayer;
  if (!v) {
    videoUrl = null;
    return;
  }
  // Detach handlers first: removeAttribute('src') + load() fires a spurious
  // 'error' during teardown, which would otherwise re-enter clearVideo.
  v.onloadedmetadata = null;
  v.onerror = null;
  try { v.pause(); } catch { /* not playing */ }
  v.removeAttribute('src');
  try { v.load(); } catch { /* reset is best-effort */ }
  if (ui.videoCard) ui.videoCard.hidden = true;
  if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = null; }
}

function hasVideo() { return Boolean(videoUrl) && ui.videoCard && !ui.videoCard.hidden; }

function updateDownloadButton() {
  const ready = Boolean(mixer?.cleanBuffer);
  if (ui.exportRow) ui.exportRow.hidden = !ready;
  if (!ui.downloadBtn) return;
  ui.downloadBtn.disabled = !ready || downloadInFlight;
  ui.downloadBtn.textContent = (sourceFile && isVideoFile(sourceFile))
    ? 'Download Processed Video'
    : 'Download Processed WAV';
}

/** Encode clean stem to a 16-bit stereo/mono WAV Blob. */
function encodeCleanStemWav(audioBuffer) {
  const numCh = Math.min(2, audioBuffer.numberOfChannels || 1);
  const sr = audioBuffer.sampleRate;
  const len = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const ws = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  ws(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ws(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  const channels = [];
  for (let ch = 0; ch < numCh; ch++) channels.push(audioBuffer.getChannelData(ch));
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function onDownloadProcessed() {
  if (!mixer?.cleanBuffer || downloadInFlight) return;
  downloadInFlight = true;
  updateDownloadButton();
  const setDl = (msg) => { if (ui.downloadStatus) ui.downloadStatus.textContent = msg || ''; };

  try {
    let cropIn = 0;
    let cropOut = mixer.cleanBuffer.duration;
    if (mixer.hasCrop?.()) {
      const region = mixer.getCropRegion();
      cropIn = region.in;
      cropOut = region.out;
    }

    const full = mixer.cleanBuffer;

    if (sourceFile && isVideoFile(sourceFile)) {
      setDl('Encoding video with processed audio…');
      setStatus('Encoding processed video…', 'warn');
      try {
        // Full buffer + crop window keeps picture/audio aligned on remux.
        const result = await exportVideoWithProcessedAudio(sourceFile, full, {
          startSec: cropIn,
          endSec: cropOut,
          onProgress: (pct) => setDl(`Encoding video… ${Math.round(pct)}%`),
        });
        if (isDesktopShell()) {
          await saveExportBlob(result.blob, {
            defaultName: result.filename,
            filters: filtersForFilename(result.filename),
          });
        } else {
          triggerBlobDownload(result.blob, result.filename);
        }
        setDl(`Saved ${result.filename}`);
        setStatus(`Processed video ready — ${result.filename}`, 'active');
        return;
      } catch (err) {
        console.warn('[VIP][landing] video export failed, falling back to WAV:', err);
        setDl('Video remux unavailable — saving WAV…');
      }
    }

    // WAV path: materialize crop window into a new buffer.
    const sr = full.sampleRate;
    const start = Math.max(0, Math.floor(cropIn * sr));
    const end = Math.min(full.length, Math.ceil(cropOut * sr));
    const length = Math.max(1, end - start);
    const channels = Math.min(2, full.numberOfChannels);
    let exportBuf;
    if (typeof AudioBuffer === 'function') {
      try {
        exportBuf = new AudioBuffer({ numberOfChannels: channels, length, sampleRate: sr });
      } catch { exportBuf = null; }
    }
    if (!exportBuf) {
      const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      const offline = new Offline(channels, length, sr);
      exportBuf = offline.createBuffer(channels, length, sr);
    }
    for (let ch = 0; ch < channels; ch++) {
      exportBuf.copyToChannel(full.getChannelData(ch).subarray(start, start + length), ch);
    }

    const wavBlob = encodeCleanStemWav(exportBuf);
    const base = (sourceFile?.name || ingested?.sourceName || 'export')
      .replace(/\.[^.]+$/, '')
      .slice(0, 80) || 'export';
    const filename = `${base}-processed.wav`;
    if (isDesktopShell()) {
      await saveExportBlob(wavBlob, {
        defaultName: filename,
        filters: filtersForFilename(filename),
      });
    } else {
      triggerBlobDownload(wavBlob, filename);
    }
    setDl(`Saved ${filename}`);
    setStatus(`Processed audio ready — ${filename}`, 'active');
  } catch (err) {
    console.error('[VIP][landing] download failed:', err);
    setDl(err?.message || 'Download failed');
    setStatus(err?.message || 'Download failed', 'error');
  } finally {
    downloadInFlight = false;
    updateDownloadButton();
  }
}

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

const DEFAULT_WARMUP_CHAIN = DEFAULT_ML_MODEL_IDS;

function resolveModelIds(selection) {
  const chain = MODEL_CHAINS[selection];
  if (chain) return chain;
  return [getModel(selection).id];
}

/** @type {Set<string>} */
const _warmedModels = new Set();
/** @type {Array<{ resolve: Function, reject: Function, timer: *, ids: string[] }>} */
let _warmupWaiters = [];
let _warmupHooked = false;
const WARMUP_TIMEOUT_MS = 120_000;

function hookWarmupListener(w) {
  if (_warmupHooked) return;
  _warmupHooked = true;
  w.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type !== 'warmed') return;
    for (const id of msg.modelIds || []) _warmedModels.add(id);
    const pending = _warmupWaiters.splice(0);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      const stillMissing = waiter.ids.filter((id) => !_warmedModels.has(id));
      if (stillMissing.length === 0) waiter.resolve(msg);
      else _warmupWaiters.push(waiter);
    }
  });
}

/** Prefetch model bytes + compile ONNX sessions off the hot path. */
async function warmupWorkerModels(modelIds) {
  const ids = (Array.isArray(modelIds) ? modelIds : []).filter((id) => typeof id === 'string' && id);
  const missing = ids.filter((id) => !_warmedModels.has(id));
  if (missing.length === 0) return { modelIds: ids };
  const w = getWorker();
  hookWarmupListener(w);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = _warmupWaiters.findIndex((x) => x.resolve === resolve);
      if (idx >= 0) _warmupWaiters.splice(idx, 1);
      reject(new Error('[VIP][landing] ML warmup timeout'));
    }, WARMUP_TIMEOUT_MS);
    _warmupWaiters.push({ resolve, reject, timer, ids: missing });
    w.postMessage({ type: 'warmup', modelIds: missing });
  });
}

function getWorker() {
  if (worker) return worker;
  worker = createMLWorker();
  initMLWorker(worker);
  worker.addEventListener('message', (event) => {
    const msg = event.data || {};
    const stale = msg.requestId != null && msg.requestId !== requestSeq;
    switch (msg.type) {
      case 'ready': {
        let debugEnabled = false;
        try {
          debugEnabled = typeof localStorage !== 'undefined' && localStorage.getItem('vip_debug') === '1';
        } catch (_) {}
        if (debugEnabled) {
          console.log('[VIP][landing] MLWorker ready (backend: ' + msg.backend + ')');
        }
        // Provider status for research / UI (OrtStatus also updated in MLWorkerHost).
        try {
          const label = msg.backend === 'webgpu' ? 'WebGPU' : (msg.backend || 'WASM');
          const el = document.getElementById('ortProviderHint');
          if (el) el.textContent = `Inference: ${label} (local)`;
          const backendLine = document.getElementById('backendStatusLine');
          if (backendLine) {
            backendLine.textContent = `Backend: ${label} · Fast/Balanced/Max via model chain · 100% local`;
            backendLine.dataset.backend = String(msg.backend || 'wasm');
          }
        } catch (_) { /* ignore */ }
        warmupWorkerModels(DEFAULT_WARMUP_CHAIN).catch(() => {});
        break;
      }
      case 'stage':
        if (stale) break;
        if (msg.stage === 'load') {
          if ((msg.percent ?? 0) <= 1) stageStart('model_load');
          setProcStage(
            'load',
            msg.percent ?? 0,
            msg.label || `Loading ${msg.modelId || 'model'}…`,
            { updateJobLabel: false },
          );
        } else if (msg.stage === 'separate') {
          stageEnd('model_load');
          stageStart('isolate');
          setProcStage('separate', msg.percent ?? 0, currentJobLabel);
        }
        break;
      case 'progress':
        if (!stale) setProgress(msg.percent);
        break;
      case 'stems':
        onStems(msg);
        break;
      case 'error':
        if (stale) break;
        stageEnd('isolate');
        stageEnd('model_load');
        processingInFlight = false;
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
  // Target enrollment becomes available once stems exist (same module as Engineer).
  void ensureTargetSpeakerUi();
}

/**
 * Mount shared TargetSpeakerUI on Landing (post stem-split).
 * Soft-gain isolation on the clean stem; never re-runs ML.
 */
async function ensureTargetSpeakerUi() {
  const panel = document.getElementById('targetSpeakerLandingPanel');
  const host = document.getElementById('targetSpeakerPanel');
  if (!host || !mixer) return;
  if (panel) panel.hidden = false;
  if (targetSpeakerUi) return;
  try {
    const { mountTargetSpeakerUI } = await import('/src/presentation/TargetSpeakerUI.js');
    targetSpeakerUi = mountTargetSpeakerUI({
      container: host,
      getAudio: () => {
        if (!mixer?.cleanBuffer) return null;
        const buf = mixer.cleanBuffer;
        const channelData = [];
        for (let c = 0; c < buf.numberOfChannels; c++) {
          channelData.push(buf.getChannelData(c));
        }
        return { channelData, sampleRate: buf.sampleRate || 48000 };
      },
      getDiarizationSegments: () => {
        try {
          const segs = mixer?.getSpeakerSegments?.() || mixer?._segments || [];
          return Array.isArray(segs) && segs.length ? segs : null;
        } catch {
          return null;
        }
      },
      getDurationSec: () => {
        try {
          const d = mixer?.duration?.();
          return Number.isFinite(d) && d > 0 ? d : null;
        } catch {
          return null;
        }
      },
      getPlayheadSec: () => {
        try {
          const t = mixer?.currentTime?.();
          return Number.isFinite(t) ? t : null;
        } catch {
          return null;
        }
      },
      onIsolated: async (channels, sampleRate) => {
        // Replace clean stem; preserve diarization (loadStems clears segments).
        const segs = mixer.getSpeakerSegments?.() || [];
        const noise = mixer.noiseBuffer
          ? Array.from({ length: mixer.noiseBuffer.numberOfChannels }, (_, c) =>
            mixer.noiseBuffer.getChannelData(c).slice())
          : channels.map((ch) => new Float32Array(ch.length));
        mixer.loadStems(channels, noise, sampleRate);
        if (segs.length) mixer.loadSpeakerSegments(segs);
        visualizer?.loadStems?.(channels, noise, mixer.duration());
        setStatus('Target isolation applied on clean stem (local voiceprint). Press Play.', 'active');
      },
      notify: (msg, kind) => {
        const map = { ok: 'active', error: 'error', warn: 'error', info: 'active' };
        setStatus(msg, map[kind] || 'active');
      },
    });
  } catch (err) {
    console.warn('[VIP][landing] TargetSpeaker UI failed to mount:', err);
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
  if (!file || ingestInFlight || processingInFlight) return;
  try {
    assertIngestible(file);
  } catch (err) {
    setStatus(err.message, 'error');
    return;
  }
  const seq = ++ingestSeq;
  ingestInFlight = true;
  resetTimings();
  clearStemCache();
  sourceFile = file;
  ui.processBtn.disabled = true;
  ui.fileInput.disabled = true;
  if (ui.downloadBtn) ui.downloadBtn.disabled = true;
  if (ui.exportRow) ui.exportRow.hidden = true;
  // Unlock Web Audio inside the user gesture (required on mobile + some desktop builds).
  try { await primeAudioGesture(); } catch { /* best-effort */ }
  // Avoid loading the preview <video> during decode — demuxing the same file twice
  // (preview + hidden capture element) stalls progress on large uploads.
  clearVideo();
  // Library persist off the critical path — never block decode/listen.
  const scheduleLib = globalThis.requestIdleCallback
    || ((cb) => setTimeout(cb, 400));
  scheduleLib(() => {
    if ((file.size || 0) > 200 * 1024 * 1024) return;
    FileLibrary.importFile(file, { mode: 'library' })
      .then((meta) => { window.__vipLandingLibraryId = meta.id; })
      .catch((libErr) => console.warn('[VIP][landing] library persist failed:', libErr?.message || libErr));
  });
  try {
    showSpinner('Decoding…', { indeterminate: true });
    setStatus(`Decoding “${file.name}”…`, 'warn');
    // Prefer fast single-model default for auto-path; never auto-run Demucs.
    let selection = ui.modelSelect?.value || 'bsrnn_vocals';
    if (selection === 'demucs' || selection === 'studio_isolation') {
      selection = 'bsrnn_vocals';
      if (ui.modelSelect) ui.modelSelect.value = 'bsrnn_vocals';
      setStatus('Using fast BS-RNN (Demucs disabled for auto-process)', 'warn');
    }
    const modelIds = resolveModelIds(selection);
    // Overlap model prefetch with decode (bsrnn only ~4 MB).
    void warmupWorkerModels(modelIds).catch(() => {});
    const next = await ingestFile(file, {
      onProgress: (stage, percent = 0) => {
        if (seq !== ingestSeq) return;
        if (stage === 'decoding') {
          const label = percent < 20
            ? `Reading “${file.name}”…`
            : `Decoding “${file.name}”…`;
          setProcStage('decode', percent, label);
        } else if (stage === 'resampling') {
          setProcStage('resample', percent, 'Resampling to 48 kHz…');
        }
      },
    });
    if (seq !== ingestSeq) return;
    ingested = next;
    // Always attempt preview for video sources after decode succeeds.
    if (isVideoFile(file)) loadVideo(file);
    if (seq !== ingestSeq) return;

    // CRITICAL UX: enable listen immediately after decode — do not force-wait on ML.
    hideSpinner();
    ui.processBtn.disabled = false;
    ui.fileInput.disabled = false;
    setStatus(
      `Ready to play — “${file.name}” decoded (${(next.duration || 0).toFixed?.(1) || '?'}s). Isolating…`,
      'warn',
    );
    // Load raw mix into playback so user can listen while isolation runs.
    try {
      if (mixer && next.channelData) {
        // Clean = full mix, noise = silence so user hears original immediately.
        const silence = next.channelData.map((c) => new Float32Array(c.length));
        mixer.loadStems(next.channelData, silence, next.sampleRate);
        if (typeof mixer.setVoiceLevel === 'function') mixer.setVoiceLevel(100);
        if (typeof mixer.setVolume === 'function') mixer.setVolume(100);
      }
    } catch (playPrepErr) {
      console.warn('[VIP][landing] early play prep failed', playPrepErr);
    }

    // Long files: do not auto-run ML (can take many minutes). User hits Separate.
    const dur = next.duration || (next.channelData?.[0]?.length || 0) / (next.sampleRate || 48000);
    if (dur > 180) {
      setStatus(
        `Decoded ${(dur / 60).toFixed(1)} min — press “Separate Stems” to isolate (auto-skip for long files). You can play now.`,
        'warn',
      );
      return;
    }
    // Short files: auto-isolate in background; playback already available.
    onProcess();
  } catch (err) {
    if (seq !== ingestSeq) return;
    hideSpinner();
    clearVideo(); // nothing to play — don't leave a dangling preview/object URL
    console.error('[VIP][landing] ingestion failed:', err);
    setStatus(err.message, 'error');
    ingested = null;
    sourceFile = null;
    ui.processBtn.disabled = true;
    updateDownloadButton();
  } finally {
    ingestInFlight = false;
    // Keep input locked while ML isolation runs; onStems/error re-enables it.
    if (!processingInFlight) {
      ui.fileInput.disabled = false;
    }
    ui.fileInput.value = '';
  }
}

async function onFileChosen() {
  try { await primeAudioGesture(); } catch { /* best-effort */ }
  await ingestFrom(ui.fileInput.files && ui.fileInput.files[0]);
}

function wireUploadDropZone() {
  const zone = ui.uploadZone;
  if (!zone) return;

  const openPicker = async () => {
    if (isDesktopShell()) {
      try {
        const file = await pickAudioFile();
        if (file) await ingestFrom(file);
      } catch (err) {
        console.error('[VIP][landing] desktop open failed:', err);
        setStatus(err.message, 'error');
      }
      return;
    }
    if (!openFilePicker(ui.fileInput)) {
      setStatus('Upload control unavailable — refresh the page', 'error');
      return;
    }
    primeAudioGesture().catch(() => {});
  };
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
  // browseBtn is <label for="fileInput"> — native picker; skip redundant JS handler.

  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('drag-over');
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    primeAudioGesture().catch(() => {}).finally(() => ingestFrom(file));
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
  max_isolation: ['bsrnn_vocals', 'rnnoise'],
  studio_isolation: ['demucs', 'rnnoise'],
});

function onProcess() {
  if (!ingested) return;
  processingInFlight = true;
  ui.fileInput.disabled = true;
  const selection = ui.modelSelect.value;
  const chain = MODEL_CHAINS[selection];
  const modelIds = chain || [getModel(selection).id];
  const cacheKey = stemCacheKey(
    ingested.channelData,
    ingested.sampleRate,
    modelIds,
    ingested.sourceName,
  );
  ui.processBtn.disabled = true;
  ui.fileInput.disabled = true;
  ui.modelSelect.disabled = true;
  currentJobLabel = chain ? 'Maximum isolation (2 passes)…' : 'Separating stems…';
  setProgress(0, currentJobLabel);
  setStatus(currentJobLabel, 'warn');

  const cached = getCachedStems(cacheKey);
  if (cached) {
    currentJobLabel = 'Using cached stems…';
    setStatus(currentJobLabel, 'warn');
    stageStart('model_load');
    stageEnd('model_load');
    stageStart('isolate');
    stageEnd('isolate');
    onStems({
      requestId: ++requestSeq,
      clean: cached.clean.map((c) => new Float32Array(c)),
      noise: cached.noise.map((c) => new Float32Array(c)),
      sampleRate: cached.sampleRate,
      passthrough: false,
      _cacheKey: cacheKey,
    });
    return;
  }

  stageStart('model_load');
  ingested._stemCacheKey = cacheKey;

  // Channel copies are transferred — keep our reference for re-processing.
  const channelData = ingested.channelData.map((c) => c.slice());
  const msg = { type: 'process', requestId: ++requestSeq, channelData, sampleRate: ingested.sampleRate };
  if (chain) msg.modelIds = chain;
  else msg.modelId = getModel(selection).id;
  getWorker().postMessage(msg, channelData.map((c) => c.buffer));
}

function onStems({ requestId, clean, noise, sampleRate, passthrough, _cacheKey }) {
  if (requestId !== requestSeq) return; // stale response
  processingInFlight = false;
  stageEnd('isolate');
  stageEnd('model_load');
  setProgress(100);
  hideSpinner();

  const cacheKey = _cacheKey || ingested?._stemCacheKey;
  if (!passthrough && cacheKey) {
    setCachedStems(cacheKey, { clean, noise, sampleRate, passthrough: false });
  }
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
    // Ensure gate/de-esser worklets finish loading (non-blocking for play).
    void mixer.workletsReady?.().then(() => {
      try {
        globalThis.__vipWorkletStatus = mixer.getWorkletStatus?.();
      } catch { /* ignore */ }
    }).catch(() => {});
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
  updateDownloadButton();

  for (const el of [ui.playBtn, ui.pauseBtn, ui.stopBtn,
    ui.muteVoiceBtn, ui.muteNoiseBtn, ui.presetSelect,
    ui.seekSlider, ui.loopBtn, ui.cropInBtn, ui.cropOutBtn, ui.cropClearBtn,
    ui.downloadBtn,
    ...ui.mixSliders]) {
    if (el) el.disabled = false;
  }
  // wireTransportRegion attaches listeners and paints crop/loop UI once;
  // re-sync is not needed on landing (no external region mutations).
  wireTransportRegion({
    mixer,
    loopBtn: ui.loopBtn,
    cropInBtn: ui.cropInBtn,
    cropOutBtn: ui.cropOutBtn,
    cropClearBtn: ui.cropClearBtn,
    seekEl: ui.seekSlider,
    regionBar: ui.regionBar,
    onChange: () => visualizer?.invalidate?.(),
  });
  const cal = autoCalibrateMix(clean, sampleRate);
  const calLabel = ` · calibrated: ${cal.preset} (${cal.level})`;
  setStatus(`Stems ready — press Play and mix in real time${calLabel}.`, 'active');
  const scheduleIdle = globalThis.requestIdleCallback
    ? (cb) => requestIdleCallback(cb, { timeout: 2000 })
    : (cb) => setTimeout(cb, 0);
  scheduleIdle(() => detectSpeakers(clean, sampleRate));
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

  ui.seekSlider?.addEventListener('input', async (e) => {
    if (!mixer) return;
    const frac = Number(e.target.value) / 1000;
    try {
      await mixer.seek(frac * mixer.duration());
      syncVideo();
    } catch (err) {
      console.warn('[VIP][landing] seek failed:', err);
    }
  });

  // One ticker drives the time readout and keeps the muted video aligned with
  // the mixer clock (covers waveform click-to-seek and natural end-of-stream).
  setInterval(() => {
    if (!mixer) return;
    const cur = mixer.currentTime();
    const dur = mixer.duration();
    ui.timeReadout.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    if (ui.seekSlider && dur > 0) {
      ui.seekSlider.value = String(Math.round((cur / dur) * 1000));
      paintSeekFill(ui.seekSlider, cur, dur);
    }
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
    if (!file) return;
    primeAudioGesture().catch(() => {}).finally(() => ingestFrom(file));
  });
}

// ─── Boot ────────────────────────────────────────────────────────────────────

ui.fileInput.addEventListener('click', () => { primeAudioGesture().catch(() => {}); });
ui.fileInput.addEventListener('change', onFileChosen);
fixUploadTouchTargets();
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
ui.downloadBtn?.addEventListener('click', () => { onDownloadProcessed().catch(() => {}); });
wireReadouts();
wireSliderHints();
wireTransport();
wireMuteButtons();
wireDragAndDrop();
mountBadge();
getWorker();
wireClearLocalData();
setStatus('Idle — choose a file to begin', '');

/**
 * Privacy panel: Clear Local Data (library, OPFS/IDB, stems, model cache).
 */
function wireClearLocalData() {
  const btn = document.getElementById('clearLocalDataBtn');
  const statusEl = document.getElementById('clearLocalDataStatus');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const ok = confirm(
      'Clear ALL local VoiceIsolate data on this device?\n\n'
      + 'Deletes the library, cached stems, embeddings, and model cache. '
      + 'No audio ever left this device.',
    );
    if (!ok) return;
    btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Clearing…';
    try {
      const { clearAllLocalData } = await import('/src/core/ClearLocalData.js');
      const result = await clearAllLocalData({ includeModels: true });
      if (statusEl) {
        statusEl.textContent = `Cleared ${result.filesRemoved} file(s), ${result.localStorageKeys} keys. Reloading…`;
      }
      setStatus('Local data cleared — reloading…', 'active');
      setTimeout(() => location.reload(), 500);
    } catch (err) {
      btn.disabled = false;
      const msg = err?.message || String(err);
      if (statusEl) statusEl.textContent = `Failed: ${msg}`;
      setStatus(`Clear Local Data failed: ${msg}`, 'error');
    }
  });
}

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
import { LANDING_PRESETS, RT_SLIDER_DEFAULTS } from '/src/core/MixCalibration.js';
import { SpeakerControls } from '/src/presentation/SpeakerControls.js';
import { LandingVisualizer } from '/src/presentation/LandingVisualizer.js';
import { QuickCleanUI } from '/src/presentation/QuickCleanUI.js';
import { inspectQuickCleanDevice } from '/src/pipeline/QuickCleanPlan.js';
import { QuickCleanReview } from '/src/pipeline/QuickCleanReview.js';
import { measureAudioBuffer, encodeReviewedWav } from '/src/pipeline/AudioReview.js';
import { isVideoSource, getFileInputAccept } from '/src/core/media-types.js';
import { saveExportBlob, filtersForFilename } from '/src/core/DesktopBridge.js';
import {
  exportVideoWithProcessedAudio,
  triggerBlobDownload,
} from '/src/pipeline/video-export.js';

import { detectSpeakers as detectSpeakersPipeline } from '/src/pipeline/SpeakerDetection.js';
import { createMLWorker, initMLWorker } from '/src/pipeline/MLWorkerHost.js';
import { clearStemCache, getCachedStems, setCachedStems, stemCacheKey } from '/src/pipeline/MLStemCache.js';
import { resetTimings, stageEnd, stageStart } from '/src/pipeline/PipelineTiming.js';
import { paintSeekFill, wireTransportRegion } from '/src/presentation/TransportRegionControls.js';
import { SLIDER_HINTS } from '/app/slider-map.js';
import { buildHintPanel } from '/app/slider-hint-ui.js';
import * as FileLibrary from '/src/core/FileLibrary.js';
import {
  beginJob,
  endJob,
  updateJob,
  cancelCurrent,
  getCurrentJobId,
  isCancellationError,
  throwIfAborted,
} from '/src/pipeline/JobController.js';

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
  cancelProcessBtn: $('cancelProcessBtn'),
  landingJobStatus: $('landingJobStatus'),
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
  saveDriveBtn: $('saveDriveBtn'),
  openDriveBtn: $('openDriveBtn'),
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
let hasProcessed = false;
let processPlan = null;
let processWatch = null;
let lastProcessProgress = 0;
let review = null;
let reviewInFlight = false;
let preflightSeq = 0;
const quickClean = new QuickCleanUI();

async function refreshPreflight() {
  const seq = ++preflightSeq;
  const device = await inspectQuickCleanDevice();
  if (seq !== preflightSeq) return;
  const available = quickClean.preflight(device, ingested);
  ui.modelSelect.disabled = !['wasm', 'webgpu'].includes(quickClean.backend) || processingInFlight || ingestInFlight;
  ui.processBtn.disabled = (!available && worker !== null) || !ingested || ingestInFlight || processingInFlight || downloadInFlight || reviewInFlight;
}

function clearProcessWatch() { clearInterval(processWatch); processWatch = null; }

function invalidateComparison() {
  review?.clear();
  for (const id of ['compareOriginalBtn', 'compareCleanedBtn']) {
    const button = $(id);
    if (button) { button.disabled = true; button.setAttribute('aria-pressed', 'false'); }
  }
  if ($('prepareComparisonBtn')) $('prepareComparisonBtn').disabled = !hasProcessed || processingInFlight || downloadInFlight || reviewInFlight;
}

function failProcessing(error) {
  clearProcessWatch();
  processingInFlight = false;
  hasProcessed = false;
  const jobId = window.__vipLandingJobId;
  if (jobId) endJob(jobId, 'error', error);
  window.__vipLandingJobId = null;
  hideSpinner();
  quickClean.setState('error', `Processing failed: ${error.message || error}. Your source file is unchanged. Retry Process; if model loading fails, reconnect or clear the model cache.`);
  setStatus('Processing failed — source unchanged; retry Process.', 'error');
  ui.fileInput.disabled = false;
  ui.modelSelect.disabled = false;
  invalidateComparison();
  updateDownloadButton();
  void refreshPreflight();
}

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
  { id: 'export',   label: 'Export' },
];

const STAGE_INDEX = Object.freeze({
  decode: 0,
  resample: 1,
  load: 2,
  separate: 3,
  export: 4,
});

/** Unified 0–100% weights: decode → resample → model load → inference → export. */
const PIPELINE_WEIGHTS = Object.freeze({
  decode: [0, 12],
  resample: [12, 20],
  load: [20, 35],
  separate: [35, 95],
  export: [0, 100],
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
  setLandingCancelVisible(true);
  if (statusLabel) {
    if (updateJobLabel) currentJobLabel = statusLabel;
    setStatus(statusLabel, 'warn');
  }
  const jobId = getCurrentJobId();
  if (jobId) updateJob(jobId, statusLabel || stage, _procState.progress);
  if (ui.landingJobStatus) {
    ui.landingJobStatus.hidden = false;
    ui.landingJobStatus.textContent = statusLabel
      ? `${statusLabel} · ${_procState.progress}%`
      : `Processing… ${_procState.progress}%`;
  }
  scheduleProcRender();
}

function setLandingCancelVisible(visible) {
  if (!ui.cancelProcessBtn) return;
  ui.cancelProcessBtn.hidden = !visible;
  ui.cancelProcessBtn.disabled = !visible;
}

function cancelLandingJob() {
  quickClean.setState('cancelling', 'Stopping safely… Your source file is unchanged.');
  cancelCurrent('user');
  requestSeq += 1;
  ingestSeq += 1;
  if (worker && processingInFlight) { worker.terminate(); worker = null; quickClean.setBackend('probing'); }
  clearProcessWatch();
  processingInFlight = false;
  ingestInFlight = false;
  hideSpinner();
  ui.fileInput.disabled = false;
  ui.modelSelect.disabled = false;
  window.__vipLandingJobId = null;
  setStatus('Cancelled — ready to retry', 'active');
  quickClean.setState(hasProcessed ? 'processed' : ingested ? 'ready' : 'empty',
    'Cancelled. Your source file is unchanged. Retry Process or choose another file.');
  updateDownloadButton();
  if (!worker) { try { getWorker(); } catch (err) { failProcessing(err); } }
  void refreshPreflight();
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
  setLandingCancelVisible(false);
  if (ui.landingJobStatus && !processingInFlight && !downloadInFlight) {
    ui.landingJobStatus.hidden = true;
  }
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
  const ready = hasProcessed && Boolean(mixer?.cleanBuffer);
  const busy = downloadInFlight || reviewInFlight || processingInFlight || ingestInFlight;
  for (const control of [...ui.mixSliders, ui.presetSelect, ui.muteVoiceBtn, ui.muteNoiseBtn]) {
    if (control) control.disabled = !ready || busy;
  }
  if (ui.exportRow) ui.exportRow.hidden = !ready;
  if (ui.downloadBtn) {
    ui.downloadBtn.disabled = !ready || downloadInFlight || reviewInFlight || processingInFlight;
    ui.downloadBtn.textContent = 'Export mix as WAV';
  }
  const videoButton = $('downloadVideoBtn');
  if (videoButton) {
    videoButton.hidden = !sourceFile || !isVideoFile(sourceFile);
    videoButton.disabled = !ready || downloadInFlight || processingInFlight || reviewInFlight;
  }
  if (ui.saveDriveBtn) {
    ui.saveDriveBtn.disabled = !ready || downloadInFlight || processingInFlight || reviewInFlight;
  }
}

function setDownloadHint(msg) {
  if (ui.downloadStatus) ui.downloadStatus.textContent = msg || '';
}

async function onOpenFromDrive() {
  try {
    const { openMediaFileFromDrive, isDriveConfigured } = await import('/src/core/GoogleDriveBridge.js');
    if (!isDriveConfigured()) {
      setStatus('Google Drive not configured — see docs/guides/GOOGLE_DRIVE.md', 'error');
      return;
    }
    setStatus('Sign in to Google Drive to pick a file…', 'warn');
    const file = await openMediaFileFromDrive();
    if (!file) return;
    await ingestFrom(file);
  } catch (err) {
    if (err?.code === 'CANCELLED') {
      setStatus('Drive picker cancelled', 'active');
      return;
    }
    console.error('[VIP][landing] Drive open failed:', err);
    setStatus(err?.message || 'Google Drive open failed', 'error');
  }
}

async function onSaveToDrive() { await onDownloadProcessed({ drive: true }); }

async function onDownloadProcessed({ video = false, drive = false } = {}) {
  if (!hasProcessed || !mixer?.cleanBuffer || downloadInFlight || processingInFlight || reviewInFlight || ingestInFlight) return;
  downloadInFlight = true;
  invalidateComparison();
  updateDownloadButton();
  ui.processBtn.disabled = true;
  const job = beginJob('Export processed', { kind: 'export' });
  const signal = job.controller.signal;
  setProcStage('export', 5, 'Rendering current mix…');
  quickClean.setState('exporting', 'Rendering and validating the current mix locally…');
  try {
    sliderUI?.flush();
    const region = mixer.getCropRegion();
    // Render full duration for video remux; its existing crop path trims audio and video together.
    const full = await mixer.renderMix({ signal, ...(video ? {} : { startSec: region.in, endSec: region.out }) });
    throwIfAborted(signal);
    const stats = await measureAudioBuffer(full, { signal });
    if (stats.clipped) throw new Error('The mix exceeds full scale. Lower Voice or Output Volume and export again.');
    let result;
    const base = (sourceFile?.name || ingested?.sourceName || 'export').replace(/\.[^.]+$/, '').slice(0, 80) || 'export';
    if (video && sourceFile && isVideoFile(sourceFile)) {
      try {
        result = await exportVideoWithProcessedAudio(sourceFile, full, {
          startSec: region.in, endSec: region.out, signal,
          onProgress: (pct) => { throwIfAborted(signal); setProcStage('export', Math.round(pct), 'Encoding video…'); },
        });
      } catch (err) {
        if (isCancellationError(err)) throw err;
        throw new Error(`Video export failed: ${err.message}. Use Export mix as WAV to save audio locally.`);
      }
    } else {
      setProcStage('export', 70, 'Encoding WAV locally…');
      result = { blob: await encodeReviewedWav(full, { signal }), filename: `${base}-processed.wav` };
    }
    throwIfAborted(signal);
    if (drive) {
      const { saveBlobToDrive, isDriveConfigured } = await import('/src/core/GoogleDriveBridge.js');
      if (!isDriveConfigured()) throw new Error('Google Drive is not configured. Use Export mix as WAV.');
      throwIfAborted(signal);
      // Drive's API has no abort support: disable Cancel before the explicit external file transfer.
      setLandingCancelVisible(false);
      setDownloadHint('Uploading to Google Drive…');
      await saveBlobToDrive({ blob: result.blob, filename: result.filename, mimeType: result.blob.type });
    } else if (isDesktopShell()) {
      const saved = await saveExportBlob(result.blob, { defaultName: result.filename, filters: filtersForFilename(result.filename) });
      if (saved.canceled) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    } else {
      triggerBlobDownload(result.blob, result.filename);
    }
    throwIfAborted(signal);
    const message = drive ? `Saved to Drive: ${result.filename}` : `Export prepared: ${result.filename}. Check your downloads or chosen folder.`;
    setDownloadHint(message);
    setStatus(message, 'active');
    quickClean.setState('exported', message);
    endJob(job.id, 'completed');
  } catch (err) {
    const cancelled = isCancellationError(err) || signal.aborted;
    const message = cancelled ? 'Export cancelled. Your source and mix are unchanged; export again when ready.'
      : `Export failed: ${err.message}. Your source and mix are unchanged.`;
    setDownloadHint(message);
    setStatus(message, cancelled ? 'active' : 'error');
    quickClean.setState(cancelled ? 'processed' : 'error', message);
    endJob(job.id, cancelled ? 'cancelled' : 'error', err);
  } finally {
    downloadInFlight = false;
    hideSpinner();
    updateDownloadButton();
    invalidateComparison();
    void refreshPreflight();
  }
}

async function prepareComparison() {
  if (!hasProcessed || processingInFlight || downloadInFlight || reviewInFlight) return;
  reviewInFlight = true;
  invalidateComparison();
  updateDownloadButton();
  ui.processBtn.disabled = true;
  const job = beginJob('Prepare comparison', { kind: 'review' });
  const signal = job.controller.signal;
  quickClean.setState('comparing', 'Preparing a level-matched comparison locally…');
  setLandingCancelVisible(true);
  try {
    sliderUI?.flush();
    review ||= new QuickCleanReview(mixer);
    const gains = await review.prepare(ingested.channelData, { signal });
    throwIfAborted(signal);
    for (const id of ['compareOriginalBtn', 'compareCleanedBtn']) $(id).disabled = false;
    $('comparisonStatus').textContent = gains.matched
      ? 'Average level matched (RMS), with peak headroom. Original and Cleaned use the same timeline. This is not a LUFS measurement.'
      : 'One side is silent or nearly silent; level matching is unavailable. Compare without normalization.';
    quickClean.setState('processed', 'Comparison ready. Choose Original or Cleaned to listen.');
    endJob(job.id, 'completed');
  } catch (err) {
    review?.clear();
    $('comparisonStatus').textContent = isCancellationError(err) ? 'Comparison cancelled; prepare again when ready.' : `Comparison unavailable: ${err.message}. Your mix is unchanged.`;
    quickClean.setState('processed', $('comparisonStatus').textContent);
    endJob(job.id, isCancellationError(err) ? 'cancelled' : 'error', err);
  } finally {
    reviewInFlight = false;
    setLandingCancelVisible(false);
    $('prepareComparisonBtn').disabled = !hasProcessed;
    updateDownloadButton();
    void refreshPreflight();
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

function getWorker() {
  if (worker) return worker;
  worker = createMLWorker();
  const ownedWorker = worker;
  initMLWorker(worker);
  worker.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (worker !== ownedWorker) return;
    const stale = !processingInFlight || msg.requestId !== requestSeq;
    if (!stale) lastProcessProgress = Date.now();
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
        quickClean.setBackend(msg.backend);
        void refreshPreflight();
        break;
      }
      case 'stage':
        if (stale) break;
        if (msg.stage === 'load') {
          quickClean.setState('downloading', 'Loading local models: checking cache, downloading if needed, and verifying integrity…');
          if ((msg.percent ?? 0) <= 1) stageStart('model_load');
          setProcStage(
            'load',
            msg.percent ?? 0,
            msg.label || `Loading ${msg.modelId || 'model'}…`,
            { updateJobLabel: false },
          );
        } else if (msg.stage === 'separate') {
          quickClean.setState('processing', 'Processing locally. Cancel leaves your source file unchanged.');
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
      case 'cancelled':
        if (stale) break;
        clearProcessWatch();
        stageEnd('isolate');
        stageEnd('model_load');
        processingInFlight = false;
        setStatus('Cancelled', 'active');
        hideSpinner();
        {
          const jid = window.__vipLandingJobId || getCurrentJobId();
          if (jid) endJob(jid, 'cancelled');
          window.__vipLandingJobId = null;
        }
        ui.processBtn.disabled = !ingested;
        ui.fileInput.disabled = false;
        ui.modelSelect.disabled = false;
        break;
      case 'error':
        if (stale) break;
        clearProcessWatch();
        failProcessing(new Error(msg.message || 'Local worker failed'));
        worker?.terminate();
        worker = null;
        quickClean.setBackend('probing');
        break;
      default:
        break;
    }
  });
  worker.addEventListener('error', (err) => {
    if (worker !== ownedWorker) return;
    clearProcessWatch();
    failProcessing(new Error(err.message || 'Local worker failed'));
    worker.terminate();
    worker = null;
    quickClean.setBackend('probing');
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
        invalidateComparison();
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
  ['noiseReductionSlider', 'noiseReductionVal', (v) => `${100 - v}% retained`],
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

// ─── Pipeline glue ───────────────────────────────────────────────────────────

/**
 * Shared ingestion entry point used by both the file-input change handler and
 * the drag-and-drop drop handler. Guards against concurrent calls by disabling
 * the file input for the duration, and resets its value in `finally` so the
 * same file can be re-selected after a failed decode.
 */
async function ingestFrom(file) {
  if (!file || ingestInFlight || processingInFlight || downloadInFlight || reviewInFlight) return;
  try {
    assertIngestible(file);
  } catch (err) {
    setStatus(err.message, 'error');
    quickClean.setState('error', `Invalid media: ${err.message}. Your source is unchanged. Choose a supported audio or video file.`);
    return;
  }
  const seq = ++ingestSeq;
  requestSeq += 1;
  ingestInFlight = true;
  ingested = null;
  hasProcessed = false;
  invalidateComparison();
  mixer?.stop();
  quickClean.setState('importing', 'Reading the recording on this device…');
  for (const el of [ui.playBtn, ui.pauseBtn, ui.stopBtn, ...ui.mixSliders]) if (el) el.disabled = true;
  resetTimings();
  clearStemCache();
  sourceFile = file;
  ui.processBtn.disabled = true;
  ui.fileInput.disabled = true;
  if (ui.downloadBtn) ui.downloadBtn.disabled = true;
  if (ui.exportRow) ui.exportRow.hidden = true;
  const job = beginJob('Decode upload', { kind: 'decode' });
  window.__vipLandingJobId = job.id;
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
    if (seq !== ingestSeq) {
      endJob(job.id, 'cancelled');
      if (window.__vipLandingJobId === job.id) window.__vipLandingJobId = null;
      return;
    }
    ingested = next;
    // Always attempt preview for video sources after decode succeeds.
    if (isVideoFile(file)) loadVideo(file);
    if (seq !== ingestSeq) {
      endJob(job.id, 'cancelled');
      window.__vipLandingJobId = null;
      return;
    }

    hideSpinner();
    endJob(job.id, 'completed');
    if (window.__vipLandingJobId === job.id) window.__vipLandingJobId = null;
    quickClean.setState('imported', `Imported “${file.name}”. Nothing has been processed yet.`);
    setStatus('Imported — choose an outcome, then press Process locally.', 'active');
    // Import never initiates inference. Every duration follows the same explicit Process boundary.
  } catch (err) {
    if (seq !== ingestSeq) {
      if (window.__vipLandingJobId === job.id) {
        endJob(job.id, 'cancelled');
        window.__vipLandingJobId = null;
      }
      return;
    }
    hideSpinner();
    clearVideo(); // nothing to play — don't leave a dangling preview/object URL
    console.error('[VIP][landing] ingestion failed:', err);
    setStatus(err.message, 'error');
    quickClean.setState('error', `Import failed: ${err.message}. Your source file is unchanged. Choose a supported format and retry.`);
    endJob(job.id, 'error', err);
    window.__vipLandingJobId = null;
    ingested = null;
    sourceFile = null;
    ui.processBtn.disabled = true;
    updateDownloadButton();
  } finally {
    if (seq === ingestSeq) {
      ingestInFlight = false;
      if (ingested) quickClean.setState('ready', 'Ready. Choose an outcome and press Process locally.');
      void refreshPreflight();
      ui.fileInput.disabled = false;
      ui.fileInput.value = '';
    }
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
    if (event.target.closest('#browseBtn') || event.target.closest('#openDriveBtn')) return;
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

function onProcess() {
  if (!ingested || ingestInFlight || processingInFlight || downloadInFlight || reviewInFlight) return;
  if (!worker) {
    try { getWorker(); setStatus('Checking local runtime — press Process when ready.', 'warn'); }
    catch (err) { failProcessing(err); }
    return;
  }
  try {
    processPlan = quickClean.plan(); // immutable outcome + shipped model chain captured on this click
    processingInFlight = true;
    hasProcessed = false;
    invalidateComparison();
    updateDownloadButton();
    ui.processBtn.disabled = true;
    ui.fileInput.disabled = true;
    ui.modelSelect.disabled = true;
    const modelIds = processPlan.modelIds;
    const cacheKey = stemCacheKey(ingested.channelData, ingested.sampleRate, modelIds, ingested.sourceName);
    const job = beginJob('Separate stems', { kind: 'separate' });
    window.__vipLandingJobId = job.id;
    currentJobLabel = `${processPlan.label} — processing locally…`;
    quickClean.setState('processing', currentJobLabel);
    setProcStage('separate', 0, currentJobLabel);
    const id = ++requestSeq;
    const cached = getCachedStems(cacheKey);
    if (cached) {
      onStems({ requestId: id, clean: cached.clean.map((c) => c.slice()),
        noise: cached.noise.map((c) => c.slice()), sampleRate: cached.sampleRate,
        passthrough: false, _cacheKey: cacheKey });
      return;
    }
    ingested._stemCacheKey = cacheKey;
    stageStart('model_load');
    const channelData = ingested.channelData.map((channel) => channel.slice());
    const startedAt = Date.now();
    lastProcessProgress = startedAt;
    clearProcessWatch();
    processWatch = setInterval(() => {
      if (Date.now() - lastProcessProgress < 45000 && Date.now() - startedAt < 300000) return;
      requestSeq += 1;
      worker?.terminate();
      worker = null;
      failProcessing(new Error('The worker stopped responding. Retry Process.'));
    }, 5000);
    getWorker().postMessage({ type: 'process', requestId: id, modelIds: [...modelIds],
      channelData, sampleRate: processPlan.sampleRate }, channelData.map((channel) => channel.buffer));
  } catch (err) { failProcessing(err); }
}

function onStems({ requestId, clean, noise, sampleRate, passthrough, _cacheKey }) {
  if (!processingInFlight || requestId !== requestSeq) return; // stale response
  clearProcessWatch();
  processingInFlight = false;
  stageEnd('isolate');
  stageEnd('model_load');
  setProgress(100);
  hideSpinner();
  const jid = window.__vipLandingJobId || getCurrentJobId();
  if (jid) endJob(jid, passthrough ? 'error' : 'completed');
  window.__vipLandingJobId = null;

  const cacheKey = _cacheKey || ingested?._stemCacheKey;
  if (!passthrough && cacheKey) {
    setCachedStems(cacheKey, { clean, noise, sampleRate, passthrough: false });
  }
  ui.processBtn.disabled = false;
  ui.fileInput.disabled = false;
  ui.modelSelect.disabled = false;

  if (passthrough) {
    failProcessing(new Error('Models could not run; no cleaned result was produced.'));
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
  hasProcessed = true;
  invalidateComparison();
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
  applyPreset('original', { ...RT_SLIDER_DEFAULTS, noiseReductionSlider: 100 - (processPlan?.background || 0) });
  quickClean.setState('processed', 'Processing complete. Prepare matched A/B, adjust Voice and Background, then export the mix.');
  setStatus('Stems ready — compare, listen and export.', 'active');
  const scheduleIdle = globalThis.requestIdleCallback
    ? (cb) => requestIdleCallback(cb, { timeout: 2000 })
    : (cb) => setTimeout(cb, 0);
  scheduleIdle(() => { if (requestId === requestSeq && hasProcessed) void detectSpeakers(clean, sampleRate); });
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

if (ui.fileInput?.setAttribute) ui.fileInput.setAttribute('accept', getFileInputAccept());
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
ui.modelSelect.addEventListener('change', () => { void refreshPreflight(); });
$('prepareComparisonBtn')?.addEventListener('click', () => { void prepareComparison(); });
for (const [id, which] of [['compareOriginalBtn', 'original'], ['compareCleanedBtn', 'cleaned']]) {
  $(id)?.addEventListener('click', async () => {
    try {
      await review?.listen(which);
      for (const buttonId of ['compareOriginalBtn', 'compareCleanedBtn']) $(buttonId).setAttribute('aria-pressed', String(buttonId === id));
    } catch (err) { $('comparisonStatus').textContent = `Playback failed: ${err.message}. Try Play again.`; }
  });
}
document.addEventListener('input', (event) => {
  if (event.target.matches('input[type="range"]') && event.target.id !== 'seekSlider') {
    invalidateComparison();
    $('comparisonStatus').textContent = 'Mix changed. Prepare matched A/B again to compare this version.';
  }
  if (event.target.id === 'noiseReductionSlider') event.target.setAttribute('aria-valuetext', `${100 - Number(event.target.value)} percent background retained`);
});
for (const id of ['playBtn', 'pauseBtn', 'stopBtn', 'seekSlider']) {
  $(id)?.addEventListener(id === 'seekSlider' ? 'input' : 'click', () => review?.stop());
}
for (const id of ['muteVoiceBtn', 'muteNoiseBtn', 'presetSelect', 'speakerCardsGrid']) {
  $(id)?.addEventListener('click', invalidateComparison);
  $(id)?.addEventListener('change', invalidateComparison);
}
$('downloadVideoBtn')?.addEventListener('click', () => { void onDownloadProcessed({ video: true }); });
ui.cancelProcessBtn?.addEventListener('click', () => { cancelLandingJob(); });
ui.presetSelect.addEventListener('change', () => applyPreset(ui.presetSelect.value));
ui.downloadBtn?.addEventListener('click', () => { onDownloadProcessed().catch(() => {}); });
ui.openDriveBtn?.addEventListener('click', () => { onOpenFromDrive().catch(() => {}); });
ui.saveDriveBtn?.addEventListener('click', () => { onSaveToDrive().catch(() => {}); });
wireReadouts();
wireSliderHints();
wireTransport();
wireMuteButtons();
wireDragAndDrop();
mountBadge();
try { getWorker(); } catch (err) { quickClean.setBackend('unavailable'); quickClean.setState('error', err.message); }
void refreshPreflight();
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
window.addEventListener('pagehide', () => { clearProcessWatch(); review?.clear(); worker?.terminate(); });

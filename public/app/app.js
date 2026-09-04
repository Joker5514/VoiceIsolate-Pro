/**
 * VoiceIsolate Pro — app.js  v25.0.2
 * ====================================
 * Exports:  class VoiceIsolatePro  (also assigned to window.VoiceIsolatePro)
 *
 * vip-boot.js contract:
 *   - typeof VoiceIsolatePro !== 'undefined'   after this module evaluates
 *   - new VoiceIsolatePro()                    must not throw
 *   - instance.init()                          completes async bootstrap
 *   - window._vipApp                           set to the live instance
 *
 * Single-Pass Spectral Contract:
 *   ONE forward STFT  → in-place spectral ops → ONE iSTFT
 *   Heavy DSP/ML runs in workers (MLWorker, FullAnalysisWorker, USMWorker).
 *   app.js wires UI → pipeline hosts; never re-runs ML from slider events.
 *
 * 100 % local — no cloud APIs, no external fetch except /app/models/*.onnx.
 *
 * ── Engineer Mode data flow (path correctness) ─────────────────────────────
 *   Upload  →  File selected → FileLibrary (OPFS/IDB) unless Quick import
 *        ↓
 *   Decode  →  ensureDecoded() / FileIngestion (main thread yield + OfflineAudio)
 *        ↓
 *   Analyze →  FullAnalysisHost → FullAnalysisWorker (features, segments, recs)
 *              + USM backend (USMNode / USMWorker) once per file — stems cached
 *              → chips + audition layers; does NOT block sliders or Process
 *        ↓
 *   Config  →  Slider / preset / WhisperHunter map (Live-Mix GainNodes only)
 *        ↓
 *   Process →  runPipeline(): pause transport if playing → MLWorker isolation
 *              (or DSP fallback) → stems → Live-Mix load. Heartbeats + timeout.
 *        ↓
 *   Playback / A-B  →  Transport + toggleAB() swaps original vs processed
 *                      sample-accurate (playhead retained); no re-decode
 *        ↓
 *   Export  →  Save Original / Save Processed (local download only)
 *
 * Non-blocking contracts:
 *   - Analysis does not freeze slider interaction (worker + yield).
 *   - USM runs post-analysis off-main; never on mute/solo/slider drag.
 *   - Process pauses playback intentionally but does not auto-resume.
 *   - Transport A/B and playhead remain available after Process completes.
 */

import { SLIDER_REGISTRY, STAGES, SLIDER_ALIASES } from './slider-map.js';
import {
  getCalibratedPresets,
  PRESET_REDIRECTS as CALIBRATED_PRESET_REDIRECTS,
  resolvePresetName as resolveCalibratedPresetName,
} from '/src/core/PresetCalibration.js';
import {
  buildMlProcessingConfig,
  LIVE_MIX_PARAM_IDS,
} from '/src/core/ParameterSchema.js';
import { buildHintPanel, mountInfoPopover, removeAllInfoPopovers } from './slider-hint-ui.js';
import {
  calibrate,
  getEffectiveDspParams,
} from './slider-calibration.js';
import {
  createDspSliderRow,
  sliderMatchesQuery,
  SLIDER_SEARCH_ALIASES,
  buildAriaValueText,
} from '/src/presentation/DspSlider.js';
import { decodeBlobToAudioBuffer } from '/src/pipeline/media-decode.js';
import { resampleToCanonical } from '/src/pipeline/FileIngestion.js';
import {
  createYieldBudget,
  yieldToBrowser,
  throwIfAborted,
  processInChunks,
} from '/src/pipeline/ui-yield.js';
import { sliceAudioBuffer } from '/src/core/audio-slice.js';
import { clearStemCache } from '/src/pipeline/MLStemCache.js';
import { resetTimings, stageEnd, stageStart } from '/src/pipeline/PipelineTiming.js';
import { paintSeekFill, wireTransportRegion } from '/src/presentation/TransportRegionControls.js';
import { isDesktopShell, pickAudioFile, saveExportBlob, filtersForFilename } from '/src/core/DesktopBridge.js';
import {
  FILE_INPUT_ACCEPT,
  getFileInputAccept,
  inferMediaKind,
  isGenericMimeType,
  isVideoSource,
  resolveMediaKind,
} from '/src/core/media-types.js';
import * as FileLibrary from '/src/core/FileLibrary.js';
import * as ProjectStore from '/src/core/ProjectStore.js';
import {
  saveStemsDurable,
  loadStemsDurable,
} from '/src/core/storage/DerivedCache.js';
import { ensureCacheFresh } from '/src/core/storage/CacheManifest.js';
import {
  getTrackState,
  scheduleSaveTrackState,
  flushTrackStateSaves,
} from '/src/core/TrackState.js';
import {
  mountFileLibraryUI,
  refreshLibraryList,
  readImportOptionsFromUi,
} from '/src/presentation/FileLibraryUI.js';
import { persistAppSession, restoreAppSession } from './session-persist.js';
import {
  exportVideoWithProcessedAudio,
  triggerBlobDownload,
} from '/src/pipeline/video-export.js';
import { openFilePicker as triggerFileInput, primeAudioGesture, fixUploadTouchTargets, resetFileInput } from '/src/presentation/UploadWiring.js';
import { startWorkletStatusDriver } from '/src/presentation/WorkletStatus.js';
import {
  analyzeAcousticEnvironment,
  buildHeuristicMask,
  chunkedMaskInference,
  detectWhisperPlatform,
  ensureWhisperHunterInstance,
  getWhisperPlatformProfile,
  maskConfidence,
} from './whisper-hunter.js';
/**
 * Local preset redirect (mirrors src/core/PresetCalibration.js).
 * Kept in-app so Jest eval helpers that strip ESM imports still work.
 */
function resolvePresetNameLocal(name) {
  const redirects = {
    'Whisper in a Club': 'Aggressive Isolate',
    'Stadium Crowd': 'Surveillance',
  };
  if (!name) return 'Voice Clarity';
  if (typeof PRESETS !== 'undefined' && PRESETS[name] && !redirects[name]) return name;
  if (redirects[name] && typeof PRESETS !== 'undefined' && PRESETS[redirects[name]]) {
    return redirects[name];
  }
  if (typeof PRESETS !== 'undefined' && PRESETS[name]) return name;
  return redirects[name] || name || 'Voice Clarity';
}

const LARGE_FILE_WARNING_BYTES = 500 * 1024 * 1024;
const EXTENSION_MIME_TYPES = Object.freeze({
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  opus: 'audio/opus',
  webm: 'audio/webm',
});

function cloneArrayBuffer(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer)) return arrayBuffer;
  const out = new Uint8Array(arrayBuffer.byteLength);
  out.set(new Uint8Array(arrayBuffer));
  return out.buffer;
}

function detectUploadMimeType(file) {
  const explicit = (file?.type || '').toLowerCase();
  if (explicit) return explicit;
  const name = (file?.name || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  if (EXTENSION_MIME_TYPES[ext]) return EXTENSION_MIME_TYPES[ext];
  const kind = inferMediaKind(file);
  if (kind === 'video') return 'video/mp4';
  if (kind === 'audio') return 'audio/unknown';
  return '';
}

function isLikelyAacContainerMime(mimeType) {
  return /(?:audio\/mp4|audio\/x-m4a|audio\/m4a|audio\/aac|audio\/x-aac|aac|m4a)/i.test(mimeType || '');
}

/** Hero landing + branded loader — local-only cinematic shell */
const HeroExperience = (() => {
  let appRef = null;

  function $(id) { return document.getElementById(id); }

  function mapStageLabel(detail, pct) {
    const d = (detail || '').toLowerCase();
    if (d.includes('decod')) return 'decode';
    if (d.includes('normal')) return 'normalize';
    if (d.includes('vad') || d.includes('profile')) return 'profile';
    if (d.includes('isol') || d.includes('stft') || d.includes('spectral')) return 'spectral refine';
    if (d.includes('gate')) return 'gate';
    if (d.includes('compress') || d.includes('dyn') || d.includes('eq')) return 'compress';
    if (d.includes('render') || d.includes('export') || d.includes('final')) return 'finalize';
    if (pct >= 100) return 'finalize';
    if (pct > 75) return 'render';
    if (pct > 45) return 'isolate';
    return 'decode';
  }

  function setUiState(state) {
    const hero = $('vipHero');
    if (hero && hero.dataset) hero.dataset.uiState = state;
  }

  function setHeroCopy(status, enableProcess) {
    const statusEl = $('heroStatus');
    if (statusEl && status) statusEl.textContent = status;
    // Prefer the app's button state (knows about deferred _sourceFile). Only
    // force-enable when the caller explicitly says the file is ready.
    if (appRef && typeof appRef._updateProcessButtonsState === 'function') {
      appRef._updateProcessButtonsState();
    }
    const cta = $('heroCtaProcess');
    const busy = !!(appRef && appRef.isProcessing);
    if (cta && enableProcess && !busy) cta.disabled = false;
  }

  function syncAliasControls() {
    const pairs = [
      ['tpAB', 'abToggle'],
      ['tpABLabel', 'abLabel'],
      ['saveProcBtn', 'exportBtn'],
    ];
    for (const [src, dst] of pairs) {
      const s = $(src);
      const d = $(dst);
      if (!s || !d) continue;
      d.disabled = s.disabled;
      if (dst === 'abLabel') d.textContent = s.textContent;
    }
  }

  function syncStatStrip(buf, statusText) {
    if (buf) {
      const dur = $('stat-duration');
      const sr = $('stat-sr');
      const ch = $('stat-channels');
      if (dur) dur.textContent = typeof fmtTime === 'function' ? fmtTime(buf.duration) : `${buf.duration.toFixed(1)}s`;
      if (sr) sr.textContent = `${buf.sampleRate} Hz`;
      if (ch) ch.textContent = buf.numberOfChannels === 1 ? 'Mono' : 'Stereo';
    }
    const st = $('stat-status');
    if (st && statusText) st.textContent = statusText;
    // Voice / Noise / SNR always flow through the centralized metrics writer.
    if (appRef && typeof appRef.updateAudioMetrics === 'function') {
      appRef.updateAudioMetrics(appRef._lastMetricsState || null);
    } else {
      const snr = $('stat-snr');
      if (snr && appRef?.lastSNR != null) snr.textContent = `${appRef.lastSNR} dB`;
    }
  }

  function mirrorWaveCanvases() {
    const pairs = [['waveCanvas', 'inputCanvas'], ['waveProcCanvas', 'outputCanvas']];
    for (const [srcId, dstId] of pairs) {
      const src = $(srcId);
      const dst = $(dstId);
      if (!src || !dst || !src.width) continue;
      dst.width = src.width;
      dst.height = src.height;
      const ctx = dst.getContext('2d');
      if (ctx) ctx.drawImage(src, 0, 0);
    }
  }

  function initHeroVideo() {
    const video = $('heroVideo');
    const fallback = $('heroFallback');
    if (!video) return;
    const showFallback = () => {
      if (fallback) { fallback.hidden = false; fallback.setAttribute('aria-hidden', 'false'); }
      video.style.display = 'none';
    };
    const releaseHero = () => {
      try { video.pause(); } catch { /* ignore */ }
      try {
        video.removeAttribute('src');
        video.load();
      } catch { /* ignore */ }
      video.style.display = 'none';
      if (fallback) {
        fallback.hidden = false;
        fallback.setAttribute('aria-hidden', 'false');
      }
    };
    video.addEventListener('error', showFallback);
    const playAttempt = video.play();
    if (playAttempt && typeof playAttempt.catch === 'function') {
      playAttempt.catch(showFallback);
    }
    // Hero loop is decorative only — release decoder after a short intro so it
    // cannot keep the main thread / GPU busy during engineer workflow.
    setTimeout(releaseHero, 6000);
    window.addEventListener('vip:fileLoaded', releaseHero, { once: true });
    window.addEventListener('vip:playStarted', releaseHero, { once: true });
  }

  function bindHeroCtas(app) {
    $('heroCtaUpload')?.addEventListener('click', async (e) => {
      e.preventDefault();
      if (isDesktopShell()) {
        try {
          const file = await pickAudioFile();
          if (file) await app.handleFile(file);
        } catch (err) {
          app.showNotification?.(err?.message || 'Could not open file', 'error');
        }
        return;
      }
      triggerFileInput(app.dom?.fileInput);
      primeAudioGesture().catch(() => {});
    });
    $('heroCtaProcess')?.addEventListener('click', (e) => {
      e.preventDefault();
      if (app.isProcessing) return;
      if (!app.dom.processBtn?.disabled) app.runPipeline();
    });
    $('exportBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      app.dom.saveProcBtn?.click();
    });
    $('playOrig')?.addEventListener('click', () => {
      if (app.abMode !== 'original') app.dom.tpAB?.click();
      app.dom.tpPlay?.click();
    });
    $('playProc')?.addEventListener('click', () => {
      if (app.abMode !== 'processed') app.dom.tpAB?.click();
      app.dom.tpPlay?.click();
    });
    $('abToggle')?.addEventListener('click', () => app.dom.tpAB?.click());
  }

  function patchOverlayRefs() {
    const tryPatch = (n = 0) => {
      if (!globalThis.VIPOverlay) {
        if (n < 80) setTimeout(() => tryPatch(n + 1), 100);
        return;
      }
      const ov = globalThis.VIPOverlay;
      const origInit = ov._initRefs.bind(ov);
      ov._initRefs = function patchedInitRefs() {
        origInit.call(this);
        if (!this._refs) return;
        this._refs.stageName = $('processingStage') || this._refs.stageName;
        this._refs.pct = $('processingPercent') || this._refs.pct;
        this._refs.bar = $('processingBarFill') || this._refs.bar;
      };
      ov._initRefs();
    };
    tryPatch();
  }

  function onPipelineProgress(stageIndex, detail, pct) {
    const p = typeof pct === 'number' ? pct : 0;
    const label = mapStageLabel(detail, p);
    const stageEl = $('processingStage');
    const pctEl = $('processingPercent');
    const bar = $('processingBarFill');
    const pipeFill = $('pipelineFill');
    const chip = $('procStageChip');
    if (stageEl && detail) stageEl.textContent = detail;
    if (pctEl) pctEl.textContent = `${Math.round(p)}%`;
    if (bar) bar.style.width = `${p}%`;
    if (pipeFill) pipeFill.style.width = `${p}%`;
    if (chip) chip.textContent = `◉ ${label}`;
    const barWrap = $('pipelineStage');
    if (barWrap) barWrap.setAttribute('aria-valuenow', String(Math.round(p)));
    if (p >= 100) setUiState('processed');
    else if (p > 0) setUiState('processing');
    else if (appRef?.outputBuffer || appRef?.procBuffer) setUiState('processed');
    else if (appRef?.inputBuffer || appRef?.origBuffer) setUiState('file-ready');
    else setUiState('idle');
    if (appRef && typeof appRef._updateProcessButtonsState === 'function') {
      appRef._updateProcessButtonsState();
    }
    syncStatStrip(appRef?.inputBuffer || appRef?.origBuffer, detail || 'Processing');
    mirrorWaveCanvases();
  }

  return {
    init(app) {
      appRef = app;
      initHeroVideo();
      bindHeroCtas(app);
      patchOverlayRefs();
      setUiState('idle');
      const tierStatus = WorkflowTier.getConfig?.()?.statusIdle;
      setHeroCopy(tierStatus || 'Ready — upload audio or video to begin', false);
      window.addEventListener('vip:fileAccepted', () => {
        setUiState('file-ready');
        setHeroCopy('File accepted — Analyze or Process to decode', true);
      });
      window.addEventListener('vip:fileLoaded', () => {
        setUiState('file-ready');
        setHeroCopy('File loaded — processing pipeline starting', true);
        syncStatStrip(app.inputBuffer || app.origBuffer, 'File loaded');
        mirrorWaveCanvases();
      });
      window.addEventListener('vip:processingDone', () => {
        setUiState('processed');
        setHeroCopy('Processing complete — playback and export ready', true);
        syncStatStrip(app.outputBuffer || app.procBuffer, 'Complete');
        mirrorWaveCanvases();
        syncAliasControls();
      });
      document.addEventListener('vip:playStarted', () => setUiState('playback'));
    },
    onDecodeStart() {
      setUiState('processing');
      setHeroCopy('Decoding audio locally…', false);
    },
    onDecodeError(msg) {
      setUiState('error');
      setHeroCopy(msg || 'Could not decode file', false);
    },
    onPipelineProgress(stageIndex, detail, pct) {
      onPipelineProgress(stageIndex, detail, pct);
    },
    onClear() {
      setUiState('idle');
      const tierStatus = WorkflowTier.getConfig?.()?.statusIdle;
      setHeroCopy(tierStatus || 'Ready — upload audio or video to begin', false);
      syncStatStrip(null, 'Idle');
    },
    mirrorWaveCanvases,
    syncAliasControls,
  };
})();

// Registry lookup for examples + calibrated transforms
const SLIDER_REG_BY_ID = Object.freeze(
  SLIDER_REGISTRY.reduce((acc, s) => { acc[s.id] = s; return acc; }, {})
);

function _formatSliderUnit(unit) {
  if (!unit) return '';
  if (unit === '%' || unit === ':1' || unit.startsWith(' ')) return unit;
  return ` ${unit}`;
}

/** Live-Mix bridge sliders — canonical list in ParameterSchema / EngineerModeBridge. */
const BRIDGE_RT_SLIDER_IDS = new Set(LIVE_MIX_PARAM_IDS);

/** Calibrated render contract — min/max/step/default from SLIDER_REGISTRY. */
const RENDER_SLIDERS = SLIDER_REGISTRY.map((s) => ({
  id: s.id,
  label: s.label,
  min: s.min,
  max: s.max,
  val: s.default,
  step: s.step,
  unit: _formatSliderUnit(s.unit),
  rt: BRIDGE_RT_SLIDER_IDS.has(s.id),
  desc: s.hint || s.tip || '',
  group: s.group,
}));
import { ModelStatusUI } from './model-status-ui.js';
import WorkflowTier from './workflow-tier.js';
import { recommendEngineerPreset } from '/src/core/MixCalibration.js';

// Model keys served by /app/models-manifest.json (ModelCDNLoader.getManifest()) —
// drives the "Model Cache & Providers" pills + Local Model Health panel.
// NOTE: Appears unused in app.js but is referenced by external UI components and test suites
// that parse this file directly to validate model configuration consistency.
const MODEL_STATUS_KEYS = ['demucs', 'bsrnn', 'rnnoise', 'silero_vad'];

/** Default offline chain — BS-RNN vocals only (fast; denoise chain is opt-in). */
const DEFAULT_ML_CHAIN = Object.freeze(['bsrnn_vocals']);

// ---------------------------------------------------------------------------
// SAB ring-buffer constants (must match dsp-processor.js exactly)
// NOTE: These constants appear unused in app.js but are critical for:
// 1. Test suites (tests/app.test.js) that verify SAB protocol consistency
// 2. Documentation generation tools that extract DSP configuration
// 3. Future refactoring where app.js may need to validate SAB dimensions
// Do not remove - they serve as the canonical reference for the entire pipeline.
// ---------------------------------------------------------------------------
const FFT_SIZE = 4096;
// eslint-disable-next-line no-unused-vars -- pinned SAB/STFT reference constant; do NOT remove (see note above; parsed verbatim by tests/sab-protocol-fixes.test.js)
const HOP_SIZE = 1024;
const HALF_BINS = FFT_SIZE / 2 + 1;
const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * 5; // FLAG_SLOTS = 5

// ---------------------------------------------------------------------------
// 67-Slider definition (inline — tests parse this source directly)
// NOTE: SLIDERS object appears unused directly but is consumed by SLIDER_BY_ID (line 111)
// and is parsed by test suites to validate slider configuration consistency.
// The inline definition here (rather than importing from a separate file) ensures
// tests can parse this single source file to verify the complete slider contract.
// ---------------------------------------------------------------------------
const SLIDERS = {
  gate: [
    { id:'gateThresh', label:'Threshold', min:-80, max:-5, val:-42, step:1, unit:' dB', rt:true, desc:'Audio quieter than this level is treated as silence and turned down.', example:'Raise toward -30 dB to mute the room tone between sentences in a voice memo; lower toward -60 dB so soft speech is never cut off.' },
    { id:'gateRange', label:'Range', min:-80, max:-5, val:-60, step:1, unit:' dB', rt:true, desc:'How far the gated (silent) sections are turned down.', example:'-60 dB fully silences gaps; set -12 dB to just soften background hiss instead of killing it, keeping a natural ambience.' },
    { id:'gateAttack', label:'Attack', min:0, max:500, val:5, step:1, unit:' ms', rt:true, desc:'How fast the gate opens when speech starts.', example:'Keep at ~5 ms so the start of each word ("Hello") is not clipped; longer values soften hard consonants.' },
    { id:'gateRelease', label:'Release', min:50, max:2000, val:200, step:10, unit:' ms', rt:true, desc:'How fast the gate closes after sound stops.', example:'~200 ms feels natural for speech; raise to 800 ms so the tail of a sung note or reverb is not chopped off abruptly.' },
    { id:'gateHold', label:'Hold', min:0, max:500, val:50, step:1, unit:' ms', rt:true, desc:'Minimum time the gate stays open after a sound.', example:'Set ~80 ms to stop the gate "chattering" open and shut during a stuttered or breathy phrase.' },
    { id:'gateLookahead', label:'Lookahead', min:0, max:20, val:5, step:1, unit:' ms', rt:true, desc:'Delays the Live-Mix gate path so its detector can open before a sound arrives.', example:'5–10 ms preserves a plosive attack; higher values add the same amount of preview latency.' },
  ],
  nr: [
    { id:'nrAmount', label:'NR Amount', min:0, max:100, val:52, step:1, unit:'%', rt:false, desc:'Overall strength of the spectral noise removal.', example:'~50–55% cleans steady hiss without high-pitch musical noise; push past 85% only for heavy noise (can sound underwater).' },
    { id:'nrSensitivity', label:'Sensitivity', min:0, max:100, val:48, step:1, unit:'%', rt:false, desc:'How aggressively the noise floor is detected and learned.', example:'Raise to ~80% when noise is loud and constant (traffic); lower to ~40% to avoid mistaking quiet speech for noise.' },
    { id:'nrSpectralSub', label:'Spectral Sub', min:0, max:100, val:35, step:1, unit:'%', rt:false, desc:'Extra subtraction of the learned noise spectrum.', example:'Bump to ~70% to scrub tonal hum/whine; high values can add a "musical noise" warble, so back off if you hear bubbling.' },
    { id:'nrFloor', label:'NR Floor', min:-96, max:-30, val:-68, step:1, unit:' dB', rt:false, desc:'How deep the quietest residual noise is allowed to drop.', example:'-68 dB is transparent; set -40 dB to leave a faint natural noise bed so dialogue does not sound unnaturally dead.' },
    { id:'nrSmoothing', label:'Smoothing', min:0, max:100, val:32, step:1, unit:'%', rt:false, desc:'Averages noise estimates over time to reduce artifacts.', example:'~30–40% reduces smear; high values blur consonants and can smear the voice.' },
  ],
  eq: [
    { id:'eqSub', label:'Sub', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Lowest rumble band (20–60 Hz).', example:'Cut -6 dB to remove desk thumps and AC rumble from a podcast; rarely boosted for voice.' },
    { id:'eqBass', label:'Bass', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Bass weight band (60–200 Hz).', example:'Boost +2 dB for a fuller, radio-style male voice; cut -4 dB if speech sounds boomy or muddy.' },
    { id:'eqWarmth', label:'Warmth', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Lower-midrange warmth (200–500 Hz).', example:'A small +1.5 dB adds chest/warmth; cut -3 dB to clear "boxy" muddiness on a close-mic recording.' },
    { id:'eqBody', label:'Body', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Core body of the voice (500 Hz–1 kHz).', example:'Boost +1 dB for a thicker voice; cut to reduce a hollow, telephone-like tone.' },
    { id:'eqLowMid', label:'Low Mid', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Low-mid definition (1–2 kHz).', example:'Nudge +1 dB to help vowels cut through music; cut if the voice sounds nasal or honky.' },
    { id:'eqMid', label:'Mid', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Intelligibility band (2–4 kHz).', example:'Boost +2 dB so dialogue is easier to understand over background noise; too much sounds harsh.' },
    { id:'eqPresence', label:'Presence', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Presence and forwardness (4–6 kHz).', example:'+1.5 dB makes a voice sound closer and more "in the room"; cut to tame an aggressive announcer.' },
    { id:'eqClarity', label:'Clarity', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Detail and consonants (6–10 kHz).', example:'Boost +1 dB for crisp "s" and "t" sounds; cut if sibilance is harsh (pair with the de-esser).' },
    { id:'eqAir', label:'Air', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Open "air" band (10–16 kHz).', example:'+1 dB adds an expensive, airy sheen to vocals; cut on noisy phone recordings to hide hiss.' },
    { id:'eqBrill', label:'Brilliance', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Top-end sparkle (16–20 kHz).', example:'A gentle +0.5 dB adds shimmer to music vocals; usually left flat or cut for spoken word.' },
  ],
  dyn: [
    { id:'compThresh', label:'Threshold', min:-60, max:0, val:-24, step:1, unit:' dB', rt:true, desc:'Level where the compressor starts evening out volume.', example:'Set ~-24 dB so loud and soft words sit closer together; lower it to compress more of the performance.' },
    { id:'compRatio', label:'Ratio', min:1, max:20, val:4, step:0.5, unit:':1', rt:true, desc:'How hard volume above the threshold is reduced.', example:'4:1 is a natural podcast setting; 10:1+ acts almost like a limiter for very uneven phone audio.' },
    { id:'compAttack', label:'Attack', min:1, max:200, val:10, step:1, unit:' ms', rt:true, desc:'How quickly compression clamps down on a loud peak.', example:'~10 ms keeps speech punchy; very fast (1 ms) squashes transients for a denser, controlled sound.' },
    { id:'compRelease', label:'Release', min:10, max:1000, val:150, step:10, unit:' ms', rt:true, desc:'How quickly compression lets go after a peak.', example:'~150 ms breathes naturally with speech; too short can cause an audible pumping on sustained notes.' },
    { id:'compKnee', label:'Knee', min:0, max:30, val:6, step:1, unit:' dB', rt:true, desc:'How gradually compression eases in around the threshold.', example:'A soft 6 dB knee is gentle and transparent for voice; 0 dB (hard knee) is more obvious and aggressive.' },
    { id:'compMakeup', label:'Makeup', min:0, max:30, val:0, step:0.5, unit:' dB', rt:true, desc:'Volume added back after compression lowers the level.', example:'Add +3 dB so the compressed voice is as loud as before but more consistent and present.' },
    { id:'limThresh', label:'Lim Thresh', min:-12, max:0, val:-1, step:0.5, unit:' dB', rt:true, desc:'Hard ceiling that output peaks can never exceed.', example:'-1 dB prevents clipping/distortion on export; lower to -3 dB for extra safety headroom before encoding.' },
    { id:'limRelease', label:'Lim Release', min:10, max:500, val:50, step:5, unit:' ms', rt:true, desc:'How fast the limiter recovers after catching a peak.', example:'~50 ms is clean for speech; longer values sound smoother on music but can dull transients.' },
  ],
  spec: [
    { id:'hpFreq', label:'HP Freq', min:20, max:2000, val:80, step:1, unit:' Hz', rt:true, desc:'Removes everything below this frequency (a high-pass filter).', example:'80 Hz strips rumble from speech; raise to 300 Hz for a thin telephone/walkie-talkie effect.' },
    { id:'hpQ', label:'HP Q', min:0.1, max:10, val:0.7, step:0.1, unit:'', rt:true, desc:'Sharpness of the high-pass cutoff.', example:'0.7 is a smooth, natural roll-off; higher Q makes the cut steeper with a slight bump at the corner.' },
    { id:'lpFreq', label:'LP Freq', min:4000, max:20000, val:18000, step:100, unit:' Hz', rt:true, desc:'Removes everything above this frequency (a low-pass filter).', example:'18 kHz keeps it natural; drop to 4 kHz to hide hiss or fake an old-radio sound.' },
    { id:'lpQ', label:'LP Q', min:0.1, max:10, val:0.7, step:0.1, unit:'', rt:true, desc:'Sharpness of the low-pass cutoff.', example:'0.7 is gentle; higher Q steepens the cut and adds a resonant edge near the corner frequency.' },
    { id:'deEssFreq', label:'De-ess Freq', min:2000, max:12000, val:6500, step:100, unit:' Hz', rt:true, desc:'Center of the harsh "ess/sh" sibilance the de-esser targets.', example:'~6–7 kHz for most voices; sweep to 7–8 kHz for a bright/sharp speaker whose "s" sounds pierce.' },
    { id:'deEssAmt', label:'De-ess Amt', min:0, max:30, val:5, step:1, unit:' dB', rt:true, desc:'How much the harsh "s" and "sh" sounds are tamed.', example:'~5 dB softens piercing sibilance and high-pitch residue without lisping; 0 leaves it untouched.' },
    { id:'specTilt', label:'Spec Tilt', min:-6, max:6, val:0, step:0.5, unit:' dB', rt:true, desc:'Tilts overall tone darker (−) or brighter (+) in one move.', example:'+2 dB brightens a dull recording; -2 dB warms a harsh one without touching individual EQ bands.' },
    { id:'formantShift', label:'Formant Shift', min:-6, max:6, val:0, step:0.5, unit:' st', rt:false, desc:'Shifts vocal character without changing pitch (semitones).', example:'-2 st makes a voice sound larger/deeper; +2 st sounds smaller/younger — useful for light disguise or tone.' },
  ],
  adv: [
    { id:'derevAmt', label:'Dereverb', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Reduces echo/room reverb so a voice sounds drier and closer.', example:'Set ~50% to pull a voice out of an echoey hall recording; too high can sound thin and gated.' },
    { id:'derevDecay', label:'Rev Decay', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'Tells dereverb how long the room\'s echo tail lasts.', example:'Raise toward 80% for a big, slow church/stairwell echo; lower for a small, fast bathroom slap.' },
    { id:'harmRecov', label:'Harm Recovery', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Rebuilds harmonics lost to heavy noise reduction or low bitrate.', example:'Add ~40% to restore richness to a muffled phone-call or over-denoised voice.' },
    { id:'harmOrder', label:'Harm Order', min:1, max:10, val:3, step:1, unit:'', rt:false, desc:'How many harmonic overtones are reconstructed.', example:'3 is natural for speech; higher orders add more brightness/edge to the recovered tone.' },
    { id:'stereoWidth', label:'Stereo Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'Widens or narrows the stereo image (mid/side).', example:'120% makes music vocals feel wider; 0% collapses to mono for a focused, centered voice.' },
    { id:'phaseCorr', label:'Mono Correlation', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Blends stereo channels toward their shared midpoint for a more mono-stable result; it does not estimate time offset.', example:'Raise to ~40% when a stereo clip sounds hollow after mono summing.' },
  ],
  sep: [
    { id:'voiceIso', label:'Voice Iso', min:0, max:100, val:72, step:1, unit:'%', rt:true, desc:'Rebalances the retained clean stem in Live-Mix after one ML separation.', example:'~70% lifts a speaker out of background music without running ML again.' },
    { id:'bgSuppress', label:'BG Suppress', min:0, max:100, val:38, step:1, unit:'%', rt:true, desc:'Attenuates the retained residual stem in Live-Mix after one ML separation.', example:'Set ~60% to lower street noise and crowd chatter without another ML pass.' },
    { id:'voiceFocusLo', label:'Focus Lo', min:80, max:500, val:100, step:10, unit:' Hz', rt:false, desc:'Bottom edge of the band kept as "voice".', example:'~100–120 Hz suits most voices; raise to 200 Hz to ignore deep rumble, lower for very deep male voices.' },
    { id:'voiceFocusHi', label:'Focus Hi', min:1000, max:8000, val:4200, step:100, unit:' Hz', rt:false, desc:'Top edge of the band kept as "voice" (lower blocks high-pitch residual).', example:'4200 Hz mimics telephone clarity; raise to 5000 Hz to keep crisp consonants and a more natural top.' },
    { id:'crosstalkCancel', label:'Crosstalk', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Removes bleed of one stereo channel into the other.', example:'Use ~40% on a two-mic interview where each voice leaks into the opposite channel.' },
  ],
  out: [
    { id:'outGain', label:'Output Gain', min:-24, max:24, val:0, step:0.5, unit:' dB', rt:true, desc:'Final overall volume trim on the processed output.', example:'Add +3 dB if the cleaned voice is too quiet; the limiter still prevents clipping above its ceiling.' },
    { id:'dryWet', label:'Dry/Wet', min:0, max:100, val:100, step:1, unit:'%', rt:true, desc:'Blends the original (dry) with the processed (wet) signal.', example:'100% is fully processed; drop to 70% to keep a touch of the natural original and soften aggressive cleanup.' },
    { id:'ditherAmt', label:'Dither', min:0, max:3, val:0, step:1, unit:'', rt:false, desc:'Adds encoder-only dither while quantising a 16-bit WAV: 0=off, 1=TPDF, 2=shaped, 3=high-pass.', example:'Leave at 0 for deterministic 16-bit exports; use 1 for a standard TPDF export.' },
    { id:'outWidth', label:'Out Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'Final stereo width applied at the very end of the chain.', example:'100% leaves width unchanged; 0% guarantees a centered mono output for phone playback.' },
  ],
  extreme: [
    { id:'whisperLift', label:'Whisper Lift Gain', min:0, max:40, val:0, step:1, unit:' dB', rt:false, desc:'Process-time post-mask lift where voice confidence is high. The 0–40 dB display maps to a bounded 0–12 dB internal gain.', example:'Start near 10 dB for a buried whisper; Process to hear the result.' },
    { id:'crowdNull', label:'Crowd Null Depth', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Spectral subtraction targeting 200–2500 Hz crowd murmur. Off by default (triggers extreme path).', example:'~88% pulls down stadium chatter while leaving consonants in the 3–4 kHz band.' },
    { id:'bassCrush', label:'Bass Crush (Sub/Kick)', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Process-time attenuation of kick drum and sub bass that mask whisper formants. Off by default.', example:'~95% for nightclub recordings with heavy sub; lower if the whisper has a deep fundamental.' },
    { id:'reverbStrip', label:'Reverb Strip (RT60 Suppressor)', min:0, max:2000, val:0, step:10, unit:' ms', rt:false, desc:'Extreme spectral dereverb by RT60. Prefer Dereverb Amount for standard rooms.', example:'Match to the room — ~900 ms for a reverberant club, ~200 ms for a tight office.' },
    { id:'voiceTunnel', label:'Voice Tunnel (Formant Focus)', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Process-time narrow-band emphasis on speech formants. Off by default.', example:'~78% concentrates energy on vowel formants so a whisper cuts through music.' },
    { id:'musicKill', label:'Music Kill (Harmonic Comb)', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Suppresses steady-state harmonic music while preserving transient speech. Off by default.', example:'~92% when a DJ track is constant under the target whisper.' },
    { id:'snrFloor', label:'SNR Rescue Floor', min:-80, max:-20, val:-52, step:1, unit:' dBFS', rt:false, desc:'Minimum power threshold used by extreme isolation — bins below are treated as noise-only.', example:'Lower toward −58 dBFS to catch quieter whispers; raise if musical noise appears.' },
    { id:'whisperMode', label:'Whisper Mode (Processing Aggression)', min:0, max:3, val:0, step:1, unit:'', rt:false, desc:'Compound processing aggression: Off, Light, Heavy, or Forensic multi-pass. Keep Off when ML isolation succeeds.', example:'Forensic (3) runs four iterative refinement passes for surveillance recovery.' },
    { id:'whisperClarity', label:'Whisper Clarity', min:0, max:100, val:65, step:1, unit:'%', rt:false, desc:'Process-time clarity floor for WhisperHunter gain.', example:'~72% for podcast whispers; ~88% for buried field recordings.' },
    { id:'whisperSensitivity', label:'Whisper Sensitivity', min:0, max:100, val:55, step:1, unit:'%', rt:false, desc:'Process-time energy sensitivity for quiet speech.', example:'~82% in a noisy club; ~28% in a silent room.' },
    { id:'whisperThreshold', label:'Whisper Threshold', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'Process-time WhisperHunter suppression curve steepness.', example:'~35% gentle; ~78% aggressive forensic extraction.' },
    { id:'transientShaper', label:'Transient Shaper', min:-100, max:100, val:0, step:5, unit:'', rt:false, desc:'Process-time bipolar transient emphasis for consonant shaping.', example:'−40 softens plosives; +45 sharpens whisper consonants.' },
    { id:'breathControl', label:'Breath Control', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Attenuates breath noise between whisper phrases. Off by default.', example:'~55% for ASMR-style cleanup; ~85% to strip breaths.' },
    { id:'roomCorrection', label:'Room Correction', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Adds to dereverb for whisper tails. Prefer Dereverb Amount for standard rooms.', example:'~60% for echoey hall; ~90% for deep dereverb.' },
    { id:'subHarmonic', label:'Sub Harmonic', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Process-time sub-harmonic body reinforcement for thin whispers.', example:'~35% adds warmth; ~65% restores chest body.' },
  ],
};

// [WHISPER UPDATE] Maps camelCase slider ids to spec data-param kebab-case ids
const EXTREME_DATA_PARAMS = {
  whisperLift: 'whisper-lift',
  crowdNull: 'crowd-null',
  bassCrush: 'bass-crush',
  reverbStrip: 'reverb-strip',
  voiceTunnel: 'voice-tunnel',
  musicKill: 'music-kill',
  snrFloor: 'snr-floor',
  whisperMode: 'whisper-mode',
  whisperClarity: 'whisper-clarity',
  whisperSensitivity: 'whisper-sensitivity',
  whisperThreshold: 'whisper-threshold',
  transientShaper: 'transient-shaper',
  breathControl: 'breath-control',
  roomCorrection: 'room-correction',
  subHarmonic: 'sub-harmonic',
};

// [WHISPER UPDATE] Whisper mode compound state — drives OSF, mask floor, and pass count
const WHISPER_MODE_STATES = {
  0: { osf: 1.0, gateQ: 0.7, maskFloor: 0.15, postGain: 1.0, passes: 1 },
  1: { osf: 2.5, gateQ: 1.8, maskFloor: 0.08, postGain: 3.2, passes: 2 },
  2: { osf: 4.5, gateQ: 3.5, maskFloor: 0.03, postGain: 8.0, passes: 3 },
  3: { osf: 7.0, gateQ: 6.0, maskFloor: 0.005, postGain: 18.0, passes: 4 },
};
// SLIDER_MAP removed - unused (SLIDER_BY_ID is used instead)

// Flat lookup — prefer SLIDER_REGISTRY (SSOT) for min/max/step/default so clamp,
// presets, and mounted DspSlider rows never drift. Legacy SLIDERS keeps rich copy
// for tests that parse the inline block; ranges overlay from the registry.
const SLIDER_BY_ID = Object.freeze((() => {
  const acc = Object.create(null);
  for (const s of Object.values(SLIDERS).flat()) {
    acc[s.id] = { ...s };
  }
  for (const s of SLIDER_REGISTRY) {
    const prev = acc[s.id] || {};
    acc[s.id] = {
      ...prev,
      id: s.id,
      label: s.label || prev.label,
      min: s.min,
      max: s.max,
      val: s.default,
      step: s.step,
      unit: _formatSliderUnit(s.unit || prev.unit || ''),
      rt: BRIDGE_RT_SLIDER_IDS.has(s.id),
      desc: s.hint || s.tip || prev.desc || '',
      group: s.group || prev.group,
    };
  }
  return acc;
})());

// [WHISPER UPDATE] Build a complete preset from SLIDER defaults + overrides
function _presetDefaults(overrides = {}) {
  const base = { description: '' };
  for (const s of RENDER_SLIDERS) base[s.id] = s.val;
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// 8 calibrated isolation presets (each covers all slider IDs via _presetDefaults)
// Removed as redundant: Phone Wiretap (≈ Phone/Radio), Heavy Rain Call +
// Helicopter Rescue (covered by Surveillance / Stadium Crowd).
// ---------------------------------------------------------------------------
/** Extreme-path OFF — standard isolation uses ML + NR/EQ only (fast path). */
const EXTREME_OFF = {
  whisperLift: 0, crowdNull: 0, bassCrush: 0, reverbStrip: 0, voiceTunnel: 0, musicKill: 0,
  snrFloor: -52, whisperMode: 0,
  whisperClarity: 68, whisperSensitivity: 58, whisperThreshold: 48,
  transientShaper: 0, breathControl: 0, roomCorrection: 0, subHarmonic: 0,
};

/**
 * Canonical presets from src/core/PresetCalibration.js (SSOT).
 * Mutated copies so fill/clamp can complete every slider id safely.
 * Legacy aliases redirect via CALIBRATED_PRESET_REDIRECTS.
 */
const PRESETS = (() => {
  const calibrated = getCalibratedPresets();
  const out = Object.create(null);
  for (const [name, preset] of Object.entries(calibrated)) {
    out[name] = { ...EXTREME_OFF, ...preset };
  }
  for (const [from, to] of Object.entries(CALIBRATED_PRESET_REDIRECTS || {})) {
    if (out[to]) out[from] = out[to];
  }
  // Ensure every preset covers all registry slider IDs (canonical defaults).
  for (const preset of Object.values(out)) {
    for (const s of Object.values(SLIDER_BY_ID)) {
      if (preset[s.id] === undefined) preset[s.id] = s.val;
      else if (Number.isFinite(s.min) && Number.isFinite(s.max) && Number.isFinite(Number(preset[s.id]))) {
        preset[s.id] = Math.min(s.max, Math.max(s.min, Number(preset[s.id])));
      }
    }
  }
  return out;
})();

// PRESET_NAMES removed - unused (Object.keys(PRESETS) can be used directly if needed)

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function structuredLog(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  const debugEnabled = (typeof window !== 'undefined') && !!window.VIP_DEBUG;
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

function clampToSlider(id, value) {
  const reg = SLIDER_REG_BY_ID[id];
  const legacy = SLIDER_BY_ID[id];
  const s = reg || legacy;
  const v = Number(value);
  const fallback = reg ? (reg.default ?? 0) : (legacy ? legacy.val : 0);
  if (!Number.isFinite(v)) return fallback;
  if (!s) return v;
  if (v < s.min) return s.min;
  if (v > s.max) return s.max;
  return v;
}

function numFromInput(el, fallback = 0) {
  if (!el) return fallback;
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
}

function pill(id, state) {
  if (typeof window._setVipEnginePill === 'function') window._setVipEnginePill(id, state);
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// WAV encoder (standalone helper)
// ---------------------------------------------------------------------------
function encodeWavBuffer(audioBuffer, ditherMode = 0) {
  const numCh = audioBuffer.numberOfChannels;
  const numSamples = audioBuffer.length;
  const sr = audioBuffer.sampleRate;
  const bps = 2;
  const buf = new ArrayBuffer(44 + numSamples * numCh * bps);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * numCh * bps, true); v.setUint16(32, numCh * bps, true);
  v.setUint16(34, 16, true); ws(36, 'data'); v.setUint32(40, numSamples * numCh * bps, true);
  let off = 44;
  const mode = Math.max(0, Math.min(3, Math.round(Number(ditherMode) || 0)));
  const previousNoise = new Float32Array(numCh);
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      let s = audioBuffer.getChannelData(ch)[i];
      if (mode > 0) {
        // 1 = TPDF, 2 = shaped, 3 = high-pass-shaped. Dither is injected at
        // the 16-bit quantisation boundary only and never mutates playback PCM.
        const rawNoise = (Math.random() - Math.random()) / 32768;
        const shaped = mode === 1
          ? rawNoise
          : rawNoise - previousNoise[ch] * (mode === 2 ? 0.45 : 0.82);
        previousNoise[ch] = rawNoise;
        s += shaped;
      }
      s = Math.max(-1, Math.min(1, s));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }
  return buf;
}

function downloadWav(audioBuffer, name, ditherMode = 0) {
  const blob = new Blob([encodeWavBuffer(audioBuffer, ditherMode)], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ---------------------------------------------------------------------------
// VoiceIsolatePro — main class
// ---------------------------------------------------------------------------
class VoiceIsolatePro {
  constructor() {
    // Expose STAGES on instance for pipeline overlay
    this.STAGES = STAGES;

    // Abort flag for runPipeline cancellation
    this.abortFlag = false;
    /** Monotonic file generation — stale pipeline results are discarded. */
    this._fileSeq = 0;

    // Live chain state
    this.liveChainBuilt = false;

    // Audio context / chain
    this.ctx = null;
    this.workletNode = null;
    this.sourceNode = null;

    // ML
    this.mlReady = false;
    this._mlCallId = 0;

    // ONNX sessions
    this.onnxSessions = {};
    this._onnxSession = null;
    this._onnxReady = false;
    this._dspOnlyMode = false;

    // State flags
    this.mode = 'idle';
    this._initCalled = false;
    this._ctxReady = false;
    this._workletReady = false;
    this._workletSliderListenersBound = false;
    this._pendingCtxInit = null;
    this.isPlaying = false;
    this.isProcessing = false;
    this.isVideo = false;
    /** @type {File|Blob|null} original upload — retained for video remux export */
    this._sourceFile = null;
    /** @type {string|null} FileLibrary catalog id for the active source */
    this._libraryFileId = null;
    /** @type {number|null} fileSeq for which _cleanStemChannels were produced */
    this._stemFileSeq = null;
    /** @type {string|null} Process-time Engineer snapshot used for retained stems */
    this._stemProcessingRevision = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._sessionPersistTimer = null;
    /** Lazily loaded shared stem module; retained so cancellation never starts a late import. */
    this._stemSeparationModule = null;
    this._stemSeparationModulePromise = null;
    /** @type {string|null} object URL currently assigned to #videoPlayer */
    this._videoObjectUrl = null;

    // Playback state
    this.inputBuffer = null;
    this.outputBuffer = null;
    this.origBuffer = null;
    this.procBuffer = null;
    this.playOffset = 0;
    this.playStartTime = 0;
    this.abMode = 'original';
    this.currentSource = null;

    // Forensic audit log
    this.forensicLog = [];

    // [WHISPER UPDATE] Whisper mode + extreme spectral state
    this.whisperMode = 0;
    this._mlIsolationSucceeded = false;
    this._autoPipelineRun = false;
    this._transportRegionWired = false;
    this._syncTransportRegion = null;
    this._forceSinglePass = false;
    this._extremeFrameIdx = 0;
    this._extremeCircularMag = null;
    this._extremeNoiseProfile = null;
    /** Sliders the user dragged — preserved across auto-calibrate on process. */
    this._userTouchedSliders = new Set();
    /** Sliders locked — never overwritten by preset or auto-calibrate. */
    this._sliderLocks = new Set();
    this._programmaticSliderUpdate = false;
    this._loadSliderLocks();

    // SAB param lane
    this.sharedParams = null;
    this._inputSAB = null;
    this._outputSAB = null;

    // Slider index map (1-indexed: slot 0 = bypass flag)
    this._sliderIndexById = new Map(SLIDER_REGISTRY.map((s, i) => [s.id, i + 1]));

    // Flat params snapshot — mirrors window.VIP_PARAMS, kept in sync by
    // _renderSliders() and applyPreset() so the orchestrator patches work.
    this.params = Object.fromEntries(RENDER_SLIDERS.map((s) => [s.id, s.val]));

    // Model status UI
    this._modelStatusUI = null;
    this._mlWarmupPromise = null;
    this._mlWarmupDone = false;
    this._stopWorkletStatus = null;

    // DOM cache (populated in cacheDom / init)
    this.dom = {};

    // Pre-populate dom if DOM is already available (e.g. in jsdom test environments)
    if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
      try { this.cacheDom(); } catch (_) {}
    }
  }

  // ── Public init ──────────────────────────────────────────────────────────
  async init() {
    if (this._initCalled) return;
    this._initCalled = true;

    this.cacheDom();
    this.initBootSplash();
    try {
      // Yielded on mobile so 50+ slider rows do not freeze WebView before first paint.
      await this._renderSliders();
      this.bindEvents();
      this._initCollapsibleSections();
      fixUploadTouchTargets();
      this._updateProcessButtonsState();
      // Restore lock UI after sliders exist (already applied in _renderSliders; re-sync all).
      for (const id of this._sliderLocks) this._syncSliderLockUi(id);
      HeroExperience.init(this);
      WorkflowTier.init(this);
      // Target-speaker panel (local voiceprint) — non-blocking if module fails.
      try { this._mountTargetSpeakerPanel?.(); } catch (tsErr) {
        structuredLog('warn', '[VIP] target speaker UI mount failed', { err: tsErr?.message });
      }
      // Upload controls are live — do not leave the splash intercepting clicks.
      this._dismissBootSplash();
    } catch (initErr) {
      this._dismissBootSplash();
      structuredLog('error', '[VIP] init failed after splash', { err: initErr.message });
      throw initErr;
    }
    this.initModelStatusPanel();
    this._stopWorkletStatus = startWorkletStatusDriver({ getApp: () => this });

    // Resolve the ML engine pill (CTX/WORKLET/SAB/ML/NET cockpit) based on ONNX Runtime
    // availability — without this, engMlPill stays stuck on "loading" forever since no
    // orchestrator sets window._vipOrch.mlReady or window.VIP_ML_AVAILABLE in this build.
    // We avoid eagerly calling loadModels() here: it would download the 2MB model file on
    // the main thread, which is never used since actual inference runs in MLWorker.js.
    const ort = (typeof window !== 'undefined' && window.ort) || (typeof globalThis !== 'undefined' && globalThis.ort);
    if (ort && ort.InferenceSession) {
      window.VIP_ML_AVAILABLE = true;
      pill('engMlPill', 'ready');
      // Provider not known until MLWorker posts `ready` — leave ORT loading.
      pill('engOrtPill', 'loading');
    } else {
      window.VIP_ML_AVAILABLE = false;
      pill('engMlPill', 'unavailable');
      pill('engOrtPill', 'unavailable');
    }

    // SAB pill — capability is known at boot (COOP/COEP isolation).
    try {
      const sabOk = typeof SharedArrayBuffer !== 'undefined'
        && typeof Atomics !== 'undefined'
        && (typeof self === 'undefined' || self.crossOriginIsolated !== false);
      pill('engSabPill', sabOk ? 'ready' : 'error');
    } catch {
      pill('engSabPill', 'error');
    }

    // Full-audio analysis workspace — installed by analysis-workspace.js module
    // (index.html) via window.__VIP_INSTALL_ANALYSIS_WORKSPACE__ when ready.
    try {
      if (typeof window !== 'undefined' && typeof window.__VIP_INSTALL_ANALYSIS_WORKSPACE__ === 'function') {
        window.__VIP_INSTALL_ANALYSIS_WORKSPACE__(this);
      } else if (typeof window !== 'undefined') {
        window.__VIP_PENDING_ANALYSIS_APP__ = this;
      }
    } catch (wsErr) {
      structuredLog('warn', '[VIP] analysis workspace install failed', { err: wsErr && wsErr.message });
    }

    // Durable library + track state (IDB). UI chrome may use localStorage only.
    try {
      mountFileLibraryUI(this);
      // Versioned cache cleanup (non-blocking)
      void ensureCacheFresh({ pruneOrphans: false }).catch(() => {});
      // Prefer IDB track params after library id known; localStorage is UI fallback only.
      const restored = restoreAppSession(this.params, { applyDom: false });
      if (restored?.params) {
        this.params = { ...this.params, ...restored.params };
        window.VIP_PARAMS = window.VIP_PARAMS || {};
        Object.assign(window.VIP_PARAMS, restored.params);
      }
      this._bindCrashSafeFlush();
      this._restoreLibrarySession().catch((err) => {
        structuredLog('warn', '[VIP] library session restore failed', { err: err?.message });
      });
    } catch (libErr) {
      structuredLog('warn', '[VIP] FileLibrary UI mount failed', { err: libErr?.message });
    }

    // Probe WebGPU availability for ORT status (non-blocking).
    void import('/src/core/OrtStatus.js').then(async (m) => {
      try {
        await m.probeWebGpuAvailable?.();
        const st = m.getOrtStatus?.();
        if (st?.webgpuAvailable) {
          // Prefer WebGPU label until worker confirms
          if (!window.__vipOrtStatus || window.__vipOrtStatus.provider === 'unknown') {
            m.setOrtStatus?.({ provider: 'probing', webgpuAvailable: true });
          }
        }
      } catch { /* ignore */ }
    }).catch(() => {});

    // Lazy AudioContext — requires user gesture (also kicks worklet addModule).
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      const unlock = () => { this.ensureCtx().catch(() => {}); };
      document.addEventListener('pointerdown', unlock, { once: true, passive: true });
      document.addEventListener('click', unlock, { once: true });
      document.addEventListener('keydown', unlock, { once: true });
      document.addEventListener('touchstart', unlock, { once: true, passive: true });
    }

    // ML warmup: never block first paint. Skip entirely on mobile/Android WebView
    // (ONNX compile freezes Engineer Mode instantly). Desktop: idle-only.
    if (this._isMobileEngineer?.()) {
      structuredLog('info', '[VIP] ML warmup deferred until Process on mobile');
    } else {
      const scheduleIdle = globalThis.requestIdleCallback
        ? (cb) => requestIdleCallback(cb, { timeout: 8000 })
        : (cb) => setTimeout(cb, 1200);
      scheduleIdle(() => {
        this._warmupMLModels().catch(() => {});
      });
    }

    window.__vipAppReady = true;
    if (typeof CustomEvent !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('app:ready'));
    }

    if (window._vipOrch && typeof window._vipOrch.connectApp === 'function') {
      window._vipOrch.connectApp(this);
    }
  }

  // ── DOM cache ────────────────────────────────────────────────────────────
  cacheDom() {
    const g = id => document.getElementById(id);
    this.dom = {
      fileInput:g('fileInput'),
      fileBtn:g('fileBtn'),
      dropZone:g('dropZone'),
      uploadZone:g('uploadZone'),
      clearFile:g('clearFile'),
      fileInfo:g('fileInfo'),
      fileLoadIndicator:g('fileLoadIndicator'),
      processBtn:g('processBtn'),
      reprocessBtn:g('reprocessBtn'),
      playBtn:g('playBtn'),
      tpPlay:g('tpPlay'),
      tpPause:g('tpPause'),
      tpStop:g('tpStop'),
      tpRew:g('tpRew'),
      tpFwd:g('tpFwd'),
      tpSeek:g('tpSeek'),
      tpSeekFill:g('tpSeekFill'),
      tpRegionBar:g('tpRegionBar'),
      tpLoop:g('tpLoop'),
      tpCropIn:g('tpCropIn'),
      tpCropOut:g('tpCropOut'),
      tpCropClear:g('tpCropClear'),
      tpAB:g('tpAB'),
      tpABLabel:g('tpABLabel'),
      tpSpeed:g('tpSpeed'),
      tpSpeedDown:g('tpSpeedDown'),
      tpSpeedUp:g('tpSpeedUp'),
      tpCur:g('tpCur'),
      tpDur:g('tpDur'),
      saveOrigBtn:g('saveOrigBtn'),
      saveProcBtn:g('saveProcBtn'),
      openDriveBtn:g('openDriveBtn') || g('openDriveUploadBtn'),
      saveDriveBtn:g('saveDriveBtn'),
      auditLogBtn:g('auditLogBtn'),
      presetSel:g('presetSel'),
      resetSlidersBtn:g('resetSlidersBtn'),
      resetUnlockedBtn:g('resetUnlockedBtn'),
      sliderSearch:g('sliderSearch'),
      sliderSearchClear:g('sliderSearchClear'),
      sliderFilterAll:g('sliderFilterAll'),
      sliderFilterChanged:g('sliderFilterChanged'),
      sliderFilterLocked:g('sliderFilterLocked'),
      sliderFilterStatus:g('sliderFilterStatus'),
      pipeFill:g('pipeFill'),
      pipeBar:g('pipeBar'),
      pipeDetail:g('pipeDetail'),
      videoPlayer:g('videoPlayer'),
      videoCard:g('videoCard'),
      hStatus:g('hStatus'),
      hDur:g('hDur'),
      hSR:g('hSR'),
      hCh:g('hCh'),
      hFile:g('hFile'),
      hPeak:g('hPeak'),
      hRMS:g('hRMS'),
      hVoice:g('hVoice'),
      hNoise:g('hNoise'),
      hSNR:g('hSNR'),
      mobileProcessBtn:g('mobileProcessBtn'),
      mobileReprocessBtn:g('mobileReprocessBtn'),
      mobileStopBtn:g('mobileStopBtn'),
      statsToggle:g('statsToggle'),
      hdrStats:g('hdrStats'),
    };
  }

  /**
   * Collapsible sections:
   *  - defaults: Upload, Processing, active slider family (Noise/Gate) open
   *  - collapsed on small viewports: Waveform/Spectrum + inactive slider tabs
   *  - open/closed state persisted per section id in localStorage
   *  - toggle never triggers re-process or analysis
   */
  /**
   * Collapsible sections — details[open] is the single source of truth.
   * .active is mirrored for legacy CSS only. Never re-runs DSP.
   */
  _initCollapsibleSections() {
    if (typeof document === 'undefined') return;
    const STORAGE_KEY = 'vip.engineer.sectionOpen.v1';
    let stored = {};
    try {
      if (typeof localStorage !== 'undefined') {
        stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
      }
    } catch { stored = {}; }

    const narrow = typeof window !== 'undefined'
      && window.matchMedia
      && window.matchMedia('(max-width: 900px)').matches;
    const mobile = this._isMobileEngineer?.() || false;
    // Mobile/Android: keep rack closed except upload+process — fewer DOM mounts, less freeze.
    const defaultOpen = new Set(
      mobile
        ? ['section-upload', 'section-processing']
        : [
          'section-upload', 'section-presets', 'section-processing',
          'section-gate', 'section-analysis', 'section-separation',
        ],
    );
    if (!narrow && !mobile) defaultOpen.add('vizCard');

    const syncActive = (el) => {
      el.classList.toggle('active', !!el.open);
      const sum = el.querySelector(':scope > summary');
      if (sum) sum.setAttribute('aria-expanded', String(!!el.open));
    };

    const persist = () => {
      try {
        if (typeof localStorage === 'undefined') return;
        const next = {};
        document.querySelectorAll('details.vip-section[id], details.slider-group[id]').forEach((el) => {
          if (el.id) next[el.id] = !!el.open;
        });
        // Also key anonymous slider groups by summary text for restore stability
        document.querySelectorAll('details.slider-group:not([id])').forEach((el, i) => {
          const key = el.dataset.vipSectionKey || `vip-section-anon-${i}`;
          el.dataset.vipSectionKey = key;
          next[key] = !!el.open;
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch { /* private mode */ }
    };

    document.querySelectorAll('details.vip-section, details.slider-group').forEach((el, i) => {
      const id = el.id || '';
      if (!id && !el.dataset.vipSectionKey) {
        el.dataset.vipSectionKey = `vip-section-anon-${i}`;
      }
      const storeKey = id || el.dataset.vipSectionKey;
      if (storeKey && Object.prototype.hasOwnProperty.call(stored, storeKey)) {
        el.open = !!stored[storeKey];
      } else if (defaultOpen.has(id) || el.classList.contains('active')) {
        el.open = true;
      } else if (narrow || id === 'vizCard' || el.classList.contains('slider-group')) {
        if (id === 'vizCard') el.open = !narrow;
        else if (el.classList.contains('slider-group') && !el.classList.contains('active') && !el.hasAttribute('open')) {
          el.open = false;
        }
      }
      syncActive(el);
      // Persist user toggles only — never re-run DSP on collapse/expand.
      if (!el.dataset.vipCollapseWired) {
        el.dataset.vipCollapseWired = '1';
        el.addEventListener('toggle', () => {
          syncActive(el);
          persist();
        });
      }
    });
  }

  // ── Boot splash ──────────────────────────────────────────────────────────
  _dismissBootSplash() {
    const splash = $('bootSplash');
    if (!splash || splash.dataset.dismissed === '1') return;
    splash.dataset.dismissed = '1';
    splash.classList.add('is-complete');
    splash.style.transition = 'opacity 0.4s ease';
    splash.style.opacity = '0';
    splash.style.pointerEvents = 'none';
    splash.setAttribute('aria-hidden', 'true');
    setTimeout(() => { splash.style.display = 'none'; }, 420);
    if (typeof window._vipDismissBootSplash === 'function') window._vipDismissBootSplash();
  }

  initBootSplash() {
    const splash = $('bootSplash');
    const fill = $('bootSplashProgress');
    if (!splash) return;
    let pct = 0;
    const iv = setInterval(() => {
      pct = Math.min(pct + Math.random() * 18 + 4, 100);
      if (fill) fill.style.width = pct + '%';
      if (pct >= 100) {
        clearInterval(iv);
        setTimeout(() => this._dismissBootSplash(), 200);
      }
    }, 80);
  }

  // ── Model status panel ───────────────────────────────────────────────────
  initModelStatusPanel() {
    if (typeof ModelStatusUI !== 'undefined' && ModelStatusUI) {
      try {
        this._modelStatusUI = new ModelStatusUI(
          $('modelStatusPills') || document.body,
          MODEL_STATUS_KEYS,
          { healthContainer: $('cdnHealthPanel') }
        );
        // Ensure same-origin health is probed even if the classic loader script
        // loaded after the first paint (or Electron vip:// cold start).
        if (window.ModelCDNLoader?.probeSameOriginHealth) {
          void window.ModelCDNLoader.probeSameOriginHealth()
            .then(() => this._modelStatusUI?.refreshHealth?.())
            .catch(() => {});
        }
        void this._modelStatusUI.refreshStatus?.().catch?.(() => {});
      } catch (e) {
        structuredLog('warn', '[VIP] ModelStatusUI init failed', { err: e.message });
      }
    }
  }

  // ── Pipeline progress ────────────────────────────────────────────────────
  /**
   * Monotonic progress updates — never regress the bar (prevents "stuck at 55%"
   * when stage events fire after higher progress ticks).
   * @param {number} stageIndex
   * @param {string} detail
   * @param {number} [pct]
   * @param {{ force?: boolean }} [opts]
   */
  updatePipelineProgress(stageIndex, detail, pct, opts = {}) {
    const fill = this.dom.pipeFill || $('pipeFill');
    const bar = this.dom.pipeBar || $('pipeBar');
    const detailEl = this.dom.pipeDetail || $('pipeDetail');
    const badge = $('vip-proc-badge');
    let p = typeof pct === 'number' ? pct : (stageIndex / 32) * 100;
    if (!Number.isFinite(p)) p = 0;
    p = Math.max(0, Math.min(100, p));
    // Reset only on force (new job start / cancel / error).
    if (opts.force) {
      this._pipelinePct = p;
    } else {
      const prev = Number(this._pipelinePct) || 0;
      // Allow reset when going back to idle (0) or completing (100).
      if (p > 0 && p < 100 && p < prev) p = prev;
      this._pipelinePct = p;
    }
    if (fill) fill.style.width = p + '%';
    if (bar) bar.setAttribute('aria-valuenow', String(Math.round(p)));
    if (detailEl) detailEl.textContent = detail || '';
    if (badge) badge.dataset.state = p >= 100 ? 'done' : p > 0 ? 'processing' : 'idle';
    const spinner = badge && badge.querySelector('.vip-pb-spinner');
    if (spinner) spinner.style.display = (p > 0 && p < 100) ? '' : 'none';
    const lbl = badge && badge.querySelector('.vip-pb-label');
    if (lbl) lbl.textContent = detail || (p >= 100 ? 'Done' : 'Ready');
    // Overlay stage index should track percent so UI does not freeze mid-pipeline.
    const stageFromPct = Math.max(0, Math.min(32, Math.round((p / 100) * 32)));
    const stage = Number.isFinite(stageIndex) && stageIndex > 0 ? stageIndex : stageFromPct;
    if (typeof this.updateProcessingOverlay === 'function') {
      this.updateProcessingOverlay(detail || '', p, stage);
    }
    HeroExperience.onPipelineProgress(stage, detail, p);
  }

  /**
   * Weighted stage progress (desktop + mobile).
   * 0–8 decode/prep · 8–82 ML · 82–90 expand · 90–96 residual · 96–99 assemble · 100 ready.
   * Never leave the UI pinned at 88% while post-ML work continues.
   */
  _mapMlProgressPercent(workerPercent) {
    const w = Math.max(0, Math.min(100, Number(workerPercent) || 0));
    return 8 + Math.round(w * 0.74); // 8 → 82
  }

  /** AbortSignal for the active Process job (JobController) or synthetic from abortFlag. */
  _processAbortSignal() {
    try {
      const jobs = globalThis.__VIP_JOBS__;
      const sig = jobs?.getCurrentSignal?.();
      if (sig) return sig;
    } catch { /* ignore */ }
    const app = this;
    return {
      get aborted() { return !!app.abortFlag; },
    };
  }

  _throwIfProcessAborted() {
    if (this.abortFlag) {
      throwIfAborted({ aborted: true });
    }
    throwIfAborted(this._processAbortSignal());
  }

  /** Local-only progress diagnostics (no network). Enable: localStorage vip-debug-progress=1 */
  _logProgressDiag(stage, extra = {}) {
    try {
      const enabled = (typeof localStorage !== 'undefined' && localStorage.getItem('vip-debug-progress') === '1')
        || (typeof globalThis !== 'undefined' && globalThis.VIP_DEBUG_PROGRESS === true);
      if (!enabled) return;
      const jobs = globalThis.__VIP_JOBS__;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!this._progressDiagStages) this._progressDiagStages = Object.create(null);
      const prev = this._progressDiagStages[stage];
      const isEnd = /(?:^|[-_])(?:end|done|complete|ready|error|cancelled)$/i.test(stage)
        || Boolean(extra.end);
      if (!prev && !isEnd) {
        this._progressDiagStages[stage] = { start: now };
      }
      const startAt = prev?.start ?? extra.stageStart ?? null;
      const elapsedMs = startAt != null ? Math.round(now - startAt) : (extra.elapsedMs ?? null);
      if (isEnd && prev) delete this._progressDiagStages[stage];
      let provider = null;
      try {
        provider = globalThis.__vipOrtStatus?.provider
          || globalThis.__VIP_ORT_STATUS__?.provider
          || null;
      } catch { /* ignore */ }
      const payload = {
        t: now,
        jobId: jobs?.getCurrentJobId?.() || null,
        stage,
        stageStart: startAt,
        stageEnd: isEnd ? now : null,
        elapsedMs,
        pct: this._pipelinePct,
        provider,
        abortFlag: Boolean(this.abortFlag),
        abortReason: extra.abortReason
          || (this.abortFlag ? (jobs?.getCurrentAbortReason?.() || 'abortFlag') : null),
        desktop: isDesktopShell(),
        mobile: this._isMobileEngineer?.() || false,
        ...extra,
      };
      console.info('[VIP][progress]', payload); // local diagnostics only (gated above)
    } catch { /* ignore */ }
  }

  /** Sample chunk sizes for cooperative post-ML loops (desktop Electron freezes at 4s chunks). */
  _postMlChunkSamples() {
    if (this._isMobileEngineer?.()) return 24000; // 0.5 s
    if (isDesktopShell()) return 48000; // 1 s — keep Electron renderer painting
    return 48000 * 2; // 2 s browser desktop
  }

  // ── Render static visuals (waveform/spectrogram) — throttled, fingerprint-deduped ─
  renderStaticVisuals(buffer) {
    if (!buffer || typeof buffer.getChannelData !== 'function') return;
    // Skip identical buffer re-renders (major reopen cost).
    const fp = `${buffer.length}|${buffer.sampleRate}|${buffer.numberOfChannels}|${buffer.duration?.toFixed?.(3) || 0}`;
    if (this._lastVisualFp === fp && this._visualsDrawn) return;
    this._lastVisualFp = fp;
    // Coalesce multiple callers in one frame
    if (this._visualRaf) return;
    const mobile = this._isMobileEngineer?.() || false;
    // Mobile: defer heavy spectro until idle — waveform only keeps UI snappy.
    const paint = () => {
      this._visualRaf = 0;
      try {
        if (typeof window.drawWaveform === 'function') {
          window.drawWaveform(buffer);
        }
        if (!mobile && window.VIP_VISUALS && typeof window.VIP_VISUALS.drawStatic === 'function') {
          window.VIP_VISUALS.drawStatic();
        }
        if (!mobile && typeof window.VIP_spectro === 'object' && window.VIP_spectro) {
          window.VIP_spectro.renderStatic(buffer);
        } else if (mobile && typeof window.VIP_spectro === 'object' && window.VIP_spectro) {
          // Lightweight spectro later — never block decode/process
          const idle = globalThis.requestIdleCallback || ((cb) => setTimeout(cb, 200));
          idle(() => {
            try { window.VIP_spectro.renderStatic(buffer); } catch { /* ignore */ }
          });
        }
        if (!mobile) HeroExperience.mirrorWaveCanvases();
        this._visualsDrawn = true;
      } catch (_) { /* ignore visual errors */ }
    };
    this._visualRaf = requestAnimationFrame(paint);
  }

  // ── Audio context ────────────────────────────────────────────────────────
  async ensureCtx() {
    if (this._ctxReady) {
      if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    if (this._pendingCtxInit) return this._pendingCtxInit;

    this._pendingCtxInit = (async () => {
      try {
        this.ctx = this.ctx || new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
        pill('engCtxPill', 'loading');

        if (typeof SharedArrayBuffer !== 'undefined') {
          const sab = new SharedArrayBuffer(256 * Float32Array.BYTES_PER_ELEMENT);
          this.sharedParams = new Float32Array(sab);
          SLIDER_REGISTRY.forEach((s, i) => {
            this.sharedParams[i + 1] = (window.VIP_PARAMS && window.VIP_PARAMS[s.id] !== undefined) ? window.VIP_PARAMS[s.id] : (s.default ?? 0);
          });
          pill('engSabPill', 'ready');
        } else {
          pill('engSabPill', 'error');
        }

        this._ctxReady = true;
        this._workletReady = false;
        pill('engCtxPill', 'ready');

        this._initSABRings();
        this._updateProcessButtonsState();
        structuredLog('info', '[VIP] AudioContext ready.');
      } catch (err) {
        structuredLog('error', '[VIP] AudioContext init failed', { err: err.message });
        this._workletReady = false;
        pill('engCtxPill', 'error');
      } finally {
        this._pendingCtxInit = null;
      }
    })();

    return this._pendingCtxInit;
  }

  // Alias used by some tests
  _ensureAudioCtx() { return this.ensureCtx(); }

  /**
   * Load the Live-Mix bridge and gate/de-esser worklets. Deduped and idempotent.
   * Called only on first playback so no resources are spent before Live-Mix is needed.
   * @returns {Promise<void>}
   */
  async _ensureBridgeAndWorklets() {
    if (this._workletReady) return;
    if (this._pendingWorkletInit) return this._pendingWorkletInit;

    const paintWorkletPills = (st = {}) => {
      const map = (s) => (s === 'loaded' ? 'ready' : s === 'failed' ? 'error' : s === 'bypassed' ? 'unavailable' : 'loading');
      pill('engGatePill', map(st.gate?.state));
      pill('engDeessPill', map(st.deEsser?.state));
      const g = st.gate?.state;
      const d = st.deEsser?.state;
      if (g === 'failed' || d === 'failed') pill('engWorkletPill', 'error');
      else if ((g === 'loaded' || g === 'bypassed') && (d === 'loaded' || d === 'bypassed')) pill('engWorkletPill', 'ready');
      else pill('engWorkletPill', 'loading');
    };

    pill('engWorkletPill', 'loading');
    pill('engGatePill', 'loading');
    pill('engDeessPill', 'loading');

    this._pendingWorkletInit = (async () => {
      try {
        // Resume before worklet modules — suspended contexts flake addModule.
        if (this.ctx?.state === 'suspended') {
          try { await this.ctx.resume(); } catch { /* best-effort */ }
        }
        const bridge = await this._ensureBridge();
        if (this.ctx?.state === 'suspended') {
          try { await this.ctx.resume(); } catch { /* ignore */ }
        }
        if (bridge?.workletsReady) await bridge.workletsReady();
        if (!bridge) {
          this._workletReady = false;
          pill('engWorkletPill', 'error');
          pill('engGatePill', 'error');
          pill('engDeessPill', 'error');
          return;
        }
        const st = bridge.getWorkletStatus?.() || {};
        const gateOk = st.gate?.state === 'loaded' || st.gate?.state === 'bypassed';
        const deOk = st.deEsser?.state === 'loaded' || st.deEsser?.state === 'bypassed';
        this._workletReady = gateOk && deOk;
        paintWorkletPills(st);
        try { globalThis.__vipWorkletStatus = st; } catch { /* ignore */ }
        structuredLog('info', '[VIP] Playback worklets ready', st);
        if (!gateOk || !deOk) {
          structuredLog('warn', '[VIP] One or more worklets did not load', st);
        }
      } catch (wErr) {
        structuredLog('warn', '[VIP] Worklet boot failed (mixer bypass)', { err: wErr?.message });
        this._workletReady = false;
        pill('engWorkletPill', 'error');
        pill('engGatePill', 'error');
        pill('engDeessPill', 'error');
      } finally {
        this._pendingWorkletInit = null;
      }
    })();

    return this._pendingWorkletInit;
  }

  // ── SAB ring buffer init ─────────────────────────────────────────────────
  // Layout must match public/app/dsp-processor.js + ml-worker dual-SAB protocol:
  //   input  = header(20) + mag(HALF_BINS) + pha(HALF_BINS) + pcm(HOP_SIZE)
  //   output = header(20) + mask(HALF_BINS)
  _initSABRings() {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const f32 = Float32Array.BYTES_PER_ELEMENT;
    const inputByteLen = SAB_HEADER_BYTES + (HALF_BINS * 2 + HOP_SIZE) * f32;
    const outputByteLen = SAB_HEADER_BYTES + HALF_BINS * f32;
    const inputSAB = new SharedArrayBuffer(inputByteLen);
    const outputSAB = new SharedArrayBuffer(outputByteLen);
    this._inputSAB = inputSAB;
    this._outputSAB = outputSAB;
    const worker = window._vipOrch && window._vipOrch.mlWorker;
    if (worker) {
      try {
        worker.postMessage({
          type: 'initRingBuffers',
          inputRing: inputSAB,
          maskRing: outputSAB,
          halfN: HALF_BINS,
          hop: HOP_SIZE,
          headerBytes: SAB_HEADER_BYTES,
        }, []);
      } catch { /* worker may not accept transfer list */ }
    }
    // If legacy spectral worklet is mounted, hand SABs via canonical initSAB
    const workletNode = window._vipOrch && window._vipOrch.workletNode;
    if (workletNode?.port) {
      try {
        workletNode.port.postMessage({
          type: 'initSAB',
          inputSAB,
          outputSAB,
          halfN: HALF_BINS,
          hop: HOP_SIZE,
        });
      } catch { /* port closed */ }
      workletNode.port.addEventListener('message', (ev) => {
        if (ev.data && ev.data.type === 'sabReady' && ev.data.inputSAB && ev.data.outputSAB) {
          this._inputSAB = ev.data.inputSAB;
          this._outputSAB = ev.data.outputSAB;
        }
      });
    }
  }

  static get SLIDER_LOCK_STORAGE_KEY() { return 'vip-slider-locks'; }

  _loadSliderLocks() {
    const storages = [];
    if (typeof localStorage !== 'undefined') storages.push(localStorage);
    if (typeof sessionStorage !== 'undefined') storages.push(sessionStorage);
    for (const store of storages) {
      try {
        const raw = store.getItem(VoiceIsolatePro.SLIDER_LOCK_STORAGE_KEY);
        if (!raw) continue;
        const ids = JSON.parse(raw);
        if (Array.isArray(ids)) {
          this._sliderLocks = new Set(ids);
          // Migrate session → local so locks survive reload.
          if (store === sessionStorage && typeof localStorage !== 'undefined') {
            try {
              localStorage.setItem(VoiceIsolatePro.SLIDER_LOCK_STORAGE_KEY, raw);
            } catch (_) { /* ignore */ }
          }
          return;
        }
      } catch (_) { /* ignore corrupt storage */ }
    }
  }

  _persistSliderLocks() {
    const payload = JSON.stringify([...this._sliderLocks]);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(VoiceIsolatePro.SLIDER_LOCK_STORAGE_KEY, payload);
      }
    } catch (_) { /* ignore quota */ }
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(VoiceIsolatePro.SLIDER_LOCK_STORAGE_KEY, payload);
      }
    } catch (_) { /* ignore quota */ }
  }

  _isSliderLocked(id) {
    return this._sliderLocks.has(id);
  }

  _shouldPreserveSlider(id) {
    return this._isSliderLocked(id) || this._userTouchedSliders.has(id);
  }

  /** Inline SVG padlock icons — swapped via CSS on data-locked, not re-rendered. */
  _lockButtonSvgHtml() {
    return [
      '<svg class="lock-icon lock-icon--locked" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">',
      '<path fill="currentColor" d="M17 8h-1V6a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-7-2a2 2 0 1 1 4 0v2h-4V6zm7 14H7V10h10v10zm-5-3a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>',
      '</svg>',
      '<svg class="lock-icon lock-icon--unlocked" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">',
      '<path fill="currentColor" d="M17 8h-1V6a4 4 0 0 0-7.2-2.4l1.4 1.4A2 2 0 0 1 14 6v2H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM7 20V10h10v10H7zm5-3a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>',
      '</svg>',
    ].join('');
  }

  _syncSliderLockUi(id) {
    const row = document.querySelector(`.slider-row[data-slider-id="${id}"], .sr-row[data-slider-id="${id}"]`);
    const btn = row?.querySelector('.slider-lock-btn, .sr-lock-btn');
    if (!row || !btn) return;
    const locked = this._isSliderLocked(id);
    // Both data-locked and class toggles: style.css + slider-theme.css key off both.
    row.dataset.locked = locked ? 'true' : 'false';
    row.classList.toggle('slider-locked', locked);
    row.classList.toggle('is-locked', locked);
    btn.classList.toggle('is-locked', locked);
    btn.setAttribute('aria-pressed', String(locked));
    const labelText = (row.querySelector('.sr-label')?.textContent || id).replace(/\s*RT\s*$/, '').trim() || id;
    btn.setAttribute('aria-label', locked ? `Unlock ${labelText}` : `Lock ${labelText}`);
    btn.title = locked
      ? `Unlock ${labelText} (allow preset/reset changes)`
      : `Lock ${labelText} (ignore preset changes)`;
    if (typeof row._dspSlider?.setLocked === 'function') {
      row._dspSlider.setLocked(locked);
    }
    const input = row.querySelector('input[type="range"]');
    if (input) {
      input.classList.toggle('slider-input-locked', locked);
      // Keep visually present; block pointer interaction only when locked.
      input.style.pointerEvents = locked ? 'none' : '';
      if (locked) input.setAttribute('aria-readonly', 'true');
      else input.removeAttribute('aria-readonly');
      // slider-ticks.css keys off .slider-tick-wrapper.is-locked — keep in sync.
      const tickWrap = input.closest('.slider-tick-wrapper');
      if (tickWrap) {
        tickWrap.classList.toggle('is-locked', locked);
        tickWrap.dataset.locked = locked ? 'true' : 'false';
      }
    }
    const num = row.querySelector('input.dsp-slider-number, input[type="number"].sr-val');
    if (num) {
      num.readOnly = locked;
      num.classList.toggle('slider-input-locked', locked);
      if (locked) num.setAttribute('aria-readonly', 'true');
      else num.removeAttribute('aria-readonly');
    }
    const resetBtn = row.querySelector('.slider-reset-btn');
    if (resetBtn) resetBtn.disabled = locked;
    row.querySelectorAll('.wm-btn').forEach((modeBtn) => {
      modeBtn.disabled = locked;
      modeBtn.setAttribute('aria-disabled', String(locked));
    });
  }

  /**
   * Public lock toggle — flips data-locked, in-memory map, and localStorage.
   * @param {string} sliderId
   * @returns {boolean} new locked state
   */
  toggleSliderLock(sliderId) {
    if (!sliderId) return false;
    if (this._sliderLocks.has(sliderId)) this._sliderLocks.delete(sliderId);
    else this._sliderLocks.add(sliderId);
    this._persistSliderLocks();
    this._syncSliderLockUi(sliderId);
    return this._isSliderLocked(sliderId);
  }

  /** @deprecated use toggleSliderLock */
  _toggleSliderLock(id) {
    return this.toggleSliderLock(id);
  }

  /**
   * Raw UI params → discipline curves + coupling + soft clamps.
   * Never mutates visible slider positions.
   */
  getEffectiveParams(rawParams) {
    const raw = rawParams || window.VIP_PARAMS || this.params || {};
    const stereoHint = this._stereoHintFromBuffers
      ? this._stereoHintFromBuffers()
      : this._computeStereoHint();
    return getEffectiveDspParams(raw, {
      stereoHint,
      debug: typeof globalThis !== 'undefined' && globalThis.VIP_DEBUG_CALIBRATION === true,
    });
  }

  _computeStereoHint() {
    const buf = this.origBuffer || this.inputBuffer;
    if (!buf || typeof buf.numberOfChannels !== 'number' || buf.numberOfChannels < 2) {
      return { stereoActive: false, channelDiff: 0 };
    }
    try {
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      const n = Math.min(L.length, R.length, 48000);
      let lRms = 0;
      let rRms = 0;
      let diff = 0;
      const step = Math.max(1, Math.floor(n / 4000));
      let count = 0;
      for (let i = 0; i < n; i += step) {
        const a = L[i];
        const b = R[i];
        lRms += a * a;
        rRms += b * b;
        diff += Math.abs(a - b);
        count += 1;
      }
      if (!count) return { stereoActive: true, channelDiff: 0, leftRms: 0, rightRms: 0 };
      lRms = Math.sqrt(lRms / count);
      rRms = Math.sqrt(rRms / count);
      const meanDiff = diff / count;
      const scale = Math.max(lRms + rRms, 1e-8);
      return {
        stereoActive: true,
        leftRms: lRms,
        rightRms: rRms,
        channelDiff: Math.max(0, Math.min(1, meanDiff / scale)),
      };
    } catch (_) {
      return { stereoActive: true, channelDiff: 0.3 };
    }
  }

  // ── Slider rendering ─────────────────────────────────────────────────────
  /** Mount the complete 67-control rack, including controls in closed groups. */
  async _renderSliders() {
    const mobile = this._isMobileEngineer?.() || false;
    let rendered = 0;
    for (const s of RENDER_SLIDERS) {
      if (s.id === 'whisperMode') continue; // [WHISPER UPDATE] rendered as button group
      const panelId = this._getSliderPanelId(s.id);
      const panel = panelId ? document.getElementById(panelId) : null;
      const container = panel || document.getElementById('sliderContainer');
      if (!container) continue;

      rendered += 1;
      // Cooperative paint: every ~10 rows on mobile so boot never freezes the tab.
      if (mobile && rendered > 1 && (rendered % 10) === 0) {
        await yieldToBrowser();
      }
      this._appendSliderRow(s, container);
    }
    this._renderWhisperModeGroup();
    const mountedIds = new Set(
      Array.from(document.querySelectorAll('[data-slider-id]'), (row) => row.dataset.sliderId)
    );
    const missing = RENDER_SLIDERS.filter((slider) => !mountedIds.has(slider.id));
    if (missing.length) {
      console.error(
        `[VIP] Engineer control rack incomplete: ${missing.map((slider) => slider.id).join(', ')}`
      );
    }
    this._bindInfoPopoverDismiss();
    this._bindHintDismiss();
  }

  _appendSliderRow(s, container) {
      if (!container || container.querySelector(`[data-slider-id="${s.id}"]`)) return;
      const initVal = (window.VIP_PARAMS && window.VIP_PARAMS[s.id] !== undefined)
        ? window.VIP_PARAMS[s.id]
        : s.val;
      const regEntry = SLIDER_REG_BY_ID[s.id];
      const groupEl = typeof container.closest === 'function'
        ? container.closest('details.slider-group, details.vip-section')
        : null;
      const groupLabel = groupEl?.querySelector('.vip-section-summary')?.childNodes?.[0]?.textContent?.trim()
        || groupEl?.id
        || s.group
        || '';

      const widget = createDspSliderRow({
        spec: {
          id: s.id,
          label: s.label,
          min: s.min,
          max: s.max,
          step: s.step,
          val: s.val,
          default: s.val,
          unit: s.unit || '',
          rt: !!s.rt,
          desc: s.desc || regEntry?.tip || '',
          tip: regEntry?.tip || s.desc || '',
          group: s.group || regEntry?.group,
        },
        value: initVal,
        groupLabel,
        isLocked: () => this._isSliderLocked(s.id),
        onToggleLock: (id) => this.toggleSliderLock(id),
        onReset: (id) => {
          if (this._isSliderLocked(id)) return;
          const spec = SLIDER_BY_ID[id] || SLIDER_REG_BY_ID[id];
          const def = spec?.val != null ? spec.val : (spec?.default ?? s.val);
          this._setSliderUi(id, def, { notify: true, force: false });
          this._userTouchedSliders.delete(id);
          this._applyControlFilters?.();
        },
        onChange: (id, v, meta = {}) => {
          if (this._isSliderLocked(id) && !this._programmaticSliderUpdate) return;
          if (!this._programmaticSliderUpdate && meta.source !== 'programmatic') {
            this._userTouchedSliders.add(id);
          }
          window.VIP_PARAMS = window.VIP_PARAMS || {};
          window.VIP_PARAMS[id] = v;
          this.params[id] = v;
          if (this.sharedParams) {
            const idx = this._sliderIndexById.get(id);
            if (idx !== undefined) this.sharedParams[idx] = v;
          }
          this.onSlider(id, v);
          // Coalesce Live-Mix param storms. Process-time/export controls stay
          // in canonical state until their explicit consumer runs.
          if (BRIDGE_RT_SLIDER_IDS.has(id)) {
            this._pendingLiveParam = this._pendingLiveParam || {};
            this._pendingLiveParam[id] = v;
            if (!this._liveParamRaf) {
              this._liveParamRaf = requestAnimationFrame(() => {
                this._liveParamRaf = 0;
                const batch = this._pendingLiveParam || {};
                this._pendingLiveParam = null;
                for (const [pid, pval] of Object.entries(batch)) {
                  this._applySliderToWorklet(pid, pval);
                }
                this._syncBridgeParams?.();
              });
            }
          }
          this._scheduleSessionPersist();
          if (meta.source !== 'programmatic') this._applyControlFilters?.();
        },
      });

      const { row, range: inputEl } = widget;
      row._dspSlider = widget;
      if (EXTREME_DATA_PARAMS[s.id]) inputEl.dataset.param = EXTREME_DATA_PARAMS[s.id];

      const examples = (regEntry && regEntry.examples && regEntry.examples.length)
        ? regEntry.examples
        : this._defaultSliderExamples(s);
      const hintText = (regEntry && regEntry.hint) ? regEntry.hint : (s.desc || '');
      let hintPanel = null;
      if (hintText) {
        const hintBtn = document.createElement('button');
        hintBtn.type = 'button';
        hintBtn.className = 'slider-hint-btn';
        hintBtn.textContent = 'i';
        hintBtn.setAttribute('aria-label', `Explain ${s.label}`);
        hintBtn.setAttribute('aria-expanded', 'false');
        hintBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const wasOpen = row.classList.contains('hint-open');
          document.querySelectorAll('.slider-row.hint-open').forEach((r) => {
            r.classList.remove('hint-open');
            const b = r.querySelector('.slider-hint-btn');
            if (b) b.setAttribute('aria-expanded', 'false');
          });
          const open = !wasOpen;
          if (open) {
            row.classList.add('hint-open');
            hintBtn.setAttribute('aria-expanded', 'true');
          }
        });

        hintPanel = buildHintPanel({
          id: 'hint_' + s.id,
          text: hintText,
          min: s.min,
          max: s.max,
          value: initVal,
          unit: s.unit || '',
          examples,
          meta: regEntry?.hintMeta || null,
          onApplyExample: (val) => {
            if (this._isSliderLocked(s.id)) return;
            inputEl.value = val;
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          },
        });
        inputEl.setAttribute('aria-describedby', hintPanel.id);
        row.appendChild(hintBtn);
      }
      const infoBtn = document.createElement('button');
      infoBtn.type = 'button';
      infoBtn.className = 'info-btn';
      infoBtn.setAttribute('aria-label', `Examples for ${s.label}`);
      infoBtn.dataset.sliderId = s.id;
      infoBtn.tabIndex = 0;
      infoBtn.textContent = 'ℹ';
      infoBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleInfoPopover(row, s.id, inputEl, examples);
      });
      row.appendChild(infoBtn);
      if (hintPanel) row.appendChild(hintPanel);

      // Index aliases for search (registry + shared dictionary).
      const aliases = [
        ...(regEntry?.aliases || []),
        ...(SLIDER_ALIASES[s.id] || []),
        ...(SLIDER_SEARCH_ALIASES[s.id] || []),
      ];
      row.dataset.searchText = [s.id, s.label, s.desc, regEntry?.tip, regEntry?.hint, groupLabel, ...aliases]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      container.appendChild(row);
      if (this._isSliderLocked(s.id)) this._syncSliderLockUi(s.id);

      window.VIP_PARAMS = window.VIP_PARAMS || {};
      window.VIP_PARAMS[s.id] = initVal;
      this.params[s.id] = initVal;
  }

  /**
   * Apply search query + All/Essentials/Changed/Locked filter chips to Engineer slider rows.
   * Opens parent groups when matches exist; never covers controls with overlays.
   */
  _applyControlFilters() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    const d = this.dom || {};
    const q = (d.sliderSearch?.value || '').trim().toLowerCase();
    const mode = this._sliderFilterMode || 'all';
    const essentialsPanels = new Set(
      (this._essentialsPanels && this._essentialsPanels.length)
        ? this._essentialsPanels
        : ['tab-gate', 'tab-nr', 'tab-out'],
    );
    let visible = 0;
    let total = 0;
    document.querySelectorAll('.sr-row[data-slider-id], .slider-row[data-slider-id]').forEach((row) => {
      const id = row.dataset.sliderId;
      if (!id) return;
      total += 1;
      const locked = this._isSliderLocked(id);
      const changed = this._userTouchedSliders?.has(id)
        || (() => {
          const spec = SLIDER_BY_ID[id] || SLIDER_REG_BY_ID[id];
          if (!spec) return false;
          const def = spec.val != null ? spec.val : spec.default;
          const cur = window.VIP_PARAMS?.[id];
          return cur != null && def != null && Number(cur) !== Number(def);
        })();
      const hay = row.dataset.searchText
        || ((row.querySelector('.sr-label') || {}).textContent || '').toLowerCase();
      const matchesQuery = !q || hay.includes(q)
        || sliderMatchesQuery({
          id,
          label: row.querySelector('.sr-label')?.textContent || id,
          aliases: SLIDER_ALIASES[id] || SLIDER_SEARCH_ALIASES[id] || [],
        }, q);
      let matchesMode = true;
      if (mode === 'locked') matchesMode = locked;
      else if (mode === 'changed') matchesMode = changed;
      else if (mode === 'essentials') {
        const panel = row.closest('.slider-panel')?.id
          || SLIDER_REG_BY_ID[id]?.group
          || '';
        matchesMode = essentialsPanels.has(panel);
      }
      const show = matchesQuery && matchesMode;
      row.hidden = !show;
      row.style.display = show ? '' : 'none';
      if (show) {
        visible += 1;
        const details = row.closest('details.slider-group, details.vip-section');
        if (details && (q || mode === 'essentials')) details.open = true;
      }
    });
    // When filtering, hide empty groups; when clearing, leave open state alone.
    document.querySelectorAll('details.slider-group, details.vip-section').forEach((details) => {
      if (!details.querySelector('.sr-row[data-slider-id], .slider-row[data-slider-id]')) return;
      if (!q && mode === 'all') {
        details.classList.remove('filter-empty');
        return;
      }
      const any = Array.from(details.querySelectorAll('.sr-row[data-slider-id], .slider-row[data-slider-id]'))
        .some((r) => !r.hidden && r.style.display !== 'none');
      details.classList.toggle('filter-empty', !any);
      if (any && (q || mode !== 'all')) details.open = true;
    });
    const status = d.sliderFilterStatus || document.getElementById('sliderFilterStatus');
    if (status) {
      const modeLabel = mode === 'all' ? 'all' : mode;
      status.textContent = q || mode !== 'all'
        ? `Showing ${visible} of ${total} controls (${modeLabel}${q ? `, “${q}”` : ''})`
        : `${total} controls`;
    }
  }

  _bindHintDismiss() {
    if (this._hintDismissBound) return;
    this._hintDismissBound = true;
    const closeAll = () => {
      document.querySelectorAll('.slider-row.hint-open, .whisper-mode-row.hint-open').forEach((r) => {
        r.classList.remove('hint-open');
        const b = r.querySelector('.slider-hint-btn');
        if (b) b.setAttribute('aria-expanded', 'false');
      });
    };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.slider-hint-btn') && !e.target.closest('.slider-hint')) closeAll();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAll();
    });
  }

  /** Fallback usage examples when registry entry has none (legacy sliders). */
  _defaultSliderExamples(s) {
    const lo = s.min;
    const hi = s.max;
    const mid = s.val != null ? s.val : Math.round((lo + hi) / 2);
    const snap = (v) => {
      const step = s.step || 1;
      const snapped = Math.round(v / step) * step;
      return Math.max(lo, Math.min(hi, snapped));
    };
    return [
      { label: 'Light', value: snap(lo + (mid - lo) * 0.35) },
      { label: 'Balanced', value: snap(mid) },
      { label: 'Strong', value: snap(mid + (hi - mid) * 0.65) },
    ];
  }

  // [WHISPER UPDATE] Info popover — examples with Apply links (Part 2)
  _bindInfoPopoverDismiss() {
    if (this._infoDismissBound) return;
    this._infoDismissBound = true;
    const closeAll = () => removeAllInfoPopovers();
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.info-btn') && !e.target.closest('.info-popover')) closeAll();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAll();
    });
  }

  _toggleInfoPopover(row, sliderId, inputEl, examples) {
    const existing = row.querySelector('.info-popover');
    if (existing) { existing.remove(); return; }
    removeAllInfoPopovers();

    const pop = document.createElement('div');
    pop.className = 'info-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Examples for ${sliderId}`);

    const title = document.createElement('div');
    title.className = 'info-popover-title';
    title.textContent = 'Quick presets';
    pop.appendChild(title);

    examples.forEach((ex) => {
      const line = document.createElement('div');
      line.className = 'info-popover-line';
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'info-popover-apply';
      apply.textContent = `${ex.label} → ${ex.value}`;
      apply.addEventListener('click', (ev) => {
        ev.stopPropagation();
        inputEl.value = ex.value;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        removeAllInfoPopovers();
      });
      line.appendChild(apply);
      pop.appendChild(line);
    });

    mountInfoPopover(pop, row);
  }

  // [WHISPER UPDATE] Send calibrated DSP value to worklet (Part 3)
  // Separation sliders: apply discipline curve on UI value before family transform.
  _applySliderToWorklet(id, uiValue) {
    const entry = SLIDER_REG_BY_ID[id];
    if (!entry || !entry.rt || typeof entry.transform !== 'function') return;
    const disciplined = calibrate(id, uiValue);
    const dspVal = entry.transform(disciplined);
    const paramId = entry.workletParam || entry.id;
    const ctx = this.ctx;
    const node = this.workletNode || (window._vipOrch && window._vipOrch.workletNode);
    if (node && node.parameters && typeof node.parameters.get === 'function' && ctx) {
      const param = node.parameters.get(paramId);
      if (param) param.setValueAtTime(dspVal, ctx.currentTime);
    }
    if (node && node.port) {
      node.port.postMessage({ type: 'param', id: paramId, value: dspVal });
    }
  }

  // [WHISPER UPDATE] Render whisper-mode 4-button toggle group in EXTREME tab
  _renderWhisperModeGroup() {
    const panel = document.getElementById('tab-extreme');
    if (!panel || panel.querySelector('.whisper-mode-group')) return;

    const spec = SLIDER_BY_ID.whisperMode;
    const initMode = (window.VIP_PARAMS && window.VIP_PARAMS.whisperMode !== undefined)
      ? window.VIP_PARAMS.whisperMode : (spec ? spec.val : 0);

    const row = document.createElement('div');
    row.className = 'sr-row whisper-mode-row';
    row.dataset.sliderId = 'whisperMode';

    const labelEl = document.createElement('label');
    labelEl.className = 'sr-label';
    labelEl.textContent = spec ? spec.label : 'Whisper Mode';

    const group = document.createElement('div');
    group.className = 'whisper-mode-group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Whisper processing aggression');

    const modes = [
      { id: 0, label: 'OFF' },
      { id: 1, label: 'LIGHT' },
      { id: 2, label: 'HEAVY' },
      { id: 3, label: 'FORENSIC' },
    ];

    modes.forEach((m) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wm-btn' + (m.id === initMode ? ' active' : '');
      btn.dataset.mode = String(m.id);
      btn.dataset.param = 'whisper-mode';
      btn.textContent = m.label;
      btn.setAttribute('aria-pressed', String(m.id === initMode));
      btn.addEventListener('click', () => {
        if (this._isSliderLocked('whisperMode')) return;
        this._setWhisperMode(m.id);
        this._applyControlFilters?.();
      });
      group.appendChild(btn);
    });

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'slider-reset-btn whisper-mode-reset';
    resetBtn.innerHTML = '<span aria-hidden="true">↺</span>';
    resetBtn.setAttribute('aria-label', 'Reset Whisper Mode to Off');
    resetBtn.title = 'Reset Whisper Mode to Off';
    resetBtn.addEventListener('click', () => {
      if (this._isSliderLocked('whisperMode')) return;
      this._setWhisperMode(0);
      this._userTouchedSliders.delete('whisperMode');
      this._applyControlFilters?.();
    });

    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'slider-lock-btn';
    lockBtn.setAttribute('aria-pressed', 'false');
    lockBtn.setAttribute('aria-label', 'Lock Whisper Mode');
    lockBtn.title = 'Lock Whisper Mode (ignore preset and reset changes)';
    lockBtn.innerHTML = this._lockButtonSvgHtml();
    lockBtn.addEventListener('click', () => this.toggleSliderLock('whisperMode'));

    row.appendChild(labelEl);
    row.appendChild(group);
    row.appendChild(resetBtn);
    row.appendChild(lockBtn);

    const wmReg = SLIDER_REG_BY_ID.whisperMode;
    if (wmReg && wmReg.hint) {
      const hintBtn = document.createElement('button');
      hintBtn.type = 'button';
      hintBtn.className = 'slider-hint-btn';
      hintBtn.textContent = 'i';
      hintBtn.setAttribute('aria-label', 'Explain Whisper Mode');
      hintBtn.setAttribute('aria-expanded', 'false');
      hintBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const open = row.classList.toggle('hint-open');
        hintBtn.setAttribute('aria-expanded', String(open));
      });
      const hintPanel = buildHintPanel({
        text: wmReg.hint,
        min: wmReg.min,
        max: wmReg.max,
        value: initMode,
        unit: '',
      });
      row.appendChild(hintBtn);
      row.appendChild(hintPanel);
    }

    panel.insertBefore(row, panel.firstChild);
    this._setWhisperMode(initMode, { persist: false });
    this._syncSliderLockUi('whisperMode');
  }

  _getSliderPanelId(sliderId) {
    const entry = SLIDER_REG_BY_ID[sliderId];
    return entry?.group || null;
  }

  onSlider(id, value) {
    // Real-time path: route the slider straight to the Live-Mix bridge. When
    // the bridge handles it, the change is an immediate AudioParam update — no
    // Reprocess, no ML re-run (CLAUDE.md §1). Separation→isolation: voiceIso /
    // bgSuppress rebalance clean/noise stems only. Unsupported ids (spectral/
    // worker effects) fall through and still apply on the next Reprocess.
    //
    // rAF-coalesce rapid drag events so we never queue redundant worklet/
    // bridge recalcs mid-frame (calibration pipeline safety).

    // If the bridge is still initializing, wait for it so early slider moves are
    // not dropped (race where sliders fire before async _ensureBridge resolves).
    if (!this._bridge && this._bridgePromise) {
      this._bridgePromise.then(() => this.onSlider(id, value)).catch(() => {});
      return;
    }

    this._pendingSliderParams = this._pendingSliderParams || Object.create(null);
    this._pendingSliderParams[id] = value;
    if (this._sliderFlushRaf) return;
    const flush = () => {
      this._sliderFlushRaf = 0;
      const batch = this._pendingSliderParams || {};
      this._pendingSliderParams = Object.create(null);
      for (const [sid, sval] of Object.entries(batch)) {
        this._applySliderImmediate(sid, sval);
      }
    };
    if (typeof requestAnimationFrame === 'function') {
      this._sliderFlushRaf = requestAnimationFrame(flush);
    } else {
      this._sliderFlushRaf = setTimeout(flush, 0);
    }
  }

  /** Immediate Live-Mix / worklet application (one id). Called from rAF flush. */
  _applySliderImmediate(id, value) {
    if (!BRIDGE_RT_SLIDER_IDS.has(id)) return;
    if (this._bridge && typeof this._bridge.applyParam === 'function') {
      try {
        // Calibrate separation-family ids so extreme isolation never NaNs gains
        let v = value;
        if (id === 'voiceIso' || id === 'bgSuppress') {
          try {
            const eff = this.getEffectiveParams({ ...(window.VIP_PARAMS || {}), [id]: value });
            if (eff && Number.isFinite(eff[id])) v = eff[id];
          } catch { /* use raw */ }
        }
        if (this._bridge.applyParam(id, v)) return;
      } catch {
        /* fall through to legacy handling */
      }
    }

    const orch = typeof window !== 'undefined' ? window._vipOrch : null;
    if (id === 'outGain' && this._outGainNode && this.currentSource && this.ctx) {
      const gain = Math.pow(10, value / 20);
      this._outGainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
    }
    if (id === 'outWidth' && this.isPlaying) {
      const speed = numFromInput(this.dom && this.dom.tpSpeed, 1) || 1;
      if (this.ctx) {
        this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
      }
      const buf = this.abMode === 'processed'
        ? (this.outputBuffer || this.procBuffer || this.inputBuffer || this.origBuffer)
        : (this.inputBuffer || this.origBuffer);
      if (buf) this.playOffset = Math.max(0, Math.min(buf.duration, this.playOffset));
      this.play();
    }
    this._applySliderToWorklet(id, value);

    if (orch && typeof orch.onSlider === 'function') {
      orch.onSlider(id, value);
    }
  }

  /**
   * Mount target-speaker enrollment UI (local mel voiceprint; no network).
   * Applies soft gain isolation to the processed/clean stem after Process.
   */
  async _mountTargetSpeakerPanel() {
    const host = typeof document !== 'undefined'
      ? document.getElementById('targetSpeakerPanel')
      : null;
    if (!host || this._targetSpeakerUi) return;
    const { mountTargetSpeakerUI } = await import('/src/presentation/TargetSpeakerUI.js');
    this._targetSpeakerUi = mountTargetSpeakerUI({
      container: host,
      getAudio: () => {
        const buf = this.outputBuffer || this.procBuffer || this.origBuffer || this.inputBuffer;
        if (!buf) return null;
        const channelData = [];
        for (let c = 0; c < buf.numberOfChannels; c++) {
          channelData.push(buf.getChannelData(c));
        }
        return { channelData, sampleRate: buf.sampleRate };
      },
      getDiarizationSegments: () => {
        // Prefer PlaybackMixer speaker segments; fall back to last diarization result.
        try {
          const fromMixer = this._bridge?.mixer?._segments || this._playbackMixer?._segments;
          if (Array.isArray(fromMixer) && fromMixer.length) return fromMixer;
        } catch { /* ignore */ }
        return this._lastDiarizationSegments || null;
      },
      getDurationSec: () => {
        const buf = this.outputBuffer || this.procBuffer || this.origBuffer || this.inputBuffer;
        if (buf?.duration) return buf.duration;
        if (buf?.length && buf.sampleRate) return buf.length / buf.sampleRate;
        try {
          const d = this._bridge?.duration?.() ?? this._playbackMixer?.duration?.();
          if (Number.isFinite(d) && d > 0) return d;
        } catch { /* ignore */ }
        return null;
      },
      getPlayheadSec: () => {
        try {
          const t = this._bridge?.currentTime?.()
            ?? this._playbackMixer?.currentTime?.()
            ?? this.currentTime?.();
          if (Number.isFinite(t)) return t;
        } catch { /* ignore */ }
        return null;
      },
      onIsolated: async (channels, sampleRate) => {
        await this.ensureCtx();
        const out = this.ctx.createBuffer(channels.length, channels[0].length, sampleRate);
        for (let c = 0; c < channels.length; c++) out.copyToChannel(channels[c], c);
        this.outputBuffer = out;
        this.procBuffer = out;
        this._setProcessedPlaybackMode?.();
        this._updateProcessButtonsState?.();
      },
      notify: (msg, kind) => this.showNotification?.(msg, kind || 'info'),
    });
  }

  // ── Event binding ────────────────────────────────────────────────────────
  bindEvents() {
    const d = this.dom;
    if (d.fileInput?.setAttribute) d.fileInput.setAttribute('accept', getFileInputAccept());

    // Helper: safe addEventListener
    const bind = (name, el, event, fn) => {
      if (el) el.addEventListener(event, fn);
    };

    // Safe querySelectorAll — returns empty array when document is a partial mock
    const qsa = (sel) => {
      if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') return document.querySelectorAll(sel);
      return [];
    };

    const openFilePicker = async () => {
      if (isDesktopShell()) {
        try {
          const file = await pickAudioFile();
          if (file) await this.handleFile(file);
        } catch (err) {
          structuredLog('error', '[VIP] desktop open failed', { err: err?.message });
          this.showNotification(err?.message || 'Could not open file', 'error');
        }
        return;
      }
      if (!triggerFileInput(this.dom.fileInput)) {
        structuredLog('warn', '[VIP] file input unavailable for picker');
        this.showNotification('Upload control unavailable — refresh the page', 'warn');
        return;
      }
      primeAudioGesture().catch(() => {});
    };
    // Prime Web Audio inside the browse gesture (label or programmatic picker).
    bind('fileInput', d.fileInput, 'click', () => { primeAudioGesture().catch(() => {}); });
    // fileBtn is a <label for="fileInput"> — native picker; only wire JS fallback for legacy buttons.
    const browseIsLabel = d.fileBtn?.tagName === 'LABEL'
      && (d.fileBtn.htmlFor === 'fileInput' || d.fileBtn.getAttribute('for') === 'fileInput');
    if (!browseIsLabel) {
      bind('fileBtn', d.fileBtn, 'click', (e) => { e.preventDefault(); openFilePicker(); });
    }
    if (d.uploadZone) {
      d.uploadZone.addEventListener('click', (e) => {
        if (e.target.closest('#fileBtn')) return;
        openFilePicker();
      });
      d.uploadZone.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFilePicker(); }
      });
    }
    const acceptUpload = (file) => {
      if (!file) return;
      Promise.resolve(this.handleFile(file)).catch((err) => {
        structuredLog('error', '[VIP] handleFile failed', { err: err?.message });
        this.showNotification?.(err?.message || 'Upload failed — try WAV or MP3', 'error');
        this.setStatus?.('ERROR');
      });
    };
    bind('fileInput', d.fileInput, 'change', (e) => acceptUpload(e.target?.files?.[0]));
    if (d.dropZone) {
      d.dropZone.addEventListener('dragover', e => { e.preventDefault(); d.dropZone.classList.add('drag-over'); });
      d.dropZone.addEventListener('dragleave', () => d.dropZone.classList.remove('drag-over'));
      d.dropZone.addEventListener('drop', e => {
        e.preventDefault();
        d.dropZone.classList.remove('drag-over');
        acceptUpload(e.dataTransfer?.files?.[0]);
      });
    }
    // Engineer upload zone (id=uploadZone) also drops files.
    if (d.uploadZone && d.uploadZone !== d.dropZone) {
      d.uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        d.uploadZone.classList.add('drag-over');
      });
      d.uploadZone.addEventListener('dragleave', () => d.uploadZone.classList.remove('drag-over'));
      d.uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        d.uploadZone.classList.remove('drag-over');
        acceptUpload(e.dataTransfer?.files?.[0]);
      });
    }
    bind('clearFile', d.clearFile, 'click', () => { if (this.inputBuffer && !confirm('Are you sure you want to clear the current file? Unsaved processed audio will be lost.')) return; this._clearFile(); });
    bind('clearLocalDataBtn', document.getElementById('clearLocalDataBtn'), 'click', () => {
      this._clearAllLocalData?.();
    });

    // Process buttons
    bind('processBtn', d.processBtn, 'click', () => this.runPipeline());
    bind('reprocessBtn', d.reprocessBtn, 'click', () => this.runPipeline());

    // Mobile action bar
    if (this.dom.mobileProcessBtn) {
      this.dom.mobileProcessBtn.addEventListener('click', () => this.runPipeline());
    }
    if (this.dom.mobileReprocessBtn) {
      this.dom.mobileReprocessBtn.addEventListener('click', () => this.runPipeline());
    }
    if (this.dom.mobileStopBtn) {
      this.dom.mobileStopBtn.addEventListener('click', () => {
        this.abortFlag = true;
        if (typeof this.cancelActiveJobs === 'function') this.cancelActiveJobs();
      });
    }
    if (this.dom.statsToggle && this.dom.hdrStats) {
      this.dom.statsToggle.addEventListener('click', () => {
        const expanded = this.dom.hdrStats.classList.toggle('expanded');
        this.dom.statsToggle.setAttribute('aria-expanded', String(expanded));
        this.dom.statsToggle.textContent = expanded ? '▲' : '▼';
      });
    }

    // Transport
    bind('playBtn', this.dom.playBtn, 'click', () => { this.togglePlayback(); });
    bind('tpPlay', d.tpPlay, 'click', () => { this.togglePlayback(); });
    bind('tpPause', d.tpPause, 'click', () => this.pause());
    bind('tpStop', d.tpStop, 'click', () => this.stop());
    bind('tpRew', d.tpRew, 'click', () => this.seekDelta(-10));
    bind('tpFwd', d.tpFwd, 'click', () => this.seekDelta(10));
    if (d.tpSeek) {
      d.tpSeek.addEventListener('mousedown', () => {
        if (this._fixTransportPatched) return;
        this._transportSeeking = true;
      });
      d.tpSeek.addEventListener('touchstart', () => {
        if (this._fixTransportPatched) return;
        this._transportSeeking = true;
      }, { passive: true });
      d.tpSeek.addEventListener('input', (e) => {
        if (this._fixTransportPatched) return;
        const frac = parseFloat(e.target.value) / 1000;
        const dur = this._getTransportDuration();
        const off = frac * dur;
        this.playOffset = off;
        this._paintTransport(off, dur, { skipSeekValue: true });
      });
      d.tpSeek.addEventListener('change', (e) => {
        if (this._fixTransportPatched) return;
        this._transportSeeking = false;
        this.seekTo(parseFloat(e.target.value) / 1000);
      });
    }

    const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    bind('tpSpeed', d.tpSpeed, 'change', () => {
      if (this.currentSource) this.currentSource.playbackRate.value = numFromInput(d.tpSpeed, 1);
    });
    bind('tpSpeedDown', d.tpSpeedDown, 'click', () => {
      if (!d.tpSpeed) return;
      const cur = numFromInput(d.tpSpeed, 1);
      const idx = SPEEDS.indexOf(cur);
      if (idx > 0) { d.tpSpeed.value = SPEEDS[idx - 1]; d.tpSpeed.dispatchEvent(new Event('change')); }
    });
    bind('tpSpeedUp', d.tpSpeedUp, 'click', () => {
      if (!d.tpSpeed) return;
      const cur = numFromInput(d.tpSpeed, 1);
      const idx = SPEEDS.indexOf(cur);
      if (idx < SPEEDS.length - 1) { d.tpSpeed.value = SPEEDS[idx + 1]; d.tpSpeed.dispatchEvent(new Event('change')); }
    });

    // PATCHED BY vip-fixes.js — consider merging
    // A/B toggle
    bind('tpAB', d.tpAB, 'click', () => this.toggleAB());
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('keydown', e => this._handleGlobalKeydown(e));
    }

    // Save buttons
    bind('saveOrigBtn', d.saveOrigBtn, 'click', async () => {
      if (!(this.origBuffer || this.inputBuffer) && (this._sourceFile || this._libraryFileId)) {
        await this.ensureDecoded();
      }
      if (this.origBuffer || this.inputBuffer) {
        downloadWav(this.origBuffer || this.inputBuffer, 'original-' + Date.now() + '.wav');
      } else {
        this.showNotification('Nothing to save yet — load and decode a file first.', 'info');
      }
    });
    bind('saveProcBtn', d.saveProcBtn, 'click', async () => {
      await this._downloadProcessed();
    });
    const openDriveEl = d.openDriveBtn || $('openDriveBtn') || $('openDriveUploadBtn');
    if (openDriveEl) {
      openDriveEl.addEventListener('click', () => {
        this._openFromGoogleDrive().catch((err) => {
          if (err?.code === 'CANCELLED') return;
          this.showNotification(err?.message || 'Google Drive open failed', 'error');
        });
      });
    }
    const saveDriveEl = d.saveDriveBtn || $('saveDriveBtn');
    if (saveDriveEl) {
      saveDriveEl.addEventListener('click', () => {
        this._saveProcessedToGoogleDrive().catch((err) => {
          if (err?.code === 'CANCELLED') return;
          this.showNotification(err?.message || 'Google Drive save failed', 'error');
        });
      });
    }
    bind('auditLogBtn', d.auditLogBtn, 'click', () => this.downloadAuditLog());

    // PATCHED BY vip-fixes.js — consider merging
    // Preset selector
    bind('presetSel', d.presetSel, 'change', e => this.applyPreset(e.target.value));
    qsa('.btn-preset').forEach(b => {
      b.addEventListener('click', () => this.applyPreset(b.dataset.preset));
    });

    // Reset sliders — locked rows preserved unless user chooses "reset unlocked only"
    // then "reset all" (explicit second path via confirm).
    bind('resetSlidersBtn', d.resetSlidersBtn, 'click', () => {
      const unlockedOnly = confirm(
        'Reset unlocked controls to defaults?\n\nOK = Reset unlocked only (locked sliders stay)\nCancel = ask about full reset',
      );
      if (unlockedOnly) {
        this._resetSliders({ unlockedOnly: true });
        return;
      }
      const resetAll = confirm('Reset ALL controls including locked sliders?');
      if (!resetAll) return;
      this._resetSliders({ unlockedOnly: false });
    });
    bind('resetUnlockedBtn', d.resetUnlockedBtn || $('resetUnlockedBtn'), 'click', () => {
      this._resetSliders({ unlockedOnly: true });
    });

    // [WHISPER UPDATE] WhisperHunter AI auto-processing
    bind('btnWhisperHunter', document.getElementById('btn-whisper-hunter'), 'click', async () => {
      if (!this.inputBuffer && !this.origBuffer && !this._sourceFile && !this._libraryFileId) {
        this.showNotification('Load an audio file first', 'warn');
        return;
      }
      if (WHISPER_HUNTER._running) {
        this.showNotification('WhisperHunter is already running', 'warn');
        return;
      }
      const btn = document.getElementById('btn-whisper-hunter');
      if (btn) {
        btn.classList.add('running');
        btn.setAttribute('aria-busy', 'true');
        btn.disabled = true;
      }
      try {
        // ensureDecoded runs inside WHISPER_HUNTER when buffers are not ready yet
        await WHISPER_HUNTER.run(this.inputBuffer || this.origBuffer, this);
      } catch (err) {
        structuredLog('error', '[WHISPER_HUNTER] run failed', { err: err && err.message });
        this.showNotification('WhisperHunter failed — try again or reduce file length', 'error');
      } finally {
        if (btn) {
          btn.classList.remove('running');
          btn.removeAttribute('aria-busy');
          btn.disabled = false;
        }
      }
    });

    // Control search + All / Essentials / Changed / Locked filter chips
    this._sliderFilterMode = 'all';
    this._essentialsPanels = ['tab-gate', 'tab-nr', 'tab-out'];
    const setFilterMode = (mode) => {
      this._sliderFilterMode = mode || 'all';
      const chips = [
        [d.sliderFilterAll || $('sliderFilterAll'), 'all'],
        [d.sliderFilterEssentials || $('sliderFilterEssentials'), 'essentials'],
        [d.sliderFilterChanged || $('sliderFilterChanged'), 'changed'],
        [d.sliderFilterLocked || $('sliderFilterLocked'), 'locked'],
      ];
      chips.forEach(([el, m]) => {
        if (!el) return;
        const on = m === this._sliderFilterMode;
        el.setAttribute('aria-pressed', String(on));
        el.classList.toggle('is-active', on);
      });
      this._applyControlFilters();
    };
    this._setSliderFilterMode = setFilterMode;
    bind('sliderSearch', d.sliderSearch, 'input', () => this._applyControlFilters());
    bind('sliderSearchClear', d.sliderSearchClear || $('sliderSearchClear'), 'click', () => {
      if (d.sliderSearch) d.sliderSearch.value = '';
      const clearBtn = d.sliderSearchClear || $('sliderSearchClear');
      if (d.sliderSearch) d.sliderSearch.focus();
      if (clearBtn) clearBtn.blur();
      this._applyControlFilters();
    });
    bind('sliderFilterAll', d.sliderFilterAll || $('sliderFilterAll'), 'click', () => setFilterMode('all'));
    bind('sliderFilterEssentials', d.sliderFilterEssentials || $('sliderFilterEssentials'), 'click', () => setFilterMode('essentials'));
    bind('sliderFilterChanged', d.sliderFilterChanged || $('sliderFilterChanged'), 'click', () => setFilterMode('changed'));
    bind('sliderFilterLocked', d.sliderFilterLocked || $('sliderFilterLocked'), 'click', () => setFilterMode('locked'));
    // Every Engineer workflow defaults to the complete rack. Reduced views are
    // explicit user choices through the filter chips, never platform defaults.
    try {
      const tierMode = WorkflowTier.getConfig?.()?.defaultFilterMode || 'all';
      setFilterMode(tierMode);
    } catch {
      setFilterMode('all');
    }
    window.addEventListener('vip:tierChanged', (ev) => {
      const mode = ev?.detail?.defaultFilterMode;
      if (mode && typeof this._setSliderFilterMode === 'function') {
        this._setSliderFilterMode(mode);
      }
    });

    // Per-group "Reset unlocked in group" actions
    qsa('[data-reset-group]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const groupId = btn.getAttribute('data-reset-group');
        this._resetSliderGroup(groupId, { unlockedOnly: true });
      });
    });

    // Viz tabs, Show All, and fullscreen — owned by visuals-bootstrap.js (VIP_VISUALS.wireChrome).
    if (window.VIP_VISUALS && typeof window.VIP_VISUALS.wireChrome === 'function') {
      window.VIP_VISUALS.wireChrome();
    }

    // UI scale controls
    let uiScale = 1;
    bind('uiScaleDn', $('uiScaleDn'), 'click', () => {
      uiScale = Math.max(0.7, uiScale - 0.05);
      if (document.body) document.body.style.zoom = uiScale;
      const v = $('uiScaleVal'); if (v) v.textContent = Math.round(uiScale * 100) + '%';
    });
    bind('uiScaleUp', $('uiScaleUp'), 'click', () => {
      uiScale = Math.min(1.4, uiScale + 0.05);
      if (document.body) document.body.style.zoom = uiScale;
      const v = $('uiScaleVal'); if (v) v.textContent = Math.round(uiScale * 100) + '%';
    });

    // Custom preset modal
    const _handlePresetModalKeydown = (e) => {
      const modal = $('customPresetModal');
      if (!modal || modal.style.display === 'none') return;

      if (e.key === 'Escape') {
        const closeBtn = $('closePresetModal');
        if (closeBtn) closeBtn.click();
      } else if (e.key === 'Enter') {
        // Only trigger Enter if we are in the input, to avoid conflicting with button interactions
        if (e.target && e.target.id === 'customPresetName') {
          const saveBtn = $('saveCustomPresetBtn');
          if (saveBtn) saveBtn.click();
        }
      }
    };

    bind('openPresetModalBtn', $('openPresetModalBtn'), 'click', () => {
      const modal = $('customPresetModal');
      if (modal) {
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');

        // Auto-focus input on open
        const input = $('customPresetName');
        if (input) {
          // Delay focus slightly to ensure modal is visible
          setTimeout(() => input.focus(), 10);
        }

        document.addEventListener('keydown', _handlePresetModalKeydown);
      }
    });

    bind('closePresetModal', $('closePresetModal'), 'click', () => {
      const modal = $('customPresetModal');
      if (modal) {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');

        document.removeEventListener('keydown', _handlePresetModalKeydown);

        // Return focus to trigger
        const trigger = $('openPresetModalBtn');
        if (trigger) trigger.focus();
      }
    });

    // Also remove the keydown listener when save is clicked (assuming save handles its own close/hide logic if any, but since we are handling keydown, we should also intercept save button directly to remove listener)
    bind('saveCustomPresetBtn', $('saveCustomPresetBtn'), 'click', () => {
      document.removeEventListener('keydown', _handlePresetModalKeydown);
      // Wait a tick then return focus to the trigger if modal is closed (in case save logic closes it)
      setTimeout(() => {
        const modal = $('customPresetModal');
        if (modal && modal.style.display === 'none') {
          const trigger = $('openPresetModalBtn');
          if (trigger) trigger.focus();
        }
      }, 50);
    });

    // Forensic toggle
    bind('forensicToggle', $('forensicToggle'), 'click', () => {
      try {
        if (typeof WorkflowTier?.setTier === 'function') {
          WorkflowTier.setTier('forensic');
          this.showNotification('Forensic tier active — full engineer panel.', 'ok');
        } else {
          this.showNotification('Forensic mode: use the Forensic tier pill above.', 'info');
        }
      } catch {
        this.showNotification('Forensic mode: use the Forensic tier pill above.', 'info');
      }
    });
  }

  // ── Global keyboard shortcuts ────────────────────────────────────────────
  _handleGlobalKeydown(e) {
    const target = e.target;
    if (!target) return;

    const tag = target.tagName;
    const contentEditable = target.isContentEditable;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || contentEditable;

    // Do not intercept if interacting with a button or a tablist component
    const inButtonOrTab = tag === 'BUTTON' || (typeof target.closest === 'function' && target.closest('[role="tablist"]'));

    if (inInput || inButtonOrTab) return;

    if ((e.key === ' ' || e.key === 'k' || e.key === 'K') && (this.inputBuffer || this.origBuffer)) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (this._fixTransportPatched) return;
      e.preventDefault();
      this.togglePlayback();
      return;
    }
    if (e.key === 'Escape') {
      if (this.isProcessing) {
        if (typeof this.cancelActiveJobs === 'function') this.cancelActiveJobs();
        else this.abortFlag = true;
      } else {
        this.stop();
      }
      return;
    }
    if (e.key === 'x' || e.key === 'X') {
      if (this._fixABPatched) return;
      if (!(this.outputBuffer || this.procBuffer)) return;
      if (this.dom && this.dom.tpAB && this.dom.tpAB.disabled) return;
      this.toggleAB();
      return;
    }
    if (e.key === 'ArrowLeft') { this.seekDelta(-5); return; }
    if (e.key === 'ArrowRight') { this.seekDelta(5); return; }
    if (e.key === 'l' || e.key === 'L') {
      const mixer = this._getTransportMixer();
      if (mixer) {
        mixer.setLoop(!mixer.isLoopEnabled());
        this._syncTransportRegion?.();
      }
      return;
    }
    if (e.key === '[') {
      this._getTransportMixer()?.markCropIn(this.playOffset || this._bridge?.currentTime?.() || 0);
      this._syncTransportRegion?.();
      return;
    }
    if (e.key === ']') {
      this._getTransportMixer()?.markCropOut(this.playOffset || this._bridge?.currentTime?.() || 0);
      this._syncTransportRegion?.();
      return;
    }
  }

  /** Push VIP_PARAMS to the live-mix bridge when loaded (effective DSP where available). */
  _syncBridgeParams() {
    const bridge = this._bridge;
    if (!bridge || typeof bridge.applyParams !== 'function') return;
    // Prefer calibrated effective params for separation→isolation coupling safety.
    let params = window.VIP_PARAMS || {};
    try {
      if (typeof this.getEffectiveParams === 'function') {
        params = this.getEffectiveParams(params);
      }
    } catch { /* raw VIP_PARAMS fallback */ }
    bridge.applyParams(params);
    if (bridge.isLoaded && bridge.isLoaded()) this.liveChainBuilt = true;
  }

  /**
   * Load retained ML separation stems into the Live-Mix bridge.
   * Isolation (voiceIso / bgSuppress / gate / EQ) then refines without re-ML.
   */
  async _loadSeparationStemsToBridge() {
    if (!this._cleanStemChannels?.length) return null;
    await this.ensureCtx();
    const bridge = this._bridge || await this._ensureBridge();
    if (!bridge) return null;
    if (typeof bridge.loadStemPair === 'function') {
      bridge.loadStemPair(
        this._cleanStemChannels,
        this._noiseStemChannels || null,
        this._stemSampleRate || this.ctx?.sampleRate || 48000,
      );
    } else if (typeof bridge.loadBuffer === 'function' && this.outputBuffer) {
      bridge.loadBuffer(this.outputBuffer);
    }
    this._bridgeBuf = this.outputBuffer || null;
    this._syncBridgeParams();
    this.liveChainBuilt = true;
    return bridge;
  }

  /** After processing, default playback to the isolated output. */
  _setProcessedPlaybackMode() {
    this.abMode = 'processed';
    this._bridgeBuf = null;
    // Prefer stem-pair Live-Mix when separation retained clean+noise
    if (this._cleanStemChannels?.length) {
      this._loadSeparationStemsToBridge().catch(() => {});
    }
    if (this.dom?.tpAB) {
      this.dom.tpAB.classList.add('active');
      this.dom.tpAB.disabled = false;
      this.dom.tpAB.title = 'Compare Original / Processed (X) — sample-accurate, keeps playhead';
    }
    if (this.dom?.tpABLabel) {
      this.dom.tpABLabel.dataset.version = 'B';
      this.dom.tpABLabel.innerHTML = '<span class="tp-ab-tag">B</span><span class="tp-ab-name">Processed</span>';
    }
  }

  _resetSliders({ unlockedOnly = true } = {}) {
    const rows = (typeof document !== 'undefined' && document.querySelectorAll)
      ? document.querySelectorAll('[id^="sl_"]')
      : [];
    let changed = 0;
    rows.forEach((el) => {
      const id = el.id.slice(3);
      if (unlockedOnly && this._isSliderLocked(id)) return;
      const spec = SLIDER_BY_ID[id] || SLIDER_REG_BY_ID[id];
      if (!spec) return;
      const def = spec.val != null ? spec.val : spec.default;
      const cur = window.VIP_PARAMS?.[id];
      if (cur != null && Number(cur) === Number(def) && unlockedOnly) {
        this._userTouchedSliders.delete(id);
        return;
      }
      this._setSliderUi(id, def, { notify: true, force: !unlockedOnly });
      this._userTouchedSliders.delete(id);
      changed += 1;
    });
    if (!unlockedOnly || !this._isSliderLocked('whisperMode')) {
      this._setWhisperMode(SLIDER_BY_ID.whisperMode ? SLIDER_BY_ID.whisperMode.val : 0);
      this._userTouchedSliders.delete('whisperMode');
    }
    this._applyControlFilters?.();
    this.showNotification(
      unlockedOnly
        ? (changed ? `Reset ${changed} unlocked control(s)` : 'No unlocked controls needed reset')
        : 'All controls reset',
      'info',
    );
  }

  /**
   * Reset unlocked sliders belonging to a panel/section (by DOM id).
   * Locked parameters are never touched.
   */
  _resetSliderGroup(groupKey, { unlockedOnly = true } = {}) {
    if (!groupKey) return;
    const root = document.getElementById(groupKey);
    let n = 0;
    if (root) {
      const rows = root.querySelectorAll('.sr-row[data-slider-id], .slider-row[data-slider-id]');
      rows.forEach((row) => {
        const id = row.dataset.sliderId;
        if (!id) return;
        if (unlockedOnly && this._isSliderLocked(id)) return;
        const spec = SLIDER_BY_ID[id] || SLIDER_REG_BY_ID[id];
        if (!spec) return;
        const def = spec.val != null ? spec.val : spec.default;
        this._setSliderUi(id, def, { notify: true, force: false });
        this._userTouchedSliders.delete(id);
        n += 1;
      });
    }
    if (n === 0) {
      for (const s of RENDER_SLIDERS) {
        const panelId = this._getSliderPanelId(s.id);
        const section = root;
        const inPanel = panelId === groupKey
          || s.group === groupKey
          || (section && panelId && section.querySelector(`#${panelId}`));
        if (!inPanel) continue;
        if (unlockedOnly && this._isSliderLocked(s.id)) continue;
        const def = s.val != null ? s.val : s.default;
        this._setSliderUi(s.id, def, { notify: true, force: false });
        this._userTouchedSliders.delete(s.id);
        n += 1;
      }
    }
    this._applyControlFilters?.();
    if (n === 0) {
      this.showNotification('No unlocked controls to reset in this group', 'info');
      return;
    }
    this.showNotification(`Reset ${n} unlocked control(s) in group`, 'info');
  }

  /** Push a calibrated slider value through VIP_PARAMS, DOM, bridge, and worklet. */
  _setSliderUi(id, rawValue, { notify = true, force = false } = {}) {
    let changed = false;
    this._programmaticSliderUpdate = true;
    try {
      changed = this._setSliderUiInner(id, rawValue, { notify, force });
    } finally {
      this._programmaticSliderUpdate = false;
    }
    if (changed) this._scheduleSessionPersist();
    return changed;
  }

  _setSliderUiInner(id, rawValue, { notify = true, force = false } = {}) {
    if (id === 'whisperMode') {
      if (this._isSliderLocked(id) && !force) return false;
      return this._setWhisperMode(rawValue);
    }
    // Presets / auto-calibrate must not overwrite locked sliders unless force.
    if (this._isSliderLocked(id) && !force) return false;
    const hasSpec = SLIDER_REG_BY_ID[id] || SLIDER_BY_ID[id];
    if (!hasSpec) return false;
    const value = clampToSlider(id, rawValue);
    window.VIP_PARAMS = window.VIP_PARAMS || {};
    window.VIP_PARAMS[id] = value;
    this.params[id] = value;
    if (this.sharedParams) {
      const idx = this._sliderIndexById.get(id);
      if (idx !== undefined) this.sharedParams[idx] = value;
    }
    const el = document.getElementById('sl_' + id);
    const row = document.querySelector(
      `.slider-row[data-slider-id="${id}"], .sr-row[data-slider-id="${id}"]`,
    );
    if (row?._dspSlider && typeof row._dspSlider.setValue === 'function') {
      row._dspSlider.setValue(value, { silent: true });
    } else if (el) {
      el.value = value;
      el.setAttribute('aria-valuenow', value);
      const min = parseFloat(el.min);
      const max = parseFloat(el.max);
      const range = max - min;
      const pct = range > 0 ? ((value - min) / range) * 100 : 0;
      el.style.setProperty('--pct', `${pct.toFixed(1)}%`);
      const unit = SLIDER_REG_BY_ID[id]?.unit || SLIDER_BY_ID[id]?.unit || '';
      const label = SLIDER_REG_BY_ID[id]?.label || SLIDER_BY_ID[id]?.label || id;
      el.setAttribute('aria-valuetext', buildAriaValueText(label, value, unit));
      const valEl = document.getElementById('val_' + id);
      if (valEl) {
        if (valEl.tagName === 'INPUT') valEl.value = String(value);
        else valEl.textContent = value + _formatSliderUnit(unit);
      }
    }
    // Lazy accordion: params apply even when slider DOM is not mounted yet.
    // Flush will read VIP_PARAMS when the panel opens.
    this.onSlider(id, value);
    this._applySliderToWorklet(id, value);
    if (notify && el) el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // ── Preset application ────────────────────────────────────────────────────
  applyPreset(name, options = {}) {
    const { preserveWhisperMode = false } = options;
    const resolved = resolvePresetNameLocal(name);
    const preset = PRESETS[resolved] || PRESETS[name];
    if (!preset) return;
    name = resolved;
    const savedWhisper = preserveWhisperMode
      ? (window.VIP_PARAMS?.whisperMode ?? this.whisperMode ?? 0)
      : null;
    Object.entries(preset).forEach(([key, rawValue]) => {
      if (preserveWhisperMode && key === 'whisperMode') return;
      if (key === 'description') return;
      if (this._isSliderLocked(key)) return;
      this._setSliderUi(key, rawValue, { notify: false });
    });
    if (preserveWhisperMode && savedWhisper != null) {
      this._setWhisperMode(savedWhisper);
    }
    this._syncBridgeParams();
    if (this.liveChainBuilt) {
      if (window._vipOrch && typeof window._vipOrch.syncParams === 'function') {
        window._vipOrch.syncParams(window.VIP_PARAMS || {});
      }
    }
    this._activePresetName = name;
    this._scheduleSessionPersist();
    this.showNotification('Preset applied: ' + name, 'info');
  }

  /**
   * Auto-calibrate Engineer Mode sliders from processed audio loudness.
   * Applies the best-matching named preset, then merges AIIntelligence hints
   * for whisper/quiet content when the module is loaded.
   */
  _applyPresetValues(presetName, options = {}) {
    const { preserveWhisperMode = false, respectUserTouched = false } = options;
    const preset = PRESETS[presetName];
    if (!preset) return;
    Object.entries(preset).forEach(([key, rawValue]) => {
      if (preserveWhisperMode && key === 'whisperMode') return;
      if (key === 'description') return;
      if (this._isSliderLocked(key)) return;
      if (respectUserTouched && this._userTouchedSliders.has(key)) return;
      this._setSliderUi(key, rawValue, { notify: false });
    });
  }

  _autoCalibratePreset(buffer) {
    if (!buffer || typeof buffer.getChannelData !== 'function') return null;
    if (WorkflowTier.shouldSkipAutoCalibrate()) {
      const preset = WorkflowTier.getDefaultPreset();
      this._applyPresetValues(preset, { respectUserTouched: true });
      this._syncBridgeParams();
      return { preset, level: 'creator', rmsDb: 0 };
    }
    const channels = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      channels.push(buffer.getChannelData(ch));
    }
    const { preset, level, rmsDb, overrides = {} } = recommendEngineerPreset(channels);
    this._applyPresetValues(preset, { preserveWhisperMode: true, respectUserTouched: true });

    for (const [key, val] of Object.entries(overrides)) {
      if (!(SLIDER_REG_BY_ID[key] || SLIDER_BY_ID[key]) || !Number.isFinite(val)) continue;
      if (this._shouldPreserveSlider(key)) continue;
      this._setSliderUi(key, val);
    }

    const AI = globalThis.AIIntelligence;
    if (AI && typeof AI.autoTuneParams === 'function') {
      const mono = channels[0];
      const tune = AI.autoTuneParams(mono, buffer.sampleRate, this.params);
      for (const [key, val] of Object.entries(tune.suggestions || {})) {
        if (!(SLIDER_REG_BY_ID[key] || SLIDER_BY_ID[key]) || !Number.isFinite(val)) continue;
        if (this._shouldPreserveSlider(key)) continue;
        this._setSliderUi(key, val);
      }
    }

    this._syncBridgeParams();

    const detail = `${preset} (${level}, ${rmsDb.toFixed(1)} dBFS)`;
    structuredLog('info', '[VIP] Auto-calibrated mix', { preset, level, rmsDb });
    this.showNotification('Auto-calibrated: ' + detail, 'info');
    return { preset, level, rmsDb };
  }

  _showFileLoading(text) {
    const msg = text || 'Loading…';
    const ind = this.dom && this.dom.fileLoadIndicator;
    const info = this.dom && this.dom.fileInfo;
    if (ind) {
      ind.hidden = false;
      const label = ind.querySelector('.file-load-text');
      if (label) label.textContent = msg;
    }
    if (info) info.textContent = msg;
  }

  _hideFileLoading() {
    const ind = this.dom && this.dom.fileLoadIndicator;
    if (ind) ind.hidden = true;
  }

  _resetCollaborationState() {
    this._lastFullAnalysis = null;
    this._jointIsolationPlan = null;
    this._hunterEnvFromAnalysis = null;
    this._hunterSliderTargets = null;
    this._preferAnalysisForHunter = false;
    this._protectRegions = [];
    this._suppressRegions = [];
    this._lastHunterEnv = null;
    this._lastHunterMaskConf = null;
    this._lastHunterPlatform = null;
    this._lastHunterMessage = null;
    try {
      this._analysisWorkspace?.clearState?.();
    } catch (err) {
      structuredLog('warn', '[VIP] analysis workspace reset failed', { err: err?.message });
    }
  }

  async _readFileArrayBuffer(file) {
    if (typeof file.arrayBuffer === 'function') {
      const ab = await file.arrayBuffer();
      return cloneArrayBuffer(ab);
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(cloneArrayBuffer(reader.result));
      reader.onerror = () => reject(new Error('Could not read file from disk.'));
      reader.readAsArrayBuffer(file);
    });
  }

  async _decodeFileBuffer(ctx, arrayBuffer, file = null) {
    if (!ctx || typeof ctx.decodeAudioData !== 'function') {
      throw new Error('Audio decode unavailable on this device.');
    }
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* best-effort */ }
    }
    const mimeType = detectUploadMimeType(file);
    try {
      if (typeof globalThis.safeDecodeAudioData === 'function') {
        return await globalThis.safeDecodeAudioData(ctx, cloneArrayBuffer(arrayBuffer));
      }
      return await ctx.decodeAudioData(cloneArrayBuffer(arrayBuffer));
    } catch (primaryErr) {
      let decodeError = primaryErr;
      if (isLikelyAacContainerMime(mimeType) && typeof globalThis.decodeM4AWithFallback === 'function') {
        try {
          return await globalThis.decodeM4AWithFallback(ctx, cloneArrayBuffer(arrayBuffer), file, primaryErr);
        } catch (fallbackErr) {
          decodeError = fallbackErr;
        }
      }
      throw new Error(`Cannot decode audio: ${file?.name || 'file'} (${mimeType || 'unknown'}). ${decodeError?.message || decodeError}`);
    }
  }

  /** Lazily load the shared worker host once and retain it for synchronous cancellation. */
  _loadStemSeparationModule() {
    if (this._stemSeparationModule) return Promise.resolve(this._stemSeparationModule);
    if (!this._stemSeparationModulePromise) {
      this._stemSeparationModulePromise = import('/src/pipeline/StemSeparation.js')
        .then((module) => {
          this._stemSeparationModule = module;
          return module;
        })
        .catch((error) => {
          this._stemSeparationModulePromise = null;
          throw error;
        });
    }
    return this._stemSeparationModulePromise;
  }

  /** Prefetch + compile ONNX sessions off the hot path (deduped). */
  async _warmupMLModels(modelIds = DEFAULT_ML_CHAIN) {
    if (this._mlWarmupDone) return;
    if (this._mlWarmupPromise) return this._mlWarmupPromise;
    this._mlWarmupPromise = (async () => {
      const { warmupModels } = await this._loadStemSeparationModule();
      await warmupModels(modelIds);
      this._mlWarmupDone = true;
    })().catch((err) => {
      structuredLog('warn', '[VIP] ML warmup failed', { err: err?.message });
      this._mlWarmupPromise = null;
    });
    return this._mlWarmupPromise;
  }

  // ── File handling ─────────────────────────────────────────────────────────
  /**
   * Crash-safe save: critical params → IndexedDB TrackState; light UI chrome → localStorage.
   * Debounced. Never stores binary audio.
   */
  _persistSessionNow() {
    if (this._sessionPersistTimer) clearTimeout(this._sessionPersistTimer);
    this._sessionPersistTimer = null;
    const canPersistSession = typeof persistAppSession === 'function';
    const canSaveTrackState = typeof scheduleSaveTrackState === 'function';
    if (!canPersistSession && !canSaveTrackState) return;
    try {
      const presetName = this.dom?.presetSel?.value || this._activePresetName || null;
      const params = this.params || window.VIP_PARAMS || {};
      // Light fallback for non-critical UI continuity only
      if (canPersistSession) {
        persistAppSession(params, { presetName, mode: 'engineer' });
      }
      // Canonical crash-safe state
      if (canSaveTrackState && this._libraryFileId) {
        scheduleSaveTrackState(this._libraryFileId, {
          params,
          presetName,
          status: this.outputBuffer || this.procBuffer
            ? 'processed'
            : (this.origBuffer || this.inputBuffer ? 'decoded' : 'imported'),
          meta: {
            abMode: this.abMode,
            sourceName: this._sourceName || null,
          },
        });
      }
    } catch (err) {
      structuredLog('warn', '[VIP] session persist failed', { err: err?.message });
    }
  }

  _scheduleSessionPersist() {
    if (typeof persistAppSession !== 'function'
      && typeof scheduleSaveTrackState !== 'function') return;
    if (this._sessionPersistTimer) clearTimeout(this._sessionPersistTimer);
    this._sessionPersistTimer = setTimeout(() => this._persistSessionNow(), 400);
  }

  /** Flush pending TrackState + session on hide/unload (crash-safe). */
  _bindCrashSafeFlush() {
    if (this._crashFlushBound || typeof window === 'undefined') return;
    this._crashFlushBound = true;
    const flush = () => {
      try {
        this._persistSessionNow();
        if (typeof flushTrackStateSaves === 'function') void flushTrackStateSaves();
      } catch { /* ignore */ }
    };
    window.addEventListener('pagehide', () => {
      try { this.cancelActiveJobs(); } catch { /* page teardown is best-effort */ }
      flush();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  /**
   * Apply saved TrackState params onto sliders (IDB canonical).
   * @param {string} fileId
   */
  async _restoreTrackStateParams(fileId) {
    if (!fileId) return;
    try {
      const row = await getTrackState(fileId);
      if (!row?.params || typeof row.params !== 'object') return;
      window.VIP_PARAMS = window.VIP_PARAMS || {};
      Object.assign(window.VIP_PARAMS, row.params);
      Object.assign(this.params, row.params);
      this._programmaticSliderUpdate = true;
      try {
        for (const [id, val] of Object.entries(row.params)) {
          if (typeof val !== 'number' || !Number.isFinite(val)) continue;
          this._setSliderUi?.(id, val, { notify: false, force: true });
        }
        if (row.presetName && this.dom?.presetSel) {
          this.dom.presetSel.value = row.presetName;
          this._activePresetName = row.presetName;
        }
      } finally {
        this._programmaticSliderUpdate = false;
      }
      this._syncBridgeParams?.();
      structuredLog('info', '[VIP] Restored track state from IndexedDB', { fileId, rev: row.rev });
    } catch (err) {
      structuredLog('warn', '[VIP] track state restore failed', { err: err?.message });
    }
  }

  /**
   * Restore last library file after reload (source blob from OPFS/IDB).
   * Decode remains deferred until Analyze/Process/Play.
   *
   * Crash-safety: do not auto-hydrate multi-hundred-MB blobs into RAM on boot
   * (that OOM-killed Chrome/Edge/WebView). Prefer catalog restore + lazy open.
   */
  async _restoreLibrarySession() {
    const { CRASH_GUARD_KEY, MAX_AUTO_RESTORE_BYTES } = await import('/src/core/storage/memory-limits.js');
    // Crash guard: if the previous tab never cleared the boot flag, skip auto-hydrate once.
    let skipHydrate = false;
    try {
      if (typeof sessionStorage !== 'undefined') {
        if (sessionStorage.getItem(CRASH_GUARD_KEY) === '1') {
          skipHydrate = true;
          sessionStorage.removeItem(CRASH_GUARD_KEY);
          structuredLog('warn', '[VIP] crash guard: skipped auto-hydrate after prior unclean exit');
        } else {
          sessionStorage.setItem(CRASH_GUARD_KEY, '1');
        }
      }
    } catch { /* private mode */ }

    const { active, activeMeta, backend, hydrated } = await FileLibrary.restoreSessionBootstrap({
      hydrateActive: !skipHydrate,
      maxHydrateBytes: MAX_AUTO_RESTORE_BYTES,
    });
    const hint = document.getElementById('libraryBackendHint');
    if (hint) {
      hint.textContent = backend === 'opfs'
        ? 'Storage: OPFS (source files)'
        : 'Storage: IndexedDB (source files)';
    }
    await refreshLibraryList(this);

    const meta = active?.meta || activeMeta;
    if (!meta?.id) {
      this._clearCrashGuard(CRASH_GUARD_KEY);
      return;
    }

    this._libraryFileId = meta.id;
    await FileLibrary.setSessionState({ activeFileId: meta.id, updatedAt: Date.now() }).catch(() => {});

    // Prune orphans against live catalog
    try {
      const files = await FileLibrary.listLibraryFiles();
      await ensureCacheFresh({
        pruneOrphans: true,
        fileIds: files.map((f) => f.id),
      });
    } catch { /* ignore */ }

    await this._restoreTrackStateParams(meta.id);

    if (active?.file && hydrated) {
      await this.handleFile(active.file, {
        skipPersist: true,
        libraryId: meta.id,
        fromRestore: true,
        skipMlWarmup: true,
      });
    } else {
      // Soft restore — metadata only; blob loads on Analyze/Process/Play/open.
      this._sourceName = meta.originalFilename || '';
      this._sourceFile = null;
      this._pendingLibraryHydrate = true;
      this.setStatus('READY');
      if (this.dom?.fileInfo) {
        const mb = meta.size ? (meta.size / (1024 * 1024)).toFixed(1) : '?';
        this.dom.fileInfo.textContent =
          `${meta.originalFilename || 'Library file'} · ${mb} MB · in library (open or Analyze to load)`;
      }
      if (typeof this._updateProcessButtonsState === 'function') this._updateProcessButtonsState();
      this.showNotification(
        skipHydrate
          ? 'Recovered after crash — open a library file when ready'
          : `Library ready: ${meta.originalFilename || 'file'} — click it or Analyze to load`,
        'info',
      );
    }
    this._clearCrashGuard(CRASH_GUARD_KEY);
  }

  _clearCrashGuard(key = 'vip-crash-guard') {
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(key);
    } catch { /* ignore */ }
  }

  /**
   * Ensure _sourceFile is available for a library-backed session (lazy hydrate).
   * @returns {Promise<File|Blob|null>}
   */
  async _ensureSourceFileFromLibrary() {
    if (this._sourceFile) return this._sourceFile;
    if (!this._libraryFileId) return null;
    try {
      const opened = await FileLibrary.openSourceFile(this._libraryFileId);
      if (!opened?.file) return null;
      this._sourceFile = opened.file;
      this._sourceName = opened.meta?.originalFilename || this._sourceName || '';
      this._pendingLibraryHydrate = false;
      return this._sourceFile;
    } catch (err) {
      structuredLog('warn', '[VIP] library hydrate failed', { err: err?.message });
      return null;
    }
  }

  /**
   * Open a catalog entry from the library list (reconstructs File from storage).
   * @param {string} id
   */
  async openLibraryFile(id) {
    if (!id) return;
    try {
      const opened = await FileLibrary.openSourceFile(id);
      if (!opened?.file) {
        this.showNotification('Could not open library file — it may have been deleted.', 'error');
        await refreshLibraryList(this);
        return;
      }
      this._libraryFileId = id;
      await FileLibrary.setSessionState({ activeFileId: id, updatedAt: Date.now() });
      await this._restoreTrackStateParams(id);
      await this.handleFile(opened.file, { skipPersist: true, libraryId: id });
      await refreshLibraryList(this);
    } catch (err) {
      structuredLog('error', '[VIP] openLibraryFile failed', { err: err?.message });
      this.showNotification('Failed to open library file', 'error');
    }
  }

  /**
   * Accept a file without decoding. Decode starts on Analyze / Process / Play
   * via ensureDecoded() so upload never freezes the tab on large media.
   *
   * @param {File|Blob} file
   * @param {{ skipPersist?: boolean, libraryId?: string|null, fromRestore?: boolean }} [options]
   */
  async handleFile(file, options = {}) {
    if (!file) return;
    try { this._decodeAbortController?.abort('source changed'); } catch { /* ignore */ }
    this._decodeAbortController = null;
    if (typeof this._fileSeq !== 'number' || !Number.isFinite(this._fileSeq)) this._fileSeq = 0;
    const fileSeq = ++this._fileSeq;
    const skipPersist = Boolean(options.skipPersist);
    const fromRestore = Boolean(options.fromRestore);
    const skipMlWarmup = Boolean(options.skipMlWarmup);
    // Immediately hide any in-flight decode indicator from the previous file.
    this._hideFileLoading?.();
    // Only clear in-memory stems when switching to a different source name/size
    // (same track reopen should hit MLStemCache / durable cache).
    const sameSource = this._sourceName === (file.name || '')
      && this._sourceFile
      && this._sourceFile.size === file.size;
    if (!sameSource) {
      clearStemCache();
      this._stemFileSeq = null;
      this._stemProcessingRevision = null;
      this._cleanStemChannels = null;
      this._noiseStemChannels = null;
      this._visualsDrawn = false;
      this._lastVisualFp = null;
    }
    this._sourceName = file.name || '';
    this._decodePromise = null;
    this._decodeReady = false;
    this._resetCollaborationState?.();
    this.stop();
    if (this.isProcessing) {
      this.abortFlag = true;
      try {
        const { resetStemSeparation } = await this._loadStemSeparationModule();
        if (resetStemSeparation) resetStemSeparation();
      } catch (err) {
        structuredLog('warn', '[VIP] resetStemSeparation failed', { err: err?.message });
      }
      await this._waitForPipelineIdle(90000);
    }

    // Reject MIDI files early — not supported by Web Audio API
    const midiMimes = ['audio/midi', 'audio/x-midi', 'audio/mid'];
    const isMidi = midiMimes.includes((file.type || '').toLowerCase()) ||
      /\.(mid|midi)$/i.test(file.name || '');
    if (isMidi) {
      if (this.dom && this.dom.fileInfo) this.dom.fileInfo.textContent = 'MIDI files are not supported. Use an audio file (WAV, MP3, etc).';
      this.setStatus('ERROR');
      return;
    }

    // Reject clearly non-audio/non-video MIME types. Browsers/OS often report
    // application/octet-stream (or empty type) for valid media — fall back to
    // extension, then magic-byte sniff before giving up.
    let mediaKind = inferMediaKind(file);
    const mime = (file.type || '').toLowerCase();
    if (!mediaKind && isGenericMimeType(mime)) {
      try {
        mediaKind = await resolveMediaKind(file);
      } catch (sniffErr) {
        structuredLog('warn', '[VIP] media sniff failed', { err: sniffErr?.message });
      }
    }
    const isAudio = mediaKind === 'audio' || mediaKind === 'video'
      || isGenericMimeType(mime)
      || mime.startsWith('audio/') || mime.startsWith('video/');
    if (!isAudio) {
      if (this.dom && this.dom.fileInfo) {
        this.dom.fileInfo.textContent = 'Unsupported file type: ' + (file.type || 'unknown')
          + ' — use WAV, MP3, M4A, FLAC, or a common video container';
      }
      this.setStatus('ERROR');
      this.showNotification?.('Unsupported file type — try WAV or MP3', 'error');
      return;
    }
    const isLargeUpload = (file.size || 0) > LARGE_FILE_WARNING_BYTES;
    if (isLargeUpload) {
      structuredLog('warn', '[VIP] Large upload selected — decode may take longer', {
        name: file.name || '',
        sizeBytes: file.size || 0,
        mime: detectUploadMimeType(file),
      });
      this.showNotification?.('Large file detected (>500 MB) — decode may take longer on this device', 'warn');
    }
    if (fileSeq !== this._fileSeq) return;

    // Detect video by MIME / extension. Preview uses the raw File blob URL —
    // no PCM decode required until Analyze/Process.
    const isVideoFile = isVideoSource(file);
    this._sourceFile = file;
    this.isVideo = isVideoFile;
    this.inputBuffer = null;
    this.origBuffer = null;
    this.procBuffer = null;
    this.outputBuffer = null;
    this.noiseBuffer = null;

    // Persist source to OPFS/IDB (library/project) unless opening an existing entry.
    // Cap wait time so a hung OPFS/IDB never blocks the upload UX.
    if (!skipPersist) {
      try {
        const { mode, projectId } = await readImportOptionsFromUi();
        const persistWork = (async () => {
          const meta = await FileLibrary.importFile(file, { mode, projectId });
          if (mode === 'project' && projectId) {
            await ProjectStore.linkSourceFile(projectId, meta.id);
            await FileLibrary.updateFileMeta(meta.id, { projectId });
          }
          return meta;
        })();
        const meta = await Promise.race([
          persistWork,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('library persist timed out')), 10_000);
          }),
        ]);
        this._libraryFileId = meta.id;
        if (mode === 'temporary') {
          structuredLog('info', '[VIP] Quick import — not written to durable library');
        } else {
          structuredLog('info', '[VIP] Source saved to local library', {
            id: meta.id,
            mode,
            backend: meta.blobRef?.backend,
          });
        }
        refreshLibraryList(this).catch(() => {});
      } catch (persistErr) {
        structuredLog('warn', '[VIP] library persist failed — file still usable this session', {
          err: persistErr?.message,
        });
        this.showNotification('Could not save to library (session-only)', 'warn');
      }
    } else if (options.libraryId) {
      this._libraryFileId = options.libraryId;
      await FileLibrary.setSessionState({
        activeFileId: options.libraryId,
        updatedAt: Date.now(),
      }).catch(() => {});
    }

    if (typeof this._clearVideoElement === 'function') {
      this._clearVideoElement();
    }

    // Lightweight video picture preview (no audio decode).
    if (isVideoFile && this.dom?.videoPlayer) {
      this.isVideo = true;
      try {
        const url = URL.createObjectURL(file);
        this._videoObjectUrl = url;
        this.dom.videoPlayer.src = url;
        this.dom.videoPlayer.muted = true;
        this.dom.videoPlayer.load?.();
      } catch (err) {
        structuredLog('warn', '[VIP] video preview URL failed', { err: err?.message });
      }
      if (this.dom.videoCard) this.dom.videoCard.style.display = '';
    } else {
      this.isVideo = false;
      if (this.dom?.videoCard) this.dom.videoCard.style.display = 'none';
    }
    if (typeof this._updateSaveButtonLabels === 'function') this._updateSaveButtonLabels();

    // Reset so the same file can be re-selected (change event fires again).
    resetFileInput(this.dom?.fileInput);
    if (fileSeq !== this._fileSeq) return;

    const sizeMb = file.size ? (file.size / (1024 * 1024)).toFixed(1) : '?';
    const kindLabel = isVideoFile ? 'Video' : 'Audio';
    const restoreTag = fromRestore ? ' · restored' : (this._libraryFileId ? ' · in library' : '');
    const sizeHint = isLargeUpload ? ' · large file: decode may take longer' : '';
    if (this.dom?.fileInfo) {
      this.dom.fileInfo.textContent = `${file.name || 'File'} · ${kindLabel} · ${sizeMb} MB · ready (decode on Analyze/Process)${restoreTag}${sizeHint}`;
    }
    this.setStatus('READY');
    if (this.dom.saveOrigBtn) this.dom.saveOrigBtn.disabled = true; // needs decode
    // Single source of truth for Process / Play enablement (includes _sourceFile).
    if (typeof this._updateProcessButtonsState === 'function') this._updateProcessButtonsState();

    try { window.dispatchEvent(new CustomEvent('vip:fileAccepted', { detail: { name: file.name, size: file.size, video: isVideoFile, libraryId: this._libraryFileId, restored: fromRestore } })); } catch (evErr) {
      structuredLog('warn', '[VIP] vip:fileAccepted dispatch failed', { err: evErr?.message });
    }
    // Re-apply after hero/status listeners that may re-run button state.
    if (typeof this._updateProcessButtonsState === 'function') this._updateProcessButtonsState();
    this.showNotification(
      fromRestore
        ? `Restored “${file.name || 'File'}” from local library — Analyze or Process to decode`
        : `${file.name || 'File'} ready — Analyze or Process to decode & isolate`,
      'info',
    );

    // Idle ML warmup only (no decode) so first process is faster.
    // Skip on mobile + large files — compile competes with UI/decode and freezes WebView.
    const tooLargeForWarmup = (file.size || 0) > 40 * 1024 * 1024;
    const mobileSkipWarm = this._isMobileEngineer?.();
    if (!skipMlWarmup && !tooLargeForWarmup && !mobileSkipWarm && typeof this._warmupMLModels === 'function') {
      const scheduleIdle = globalThis.requestIdleCallback
        ? (cb) => requestIdleCallback(cb, { timeout: 4000 })
        : (cb) => setTimeout(cb, 200);
      scheduleIdle(() => {
        if (fileSeq !== this._fileSeq) return;
        this._warmupMLModels().catch((err) => {
          structuredLog('warn', '[VIP] ML warmup (idle) failed', { err: err?.message });
        });
      });
    }

    // Soft gesture unlock for AudioContext (worklets still lazy).
    try {
      const ctxP = typeof this.ensureCtx === 'function' ? this.ensureCtx() : null;
      if (ctxP && typeof ctxP.catch === 'function') {
        ctxP.catch((err) => {
          structuredLog('warn', '[VIP] AudioContext soft unlock failed', { err: err?.message });
        });
      }
    } catch (err) {
      structuredLog('warn', '[VIP] AudioContext soft unlock failed', { err: err?.message });
    }
  }

  /**
   * Decode + resample the pending source file once. Safe to call from Analyze,
   * Process, Play, or WhisperHunter. Dedupes concurrent callers.
   * @param {number} [fileSeq]
   * @returns {Promise<AudioBuffer|null>}
   */
  async ensureDecoded(fileSeq = this._fileSeq) {
    if (fileSeq !== this._fileSeq) return null;
    if (this.origBuffer || this.inputBuffer) {
      this._decodeReady = true;
      return this.origBuffer || this.inputBuffer;
    }
    // Lazy library hydrate — blob was not loaded at boot to avoid OOM.
    if (!this._sourceFile && this._libraryFileId) {
      await this._ensureSourceFileFromLibrary();
    }
    const file = this._sourceFile;
    if (!file) {
      this.showNotification?.('Load an audio or video file first', 'warn');
      return null;
    }
    if (this._decodePromise) return this._decodePromise;

    this._decodePromise = (async () => {
      const decodeUiSeq = fileSeq;
      this.setStatus('LOADING');
      HeroExperience.onDecodeStart();
      this._showFileLoading(file.name ? `Decoding ${file.name}…` : 'Decoding…');
      resetTimings();
      // Standalone decode (Play / Analyze / Save Original) gets its own job + Cancel.
      // When Process already owns the overlay/job, nest quietly under it.
      const jobs = globalThis.__VIP_JOBS__;
      const nestUnderProcess = !!this.isProcessing || !!jobs?.getCurrentJobId?.();
      let decodeJob = null;
      if (!nestUnderProcess && jobs?.beginJob) {
        decodeJob = jobs.beginJob('Decoding…', { kind: 'decode' });
        if (typeof this.showProcessingOverlay === 'function') {
          this.showProcessingOverlay('Decoding…', 0, 'decoding');
        }
      }
      const parentSignal = decodeJob?.controller?.signal || jobs?.getCurrentSignal?.() || null;
      const decodeController = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const forwardAbort = () => {
        try { decodeController?.abort(parentSignal?.reason || 'cancelled'); } catch { /* ignore */ }
      };
      if (parentSignal?.aborted) forwardAbort();
      else parentSignal?.addEventListener?.('abort', forwardAbort, { once: true });
      const decodeSignal = decodeController?.signal || parentSignal;
      this._decodeAbortController = decodeController;
      try {
        await this.ensureCtx();
        if (this.ctx?.state === 'suspended') await this.ctx.resume();
        if (fileSeq !== this._fileSeq) {
          if (decodeJob) jobs.endJob(decodeJob.id, 'cancelled');
          return null;
        }

        stageStart('decode');
        const decoded = await decodeBlobToAudioBuffer(file, {
          audioContext: this.ctx,
          signal: decodeSignal,
          onProgress: (pct) => {
            if (fileSeq !== this._fileSeq) return;
            const p = Math.round(pct);
            const label = pct < 50 ? 'Reading file…' : pct < 100 ? 'Decoding audio…' : 'Decode complete';
            this._showFileLoading(`${label} (${p}%)`);
            if (decodeJob && jobs?.updateJob) jobs.updateJob(decodeJob.id, label, p);
            if (decodeJob && typeof this.updateProcessingOverlay === 'function') {
              this.updateProcessingOverlay(label, p, 2);
            }
          },
        });
        stageEnd('decode');
        await yieldToBrowser();
        if (fileSeq !== this._fileSeq) {
          if (decodeJob) jobs.endJob(decodeJob.id, 'cancelled');
          return null;
        }

        stageStart('resample');
        if (decodeJob && jobs?.updateJob) jobs.updateJob(decodeJob.id, 'Resampling…', 85);
        const buffer = await resampleToCanonical(decoded, { signal: decodeSignal });
        stageEnd('resample');
        await yieldToBrowser();

        if (!buffer || !buffer.length) {
          throw new Error('Decoded audio is empty or unreadable');
        }
        if (fileSeq !== this._fileSeq) {
          if (decodeJob) jobs.endJob(decodeJob.id, 'cancelled');
          return null;
        }

        this.inputBuffer = buffer;
        this.origBuffer = buffer;
        this._decodeReady = true;
        // Update library metadata only (not full PCM) — duration / rate / channels.
        if (this._libraryFileId) {
          FileLibrary.updateFileMeta(this._libraryFileId, {
            duration: buffer.duration,
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
            processingStatus: 'decoded',
            waveformCacheKey: `wf:${this._libraryFileId}:${buffer.length}`,
          }).then(() => refreshLibraryList(this)).catch(() => {});
          scheduleSaveTrackState(this._libraryFileId, {
            status: 'decoded',
            meta: {
              duration: buffer.duration,
              sampleRate: buffer.sampleRate,
              channels: buffer.numberOfChannels,
            },
          });
        }
        this.onAudioLoaded(file.name, fileSeq);
        if (decodeJob) jobs.endJob(decodeJob.id, 'completed');
        return buffer;
      } catch (decodeErr) {
        if (fileSeq !== this._fileSeq) {
          if (decodeJob) jobs.endJob(decodeJob.id, 'cancelled');
          return null;
        }
        this._decodePromise = null;
        this._decodeReady = false;
        const cancelled = jobs?.isCancellationError?.(decodeErr)
          || /cancell?ed|aborted/i.test(String(decodeErr?.message || decodeErr));
        if (cancelled) {
          if (decodeJob) jobs.endJob(decodeJob.id, 'cancelled', decodeErr);
          this.setStatus('READY');
          this.showNotification('Decode cancelled', 'info');
          return null;
        }
        if (decodeJob) jobs.endJob(decodeJob.id, 'error', decodeErr);
        const isVideoFile = this.isVideo;
        const detail = decodeErr?.message ? ` (${decodeErr.message})` : '';
        const msg = isVideoFile
          ? `Cannot decode this video — try WAV or MP3.${detail}`
          : `Cannot decode this audio format — try WAV or MP3.${detail}`;
        if (this.dom && this.dom.fileInfo) this.dom.fileInfo.textContent = msg;
        this.setStatus('ERROR');
        this.showNotification('Cannot decode: ' + (file.name || 'file'), 'error');
        structuredLog('error', '[VIP] ensureDecoded failed', { err: decodeErr?.message });
        HeroExperience.onDecodeError(msg);
        return null;
      } finally {
        parentSignal?.removeEventListener?.('abort', forwardAbort);
        if (this._decodeAbortController === decodeController) this._decodeAbortController = null;
        // Hide loading indicator when this decode completes/fails/is stale,
        // but only if a newer decode hasn't already taken ownership of the UI.
        if (decodeUiSeq === this._fileSeq) {
          this._hideFileLoading();
        }
        // Only hide overlay if we opened a standalone decode job (not nested under Process).
        const activeJobId = jobs?.getCurrentJobId?.() || null;
        const decodeStillOwnsUi = !activeJobId || activeJobId === decodeJob?.id;
        if (decodeJob && decodeStillOwnsUi && !this.isProcessing
          && typeof this.hideProcessingOverlay === 'function') {
          try { this.hideProcessingOverlay(); } catch { /* ignore */ }
        }
      }
    })();

    try {
      return await this._decodePromise;
    } finally {
      // Keep resolved promise for dedupe until a new file clears it in handleFile
      if (!this._decodeReady) this._decodePromise = null;
    }
  }

  /** Revoke object URL and detach <video> source without leaving a dead URL. */
  _clearVideoElement() {
    const vp = this.dom?.videoPlayer;
    if (!vp) return;
    try { if (typeof vp.pause === 'function') vp.pause(); } catch { /* ignore */ }
    const attrSrc = typeof vp.getAttribute === 'function' ? vp.getAttribute('src') : null;
    const blobUrl = this._videoObjectUrl
      || (attrSrc && attrSrc.startsWith('blob:') ? attrSrc : null)
      || (typeof vp.src === 'string' && vp.src.startsWith('blob:') ? vp.src : null);
    if (blobUrl) {
      try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
    }
    this._videoObjectUrl = null;
    try {
      if (typeof vp.removeAttribute === 'function') vp.removeAttribute('src');
      else vp.src = '';
      if (typeof vp.load === 'function') vp.load();
    } catch { /* ignore */ }
  }

  _updateSaveButtonLabels() {
    const btn = this.dom?.saveProcBtn;
    if (!btn) return;
    btn.textContent = this.isVideo ? 'Save Processed Video' : 'Save Processed WAV';
    btn.title = this.isVideo
      ? 'Download video with isolated/processed audio track'
      : 'Download processed audio as WAV';
  }

  /**
   * User-initiated: pick a media file from Google Drive and load it locally.
   * Processing remains on-device — Drive is only the source of the file bytes.
   */
  async _openFromGoogleDrive() {
    const { openMediaFileFromDrive, isDriveConfigured } = await import('/src/core/GoogleDriveBridge.js');
    if (!isDriveConfigured()) {
      this.showNotification(
        'Google Drive is not configured — see docs/guides/GOOGLE_DRIVE.md',
        'warn',
      );
      return;
    }
    this.showNotification('Sign in to Google Drive to pick a file…', 'info');
    const file = await openMediaFileFromDrive();
    if (!file) return;
    if (typeof this.handleFile === 'function') {
      await this.handleFile(file);
    } else if (typeof this.loadFile === 'function') {
      await this.loadFile(file);
    } else {
      throw new Error('No file loader available');
    }
    this.showNotification(`Loaded from Drive: ${file.name || 'file'}`, 'ok');
  }

  /**
   * User-initiated: upload processed WAV to Google Drive (VoiceIsolate Pro folder).
   * Never runs automatically after Process.
   */
  async _saveProcessedToGoogleDrive() {
    const fullBuf = this.procBuffer || this.outputBuffer;
    if (!fullBuf) {
      this.showNotification('Nothing to save yet — process a file first.', 'info');
      return;
    }
    const { saveBlobToDrive, isDriveConfigured } = await import('/src/core/GoogleDriveBridge.js');
    const { encodeWav } = await import('/src/pipeline/ExportManager.js');
    if (!isDriveConfigured()) {
      this.showNotification(
        'Google Drive is not configured — see docs/guides/GOOGLE_DRIVE.md',
        'warn',
      );
      return;
    }
    const channels = [];
    for (let c = 0; c < fullBuf.numberOfChannels; c++) {
      channels.push(fullBuf.getChannelData(c));
    }
    const ditherAmt = buildMlProcessingConfig(
      this.getEffectiveParams(window.VIP_PARAMS || {}),
    ).export.ditherAmt;
    const blob = encodeWav(channels, fullBuf.sampleRate, { ditherAmt });
    const filename = `processed-${Date.now()}.wav`;
    this.showNotification('Uploading to Google Drive…', 'info');
    const meta = await saveBlobToDrive({ blob, filename, mimeType: 'audio/wav' });
    const link = meta?.webViewLink ? ` · ${meta.webViewLink}` : '';
    this.showNotification(`Saved to Drive: ${meta?.name || filename}${link}`, 'ok');
  }

  /**
   * Download processed audio, remuxed into the original video container when
   * the source was a video file. Falls back to WAV if remux is unavailable.
   * Uses JobController + processing overlay Cancel (same path as Process).
   */
  async _downloadProcessed() {
    const fullBuf = this.procBuffer || this.outputBuffer;
    if (!fullBuf) {
      this.showNotification('Nothing to save yet — process a file first.', 'info');
      return;
    }
    if (this._exportInFlight) {
      this.showNotification('Export already in progress…', 'info');
      return;
    }
    this._exportInFlight = true;
    const jobs = globalThis.__VIP_JOBS__;
    const job = jobs?.beginJob?.('Export processed', { kind: 'export' }) || null;
    const signal = job?.controller?.signal || jobs?.getCurrentSignal?.() || null;
    if (typeof this.showProcessingOverlay === 'function') {
      this.showProcessingOverlay('Exporting…', 0, 'exporting');
    }
    try {
      await this.ensureCtx();
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'CancellationError', code: 'CANCELLED' });

      let cropIn = 0;
      let cropOut = fullBuf.duration;
      const transport = this._getTransportMixer?.();
      if (transport?.hasCrop?.()) {
        const region = transport.getCropRegion();
        cropIn = region.in;
        cropOut = region.out;
      }

      const wantsVideo = this.isVideo && this._sourceFile && isVideoSource(this._sourceFile);
      if (wantsVideo) {
        try {
          this.showNotification('Encoding processed video…', 'info');
          const result = await exportVideoWithProcessedAudio(this._sourceFile, fullBuf, {
            startSec: cropIn,
            endSec: cropOut,
            signal,
            onProgress: (pct, stage) => {
              if (signal?.aborted) {
                throw Object.assign(new Error('Cancelled'), { name: 'CancellationError', code: 'CANCELLED' });
              }
              if (pct === 100 || stage === 'complete') return;
              const p = Math.round(pct);
              if (job && jobs?.updateJob) jobs.updateJob(job.id, 'Exporting video…', p);
              if (typeof this.updateProcessingOverlay === 'function') {
                this.updateProcessingOverlay(`Exporting video… ${p}%`, p, 28);
              }
              this.updatePipelineProgress?.(p, `Exporting video… ${p}%`, 1);
            },
          });
          if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'CancellationError', code: 'CANCELLED' });
          if (isDesktopShell()) {
            await saveExportBlob(result.blob, {
              defaultName: result.filename,
              filters: filtersForFilename(result.filename),
            });
          } else {
            triggerBlobDownload(result.blob, result.filename);
          }
          this.showNotification('Processed video saved: ' + result.filename, 'info');
          if (job && jobs?.endJob) jobs.endJob(job.id, 'completed');
          return;
        } catch (err) {
          const cancelled = jobs?.isCancellationError?.(err)
            || /cancell?ed|aborted/i.test(String(err?.message || err));
          if (cancelled) {
            this.showNotification('Export cancelled', 'info');
            if (job && jobs?.endJob) jobs.endJob(job.id, 'cancelled', err);
            return;
          }
          structuredLog('warn', '[VIP] video export failed — falling back to WAV', { err: err?.message });
          this.showNotification('Video remux unavailable — saving WAV instead.', 'info');
        }
      }

      if (signal?.aborted) {
        this.showNotification('Export cancelled', 'info');
        if (job && jobs?.endJob) jobs.endJob(job.id, 'cancelled');
        return;
      }

      let buf = fullBuf;
      if (cropIn > 0 || cropOut < fullBuf.duration) {
        buf = sliceAudioBuffer(this.ctx, fullBuf, cropIn, cropOut);
      }
      if (typeof this.updateProcessingOverlay === 'function') {
        this.updateProcessingOverlay('Writing WAV…', 90, 30);
      }
      const ditherAmt = buildMlProcessingConfig(
        this.getEffectiveParams(window.VIP_PARAMS || {}),
      ).export.ditherAmt;
      downloadWav(buf, 'processed-' + Date.now() + '.wav', ditherAmt);
      this.showNotification('Processed audio saved', 'info');
      if (job && jobs?.endJob) jobs.endJob(job.id, 'completed');
    } catch (err) {
      const cancelled = jobs?.isCancellationError?.(err)
        || /cancell?ed|aborted/i.test(String(err?.message || err));
      if (cancelled) {
        this.showNotification('Export cancelled', 'info');
        if (job && jobs?.endJob) jobs.endJob(job.id, 'cancelled', err);
      } else {
        this.showNotification(err?.message || 'Export failed', 'error');
        if (job && jobs?.endJob) jobs.endJob(job.id, 'error', err);
        throw err;
      }
    } finally {
      this._exportInFlight = false;
      const activeJobId = jobs?.getCurrentJobId?.() || null;
      const exportStillOwnsUi = !activeJobId || activeJobId === job?.id;
      if (exportStillOwnsUi && typeof this.hideProcessingOverlay === 'function') {
        try { this.hideProcessingOverlay(); } catch { /* ignore */ }
      }
    }
  }

  /** @deprecated Use decodeBlobToAudioBuffer — kept for legacy patch scripts. */
  async decodeViaVideoElement(file) {
    const decoded = await decodeBlobToAudioBuffer(file);
    return resampleToCanonical(decoded);
  }

  onAudioLoaded(name, fileSeq = this._fileSeq) {
    const buf = this.inputBuffer || this.origBuffer;
    if (!buf) return;
    if (fileSeq !== this._fileSeq) return;

    this.setStatus('READY');

    // Button states — set before updating header stats
    this._updateProcessButtonsState();
    if (this.dom.playBtn) this.dom.playBtn.disabled = false;
    if (this.dom.saveOrigBtn) this.dom.saveOrigBtn.disabled = false;

    // Header stats
    if (this.dom.hDur) this.dom.hDur.textContent = fmtTime(buf.duration);
    if (this.dom.hSR) this.dom.hSR.textContent = buf.sampleRate + ' Hz';
    if (this.dom.hCh) this.dom.hCh.textContent = buf.numberOfChannels === 1 ? 'Mono' : 'Stereo';
    if (this.dom.hFile) this.dom.hFile.textContent = (name || '').slice(0, 20);
    if (this.dom.fileInfo) {
      this.dom.fileInfo.textContent = `${name || 'File'} · ${fmtTime(buf.duration)} · ${buf.sampleRate} Hz · decoded`;
    }

    const scheduleIdle = globalThis.requestIdleCallback
      ? (cb) => requestIdleCallback(cb, { timeout: 1500 })
      : (cb) => setTimeout(cb, 0);
    scheduleIdle(() => {
      if (fileSeq !== this._fileSeq) return;
      this.renderStaticVisuals(buf);
      HeroExperience.mirrorWaveCanvases();
    });
    try { window.dispatchEvent(new CustomEvent('vip:fileLoaded', { detail: { name } })); } catch (_) {}
    this.showNotification('Decoded: ' + name + ' — run Analyze or Process', 'info');

    // No auto-pipeline on decode — user drives Analyze / Process / WhisperHunter.
    // Idle warmup on desktop only (mobile freezes if ONNX compiles during UI work).
    if (typeof this._warmupMLModels === 'function' && !this._isMobileEngineer?.()) {
      const scheduleIdle = globalThis.requestIdleCallback
        ? (cb) => requestIdleCallback(cb, { timeout: 5000 })
        : (cb) => setTimeout(cb, 400);
      scheduleIdle(() => {
        this._warmupMLModels().catch(() => {});
      });
    }
  }

  /**
   * Wipe library, OPFS/IDB blobs, stems, embeddings, model cache, VIP localStorage.
   * Confirms with the user. Reloads after success so UI state is consistent.
   */
  async _clearAllLocalData() {
    const ok = typeof confirm === 'function'
      ? confirm(
        'Clear ALL local VoiceIsolate data?\n\n'
        + 'This permanently deletes the file library, cached stems, embeddings, '
        + 'track state, and ONNX model cache on this device. Audio never left this device.',
      )
      : true;
    if (!ok) return;
    try {
      this.showNotification?.('Clearing local data…', 'info');
      const { clearAllLocalData } = await import('/src/core/ClearLocalData.js');
      const result = await clearAllLocalData({ includeModels: true });
      try { this._clearFile?.(); } catch { /* ignore */ }
      this.showNotification?.(
        `Local data cleared (${result.filesRemoved} library file(s), ${result.localStorageKeys} keys). Reloading…`,
        'ok',
      );
      if (typeof location !== 'undefined' && location.reload) {
        setTimeout(() => location.reload(), 600);
      }
    } catch (err) {
      this.showNotification?.(
        `Clear Local Data failed: ${err?.message || err}`,
        'error',
      );
    }
  }

  _clearFile() {
    clearStemCache();
    this._sourceName = '';
    this._sourceFile = null;
    // Clear only the working set — library entries remain until Remove/Delete.
    this._libraryFileId = null;
    this._stemFileSeq = null;
    this._stemProcessingRevision = null;
    this._decodePromise = null;
    this._decodeReady = false;
    this._resetCollaborationState?.();
    this._transportRegionWired = false;
    this._syncTransportRegion = null;
    this._cleanStemChannels = null;
    this._noiseStemChannels = null;
    this._stemSampleRate = null;
    this.noiseBuffer = null;
    this._bridgeBuf = null;
    FileLibrary.setSessionState({ activeFileId: null, updatedAt: Date.now() }).catch(() => {});
    refreshLibraryList(this).catch(() => {});
    HeroExperience.onClear();
    this.stop();
    this.inputBuffer = null;
    this.outputBuffer = null;
    this.origBuffer = null;
    this.procBuffer = null;
    this.isVideo = false;
    this._clearVideoElement();
    if (this.dom && this.dom.videoCard) this.dom.videoCard.style.display = 'none';
    this._updateSaveButtonLabels();
    if (this.dom.fileInfo) this.dom.fileInfo.textContent = 'No file loaded';
    if (this.dom.fileInput) this.dom.fileInput.value = '';
    [this.dom.processBtn, this.dom.reprocessBtn, this.dom.saveProcBtn,
     this.dom.saveDriveBtn, this.dom.saveOrigBtn, this.dom.auditLogBtn,
     this.dom.mobileProcessBtn, this.dom.mobileReprocessBtn].forEach(b => {
      if (b) b.disabled = true;
    });
    this.setStatus('IDLE');
  }

  setStatus(s) {
    this._setHeaderStat('hStatus', s);
  }

  // [WHISPER UPDATE] Read compound whisper-mode state from VIP_PARAMS
  _getWhisperModeState() {
    const mode = Math.round(window.VIP_PARAMS?.whisperMode ?? this.whisperMode ?? 0);
    return WHISPER_MODE_STATES[mode] || WHISPER_MODE_STATES[0];
  }

  // [WHISPER UPDATE] Animate sliders toward target values with cubic ease-out
  morphSlidersTo(targets, durationMs = 400) {
    if (!targets || typeof targets !== 'object') return Promise.resolve();
    const entries = Object.entries(targets).filter(([id]) => SLIDER_BY_ID[id] || id === 'whisperMode');
    if (!entries.length) return Promise.resolve();

    const startVals = entries.map(([id]) => {
      if (id === 'whisperMode') return window.VIP_PARAMS?.whisperMode ?? this.whisperMode ?? 0;
      const el = document.getElementById('sl_' + id);
      return el ? parseFloat(el.value) : (window.VIP_PARAMS?.[id] ?? 0);
    });

    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        const raw = Math.min(1, (now - t0) / durationMs);
        const t = 1 - Math.pow(1 - raw, 3);
        entries.forEach(([id, target], i) => {
          const end = Number(target);
          const val = Math.round((startVals[i] + (end - startVals[i]) * t) * 100) / 100;
          if (id === 'whisperMode') {
            this._setWhisperMode(Math.round(val));
          } else {
            const el = document.getElementById('sl_' + id);
            if (el) {
              el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
              window.VIP_PARAMS = window.VIP_PARAMS || {};
              window.VIP_PARAMS[id] = val;
              this.params[id] = val;
              this.onSlider(id, val);
            }
          }
        });
        if (raw < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  // [WHISPER UPDATE] Set whisper-mode button group state
  _setWhisperMode(mode, { persist = true } = {}) {
    const m = Math.max(0, Math.min(3, Math.round(mode)));
    const prior = Number(window.VIP_PARAMS?.whisperMode);
    window.VIP_PARAMS = window.VIP_PARAMS || {};
    window.VIP_PARAMS.whisperMode = m;
    this.params.whisperMode = m;
    this.whisperMode = m;
    if (this.sharedParams) {
      const idx = this._sliderIndexById.get('whisperMode');
      if (idx !== undefined) this.sharedParams[idx] = m;
    }
    if (typeof document !== 'undefined') {
      document.querySelectorAll('.wm-btn').forEach((btn) => {
        const active = parseInt(btn.dataset.mode, 10) === m;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
      });
    }
    this.onSlider('whisperMode', m);
    const changed = !Number.isFinite(prior) || prior !== m;
    if (persist && changed) this._scheduleSessionPersist();
    return changed;
  }

  /** Wait for an in-flight pipeline (after abort) before loading or re-running. */
  async _waitForPipelineIdle(maxMs = 20000) {
    const start = Date.now();
    while (this.isProcessing && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 40));
    }
    if (this.isProcessing) {
      structuredLog('warn', '[VIP] Pipeline idle wait timed out — forcing reset.');
      try { this._stemSeparationModule?.resetStemSeparation?.(); } catch { /* ignore */ }
      this.isProcessing = false;
      this.abortFlag = false;
      const activeJobId = globalThis.__VIP_JOBS__?.getCurrentJobId?.() || null;
      if (!activeJobId && typeof this.hideProcessingOverlay === 'function') {
        try { this.hideProcessingOverlay(); } catch (_) {}
      }
      document.body.classList.remove('vip-processing-lock');
      try { window.dispatchEvent(new CustomEvent('vip:processingDone')); } catch (_) {}
    }
  }

  /** Cooperative cancel for Process / Analyze / MOPE (JobController + workers). */
  cancelActiveJobs() {
    this.abortFlag = true;
    try { this._decodeAbortController?.abort('user'); } catch { /* ignore */ }
    this._logProgressDiag('cancel-requested', { abortReason: 'user', end: true });
    try {
      const jobs = globalThis.__VIP_JOBS__;
      if (jobs?.cancelCurrent) jobs.cancelCurrent('user');
    } catch { /* ignore */ }
    // If ML was loaded, its host owns the cancel grace timer and worker recycle.
    // Never start a dynamic import from cancellation: it can resolve after page/test teardown.
    try { this._stemSeparationModule?.cancelStemSeparation?.(); } catch { /* ignore */ }
  }

  // ── Main pipeline (32-stage Deca-Pass) ────────────────────────────────────
  async runPipeline(fileSeq = this._fileSeq) {
    if (this.isProcessing) {
      this.showNotification('Processing already in progress…', 'info');
      return;
    }
    if (fileSeq !== this._fileSeq) return;

    // Decode only when processing starts (not at upload).
    const decoded = await this.ensureDecoded(fileSeq);
    if (!decoded || fileSeq !== this._fileSeq) return;
    if (!this.origBuffer && !this.inputBuffer) return;

    if (this.isProcessing) {
      this.showNotification('Processing already in progress…', 'info');
      return;
    }
    this.isProcessing = true;
    this.abortFlag = false;
    // Mirror JobController signal when available (overlay cancel / supersede).
    try {
      const jobs = globalThis.__VIP_JOBS__;
      const sig = jobs?.getCurrentSignal?.();
      if (sig) {
        const onAbort = () => { this.abortFlag = true; };
        if (sig.aborted) this.abortFlag = true;
        else sig.addEventListener('abort', onAbort, { once: true });
      }
    } catch { /* ignore */ }
    this._mlIsolationSucceeded = false;
    this._pipelinePct = 0;
    // STFT owner budget for this Process job (audit F-02) — soft observability.
    try {
      if (typeof globalThis !== 'undefined') {
        // Dynamic import avoided in hot path; budget factory is tiny and inlined via global hook.
        const factory = globalThis.__vipCreateStftBudget;
        if (typeof factory === 'function') {
          globalThis.__vipStftBudget = factory({ label: 'process', maxOwners: 2 });
        } else {
          globalThis.__vipStftBudget = {
            _m: new Map(),
            record(owner) {
              const n = (this._m.get(owner) || 0) + 1;
              this._m.set(owner, n);
              return { allowed: n <= 1, count: n, ownerCount: this._m.size };
            },
            owners() { return [...this._m.keys()]; },
            snapshot() { const o = {}; for (const [k, v] of this._m) o[k] = v; return o; },
            getWarnings() { return []; },
          };
        }
      }
    } catch { /* budget is best-effort */ }
    // Pause active playback before heavy work; retain playhead; do NOT auto-resume.
    // Prevents overlapping graph nodes / double STFT races with AudioWorklet.
    this._pausedForProcess = false;
    this._playheadBeforeProcess = null;
    try {
      const bridgePlaying = this._bridge && typeof this._bridge.isPlaying === 'function'
        && this._bridge.isPlaying();
      if (this.isPlaying || bridgePlaying) {
        if (typeof this._getTransportPosition === 'function') {
          this._playheadBeforeProcess = this._getTransportPosition();
        } else {
          this._playheadBeforeProcess = this.playOffset || 0;
        }
        this.pause();
        this._pausedForProcess = true;
      }
    } catch (pauseErr) {
      structuredLog('warn', '[VIP] pause-before-process failed', { err: pauseErr?.message });
    }
    this._setTransportProcessingState(true);
    this._updateProcessButtonsState();
    stageStart('pipeline');
    // Let the browser paint the processing overlay before heavy work.
    await yieldToBrowser();

    // Hide process buttons, show stop button
    if (this.dom.mobileProcessBtn) {
      this.dom.mobileProcessBtn.style.display = 'none';
    }
    if (this.dom.mobileReprocessBtn) {
      this.dom.mobileReprocessBtn.style.display = 'none';
    }
    if (this.dom.mobileStopBtn) {
      this.dom.mobileStopBtn.style.display = 'inline-flex';
    }

    // Always single-pass isolation on the auto/default path — multi-pass STFT
    // loops freeze the main thread for multi-minute files. Whisper aggressiveness
    // is controlled by whisperMode spectral params inside one spectral stage.
    let totalPasses = 1;
    if (this._autoPipelineRun) this._autoPipelineRun = false;
    void this._getWhisperModeState();

    this.setStatus('PROCESSING');
    this.updatePipelineProgress(0, totalPasses > 1 ? 'Starting isolation passes…' : 'ML isolation…', 0, { force: true });

    try {
      // Always preserve the uploaded buffer as origBuffer for ML/cache identity.
      if (!this.origBuffer && this.inputBuffer) this.origBuffer = this.inputBuffer;
      let sourceBuf = this.origBuffer || this.inputBuffer;
      for (let pass = 0; pass < totalPasses; pass++) {
        if (this.abortFlag) break;
        if (totalPasses > 1) {
          this.updatePipelineProgress(0, `Whisper forensic pass ${pass + 1}/${totalPasses}…`, Math.round((pass / totalPasses) * 90));
          if (this.dom && this.dom.pipeDetail) {
            this.dom.pipeDetail.textContent = `Forensic pass ${pass + 1}/${totalPasses}…`;
          }
        }
        // Pass 0 works from original; later forensic DSP passes refine procBuffer.
        sourceBuf = pass === 0
          ? (this.origBuffer || this.inputBuffer)
          : (this.procBuffer || this.origBuffer || this.inputBuffer);

        if (pass === 0) {
          // ML inference runs exactly once per file (CLAUDE.md §1). Whisper
          // forensic passes are DSP-only refinement on procBuffer.
          stageStart('ml_isolation');
          const mlOk = await this._runMLIsolationPipeline(fileSeq);
          stageEnd('ml_isolation');
          if (fileSeq !== this._fileSeq) break;
          this._mlIsolationSucceeded = mlOk;
          if (!mlOk) {
            stageStart('dsp_fallback');
            await this._runFallbackPipeline(sourceBuf);
            stageEnd('dsp_fallback');
          }
        } else if (!this._mlIsolationSucceeded) {
          stageStart(`dsp_whisper_pass_${pass}`);
          await this._runFallbackPipeline(sourceBuf);
          stageEnd(`dsp_whisper_pass_${pass}`);
        }
        // When ML already isolated vocals, skip redundant forensic DSP passes.

        if (this._mlIsolationSucceeded) break;

        if (pass < totalPasses - 1 && this.procBuffer) {
          WHISPER_HUNTER.updateNoiseProfileFromBuffer(this.procBuffer, this);
        }
      }

      if (fileSeq !== this._fileSeq) {
        stageEnd('pipeline');
        this.setStatus('READY');
        this.updatePipelineProgress(0, 'Cancelled (new file loaded)', 0, { force: true });
        return;
      }
      if (this.abortFlag) {
        stageEnd('pipeline');
        this.setStatus('READY');
        this.updatePipelineProgress(0, 'Cancelled', 0, { force: true });
        return;
      }

      // Success — enable reprocess
      this.outputBuffer = this.outputBuffer || this.procBuffer;
      if (!this.outputBuffer && (this.origBuffer || this.inputBuffer)) {
        // Guard: never leave processing "done" with no playable buffer.
        this.outputBuffer = this.procBuffer = this.origBuffer || this.inputBuffer;
      }
      // ML isolation path can emit super-unity peaks (mask gain / OLA). The offline
      // DSP path already limits, but ML success skips that path — enforce a final
      // brickwall safety limit on every processed buffer before Live-Mix / export.
      try {
        if (
          this.outputBuffer &&
          this.outputBuffer !== this.origBuffer &&
          this.outputBuffer !== this.inputBuffer
        ) {
          this._throwIfProcessAborted();
          this.updatePipelineProgress(26, 'Output safety…', 98);
          this._logProgressDiag('output-safety');
          await yieldToBrowser();
          await this._applyOutputSafetyLimitAsync(this.outputBuffer);
          this.procBuffer = this.outputBuffer;
          await yieldToBrowser();
        }
      } catch (limErr) {
        const jobs = globalThis.__VIP_JOBS__;
        if (jobs?.isCancellationError?.(limErr) || limErr?.name === 'AbortError') throw limErr;
        structuredLog('warn', '[VIP] output safety limit failed', { err: limErr?.message });
      }
      if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = false;
      if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = false;
      if (this.dom.saveProcBtn) this.dom.saveProcBtn.disabled = false;
      if (this.dom.saveDriveBtn) this.dom.saveDriveBtn.disabled = false;
      if (this.dom.auditLogBtn) this.dom.auditLogBtn.disabled = false;
      this._updateSaveButtonLabels();

      this.updatePipelineProgress(28, 'Loading Live-Mix…', 99);
      await yieldToBrowser();
      try {
        this._setProcessedPlaybackMode();
      } catch (playErr) {
        structuredLog('warn', '[VIP] Live-Mix load failed after process', { err: playErr?.message });
      }
      await yieldToBrowser();

      // Playable/exportable output is ready BEFORE visuals / auto-analysis.
      stageEnd('pipeline');
      this.updatePipelineProgress(32, 'Complete', 100, { force: true });
      this._logProgressDiag('complete');
      this.setStatus('DONE');
      try {
        this.updateAudioMetrics(this._computeAudioMetricsState());
      } catch (_) { /* metrics must not fail the pipeline */ }
      try { window.dispatchEvent(new CustomEvent('vip:processingDone')); } catch (_) {}

      if (this.outputBuffer) {
        const scheduleIdle = globalThis.requestIdleCallback
          ? (cb) => requestIdleCallback(cb, { timeout: 2500 })
          : (cb) => setTimeout(cb, 50);
        scheduleIdle(() => {
          if (fileSeq !== this._fileSeq) return;
          try {
            this.renderStaticVisuals(this.outputBuffer);
            if (!this._isMobileEngineer?.()) {
              this._autoCalibratePreset(this.outputBuffer);
            }
            this._syncBridgeParams();
          } catch (idleErr) {
            structuredLog('warn', '[VIP] post-process idle work failed', { err: idleErr?.message });
          }
        });
      }
      // Auto Analysis + USM/diarization — NEVER blocks playable output readiness.
      // Mobile: skip. Desktop Electron: defer longer so Live-Mix paints first.
      try {
        const seq = fileSeq;
        if (this._isMobileEngineer?.()) {
          structuredLog('info', '[VIP] auto-analysis skipped on mobile — tap Analyze when ready');
        } else {
          const delayMs = isDesktopShell() ? 1200 : 80;
          const schedule = globalThis.requestIdleCallback
            ? (cb) => requestIdleCallback(cb, { timeout: isDesktopShell() ? 8000 : 3500 })
            : (cb) => setTimeout(cb, delayMs);
          schedule(() => {
            if (seq !== this._fileSeq) return;
            if (this.isProcessing) return;
            if (typeof this.runFullAnalysis !== 'function') return;
            // Deduplicate: one deferred analysis per processed fileSeq.
            if (this._deferredAnalysisFileSeq === seq) return;
            this._deferredAnalysisFileSeq = seq;
            this.runFullAnalysis().then(() => {
              try {
                window.__VIP_ENGINEER_CONSOLE__?.refreshSummaryFromApp?.();
              } catch { /* cosmetic */ }
            }).catch((aErr) => {
              structuredLog('warn', '[VIP] auto-analysis after process failed', {
                err: aErr?.message || String(aErr),
              });
              this.showNotification?.('Analysis deferred — processed audio is ready', 'info');
            });
          });
        }
      } catch { /* auto-analysis is best-effort */ }
    } catch (err) {
      const jobs = globalThis.__VIP_JOBS__;
      const cancelled = jobs?.isCancellationError?.(err)
        || err?.name === 'AbortError'
        || this.abortFlag;
      if (cancelled) {
        structuredLog('info', '[VIP] Pipeline cancelled', { err: err?.message });
        this.setStatus('READY');
        this.showNotification('Processing cancelled', 'info');
        this.updatePipelineProgress(0, 'Cancelled', 0, { force: true });
        this._logProgressDiag('cancelled', { err: err?.message || null });
      } else {
        structuredLog('error', '[VIP] Pipeline error', { err: err?.message });
        this.setStatus('ERROR');
        this.showNotification('Processing failed: ' + (err?.message || err), 'error');
        this.updatePipelineProgress(0, 'Error', 0, { force: true });
        this._logProgressDiag('error', { err: err?.message || String(err) });
      }
    } finally {
      // Always unlock the UI — never leave the bar stuck mid-process.
      this.isProcessing = false;
      // Restore transport controls; restore playhead if we paused — never auto-resume.
      this._setTransportProcessingState(false);
      if (this._playheadBeforeProcess != null && Number.isFinite(this._playheadBeforeProcess)) {
        try {
          if (typeof this.seekTo === 'function') this.seekTo(this._playheadBeforeProcess);
          else this.playOffset = this._playheadBeforeProcess;
        } catch { /* keep current offset */ }
      }
      this._pausedForProcess = false;
      this._playheadBeforeProcess = null;
      this._updateProcessButtonsState();
      // Let the overlay wrapper settle this job while one is active. Direct
      // callers still release the overlay here when no newer job owns it.
      const activeJobId = globalThis.__VIP_JOBS__?.getCurrentJobId?.() || null;
      if (!activeJobId && typeof this.hideProcessingOverlay === 'function') {
        try { this.hideProcessingOverlay(); } catch (_) {}
      }
      if (this.dom.mobileProcessBtn) {
        this.dom.mobileProcessBtn.style.display='inline-flex';
      }
      if (this.dom.mobileReprocessBtn) {
        this.dom.mobileReprocessBtn.style.display='inline-flex';
      }
      if (this.dom.mobileStopBtn) {
        this.dom.mobileStopBtn.style.display='none';
      }
    }
  }

  /**
   * During Process: disable transport except visible "processing" state.
   * Restores on completion/error without starting playback.
   */
  _setTransportProcessingState(busy) {
    const ids = ['tpPlay', 'tpPause', 'tpStop', 'tpRew', 'tpFwd', 'tpSeek', 'tpSpeed', 'tpLoop', 'tpCropIn', 'tpCropOut', 'tpCropClear', 'tpAB'];
    for (const id of ids) {
      const el = this.dom?.[id] || (typeof document !== 'undefined' ? document.getElementById(id) : null);
      if (!el) continue;
      if (busy) {
        if (el.dataset.vipPrevDisabled == null) {
          el.dataset.vipPrevDisabled = el.disabled ? '1' : '0';
        }
        el.disabled = true;
      } else if (el.dataset.vipPrevDisabled != null) {
        // Leave disabled if no buffer / no processed yet for A/B; else restore.
        const had = el.dataset.vipPrevDisabled === '1';
        delete el.dataset.vipPrevDisabled;
        if (id === 'tpAB') {
          el.disabled = !(this.outputBuffer || this.procBuffer);
        } else {
          el.disabled = had && !(this.inputBuffer || this.origBuffer || this.outputBuffer);
          if (this.inputBuffer || this.origBuffer || this.outputBuffer) {
            el.disabled = false;
          }
        }
      }
    }
    const card = typeof document !== 'undefined' ? document.querySelector('.transport-card') : null;
    if (card) {
      card.dataset.processing = busy ? 'true' : 'false';
      card.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    const ab = this.dom?.tpAB || (typeof document !== 'undefined' ? document.getElementById('tpAB') : null);
    if (ab && !busy) {
      ab.title = 'Compare Original / Processed (X) — sample-accurate, keeps playhead';
      ab.setAttribute('aria-label', 'Compare Original vs Processed');
    }
  }

  async pip() {
    // Alias — kept for compatibility
    return this.runPipeline();
  }

  /** Mobile / low-memory Engineer shell — freeze-sensitive path. */
  _isMobileEngineer() {
    try {
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
      if (/Android|iPhone|iPad|Mobile|Capacitor/i.test(ua)) return true;
      if (typeof navigator !== 'undefined' && navigator.deviceMemory > 0 && navigator.deviceMemory <= 4) {
        return true;
      }
      if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) return true;
    } catch { /* ignore */ }
    return false;
  }

  /**
   * Build mid (L+R)/2 for multi-channel — one ML pass instead of N channels.
   * Async + yielded so long stereo files do not freeze mobile UI.
   * @param {AudioBuffer} buf
   * @returns {Promise<{ channelData: Float32Array[], expandStereo: boolean, left?: Float32Array, right?: Float32Array, mid?: Float32Array }>}
   */
  async _mlChannelPlan(buf) {
    const nCh = buf.numberOfChannels;
    if (nCh < 2) {
      return { channelData: [new Float32Array(buf.getChannelData(0))], expandStereo: false };
    }
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);
    const mid = new Float32Array(left.length);
    const signal = this._processAbortSignal();
    const CHUNK = this._postMlChunkSamples();
    await processInChunks({
      total: left.length,
      chunkSize: CHUNK,
      signal,
      runChunk: (start, end) => {
        for (let i = start; i < end; i++) {
          mid[i] = 0.5 * (left[i] + right[i]);
        }
      },
    });
    return { channelData: [mid], expandStereo: true, left, right, mid };
  }

  /**
   * Apply mono clean stem as a per-sample gain envelope onto stereo sources.
   * Cooperative on desktop Electron + mobile so expand never freezes at ~87%.
   * @param {Float32Array} cleanMono
   * @param {Float32Array|null} mid
   * @param {Float32Array} left
   * @param {Float32Array} right
   * @param {{ onProgress?: (r: number) => void }} [opts]
   */
  async _expandMonoCleanToStereo(cleanMono, mid, left, right, opts = {}) {
    const n = cleanMono.length;
    const cleanL = new Float32Array(n);
    const cleanR = new Float32Array(n);
    const midOk = mid && mid.length >= n;
    const signal = this._processAbortSignal();
    const CHUNK = this._postMlChunkSamples();
    await processInChunks({
      total: n,
      chunkSize: CHUNK,
      signal,
      onProgress: opts.onProgress,
      runChunk: (start, end) => {
        for (let i = start; i < end; i++) {
          const m = midOk ? mid[i] : 0.5 * (left[i] + right[i]);
          let g = Math.abs(m) > 1e-8 ? cleanMono[i] / m : 0;
          if (g < 0) g = 0;
          else if (g > 1.35) g = 1.35;
          cleanL[i] = left[i] * g;
          cleanR[i] = right[i] * g;
        }
      },
    });
    return [cleanL, cleanR];
  }

  /**
   * Apply the two stereo-only Engineer controls after a mono ML stem has been
   * expanded back to L/R. This is O(N), chunked, and deliberately avoids a
   * second STFT/iSTFT. Mono input has no truthful phase/crosstalk consumer, so
   * runtime telemetry reports it as unavailable instead of claiming success.
   * @param {Float32Array[]} channels
   * @param {object} processingConfig
   */
  async _applyMlPostStemControls(channels, processingConfig) {
    const post = processingConfig?.postStem || {};
    const phase = Math.max(0, Math.min(1, Number(post.phaseCorr || 0) / 100));
    const crosstalk = Math.max(0, Math.min(1, Number(post.crosstalkCancel || 0) / 100));
    const requested = phase > 0 || crosstalk > 0;
    const revision = processingConfig?.revision || null;
    const status = {
      revision,
      phaseCorr: phase > 0 ? 'pending' : 'not-requested',
      crosstalkCancel: crosstalk > 0 ? 'pending' : 'not-requested',
    };
    if (!requested) {
      this._engineerPostStemStatus = status;
      return status;
    }
    if (!channels?.[0] || !channels?.[1] || channels[0] === channels[1]) {
      if (phase > 0) status.phaseCorr = 'unavailable-mono';
      if (crosstalk > 0) status.crosstalkCancel = 'unavailable-mono';
      this._engineerPostStemStatus = status;
      return status;
    }
    const left = channels[0];
    const right = channels[1];
    const total = Math.min(left.length, right.length);
    const signal = this._processAbortSignal();
    await processInChunks({
      total,
      chunkSize: this._postMlChunkSamples(),
      signal,
      runChunk: (start, end) => {
        for (let i = start; i < end; i++) {
          const sourceL = left[i];
          const sourceR = right[i];
          let nextL = sourceL;
          let nextR = sourceR;
          if (crosstalk > 0) {
            const depth = crosstalk * 0.5;
            nextL = sourceL - depth * sourceR;
            nextR = sourceR - depth * sourceL;
          }
          if (phase > 0) {
            const mid = (nextL + nextR) * 0.5;
            nextL = nextL * (1 - phase) + mid * phase;
            nextR = nextR * (1 - phase) + mid * phase;
          }
          left[i] = nextL;
          right[i] = nextR;
        }
      },
    });
    if (phase > 0) status.phaseCorr = 'applied';
    if (crosstalk > 0) status.crosstalkCancel = 'applied';
    this._engineerPostStemStatus = status;
    try {
      globalThis.__vipEngineerRuntime = {
        ...(globalThis.__vipEngineerRuntime || {}),
        postStem: status,
      };
    } catch { /* telemetry is best-effort */ }
    return status;
  }

  /**
   * Apply the deterministic time-domain cleanup shared by fresh and durable
   * ML results. Durable storage intentionally keeps raw worker stems, so this
   * must run after clone/expand/post-stem controls on every cache path.
   */
  async _applyPostIsolationCleanup(channels, sampleRate) {
    try {
      this.updatePipelineProgress(19, 'Smoothing residual…', 90);
      this._logProgressDiag('dewhistle-start');
      await yieldToBrowser();
      await this._postIsolationDeWhistle(channels, sampleRate, {
        onProgress: (r) => {
          if (this.abortFlag) return;
          const pct = 90 + Math.round(Math.max(0, Math.min(1, r)) * 6); // 90→96
          this.updatePipelineProgress(19, 'Smoothing residual…', pct);
        },
      });
    } catch (dwErr) {
      const jobs = globalThis.__VIP_JOBS__;
      if (jobs?.isCancellationError?.(dwErr) || dwErr?.name === 'AbortError') throw dwErr;
      structuredLog('warn', '[VIP] post-isolation dewhistle skipped', { err: dwErr?.message });
    }
  }

  /**
   * Build the residual that is paired with the final clean stem in Live-Mix.
   *
   * MLWorker's residual is correct for its pre-main-thread clean stem. Stereo
   * expansion, post-stem controls, and de-whistling can subsequently mutate
   * clean, so retaining that older residual would make clean + noise describe
   * different processing states. Reconcile only at this playback boundary;
   * cached ML stems remain the immutable pre-post-processing artifacts.
   *
   * @param {Float32Array[]} clean final output clean channels
   * @param {AudioBuffer} sourceBuffer canonical input source at the same rate
   * @returns {Promise<Float32Array[]|null>}
   */
  async _reconcileLiveMixNoiseStem(clean, sourceBuffer) {
    if (!Array.isArray(clean) || !clean.length || !sourceBuffer
      || typeof sourceBuffer.getChannelData !== 'function') return null;
    const total = clean[0]?.length || 0;
    const sourceCount = Number(sourceBuffer.numberOfChannels) || 0;
    if (!total || !sourceCount || clean.length > sourceCount) return null;
    for (const channel of clean) {
      if (!(channel instanceof Float32Array) || channel.length !== total) return null;
    }

    const midSource = clean.length === 1 && sourceCount >= 2;
    const sourceChannels = midSource
      ? [sourceBuffer.getChannelData(0), sourceBuffer.getChannelData(1)]
      : clean.map((_, channel) => sourceBuffer.getChannelData(channel));
    if (sourceChannels.some((channel) => !channel || channel.length !== total)) return null;

    const residual = clean.map(() => new Float32Array(total));
    await processInChunks({
      total,
      chunkSize: this._postMlChunkSamples(),
      signal: this._processAbortSignal(),
      runChunk: (start, end) => {
        for (let i = start; i < end; i++) {
          if (midSource) {
            residual[0][i] = 0.5 * (sourceChannels[0][i] + sourceChannels[1][i]) - clean[0][i];
          } else {
            for (let channel = 0; channel < clean.length; channel++) {
              residual[channel][i] = sourceChannels[channel][i] - clean[channel][i];
            }
          }
        }
      },
    });
    try {
      globalThis.__vipEngineerRuntime = {
        ...(globalThis.__vipEngineerRuntime || {}),
        liveMixResidual: 'reconciled',
      };
    } catch { /* telemetry is best-effort */ }
    return residual;
  }

  /**
   * Offline ML isolation — BS-RNN vocals (DEFAULT_ML_CHAIN). Stereo files are
   * reduced to mid for a single inference pass (≈2× faster than per-channel).
   * @returns {Promise<boolean>} true when ML produced a non-passthrough result
   */
  async _runMLIsolationPipeline(fileSeq = this._fileSeq) {
    // Always isolate from the original upload — never re-ML a previous procBuffer.
    const buf = this.origBuffer || this.inputBuffer;
    if (!buf) return false;
    if (fileSeq !== this._fileSeq) return false;
    // Snapshot once per explicit Process. Offline/spectral controls cannot
    // truthfully alter already-iSTFT'd stems without another process pass.
    const processingConfig = buildMlProcessingConfig(
      this.getEffectiveParams(window.VIP_PARAMS || {}),
    );
    const processingRevision = processingConfig.revision;

    // Reprocess with retained stems: skip ONNX (audit P-04) unless forced.
    if (
      !this._forceMlRerun
      && this._stemFileSeq === fileSeq
      && this._stemProcessingRevision === processingRevision
      && this._cleanStemChannels?.length
      && this.outputBuffer
    ) {
      this.updatePipelineProgress(20, 'ML isolation (retained stems)', 90);
      try {
        await this._loadSeparationStemsToBridge();
      } catch { /* best-effort */ }
      structuredLog('info', '[VIP] ML isolation skipped — retained stems for this file');
      return true;
    }

    // Durable stem cache (OPFS/IDB) for library files — skip re-inference after reload.
    if (!this._forceMlRerun && this._libraryFileId) {
      try {
        const durable = await loadStemsDurable(
          this._libraryFileId,
          DEFAULT_ML_CHAIN,
          processingRevision,
        );
        if (durable?.clean?.length) {
          await this.ensureCtx();
          const { stemsToAudioBuffer } = await this._loadStemSeparationModule();
          // Durable cache stores immutable, pre-post-processing worker stems.
          // Clone before post-stem shaping/dewhistling so a cache hit equals a
          // fresh result and never mutates the retained cache backing.
          let clean = durable.clean.map((channel) => new Float32Array(channel));
          let noise = null;
          // Mid-only durable packs expand to mono; stereo expand if source is stereo.
          if (buf.numberOfChannels >= 2 && clean.length === 1) {
            this.updatePipelineProgress(18, 'Reconstructing stems (cache)…', 86);
            await yieldToBrowser();
            const plan = await this._mlChannelPlan(buf);
            const midCopy = plan.mid && !this._isMobileEngineer()
              ? new Float32Array(plan.mid)
              : null;
            clean = await this._expandMonoCleanToStereo(
              clean[0],
              midCopy || plan.mid,
              plan.left,
              plan.right,
            );
            await yieldToBrowser();
          }
          await this._applyMlPostStemControls(clean, processingConfig);
          await this._applyPostIsolationCleanup(clean, durable.sampleRate || buf.sampleRate);
          noise = await this._reconcileLiveMixNoiseStem(clean, buf);
          this.updatePipelineProgress(19, 'Building output…', 89);
          await yieldToBrowser();
          this.outputBuffer = stemsToAudioBuffer(this.ctx, clean, durable.sampleRate || buf.sampleRate);
          this.procBuffer = this.outputBuffer;
          this._stemFileSeq = fileSeq;
          this._stemProcessingRevision = processingRevision;
          // Processed channel copies are separate from the immutable raw cache artifact.
          this._cleanStemChannels = clean;
          this._noiseStemChannels = noise?.length ? noise : null;
          this._stemSampleRate = durable.sampleRate || buf.sampleRate;
          this._durableStemBacking = durable._backing || null;
          if (this._noiseStemChannels) {
            this.noiseBuffer = stemsToAudioBuffer(this.ctx, this._noiseStemChannels, this._stemSampleRate);
          } else {
            this.noiseBuffer = null;
          }
          await this._loadSeparationStemsToBridge().catch(() => {});
          this.updatePipelineProgress(20, 'ML isolation (disk cache)', 90);
          structuredLog('info', '[VIP] ML isolation from durable stem cache', {
            fileId: this._libraryFileId,
          });
          return true;
        }
      } catch (durErr) {
        structuredLog('warn', '[VIP] durable stem load failed', { err: durErr?.message });
      }
    }

    try {
      await this.ensureCtx();
      // Warmup may already run from handleFile — keep it in flight but never block
      // pipeline start on full ONNX compile (can take 30–120s on first load).
      void this._warmupMLModels().catch(() => {});
      const { separateStems, stemsToAudioBuffer } = await this._loadStemSeparationModule();
      await yieldToBrowser();
      const plan = await this._mlChannelPlan(buf);
      await yieldToBrowser();
      // Keep a non-transferred mid copy for stereo expand (worker detaches transfer list).
      // On mobile, skip midCopy when possible — expand recomputes mid from L/R (saves RAM).
      const midCopy = plan.expandStereo && plan.mid && !this._isMobileEngineer()
        ? new Float32Array(plan.mid)
        : null;
      const durSec = buf.duration || (buf.length / (buf.sampleRate || 48000));
      if (durSec > 90 || this._isMobileEngineer()) {
        this.showNotification?.(
          this._isMobileEngineer()
            ? 'Mobile fast isolation — Play original anytime while processing.'
            : `Long file (~${(durSec / 60).toFixed(1)} min) — fast adaptive isolation. Play original while this runs.`,
          'info',
        );
      }
      this.updatePipelineProgress(4, plan.expandStereo ? 'ML isolation (mid)…' : 'ML isolation…', 15);
      this._logProgressDiag('ml-isolation-start');
      // Always single fast model (bsrnn) — never chain demucs on engineer default path.
      const result = await separateStems(plan.channelData, buf.sampleRate, {
        modelIds: DEFAULT_ML_CHAIN,
        sourceName: this._sourceName || '',
        processingConfig,
        // Owned Float32Arrays from _mlChannelPlan — transfer, don't re-copy.
        transferOwned: true,
        signal: this._processAbortSignal(),
        onProgress: (ev) => {
          if (fileSeq !== this._fileSeq || this.abortFlag) return;
          const workerPct = Number(ev.percent);
          const mapped = this._mapMlProgressPercent(
            Number.isFinite(workerPct) ? workerPct : 0,
          );
          if (ev.type === 'stage') {
            const label = ev.label || `ML: ${ev.stage} (${ev.modelId || 'model'})…`;
            this.updatePipelineProgress(4, label, mapped);
            this._logProgressDiag('ml-worker-stage', {
              workerStage: ev.stage || null,
              workerPct: Number.isFinite(workerPct) ? workerPct : null,
              mappedPct: mapped,
              provider: ev.backend || null,
            });
          } else if (ev.type === 'progress') {
            this.updatePipelineProgress(4, 'ML isolation…', mapped);
          }
        },
      });
      this._logProgressDiag('ml-isolation-end', {
        end: true,
        backend: result.backend || null,
        fromCache: Boolean(result.fromCache),
      });
      if (fileSeq !== this._fileSeq) return false;
      if (result.passthrough) return false;
      if (result.appliedProcessingConfigRevision !== processingRevision) {
        throw new Error('[VIP] ML worker did not acknowledge the Engineer processing snapshot');
      }
      try {
        globalThis.__vipEngineerRuntime = {
          ...(globalThis.__vipEngineerRuntime || {}),
          processingConfigRevision: processingRevision,
          mlSpectral: 'applied',
        };
      } catch { /* telemetry is best-effort */ }

      // Post-ML reconstruct — cooperative on Electron + Android (never pin at 88%).
      this._throwIfProcessAborted();
      this.updatePipelineProgress(18, 'Reconstructing stems…', 82);
      this._logProgressDiag('reconstruct-start', { backend: result.backend || null });
      await yieldToBrowser();
      // Keep result.clean immutable for durable cache persistence. The output
      // copy receives expansion, post-stem controls, and dewhistling.
      let clean = result.clean.map((channel) => new Float32Array(channel));
      if (plan.expandStereo && clean?.[0] && plan.left && plan.right) {
        this.updatePipelineProgress(18, 'Expanding stereo…', 83);
        await yieldToBrowser();
        clean = await this._expandMonoCleanToStereo(
          clean[0],
          midCopy || plan.mid,
          plan.left,
          plan.right,
          {
            onProgress: (r) => {
              if (this.abortFlag) return;
              const pct = 82 + Math.round(Math.max(0, Math.min(1, r)) * 8); // 82→90
              this.updatePipelineProgress(18, 'Expanding stereo…', pct);
            },
          },
        );
      }
      await this._applyMlPostStemControls(clean, processingConfig);
      this._throwIfProcessAborted();
      await yieldToBrowser();
      await this._applyPostIsolationCleanup(clean, result.sampleRate || buf.sampleRate);
      this._throwIfProcessAborted();
      this.updatePipelineProgress(19, 'Building output…', 96);
      this._logProgressDiag('build-output');
      await yieldToBrowser();
      this.outputBuffer = stemsToAudioBuffer(this.ctx, clean, result.sampleRate);
      this.procBuffer = this.outputBuffer;
      this._stemFileSeq = fileSeq;
      this._stemProcessingRevision = processingRevision;
      // Retain residual/noise stem for Live-Mix isolation refinements (bgSuppress).
      // Separation once → isolation sliders only rebalance stems (never re-ML).
      try {
        const noise = await this._reconcileLiveMixNoiseStem(clean, buf);
        if (noise?.length && noise[0]?.length) {
          this.noiseBuffer = stemsToAudioBuffer(this.ctx, noise, result.sampleRate || buf.sampleRate);
          // Keep references without cloning when arrays are already owned.
          this._cleanStemChannels = clean;
          this._noiseStemChannels = noise;
          this._stemSampleRate = result.sampleRate || buf.sampleRate;
        } else {
          this.noiseBuffer = null;
          this._cleanStemChannels = clean;
          this._noiseStemChannels = null;
          this._stemSampleRate = result.sampleRate || buf.sampleRate;
        }
      } catch (stemErr) {
        structuredLog('warn', '[VIP] noise stem retain failed', { err: stemErr?.message });
        this._cleanStemChannels = clean;
        this._noiseStemChannels = null;
      }
      // Keep origBuffer as the ML source of truth for subsequent reprocess/cache keys.
      if (!this.origBuffer) this.origBuffer = buf;
      // Load separation stems into Live-Mix so isolation sliders refine immediately.
      try {
        this.updatePipelineProgress(20, 'Loading Live-Mix…', 97);
        this._logProgressDiag('live-mix-load');
        await yieldToBrowser();
        await this._loadSeparationStemsToBridge();
      } catch (loadErr) {
        structuredLog('warn', '[VIP] stem Live-Mix load deferred', { err: loadErr?.message });
      }
      const mlLabel = result.fromCache ? 'ML isolation (cached)' : 'ML isolation complete';
      this.updatePipelineProgress(20, mlLabel, 98);
      this._logProgressDiag('ml-path-ready');
      if (this._libraryFileId) {
        FileLibrary.updateFileMeta(this._libraryFileId, {
          processingStatus: 'processed',
          analysisCacheKey: this._lastFullAnalysis
            ? `an:${this._libraryFileId}:${Date.now()}`
            : null,
        }).then(() => refreshLibraryList(this)).catch(() => {});
        // Persist mid-channel stems (pre-expand) off the critical path; size-capped.
        const durableClean = result.clean;
        const durableNoise = result.noise;
        const sampleRate = result.sampleRate || buf.sampleRate;
        const schedule = globalThis.requestIdleCallback
          || ((cb) => setTimeout(cb, 250));
        schedule(() => {
          if (fileSeq !== this._fileSeq) return;
          void saveStemsDurable(this._libraryFileId, DEFAULT_ML_CHAIN, {
            clean: durableClean,
            noise: durableNoise,
            sampleRate,
          }, processingRevision).catch((err) => {
            structuredLog('warn', '[VIP] durable stem save failed', { err: err?.message });
          });
        });
      }
      structuredLog('info', '[VIP] ML isolation done', {
        fromCache: Boolean(result.fromCache),
        channels: clean.length,
        midOnly: plan.expandStereo,
        samples: clean[0]?.length || 0,
        hasNoiseStem: Boolean(this._noiseStemChannels?.length),
      });
      return true;
    } catch (err) {
      structuredLog('warn', '[VIP] ML isolation unavailable, falling back to DSP', { err: err.message });
      // Surface stall/timeout so the user knows DSP fallback is starting.
      if (/stall|timeout/i.test(err.message || '')) {
        this.updatePipelineProgress(10, 'ML stalled — classical DSP fallback…', Math.max(this._pipelinePct || 20, 40));
        this.showNotification('ML isolation stalled — finishing with classical DSP', 'warn');
      }
      return false;
    }
  }

  // Full offline DSP chain (fallback when ML is unavailable). Capabilities are
  // wired to window.VIP_PARAMS via DSPCore. Performance: process mid only on
  // multi-channel sources (one STFT path), FFT 2048 / hop 512 for Engineer speed.
  // @param {AudioBuffer} [sourceBuf] — pass-local source (orig or prior proc for multi-pass)
  async _runFallbackPipeline(sourceBuf) {
    const buf = sourceBuf || this.origBuffer || this.inputBuffer;
    if (!buf) return;

    // ML may have succeeded for an earlier Process. A fallback output is not a
    // compatible stem pair, so invalidate it before any passthrough/DSP return
    // can hand stale audio to the Live-Mix bridge.
    this._stemFileSeq = null;
    this._stemProcessingRevision = null;
    this._cleanStemChannels = null;
    this._noiseStemChannels = null;
    this._stemSampleRate = null;
    this._durableStemBacking = null;
    this.noiseBuffer = null;
    this._bridgeBuf = null;
    this.liveChainBuilt = false;
    try { this._bridge?.stop?.(); } catch { /* best-effort */ }

    await this.ensureCtx();
    const DSP = this._resolveDSP();
    // Discipline/coupling soft-clamps — effective only; UI sliders stay put.
    const p = { ...this.getEffectiveParams(window.VIP_PARAMS || {}), __effective: true };
    const sr = buf.sampleRate;
    const nCh = buf.numberOfChannels;
    const len = buf.length;

    if (!DSP || !this.ctx || typeof this.ctx.createBuffer !== 'function') {
      // No DSP runtime — passthrough so playback still works.
      this.procBuffer = buf;
      this.outputBuffer = buf;
      return;
    }

    // Stereo → process mid once (halves STFT + spectral cost). Re-expand at end.
    const processStereoAsMid = nCh >= 2;
    let channels;
    // Mobile / Electron: cooperative mid build — never pin UI during fallback.
    const signal = this._processAbortSignal();
    const postChunk = this._postMlChunkSamples();
    if (processStereoAsMid) {
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      const mid = new Float32Array(len);
      this.updatePipelineProgress(3, 'Preparing mid channel…', 8);
      await processInChunks({
        total: len,
        chunkSize: postChunk,
        signal,
        onProgress: (r) => {
          if (this.abortFlag) return;
          this.updatePipelineProgress(3, 'Preparing mid channel…', 8 + Math.round(r * 4));
        },
        runChunk: (start, end) => {
          for (let i = start; i < end; i++) {
            mid[i] = 0.5 * (L[i] + R[i]);
          }
        },
      });
      channels = [mid];
      this._dspStereoSources = { L, R, mid };
    } else {
      channels = [buf.getChannelData(0).slice()];
      this._dspStereoSources = null;
    }
    this._throwIfProcessAborted();
    await yieldToBrowser();

    // ── Pass 1–2: input conditioning + time-domain cleanup ──
    // Order: DC → classical click removal → gate → de-ess.
    // removeClicks was previously implemented but never wired (audit residual pops).
    this.updatePipelineProgress(3, 'Conditioning input…', 8);
    for (let ch = 0; ch < channels.length; ch++) {
      let data = channels[ch];
      DSP.removeDCOffset(data, sr);
      // S07: click/pop repair (sensitivity 1–10; default 3). Always on for
      // classical path; lightweight O(N) median detector + Hermite fill.
      if (typeof DSP.removeClicks === 'function') {
        DSP.removeClicks(data, p.clickSensitivity ?? 3);
      }
      const gateThresh = p.gateThresh ?? -42;
      if (gateThresh > -80) {
        data = DSP.noiseGate(data, {
          threshold: gateThresh,
          range: p.gateRange ?? -60,
          attack: p.gateAttack ?? 5,
          release: p.gateRelease ?? 200,
          hold: p.gateHold ?? 50,
          lookahead: p.gateLookahead ?? 5,
        }, sr);
      }
      if ((p.deEssAmt ?? 0) > 0) DSP.deEss(data, p.deEssFreq ?? 6500, p.deEssAmt ?? 0, sr);
      // Process-boundary micro-fades (~8 ms) kill residual edge discontinuities.
      const fadeN = Math.min(Math.floor(data.length / 4), Math.round(0.008 * sr));
      for (let i = 0; i < fadeN; i++) {
        const g = i / Math.max(1, fadeN);
        data[i] *= g;
        data[data.length - 1 - i] *= g;
      }
      channels[ch] = data;
    }

    // ── Pass 3–5: Engineer spectral fallback ──────────────────────────────
    // MLWorker owns the fast fused production path. If it is unavailable, this
    // bounded single-STFT fallback is the real consumer for the same Process
    // snapshot—never silently downgrade Engineer controls into UI-only state.
    this.updatePipelineProgress(10, 'Spectral isolation (DSP fallback)…', 20);
    const regionMaps = {
      protect: this._protectRegions || [],
      suppress: this._suppressRegions || [],
    };
    for (let ch = 0; ch < channels.length; ch++) {
      if (this.abortFlag) break;
      channels[ch] = await this._spectralStageAsync(channels[ch], sr, p, (frac) => {
        const pct = 20 + Math.round(frac * 40);
        this.updatePipelineProgress(10, 'Spectral isolation (DSP fallback)…', pct);
      }, regionMaps) || channels[ch];
    }

    // Expand mono-processed mid back to stereo with gain envelope.
    if (processStereoAsMid && this._dspStereoSources) {
      const midProc = channels[0];
      const { L, R, mid } = this._dspStereoSources;
      channels = await this._expandMonoCleanToStereo(midProc, mid, L, R);
      this._dspStereoSources = null;
      await yieldToBrowser();
    }

    // S15 crosstalk (only when both channels were processed independently — skipped on mid path)
    if (channels.length >= 2 && (p.crosstalkCancel ?? 0) > 0) {
      this._applyStereoCrosstalk(channels, (p.crosstalkCancel ?? 0) / 100);
    }

    // ── Pass 7–8: filters, EQ, dynamics ──
    this.updatePipelineProgress(21, 'EQ + dynamics…', 70);
    for (let ch = 0; ch < channels.length; ch++) {
      this._eqDynamicsStage(channels[ch], sr, p);
    }
    await this._yield();

    // ── Pass 9: stereo image ──
    if (channels.length >= 2) {
      if ((p.phaseCorr ?? 0) > 0) this._applyPhaseCorrection(channels, (p.phaseCorr ?? 0) / 100);
      const widthPct = ((p.stereoWidth ?? 100) / 100) * ((p.outWidth ?? 100) / 100) * 100;
      if (Math.abs(widthPct - 100) > 0.5) {
        const w = DSP.stereoWiden(channels[0], channels[1], widthPct);
        channels[0] = w.left; channels[1] = w.right;
      }
    }

    // Assemble the processed AudioBuffer — cooperative; never pin live jobs at 88%.
    this._throwIfProcessAborted();
    this.updatePipelineProgress(28, 'Rendering output…', 90);
    this._logProgressDiag('fallback-render-start');
    await yieldToBrowser();
    const outCh = channels.length;
    let processed = this.ctx.createBuffer(outCh, len, sr);
    for (let ch = 0; ch < outCh; ch++) {
      const src = channels[ch];
      const dst = processed.getChannelData(ch);
      const copyLen = Math.min(len, src.length);
      await processInChunks({
        total: copyLen,
        chunkSize: postChunk,
        signal,
        onProgress: (r) => {
          if (this.abortFlag) return;
          const base = 90 + Math.round(((ch + r) / outCh) * 4); // 90→94
          this.updatePipelineProgress(28, 'Rendering output…', Math.min(94, base));
        },
        runChunk: (start, end) => {
          dst.set(src.subarray(start, end), start);
        },
      });
    }
    await yieldToBrowser();

    // S28 dry/wet blend with the untouched original.
    const dryWetPct = Math.max(0, Math.min(100, p.dryWet ?? 100));
    if (dryWetPct < 100) {
      this.updatePipelineProgress(28, 'Dry/wet blend…', 95);
      await yieldToBrowser();
      processed = this.mixDW(buf, processed, dryWetPct / 100);
    }

    // Output gain trim.
    const outGainDb = p.outGain ?? 0;
    if (outGainDb !== 0) {
      const gain = Math.pow(10, outGainDb / 20);
      for (let ch = 0; ch < processed.numberOfChannels; ch++) {
        const out = processed.getChannelData(ch);
        await processInChunks({
          total: out.length,
          chunkSize: postChunk,
          signal,
          runChunk: (start, end) => {
            for (let i = start; i < end; i++) out[i] *= gain;
          },
        });
      }
      await yieldToBrowser();
    }

    // Final brickwall safety limit. Dither is intentionally deferred to the
    // 16-bit encoder boundary so preview PCM stays deterministic and exports
    // are never dithered twice.
    this._throwIfProcessAborted();
    this.updatePipelineProgress(29, 'Output safety…', 97);
    await yieldToBrowser();
    this._applyOutputSafetyLimit(processed, p);
    await yieldToBrowser();
    this._logProgressDiag('fallback-render-end', { end: true });

    this.procBuffer = processed;
    this.outputBuffer = processed;
  }

  /**
   * Brickwall peak safety for export/playback buffers.
   * ML stems and aggressive makeup can exceed ±1; truePeakLimit keeps samples
   * within limThresh (default −1 dBFS). Mutates channel data in place.
   * @param {AudioBuffer} buf
   * @param {object} [params] optional slider map (uses limThresh)
   */
  _applyOutputSafetyLimit(buf, params) {
    if (!buf || typeof buf.numberOfChannels !== 'number') return buf;
    const DSP = this._resolveDSP?.() || (typeof globalThis !== 'undefined' ? globalThis.DSP : null);
    if (!DSP || typeof DSP.truePeakLimit !== 'function') {
      // Fallback hard clamp to full-scale if DSP core not loaded.
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const out = buf.getChannelData(ch);
        for (let i = 0; i < out.length; i++) {
          if (out[i] > 1) out[i] = 1;
          else if (out[i] < -1) out[i] = -1;
        }
      }
      return buf;
    }
    let p = params;
    if (!p) {
      try {
        p = (typeof this.getEffectiveParams === 'function')
          ? this.getEffectiveParams(this.params || {})
          : (this.params || {});
      } catch {
        p = this.params || {};
      }
    }
    const ceil = Math.min(Number.isFinite(p.limThresh) ? p.limThresh : -1, -0.1);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      DSP.truePeakLimit(buf.getChannelData(ch), ceil);
    }
    return buf;
  }

  /**
   * Async safety limit — yields between channels / long buffers so Electron
   * does not freeze at 98% during brickwall limiting.
   */
  async _applyOutputSafetyLimitAsync(buf, params) {
    if (!buf || typeof buf.numberOfChannels !== 'number') return buf;
    const DSP = this._resolveDSP?.() || (typeof globalThis !== 'undefined' ? globalThis.DSP : null);
    let p = params;
    if (!p) {
      try {
        p = (typeof this.getEffectiveParams === 'function')
          ? this.getEffectiveParams(this.params || {})
          : (this.params || {});
      } catch {
        p = this.params || {};
      }
    }
    const ceil = Math.min(Number.isFinite(p?.limThresh) ? p.limThresh : -1, -0.1);
    const signal = this._processAbortSignal();
    const CHUNK = this._postMlChunkSamples();
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      this._throwIfProcessAborted();
      const out = buf.getChannelData(ch);
      if (DSP && typeof DSP.truePeakLimit === 'function' && out.length <= CHUNK * 2) {
        DSP.truePeakLimit(out, ceil);
      } else if (DSP && typeof DSP.truePeakLimit === 'function') {
        // A subarray is a zero-copy view, so the limiter can be time-sliced
        // without allocating another full channel.  The previous single call
        // monopolised the renderer for long recordings at 98% progress.
        await processInChunks({
          total: out.length,
          chunkSize: CHUNK,
          signal,
          runChunk: (start, end) => {
            DSP.truePeakLimit(out.subarray(start, end), ceil);
          },
        });
      } else {
        await processInChunks({
          total: out.length,
          chunkSize: CHUNK,
          signal,
          runChunk: (start, end) => {
            for (let i = start; i < end; i++) {
              if (out[i] > 1) out[i] = 1;
              else if (out[i] < -1) out[i] = -1;
            }
          },
        });
      }
      await yieldToBrowser();
    }
    return buf;
  }

  // Yield to the event loop between heavy passes so the processing overlay /
  // spinner keeps animating and the page stays responsive.
  _yield() {
    return yieldToBrowser();
  }

  // ── Old process() alias ───────────────────────────────────────────────────
  async process() {
    return this.runPipeline();
  }

  // ── ML model loading ──────────────────────────────────────────────────────
  async loadModels() {
    const ort = (typeof window !== 'undefined' && window.ort) || (typeof globalThis !== 'undefined' && globalThis.ort);
    if (!ort || !ort.InferenceSession) {
      structuredLog('warn', '[VIP] ONNX Runtime unavailable');
      this._dspOnlyMode = true;
      window.VIP_ML_AVAILABLE = false;
      pill('engMlPill', 'unavailable');
      return null;
    }
    let session = null;
    try {
      ort.env.wasm.wasmPaths = './';
      // Try WebGPU first, fall back to WASM-only
      try {
        session = await ort.InferenceSession.create('./models/rnnoise_suppressor.onnx', {
          executionProviders: ['webgpu', 'wasm'],
        });
      } catch (_gpuErr) {
        session = await ort.InferenceSession.create('./models/rnnoise_suppressor.onnx', {
          executionProviders: ['wasm'],
        });
      }
      this._onnxSession = session;
      this._onnxReady = true;
      this._dspOnlyMode = false;
      window.VIP_ML_AVAILABLE = true;
      pill('engMlPill', 'ready');
      // Notify ml-worker of successful session setup
      if (this._mlWorker) {
        this._mlWorker.postMessage({ type: 'init', session, });
      }
      return session;
    } catch (err) {
      structuredLog('warn', '[VIP] ONNX load failed — DSP-only mode', { err: err.message });
      this._onnxReady = false;
      this._dspOnlyMode = true;
      window.VIP_ML_AVAILABLE = false;
      pill('engMlPill', 'unavailable');
      return null;
    }
  }

  // ── VAD ───────────────────────────────────────────────────────────────────
  async runVAD(buffer, params) {
    const p = params || window.VIP_PARAMS || {};
    try {
      const result = await this._mlCall({ type: 'vad', buffer: buffer.getChannelData(0).buffer }, [buffer.getChannelData(0).buffer.slice(0)]);
      return result;
    } catch (_) {
      // Fallback: simple energy-based VAD
      return this._simpleVAD(buffer, p);
    }
  }

  _simpleVAD(buffer, _p) {
    const d = buffer.getChannelData(0);
    const threshold = 0.01;
    const segments = [];
    for (let i = 0; i < d.length; i += 1024) {
      let rms = 0;
      const end = Math.min(i + 1024, d.length);
      for (let j = i; j < end; j++) rms += d[j] * d[j];
      rms = Math.sqrt(rms / (end - i));
      if (rms > threshold) segments.push({ start: i, end });
    }
    return segments;
  }

  // ── Source separation ─────────────────────────────────────────────────────
  async runSeparation(buffer, params) {
    const raw = params || window.VIP_PARAMS || {};
    const p = this.getEffectiveParams(raw);
    const iso = p.voiceIso || 80;
    try {
      const channelData = buffer.getChannelData(0);
      const transfer = channelData.buffer.slice(0);
      const result = await this._mlCall({ type: 'separate', buffer: transfer, voiceIso: iso }, [transfer]);
      return result;
    } catch (err) {
      structuredLog('warn', '[VIP] runSeparation failed, returning original', { err: err.message });
      return null;
    }
  }

  // ── ML call helper ────────────────────────────────────────────────────────
  _mlCall(payload, transfer = []) {
    return new Promise((resolve, reject) => {
      const worker = window._vipOrch && window._vipOrch.mlWorker;
      if (!worker) { reject(new Error('ML worker unavailable')); return; }
      const id = ++this._mlCallId;
      const handler = (e) => {
        if (e.data && e.data._id === id) {
          worker.removeEventListener('message', handler);
          resolve(e.data);
        }
      };
      worker.addEventListener('message', handler);
      payload._id = id;
      worker.postMessage(payload, transfer);
    });
  }

  // ── DSP spectral operations ───────────────────────────────────────────────

  applySpectralNR(spec, params) {
    const p = params || {};
    const amt = (p.nrAmount || 0) / 100;
    const sens = p.nrSensitivity || 60;
    const sub = p.nrSpectralSub || 50;
    for (let i = 0; i < spec.length; i++) {
      spec[i] *= (1 - amt * sens / 100);
      spec[i] *= (1 - (amt * sub / 100) * 0.1);
    }
  }

  applyBgSuppress(spec, pIn) {
    const p = pIn?.__effective ? pIn : this.getEffectiveParams(pIn || {});
    const g = 1 - (p.bgSuppress || 0) / 100;
    for (let i = 0; i < spec.length; i++) spec[i] *= g;
  }

  applyDereverb(spec, p) {
    const amt = (p.derevAmt || 0) / 100;
    const decay = (p.derevDecay || 50) / 100;
    for (let i = 0; i < spec.length; i++) spec[i] *= (1 - amt * decay);
  }

  applyFormantShift(spec, p) {
    if (!p.formantShift) return;
    // Formant shift via spectral envelope warping
    const shift = p.formantShift;
    if (Math.abs(shift) < 0.01) return;
  }

  applyPhaseCorr(spec, p) {
    if (!p.phaseCorr) return;
    // Compatibility hook for the process-time mono-correlation blend.
    const strength = (p.phaseCorr || 0) / 100;
    if (strength < 0.001) return;
  }

  applyCrosstalkCancel(spec, pIn) {
    const p = pIn?.__effective ? pIn : this.getEffectiveParams(pIn || {});
    if (!p.crosstalkCancel) return;
    // Crosstalk cancellation
    const strength = (p.crosstalkCancel || 0) / 100;
    if (strength < 0.001) return;
  }

  /**
   * Soft one-pole low-pass + light HF peak clamp after ML isolation.
   * Removes thin high-pitch residual without a full STFT pass (keeps speed).
   * Cooperative on Electron + Android so progress never sticks at ~88–90%.
   * @param {Float32Array[]} channels
   * @param {number} [sampleRate]
   * @param {{ onProgress?: (r: number) => void }} [opts]
   */
  async _postIsolationDeWhistle(channels, sampleRate = 48000, opts = {}) {
    if (!channels?.length) return;
    const sr = sampleRate || 48000;
    const mobile = this._isMobileEngineer?.() || false;
    const desktop = isDesktopShell();
    const n0 = channels[0]?.length || 0;
    // Very long clips: skip full dewhistle (main freeze source at 88–90%).
    if ((mobile || desktop) && n0 > 48000 * 180) {
      structuredLog('info', '[VIP] dewhistle skipped for long file', {
        samples: n0,
        desktop,
        mobile,
      });
      opts.onProgress?.(1);
      return;
    }
    // ~11 kHz cutoff — speech stays clear, whistle/hiss ring dies.
    const fc = 11000;
    const x = Math.exp(-2 * Math.PI * fc / sr);
    const a0 = 1 - x;
    const CHUNK = this._postMlChunkSamples();
    const signal = this._processAbortSignal();
    const chCount = channels.length;
    for (let ch = 0; ch < chCount; ch++) {
      const d = channels[ch];
      if (!d?.length) continue;
      let y = 0;
      let prev = 0;
      await processInChunks({
        total: d.length,
        chunkSize: CHUNK,
        signal,
        onProgress: (r) => {
          const overall = (ch + r) / chCount;
          opts.onProgress?.(overall);
        },
        runChunk: (start, end) => {
          for (let i = start; i < end; i++) {
            y = a0 * d[i] + x * y;
            const delta = y - prev;
            const limited = Math.max(-0.08, Math.min(0.08, delta));
            const out = prev + limited * 0.35 + (y - prev) * 0.65;
            prev = out;
            d[i] = out;
          }
        },
      });
      await yieldToBrowser();
    }
    opts.onProgress?.(1);
  }

  applyVoiceFocus(spec, p) {
    // Soft-mask bins outside the voice focus band
    const lo = p.voiceFocusLo || 120;
    const hi = p.voiceFocusHi || 3400;
    if (!lo && !hi) return;
    // This is a spectral-domain operation; bin indices depend on sample rate
    // Implementation deferred to pipeline-orchestrator
  }

  // ── In-place Cooley-Tukey FFT ─────────────────────────────────────────────
  _fft(re, im) {
    const n = re.length;
    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    // Butterfly passes
    for (let len = 2; len <= n; len <<= 1) {
      const wRe = Math.cos(-2 * Math.PI / len);
      const wIm = Math.sin(-2 * Math.PI / len);
      for (let i = 0; i < n; i += len) {
        let ur = 1, ui = 0;
        for (let j = 0; j < len / 2; j++) {
          const uRe = re[i + j + len / 2] * ur - im[i + j + len / 2] * ui;
          const uIm = re[i + j + len / 2] * ui + im[i + j + len / 2] * ur;
          re[i + j + len / 2] = re[i + j] - uRe;
          im[i + j + len / 2] = im[i + j] - uIm;
          re[i + j] += uRe;
          im[i + j] += uIm;
          const newUr = ur * wRe - ui * wIm;
          ui = ur * wIm + ui * wRe;
          ur = newUr;
        }
      }
    }
  }

  _ifft(re, im) {
    // Conjugate, forward FFT, conjugate, scale
    for (let i = 0; i < im.length; i++) im[i] = -im[i];
    this._fft(re, im);
    for (let i = 0; i < im.length; i++) im[i] = -im[i];
    const n = re.length;
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  _makeWindow(N) {
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / N));
    return w;
  }

  // ── Offline STFT / iSTFT (single-pass — Rule §1) ──────────────────────────
  // Exactly ONE forward STFT and ONE inverse STFT per offline processing path.
  // This method is the sole caller of DSP.forwardSTFT and DSP.inverseSTFT in app.js.

  _resolveDSP() {
    if (typeof globalThis !== 'undefined' && 'DSPCore' in globalThis) return globalThis.DSPCore || null;
    if (typeof window !== 'undefined' && 'DSPCore' in window) return window.DSPCore || null;
    return null;
  }

  // Median of five values — allocation-free (reuses scratch buffer).
  _median5(v0, v1, v2, v3, v4) {
    const s = this._median5Buf || (this._median5Buf = new Float32Array(5));
    s[0] = v0; s[1] = v1; s[2] = v2; s[3] = v3; s[4] = v4;
    for (let i = 1; i < 5; i++) {
      const v = s[i];
      let j = i;
      while (j > 0 && s[j - 1] > v) { s[j] = s[j - 1]; j--; }
      s[j] = v;
    }
    return s[2];
  }

  // S10–S20: spectral isolation on a single channel. Exactly ONE forward STFT
  // and ONE inverse STFT — the single-pass spectral contract (CLAUDE.md §1).
  // Desktop: FFT 2048 / hop 512 (75% COLA — flat w² envelope; audit F-03).
  // Forensic (whisperMode ≥ 2): full 4096 / 1024 for whisper recovery quality.
  // Mobile: smaller FFT + 50% hop → fewer frames (WebView freeze fix; quality tradeoff).
  // Async STFT yields so long files no longer freeze the browser tab.
  async _spectralStageAsync(data, sr, p, onProgress, regionMaps = null) {
    const DSP = this._resolveDSP();
    const whisperMode = Math.round(p.whisperMode ?? this.whisperMode ?? 0);
    const forensic = whisperMode >= 2;
    const mobile = this._isMobileEngineer();
    // Desktop Engineer: 75% overlap (hop = FFT/4). Mobile speed path: 50% hop.
    const FFT = forensic ? (mobile ? 2048 : 4096) : (mobile ? 1024 : 2048);
    const HOP = mobile ? Math.max(512, FFT / 2) : Math.max(256, FFT >> 2);
    try {
      globalThis.__vipStftBudget?.record?.('engineer-spectral', `N=${FFT} hop=${HOP}`);
    } catch { /* best-effort */ }
    const FRAME_CHUNK = forensic ? (mobile ? 48 : 128) : (mobile ? 64 : 256);
    if (!DSP || !data || data.length < FFT) return data;

    const yieldBudget = createYieldBudget(forensic ? (mobile ? 8 : 14) : (mobile ? 8 : 20));
    if (onProgress) onProgress(0.02);
    await yieldToBrowser();

    const stftOpts = {
      // Cooperative STFT: yield every N frames so long files never freeze the tab.
      yieldEvery: forensic ? (mobile ? 8 : 32) : (mobile ? 12 : 48),
      onProgress: (frac) => { if (onProgress) onProgress(0.02 + frac * 0.18); },
      shouldAbort: () => this.abortFlag,
    };
    const spec = typeof DSP.forwardSTFTAsync === 'function'
      ? await DSP.forwardSTFTAsync(data, FFT, HOP, stftOpts)
      : DSP.forwardSTFT(data, FFT, HOP);
    if (onProgress) onProgress(0.22);
    await yieldBudget();
    if (!spec || !Array.isArray(spec.mag) || spec.mag.length === 0) return data;
    const mag = spec.mag;
    const phase = spec.phase;
    const halfN = mag[0].length;
    const totalFrames = mag.length;

    const wm = this._getWhisperModeState();
    // Mode 0: full NR slider. Whisper modes scale OSF relative to Heavy (4.5).
    const nrScale = whisperMode > 0 ? (wm.osf / 4.5) : 1;
    const nrAmount = (p.nrAmount ?? 0) * nrScale;
    if (nrAmount > 0) {
      const noise = this._estimateNoiseFloor(mag);
      // Milder over-subtraction scale — high sens+sub was creating HF musical noise.
      const scale = 1 + (p.nrSensitivity ?? 48) / 100 * 0.35 + (p.nrSpectralSub ?? 35) / 100 * 0.35;
      for (let k = 0; k < noise.length; k++) noise[k] *= scale;
      DSP.wienerMMSE(mag, noise, nrAmount);
      await yieldBudget();
    }

    if ((p.nrFloor ?? -96) > -90) DSP.spectralGate(mag, p.nrFloor ?? -68, sr, HOP);
    this._applyVoiceFocus(mag, sr, p, halfN, FFT);
    // Cap smoothing — high values smear speech and cost CPU.
    const smooth = Math.min(45, p.nrSmoothing ?? 0);
    if (smooth > 0) DSP.temporalSmooth(mag, smooth);
    if (Math.abs(p.specTilt ?? 0) > 0.01) this._applySpectralTilt(mag, sr, p.specTilt, halfN, FFT);
    if (Math.abs(p.formantShift ?? 0) > 0.01) this._applyFormantShiftSpec(mag, p.formantShift, halfN);
    await yieldBudget();
    const derevTotal = Math.min(100, (p.derevAmt ?? 0) + (p.roomCorrection ?? 0) * 0.5);
    if (derevTotal > 0) {
      const decaySec = 0.12 + (p.derevDecay ?? 50) / 100 * 0.68;
      DSP.dereverb(mag, derevTotal, decaySec, sr, HOP);
    }
    if ((p.harmRecov ?? 0) > 0) {
      const orderScale = Math.max(1, Math.min(8, p.harmOrder ?? 3)) / 3;
      const maxBin = Math.floor(5500 / (sr / FFT));
      DSP.harmonicEnhance(mag, phase, (p.harmRecov ?? 0) * orderScale, { maxBin });
    }
    if ((p.breathControl ?? 0) > 0) this._applyBreathControl(mag, p.breathControl, halfN);
    if (Math.abs(p.transientShaper ?? 0) > 1) this._applyTransientShaper(mag, p.transientShaper);
    if ((p.subHarmonic ?? 0) > 0) this._applySubHarmonic(mag, sr, p, halfN, FFT);
    // Always kill thin high-pitch residual after spectral chain (whistle / smear).
    if (typeof DSP.deWhistle === 'function') {
      DSP.deWhistle(mag, sr, FFT, { cutHz: 7200, rollHz: 10500 });
    }
    await yieldBudget();

    // Ensure WhisperHunter instance exists when whisper mode is engaged.
    if (whisperMode > 0 && typeof ensureWhisperHunterInstance === 'function') {
      ensureWhisperHunterInstance(FFT, sr);
    }
    const runExtreme = this._extremeSpectralActive(p);
    const hunter = whisperMode > 0 && typeof window !== 'undefined' ? window._vipWhisperHunter : null;
    const mapUi = (typeof window !== 'undefined' && window.mapWhisperUi) ? window.mapWhisperUi : () => 0.5;
    const whParams = (whisperMode > 0 && hunter && typeof hunter.processMagnitudes === 'function') ? {
      clarity: mapUi(p.whisperClarity ?? 65),
      sensitivity: mapUi(p.whisperSensitivity ?? 55),
      threshold: mapUi(p.whisperThreshold ?? 50),
      harmonic: Math.pow(Math.max(0, (p.harmRecov ?? 0)) / 100, 2),
    } : null;

    // Noise profile for extreme path only (skip full-frame scan on the fast path).
    if (runExtreme) this._extremeNoiseProfile = this._estimateNoiseFloor(mag);

    if (runExtreme || whParams) {
      for (let f0 = 0; f0 < totalFrames; f0 += FRAME_CHUNK) {
        if (this.abortFlag) return data;
        const f1 = Math.min(totalFrames, f0 + FRAME_CHUNK);
        if (runExtreme) this._applyExtremeSpectralOffline(mag, sr, p, halfN, FFT, HOP, DSP, f0, f1);
        if (whParams) {
          for (let f = f0; f < f1; f++) hunter.processMagnitudes(mag[f], phase[f], whParams);
        }
        if (onProgress) onProgress(0.25 + 0.55 * (f1 / totalFrames));
        await yieldBudget();
      }
    } else if (onProgress) {
      onProgress(0.80);
    }

    if (onProgress) onProgress(0.85);
    await yieldToBrowser();
    const rendered = typeof DSP.inverseSTFTAsync === 'function'
      ? await DSP.inverseSTFTAsync(mag, phase, FFT, HOP, data.length, {
        yieldEvery: forensic ? (mobile ? 16 : 32) : (mobile ? 24 : 64),
        onProgress: (frac) => { if (onProgress) onProgress(0.85 + frac * 0.14); },
      })
      : DSP.inverseSTFT(mag, phase, FFT, HOP, data.length);
    if (onProgress) onProgress(1);
    if (!rendered || rendered.length !== data.length) return data;

    // Apply time-region masks from Analyze + WhisperHunter joint plan.
    // Protect regions (voice/whisper): blend some pre-spectral signal back to
    // reduce over-suppression. Suppress regions (noise/music): attenuate further.
    // SUPPRESS_MAX_ATTENUATION: 0.5 → up to 50% additional gain reduction (~-6 dB).
    const SUPPRESS_MAX_ATTENUATION = 0.5;
    const protect = regionMaps?.protect;
    const suppress = regionMaps?.suppress;
    if ((protect && protect.length) || (suppress && suppress.length)) {
      if (protect) {
        for (const region of protect) {
          const sStart = Math.max(0, Math.round(region.start * sr));
          const sEnd = Math.min(rendered.length, Math.round(region.end * sr));
          if (sEnd <= sStart) continue;
          const originalWeight = Math.min(0.45, (region.confidence ?? 0.5) * 0.45);
          const spectralWeight = 1 - originalWeight;
          for (let i = sStart; i < sEnd; i++) {
            rendered[i] = rendered[i] * spectralWeight + data[i] * originalWeight;
          }
        }
      }
      if (suppress) {
        for (const region of suppress) {
          const sStart = Math.max(0, Math.round(region.start * sr));
          const sEnd = Math.min(rendered.length, Math.round(region.end * sr));
          if (sEnd <= sStart) continue;
          const scale = 1 - Math.min(SUPPRESS_MAX_ATTENUATION, (region.confidence ?? 0.5) * SUPPRESS_MAX_ATTENUATION);
          for (let i = sStart; i < sEnd; i++) {
            rendered[i] *= scale;
          }
        }
      }
    }

    return rendered;
  }

  /**
   * Extreme isolation path is intentionally expensive (per-frame median/comb).
   * Require meaningful engagement so standard presets stay on the fast path.
   */
  _extremeSpectralActive(p) {
    return (p.bassCrush ?? 0) >= 8
      || (p.musicKill ?? 0) >= 8
      || (p.crowdNull ?? 0) >= 8
      || (p.reverbStrip ?? 0) >= 80
      || (p.voiceTunnel ?? 0) >= 8
      || (p.whisperLift ?? 0) >= 2;
  }

  /** Attenuate HF on quiet frames (breath noise between phrases). */
  _applyBreathControl(mag, amount, halfN) {
    const strength = Math.max(0, Math.min(100, amount)) / 100;
    if (strength <= 0 || !mag.length) return;
    const hiStart = Math.floor(halfN * 0.45);
    for (let f = 0; f < mag.length; f++) {
      const frame = mag[f];
      let e = 0;
      for (let k = 1; k < halfN; k++) e += frame[k] * frame[k];
      e = Math.sqrt(e / halfN);
      if (e > 0.02) continue; // only quiet / between-phrase frames
      const atten = 1 - strength * 0.85;
      for (let k = hiStart; k < halfN; k++) frame[k] *= atten;
    }
  }

  /** Bipolar peak emphasis: + sharpens consonants, − softens plosives. */
  _applyTransientShaper(mag, amount) {
    const a = Math.max(-100, Math.min(100, amount)) / 100;
    if (Math.abs(a) < 0.01 || !mag.length) return;
    const halfN = mag[0].length;
    for (let f = 0; f < mag.length; f++) {
      const frame = mag[f];
      for (let k = 2; k < halfN - 2; k++) {
        const isPeak = frame[k] > frame[k - 1] && frame[k] > frame[k + 1]
          && frame[k] > frame[k - 2] && frame[k] > frame[k + 2];
        if (isPeak) frame[k] *= (1 + a * 0.45);
        else if (a < 0) frame[k] *= (1 - a * 0.08); // when softening peaks, slightly lift body
      }
    }
  }

  /** Mild low-band body lift for thin whispers (below voiceFocusLo). */
  _applySubHarmonic(mag, sr, p, halfN, fftSize) {
    const amount = Math.max(0, Math.min(100, p.subHarmonic ?? 0)) / 100;
    if (amount <= 0) return;
    const lo = p.voiceFocusLo ?? 120;
    const loBin = Math.max(1, Math.round(lo / (sr / fftSize)));
    const boost = 1 + amount * 0.55;
    for (let f = 0; f < mag.length; f++) {
      const frame = mag[f];
      for (let k = 1; k < loBin && k < halfN; k++) frame[k] *= boost;
    }
  }

  // [WHISPER UPDATE] Extreme isolation ops — in-place per STFT frame (offline path)
  _applyExtremeSpectralOffline(mag, sr, p, halfN, fftSize, hop, DSP, frameStart = 0, frameEnd = mag.length) {
    const bassCrush = p.bassCrush ?? 0;
    const musicKill = p.musicKill ?? 0;
    const crowdNull = p.crowdNull ?? 0;
    const reverbStrip = p.reverbStrip ?? 0;
    const snrFloor = p.snrFloor ?? -52;
    const whisperLift = Math.min(12, Math.max(0, p.whisperLift ?? 0));
    const voiceTunnel = p.voiceTunnel ?? 0;
    const wm = WHISPER_MODE_STATES[Math.round(p.whisperMode ?? 2)] || WHISPER_MODE_STATES[2];
    // Cap lift to avoid metallic / clipped offline forensic output
    const liftGain = Math.min(4.0, Math.pow(10, whisperLift / 20) * (wm.postGain || 1));

    if (!this._extremeCircularMag || this._extremeCircularMag[0].length !== halfN) {
      this._extremeCircularMag = Array.from({ length: 5 }, () => new Float32Array(halfN));
      this._extremeFrameIdx = 0;
    }
    const noiseProfile = this._extremeNoiseProfile || this._estimateNoiseFloor(mag);
    if (!this._extremeNoiseProfile) this._extremeNoiseProfile = noiseProfile;

    const bassCrushCutoff = Math.round((bassCrush / 100) * 0.045 * fftSize);
    const crowdLowBin = Math.round(200 / (sr / fftSize));
    const crowdHighBin = Math.round(2500 / (sr / fftSize));
    const crowdOSF = 1.5 + (crowdNull / 100) * 4.5;
    const crowdFloor = 0.005;
    const frameTimeSec = hop / sr;
    const rt60Sec = Math.max(reverbStrip / 1000, 0.001);
    const snrThresh = Math.pow(10, snrFloor / 20);
    const tunnelQ1 = 2 + (voiceTunnel / 100) * 8;
    const tunnelG1 = voiceTunnel * 0.12;
    const tunnelQ2 = 3 + (voiceTunnel / 100) * 6;
    const tunnelG2 = voiceTunnel * 0.08;

    if (frameStart === 0 || !this._extremeMaskGains || this._extremeMaskGains.length !== halfN) {
      const maskGains = new Float32Array(halfN);
      for (let k = 0; k < halfN; k++) {
        let mask = 1;
        if (DSP && typeof DSP.getVoiceMaskGain === 'function') {
          mask = DSP.getVoiceMaskGain(k, sr, fftSize);
        }
        maskGains[k] = mask > 0.55 ? liftGain : Math.max(wm.maskFloor, mask);
      }
      this._extremeMaskGains = maskGains;
      if (voiceTunnel > 0) {
        const tunnelGains = new Float32Array(halfN);
        const lowCut = 300 + (200 * voiceTunnel / 100);
        const highCut = 3400 - (600 * voiceTunnel / 100);
        for (let k = 0; k < halfN; k++) {
          const hz = k * sr / fftSize;
          let g = 1;
          const d1 = Math.abs(hz - 1200) / (1200 / tunnelQ1);
          const d2 = Math.abs(hz - 2800) / (2800 / tunnelQ2);
          if (d1 < 1) g *= Math.pow(10, (tunnelG1 * (1 - d1)) / 20);
          if (d2 < 1) g *= Math.pow(10, (tunnelG2 * (1 - d2)) / 20);
          if (hz < lowCut || hz > highCut) g *= 0.85;
          tunnelGains[k] = g;
        }
        this._extremeTunnelGains = tunnelGains;
      } else {
        this._extremeTunnelGains = null;
      }
    }
    const maskGains = this._extremeMaskGains;
    const tunnelGains = this._extremeTunnelGains;

    const doBass = bassCrush >= 8;
    const doMusic = musicKill >= 8;
    const doCrowd = crowdNull >= 8;
    const doRev = reverbStrip >= 80;
    const doSnr = whisperLift >= 2 || doCrowd || doMusic; // snr floor only when lifting/isolating
    const musicAtten = 1 - musicKill / 100;
    const decayMask = Math.exp(-Math.log(1000) * frameTimeSec / rt60Sec);
    const revAmt = doRev ? (1 - decayMask) * 0.9 : 0;
    const revKeep = 1 - revAmt;

    for (let f = frameStart; f < frameEnd; f++) {
      const frame = mag[f];

      if (doBass && bassCrushCutoff > 0) {
        for (let k = 0; k < bassCrushCutoff; k++) frame[k] *= 0.0001;
      }

      // Music-kill median comb is the hottest loop — skip entirely when inactive.
      if (doMusic) {
        const bufIdx = this._extremeFrameIdx % 5;
        for (let k = 0; k < halfN; k++) {
          const med = this._median5(
            this._extremeCircularMag[0][k],
            this._extremeCircularMag[1][k],
            this._extremeCircularMag[2][k],
            this._extremeCircularMag[3][k],
            this._extremeCircularMag[4][k]
          );
          const ratio = frame[k] / (med + 1e-10);
          if (ratio < 1.3) frame[k] *= musicAtten;
        }
        this._extremeCircularMag[bufIdx].set(frame);
        this._extremeFrameIdx++;
      }

      if (doCrowd) {
        for (let k = crowdLowBin; k < crowdHighBin && k < halfN; k++) {
          const suppressed = frame[k] - crowdOSF * noiseProfile[k];
          frame[k] = Math.max(suppressed, crowdFloor * frame[k]);
        }
      }

      if (doRev && revAmt > 0.001) {
        for (let k = 0; k < halfN; k++) frame[k] *= revKeep;
      }

      if (doSnr) {
        for (let k = 0; k < halfN; k++) {
          if (frame[k] < snrThresh) frame[k] = 0;
        }
      }

      if (whisperLift >= 2) {
        for (let k = 0; k < halfN; k++) frame[k] *= maskGains[k];
      }
      if (tunnelGains) {
        for (let k = 0; k < halfN; k++) frame[k] *= tunnelGains[k];
      }
    }
  }

  // Per-bin stationary-noise estimate via minimum statistics (subsample frames for speed).
  _estimateNoiseFloor(mag) {
    const halfN = mag[0].length;
    const floor = new Float32Array(halfN).fill(Infinity);
    // Sample every Nth frame — full min-scan is O(frames×bins) and dominated long files.
    const step = mag.length > 400 ? 4 : mag.length > 150 ? 2 : 1;
    for (let f = 0; f < mag.length; f += step) {
      const frame = mag[f];
      for (let k = 0; k < halfN; k++) if (frame[k] < floor[k]) floor[k] = frame[k];
    }
    // Milder multiplier — 1.6× made Wiener dig holes → high-pitch musical noise.
    for (let k = 0; k < halfN; k++) floor[k] = Number.isFinite(floor[k]) ? floor[k] * 1.25 : 0;
    return floor;
  }

  // S14: keep the voice band (voiceFocusLo..Hi) plus the speech-shaped mask;
  // attenuate everything else by bgSuppress, weighted by voiceIso.
  // Uses effective (calibrated/coupled) values — never mutates UI sliders.
  _applyVoiceFocus(mag, sr, pIn, halfN, fftSize) {
    const p = pIn?.__effective ? pIn : this.getEffectiveParams(pIn || window.VIP_PARAMS || {});
    const DSP = this._resolveDSP();
    const iso = (p.voiceIso ?? 0) / 100;
    const bg = (p.bgSuppress ?? 0) / 100;
    if (iso <= 0 && bg <= 0) return;
    const lo = p.voiceFocusLo ?? 120;
    const hi = p.voiceFocusHi ?? 3400;
    const gains = new Float32Array(halfN);
    for (let k = 0; k < halfN; k++) {
      const freq = k * sr / fftSize;
      let g = 1;
      if (freq < lo || freq > hi) g *= (1 - bg * 0.92);
      if (iso > 0 && DSP && typeof DSP.getVoiceMaskGain === 'function') {
        const vm = DSP.getVoiceMaskGain(k, sr, fftSize);
        g *= (1 - iso) + iso * vm;
      }
      gains[k] = g;
    }
    for (let f = 0; f < mag.length; f++) {
      const frame = mag[f];
      for (let k = 0; k < halfN; k++) frame[k] *= gains[k];
    }
  }

  // S17: linear spectral tilt; +dB brightens (boost highs, cut lows), −dB darkens.
  _applySpectralTilt(mag, sr, tiltDb, halfN, fftSize) {
    const nyq = sr / 2;
    const gains = new Float32Array(halfN);
    for (let k = 0; k < halfN; k++) {
      const frac = (k * sr / fftSize) / nyq; // 0..1
      gains[k] = Math.pow(10, (tiltDb * (frac - 0.5)) / 20);
    }
    for (let f = 0; f < mag.length; f++) {
      const frame = mag[f];
      for (let k = 0; k < halfN; k++) frame[k] *= gains[k];
    }
  }

  // Formant shift: resample the magnitude envelope by 2^(st/12). Phase frames
  // are untouched so pitch is preserved while vocal character moves.
  _applyFormantShiftSpec(mag, semitones, halfN) {
    const factor = Math.pow(2, semitones / 12);
    if (!Number.isFinite(factor) || factor <= 0) return;
    const out = new Float32Array(halfN);
    for (let f = 0; f < mag.length; f++) {
      const src = mag[f];
      for (let k = 0; k < halfN; k++) {
        const pos = k / factor;
        const i0 = Math.floor(pos);
        if (i0 < 0 || i0 >= halfN) { out[k] = 0; continue; }
        const i1 = Math.min(i0 + 1, halfN - 1);
        const t = pos - i0;
        out[k] = src[i0] * (1 - t) + src[i1] * t;
      }
      src.set(out);
    }
  }

  // S15: cancel the bleed of each stereo channel into the other.
  _applyStereoCrosstalk(channels, amount) {
    const L = channels[0], R = channels[1];
    const n = Math.min(L.length, R.length);
    const k = Math.max(0, Math.min(1, amount)) * 0.5;
    const Lc = L.slice(), Rc = R.slice();
    for (let i = 0; i < n; i++) {
      L[i] = Lc[i] - k * Rc[i];
      R[i] = Rc[i] - k * Lc[i];
    }
  }

  // Mono-correlation blend — pull stereo content toward the shared midpoint so
  // the mix stays more stable when summed to mono. This does not estimate or
  // correct a channel time offset.
  _applyPhaseCorrection(channels, amount) {
    const L = channels[0], R = channels[1];
    const n = Math.min(L.length, R.length);
    const a = Math.max(0, Math.min(1, amount));
    for (let i = 0; i < n; i++) {
      const mid = (L[i] + R[i]) * 0.5;
      L[i] = L[i] * (1 - a) + mid * a;
      R[i] = R[i] * (1 - a) + mid * a;
    }
  }

  // S22–S25: HP/LP filters, 10-band parametric EQ, compressor, limiter.
  _eqDynamicsStage(data, sr, p) {
    const DSP = this._resolveDSP();
    if (!DSP) return data;

    // S22 high-pass / low-pass.
    const hpFreq = p.hpFreq ?? 20;
    if (hpFreq > 20) DSP.biquadProcess(data, DSP.biquadCoeffs('highpass', hpFreq, p.hpQ ?? 0.7, 0, sr));
    const lpFreq = p.lpFreq ?? 20000;
    if (lpFreq < 20000) DSP.biquadProcess(data, DSP.biquadCoeffs('lowpass', lpFreq, p.lpQ ?? 0.7, 0, sr));

    // S23 10-band parametric EQ.
    const eqBands = [
      ['eqSub', 40], ['eqBass', 120], ['eqWarmth', 300], ['eqBody', 700], ['eqLowMid', 1500],
      ['eqMid', 3000], ['eqPresence', 5000], ['eqClarity', 8000], ['eqAir', 13000], ['eqBrill', 18000],
    ].map(([id, freq]) => ({ freq, gain: p[id] ?? 0, Q: 1.0, type: 'peaking' }))
      .filter((b) => b.freq < sr / 2);
    DSP.parametricEQ(data, eqBands, sr);

    // S24 compressor (+ makeup gain).
    if ((p.compRatio ?? 1) > 1.01) {
      DSP.compress(data, {
        threshold: p.compThresh ?? -24,
        ratio: p.compRatio ?? 4,
        attack: p.compAttack ?? 10,
        release: p.compRelease ?? 150,
        knee: Math.max(0.5, p.compKnee ?? 6),
        makeup: p.compMakeup ?? 0,
      }, sr);
    } else if ((p.compMakeup ?? 0) > 0) {
      const g = Math.pow(10, (p.compMakeup ?? 0) / 20);
      for (let i = 0; i < data.length; i++) data[i] *= g;
    }

    // S25 limiter.
    DSP.truePeakLimit(data, p.limThresh ?? -1);
    return data;
  }

  // Live-microphone ingestion removed — upload-only workflow (CLAUDE.md §1.1).

  // ── Transport ─────────────────────────────────────────────────────────────

  /** Active playback buffer (honours A/B mode). */
  _getPlaybackBuffer() {
    if (this.abMode === 'processed') {
      return this.outputBuffer || this.procBuffer || this.inputBuffer || this.origBuffer || null;
    }
    return this.inputBuffer || this.origBuffer || null;
  }

  _getTransportDuration() {
    const bridgeDur = this._bridge?.duration?.();
    if (Number.isFinite(bridgeDur) && bridgeDur > 0) return bridgeDur;
    const buf = this._getPlaybackBuffer();
    return buf?.duration || 0;
  }

  _getTransportPosition() {
    const bridge = this._bridge;
    // Bridge clock is authoritative whenever it drives transport — including
    // the brief seek gap where mixer.isPlaying() is false but app.isPlaying is true.
    if (this._transportViaBridge && bridge && typeof bridge.currentTime === 'function') {
      return bridge.currentTime();
    }
    if (this.isPlaying && this.ctx && Number.isFinite(this.playStartTime)) {
      const speed = numFromInput(this.dom?.tpSpeed, 1) || 1;
      return this.playOffset + (this.ctx.currentTime - this.playStartTime) * speed;
    }
    return this.playOffset || 0;
  }

  /** Paint time readout + seek bar fill from seconds (not normalised fraction). */
  _paintTransport(cur, dur, opts = {}) {
    const { skipSeekValue = false } = opts;
    const clamped = Math.max(0, Math.min(cur, dur || 0));
    if (this.dom?.tpCur) this.dom.tpCur.textContent = this.fmtDur(clamped);
    if (this.dom?.tpSeek && dur > 0) {
      if (!skipSeekValue) this.dom.tpSeek.value = (clamped / dur) * 1000;
      if (typeof paintSeekFill === 'function') {
        paintSeekFill(this.dom.tpSeek, clamped, dur);
      } else if (this.dom.tpSeek.style?.setProperty) {
        const pct = Math.max(0, Math.min(100, (clamped / dur) * 100));
        const pctStr = `${pct}%`;
        this.dom.tpSeek.style.setProperty('--seek-pct', pctStr);
        if (this.dom.tpSeekFill) this.dom.tpSeekFill.style.width = pctStr;
      }
    }
  }

  _stopTransportClock() {
    if (!this._tickRaf) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._tickRaf);
    else clearTimeout(this._tickRaf);
    this._tickRaf = 0;
  }

  _startTransportClock() {
    if (this._tickRaf) return;
    const loop = () => {
      this._tickRaf = 0;
      if (!this.isPlaying) return;

      const dur = this._getTransportDuration();
      let cur = Math.min(this._getTransportPosition(), dur);

      if (!this._transportSeeking) {
        this.playOffset = cur;
        this._paintTransport(cur, dur);
        // Throttle playhead events ~30 Hz — full 60 Hz CustomEvent + canvas
        // restores was a major source of engineer-mode lag.
        const now = (typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now();
        if (!this._lastTransportTickEvt || now - this._lastTransportTickEvt >= 32) {
          this._lastTransportTickEvt = now;
          try {
            window.dispatchEvent(new CustomEvent('vip:transportTick', {
              detail: { position: cur, duration: dur },
            }));
          } catch (_) {}
        }
      }

      const bridge = this._bridge;
      const region = bridge?.getCropRegion?.() || { in: 0, out: dur };
      const looping = bridge?.isLoopEnabled?.();
      const naturalEnd = dur > 0 && bridge && !bridge.isPlaying()
        && !looping && cur >= (region.out ?? dur) - 0.05;

      if (naturalEnd) {
        this.isPlaying = false;
        this.playOffset = region.in || 0;
        this._paintTransport(this.playOffset, dur);
        this._updateTransportUI?.();
        try { window.dispatchEvent(new CustomEvent('vip:playStopped')); } catch (_) {}
        return;
      }

      if (looping && bridge && !bridge.isPlaying()) {
        this._tickRaf = (typeof requestAnimationFrame === 'function')
          ? requestAnimationFrame(loop)
          : setTimeout(loop, 50);
        return;
      }

      this._tickRaf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame(loop)
        : setTimeout(loop, 50);
    };
    this._tickRaf = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame(loop)
      : setTimeout(loop, 50);
  }

  /** FFT tap shared by visuals-bootstrap.js, neon pulse, and premium tabs. */
  _ensurePlaybackAnalyser() {
    const bridge = this._bridge;
    if (bridge && typeof bridge.getAnalyser === 'function') {
      const bridged = bridge.getAnalyser();
      if (bridged) {
        window._vipPlayAnalyser = bridged;
        return bridged;
      }
    }
    if (!this.ctx) return null;
    if (!this._playbackAnalyser) {
      try {
        this._playbackAnalyser = this.ctx.createAnalyser();
        // 1024 bins is enough for spectro/LUFS and halves analyser work vs 2048.
        this._playbackAnalyser.fftSize = 1024;
        this._playbackAnalyser.smoothingTimeConstant = 0.82;
      } catch (_) {
        return null;
      }
    }
    window._vipPlayAnalyser = this._playbackAnalyser;
    return this._playbackAnalyser;
  }

  _connectFallbackAnalyser(outNode) {
    const an = this._ensurePlaybackAnalyser();
    if (!an || !outNode || !this.ctx) return an;
    try {
      outNode.connect(an);
      if (!this._playbackAnalyserToDest) {
        an.connect(this.ctx.destination);
        this._playbackAnalyserToDest = true;
      }
    } catch (_) { /* chain may already be wired */ }
    return an;
  }

  _dispatchPlayStarted(extra) {
    const an = this._ensurePlaybackAnalyser();
    try {
      window.dispatchEvent(new CustomEvent('vip:playStarted', {
        detail: Object.assign({ analyser: an }, extra || {}),
      }));
    } catch (_) {}
  }

  _dispatchPlayStopped() {
    try { window.dispatchEvent(new CustomEvent('vip:playStopped')); } catch (_) {}
  }

  async play() {
    await this.ensureCtx();
    // Never block listening on ML — decode only, then play original if process still running.
    if (!(this.inputBuffer || this.origBuffer) && (this._sourceFile || this._libraryFileId)) {
      await this.ensureDecoded();
    }
    // While isolating, force original so user can audition immediately.
    const wantProcessed = this.abMode === 'processed' && !this.isProcessing;
    const buf = wantProcessed
      ? (this.outputBuffer || this.procBuffer || this.inputBuffer || this.origBuffer)
      : (this.inputBuffer || this.origBuffer);
    if (!buf) {
      this.showNotification?.('Decode audio first — drop a file, then press Play', 'warn');
      return;
    }

    // Wait for the Live-Mix bridge and worklets so rt:true sliders affect playback on first play.
    await this._ensureBridgeAndWorklets();

    this.isPlaying = true;
    this.playStartTime = this.ctx ? this.ctx.currentTime : 0;

    // PATCHED BY vip-fixes.js — consider merging
    if (this.dom && this.dom.tpABLabel) {
      this.dom.tpABLabel.textContent = this.abMode === 'processed' ? 'Processed' : 'Original';
    }

    await this.buildLiveChain(buf);

    if (this.isVideo && this.dom && this.dom.videoPlayer) {
      const vp = this.dom.videoPlayer;
      vp.currentTime = this.playOffset;
      vp.playbackRate = numFromInput(this.dom.tpSpeed, 1);
      vp.muted = true;
      vp.play && vp.play().catch(() => {});
    }

    this._dispatchPlayStarted({ bridgeRouted: !!(this._bridge && typeof this._bridge.getAnalyser === 'function') });
    if (typeof this.startSpectro === 'function') this.startSpectro();
    if (typeof this.startFreq === 'function') this.startFreq();
    if (typeof this._startTransportClock === 'function') this._startTransportClock();
    if (typeof this._updateTransportUI === 'function') this._updateTransportUI();
    if (typeof this.renderStaticVisuals === 'function') this.renderStaticVisuals(buf);
  }

  /**
   * Lazily load the real-time Live-Mix bridge (src/pipeline/EngineerModeBridge).
   * It shares this AudioContext so there is a single transport clock. Loaded by
   * dynamic import so any failure (CSP, missing module) degrades gracefully to
   * the offline Reprocess workflow rather than breaking Engineer Mode.
   * @returns {Promise<object|null>}
   */
  async _ensureBridge() {
    if (this._bridge) return this._bridge;
    if (this._bridgePromise) return this._bridgePromise;
    if (this._bridgeFailed || !this.ctx) return null;

    this._bridgePromise = (async () => {
      try {
        const mod = await import('/src/pipeline/EngineerModeBridge.js');
        this._bridge = new mod.EngineerModeBridge({ context: this.ctx });
        if (typeof window !== 'undefined' && mod.PARAM_MAP) {
          window._vipBridgeIds = Object.keys(mod.PARAM_MAP);
        }
        structuredLog('info', '[VIP] Live-Mix bridge ready — rt sliders are now real-time.');

        // Load gate/de-esser worklets lazily on first playback (not on upload).
        const paintWorkletPills = (st = {}) => {
          const map = (s) => (s === 'loaded' ? 'ready' : s === 'failed' ? 'error' : s === 'bypassed' ? 'unavailable' : 'loading');
          pill('engGatePill', map(st.gate?.state));
          pill('engDeessPill', map(st.deEsser?.state));
          const g = st.gate?.state;
          const d = st.deEsser?.state;
          if (g === 'failed' || d === 'failed') pill('engWorkletPill', 'error');
          else if ((g === 'loaded' || g === 'bypassed') && (d === 'loaded' || d === 'bypassed')) pill('engWorkletPill', 'ready');
          else pill('engWorkletPill', 'loading');
        };
        pill('engWorkletPill', 'loading');
        pill('engGatePill', 'loading');
        pill('engDeessPill', 'loading');
        if (this.ctx?.state === 'suspended') {
          try { await this.ctx.resume(); } catch { /* best-effort */ }
        }
        if (this._bridge.workletsReady) await this._bridge.workletsReady();
        const st = this._bridge.getWorkletStatus?.() || {};
        const gateOk = st.gate?.state === 'loaded' || st.gate?.state === 'bypassed';
        const deOk = st.deEsser?.state === 'loaded' || st.deEsser?.state === 'bypassed';
        this._workletReady = gateOk && deOk;
        paintWorkletPills(st);
        try { globalThis.__vipWorkletStatus = st; } catch { /* ignore */ }
        structuredLog('info', '[VIP] Playback worklets ready', st);
        if (!gateOk || !deOk) {
          structuredLog('warn', '[VIP] One or more worklets did not load', st);
        }

        return this._bridge;
      } catch (err) {
        this._bridgeFailed = true;
        this._workletReady = false;
        pill('engWorkletPill', 'error');
        pill('engGatePill', 'error');
        pill('engDeessPill', 'error');
        structuredLog('warn', '[VIP] Live-Mix bridge unavailable; sliders apply on Reprocess.', { err: err && err.message });
        return null;
      } finally {
        this._bridgePromise = null;
      }
    })();
    return this._bridgePromise;
  }

  async buildLiveChain(buf) {
    // Preferred path: play through the real-time Live-Mix bridge so every
    // rt:true slider is a live AudioParam (no Reprocess, no ML re-run).
    // When separation stems exist and we're playing processed, use stem-pair
    // so isolation sliders (voiceIso/bgSuppress) refine the residual balance.
    const bridge = this._bridge || await this._ensureBridge();
    if (bridge && (typeof bridge.loadBuffer === 'function' || typeof bridge.loadStemPair === 'function')) {
      try {
        const useStems = this.abMode === 'processed'
          && this._cleanStemChannels?.length
          && buf === (this.outputBuffer || this.procBuffer);
        if (this._bridgeBuf !== buf || (useStems && !bridge.hasNoiseStem?.())) {
          if (useStems && typeof bridge.loadStemPair === 'function') {
            bridge.loadStemPair(
              this._cleanStemChannels,
              this._noiseStemChannels || null,
              this._stemSampleRate || buf.sampleRate,
            );
          } else if (typeof bridge.loadBuffer === 'function') {
            bridge.loadBuffer(buf);
          }
          this._bridgeBuf = buf;
          this._transportRegionWired = false;
          this._syncBridgeParams();
          this.liveChainBuilt = true;
        }
        this._ensureTransportRegionWiring();
        // Honour the current scrub position, then start.
        this._ensurePlaybackAnalyser();
        this._transportViaBridge = true;
        Promise.resolve(bridge.seek(this.playOffset || 0))
          .then(() => bridge.play())
          .catch((err) => {
            structuredLog('warn', '[VIP] bridge play failed', { err: err && err.message });
          });
        this.currentSource = null;
        this._outGainNode = null;
        return;
      } catch (err) {
        structuredLog('warn', '[VIP] bridge buildLiveChain failed; using offline graph.', { err: err && err.message });
      }
    }

    // Kick off bridge init for next time if it is not ready yet.
    if (!bridge && !this._bridgeFailed) {
      this._ensureBridge();
    }

    this._transportViaBridge = false;

    // Fallback: direct AudioContext source node (offline-processed buffer).
    if (window._vipOrch && typeof window._vipOrch.buildLiveChain === 'function') {
      window._vipOrch.buildLiveChain(buf);
      return;
    }
    if (!this.ctx || typeof this.ctx.createBufferSource !== 'function') return;
    this.teardownChain();
    const p = window.VIP_PARAMS || {};
    const outGainDb = p.outGain ?? 0;
    const widthLinear = (p.outWidth ?? 100) / 100;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = numFromInput(this.dom && this.dom.tpSpeed, 1);
    const outGainNode = this.ctx.createGain();
    outGainNode.gain.value = Math.pow(10, outGainDb / 20);
    this._outGainNode = outGainNode;
    if (buf.numberOfChannels >= 2 && this.ctx.createChannelSplitter && this.ctx.createChannelMerger) {
      const splitter = this.ctx.createChannelSplitter(2);
      const merger = this.ctx.createChannelMerger(2);
      const mGain = (1 + widthLinear) / 2;
      const sGain = (1 - widthLinear) / 2;

      const lMain = this.ctx.createGain();
      const lCross = this.ctx.createGain();
      const rMain = this.ctx.createGain();
      const rCross = this.ctx.createGain();
      lMain.gain.value = mGain;
      lCross.gain.value = sGain;
      rMain.gain.value = mGain;
      rCross.gain.value = sGain;

      src.connect(splitter);
      splitter.connect(lMain, 0);
      splitter.connect(lCross, 1);
      splitter.connect(rMain, 1);
      splitter.connect(rCross, 0);
      lMain.connect(merger, 0, 0);
      lCross.connect(merger, 0, 0);
      rMain.connect(merger, 0, 1);
      rCross.connect(merger, 0, 1);
      merger.connect(outGainNode);
    } else {
      src.connect(outGainNode);
    }
    this._connectFallbackAnalyser(outGainNode);
    src.start(0, this.playOffset || 0);
    src.onended = () => {
      this.isPlaying = false;
      this.playOffset = 0;
      if (typeof this._updateTransportUI === 'function') this._updateTransportUI();
      this._dispatchPlayStopped();
    };
    this.currentSource = src;
  }

  pause() {
    if (!this.isPlaying) return;
    if (typeof this._getTransportPosition === 'function') {
      this.playOffset = this._getTransportPosition();
    } else {
      const speed = numFromInput(this.dom?.tpSpeed, 1);
      this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    }
    if (typeof this._stopTransportClock === 'function') this._stopTransportClock();
    this.teardownChain();
    if (typeof this.stopSpectro === 'function') this.stopSpectro();
    if (this.isVideo && this.dom.videoPlayer) this.dom.videoPlayer.pause();
    this.isPlaying = false;
    this._dispatchPlayStopped();
  }

  stop() {
    if (typeof this._stopTransportClock === 'function') this._stopTransportClock();
    this.teardownChain();
    if (this._bridge && typeof this._bridge.stop === 'function') {
      try { this._bridge.stop(); } catch (_) {}
    }
    this.isPlaying = false;
    this.playOffset = 0;
    if (typeof this.stopSpectro === 'function') this.stopSpectro();
    if (this.isVideo && this.dom && this.dom.videoPlayer) {
      this.dom.videoPlayer.pause();
      this.dom.videoPlayer.currentTime = 0;
    }
    if (typeof this._paintTransport === 'function') {
      this._paintTransport(0, typeof this._getTransportDuration === 'function' ? this._getTransportDuration() : 0);
    } else {
      if (this.dom?.tpCur) this.dom.tpCur.textContent = this.fmtDur(0);
      if (this.dom?.tpSeek) this.dom.tpSeek.value = 0;
    }
    if (typeof this._updateTransportUI === 'function') this._updateTransportUI();
    this._dispatchPlayStopped();
  }

  teardownChain() {
    // Bridge owns playback when active: capture position, then pause it.
    if (this._bridge && typeof this._bridge.isPlaying === 'function') {
      try {
        if (this._bridge.isPlaying()) {
          this.playOffset = this._bridge.currentTime();
          this._bridge.pause();
        }
      } catch { /* fall through to legacy teardown */ }
    }
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (_) {}
      try { this.currentSource.disconnect(); } catch (_) {}
      this.currentSource = null;
    }
    if (this._outGainNode) {
      try { this._outGainNode.disconnect(); } catch (_) {}
    }
    this._outGainNode = null;
  }

  async togglePlayback() {
    if (this._fixTransportPatched) {
      const tp = this.dom?.tpPlay || document.getElementById('tpPlay');
      if (tp) { tp.click(); return; }
    }
    this.ensureCtx();
    if (this.isPlaying) {
      this.pause();
      return;
    }
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (_) {}
      try { this.currentSource.disconnect(); } catch (_) {}
      this.currentSource = null;
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    this.play();
  }

  seekDelta(delta) {
    const dur = typeof this._getTransportDuration === 'function'
      ? this._getTransportDuration()
      : (this.inputBuffer || this.origBuffer)?.duration || 0;
    if (!dur) return;
    const pos = typeof this._getTransportPosition === 'function'
      ? this._getTransportPosition()
      : (this.playOffset || 0);
    const next = Math.max(0, Math.min(dur, pos + delta));
    return VoiceIsolatePro.prototype.seekTo.call(this, next / dur);
  }

  seekTo(frac) {
    const buf = typeof this._getPlaybackBuffer === 'function'
      ? this._getPlaybackBuffer()
      : (this.inputBuffer || this.origBuffer);
    if (!buf) return;
    const dur = buf.duration || 0;
    if (!dur) return;
    const target = Math.round(Math.max(0, Math.min(1, frac)) * dur * 1000) / 1000;
    const wasPlaying = this.isPlaying;

    this.playOffset = target;
    if (typeof this._paintTransport === 'function') {
      this._paintTransport(target, dur);
    } else {
      if (this.dom?.tpCur) this.dom.tpCur.textContent = this.fmtDur(target);
      if (this.dom?.tpSeek) this.dom.tpSeek.value = frac * 1000;
    }

    if (this.isVideo && this.dom?.videoPlayer) {
      this.dom.videoPlayer.currentTime = target;
    }

    const bridge = this._bridge;
    if (bridge && typeof bridge.seek === 'function') {
      Promise.resolve(bridge.seek(target)).catch(() => {});
    }

    if (wasPlaying && !this._fixTransportPatched) {
      this.play();
    }
  }

  /**
   * Instant original ↔ processed swap during playback (transport bar).
   * Sample-accurate: retains playhead; does not reload the file.
   * vip-fixes may own this path when _fixABPatched is set.
   */
  toggleAB() {
    if (this._fixABPatched) return;
    const buf = this.outputBuffer || this.procBuffer;
    if (!buf) return;
    if (this.isPlaying && typeof this._getTransportPosition === 'function') {
      this.playOffset = this._getTransportPosition();
    } else if (this.isPlaying) {
      const speed = numFromInput(this.dom.tpSpeed, 1);
      this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    }
    this._bridgeBuf = null;
    this.abMode = this.abMode === 'original' ? 'processed' : 'original';
    if (this.dom.tpAB) {
      if (this.dom.tpAB.classList && typeof this.dom.tpAB.classList.toggle === 'function') {
        this.dom.tpAB.classList.toggle('active', this.abMode === 'processed');
      }
      if (typeof this.dom.tpAB.setAttribute === 'function') {
        this.dom.tpAB.setAttribute('aria-pressed', this.abMode === 'processed' ? 'true' : 'false');
      }
    }
    if (this.dom.tpABLabel) {
      const isProc = this.abMode === 'processed';
      const labelText = isProc ? 'Processed' : 'Original';
      if (this.dom.tpABLabel.dataset) this.dom.tpABLabel.dataset.version = isProc ? 'B' : 'A';
      // Tests mock textContent; real DOM also gets structured A/B tags when possible.
      this.dom.tpABLabel.textContent = labelText;
      if (typeof Element !== 'undefined' && this.dom.tpABLabel instanceof Element) {
        this.dom.tpABLabel.innerHTML = isProc
          ? '<span class="tp-ab-tag">B</span><span class="tp-ab-name">Processed</span>'
          : '<span class="tp-ab-tag">A</span><span class="tp-ab-name">Original</span>';
      }
    }
    if (this.isPlaying) this.play();
    // Keep Voice/Noise/SNR in sync across every readout on A/B toggle.
    this.updateAudioMetrics(this._computeAudioMetricsState());
  }

  /**
   * Centralized Voice % / Noise % / SNR dB writer.
   * Computes once (or accepts precomputed state) and pushes to every DOM location.
   * @param {{ voicePct?: number, noisePct?: number, snrDb?: number }|null} [computedState]
   */
  updateAudioMetrics(computedState) {
    const state = computedState || this._computeAudioMetricsState() || this._lastMetricsState || {
      voicePct: null,
      noisePct: null,
      snrDb: null,
    };
    this._lastMetricsState = state;
    if (Number.isFinite(state.snrDb)) this.lastSNR = state.snrDb;

    const voiceTxt = Number.isFinite(state.voicePct) ? `${Math.round(state.voicePct)}%` : '--';
    const noiseTxt = Number.isFinite(state.noisePct) ? `${Math.round(state.noisePct)}%` : '--';
    const snrTxt = Number.isFinite(state.snrDb)
      ? `${state.snrDb >= 0 ? '+' : ''}${state.snrDb.toFixed(1)} dB`
      : '-- dB';
    const snrShort = Number.isFinite(state.snrDb)
      ? `${state.snrDb >= 0 ? '+' : ''}${state.snrDb.toFixed(1)}`
      : '--';

    const write = (id, text) => {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
      try {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
      } catch (_) { /* test sandboxes may lack DOM */ }
    };
    // Header badges
    write('hVoice', voiceTxt);
    write('hNoise', noiseTxt);
    write('hSNR', snrTxt);
    // Pipeline stat strip
    write('stat-voice', voiceTxt);
    write('stat-noise', noiseTxt);
    write('stat-snr', Number.isFinite(state.snrDb) ? `${snrShort} dB` : '--');
    // Neon pulse card
    write('np-stat-voice', Number.isFinite(state.voicePct) ? String(Math.round(state.voicePct)) : '--');
    write('np-stat-noise', Number.isFinite(state.noisePct) ? String(Math.round(state.noisePct)) : '--');
    write('np-stat-snr', Number.isFinite(state.snrDb) ? snrShort : '--');
    if (window.NeonPulseViz && typeof window.NeonPulseViz.updateStats === 'function') {
      window.NeonPulseViz.updateStats({
        voice: Number.isFinite(state.voicePct) ? state.voicePct : 0,
        noise: Number.isFinite(state.noisePct) ? state.noisePct : 0,
        snr: Number.isFinite(state.snrDb) ? snrShort : '--',
      });
    }
    return state;
  }

  /**
   * Derive Voice %, Noise %, SNR dB from current buffers / analysis once.
   */
  _computeAudioMetricsState() {
    const orig = this.origBuffer || this.inputBuffer;
    const proc = this.abMode === 'original'
      ? orig
      : (this.outputBuffer || this.procBuffer || orig);
    if (!orig || typeof orig.getChannelData !== 'function') {
      return this._lastMetricsState || { voicePct: null, noisePct: null, snrDb: null };
    }
    try {
      const o = orig.getChannelData(0);
      const p = (proc && proc.getChannelData) ? proc.getChannelData(0) : o;
      const n = Math.min(o.length, p.length);
      if (n < 32) return { voicePct: null, noisePct: null, snrDb: null };

      // Subsample for UI speed.
      const step = Math.max(1, Math.floor(n / 8000));
      let oRms = 0;
      let pRms = 0;
      let oCount = 0;
      let voiceEnergy = 0;
      let noiseEnergy = 0;
      for (let i = 0; i < n; i += step) {
        const ov = o[i];
        const pv = p[i];
        oRms += ov * ov;
        pRms += pv * pv;
        oCount += 1;
        // Proxy: residual |orig-proc| ≈ noise removed; retained energy ≈ voice.
        const resid = ov - pv;
        noiseEnergy += resid * resid;
        voiceEnergy += pv * pv;
      }
      if (!oCount) return { voicePct: null, noisePct: null, snrDb: null };
      oRms = Math.sqrt(oRms / oCount);
      pRms = Math.sqrt(pRms / oCount);
      const total = voiceEnergy + noiseEnergy + 1e-12;
      let voicePct = (voiceEnergy / total) * 100;
      let noisePct = (noiseEnergy / total) * 100;
      // Clamp + normalize to 100
      voicePct = Math.max(0, Math.min(100, voicePct));
      noisePct = Math.max(0, Math.min(100, 100 - voicePct));

      // SNR estimate: processed signal vs residual (noise proxy)
      const noiseRms = Math.sqrt(noiseEnergy / oCount) + 1e-10;
      const sigRms = pRms + 1e-10;
      let snrDb = 20 * Math.log10(sigRms / noiseRms);
      if (!Number.isFinite(snrDb)) snrDb = 0;
      snrDb = Math.max(-40, Math.min(60, snrDb));

      // Prefer analyzer profile when present.
      const env = this._lastEnvProfile || this.lastEnvProfile;
      if (env && Number.isFinite(env.voiceRatio)) {
        voicePct = Math.max(0, Math.min(100, env.voiceRatio * 100));
        noisePct = Math.max(0, Math.min(100, 100 - voicePct));
      }
      if (env && Number.isFinite(env.snrDb)) snrDb = env.snrDb;

      return { voicePct, noisePct, snrDb, oRms, pRms };
    } catch (_) {
      return this._lastMetricsState || { voicePct: null, noisePct: null, snrDb: null };
    }
  }

  _setScrubPos(frac) {
    if (this.dom && this.dom.tpSeek) this.dom.tpSeek.value = frac * 1000;
  }

  // ── Bypass ────────────────────────────────────────────────────────────────
  setBypass(on) {
    if (this.sharedParams) this.sharedParams[0] = on ? 1 : 0;
    const workletNode = window._vipOrch && window._vipOrch.workletNode;
    if (workletNode) workletNode.port.postMessage({ type: 'bypass', enabled: on });
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────
  startDiagnostics() {
    if (window._vipOrch && typeof window._vipOrch.startDiagnostics === 'function') {
      window._vipOrch.startDiagnostics();
    }
  }

  stopDiagnostics() {
    if (window._vipOrch && typeof window._vipOrch.stopDiagnostics === 'function') {
      window._vipOrch.stopDiagnostics();
    }
  }

  startSpectro() {
    if (window.VIP_VISUALS && typeof window.VIP_VISUALS.start === 'function') {
      window.VIP_VISUALS.start();
      return;
    }
    if (window._vipOrch && typeof window._vipOrch.startSpectro === 'function') {
      window._vipOrch.startSpectro();
    }
  }

  stopSpectro() {
    if (window.VIP_VISUALS && typeof window.VIP_VISUALS.stop === 'function') {
      window.VIP_VISUALS.stop();
      return;
    }
    if (window._vipOrch && typeof window._vipOrch.stopSpectro === 'function') {
      window._vipOrch.stopSpectro();
    }
  }

  startFreq() {
    if (window.VIP_VISUALS && typeof window.VIP_VISUALS.start === 'function') {
      window.VIP_VISUALS.start();
      return;
    }
    if (window._vipOrch && typeof window._vipOrch.startFreq === 'function') {
      window._vipOrch.startFreq();
    }
  }

  tickTime() {
    if (window._vipOrch && typeof window._vipOrch.tickTime === 'function') {
      window._vipOrch.tickTime();
      return;
    }
    this._startTransportClock();
  }

  // ── Notifications / Toast ─────────────────────────────────────────────────
  showNotification(msg, type = 'info', duration = 4000) {
    const region = document.getElementById('toastRegion');
    if (!region) return () => {};

    // Cap at 4 stacked toasts
    while (region.children.length >= 4) {
      if (region.firstChild) region.removeChild(region.firstChild);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    if (type === 'error') toast.setAttribute('role', 'alert');
    const msgNode = document.createElement('span');
    msgNode.textContent = msg;
    toast.appendChild(msgNode);
    region.appendChild(toast);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      setTimeout(() => {
        try { region.removeChild(toast); } catch (_) {}
      }, 220);
    };

    if (duration > 0) {
      setTimeout(dismiss, duration);
    }

    return dismiss;
  }

  _showToast(msg, type = 'info', duration = 4000) {
    return this.showNotification(msg, type, duration);
  }

  // ── Forensic audit ────────────────────────────────────────────────────────
  async addAuditEntry(buf, stageName) {
    if (!buf) return;
    try {
      const channelData = buf.getChannelData ? buf.getChannelData(0) : buf;
      const hash = await crypto.subtle.digest('SHA-256', channelData.buffer);
      const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      this.forensicLog.push({ stage: stageName, hash: hashHex, ts: Date.now() });
    } catch (err) {
      structuredLog('warn', '[VIP] addAuditEntry failed', { err: err.message });
    }
  }

  downloadAuditLog() {
    if (!this.forensicLog || this.forensicLog.length === 0) {
      this.showNotification('No forensic entries to download.', 'info');
      return;
    }
    const content = JSON.stringify(this.forensicLog, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vip-forensic-audit-' + Date.now() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // ── Meter / pipeline UI ───────────────────────────────────────────────────
  _updateMeters(peak, rms) {
    const fmt = v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB';
    this._setHeaderStat('hPeak', fmt(peak != null ? peak : -60));
    this._setHeaderStat('hRMS', fmt(rms != null ? rms : -60));
    const vuIn = document.querySelector('.vu-meter:nth-child(1)');
    const vuOut = document.querySelector('.vu-meter:nth-child(2)');
    const toLevel = v => Math.max(0, ((v + 60) / 60) * 100).toFixed(1) + '%';
    if (vuIn) vuIn.style.setProperty('--vu-level', toLevel(rms != null ? rms : -60));
    if (vuOut) vuOut.style.setProperty('--vu-level', toLevel(peak != null ? peak : -60));
  }

  _setPipeProgress(pct, label) {
    this.updatePipelineProgress(Math.round((pct / 100) * 32), label, pct);
  }

  _setHeaderStat(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  _updateProcessButtonsState() {
    // Deferred decode: pending _sourceFile OR library id (lazy hydrate) is enough.
    // Decode happens inside ensureDecoded() on Process/Analyze — never block the CTA.
    const hasSource = Boolean(
      this.inputBuffer || this.origBuffer || this._sourceFile || this._libraryFileId,
    );
    const hasOut = Boolean(this.outputBuffer || this.procBuffer);
    const busy = Boolean(this.isProcessing);
    if (this.dom.processBtn) this.dom.processBtn.disabled = !hasSource || busy;
    if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.disabled = !hasSource || busy;
    if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = !hasOut || busy;
    if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = !hasOut || busy;
    const heroCta = document.getElementById('heroCtaProcess');
    if (heroCta) heroCta.disabled = !hasSource || busy;
    // Play is allowed with a pending source (ensureDecoded on first play).
    if (this.dom.playBtn && !busy) {
      this.dom.playBtn.disabled = !hasSource;
    }
  }

  _getTransportMixer() {
    return this._bridge?.mixer || null;
  }

  _ensureTransportRegionWiring() {
    const mixer = this._getTransportMixer();
    if (!mixer || this._transportRegionWired) return;
    this._transportRegionWired = true;
    this._syncTransportRegion = wireTransportRegion({
      mixer,
      loopBtn: this.dom.tpLoop,
      cropInBtn: this.dom.tpCropIn,
      cropOutBtn: this.dom.tpCropOut,
      cropClearBtn: this.dom.tpCropClear,
      seekEl: this.dom.tpSeek,
      regionBar: this.dom.tpRegionBar,
    });
  }

  _updateTransportUI() {
    const buf = this._getPlaybackBuffer() || this.inputBuffer || this.origBuffer;
    const dur = this._getTransportDuration() || (buf ? buf.duration : 0);
    if (this.dom.tpDur) this.dom.tpDur.textContent = fmtTime(dur);
    const enabled = Boolean(buf);
    [this.dom.tpPlay, this.dom.tpPause, this.dom.tpStop, this.dom.tpRew,
     this.dom.tpFwd, this.dom.tpSeek, this.dom.tpAB,
     this.dom.tpLoop, this.dom.tpCropIn, this.dom.tpCropOut, this.dom.tpCropClear].forEach(b => {
      if (b) b.disabled = !enabled;
    });
    if (enabled) {
      this._ensureTransportRegionWiring();
      if (!this.isPlaying) this._paintTransport(this.playOffset || 0, dur);
    }
    this._syncTransportRegion?.();
  }

  // ── Pure utility methods (also used as instance methods) ──────────────────

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

  encWav(buf) {
    const nCh = buf.numberOfChannels;
    const sr = buf.sampleRate;
    const dL = buf.length * nCh * 2;
    const a = new ArrayBuffer(44 + dL);
    const v = new DataView(a);
    const ws = (o, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
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
    const chans = [];
    for (let ch = 0; ch < nCh; ch++) chans.push(buf.getChannelData(ch));
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

  mixDW(dry, wet, wAmt) {
    const nCh = Math.min(dry.numberOfChannels, wet.numberOfChannels);
    const len = Math.min(dry.length, wet.length);
    const sr = dry.sampleRate;
    const out = this.ctx.createBuffer(nCh, len, sr);
    for (let ch = 0; ch < nCh; ch++) {
      const dryData = dry.getChannelData(ch);
      const wetData = wet.getChannelData(ch);
      const outData = out.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        outData[i] = dryData[i] * (1 - wAmt) + wetData[i] * wAmt;
      }
    }
    return out;
  }

  peakNorm(buf, targetDb = -1) {
    const nCh = buf.numberOfChannels;
    const len = buf.length;
    let pk = 0;
    for (let ch = 0; ch < nCh; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const a = Math.abs(d[i]);
        if (a > pk) pk = a;
      }
    }
    if (pk === 0) return buf;
    const g = Math.pow(10, targetDb / 20) / pk;
    const out = this.ctx.createBuffer(nCh, len, buf.sampleRate);
    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch);
      const outp = out.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        outp[i] = Math.max(-1, Math.min(1, inp[i] * g));
      }
    }
    return out;
  }
}

// [WHISPER UPDATE] WhisperHunter AI — automatic extreme isolation orchestrator
// Collaborates with Source Analysis Workspace when app._lastFullAnalysis is set
// (protect speech/whisper zones; suppress music, horns, barks, crowd, etc.).
const WHISPER_HUNTER = {
  _running: false,

  async run(audioBuffer, app) {
    app = app || window._vipApp;
    if (!app || this._running) return;

    // Decode on demand when upload deferred decode (File only, no PCM yet).
    if ((!audioBuffer || !audioBuffer.getChannelData) && typeof app.ensureDecoded === 'function') {
      audioBuffer = await app.ensureDecoded();
    }
    if (!audioBuffer || !audioBuffer.getChannelData || !audioBuffer.length) {
      app.showNotification?.('Load an audio file first', 'warn');
      return;
    }

    this._running = true;
    const platformProfile = getWhisperPlatformProfile(detectWhisperPlatform());
    const detail = document.getElementById('pipeDetail');
    const analysis = app._lastFullAnalysis || null;
    const hasJoint = !!(analysis && (analysis.jointPlan || app._jointIsolationPlan || app._preferAnalysisForHunter));
    if (detail) {
      detail.textContent = hasJoint
        ? `WhisperHunter + Analyzer (${platformProfile.platform})…`
        : `WhisperHunter analyzing (${platformProfile.platform})…`;
    }

    try {
      const hunter = ensureWhisperHunterInstance(4096, audioBuffer.sampleRate);
      if (hunter && typeof hunter.seedNoiseFromAudio === 'function') {
        hunter.reset();
        // Prefer noise-only seeding when analyzer marked suppress zones (approximate: full seed still OK)
        hunter.seedNoiseFromAudio(audioBuffer.getChannelData(0), audioBuffer.sampleRate);
      }

      let envProfile = this.analyzeEnvironment(audioBuffer);
      // Fuse analyzer map when available (music / impulse / whisper / SNR)
      if (analysis?.jointPlan?.jointEnv) {
        envProfile = { ...envProfile, ...analysis.jointPlan.jointEnv, source: 'analyzer+hunter' };
      } else if (app._hunterEnvFromAnalysis) {
        envProfile = { ...envProfile, ...app._hunterEnvFromAnalysis, source: 'analyzer+hunter' };
      }

      // Prefer joint plan preset, then hunter heuristic
      let basePreset = this.selectPreset(envProfile, analysis);
      if (analysis?.jointPlan?.recommendedPreset) {
        basePreset = analysis.jointPlan.recommendedPreset;
      } else if (app._hunterSliderTargets?.preset) {
        basePreset = app._hunterSliderTargets.preset;
      }
      // resolvePresetNameLocal maps retired names → current catalog
      basePreset = resolvePresetNameLocal(basePreset);

      if (PRESETS[basePreset]) {
        app.applyPreset(basePreset);
        await app.morphSlidersTo(
          Object.fromEntries(
            Object.entries(PRESETS[basePreset]).filter(([k]) => k !== 'description')
          ),
          400
        );
      }

      const masks = await this.runDeepFilterNet(audioBuffer, app, platformProfile);
      const avgMaskConf = maskConfidence(masks);
      const separationScore = Math.max(0, Math.min(1, (1 - avgMaskConf) * 0.55 + (1 - (envProfile.speechPresence || 0.4)) * 0.45));

      // Slider targets: joint analyzer plan when present, else pure hunter heuristic
      let morph = null;
      if (app._hunterSliderTargets?.sliders) {
        morph = { ...app._hunterSliderTargets.sliders };
      } else if (analysis && typeof window !== 'undefined') {
        try {
          // Lazy import not needed — targets may already be on analysis.jointPlan
          const cfg = analysis.jointPlan?.recommendedStageConfig
            || analysis.recommendedStageConfig
            || analysis.recommendation?.recommendedStageConfig;
          if (cfg && Object.keys(cfg).length) {
            morph = {
              whisperClarity: Math.round(cfg.whisperClarity ?? (58 + separationScore * 32)),
              whisperSensitivity: Math.round(cfg.whisperSensitivity ?? (48 + (1 - (envProfile.voiceRatio || 0.3)) * 38)),
              whisperThreshold: Math.round(cfg.whisperThreshold ?? (42 + separationScore * 48)),
              harmRecov: Math.round(cfg.harmRecov ?? ((envProfile.voiceRatio || 0) < 0.25 ? 18 + separationScore * 22 : 8)),
              whisperLift: Math.round(cfg.whisperLift ?? (14 + separationScore * 24)),
              snrFloor: Math.round(cfg.snrFloor ?? (-78 + avgMaskConf * 26)),
              crowdNull: Math.round(cfg.crowdNull ?? (68 + separationScore * 28)),
              musicKill: Math.round(cfg.musicKill ?? (envProfile.dominantNoise === 'music' ? 82 + separationScore * 16 : 45 + separationScore * 20)),
              bassCrush: Math.round(cfg.bassCrush ?? (55 + (envProfile.musicRatio || 0) * 40)),
              reverbStrip: Math.min(1200, Math.round(cfg.reverbStrip ?? ((envProfile.rt60 || 400) * (0.85 + separationScore * 0.35)))),
              voiceTunnel: Math.round(cfg.voiceTunnel ?? (52 + avgMaskConf * 38)),
              voiceIso: Math.round(cfg.voiceIso ?? 85),
              bgSuppress: Math.round(cfg.bgSuppress ?? 55),
              nrAmount: Math.round(cfg.nrAmount ?? 60),
              humRemoval: Math.round(cfg.humRemoval ?? 0),
              derevAmt: Math.round(cfg.derevAmt ?? 0),
              whisperMode: cfg.whisperMode ?? (separationScore > 0.65 ? 3 : separationScore > 0.35 ? 2 : 1),
              transientShaper: Math.round(cfg.transientShaper ?? 12),
            };
          }
        } catch { /* fall through */ }
      }

      if (!morph) {
        morph = {
          whisperClarity: Math.round(58 + separationScore * 32),
          whisperSensitivity: Math.round(48 + (1 - (envProfile.voiceRatio || 0.3)) * 38),
          whisperThreshold: Math.round(42 + separationScore * 48),
          harmRecov: (envProfile.voiceRatio || 0) < 0.25 ? Math.round(18 + separationScore * 22) : 8,
          whisperLift: Math.round(14 + separationScore * 24),
          snrFloor: Math.round(-78 + avgMaskConf * 26),
          crowdNull: Math.round(68 + separationScore * 28),
          musicKill: envProfile.dominantNoise === 'music' ? Math.round(82 + separationScore * 16) : Math.round(45 + separationScore * 20),
          bassCrush: Math.round(55 + (envProfile.musicRatio || 0) * 40),
          reverbStrip: Math.min(1200, Math.round((envProfile.rt60 || 400) * (0.85 + separationScore * 0.35))),
          voiceTunnel: Math.round(52 + avgMaskConf * 38),
          whisperMode: separationScore > 0.65 ? 3 : separationScore > 0.35 ? 2 : 1,
        };
      }

      await app.morphSlidersTo(morph, 600);

      // Single pipeline pass keeps the UI responsive. WhisperMode still drives
      // spectral aggressiveness inside the offline path — multi-pass loops froze tabs.
      app._forceSinglePass = true;
      try {
        await app.runPipeline();
      } finally {
        app._forceSinglePass = false;
      }

      app._lastHunterEnv = envProfile;
      app._lastHunterMaskConf = avgMaskConf;
      app._lastHunterPlatform = platformProfile.platform;
      this.reportResults(envProfile, avgMaskConf, app, platformProfile, hasJoint);
    } finally {
      this._running = false;
    }
  },

  analyzeEnvironment(buffer) {
    return analyzeAcousticEnvironment(buffer);
  },

  selectPreset(envProfile, analysis) {
    // Analyzer joint plan wins when present
    if (analysis?.jointPlan?.recommendedPreset) return analysis.jointPlan.recommendedPreset;
    if (analysis?.recommendedPreset) return analysis.recommendedPreset;
    if (envProfile.dominantNoise === 'music' && envProfile.rt60 > 500) return 'Whisper in a Club';
    if (envProfile.dominantNoise === 'crowd' && envProfile.speechPresence < 0.35) return 'Stadium Crowd';
    if (envProfile.voiceRatio < 0.18) return 'Forensic Extract';
    if (envProfile.hasWhisper || (analysis?.whisperRegions || []).length) return 'Whisper Boost';
    if (envProfile.rt60 < 200) return 'Whisper Boost';
    if (envProfile.dominantNoise === 'traffic') return 'Surveillance';
    if (envProfile.dominantNoise === 'music') return 'Aggressive Isolate';
    return 'Whisper Boost';
  },

  async runDeepFilterNet(audioBuffer, app, platformProfile = getWhisperPlatformProfile()) {
    const masks = [];
    try {
      const worker = window._vipOrch && window._vipOrch.mlWorker;
      if (worker && app && platformProfile.mlEnabled) {
        const inferred = await chunkedMaskInference(audioBuffer, worker, {
          callIdBase: app._mlCallId || 0,
          maxChunks: platformProfile.maxChunks,
          timeoutMs: platformProfile.timeoutMs,
          chunkYieldMs: platformProfile.chunkYieldMs,
          mlEnabled: platformProfile.mlEnabled,
        });
        app._mlCallId = (app._mlCallId || 0) + platformProfile.maxChunks;
        if (inferred.length) return inferred;
      }
    } catch (err) {
      structuredLog('warn', '[WHISPER_HUNTER] ML inference fallback', { err: err && err.message });
    }
    if (!masks.length) {
      const env = analyzeAcousticEnvironment(audioBuffer);
      return buildHeuristicMask(env, 2049);
    }
    return masks;
  },

  async runForensicPasses(buffer, numPasses, app, envProfile = {}) {
    // Cap via platformProfile.forensicCap — full reprocess loops freeze multi-minute files.
    app = app || window._vipApp;
    const platformProfile = getWhisperPlatformProfile(detectWhisperPlatform());
    const forensicCap = Math.max(1, Number(platformProfile.forensicCap) || 1);
    const passes = Math.min(Math.max(1, Number(numPasses) || 1), forensicCap);
    void passes; // single spectral reprocess; multi-pass STFT loops are intentionally disabled
    const detail = document.getElementById('pipeDetail');
    if (detail) detail.textContent = 'WhisperHunter isolation (single pass)…';
    await app.morphSlidersTo({
      crowdNull: Math.min(100, Math.round(70 + (envProfile.speechPresence < 0.3 ? 20 : 0))),
      musicKill: Math.min(100, Math.round(envProfile.dominantNoise === 'music' ? 85 : 55)),
      whisperLift: 8,
      whisperThreshold: 62,
      voiceTunnel: 65,
      snrFloor: -72,
      whisperMode: Math.min(2, Math.max(1, Math.round(numPasses > 1 ? 2 : 1))),
    }, 200);
    app.inputBuffer = buffer;
    app._forceSinglePass = true;
    try {
      await app.runPipeline();
    } finally {
      app._forceSinglePass = false;
    }
    this.updateNoiseProfileFromBuffer(app.procBuffer || app.outputBuffer || buffer, app);
  },

  updateNoiseProfileFromBuffer(buffer, app) {
    if (!buffer || !app || !buffer.getChannelData) return;
    const hunter = ensureWhisperHunterInstance(4096, buffer.sampleRate);
    if (hunter && typeof hunter.seedNoiseFromAudio === 'function') {
      hunter.seedNoiseFromAudio(buffer.getChannelData(0), buffer.sampleRate);
    }
    app._extremeNoiseProfile = null;
  },

  reportResults(envProfile, avgMaskConf, app, platformProfile = getWhisperPlatformProfile(), collab = false) {
    app = app || window._vipApp;
    const detail = document.getElementById('pipeDetail');
    const voicePct = ((envProfile.voiceRatio || 0) * 100).toFixed(0);
    const maskPct = ((avgMaskConf || 0) * 100).toFixed(0);
    const prefix = collab ? 'Analyzer↔Hunter' : 'WhisperHunter';
    const extra = envProfile.unwantedPrimary ? ` · kill ${envProfile.unwantedPrimary}` : '';
    const msg = `${prefix} (${platformProfile.platform}): ${envProfile.dominantNoise} · voice ${voicePct}% · mask ${maskPct}% · RT60 ${envProfile.rt60}ms${extra}`;
    app._lastHunterMessage = msg;
    if (detail) detail.textContent = msg;
    if (app && typeof app.showNotification === 'function') {
      app.showNotification(msg, 'info');
    }
  },
};

if (typeof window !== 'undefined') {
  window.WHISPER_HUNTER = WHISPER_HUNTER;
}

// ---------------------------------------------------------------------------
// Module-level utility function exports
// ---------------------------------------------------------------------------
// clampToSliderExport and numFromInputExport removed - unused
// If needed by external code, use clampToSlider and numFromInput directly

if (typeof window !== 'undefined') {
  window.numFromInput = numFromInput;
  window.clampToSlider = clampToSlider;
  window.BRIDGE_RT_SLIDER_IDS = BRIDGE_RT_SLIDER_IDS;
}

// ---------------------------------------------------------------------------
// Register on window + CommonJS export
// ---------------------------------------------------------------------------
window.VoiceIsolatePro = VoiceIsolatePro;

if (typeof module !== 'undefined') module.exports = VoiceIsolatePro;

(function _vipBootstrap() {
  if (typeof VoiceIsolatePro === 'undefined') return;
  if (window._vipApp) return;
  // Skip when running outside a real browser (test VMs, new Function sandboxes, CommonJS)
  if (typeof document === 'undefined' || typeof document.readyState !== 'string') return;
  if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') return;

  function _callAuthInit() {
    if (typeof Auth !== 'undefined' && Auth && typeof Auth.init === 'function') {
      Auth.init().catch(function(e) {
        console.warn('[app] Auth.init() failed:', e);
      });
    }
  }

  function boot() {
    if (window._vipApp) return;
    var app = null;
    try {
      app = new VoiceIsolatePro();
      app.init();
      app._initCalled = true;
      window._vipApp = app;
      window.vip = app;
      console.info('[app] VoiceIsolatePro ready via app.js bootstrap');
    } catch (e) {
      console.error('[app] Bootstrap failed:', e);
      window._vipApp = null;
      window.vip = null;
      if (typeof window._vipDismissBootSplash === 'function') window._vipDismissBootSplash();
      if (typeof window._vipReportError === 'function') window._vipReportError('bootstrap', e);
    }
    _callAuthInit();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

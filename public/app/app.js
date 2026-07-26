/**
 * VoiceIsolate Pro — app.js  v24.0.0
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
 *   All spectral work delegated to pipeline-orchestrator.js.
 *   app.js provides DSP helpers used by the pipeline.
 *
 * 100 % local — no cloud APIs, no external fetch except /app/models/*.onnx.
 */

import { SLIDER_REGISTRY, STAGES } from './slider-map.js';
import { buildHintPanel, mountInfoPopover, removeAllInfoPopovers } from './slider-hint-ui.js';
import { decodeBlobToAudioBuffer } from '/src/pipeline/media-decode.js';
import { resampleToCanonical } from '/src/pipeline/FileIngestion.js';
import { createYieldBudget, yieldToBrowser } from '/src/pipeline/ui-yield.js';
import { sliceAudioBuffer } from '/src/core/audio-slice.js';
import { clearStemCache } from '/src/pipeline/MLStemCache.js';
import { resetTimings, stageEnd, stageStart } from '/src/pipeline/PipelineTiming.js';
import { paintSeekFill, wireTransportRegion } from '/src/presentation/TransportRegionControls.js';
import { isDesktopShell, pickAudioFile, saveExportBlob, filtersForFilename } from '/src/core/DesktopBridge.js';
import { inferMediaKind, isVideoSource } from '/src/core/media-types.js';
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
    const cta = $('heroCtaProcess');
    const busy = !!(appRef && appRef.isProcessing);
    if (cta) cta.disabled = !enableProcess || busy;
    if (appRef && typeof appRef._updateProcessButtonsState === 'function') {
      appRef._updateProcessButtonsState();
    }
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
    const snr = $('stat-snr');
    if (snr && appRef?.lastSNR != null) snr.textContent = `${appRef.lastSNR} dB`;
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

/** Live-mix bridge sliders — only these affect playback in real time (EngineerModeBridge.PARAM_MAP). */
const BRIDGE_RT_SLIDER_IDS = new Set([
  'gateThresh', 'gateRange', 'gateAttack', 'gateRelease', 'gateHold',
  'eqSub', 'eqBass', 'eqWarmth', 'eqBody', 'eqLowMid', 'eqMid', 'eqPresence', 'eqClarity', 'eqAir', 'eqBrill',
  'compThresh', 'compRatio', 'compAttack', 'compRelease', 'compKnee', 'compMakeup',
  'limThresh', 'limRelease',
  'hpFreq', 'hpQ', 'lpFreq', 'lpQ',
  'deEssFreq', 'deEssAmt',
  'specTilt', 'outGain', 'dryWet', 'outWidth', 'stereoWidth',
]);

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

function _yieldToUI(cb) {
  setTimeout(cb, 0);
}

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
    { id:'gateLookahead', label:'Lookahead', min:0, max:50, val:5, step:1, unit:' ms', rt:false, desc:'Lets the gate peek ahead so it opens just before a sound arrives.', example:'5–10 ms preserves the sharp attack of a clapper or plosive that a zero-lookahead gate would shave off.' },
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
    { id:'phaseCorr', label:'Phase Corr', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Fixes out-of-phase stereo so it stays solid in mono.', example:'Raise to ~40% when a stereo clip goes hollow/thin on a phone speaker that sums to mono.' },
  ],
  sep: [
    { id:'voiceIso', label:'Voice Iso', min:0, max:100, val:72, step:1, unit:'%', rt:false, desc:'Emphasises the human voice over everything else.', example:'~70% lifts a speaker out of background music; near 100% is forensic-grade but can sound processed.' },
    { id:'bgSuppress', label:'BG Suppress', min:0, max:100, val:38, step:1, unit:'%', rt:false, desc:'Lowers sound that sits outside the voice focus band.', example:'Set ~60% to push down street noise and crowd chatter while keeping the dialogue forward.' },
    { id:'voiceFocusLo', label:'Focus Lo', min:80, max:500, val:100, step:10, unit:' Hz', rt:false, desc:'Bottom edge of the band kept as "voice".', example:'~100–120 Hz suits most voices; raise to 200 Hz to ignore deep rumble, lower for very deep male voices.' },
    { id:'voiceFocusHi', label:'Focus Hi', min:1000, max:8000, val:4200, step:100, unit:' Hz', rt:false, desc:'Top edge of the band kept as "voice" (lower blocks high-pitch residual).', example:'4200 Hz mimics telephone clarity; raise to 5000 Hz to keep crisp consonants and a more natural top.' },
    { id:'crosstalkCancel', label:'Crosstalk', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Removes bleed of one stereo channel into the other.', example:'Use ~40% on a two-mic interview where each voice leaks into the opposite channel.' },
  ],
  out: [
    { id:'outGain', label:'Output Gain', min:-24, max:24, val:0, step:0.5, unit:' dB', rt:true, desc:'Final overall volume trim on the processed output.', example:'Add +3 dB if the cleaned voice is too quiet; the limiter still prevents clipping above its ceiling.' },
    { id:'dryWet', label:'Dry/Wet', min:0, max:100, val:100, step:1, unit:'%', rt:true, desc:'Blends the original (dry) with the processed (wet) signal.', example:'100% is fully processed; drop to 70% to keep a touch of the natural original and soften aggressive cleanup.' },
    { id:'ditherAmt', label:'Dither', min:0, max:10, val:0, step:0.1, unit:' bits', rt:false, desc:'Adds tiny noise that smooths quiet detail when exporting.', example:'Leave at 0 for full float quality; set ~1 only when dithering for 16-bit export.' },
    { id:'outWidth', label:'Out Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'Final stereo width applied at the very end of the chain.', example:'100% leaves width unchanged; 0% guarantees a centered mono output for phone playback.' },
  ],
  extreme: [
    { id:'whisperLift', label:'Whisper Lift Gain', min:0, max:40, val:0, step:1, unit:' dB', rt:true, desc:'Post-mask amplification applied only where voice confidence exceeds 0.55. Off by default — enable for buried whispers.', example:'Raise to ~22 dB when the whisper is buried under club noise; keeps the noise floor untouched.' },
    { id:'crowdNull', label:'Crowd Null Depth', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Spectral subtraction targeting 200–2500 Hz crowd murmur. Off by default (triggers extreme path).', example:'~88% pulls down stadium chatter while leaving consonants in the 3–4 kHz band.' },
    { id:'bassCrush', label:'Bass Crush (Sub/Kick)', min:0, max:100, val:0, step:1, unit:'%', rt:true, desc:'Attenuates kick drum and sub bass that mask whisper formants. Off by default.', example:'~95% for nightclub recordings with heavy sub; lower if the whisper has a deep fundamental.' },
    { id:'reverbStrip', label:'Reverb Strip (RT60 Suppressor)', min:0, max:2000, val:0, step:10, unit:' ms', rt:false, desc:'Extreme spectral dereverb by RT60. Prefer Dereverb Amount for standard rooms.', example:'Match to the room — ~900 ms for a reverberant club, ~200 ms for a tight office.' },
    { id:'voiceTunnel', label:'Voice Tunnel (Formant Focus)', min:0, max:100, val:0, step:1, unit:'%', rt:true, desc:'Narrow-band emphasis on speech formants. Off by default.', example:'~78% concentrates energy on vowel formants so a whisper cuts through music.' },
    { id:'musicKill', label:'Music Kill (Harmonic Comb)', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Suppresses steady-state harmonic music while preserving transient speech. Off by default.', example:'~92% when a DJ track is constant under the target whisper.' },
    { id:'snrFloor', label:'SNR Rescue Floor', min:-80, max:-20, val:-52, step:1, unit:' dBFS', rt:false, desc:'Minimum power threshold used by extreme isolation — bins below are treated as noise-only.', example:'Lower toward −58 dBFS to catch quieter whispers; raise if musical noise appears.' },
    { id:'whisperMode', label:'Whisper Mode (Processing Aggression)', min:0, max:3, val:0, step:1, unit:'', rt:false, desc:'Compound processing aggression: Off, Light, Heavy, or Forensic multi-pass. Keep Off when ML isolation succeeds.', example:'Forensic (3) runs four iterative refinement passes for surveillance recovery.' },
    { id:'whisperClarity', label:'Whisper Clarity', min:0, max:100, val:65, step:1, unit:'%', rt:true, desc:'Sigmoid-mapped clarity floor for WhisperHunter gain.', example:'~72% for podcast whispers; ~88% for buried field recordings.' },
    { id:'whisperSensitivity', label:'Whisper Sensitivity', min:0, max:100, val:55, step:1, unit:'%', rt:true, desc:'Scales W-VAD energy threshold — higher catches quieter whispers.', example:'~82% in a noisy club; ~28% in a silent room.' },
    { id:'whisperThreshold', label:'Whisper Threshold', min:0, max:100, val:50, step:1, unit:'%', rt:true, desc:'Steepens WhisperHunter suppression curve.', example:'~35% gentle; ~78% aggressive forensic extraction.' },
    { id:'transientShaper', label:'Transient Shaper', min:-100, max:100, val:0, step:5, unit:'', rt:true, desc:'Bipolar transient emphasis for consonant shaping.', example:'−40 softens plosives; +45 sharpens whisper consonants.' },
    { id:'breathControl', label:'Breath Control', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Attenuates breath noise between whisper phrases. Off by default.', example:'~55% for ASMR-style cleanup; ~85% to strip breaths.' },
    { id:'roomCorrection', label:'Room Correction', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Adds to dereverb for whisper tails. Prefer Dereverb Amount for standard rooms.', example:'~60% for echoey hall; ~90% for deep dereverb.' },
    { id:'subHarmonic', label:'Sub Harmonic', min:0, max:100, val:0, step:1, unit:'%', rt:true, desc:'Sub-harmonic body reinforcement for thin whispers.', example:'~35% adds warmth; ~65% restores chest body.' },
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

// Flat lookup (frozen, used by clampToSlider and applyPreset)
const SLIDER_BY_ID = Object.freeze(
  Object.values(SLIDERS).flat().reduce((acc, s) => { acc[s.id] = s; return acc; }, {})
);

// [WHISPER UPDATE] Build a complete preset from SLIDER defaults + overrides
function _presetDefaults(overrides = {}) {
  const base = { description: '' };
  for (const s of Object.values(SLIDERS).flat()) base[s.id] = s.val;
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

const PRESETS = {
  'Voice Clarity': {
    description: 'Isolate speech and enhance intelligibility with balanced noise reduction',
    gateThresh: -44, gateRange: -58, gateAttack: 4, gateRelease: 180, gateHold: 40, gateLookahead: 5,
    nrAmount: 52, nrSensitivity: 48, nrSpectralSub: 32, nrFloor: -68, nrSmoothing: 30,
    eqSub: 0, eqBass: 0, eqWarmth: 0.5, eqBody: 1, eqLowMid: 0.5, eqMid: 1, eqPresence: 1, eqClarity: 0.5, eqAir: 0, eqBrill: 0,
    compThresh: -22, compRatio: 3.5, compAttack: 8, compRelease: 140, compKnee: 5, compMakeup: 1.5, limThresh: -1, limRelease: 45,
    hpFreq: 70, hpQ: 0.7, lpFreq: 14000, lpQ: 0.7, deEssFreq: 6500, deEssAmt: 5, specTilt: 0, formantShift: 0,
    derevAmt: 8, derevDecay: 30, harmRecov: 0, harmOrder: 3, stereoWidth: 100, phaseCorr: 0,
    voiceIso: 72, bgSuppress: 38, voiceFocusLo: 100, voiceFocusHi: 4200, crosstalkCancel: 0,
    outGain: 1, dryWet: 100, ditherAmt: 0, outWidth: 100,
    ...EXTREME_OFF,
  },
  'Podcast Clean': {
    description: 'Studio-clean podcast isolation with de-essing and steady loudness',
    gateThresh: -52, gateRange: -62, gateAttack: 5, gateRelease: 200, gateHold: 45, gateLookahead: 5,
    nrAmount: 55, nrSensitivity: 50, nrSpectralSub: 35, nrFloor: -68, nrSmoothing: 32,
    eqSub: -1, eqBass: 0, eqWarmth: 1, eqBody: 0.5, eqLowMid: 0, eqMid: 0.5, eqPresence: 1, eqClarity: 0, eqAir: 0, eqBrill: 0,
    compThresh: -18, compRatio: 3, compAttack: 12, compRelease: 160, compKnee: 6, compMakeup: 2, limThresh: -1, limRelease: 50,
    hpFreq: 90, hpQ: 0.7, lpFreq: 14000, lpQ: 0.7, deEssFreq: 6500, deEssAmt: 6, specTilt: 0, formantShift: 0,
    derevAmt: 8, derevDecay: 35, harmRecov: 0, harmOrder: 3, stereoWidth: 100, phaseCorr: 0,
    voiceIso: 74, bgSuppress: 42, voiceFocusLo: 110, voiceFocusHi: 3800, crosstalkCancel: 0,
    outGain: 0, dryWet: 100, ditherAmt: 0, outWidth: 100,
    ...EXTREME_OFF,
    breathControl: 28,
  },
  'Forensic Extract': {
    description: 'Maximum voice extraction for forensic / low-SNR analysis',
    gateThresh: -62, gateRange: -78, gateAttack: 2, gateRelease: 90, gateHold: 18, gateLookahead: 8,
    nrAmount: 94, nrSensitivity: 80, nrSpectralSub: 82, nrFloor: -82, nrSmoothing: 78,
    eqSub: -6, eqBass: -2, eqWarmth: 0, eqBody: 1.5, eqLowMid: 1.5, eqMid: 2.5, eqPresence: 2.5, eqClarity: 1.5, eqAir: 0, eqBrill: -2,
    compThresh: -28, compRatio: 7, compAttack: 4, compRelease: 90, compKnee: 3, compMakeup: 6, limThresh: -1, limRelease: 28,
    hpFreq: 140, hpQ: 0.85, lpFreq: 11000, lpQ: 0.7, deEssFreq: 7500, deEssAmt: 8, specTilt: 1.2, formantShift: 0,
    derevAmt: 50, derevDecay: 50, harmRecov: 30, harmOrder: 4, stereoWidth: 100, phaseCorr: 22,
    voiceIso: 96, bgSuppress: 90, voiceFocusLo: 90, voiceFocusHi: 4500, crosstalkCancel: 30,
    outGain: 6, dryWet: 100, ditherAmt: 1, outWidth: 100,
    whisperLift: 14, crowdNull: 58, bassCrush: 42, reverbStrip: 320, voiceTunnel: 62, musicKill: 48, snrFloor: -56, whisperMode: 2,
    whisperClarity: 74, whisperSensitivity: 70, whisperThreshold: 58, transientShaper: 18, breathControl: 30, roomCorrection: 38, subHarmonic: 12,
  },
  'Whisper Boost': {
    description: 'Amplify and isolate soft whispering voices from ambience',
    gateThresh: -70, gateRange: -78, gateAttack: 2, gateRelease: 140, gateHold: 35, gateLookahead: 8,
    nrAmount: 62, nrSensitivity: 48, nrSpectralSub: 45, nrFloor: -78, nrSmoothing: 70,
    eqSub: -5, eqBass: -2, eqWarmth: 0.5, eqBody: 2.5, eqLowMid: 2.5, eqMid: 3.5, eqPresence: 4, eqClarity: 2.5, eqAir: 1.5, eqBrill: 0.5,
    compThresh: -38, compRatio: 5, compAttack: 6, compRelease: 110, compKnee: 5, compMakeup: 9, limThresh: -1, limRelease: 35,
    hpFreq: 100, hpQ: 0.7, lpFreq: 13000, lpQ: 0.7, deEssFreq: 5200, deEssAmt: 2, specTilt: 1.2, formantShift: 0,
    derevAmt: 18, derevDecay: 35, harmRecov: 22, harmOrder: 4, stereoWidth: 100, phaseCorr: 8,
    voiceIso: 80, bgSuppress: 68, voiceFocusLo: 140, voiceFocusHi: 4200, crosstalkCancel: 6,
    outGain: 7, dryWet: 100, ditherAmt: 1, outWidth: 100,
    whisperLift: 22, crowdNull: 38, bassCrush: 30, reverbStrip: 220, voiceTunnel: 72, musicKill: 28, snrFloor: -58, whisperMode: 1,
    whisperClarity: 78, whisperSensitivity: 72, whisperThreshold: 42, transientShaper: 14, breathControl: 42, roomCorrection: 28, subHarmonic: 16,
  },
  'Phone/Radio': {
    description: 'Band-limit and isolate speech for phone / radio recovery',
    gateThresh: -48, gateRange: -62, gateAttack: 4, gateRelease: 180, gateHold: 45, gateLookahead: 5,
    nrAmount: 82, nrSensitivity: 70, nrSpectralSub: 64, nrFloor: -74, nrSmoothing: 70,
    eqSub: -12, eqBass: -8, eqWarmth: -3, eqBody: 0.5, eqLowMid: 2.5, eqMid: 1.5, eqPresence: 0.5, eqClarity: -1, eqAir: -6, eqBrill: -10,
    compThresh: -20, compRatio: 5, compAttack: 8, compRelease: 120, compKnee: 4, compMakeup: 4, limThresh: -1, limRelease: 40,
    hpFreq: 280, hpQ: 1.1, lpFreq: 3800, lpQ: 1.0, deEssFreq: 3200, deEssAmt: 5, specTilt: -0.4, formantShift: 0,
    derevAmt: 12, derevDecay: 28, harmRecov: 28, harmOrder: 5, stereoWidth: 0, phaseCorr: 5,
    voiceIso: 88, bgSuppress: 74, voiceFocusLo: 300, voiceFocusHi: 3400, crosstalkCancel: 18,
    outGain: 3, dryWet: 100, ditherAmt: 1, outWidth: 0,
    ...EXTREME_OFF,
  },
  'Surveillance': {
    description: 'Aggressive isolation for challenging surveillance / outdoor noise',
    gateThresh: -68, gateRange: -78, gateAttack: 2, gateRelease: 100, gateHold: 20, gateLookahead: 8,
    nrAmount: 92, nrSensitivity: 84, nrSpectralSub: 80, nrFloor: -82, nrSmoothing: 80,
    eqSub: -6, eqBass: -3, eqWarmth: 0, eqBody: 1.5, eqLowMid: 2, eqMid: 3, eqPresence: 2.5, eqClarity: 1.5, eqAir: 0, eqBrill: -2,
    compThresh: -30, compRatio: 7, compAttack: 4, compRelease: 95, compKnee: 3, compMakeup: 7, limThresh: -1, limRelease: 30,
    hpFreq: 110, hpQ: 0.9, lpFreq: 11000, lpQ: 0.7, deEssFreq: 7000, deEssAmt: 7, specTilt: 1, formantShift: 0,
    derevAmt: 38, derevDecay: 48, harmRecov: 22, harmOrder: 4, stereoWidth: 100, phaseCorr: 15,
    voiceIso: 93, bgSuppress: 88, voiceFocusLo: 100, voiceFocusHi: 4200, crosstalkCancel: 22,
    outGain: 7, dryWet: 100, ditherAmt: 1, outWidth: 100,
    whisperLift: 15, crowdNull: 72, bassCrush: 58, reverbStrip: 380, voiceTunnel: 70, musicKill: 52, snrFloor: -56, whisperMode: 2,
    whisperClarity: 74, whisperSensitivity: 76, whisperThreshold: 64, transientShaper: 20, breathControl: 35, roomCorrection: 42, subHarmonic: 12,
  },
  'Room Echo Reduction': _presetDefaults({
    description: 'Reduce room tone and reverb tails while preserving speech clarity',
    gateThresh: -50, gateRange: -62, gateAttack: 4, gateRelease: 180, gateHold: 40,
    nrAmount: 48, nrSensitivity: 45, nrSpectralSub: 30, nrFloor: -68, nrSmoothing: 40,
    eqPresence: 1.5, eqClarity: 1, eqAir: 0,
    derevAmt: 62, derevDecay: 58, roomCorrection: 55, reverbStrip: 420,
    voiceIso: 70, bgSuppress: 45, outGain: 1,
    ...EXTREME_OFF,
  }),
  'Hum Removal': _presetDefaults({
    description: 'Target mains hum/buzz with conservative speech preservation',
    gateThresh: -46, gateRange: -58, gateAttack: 4, gateRelease: 180,
    nrAmount: 40, nrSensitivity: 40, nrSpectralSub: 28, nrFloor: -68,
    eqSub: -2, eqBass: -1, hpFreq: 85,
    phaseCorr: 28, voiceIso: 65, bgSuppress: 30, outGain: 0,
    ...EXTREME_OFF,
  }),
  'Aggressive Isolate': _presetDefaults({
    description: 'Strong voice isolation against music beds and dense backgrounds',
    gateThresh: -58, gateRange: -72, gateAttack: 2, gateRelease: 120, gateHold: 25,
    nrAmount: 88, nrSensitivity: 80, nrSpectralSub: 72, nrFloor: -80, nrSmoothing: 70,
    eqPresence: 3, eqClarity: 2,
    voiceIso: 94, bgSuppress: 90, outGain: 3,
    musicKill: 82, bassCrush: 70, crowdNull: 70, voiceTunnel: 75,
    snrFloor: -56, whisperMode: 0,
  }),
  // Legacy aliases (redirect to calibrated presets)
  'Whisper in a Club': null,
  'Stadium Crowd': null,
};

// Resolve legacy null aliases (calibrated merge may refine these after ESM loads)
PRESETS['Whisper in a Club'] = PRESETS['Aggressive Isolate'];
PRESETS['Stadium Crowd'] = PRESETS['Surveillance'];

// Ensure every preset covers all 67 slider IDs
for (const preset of Object.values(PRESETS)) {
  for (const s of Object.values(SLIDERS).flat()) {
    if (preset[s.id] === undefined) preset[s.id] = s.val;
  }
}

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
function encodeWavBuffer(audioBuffer) {
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
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }
  return buf;
}

function downloadWav(audioBuffer, name) {
  const blob = new Blob([encodeWavBuffer(audioBuffer)], { type: 'audio/wav' });
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
    this.params = Object.fromEntries(
      Object.values(SLIDERS).flat().map(s => [s.id, s.val])
    );

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
      this._renderSliders();
      this.bindEvents();
      fixUploadTouchTargets();
      this._updateProcessButtonsState();
      HeroExperience.init(this);
      WorkflowTier.init(this);
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

    this._warmupMLModels().catch(() => {});

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
      auditLogBtn:g('auditLogBtn'),
      presetSel:g('presetSel'),
      resetSlidersBtn:g('resetSlidersBtn'),
      sliderSearch:g('sliderSearch'),
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
      mobileProcessBtn:g('mobileProcessBtn'),
      mobileReprocessBtn:g('mobileReprocessBtn'),
      mobileStopBtn:g('mobileStopBtn'),
      statsToggle:g('statsToggle'),
      hdrStats:g('hdrStats'),
    };
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

  /** Map ML worker percent (0–100) into the isolation band (15–88). */
  _mapMlProgressPercent(workerPercent) {
    const w = Math.max(0, Math.min(100, Number(workerPercent) || 0));
    return 15 + Math.round(w * 0.73);
  }

  // ── Render static visuals (waveform/spectrogram placeholder) ─────────────
  renderStaticVisuals(buffer) {
    if (window.VIP_VISUALS && typeof window.VIP_VISUALS.drawStatic === 'function') {
      try { window.VIP_VISUALS.drawStatic(); } catch (_) {}
    }
    if (typeof window.drawWaveform === 'function') {
      try { window.drawWaveform(buffer); } catch (_) {}
    }
    if (typeof window.VIP_spectro === 'object' && window.VIP_spectro) {
      try { window.VIP_spectro.renderStatic(buffer); } catch (_) {}
    }
    HeroExperience.mirrorWaveCanvases();
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
        const st = bridge?.getWorkletStatus?.() || {};
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
  _initSABRings() {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const inputByteLen = SAB_HEADER_BYTES + HALF_BINS * 4 * 2;
    const outputByteLen = SAB_HEADER_BYTES + HALF_BINS * 4 * 2;
    const inputSAB = new SharedArrayBuffer(inputByteLen);
    const outputSAB = new SharedArrayBuffer(outputByteLen);
    this._inputSAB = inputSAB;
    this._outputSAB = outputSAB;
    const worker = window._vipOrch && window._vipOrch.mlWorker;
    if (worker) {
      worker.postMessage({ type: 'initRingBuffers', inputRing: inputSAB, maskRing: outputSAB }, []);
    }
    const workletNode = window._vipOrch && window._vipOrch.workletNode;
    if (workletNode) {
      workletNode.port.addEventListener('message', (ev) => {
        if (ev.data && ev.data.type === 'sabReady' && ev.data.inputSAB && ev.data.outputSAB) {
          this._inputSAB = ev.data.inputSAB;
          this._outputSAB = ev.data.outputSAB;
        }
      });
    }
  }

  _loadSliderLocks() {
    if (typeof sessionStorage === 'undefined') return;
    try {
      const raw = sessionStorage.getItem('vip-slider-locks');
      if (!raw) return;
      const ids = JSON.parse(raw);
      if (Array.isArray(ids)) this._sliderLocks = new Set(ids);
    } catch (_) { /* ignore corrupt storage */ }
  }

  _persistSliderLocks() {
    if (typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.setItem('vip-slider-locks', JSON.stringify([...this._sliderLocks]));
    } catch (_) { /* ignore quota */ }
  }

  _isSliderLocked(id) {
    return this._sliderLocks.has(id);
  }

  _shouldPreserveSlider(id) {
    return this._isSliderLocked(id) || this._userTouchedSliders.has(id);
  }

  _syncSliderLockUi(id) {
    const row = document.querySelector(`.slider-row[data-slider-id="${id}"]`);
    const btn = row?.querySelector('.slider-lock-btn');
    if (!row || !btn) return;
    const locked = this._isSliderLocked(id);
    row.classList.toggle('slider-locked', locked);
    btn.classList.toggle('is-locked', locked);
    btn.setAttribute('aria-pressed', String(locked));
    btn.title = locked ? 'Unlock slider (allow preset changes)' : 'Lock slider (ignore preset changes)';
    btn.textContent = locked ? '\u{1F512}' : '\u{1F513}';
  }

  _toggleSliderLock(id) {
    if (this._sliderLocks.has(id)) this._sliderLocks.delete(id);
    else this._sliderLocks.add(id);
    this._persistSliderLocks();
    this._syncSliderLockUi(id);
  }

  // ── Slider rendering ─────────────────────────────────────────────────────
  _renderSliders() {
    for (const s of RENDER_SLIDERS) {
      if (s.id === 'whisperMode') continue; // [WHISPER UPDATE] rendered as button group
      const panelId = this._getSliderPanelId(s.id);
      const panel = panelId ? document.getElementById(panelId) : null;
      const container = panel || document.getElementById('sliderContainer');
      if (!container) continue;

      const row = document.createElement('div');
      row.className = 'sr-row slider-row';
      row.dataset.sliderId = s.id;

      const labelEl = document.createElement('label');
      labelEl.className = 'sr-label';
      labelEl.htmlFor = 'sl_' + s.id;
      labelEl.textContent = s.label;
      labelEl.title = s.desc || '';

      if (s.rt) {
        const badge = document.createElement('span');
        badge.className = 'rt-badge';
        badge.textContent = 'RT';
        labelEl.appendChild(badge);
      }

      const inputEl = document.createElement('input');
      inputEl.type = 'range';
      inputEl.id = 'sl_' + s.id;
      inputEl.name = s.id;
      inputEl.classList.add('dsp-slider');
      if (EXTREME_DATA_PARAMS[s.id]) inputEl.dataset.param = EXTREME_DATA_PARAMS[s.id];
      inputEl.min = s.min;
      inputEl.max = s.max;
      inputEl.step = s.step;
      const initVal = (window.VIP_PARAMS && window.VIP_PARAMS[s.id] !== undefined) ? window.VIP_PARAMS[s.id] : s.val;
      inputEl.value = initVal;
      inputEl.setAttribute('aria-label', s.label);
      inputEl.setAttribute('aria-valuenow', initVal);
      if (s.rt) inputEl.classList.add('realtime');

      const range = s.max - s.min;
      const initPct = range > 0 ? ((initVal - s.min) / range) * 100 : 0;
      inputEl.style.setProperty('--pct', `${initPct.toFixed(1)}%`);

      const valEl = document.createElement('span');
      valEl.className = 'sr-val';
      valEl.id = 'val_' + s.id;
      valEl.textContent = initVal + (s.unit || '');

      // PATCHED BY vip-fixes.js — consider merging
      inputEl.addEventListener('input', () => {
        if (!this._programmaticSliderUpdate) this._userTouchedSliders.add(s.id);
        const el = inputEl;
        const v = parseFloat(el.value);
        const min = parseFloat(el.min);
        const max = parseFloat(el.max);
        const r = parseFloat(el.max) - parseFloat(el.min);
        const pct = r > 0 ? ((v - min) / (max - min)) * 100 : 0;
        el.style.setProperty('--pct', `${pct.toFixed(1)}%`);
        el.setAttribute('aria-valuenow', v);
        valEl.textContent = v + (s.unit || '');
        window.VIP_PARAMS = window.VIP_PARAMS || {};
        window.VIP_PARAMS[s.id] = v;
        this.params[s.id] = v;
        if (this.sharedParams) {
          const idx = this._sliderIndexById.get(s.id);
          if (idx !== undefined) this.sharedParams[idx] = v;
        }
        this.onSlider(s.id, v);
        this._applySliderToWorklet(s.id, v);
      });

      const lockBtn = document.createElement('button');
      lockBtn.type = 'button';
      lockBtn.className = 'slider-lock-btn';
      lockBtn.setAttribute('aria-label', `Lock ${s.label}`);
      lockBtn.setAttribute('aria-pressed', 'false');
      lockBtn.title = 'Lock slider (ignore preset changes)';
      lockBtn.textContent = '\u{1F513}';
      lockBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleSliderLock(s.id);
      });

      row.appendChild(labelEl);
      row.appendChild(inputEl);
      row.appendChild(valEl);
      row.appendChild(lockBtn);

      const regEntry = SLIDER_REG_BY_ID[s.id];
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
          onApplyExample: (val) => {
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
      infoBtn.setAttribute('aria-label', `Examples for ${s.id}`);
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

      container.appendChild(row);
      if (this._isSliderLocked(s.id)) this._syncSliderLockUi(s.id);

      window.VIP_PARAMS = window.VIP_PARAMS || {};
      window.VIP_PARAMS[s.id] = initVal;
    }
    this._renderWhisperModeGroup();
    this._bindInfoPopoverDismiss();
    this._bindHintDismiss();
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
  _applySliderToWorklet(id, uiValue) {
    const entry = SLIDER_REG_BY_ID[id];
    if (!entry || typeof entry.transform !== 'function') return;
    const dspVal = entry.transform(uiValue);
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
      btn.addEventListener('click', () => {
        group.querySelectorAll('.wm-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        window.VIP_PARAMS = window.VIP_PARAMS || {};
        window.VIP_PARAMS.whisperMode = m.id;
        this.params.whisperMode = m.id;
        this.whisperMode = m.id;
        this.onSlider('whisperMode', m.id);
      });
      group.appendChild(btn);
    });

    row.appendChild(labelEl);
    row.appendChild(group);

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

    window.VIP_PARAMS = window.VIP_PARAMS || {};
    window.VIP_PARAMS.whisperMode = initMode;
    this.params.whisperMode = initMode;
    this.whisperMode = initMode;
  }

  _getSliderPanelId(sliderId) {
    const entry = SLIDER_REG_BY_ID[sliderId];
    return entry?.group || null;
  }

  onSlider(id, value) {
    // Real-time path: route the slider straight to the Live-Mix bridge. When
    // the bridge handles it, the change is an immediate AudioParam update — no
    // Reprocess, no ML re-run (CLAUDE.md §1). Unsupported ids (spectral/worker
    // effects) fall through and still apply on the next Reprocess.

    // If the bridge is still initializing, wait for it so early slider moves are
    // not dropped (race where sliders fire before async _ensureBridge resolves).
    if (!this._bridge && this._bridgePromise) {
      this._bridgePromise.then(() => this.onSlider(id, value)).catch(() => {});
      return;
    }

    if (this._bridge && typeof this._bridge.applyParam === 'function') {
      try {
        if (this._bridge.applyParam(id, value)) return;
      } catch {
        /* fall through to legacy handling */
      }
    }

    const orch = window._vipOrch;
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

  // ── Event binding ────────────────────────────────────────────────────────
  bindEvents() {
    const d = this.dom;

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
    bind('fileInput', d.fileInput, 'change', e => this.handleFile(e.target.files[0]));
    if (d.dropZone) {
      d.dropZone.addEventListener('dragover', e => { e.preventDefault(); d.dropZone.classList.add('drag-over'); });
      d.dropZone.addEventListener('dragleave', () => d.dropZone.classList.remove('drag-over'));
      d.dropZone.addEventListener('drop', e => {
        e.preventDefault();
        d.dropZone.classList.remove('drag-over');
        this.handleFile(e.dataTransfer.files[0]);
      });
    }
    bind('clearFile', d.clearFile, 'click', () => { if (this.inputBuffer && !confirm('Are you sure you want to clear the current file? Unsaved processed audio will be lost.')) return; this._clearFile(); });

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
      this.dom.mobileStopBtn.addEventListener('click', () => { this.abortFlag = true; });
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
      if (!(this.origBuffer || this.inputBuffer) && this._sourceFile) {
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
    bind('auditLogBtn', d.auditLogBtn, 'click', () => this.downloadAuditLog());

    // PATCHED BY vip-fixes.js — consider merging
    // Preset selector
    bind('presetSel', d.presetSel, 'change', e => this.applyPreset(e.target.value));
    qsa('.btn-preset').forEach(b => {
      b.addEventListener('click', () => this.applyPreset(b.dataset.preset));
    });

    // Reset sliders
    bind('resetSlidersBtn', d.resetSlidersBtn, 'click', () => {
      if (!confirm('Are you sure you want to reset all controls to their default values?')) return;
      qsa('[id^="sl_"]').forEach(el => {
        const id = el.id.slice(3);
        const spec = SLIDER_BY_ID[id];
        if (spec) { el.value = spec.val; el.dispatchEvent(new Event('input', { bubbles: true })); }
      });
      this._setWhisperMode(SLIDER_BY_ID.whisperMode ? SLIDER_BY_ID.whisperMode.val : 0);
    });

    // [WHISPER UPDATE] WhisperHunter AI auto-processing
    bind('btnWhisperHunter', document.getElementById('btn-whisper-hunter'), 'click', async () => {
      if (!this.inputBuffer && !this.origBuffer && !this._sourceFile) {
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

    // PATCHED BY vip-fixes.js — consider merging
    // Slider search
    bind('sliderSearch', d.sliderSearch, 'input', () => {
      const q = d.sliderSearch.value.trim().toLowerCase();
      qsa('.sr-row').forEach(row => {
        const label = (row.querySelector('.sr-label') || {}).textContent || '';
        row.style.display = (!q || label.toLowerCase().includes(q)) ? '' : 'none';
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
    bind('forensicToggle', $('forensicToggle'), 'click', () => this.showNotification('Forensic mode: set in Advanced sliders.', 'info'));
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
        this.abortFlag = true;
        import('/src/pipeline/StemSeparation.js')
          .then((m) => { if (m.resetStemSeparation) m.resetStemSeparation(); })
          .catch(() => {});
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

  /** Push VIP_PARAMS to the live-mix bridge when loaded. */
  _syncBridgeParams() {
    const bridge = this._bridge;
    if (!bridge || typeof bridge.applyParams !== 'function') return;
    bridge.applyParams(window.VIP_PARAMS || {});
    if (bridge.isLoaded && bridge.isLoaded()) this.liveChainBuilt = true;
  }

  /** After processing, default playback to the isolated output. */
  _setProcessedPlaybackMode() {
    this.abMode = 'processed';
    this._bridgeBuf = null;
    if (this.dom?.tpAB) this.dom.tpAB.classList.add('active');
    if (this.dom?.tpABLabel) this.dom.tpABLabel.textContent = 'Processed';
  }

  /** Push a calibrated slider value through VIP_PARAMS, DOM, bridge, and worklet. */
  _setSliderUi(id, rawValue, { notify = true } = {}) {
    this._programmaticSliderUpdate = true;
    try {
      this._setSliderUiInner(id, rawValue, { notify });
    } finally {
      this._programmaticSliderUpdate = false;
    }
  }

  _setSliderUiInner(id, rawValue, { notify = true } = {}) {
    if (id === 'whisperMode') {
      this._setWhisperMode(rawValue);
      return;
    }
    const hasSpec = SLIDER_REG_BY_ID[id] || SLIDER_BY_ID[id];
    if (!hasSpec) return;
    const value = clampToSlider(id, rawValue);
    window.VIP_PARAMS = window.VIP_PARAMS || {};
    window.VIP_PARAMS[id] = value;
    this.params[id] = value;
    if (this.sharedParams) {
      const idx = this._sliderIndexById.get(id);
      if (idx !== undefined) this.sharedParams[idx] = value;
    }
    const el = document.getElementById('sl_' + id);
    if (el) {
      el.value = value;
      el.setAttribute('aria-valuenow', value);
      const min = parseFloat(el.min);
      const max = parseFloat(el.max);
      const range = max - min;
      const pct = range > 0 ? ((value - min) / range) * 100 : 0;
      el.style.setProperty('--pct', `${pct.toFixed(1)}%`);
      const valEl = document.getElementById('val_' + id);
      const unit = SLIDER_REG_BY_ID[id]?.unit || SLIDER_BY_ID[id]?.unit || '';
      if (valEl) valEl.textContent = value + _formatSliderUnit(unit);
    }
    this.onSlider(id, value);
    this._applySliderToWorklet(id, value);
    if (notify) el?.dispatchEvent(new Event('change', { bubbles: true }));
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
      return ab.slice(0);
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.slice(0));
      reader.onerror = () => reject(new Error('Could not read file from disk.'));
      reader.readAsArrayBuffer(file);
    });
  }

  async _decodeFileBuffer(ctx, arrayBuffer) {
    if (typeof window.safeDecodeAudioData === 'function') {
      return window.safeDecodeAudioData(ctx, arrayBuffer);
    }
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  /** Prefetch + compile ONNX sessions off the hot path (deduped). */
  async _warmupMLModels(modelIds = DEFAULT_ML_CHAIN) {
    if (this._mlWarmupDone) return;
    if (this._mlWarmupPromise) return this._mlWarmupPromise;
    this._mlWarmupPromise = (async () => {
      const { warmupModels } = await import('/src/pipeline/StemSeparation.js');
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
   * Accept a file without decoding. Decode starts on Analyze / Process / Play
   * via ensureDecoded() so upload never freezes the tab on large media.
   */
  async handleFile(file) {
    if (!file) return;
    if (typeof this._fileSeq !== 'number' || !Number.isFinite(this._fileSeq)) this._fileSeq = 0;
    const fileSeq = ++this._fileSeq;
    // Immediately hide any in-flight decode indicator from the previous file.
    this._hideFileLoading?.();
    clearStemCache();
    this._sourceName = file.name || '';
    this._decodePromise = null;
    this._decodeReady = false;
    this._resetCollaborationState?.();
    this.stop();
    if (this.isProcessing) {
      this.abortFlag = true;
      try {
        const { resetStemSeparation } = await import('/src/pipeline/StemSeparation.js');
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

    // Reject clearly non-audio/non-video MIME types. Browsers often report
    // application/octet-stream for valid media files — fall back to extension.
    const mediaKind = inferMediaKind(file);
    const mime = (file.type || '').toLowerCase();
    const isAudio = mediaKind === 'audio' || mediaKind === 'video'
      || !mime || mime.startsWith('audio/') || mime.startsWith('video/');
    if (!isAudio) {
      if (this.dom && this.dom.fileInfo) this.dom.fileInfo.textContent = 'Unsupported file type: ' + (file.type || 'unknown');
      this.setStatus('ERROR');
      return;
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
    if (this.dom?.fileInfo) {
      this.dom.fileInfo.textContent = `${file.name || 'File'} · ${kindLabel} · ${sizeMb} MB · ready (decode on Analyze/Process)`;
    }
    this.setStatus('READY');
    this._updateProcessButtonsState();
    // Enable analyze/process without decoded buffers — ensureDecoded runs first.
    if (this.dom.processBtn) this.dom.processBtn.disabled = false;
    if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.disabled = false;
    if (this.dom.playBtn) this.dom.playBtn.disabled = false;
    if (this.dom.saveOrigBtn) this.dom.saveOrigBtn.disabled = true; // needs decode

    try { window.dispatchEvent(new CustomEvent('vip:fileAccepted', { detail: { name: file.name, size: file.size, video: isVideoFile } })); } catch (evErr) {
      structuredLog('warn', '[VIP] vip:fileAccepted dispatch failed', { err: evErr?.message });
    }
    this.showNotification(`${file.name || 'File'} ready — Analyze or Process to decode & isolate`, 'info');

    // Idle ML warmup only (no decode) so first process is faster.
    if (typeof this._warmupMLModels === 'function') {
      const scheduleIdle = globalThis.requestIdleCallback
        ? (cb) => requestIdleCallback(cb, { timeout: 2500 })
        : (cb) => setTimeout(cb, 50);
      scheduleIdle(() => {
        if (fileSeq !== this._fileSeq) return;
        this._warmupMLModels().catch((err) => {
          structuredLog('warn', '[VIP] ML warmup (idle) failed', { err: err?.message });
        });
      });
    }

    // Soft gesture unlock for AudioContext (worklets still lazy).
    this.ensureCtx().catch((err) => {
      structuredLog('warn', '[VIP] AudioContext soft unlock failed', { err: err?.message });
    });
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
      try {
        await this.ensureCtx();
        if (this.ctx?.state === 'suspended') await this.ctx.resume();
        if (fileSeq !== this._fileSeq) return null;

        stageStart('decode');
        const decoded = await decodeBlobToAudioBuffer(file, {
          onProgress: (pct) => {
            if (fileSeq !== this._fileSeq) return;
            const label = pct < 50 ? 'Reading file…' : pct < 100 ? 'Decoding audio…' : 'Decode complete';
            this._showFileLoading(`${label} (${Math.round(pct)}%)`);
          },
        });
        stageEnd('decode');
        await yieldToBrowser();
        if (fileSeq !== this._fileSeq) return null;

        stageStart('resample');
        const buffer = await resampleToCanonical(decoded);
        stageEnd('resample');
        await yieldToBrowser();

        if (!buffer || !buffer.length) {
          throw new Error('Decoded audio is empty or unreadable');
        }
        if (fileSeq !== this._fileSeq) return null;

        this.inputBuffer = buffer;
        this.origBuffer = buffer;
        this._decodeReady = true;
        this.onAudioLoaded(file.name, fileSeq);
        return buffer;
      } catch (decodeErr) {
        if (fileSeq !== this._fileSeq) return null;
        this._decodePromise = null;
        this._decodeReady = false;
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
        // Hide loading indicator when this decode completes/fails/is stale,
        // but only if a newer decode hasn't already taken ownership of the UI.
        if (decodeUiSeq === this._fileSeq) {
          this._hideFileLoading();
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
   * Download processed audio, remuxed into the original video container when
   * the source was a video file. Falls back to WAV if remux is unavailable.
   */
  async _downloadProcessed() {
    const fullBuf = this.procBuffer || this.outputBuffer;
    if (!fullBuf) {
      this.showNotification('Nothing to save yet — process a file first.', 'info');
      return;
    }
    await this.ensureCtx();

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
        // Pass the full buffer + crop window so the picture seeks to crop-in
        // while audio is sliced to the same window inside the exporter.
        const result = await exportVideoWithProcessedAudio(this._sourceFile, fullBuf, {
          startSec: cropIn,
          endSec: cropOut,
          onProgress: (pct, stage) => {
            if (pct === 100 || stage === 'complete') return;
            this.updatePipelineProgress?.(Math.round(pct), `Exporting video… ${Math.round(pct)}%`, 1);
          },
        });
        if (isDesktopShell()) {
          await saveExportBlob(result.blob, {
            defaultName: result.filename,
            filters: filtersForFilename(result.filename),
          });
        } else {
          triggerBlobDownload(result.blob, result.filename);
        }
        this.showNotification('Processed video saved: ' + result.filename, 'info');
        return;
      } catch (err) {
        structuredLog('warn', '[VIP] video export failed — falling back to WAV', { err: err?.message });
        this.showNotification('Video remux unavailable — saving WAV instead.', 'info');
      }
    }

    let buf = fullBuf;
    if (cropIn > 0 || cropOut < fullBuf.duration) {
      buf = sliceAudioBuffer(this.ctx, fullBuf, cropIn, cropOut);
    }
    downloadWav(buf, 'processed-' + Date.now() + '.wav');
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
    // Keeps the UI free; ML warmup continues in idle if already scheduled.
    if (typeof this._warmupMLModels === 'function') {
      this._warmupMLModels().catch(() => {});
    }
  }

  _clearFile() {
    clearStemCache();
    this._sourceName = '';
    this._sourceFile = null;
    this._decodePromise = null;
    this._decodeReady = false;
    this._resetCollaborationState?.();
    this._transportRegionWired = false;
    this._syncTransportRegion = null;
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
     this.dom.saveOrigBtn, this.dom.auditLogBtn,
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
  _setWhisperMode(mode) {
    const m = Math.max(0, Math.min(3, Math.round(mode)));
    window.VIP_PARAMS = window.VIP_PARAMS || {};
    window.VIP_PARAMS.whisperMode = m;
    this.params.whisperMode = m;
    this.whisperMode = m;
    document.querySelectorAll('.wm-btn').forEach((btn) => {
      btn.classList.toggle('active', parseInt(btn.dataset.mode, 10) === m);
    });
    this.onSlider('whisperMode', m);
  }

  /** Wait for an in-flight pipeline (after abort) before loading or re-running. */
  async _waitForPipelineIdle(maxMs = 20000) {
    const start = Date.now();
    while (this.isProcessing && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 40));
    }
    if (this.isProcessing) {
      structuredLog('warn', '[VIP] Pipeline idle wait timed out — forcing reset.');
      import('/src/pipeline/StemSeparation.js')
        .then((m) => { if (m.resetStemSeparation) m.resetStemSeparation(); })
        .catch(() => {});
      this.isProcessing = false;
      this.abortFlag = false;
      if (typeof this.hideProcessingOverlay === 'function') {
        try { this.hideProcessingOverlay(); } catch (_) {}
      }
      document.body.classList.remove('vip-processing-lock');
      try { window.dispatchEvent(new CustomEvent('vip:processingDone')); } catch (_) {}
    }
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
    this._mlIsolationSucceeded = false;
    this._pipelinePct = 0;
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
      if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = false;
      if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = false;
      if (this.dom.saveProcBtn) this.dom.saveProcBtn.disabled = false;
      if (this.dom.auditLogBtn) this.dom.auditLogBtn.disabled = false;
      this._updateSaveButtonLabels();

      this.updatePipelineProgress(28, 'Loading Live-Mix…', 92);
      try {
        this._setProcessedPlaybackMode();
      } catch (playErr) {
        structuredLog('warn', '[VIP] Live-Mix load failed after process', { err: playErr?.message });
      }

      if (this.outputBuffer) {
        const scheduleIdle = globalThis.requestIdleCallback
          ? (cb) => requestIdleCallback(cb, { timeout: 2000 })
          : (cb) => setTimeout(cb, 0);
        scheduleIdle(() => {
          if (fileSeq !== this._fileSeq) return;
          try {
            this.renderStaticVisuals(this.outputBuffer);
            this._autoCalibratePreset(this.outputBuffer);
            this._syncBridgeParams();
          } catch (idleErr) {
            structuredLog('warn', '[VIP] post-process idle work failed', { err: idleErr?.message });
          }
        });
      }
      stageEnd('pipeline');
      this.updatePipelineProgress(32, 'Complete', 100, { force: true });
      this.setStatus('DONE');
      try { window.dispatchEvent(new CustomEvent('vip:processingDone')); } catch (_) {}
    } catch (err) {
      structuredLog('error', '[VIP] Pipeline error', { err: err.message });
      this.setStatus('ERROR');
      this.showNotification('Processing failed: ' + err.message, 'error');
      this.updatePipelineProgress(0, 'Error', 0, { force: true });
    } finally {
      // Always unlock the UI — never leave the bar stuck mid-process.
      this.isProcessing = false;
      this._updateProcessButtonsState();
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

  async pip() {
    // Alias — kept for compatibility
    return this.runPipeline();
  }

  /**
   * Build mid (L+R)/2 for multi-channel — one ML pass instead of N channels.
   * @param {AudioBuffer} buf
   * @returns {{ channelData: Float32Array[], expandStereo: boolean, left?: Float32Array, right?: Float32Array, mid?: Float32Array }}
   */
  _mlChannelPlan(buf) {
    const nCh = buf.numberOfChannels;
    if (nCh < 2) {
      // Owned copy — safe to transfer to the ML worker without a second memcpy.
      return { channelData: [new Float32Array(buf.getChannelData(0))], expandStereo: false };
    }
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);
    const mid = new Float32Array(left.length);
    // Unrolled-ish mid mix (single pass).
    for (let i = 0; i < left.length; i++) mid[i] = 0.5 * (left[i] + right[i]);
    return { channelData: [mid], expandStereo: true, left, right, mid };
  }

  /**
   * Apply mono clean stem as a per-sample gain envelope onto stereo sources.
   * Preserves L/R imaging while only running ML once on the mid channel.
   * `mid` may be null/detached after worker transfer — recompute from L/R.
   */
  _expandMonoCleanToStereo(cleanMono, mid, left, right) {
    const n = cleanMono.length;
    const cleanL = new Float32Array(n);
    const cleanR = new Float32Array(n);
    const midOk = mid && mid.length >= n;
    for (let i = 0; i < n; i++) {
      const m = midOk ? mid[i] : 0.5 * (left[i] + right[i]);
      let g = Math.abs(m) > 1e-8 ? cleanMono[i] / m : 0;
      if (g < 0) g = 0;
      else if (g > 1.35) g = 1.35;
      cleanL[i] = left[i] * g;
      cleanR[i] = right[i] * g;
    }
    return [cleanL, cleanR];
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
    try {
      await this.ensureCtx();
      // Warmup may already run from handleFile — keep it in flight but never block
      // pipeline start on full ONNX compile (can take 30–120s on first load).
      void this._warmupMLModels().catch(() => {});
      const { separateStems, stemsToAudioBuffer } = await import('/src/pipeline/StemSeparation.js');
      const plan = this._mlChannelPlan(buf);
      // Keep a non-transferred mid copy for stereo expand (worker detaches transfer list).
      const midCopy = plan.expandStereo && plan.mid
        ? new Float32Array(plan.mid)
        : null;
      this.updatePipelineProgress(4, plan.expandStereo ? 'ML isolation (mid)…' : 'ML isolation…', 15);
      const result = await separateStems(plan.channelData, buf.sampleRate, {
        modelIds: DEFAULT_ML_CHAIN,
        sourceName: this._sourceName || '',
        // Owned Float32Arrays from _mlChannelPlan — transfer, don't re-copy.
        transferOwned: true,
        onProgress: (ev) => {
          if (fileSeq !== this._fileSeq || this.abortFlag) return;
          const workerPct = Number(ev.percent);
          const mapped = this._mapMlProgressPercent(
            Number.isFinite(workerPct) ? workerPct : 0,
          );
          if (ev.type === 'stage') {
            const label = ev.label || `ML: ${ev.stage} (${ev.modelId || 'model'})…`;
            this.updatePipelineProgress(4, label, mapped);
          } else if (ev.type === 'progress') {
            this.updatePipelineProgress(4, 'ML isolation…', mapped);
          }
        },
      });
      if (fileSeq !== this._fileSeq) return false;
      if (result.passthrough) return false;

      this.updatePipelineProgress(18, 'Reconstructing stems…', 88);
      let clean = result.clean;
      if (plan.expandStereo && clean?.[0] && plan.left && plan.right) {
        clean = this._expandMonoCleanToStereo(
          clean[0],
          midCopy || plan.mid,
          plan.left,
          plan.right,
        );
      }
      // Fast time-domain HF tame — kills residual ML mask whistle without a 2nd STFT.
      try {
        this._postIsolationDeWhistle(clean, result.sampleRate || buf.sampleRate);
      } catch (dwErr) {
        structuredLog('warn', '[VIP] post-isolation dewhistle skipped', { err: dwErr?.message });
      }
      this.outputBuffer = stemsToAudioBuffer(this.ctx, clean, result.sampleRate);
      this.procBuffer = this.outputBuffer;
      // Keep origBuffer as the ML source of truth for subsequent reprocess/cache keys.
      if (!this.origBuffer) this.origBuffer = buf;
      const mlLabel = result.fromCache ? 'ML isolation (cached)' : 'ML isolation complete';
      this.updatePipelineProgress(20, mlLabel, 90);
      structuredLog('info', '[VIP] ML isolation done', {
        fromCache: Boolean(result.fromCache),
        channels: clean.length,
        midOnly: plan.expandStereo,
        samples: clean[0]?.length || 0,
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

    await this.ensureCtx();
    const DSP = this._resolveDSP();
    const p = window.VIP_PARAMS || {};
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
    // Yield less often during bulk DSP — 24ms budget keeps UI alive without thrashing.
    const yieldBudget = createYieldBudget(24);
    if (processStereoAsMid) {
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      const mid = new Float32Array(len);
      const CHUNK = 48000 * 4; // ~4 s between yields
      for (let i = 0; i < len; i++) {
        mid[i] = 0.5 * (L[i] + R[i]);
        if (i > 0 && (i % CHUNK) === 0) await yieldBudget();
      }
      channels = [mid];
      // Reuse the mid buffer on expand — avoid a second full mid mix.
      this._dspStereoSources = { L, R, mid };
    } else {
      channels = [buf.getChannelData(0).slice()];
      this._dspStereoSources = null;
    }
    await yieldToBrowser();

    // ── Pass 1–2: input conditioning + time-domain cleanup ──
    this.updatePipelineProgress(3, 'Conditioning input…', 8);
    for (let ch = 0; ch < channels.length; ch++) {
      let data = channels[ch];
      DSP.removeDCOffset(data, sr);
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
      if ((p.deEssAmt ?? 0) > 0) DSP.deEss(data, p.deEssFreq ?? 6000, p.deEssAmt ?? 0, sr);
      channels[ch] = data;
    }

    // ── Pass 3–5: spectral isolation — ONE STFT/iSTFT per process channel ──
    this.updatePipelineProgress(10, 'Spectral isolation…', 20);
    const regionMaps = {
      protect: this._protectRegions || [],
      suppress: this._suppressRegions || [],
    };
    for (let ch = 0; ch < channels.length; ch++) {
      if (this.abortFlag) break;
      channels[ch] = await this._spectralStageAsync(channels[ch], sr, p, (frac) => {
        const pct = 20 + Math.round(frac * 40);
        this.updatePipelineProgress(10, 'Spectral isolation…', pct);
      }, regionMaps) || channels[ch];
    }

    // Expand mono-processed mid back to stereo with gain envelope.
    if (processStereoAsMid && this._dspStereoSources) {
      const midProc = channels[0];
      const { L, R, mid } = this._dspStereoSources;
      channels = this._expandMonoCleanToStereo(midProc, mid, L, R);
      this._dspStereoSources = null;
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

    // Assemble the processed AudioBuffer.
    this.updatePipelineProgress(28, 'Rendering output…', 88);
    const outCh = channels.length;
    let processed = this.ctx.createBuffer(outCh, len, sr);
    for (let ch = 0; ch < outCh; ch++) {
      const src = channels[ch];
      processed.getChannelData(ch).set(src.length === len ? src : src.subarray(0, len));
    }

    // S28 dry/wet blend with the untouched original.
    const dryWetPct = Math.max(0, Math.min(100, p.dryWet ?? 100));
    if (dryWetPct < 100) processed = this.mixDW(buf, processed, dryWetPct / 100);

    // Output gain trim.
    const outGainDb = p.outGain ?? 0;
    if (outGainDb !== 0) {
      const gain = Math.pow(10, outGainDb / 20);
      for (let ch = 0; ch < processed.numberOfChannels; ch++) {
        const out = processed.getChannelData(ch);
        for (let i = 0; i < out.length; i++) out[i] *= gain;
      }
    }

    // Final brickwall safety limit + optional dither.
    const ceil = Math.min(p.limThresh ?? -1, -0.1);
    for (let ch = 0; ch < processed.numberOfChannels; ch++) {
      const out = processed.getChannelData(ch);
      DSP.truePeakLimit(out, ceil);
      if ((p.ditherAmt ?? 0) > 0) this.applyDither(out, p);
    }

    this.procBuffer = processed;
    this.outputBuffer = processed;
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
    const p = params || window.VIP_PARAMS || {};
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

  applyBgSuppress(spec, p) {
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
    // Phase correlation correction
    const strength = (p.phaseCorr || 0) / 100;
    if (strength < 0.001) return;
  }

  applyCrosstalkCancel(spec, p) {
    if (!p.crosstalkCancel) return;
    // Crosstalk cancellation
    const strength = (p.crosstalkCancel || 0) / 100;
    if (strength < 0.001) return;
  }

  /**
   * Soft one-pole low-pass + light HF peak clamp after ML isolation.
   * Removes thin high-pitch residual without a full STFT pass (keeps speed).
   */
  _postIsolationDeWhistle(channels, sampleRate = 48000) {
    if (!channels?.length) return;
    const sr = sampleRate || 48000;
    // ~11 kHz cutoff — speech stays clear, whistle/hiss ring dies.
    const fc = 11000;
    const x = Math.exp(-2 * Math.PI * fc / sr);
    const a0 = 1 - x;
    for (let ch = 0; ch < channels.length; ch++) {
      const d = channels[ch];
      if (!d?.length) continue;
      let y = 0;
      let prev = 0;
      for (let i = 0; i < d.length; i++) {
        y = a0 * d[i] + x * y;
        // Soft clamp of high-freq delta (kills single-sample ticks / ring)
        const delta = y - prev;
        const limited = Math.max(-0.08, Math.min(0.08, delta));
        const out = prev + limited * 0.35 + (y - prev) * 0.65;
        prev = out;
        d[i] = out;
      }
    }
  }

  applyDither(buf, p) {
    const bits = p.ditherAmt || 0;
    if (!bits || bits <= 0) return;
    // Interpret ditherAmt as optional 16-bit-ish TPDF level (not bits*8 — that was too loud/harsh).
    const amp = Math.min(1e-3, Math.pow(2, -(16 + bits)) * 0.5);
    for (let i = 0; i < buf.length; i++) {
      buf[i] += (Math.random() + Math.random() - 1) * amp;
    }
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
  // Fast path: FFT 2048 / hop 1024 (50% COLA, ~2× fewer frames than 512).
  // Forensic (whisperMode ≥ 2): full 4096 / 1024 for whisper recovery quality.
  // Async STFT yields so long files no longer freeze the browser tab.
  async _spectralStageAsync(data, sr, p, onProgress, regionMaps = null) {
    const DSP = this._resolveDSP();
    const whisperMode = Math.round(p.whisperMode ?? this.whisperMode ?? 0);
    const forensic = whisperMode >= 2;
    const FFT = forensic ? 4096 : 2048;
    const HOP = 1024;
    const FRAME_CHUNK = forensic ? 128 : 256;
    if (!DSP || !data || data.length < FFT) return data;

    // Mobile yields more often; desktop keeps longer stretches for speed.
    const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
    const mobile = /Android|Mobile|Capacitor/i.test(ua);
    const yieldBudget = createYieldBudget(forensic ? (mobile ? 10 : 14) : (mobile ? 12 : 20));
    if (onProgress) onProgress(0.02);
    await yieldToBrowser();

    const stftOpts = {
      // Cooperative STFT: yield every N frames so long files never freeze the tab.
      yieldEvery: forensic ? (mobile ? 16 : 32) : (mobile ? 32 : 48),
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
        yieldEvery: forensic ? 32 : 64,
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
    const whisperLift = p.whisperLift ?? 0;
    const voiceTunnel = p.voiceTunnel ?? 0;
    const wm = WHISPER_MODE_STATES[Math.round(p.whisperMode ?? 2)] || WHISPER_MODE_STATES[2];
    const liftGain = Math.pow(10, whisperLift / 20) * wm.postGain;

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
  _applyVoiceFocus(mag, sr, p, halfN, fftSize) {
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

  // Phase-correlation correction — pull out-of-phase stereo content toward the
  // mono centre so the mix stays solid when summed to mono.
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
    if (!(this.inputBuffer || this.origBuffer) && this._sourceFile) {
      await this.ensureDecoded();
    }
    const buf = this.abMode === 'processed'
      ? (this.outputBuffer || this.procBuffer || this.inputBuffer || this.origBuffer)
      : (this.inputBuffer || this.origBuffer);
    if (!buf) return;

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
    const bridge = this._bridge || await this._ensureBridge();
    if (bridge && typeof bridge.loadBuffer === 'function') {
      try {
        if (this._bridgeBuf !== buf) {
          bridge.loadBuffer(buf);
          this._bridgeBuf = buf;
          this._transportRegionWired = false;
          const params = window.VIP_PARAMS || {};
          if (typeof bridge.applyParams === 'function') bridge.applyParams(params);
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
    if (this.dom.tpAB) this.dom.tpAB.classList.toggle('active', this.abMode === 'processed');
    // PATCHED BY vip-fixes.js — consider merging
    if (this.dom.tpABLabel) this.dom.tpABLabel.textContent = this.abMode === 'processed' ? 'Processed' : 'Original';
    if (this.isPlaying) this.play();
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
    const hasBuf = Boolean(this.inputBuffer || this.origBuffer);
    const hasOut = Boolean(this.outputBuffer || this.procBuffer);
    const busy = Boolean(this.isProcessing);
    if (this.dom.processBtn) this.dom.processBtn.disabled = !hasBuf || busy;
    if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.disabled = !hasBuf || busy;
    if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = !hasOut || busy;
    if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = !hasOut || busy;
    const heroCta = document.getElementById('heroCtaProcess');
    if (heroCta) heroCta.disabled = !hasBuf || busy;
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
      whisperLift: 18,
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

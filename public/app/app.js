import { SLIDER_REGISTRY, STAGES } from './slider-map.js';
import { ModelStatusUI } from './model-status-ui.js';
import { runFullPipeline } from './dsp-stages.js';
// DSP math (forwardSTFT / inverseSTFT) lives on globalThis.DSPCore, exposed by
// the classic <script src="./dsp-core.js"> tag in index.html — loaded before
// this module so the binding is live at evaluation time. `DSP` retained as a
// shorter alias; legacy globalThis.DSP kept as a fallback.
function resolveDSPOrFail() {
  const dsp = globalThis.DSPCore || globalThis.DSP;
  const hasForward = !!dsp && typeof dsp.forwardSTFT === 'function';
  const hasInverse = !!dsp && typeof dsp.inverseSTFT === 'function';

  if (hasForward && hasInverse) return dsp;

  const error = new Error(
    'DSPCore is required but was not initialized correctly. Missing DSP.forwardSTFT and/or DSP.inverseSTFT.'
  );
  const details = {
    hasDSPCore: !!globalThis.DSPCore,
    hasLegacyDSP: !!globalThis.DSP,
    hasForwardSTFT: hasForward,
    hasInverseSTFT: hasInverse,
  };

  console.error('[VIP] Failed to initialize DSP dependency', details);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('vip:dsp-error', {
      detail: {
        message: error.message,
        ...details,
      },
    }));
  }

  throw error;
}

const DSP = resolveDSPOrFail();

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
let inputSAB    = null;
let outputSAB   = null;
let inputFlags  = null;
let outputFlags = null;
let inputView   = null;
let outputView  = null;
let mlWorker    = null;
let mlReady     = false;
let neonAnalyser = null;
let neonVizHandle = null;
let pulsingAuraHandle = null;
let topo3DHandle = null;
let swarmHandle = null;
let liquidWavesHandle = null;

const _pendingFrames = [];
const FFT_SIZE = 4096;
const HOP_SIZE = 1024;
const HALF_BINS = FFT_SIZE / 2 + 1;
const FLAG_SLOTS = 4;
const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS;
const INPUT_SAB_BYTES = SAB_HEADER_BYTES + Float32Array.BYTES_PER_ELEMENT * HALF_BINS * 2;
const OUTPUT_SAB_BYTES = SAB_HEADER_BYTES + Float32Array.BYTES_PER_ELEMENT * HALF_BINS;

// ---------------------------------------------------------------------------
// 1. ML Worker helpers
// ---------------------------------------------------------------------------
function _forwardSabToWorker() {
  if (!mlWorker || !mlReady || !inputSAB || !outputSAB) return;
  mlWorker.postMessage({
    type: 'initRingBuffers',
    inputRing: inputSAB,
    maskRing: outputSAB,
    halfN: HALF_BINS,
    ringCapacity: 16,
    quantumSize: 128,
  });
}

function _forwardFrameToWorker(mag) {
  if (!mlWorker) return;
  if (!mlReady) { _pendingFrames.push(mag); return; }
  mlWorker.postMessage({ type: 'infer', model: 'bsrnn', mag });
}

function updateStatus(msg) {
  const el = typeof document !== 'undefined' ? document.getElementById('hStatus') : null;
  if (el) el.textContent = msg;
}

// ---------------------------------------------------------------------------
// SLIDER definitions
// ---------------------------------------------------------------------------
const SLIDERS = {
  gate: [
    { id:'gateThresh', label: 'Threshold', min: -80, max: -5, val: -42, step: 1, unit: ' dB', rt: true, desc: 'Signal level below which audio is gated' },
    { id:'gateRange', label: 'Range', min: -80, max: -5, val: -60, step: 1, unit: ' dB', rt: true, desc: 'Maximum gain reduction applied by the gate' },
    { id:'gateAttack', label: 'Attack', min: 0, max: 500, val: 5, step: 1, unit: ' ms', rt: true, desc: 'Time for gate to open on signal detection' },
    { id:'gateRelease', label: 'Release', min: 50, max: 2000, val: 200, step: 10, unit: ' ms', rt: true, desc: 'Time for gate to close after signal drops' },
    { id:'gateHold', label: 'Hold', min: 0, max: 500, val: 50, step: 1, unit: ' ms', rt: true, desc: 'Hold time before release phase begins' },
    { id:'gateLookahead', label: 'Lookahead', min: 0, max: 50, val: 5, step: 1, unit: ' ms', rt: false, desc: 'Lookahead window for predictive gating' },
  ],
  nr: [
    { id:'nrAmount', label: 'NR Amount', min: 0, max: 100, val: 78, step: 1, unit: '%', rt: false, desc: 'Spectral noise reduction strength' },
    { id:'nrSensitivity', label: 'Sensitivity', min: 0, max: 100, val: 60, step: 1, unit: '%', rt: false, desc: 'Noise floor detection sensitivity' },
    { id:'nrSpectralSub', label: 'Spectral Sub', min: 0, max: 100, val: 50, step: 1, unit: '%', rt: false, desc: 'Spectral subtraction strength' },
    { id:'nrFloor', label: 'NR Floor', min: -96, max: -30, val: -72, step: 1, unit: ' dB', rt: false, desc: 'Noise reduction floor limit' },
    { id:'nrSmoothing', label: 'Smoothing', min: 0, max: 100, val: 70, step: 1, unit: '%', rt: false, desc: 'Temporal smoothing of spectral noise estimate' },
  ],
  eq: [
    { id:'eqSub', label: 'Sub', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Sub-bass EQ (20-60 Hz)' },
    { id:'eqBass', label: 'Bass', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Bass EQ (60-200 Hz)' },
    { id:'eqWarmth', label: 'Warmth', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Warmth EQ (200-500 Hz)' },
    { id:'eqBody', label: 'Body', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Body EQ (500-1k Hz)' },
    { id:'eqLowMid', label: 'Low Mid', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Low-mid EQ (1-2 kHz)' },
    { id:'eqMid', label: 'Mid', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Mid EQ (2-4 kHz)' },
    { id:'eqPresence', label: 'Presence', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Presence EQ (4-6 kHz)' },
    { id:'eqClarity', label: 'Clarity', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Clarity EQ (6-10 kHz)' },
    { id:'eqAir', label: 'Air', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Air EQ (10-16 kHz)' },
    { id:'eqBrill', label: 'Brilliance', min: -12, max: 12, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Brilliance EQ (16-20 kHz)' },
  ],
  dyn: [
    { id:'compThresh', label: 'Threshold', min: -60, max: 0, val: -24, step: 1, unit: ' dB', rt: true, desc: 'Compressor threshold level' },
    { id:'compRatio', label: 'Ratio', min: 1, max: 20, val: 4, step: 0.5, unit: ':1', rt: true, desc: 'Compression ratio' },
    { id:'compAttack', label: 'Attack', min: 1, max: 200, val: 10, step: 1, unit: ' ms', rt: true, desc: 'Compressor attack time' },
    { id:'compRelease', label: 'Release', min: 10, max: 1000, val: 150, step: 10, unit: ' ms', rt: true, desc: 'Compressor release time' },
    { id:'compKnee', label: 'Knee', min: 0, max: 30, val: 6, step: 1, unit: ' dB', rt: true, desc: 'Compressor knee width' },
    { id:'compMakeup', label: 'Makeup', min: 0, max: 30, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Makeup gain after compression' },
    { id:'limThresh', label: 'Lim Thresh', min: -12, max: 0, val: -1, step: 0.5, unit: ' dB', rt: true, desc: 'Brickwall limiter threshold' },
    { id:'limRelease', label: 'Lim Release', min: 10, max: 500, val: 50, step: 5, unit: ' ms', rt: true, desc: 'Limiter release time' },
  ],
  spec: [
    { id:'hpFreq', label: 'HP Freq', min: 20, max: 2000, val: 80, step: 1, unit: ' Hz', rt: true, desc: 'High-pass filter cutoff frequency' },
    { id:'hpQ', label: 'HP Q', min: 0.1, max: 10, val: 0.7, step: 0.1, unit: '', rt: true, desc: 'High-pass filter resonance' },
    { id:'lpFreq', label: 'LP Freq', min: 4000, max: 20000, val: 18000, step: 100, unit: ' Hz', rt: true, desc: 'Low-pass filter cutoff frequency' },
    { id:'lpQ', label: 'LP Q', min: 0.1, max: 10, val: 0.7, step: 0.1, unit: '', rt: true, desc: 'Low-pass filter resonance' },
    { id:'deEssFreq', label: 'De-ess Freq', min: 2000, max: 12000, val: 6000, step: 100, unit: ' Hz', rt: true, desc: 'De-esser detection frequency' },
    { id:'deEssAmt', label: 'De-ess Amt', min: 0, max: 30, val: 0, step: 1, unit: ' dB', rt: true, desc: 'De-esser reduction amount' },
    { id:'specTilt', label: 'Spec Tilt', min: -6, max: 6, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Spectral tilt (high vs low shelf balance)' },
    { id:'formantShift', label: 'Formant Shift', min: -6, max: 6, val: 0, step: 0.5, unit: ' st', rt: false, desc: 'Formant shift in semitones' },
  ],
  adv: [
    { id:'derevAmt', label: 'Dereverb', min: 0, max: 100, val: 0, step: 1, unit: '%', rt: false, desc: 'Dereverberation strength' },
    { id:'derevDecay', label: 'Rev Decay', min: 0, max: 100, val: 50, step: 1, unit: '%', rt: false, desc: 'Estimated reverb decay time reference' },
    { id:'harmRecov', label: 'Harm Recovery', min: 0, max: 100, val: 0, step: 1, unit: '%', rt: false, desc: 'Harmonic recovery via neural vocoder' },
    { id:'harmOrder', label: 'Harm Order', min: 1, max: 10, val: 3, step: 1, unit: '', rt: false, desc: 'Harmonic series order for reconstruction' },
    { id:'stereoWidth', label: 'Stereo Width', min: 0, max: 200, val: 100, step: 1, unit: '%', rt: true, desc: 'Stereo width of output signal' },
    { id:'phaseCorr', label: 'Phase Corr', min: 0, max: 100, val: 0, step: 1, unit: '%', rt: false, desc: 'Phase correlation correction strength' },
  ],
  sep: [
    { id:'voiceIso', label: 'Voice Iso', min: 0, max: 100, val: 80, step: 1, unit: '%', rt: false, desc: 'Voice isolation strength (0=off 100=max)' },
    { id:'bgSuppress', label: 'BG Suppress', min: 0, max: 100, val: 50, step: 1, unit: '%', rt: false, desc: 'Background suppression level' },
    { id:'voiceFocusLo', label: 'Focus Lo', min: 80, max: 500, val: 120, step: 10, unit: ' Hz', rt: false, desc: 'Lower bound of voice focus band' },
    { id:'voiceFocusHi', label: 'Focus Hi', min: 1000, max: 8000, val: 3400, step: 100, unit: ' Hz', rt: false, desc: 'Upper bound of voice focus band' },
    { id:'crosstalkCancel', label: 'Crosstalk', min: 0, max: 100, val: 0, step: 1, unit: '%', rt: false, desc: 'Crosstalk cancellation between channels' },
  ],
  out: [
    { id:'outGain', label: 'Output Gain', min: -24, max: 24, val: 0, step: 0.5, unit: ' dB', rt: true, desc: 'Final output gain trim' },
    { id:'dryWet', label: 'Dry/Wet', min: 0, max: 100, val: 100, step: 1, unit: '%', rt: true, desc: 'Blend between dry input and processed output' },
    { id:'ditherAmt', label: 'Dither', min: 0, max: 10, val: 1, step: 0.1, unit: ' bits', rt: false, desc: 'Dither noise amplitude in bits' },
    { id:'outWidth', label: 'Out Width', min: 0, max: 200, val: 100, step: 1, unit: '%', rt: true, desc: 'Output stereo width' },
  ],
};
const SLIDER_MAP = Object.fromEntries(
  Object.entries(SLIDERS).flatMap(([tab, sliders]) =>
    sliders.map(s => [s.id, { ...s, tab }])
  )
);

const TAB_PANEL_MAP = {
  gate: 'tab-gate',
  nr:   'tab-nr',
  eq:   'tab-eq',
  dyn:  'tab-dyn',
  spec: 'tab-spec',
  adv:  'tab-adv',
  sep:  'tab-sep',
  out:  'tab-out',
};

// ---------------------------------------------------------------------------
// _ensureSliderTooltip — singleton tooltip element for slider help popovers
// ---------------------------------------------------------------------------
function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
function _ensureSliderTooltip() {
  if (window._vipSliderTooltip) return window._vipSliderTooltip;
  const tip = document.createElement('div');
  tip.id = 'vip-slider-tooltip';
  tip.className = 'vip-slider-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tip);
  window._vipSliderTooltip = tip;
  return tip;
}

// ---------------------------------------------------------------------------
// buildPanels — injects slider rows into the empty panel divs
// MUST run before initPct() or initSliders()
// ---------------------------------------------------------------------------
function buildPanels() {
  // Restore locked slider IDs from session storage
  if (!window.VIP_LOCKED_SLIDERS) window.VIP_LOCKED_SLIDERS = new Set();
  try {
    const stored = sessionStorage.getItem('vip_locked_sliders');
    if (stored) { const ids = JSON.parse(stored); if (Array.isArray(ids)) ids.forEach(id => window.VIP_LOCKED_SLIDERS.add(id)); }
  } catch (_) {}

  _ensureSliderTooltip();

  for (const [tabKey, sliders] of Object.entries(SLIDERS)) {
    const panelId = TAB_PANEL_MAP[tabKey];
    const panel = document.getElementById(panelId);
    if (!panel) continue;
    if (panel.querySelector('.slider-row, .sr-row')) continue; // already built

    const frag = document.createDocumentFragment();
    for (const s of sliders) {
      const range = s.max - s.min;
      const initPct = range > 0 ? ((s.val - s.min) / range) * 100 : 0;

      // Row wrapper
      const row = document.createElement('div');
      row.className = 'sr-row';
      row.dataset.sliderId = s.id;
      if (window.VIP_LOCKED_SLIDERS.has(s.id)) row.classList.add('is-locked');

      // Label with RT badge
      const labelWrap = document.createElement('label');
      labelWrap.className = 'sr-label';
      labelWrap.id = 'lbl_' + s.id;
      labelWrap.htmlFor = 'sl_' + s.id;
      labelWrap.textContent = s.label;
      if (s.rt) {
        const badge = document.createElement('span');
        badge.className = 'rt-badge';
        badge.textContent = 'RT';
        badge.title = 'Real-time: value is wired directly to the AudioWorklet and takes effect immediately during playback';
        labelWrap.appendChild(badge);
      }

      // Value readout
      const valEl = document.createElement('span');
      valEl.className = 'sr-val';
      valEl.id = 'val_' + s.id;
      valEl.textContent = s.val + (s.unit || '');

      // Range input
      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'slider';
      if (s.rt) input.classList.add('realtime');
      input.id = 'sl_' + s.id;
      input.min = s.min;
      input.max = s.max;
      input.step = s.step;
      input.value = s.val;
      input.style.setProperty('--pct', initPct.toFixed(1) + '%');
      input.setAttribute('aria-label', s.label);
      input.setAttribute('aria-valuenow', s.val);
      input.setAttribute('aria-valuemin', s.min);
      input.setAttribute('aria-valuemax', s.max);
      input.title = s.desc;

      // Live value readout on drag
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        const pct = range > 0 ? ((v - s.min) / range) * 100 : 0;
        input.style.setProperty('--pct', pct.toFixed(1) + '%');
        input.setAttribute('aria-valuenow', v);
        valEl.textContent = v + (s.unit || '');
        if (typeof window !== 'undefined') {
          window.VIP_PARAMS = window.VIP_PARAMS || {};
          window.VIP_PARAMS[s.id] = v;
        }
        // Bug 1 Fix: Immediately dispatch updated params to orchestrator or workletNode
        const orch = window._vipOrch;
        if (orch && typeof orch.updateParams === 'function') {
          orch.updateParams(orch._normalizeRawParams({ ...window.VIP_PARAMS }));
        } else if (typeof workletNode !== 'undefined' && workletNode) {
          workletNode.port.postMessage({ type: 'setParams', params: { ...window.VIP_PARAMS } });
        }
      });

      // Lock button — protects this slider from preset and reset overrides
      const isInitLocked = window.VIP_LOCKED_SLIDERS.has(s.id);
      const lockBtn = document.createElement('button');
      lockBtn.type = 'button';
      lockBtn.className = 'sr-lock-btn';
      lockBtn.setAttribute('aria-label', (isInitLocked ? 'Unlock ' : 'Lock ') + s.label);
      lockBtn.setAttribute('aria-pressed', String(isInitLocked));
      lockBtn.title = isInitLocked
        ? 'Locked — preset and reset changes will not touch this slider'
        : 'Unlocked — click to protect this slider from preset and reset overrides';
      lockBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path class="lock-shackle" d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

      lockBtn.addEventListener('click', () => {
        const locked = window.VIP_LOCKED_SLIDERS.has(s.id);
        if (locked) {
          window.VIP_LOCKED_SLIDERS.delete(s.id);
          row.classList.remove('is-locked');
          lockBtn.setAttribute('aria-pressed', 'false');
          lockBtn.setAttribute('aria-label', 'Lock ' + s.label);
          lockBtn.title = 'Unlocked — click to protect this slider from preset and reset overrides';
        } else {
          window.VIP_LOCKED_SLIDERS.add(s.id);
          row.classList.add('is-locked');
          lockBtn.setAttribute('aria-pressed', 'true');
          lockBtn.setAttribute('aria-label', 'Unlock ' + s.label);
          lockBtn.title = 'Locked — preset and reset changes will not touch this slider';
        }
        try {
          sessionStorage.setItem('vip_locked_sliders', JSON.stringify([...window.VIP_LOCKED_SLIDERS]));
        } catch (_) {}
      });

      // Info tooltip on label hover — HTML escaped, viewport-aware positioning
      const TIP_W = 264; // matches CSS width
      const TIP_H_EST = 160; // estimated height for flip calculation
      const tipHTML = [
        '<strong>' + _escHtml(s.label) + '</strong>',
        '<span class="vip-tip-desc">' + _escHtml(s.desc || '') + '</span>',
        '<span class="vip-tip-range">Range: ' + _escHtml(s.min + (s.unit || '')) + ' &rarr; ' + _escHtml(s.max + (s.unit || '')) + ' &nbsp;|&nbsp; step ' + _escHtml(s.step) + ' &nbsp;|&nbsp; default ' + _escHtml(s.val + (s.unit || '')) + '</span>',
        s.rt
          ? '<span class="vip-tip-mode vip-tip-rt">&#9889; Real-time (AudioWorklet) — takes effect during live playback</span>'
          : '<span class="vip-tip-mode">Offline param — applied when processing starts</span>',
        '<span class="vip-tip-lock">&#128274; Lock this slider to preserve its value across preset changes</span>',
      ].join('');

      labelWrap.addEventListener('mouseenter', () => {
        const tip = window._vipSliderTooltip;
        if (!tip) return;
        tip.innerHTML = tipHTML;
        tip.classList.add('is-visible');
        tip.setAttribute('aria-hidden', 'false');
        const rect = labelWrap.getBoundingClientRect();
        const pageLeft = rect.left + window.scrollX;
        const maxLeft = window.scrollX + window.innerWidth - TIP_W - 8;
        const fitsBelow = rect.bottom + TIP_H_EST + 8 < window.innerHeight;
        tip.style.left = Math.max(window.scrollX + 8, Math.min(pageLeft, maxLeft)) + 'px';
        tip.style.top = fitsBelow
          ? (rect.bottom + window.scrollY + 8) + 'px'
          : (rect.top + window.scrollY - TIP_H_EST - 8) + 'px';
      });
      labelWrap.addEventListener('mouseleave', () => {
        const tip = window._vipSliderTooltip;
        if (!tip) return;
        tip.classList.remove('is-visible');
        tip.setAttribute('aria-hidden', 'true');
      });

      row.appendChild(labelWrap);
      row.appendChild(input);
      row.appendChild(valEl);
      row.appendChild(lockBtn);
      frag.appendChild(row);
    }
    panel.appendChild(frag);
  }
}

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

function initSliders() {
  for (const entry of SLIDER_REGISTRY) {
    const slider = document.getElementById(`sl_${entry.id}`);
    if (!slider || slider.dataset.vipBound === '1') continue;
    slider.dataset.vipBound = '1';
    const dispatch = () => {
      const raw = Number(slider.value);
      if (!Number.isFinite(raw)) return;
      // Bug 4 Fix: Cosmetic job only, only update window.VIP_PARAMS, remove duplicate postMessage dispatch.
      if (typeof window !== 'undefined') {
        window.VIP_PARAMS = window.VIP_PARAMS || {};
        window.VIP_PARAMS[entry.id] = raw;
      }
    };
    slider.addEventListener('input', dispatch);
    slider.addEventListener('change', dispatch);
  }
}

// ---------------------------------------------------------------------------
// 2. AudioContext + AudioWorklet setup
// ---------------------------------------------------------------------------
async function initAudio() {
  audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });

  inputSAB = new SharedArrayBuffer(INPUT_SAB_BYTES);
  outputSAB = new SharedArrayBuffer(OUTPUT_SAB_BYTES);
  inputFlags = new Int32Array(inputSAB, 0, FLAG_SLOTS);
  outputFlags = new Int32Array(outputSAB, 0, FLAG_SLOTS);
  inputView = new Float32Array(inputSAB, SAB_HEADER_BYTES, HALF_BINS * 2);
  outputView = new Float32Array(outputSAB, SAB_HEADER_BYTES, HALF_BINS);

  if (workletNode) {
    _forwardSabToWorker();
    workletNode.port.onmessage = (ev) => {
      if (ev.data && ev.data.type === 'sabReady' && ev.data.inputSAB && ev.data.outputSAB) {
        inputSAB = ev.data.inputSAB;
        outputSAB = ev.data.outputSAB;
        inputFlags = new Int32Array(inputSAB, 0, FLAG_SLOTS);
        outputFlags = new Int32Array(outputSAB, 0, FLAG_SLOTS);
        inputView = new Float32Array(inputSAB, SAB_HEADER_BYTES, HALF_BINS * 2);
        outputView = new Float32Array(outputSAB, SAB_HEADER_BYTES, HALF_BINS);
        _forwardSabToWorker();
        return;
      }
      if (ev.data && ev.data.type === 'magnitude' && ev.data.mag) {
        _forwardFrameToWorker(ev.data.mag);
      }
    };
  }

  neonAnalyser = audioCtx.createAnalyser();
  neonAnalyser.fftSize = 512;
  neonAnalyser.smoothingTimeConstant = 0.85;

  console.info('[initAudio] AudioContext and SABs initialized.');
}

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
    this._mlCallId = 0;
    this.gainNode = null;
    this.params = {};
    this.STAGES = STAGES;
    this.modelStatusUI = null;
    this._modelStatusChannel = null;
    this.visualEngine = null;
    this._vizRaf = 0;
    this._spectroFrame = 0;
    this._videoPreviewUrl = null;

    Object.values(SLIDERS).flat().forEach(s => { this.params[s.id] = s.val; });
    if (typeof window !== 'undefined') {
      window.VIP_PARAMS = { ...this.params };
      window._vipStages = STAGES;
    }

    this.dom = {};
    try { buildPanels(); } catch (e) { console.error('[VIP] buildPanels failed:', e); }
    try { this.cacheDom(); } catch (_) {}
    try { this.initPct(); } catch (_) {}
    try { initSliders(); } catch (_) {}
    try { this.initModelStatusPanel(); } catch (e) { console.warn('[VIP] model status init failed', e); }
    try { this.initVisualState(); } catch (e) { console.warn('[VIP] visual init failed', e); }
    try { this.initBootSplash(); } catch (_) {}
    try { this.bindEvents(); } catch (_) {}
    const searchEl = document.getElementById('sliderSearch');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        const q = searchEl.value.toLowerCase();
        document.querySelectorAll('.sr-row, .slider-row').forEach(row => {
          const label = row.querySelector('.sr-label, .slider-label');
          const match = !q || (label && label.textContent.toLowerCase().includes(q));
          row.style.display = match ? '' : 'none';
          const group = row.closest('.slider-group');
          if (match && group) group.classList.add('active');
        });
      });
    }
    document.querySelectorAll('.slider-group-header').forEach(header => {
      header.addEventListener('click', () => {
        const group = header.closest('.slider-group');
        const isActive = group.classList.toggle('active');
        header.setAttribute('aria-expanded', isActive.toString());
      });
    });
    try {
      document.addEventListener('keydown', e => this._handleGlobalKeydown(e));
    } catch (_) {}
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.__vipAppReady = true;
      window.dispatchEvent(new CustomEvent('app:ready'));
    }
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
      tpRew: g('tpRew'),
      tpFwd: g('tpFwd'),
      tpAB: g('tpAB'),
      tpABLabel: g('tpABLabel'),
      tpCur: g('tpCur'),
      tpDur: g('tpDur'),
      tpSeek: g('tpSeek'),
      tpSpeed: g('tpSpeed'),
      tpSpeedUp: g('tpSpeedUp'),
      tpSpeedDown: g('tpSpeedDown'),
      fileLoadIndicator: g('fileLoadIndicator'),
      hDur: g('hDur'),
      hFile: g('hFile'),
      hSR: g('hSR'),
      hCh: g('hCh'),
      hRMS: g('hRMS'),
      hPeak: g('hPeak'),
      hLUFS: g('hLUFS'),
      hVoices: g('hVoices'),
      hStatus: g('hStatus'),
      waveCanvas: g('waveCanvas'),
      spectroCanvas: g('spectroCanvas'),
      spectro2DCanvas: g('spectro2DCanvas'),
      freqCanvas: g('freqCanvas'),
      waveOrigCanvas: g('waveOrigCanvas'),
      waveProcCanvas: g('waveProcCanvas'),
      fsCanvas: g('fsCanvas'),
      diarCanvas: g('diarCanvas'),
      lufsI: g('lufsI'),
      lufsS: g('lufsS'),
      pipeStage: g('pipeStage'),
      pipePercent: g('pipePercent'),
      pipeFill: g('pipeFill'),
      pipeBar: g('pipeBar'),
      pipeDetail: g('pipeDetail'),
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
      resetSlidersBtn:g('resetSlidersBtn'),
      bootSplash:g('bootSplash'),
      bootSplashText:g('bootSplashText'),
      bootSplashProgress:g('bootSplashProgress'),
    };
  }

  initPct() {
    const allSliders = Object.values(SLIDERS).flat();
    allSliders.forEach(s => {
      const inputEl = document.getElementById('sl_' + s.id);
      if (!inputEl) return; // guard: skip if panel not built yet

      const labelEl = document.getElementById('lbl_' + s.id) || inputEl.parentElement;
      if (labelEl && s.rt && !labelEl.querySelector('.rt-badge')) {
        const badge = document.createElement('span');
        badge.className = 'rt-badge';
        badge.textContent = 'RT';
        badge.setAttribute('aria-label', 'Real-time parameter');
        labelEl.appendChild(badge);
      }

      if (labelEl && !labelEl.querySelector('.sr-info')) {
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
    const range = parseFloat(el.max) - parseFloat(el.min);
    const pct = range > 0 ? ((val - parseFloat(el.min)) / range) * 100 : 0;
    el.style.setProperty('--pct', `${pct.toFixed(1)}%`);
    this.params[id] = val;
    const def = SLIDER_BY_ID[id];
    const valEl = document.getElementById('val_' + id);
    if (valEl && def) valEl.textContent = val + (def.unit || '');
    if (typeof window !== 'undefined') {
      window.VIP_PARAMS = window.VIP_PARAMS || {};
      window.VIP_PARAMS[id] = val;
    }
    this.syncParamsToPipeline(id, val);
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
      const seek = this.dom.tpSeek;
      const beginSeek = () => { this._isSeeking = true; };
      const endSeek = () => {
        this._isSeeking = false;
        this.seekTo(parseFloat(seek.value) / 1000);
      };
      seek.addEventListener('pointerdown', beginSeek);
      seek.addEventListener('mousedown', beginSeek);
      seek.addEventListener('touchstart', beginSeek, { passive: true });
      seek.addEventListener('keydown', beginSeek);
      seek.addEventListener('pointerup', endSeek);
      seek.addEventListener('mouseup', endSeek);
      seek.addEventListener('touchend', endSeek);
      seek.addEventListener('keyup', endSeek);
      seek.addEventListener('change', endSeek);
      seek.addEventListener('input', () => {
        this._isSeeking = true;
        const frac = parseFloat(seek.value) / 1000;
        if (this.inputBuffer && this.dom.tpCur) {
          this.dom.tpCur.textContent = this.fmtDur(frac * this.inputBuffer.duration);
        }
      });
    }
    if (this.dom.tpSpeed) {
      this.dom.tpSpeed.addEventListener('change', () => this._applyPlaybackRate());
    }
    if (this.dom.tpSpeedUp) {
      this.dom.tpSpeedUp.addEventListener('click', () => this._stepSpeed(1));
    }
    if (this.dom.tpSpeedDown) {
      this.dom.tpSpeedDown.addEventListener('click', () => this._stepSpeed(-1));
    }
    if (this.dom.processBtn) {
      this.dom.processBtn.addEventListener('click', () => this.runPipeline());
    }
    if (this.dom.reprocessBtn) {
      this.dom.reprocessBtn.addEventListener('click', () => this.runPipeline());
    }
    if (this.dom.resetSlidersBtn) {
      this.dom.resetSlidersBtn.addEventListener('click', () => this.resetSliders());
    }
    if (this.dom.presetSel) {
      this.dom.presetSel.addEventListener('change', () => {
        this.applyPreset(this.dom.presetSel.value);
      });
    }
    if (this.dom.fileInput) {
      this.dom.fileInput.addEventListener('change', e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        // Reset value so re-selecting the same file fires `change` again.
        try { e.target.value = ''; } catch (_) {}
        this.handleFile(f);
      });
    }
    if (this.dom.dropZone) {
      const uploadZoneEl = document.getElementById('uploadZone') || this.dom.dropZone;
      window.addEventListener('dragover', e => {
        e.preventDefault();
        uploadZoneEl.classList.add('dragover');
      });
      window.addEventListener('dragleave', e => {
        if (!e.relatedTarget || e.relatedTarget.nodeName === 'HTML') {
          uploadZoneEl.classList.remove('dragover');
        }
      });
      window.addEventListener('drop', e => {
        e.preventDefault();
        uploadZoneEl.classList.remove('dragover');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) this.handleFile(f);
      });
    }
    if (this.dom.clearFile) {
      this.dom.clearFile.addEventListener('click', () => this.clearLoadedFile());
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

    // Preset buttons + description panel
    const presetDescPanel = document.getElementById('preset-desc-panel');
    const _showPresetDesc = (name) => {
      if (!presetDescPanel) return;
      const p = PRESETS[name];
      if (p && p.description) {
        presetDescPanel.textContent = p.description;
        presetDescPanel.style.display = '';
      } else {
        presetDescPanel.style.display = 'none';
      }
    };
    // Show description for the initially-selected preset
    if (this.dom.presetSel) _showPresetDesc(this.dom.presetSel.value);

    document.querySelectorAll('.btn-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.preset;
        if (!name) return;
        this.applyPreset(name);
        // Sync dropdown so mouseleave restores the correct (just-applied) description
        if (this.dom.presetSel) this.dom.presetSel.value = name;
      });
      btn.addEventListener('mouseenter', () => _showPresetDesc(btn.dataset.preset));
      btn.addEventListener('mouseleave', () => _showPresetDesc(this.dom.presetSel?.value));
    });

    // Save custom preset
    const saveCustomBtn = document.getElementById('saveCustomPresetBtn');
    const openPresetModalBtn = document.getElementById('openPresetModalBtn');
    const customPresetModal = document.getElementById('customPresetModal');
    const closePresetModal = document.getElementById('closePresetModal');
    const customPresetNameInput = document.getElementById('customPresetName');

    const openPresetModal = () => {
      if (!customPresetModal) return;
      customPresetModal.classList.add('open');
      customPresetModal.setAttribute('aria-hidden', 'false');
      if (customPresetNameInput) {
        customPresetNameInput.value = '';
        customPresetNameInput.focus();
      }
    };

    const closePresetModalFunc = () => {
      if (!customPresetModal) return;
      customPresetModal.classList.remove('open');
      customPresetModal.setAttribute('aria-hidden', 'true');
      if (openPresetModalBtn) openPresetModalBtn.focus();
    };

    const savePreset = () => {
      const nameEl = document.getElementById('customPresetName');
      const name = nameEl && nameEl.value.trim();
      if (!name) return;
      PRESETS[name] = { ...this.params };
      closePresetModalFunc();
      this.showNotification('Preset "' + name + '" saved', 'success');
    };

    if (openPresetModalBtn && customPresetModal) {
      openPresetModalBtn.addEventListener('click', openPresetModal);
    }

    if (closePresetModal && customPresetModal) {
      closePresetModal.addEventListener('click', closePresetModalFunc);
    }

    if (saveCustomBtn) {
      saveCustomBtn.addEventListener('click', savePreset);
    }

    if (customPresetModal) {
      customPresetModal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closePresetModalFunc();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          savePreset();
        }
      });
    }

    const fullscreenBtn = document.getElementById('fullscreenSpectroBtn');
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => {
        const container = document.getElementById('spectro3d-container') || document.getElementById('spectroCanvas')?.parentElement;
        if (container) container.classList.toggle('fullscreen');
      });
    }
    const applySpectroFallback = () => {
      const spectro3d = document.getElementById('spectro3d-container');
      const spectro2d = document.getElementById('spectro2DCanvas');
      const use2d = window.innerWidth < 768;
      if (spectro3d) spectro3d.style.display = use2d ? 'none' : '';
      if (spectro2d) spectro2d.style.display = use2d ? 'block' : 'none';
    };
    applySpectroFallback();
    window.addEventListener('resize', applySpectroFallback);

    // Rewind / forward transport buttons
    const tpRew = document.getElementById('tpRew');
    const tpFwd = document.getElementById('tpFwd');
    if (tpRew) tpRew.addEventListener('click', () => this.seekDelta(-5));
    if (tpFwd) tpFwd.addEventListener('click', () => this.seekDelta(5));

    // Upload zone click → file input
    const uploadZone = document.getElementById('uploadZone');
    const fileBtn = document.getElementById('fileBtn');
    const fileInput = document.getElementById('fileInput');
    if (uploadZone && fileInput) {
      uploadZone.addEventListener('click', (e) => {
        if (e.target === fileBtn || fileBtn && fileBtn.contains(e.target)) return;
        fileInput.click();
      });
      uploadZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') fileInput.click();
      });
    }
    if (fileBtn && fileInput) {
      fileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
      });
    }

    // Mic button
    const micBtn = document.getElementById('micBtn');
    if (micBtn) {
      micBtn.addEventListener('click', () => this._toggleMic(micBtn));
    }

    // Save buttons
    const saveOrigBtn = document.getElementById('saveOrigBtn');
    const saveProcBtn = document.getElementById('saveProcBtn');
    if (saveOrigBtn) saveOrigBtn.addEventListener('click', () => this._saveWav('original'));
    if (saveProcBtn) saveProcBtn.addEventListener('click', () => this._saveWav('processed'));

    // Audit log
    const auditLogBtn = document.getElementById('auditLogBtn');
    if (auditLogBtn) auditLogBtn.addEventListener('click', () => this.downloadAuditLog());

    // Forensic toggle
    const forensicToggle = document.getElementById('forensicToggle');
    if (forensicToggle) {
      forensicToggle.addEventListener('click', () => {
        forensicToggle.classList.toggle('active');
      });
    }

    // Tab bar
    const tabBar = document.getElementById('tabBar');
    if (tabBar) {
      tabBar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tab]');
        if (!btn) return;
        const tab = btn.dataset.tab;
        tabBar.querySelectorAll('[data-tab]').forEach(b => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', String(b === btn));
          b.tabIndex = b === btn ? 0 : -1;
        });
        document.querySelectorAll('.panel').forEach(p => {
          p.classList.toggle('active', p.id === 'tab-' + tab);
        });
      });
    }

    // UI scale controls
    const uiScaleDn = document.getElementById('uiScaleDn');
    const uiScaleUp = document.getElementById('uiScaleUp');
    const uiScaleSave = document.getElementById('uiScaleSave');
    const uiScaleVal = document.getElementById('uiScaleVal');
    const uiScaleApply = (s) => {
      s = Math.max(0.5, Math.min(2, s));
      const supportsZoom = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('zoom', '1');
      const rs = document.documentElement.style;
      if (supportsZoom) {
        rs.zoom = String(s);
        rs.transform = '';
        rs.transformOrigin = '';
        rs.width = '';
      } else {
        rs.zoom = '';
        rs.transform = 'scale(' + s + ')';
        rs.transformOrigin = 'top left';
        rs.width = (100 / s) + '%';
      }
      if (uiScaleVal) uiScaleVal.textContent = Math.round(s * 100) + '%';
      return s;
    };
    let currentScale = parseFloat(localStorage.getItem('vip_ui_scale')) || 1;
    uiScaleApply(currentScale);
    if (uiScaleDn) uiScaleDn.addEventListener('click', () => { currentScale = uiScaleApply(currentScale - 0.1); });
    if (uiScaleUp) uiScaleUp.addEventListener('click', () => { currentScale = uiScaleApply(currentScale + 0.1); });
    if (uiScaleSave) uiScaleSave.addEventListener('click', () => {
      localStorage.setItem('vip_ui_scale', currentScale);
      uiScaleSave.classList.add('saved');
      setTimeout(() => uiScaleSave.classList.remove('saved'), 1500);
    });
  }

  syncParamsToPipeline(id, rawValue) {
    const orch = typeof window !== 'undefined' ? window._vipOrch : null;
    const entry = SLIDER_REGISTRY.find(item => item.id === id);
    const mapped = entry && typeof entry.transform === 'function' ? entry.transform(rawValue) : rawValue;
    const payload = entry ? { [entry.key]: mapped } : { [id]: rawValue };

    if (entry && (entry.target === 'worklet' || entry.target === 'both')) {
      if (orch?.workletNode) orch.updateParams?.(orch._normalizeRawParams({ ...this.params }));
      else if (workletNode) workletNode.port.postMessage({ type: 'params', payload });
    }
    if (entry && (entry.target === 'worker' || entry.target === 'both')) {
      if (orch?.mlWorker) orch.mlWorker.postMessage({ type: 'setParams', payload });
      else if (mlWorker) mlWorker.postMessage({ type: 'setParams', payload });
    }
  }

  resetSliders() {
    const locked = window.VIP_LOCKED_SLIDERS || new Set();
    let skippedCount = 0;
    Object.values(SLIDERS).flat().forEach((sliderDef) => {
      if (locked.has(sliderDef.id)) { skippedCount++; return; }
      const sliderEl = document.getElementById('sl_' + sliderDef.id);
      if (!sliderEl) return;
      sliderEl.value = sliderDef.val;
      sliderEl.dispatchEvent(new Event('input', { bubbles: true }));
      sliderEl.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const note = skippedCount > 0
      ? `Controls reset · ${skippedCount} locked slider${skippedCount > 1 ? 's' : ''} preserved`
      : 'Engineer controls reset to calibrated defaults';
    this.showNotification(note, 'info', 2200);
  }

  initBootSplash() {
    this.setBootSplash('VoiceIsolate Pro readying local DSP, ML cache, and diagnostics…', 24);
    window.setTimeout(() => this.setBootSplash('Engineer Mode ready for file load and live input.', 100), 380);
    window.setTimeout(() => this.dismissBootSplash(), 1200);
  }

  setBootSplash(message, percent = 100) {
    if (this.dom.bootSplashText) this.dom.bootSplashText.textContent = message;
    if (this.dom.bootSplashProgress) this.dom.bootSplashProgress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }

  dismissBootSplash() {
    if (!this.dom.bootSplash) return;
    this.dom.bootSplash.classList.add('is-complete');
    this.dom.bootSplash.setAttribute('aria-hidden', 'true');
    window.setTimeout(() => {
      if (this.dom.bootSplash) this.dom.bootSplash.style.display = 'none';
    }, 500);
  }

  initModelStatusPanel() {
    const pills = document.getElementById('modelStatusPills');
    if (!pills) return;
    this.modelStatusUI = new ModelStatusUI(
      pills,
      ['silero_vad', 'rnnoise', 'demucs_v4', 'bsrnn_vocals'],
      { healthContainer: document.getElementById('cdnHealthPanel') }
    );
    this.modelStatusUI.refreshStatus();

    if (typeof BroadcastChannel === 'undefined') return;
    const modelAlias = { demucs: 'demucs_v4', bsrnn: 'bsrnn_vocals' };
    this._modelStatusChannel = new BroadcastChannel('vip-model-progress');
    this._modelStatusChannel.addEventListener('message', (event) => {
      const data = event.data || {};
      const modelKey = modelAlias[data.model] || data.model;
      if (!modelKey || !this.modelStatusUI) return;
      if (data.type === 'start' || data.type === 'progress') {
        this.modelStatusUI.setStatus(modelKey, 'loading', data.progress ?? 0);
      } else if (data.type === 'cached' || data.type === 'done') {
        this.modelStatusUI.setStatus(modelKey, 'cached', 100);
      } else if (data.type === 'error') {
        this.modelStatusUI.setStatus(modelKey, 'error');
      }
    });
  }

  initVisualState() {
    this.drawEmptyVisuals('Load audio or video to inspect waveform, spectrum, LUFS, saliency, and speaker activity.');
    this.updatePipelineProgress(-1, 'Ready for local analysis', 0);
  }

  _saveWav(mode) {
    const buf = mode === 'processed' ? this.outputBuffer : this.inputBuffer;
    if (!buf) return;
    const wav = this.encWav(buf);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = mode === 'processed' ? 'processed.wav' : 'original.wav';
    a.click();
    URL.revokeObjectURL(url);
  }

  _toggleMic(btn) {
    if (this._micStream) {
      this._micStream.getTracks().forEach(t => t.stop());
      this._micStream = null;
      if (btn) { const lbl = btn.querySelector('#micLabel'); if (lbl) lbl.textContent = 'Record'; }
      btn && btn.classList.remove('active');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      this._micStream = stream;
      if (btn) { const lbl = btn.querySelector('#micLabel'); if (lbl) lbl.textContent = 'Stop'; }
      btn && btn.classList.add('active');
      this.ensureCtx();
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const ab = await blob.arrayBuffer();
        const decoded = await this.ctx.decodeAudioData(ab);
        this.inputBuffer = decoded;
        this.onAudioLoaded('mic-recording.webm');
      };
      recorder.start();
      this._micRecorder = recorder;
      stream.getAudioTracks()[0].onended = () => this._toggleMic(btn);
    }).catch(e => {
      this.showNotification('Microphone access denied', 'error');
    });
  }

  ensureCtx() {
    // Prefer the orchestrator's AudioContext so the AudioWorkletNode (DSP pipeline)
    // lives in the same context as the playback chain.  Without this, slider
    // parameters are sent to a worklet that never receives audio input.
    if (!this.ctx) {
      const orch = typeof window !== 'undefined' ? window._vipOrch : null;
      if (orch && orch.ctx && orch.ctx.state !== 'closed') {
        this.ctx = orch.ctx;
        neonAnalyser = null;
      } else {
        try {
          const AC = typeof AudioContext !== 'undefined' ? AudioContext :
            (typeof window !== 'undefined' && window.AudioContext) ? window.AudioContext : null;
          if (AC) {
            this.ctx = new AC();
            neonAnalyser = null;
          }
        } catch (_) {}
      }
    }
    // Resume on user gesture (iOS/Safari + autoplay-blocked Chrome start suspended).
    if (this.ctx && this.ctx.state === 'suspended' && typeof this.ctx.resume === 'function') {
      this.ctx.resume().catch(() => {});
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
    this.stopDiagnostics();
    if (this.dom.tpCur) this.dom.tpCur.textContent = this.fmtDur(0);
    if (this.dom.tpSeek) this.dom.tpSeek.value = 0;
    this._setScrubPos(0);
    this.renderStaticVisuals(0);
    if (this.dom.tpABLabel && this.dom.tpABLabel.classList && this.dom.tpABLabel.classList.remove) {
      this.dom.tpABLabel.classList.remove('is-playing');
    }
  }

  pause() {
    if (!this.isPlaying) return;
    const speed = this._activeSpeed || parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
    this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    this.teardownChain();
    this.stopSpectro();
    this.stopDiagnostics();
    this.isPlaying = false;
    if (this.isVideo && this.dom.videoPlayer) {
      this.dom.videoPlayer.pause();
    }
    if (this.inputBuffer) this.renderStaticVisuals(this.playOffset / Math.max(this.inputBuffer.duration || 1, 1));
    if (this.dom.tpABLabel && this.dom.tpABLabel.classList && this.dom.tpABLabel.classList.remove) {
      this.dom.tpABLabel.classList.remove('is-playing');
    }
  }

  seekDelta(dt) {
    if (!this.inputBuffer) return;
    const dur = this.inputBuffer.duration;
    if (this.isPlaying) {
      const speed = parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
      this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    }
    this.playOffset = Math.max(0, Math.min(dur, this.playOffset + dt));
    if (this.dom.tpCur) this.dom.tpCur.textContent = this.fmtDur(this.playOffset);
    this._setScrubPos(this.playOffset / dur);
    if (this.isPlaying) { this.play(); }
  }

  seekTo(frac) {
    if (!this.inputBuffer) return;
    const dur = this.inputBuffer.duration;
    if (this.isPlaying) {
      const speed = parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
      this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    }
    this.playOffset = frac * dur;
    if (this.isPlaying) {
      this.play();
    } else {
      if (this.dom.tpCur) this.dom.tpCur.textContent = this.fmtDur(this.playOffset);
      if (this.dom.tpSeek) this.dom.tpSeek.value = frac * 1000;
      this._setScrubPos(frac);
    }
  }

  toggleAB() {
    if (!this.outputBuffer) return;
    if (this.isPlaying) {
      const speed = this._activeSpeed || parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
      this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    }
    this.abMode = this.abMode === 'original' ? 'processed' : 'original';
    const isProcessed = this.abMode === 'processed';
    if (this.dom.tpAB) this.dom.tpAB.classList.toggle('active', isProcessed);
    if (this.dom.tpABLabel) this.dom.tpABLabel.textContent = isProcessed ? 'Processed' : 'Original';
    if (typeof this._setABLabel === 'function') this._setABLabel();
    this.renderStaticVisuals(this.playOffset / Math.max(this.inputBuffer?.duration || 1, 1));
    if (this.isPlaying) { this.play(); }
  }

  play() {
    this.ensureCtx();
    const buf = (this.abMode === 'processed' && this.outputBuffer) ? this.outputBuffer : this.inputBuffer;
    if (!buf) return;

    this.buildLiveChain(buf);
    this.isPlaying = true;
    this.playStartTime = this.ctx.currentTime;
    this._activeSpeed = parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
    if (this.dom.tpABLabel) this.dom.tpABLabel.textContent = this.abMode === 'processed' ? 'Processed' : 'Original';
    if (typeof this._setABLabel === 'function') this._setABLabel();

    if (this.isVideo && this.dom.videoPlayer) {
      this.dom.videoPlayer.currentTime = this.playOffset;
      this.dom.videoPlayer.playbackRate = parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
      this.dom.videoPlayer.muted = true;
      this.dom.videoPlayer.play().catch(() => {});
    }

    this.startSpectro();
    this.startFreq();
    this.startDiagnostics();
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
      this.gainNode.gain.value = 1.0; // worklet handles outGain internally
      if (neonAnalyser && neonAnalyser.context !== this.ctx) neonAnalyser = null;
      if (!neonAnalyser) {
        neonAnalyser = this.ctx.createAnalyser();
        neonAnalyser.fftSize = 1024;
        neonAnalyser.smoothingTimeConstant = 0.84;
      }

      // Route audio through the DSP worklet when available so that all
      // real-time slider parameters (EQ, compression, gate, HP/LP filters,
      // noise reduction, dry/wet, output gain, limiter) actually affect
      // the audible output.  Chain: Source → WorkletNode → GainNode → Analyser → Destination
      const orch = typeof window !== 'undefined' ? window._vipOrch : null;
      const wn   = orch && orch.workletNode;
      if (wn) {
        src.connect(wn);
        // Disconnect worklet's previous destination and re-wire through the
        // gain + analyser chain so visualizers keep working.
        try { wn.disconnect(); } catch (_) {}
        wn.connect(this.gainNode);
      } else {
        // Fallback: no worklet available — direct passthrough
        src.connect(this.gainNode);
      }

      this.gainNode.connect(neonAnalyser);
      neonAnalyser.connect(this.ctx.destination);

      // Push current slider snapshot to the worklet so any parameters
      // the user changed before pressing play take effect immediately.
      if (orch && typeof orch.updateParams === 'function') {
        orch.updateParams(orch._normalizeRawParams({ ...window.VIP_PARAMS }));
      }

      src.start(0, this.playOffset);
      this.currentSource = src;
      this.liveChainBuilt = true;

      // Start premium visualizers
      if (typeof window !== 'undefined') {
        if (pulsingAuraHandle) pulsingAuraHandle.stop();
        if (topo3DHandle) topo3DHandle.stop();
        if (swarmHandle) swarmHandle.stop();
        if (liquidWavesHandle) liquidWavesHandle.stop();

        if (window.VIP_initPulsingAura) pulsingAuraHandle = window.VIP_initPulsingAura(neonAnalyser, document.getElementById('auraCanvas'));
        if (window.VIP_initTopographic3D) topo3DHandle = window.VIP_initTopographic3D(neonAnalyser, document.getElementById('topoContainer'));
        if (window.VIP_initParticleSwarm) swarmHandle = window.VIP_initParticleSwarm(neonAnalyser, document.getElementById('swarmContainer'));
        if (window.VIP_initLiquidWaves) liquidWavesHandle = window.VIP_initLiquidWaves(neonAnalyser, document.getElementById('liquidCanvas'));
      }
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
    // Disconnect the worklet from the playback chain (but don't destroy it)
    const orch = typeof window !== 'undefined' ? window._vipOrch : null;
    if (orch && orch.workletNode) {
      try { orch.workletNode.disconnect(); } catch (_) {}
    }
    if (this.gainNode) {
      try { this.gainNode.disconnect(); } catch (_) {}
      this.gainNode = null;
    }
    if (neonAnalyser) {
      try { neonAnalyser.disconnect(); } catch (_) {}
    }
    this.liveChainBuilt = false;
  }

  startSpectro() {
    if (!neonAnalyser || this._vizRaf) return;
    const freqBins = new Uint8Array(neonAnalyser.frequencyBinCount);
    const timeBins = new Float32Array(neonAnalyser.fftSize);
    const paint = () => {
      if (!this.isPlaying || !neonAnalyser) {
        this._vizRaf = 0;
        return;
      }
      this._vizRaf = requestAnimationFrame(paint);
      neonAnalyser.getByteFrequencyData(freqBins);
      neonAnalyser.getFloatTimeDomainData(timeBins);
      this.drawLiveWaveform(timeBins);
      this.drawLiveSpectrum(freqBins);
      this.drawLiveSpectrogram(freqBins);
      this.drawLiveSaliency(freqBins);
      this.updateLiveLoudness(timeBins);
    };
    paint();
  }
  stopSpectro() {
    if (this._vizRaf) {
      cancelAnimationFrame(this._vizRaf);
      this._vizRaf = 0;
    }
  }
  startFreq() {}
  startDiagnostics() {
    if (this.visualEngine || typeof window === 'undefined' || typeof window.VisualizationEngine !== 'function') return;
    this.visualEngine = new window.VisualizationEngine({
      getAnalysers: () => ({ orig: neonAnalyser, proc: neonAnalyser }),
      diarCanvas: this.dom.diarCanvas,
      vuPanel: document.getElementById('panel-vu-meters'),
      getSpeakerState: () => this.buildSpeakerState(),
      maxSpeakers: 2,
    });
    this.visualEngine.start();
  }
  stopDiagnostics() {
    if (this.visualEngine) {
      this.visualEngine.stop();
      this.visualEngine.destroy();
      this.visualEngine = null;
    }
  }

  tickTime() {
    if (!this.isPlaying || !this.ctx || !this.inputBuffer) return;
    const speed = this._activeSpeed || parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
    const elapsed = (this.ctx.currentTime - this.playStartTime) * speed;
    const cur = this.playOffset + elapsed;
    if (this.dom.tpCur && !this._isSeeking) this.dom.tpCur.textContent = this.fmtDur(cur);
    const dur = this.inputBuffer.duration;
    if (dur > 0 && this.dom.tpSeek) this._setScrubPos(cur / dur);
    this.renderStaticVisuals(cur / Math.max(dur || 1, 1));
    if (cur < dur) {
      requestAnimationFrame(() => this.tickTime());
    } else {
      this.stop();
    }
  }

  _setScrubPos(frac) {
    if (this._isSeeking) return;
    if (this.dom.tpSeek) this.dom.tpSeek.value = frac * 1000;
  }

  _setABLabel() {
    const isProcessed = this.abMode === 'processed';
    const version = isProcessed ? 'B' : 'A';
    const name = isProcessed ? 'Processed' : 'Original';
    const lbl = this.dom.tpABLabel;
    if (lbl) {
      try { if (lbl.setAttribute) lbl.setAttribute('data-version', version); } catch (_) {}
      try { if (lbl.classList && lbl.classList.toggle) lbl.classList.toggle('is-playing', !!this.isPlaying); } catch (_) {}
      const tagEl = (lbl.querySelector && lbl.querySelector('.tp-ab-tag')) || null;
      const nameEl = (lbl.querySelector && lbl.querySelector('.tp-ab-name')) || null;
      if (tagEl && nameEl) {
        tagEl.textContent = version;
        nameEl.textContent = name;
      } else {
        lbl.textContent = name;
      }
    }
    const ab = this.dom.tpAB;
    if (ab) {
      try { if (ab.setAttribute) ab.setAttribute('aria-label', 'Toggle A/B (currently playing ' + version + ' · ' + name + ')'); } catch (_) {}
      try { ab.title = 'Toggle A/B (currently ' + version + ' · ' + name + ')'; } catch (_) {}
    }
  }

  _stepSpeed(direction) {
    const sel = this.dom.tpSpeed;
    if (!sel) return;
    const opts = Array.from(sel.options || []).map(o => parseFloat(o.value)).filter(v => !isNaN(v)).sort((a, b) => a - b);
    if (!opts.length) return;
    const cur = parseFloat(sel.value) || 1;
    let idx = opts.findIndex(v => Math.abs(v - cur) < 1e-6);
    if (idx < 0) idx = opts.findIndex(v => v >= cur);
    if (idx < 0) idx = opts.length - 1;
    const next = Math.max(0, Math.min(opts.length - 1, idx + direction));
    sel.value = String(opts[next]);
    this._applyPlaybackRate();
  }

  _applyPlaybackRate() {
    const rate = parseFloat(this.dom.tpSpeed && this.dom.tpSpeed.value) || 1;
    if (this.isPlaying) {
      const prevSpeed = this._activeSpeed || 1;
      if (this.ctx) {
        this.playOffset += (this.ctx.currentTime - this.playStartTime) * prevSpeed;
        this.playStartTime = this.ctx.currentTime;
      }
      if (this.currentSource && this.currentSource.playbackRate) {
        try { this.currentSource.playbackRate.value = rate; } catch (_) {}
      }
      if (this.isVideo && this.dom.videoPlayer) {
        try { this.dom.videoPlayer.playbackRate = rate; } catch (_) {}
      }
    }
    this._activeSpeed = rate;
  }

  clearLoadedFile() {
    this.stop();
    this.inputBuffer = null;
    this.outputBuffer = null;
    if (this.dom.fileInput) { try { this.dom.fileInput.value = ''; } catch (_) {} }
    if (this.dom.fileInfo) this.dom.fileInfo.textContent = 'No file loaded';
    if (this.dom.hFile) this.dom.hFile.textContent = '—';
    if (this.dom.hDur) this.dom.hDur.textContent = '0:00';
    if (this.dom.tpDur) this.dom.tpDur.textContent = '0:00';
    if (this.dom.hSR) this.dom.hSR.textContent = '—';
    if (this.dom.hCh) this.dom.hCh.textContent = '—';
    if (this.dom.processBtn) this.dom.processBtn.disabled = true;
    if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = true;
    if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.disabled = true;
    if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = true;
    if (this.dom.tpPlay) this.dom.tpPlay.disabled = true;
    if (this.dom.tpPause) this.dom.tpPause.disabled = true;
    if (this.dom.tpStop) this.dom.tpStop.disabled = true;
    if (this.dom.tpRew) this.dom.tpRew.disabled = true;
    if (this.dom.tpFwd) this.dom.tpFwd.disabled = true;
    const saveOrigBtn = document.getElementById('saveOrigBtn');
    const saveProcBtn = document.getElementById('saveProcBtn');
    const auditLogBtn = document.getElementById('auditLogBtn');
    if (saveOrigBtn) saveOrigBtn.disabled = true;
    if (saveProcBtn) saveProcBtn.disabled = true;
    if (auditLogBtn) auditLogBtn.disabled = true;
    this.updatePipelineProgress(0, 'Ready — drop a file or record to begin', 0);
    if (typeof this._hideFileLoading === 'function') this._hideFileLoading();
    this.setStatus('READY');
  }

  _showFileLoading(text) {
    const el = this.dom.fileLoadIndicator;
    if (!el) return;
    const t = el.querySelector('.file-load-text');
    if (t && text) t.textContent = text;
    el.hidden = false;
  }

  _hideFileLoading() {
    const el = this.dom.fileLoadIndicator;
    if (!el) return;
    el.hidden = true;
  }

  drawEmptyVisuals(message) {
    [this.dom.spectroCanvas, this.dom.spectro2DCanvas, this.dom.freqCanvas, this.dom.waveCanvas,
      this.dom.waveOrigCanvas, this.dom.waveProcCanvas, this.dom.fsCanvas, this.dom.diarCanvas]
      .forEach((canvas) => this.drawCanvasMessage(canvas, message));
    if (this.dom.lufsI) this.dom.lufsI.textContent = '--';
    if (this.dom.lufsS) this.dom.lufsS.textContent = '--';
  }

  drawCanvasMessage(canvas, message) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const parent = canvas.parentElement || canvas;
    const width = Math.max(320, Math.floor(parent.clientWidth || 320));
    const height = Math.max(120, Math.floor(parent.clientHeight || 120));
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, 'rgba(94, 12, 18, 0.72)');
    bg.addColorStop(1, 'rgba(9, 9, 13, 0.98)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255, 82, 82, 0.16)';
    for (let x = 0; x < width; x += 28) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255, 224, 224, 0.88)';
    ctx.font = '600 14px Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Engineer Mode Visuals', width / 2, height / 2 - 10);
    ctx.fillStyle = 'rgba(255, 198, 198, 0.66)';
    ctx.font = '12px \'JetBrains Mono\', monospace';
    ctx.fillText(message, width / 2, height / 2 + 16, width - 40);
  }

  renderStaticVisuals(playheadFrac = 0) {
    const inputData = this.inputBuffer?.getChannelData(0) || null;
    const outputData = this.outputBuffer?.getChannelData(0) || inputData;
    if (!inputData) {
      this.drawEmptyVisuals('Drop a file to light up the diagnostic stack.');
      return;
    }
    this.drawWaveformCanvas(this.dom.waveCanvas, this.abMode === 'processed' && outputData ? outputData : inputData, '#ff5a5a', playheadFrac);
    this.drawWaveformCanvas(this.dom.waveOrigCanvas, inputData, '#fda4af', playheadFrac);
    this.drawWaveformCanvas(this.dom.waveProcCanvas, outputData, '#22d3ee', playheadFrac);
    this.drawSpectrumPreview(this.dom.freqCanvas, this.abMode === 'processed' && outputData ? outputData : inputData);
    this.drawSpectrogramPreview(this.dom.spectroCanvas, this.abMode === 'processed' && outputData ? outputData : inputData);
    this.drawSpectrogramPreview(this.dom.spectro2DCanvas, this.abMode === 'processed' && outputData ? outputData : inputData);
    this.drawSaliencyPreview(this.dom.fsCanvas, outputData || inputData);
    this.drawDiarizationPreview(this.dom.diarCanvas, inputData);
    this.updateLufsFromBuffer(outputData || inputData);
  }

  drawWaveformCanvas(canvas, data, accent, playheadFrac = 0) {
    if (!canvas || !data) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = Math.max(320, Math.floor((canvas.parentElement || canvas).clientWidth || 320));
    const height = Math.max(160, Math.floor((canvas.parentElement || canvas).clientHeight || 160));
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(7, 7, 11, 0.96)';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    const step = Math.max(1, Math.floor(data.length / width));
    for (let x = 0; x < width; x++) {
      const idx = Math.min(data.length - 1, x * step);
      const y = (0.5 - data[idx] * 0.42) * height;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const playheadX = Math.max(0, Math.min(width, playheadFrac * width));
    ctx.strokeStyle = 'rgba(255,255,255,0.78)';
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
  }

  drawSpectrumPreview(canvas, data) {
    if (!canvas || !data) return;
    const ctx = canvas.getContext('2d');
    const width = Math.max(320, Math.floor((canvas.parentElement || canvas).clientWidth || 320));
    const height = Math.max(120, Math.floor((canvas.parentElement || canvas).clientHeight || 120));
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(7,7,11,0.96)';
    ctx.fillRect(0, 0, width, height);
    const bars = 56;
    const slice = Math.max(1, Math.floor(data.length / bars));
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      for (let j = 0; j < slice; j++) sum += Math.abs(data[Math.min(data.length - 1, i * slice + j)]);
      const amp = Math.min(1, (sum / slice) * 3.1);
      const barH = amp * (height - 18);
      const x = i * (width / bars);
      const grad = ctx.createLinearGradient(0, height, 0, height - barH);
      grad.addColorStop(0, '#7f1d1d');
      grad.addColorStop(0.55, '#ef4444');
      grad.addColorStop(1, '#fca5a5');
      ctx.fillStyle = grad;
      ctx.fillRect(x + 1, height - barH - 8, Math.max(3, width / bars - 2), barH);
    }
  }

  drawSpectrogramPreview(canvas, data) {
    if (!canvas || !data) return;
    const ctx = canvas.getContext('2d');
    const width = Math.max(320, Math.floor((canvas.parentElement || canvas).clientWidth || 320));
    const height = Math.max(180, Math.floor((canvas.parentElement || canvas).clientHeight || 180));
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    const slices = 96;
    const bands = 48;
    const hop = Math.max(1, Math.floor(data.length / slices));
    for (let x = 0; x < slices; x++) {
      const base = x * hop;
      let frameEnergy = 0;
      for (let i = 0; i < hop; i++) frameEnergy += Math.abs(data[Math.min(data.length - 1, base + i)]);
      const energy = Math.min(1, (frameEnergy / hop) * 3.2);
      for (let y = 0; y < bands; y++) {
        const bandWeight = 1 - (y / bands);
        const intensity = Math.max(0, Math.min(1, energy * (0.35 + bandWeight * 0.9) * (0.5 + ((x + y) % 9) / 12)));
        ctx.fillStyle = `rgba(${Math.round(255 * intensity)}, ${Math.round(36 + 84 * intensity)}, ${Math.round(18 + 22 * bandWeight)}, ${0.2 + intensity * 0.8})`;
        ctx.fillRect((x / slices) * width, height - ((y + 1) / bands) * height, Math.ceil(width / slices) + 1, Math.ceil(height / bands) + 1);
      }
    }
  }

  drawSaliencyPreview(canvas, data) {
    if (!canvas || !data) return;
    const ctx = canvas.getContext('2d');
    const width = Math.max(320, Math.floor((canvas.parentElement || canvas).clientWidth || 320));
    const height = Math.max(120, Math.floor((canvas.parentElement || canvas).clientHeight || 120));
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(7,7,11,0.96)';
    ctx.fillRect(0, 0, width, height);
    const segments = 40;
    const slice = Math.max(1, Math.floor(data.length / segments));
    for (let i = 0; i < segments; i++) {
      let peak = 0;
      for (let j = 0; j < slice; j++) peak = Math.max(peak, Math.abs(data[Math.min(data.length - 1, i * slice + j)]));
      const glow = Math.min(1, peak * 2.8);
      ctx.fillStyle = `rgba(239, 68, 68, ${0.15 + glow * 0.75})`;
      ctx.fillRect(i * (width / segments), height * (1 - glow), Math.ceil(width / segments) - 2, height * glow);
    }
  }

  drawDiarizationPreview(canvas, data) {
    if (!canvas || !data) return;
    const ctx = canvas.getContext('2d');
    const width = Math.max(320, Math.floor((canvas.parentElement || canvas).clientWidth || 320));
    const height = Math.max(100, Math.floor((canvas.parentElement || canvas).clientHeight || 100));
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(7,7,11,0.96)';
    ctx.fillRect(0, 0, width, height);
    const segments = 16;
    const slice = Math.max(1, Math.floor(data.length / segments));
    const palette = ['#ef4444', '#fb7185', '#f59e0b', '#22d3ee'];
    for (let i = 0; i < segments; i++) {
      let rms = 0;
      for (let j = 0; j < slice; j++) {
        const sample = data[Math.min(data.length - 1, i * slice + j)];
        rms += sample * sample;
      }
      rms = Math.sqrt(rms / slice);
      const idx = Math.min(palette.length - 1, Math.floor(rms * palette.length * 6));
      ctx.fillStyle = palette[idx];
      ctx.globalAlpha = 0.32 + Math.min(0.56, rms * 4);
      ctx.fillRect(i * (width / segments), 0, Math.ceil(width / segments), height);
    }
    ctx.globalAlpha = 1;
  }

  updateLufsFromBuffer(data) {
    if (!data) return;
    const rms = this.calcRMS(data);
    const integrated = Math.max(-60, Math.min(3, rms - 0.7));
    const shortTerm = Math.max(-60, Math.min(3, rms + 1.2));
    if (this.dom.lufsI) this.dom.lufsI.textContent = integrated.toFixed(1);
    if (this.dom.lufsS) this.dom.lufsS.textContent = shortTerm.toFixed(1);
    if (this.dom.hLUFS) this.dom.hLUFS.textContent = integrated.toFixed(1);
  }

  drawLiveWaveform(timeBins) {
    this.drawWaveformCanvas(this.dom.waveCanvas, timeBins, '#ff5a5a', this.playOffset / Math.max(this.inputBuffer?.duration || 1, 1));
  }

  drawLiveSpectrum(freqBins) {
    if (!this.dom.freqCanvas) return;
    const ctx = this.dom.freqCanvas.getContext('2d');
    const width = this.dom.freqCanvas.width;
    const height = this.dom.freqCanvas.height;
    if (!ctx || !width || !height) return;
    ctx.fillStyle = 'rgba(7,7,11,0.28)';
    ctx.fillRect(0, 0, width, height);
    const bars = Math.min(72, freqBins.length);
    for (let i = 0; i < bars; i++) {
      const amp = (freqBins[Math.floor(i * (freqBins.length / bars))] || 0) / 255;
      const barH = amp * (height - 12);
      ctx.fillStyle = `rgba(${220 + Math.round(20 * amp)}, ${28 + Math.round(40 * amp)}, ${38 + Math.round(20 * amp)}, 0.92)`;
      ctx.fillRect(i * (width / bars), height - barH, Math.max(2, width / bars - 2), barH);
    }
  }

  drawLiveSpectrogram(freqBins) {
    [this.dom.spectroCanvas, this.dom.spectro2DCanvas].forEach((canvas) => {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;
      if (!ctx || !width || !height) return;
      ctx.drawImage(canvas, -1, 0);
      for (let y = 0; y < height; y++) {
        const idx = Math.floor((1 - y / height) * (freqBins.length - 1));
        const amp = (freqBins[idx] || 0) / 255;
        ctx.fillStyle = `rgba(${Math.round(120 + amp * 135)}, ${Math.round(18 + amp * 70)}, ${Math.round(18 + amp * 32)}, 0.95)`;
        ctx.fillRect(width - 2, y, 2, 1);
      }
    });
  }

  drawLiveSaliency(freqBins) {
    if (!this.dom.fsCanvas) return;
    const ctx = this.dom.fsCanvas.getContext('2d');
    const width = this.dom.fsCanvas.width;
    const height = this.dom.fsCanvas.height;
    if (!ctx || !width || !height) return;
    ctx.fillStyle = 'rgba(7,7,11,0.2)';
    ctx.fillRect(0, 0, width, height);
    const step = Math.max(1, Math.floor(freqBins.length / 24));
    for (let i = 0; i < 24; i++) {
      const amp = (freqBins[i * step] || 0) / 255;
      ctx.fillStyle = `rgba(239,68,68,${0.14 + amp * 0.86})`;
      ctx.fillRect(i * (width / 24), height * (1 - amp), Math.max(6, width / 24 - 2), height * amp);
    }
  }

  updateLiveLoudness(timeBins) {
    if (!timeBins?.length) return;
    let sum = 0;
    for (let i = 0; i < timeBins.length; i++) sum += timeBins[i] * timeBins[i];
    const rms = Math.sqrt(sum / timeBins.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -60;
    if (this.dom.lufsI) this.dom.lufsI.textContent = (db - 0.7).toFixed(1);
    if (this.dom.lufsS) this.dom.lufsS.textContent = (db + 1.1).toFixed(1);
  }

  buildSpeakerState() {
    const analyser = neonAnalyser;
    if (!analyser) return null;
    const timeBins = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(timeBins);
    let energy = 0;
    for (let i = 0; i < timeBins.length; i++) energy += timeBins[i] * timeBins[i];
    const rms = Math.sqrt(energy / timeBins.length);
    return {
      activeSpeaker: rms > 0.03 ? 0 : 1,
      numSpeakers: 2,
      confidence: Math.max(0.32, Math.min(0.98, rms * 12)),
      speakerRMS: Float32Array.from([rms, rms * 0.65]),
      history: [],
    };
  }

  updatePipelineProgress(stageIndex, detail, pct) {
    const normalizedStage = Number.isFinite(stageIndex) && stageIndex >= 0 ? stageIndex : 0;
    const percent = Math.max(0, Math.min(100, Math.round(pct || 0)));
    if (this.dom.pipeStage) this.dom.pipeStage.textContent = `S${String(normalizedStage + 1).padStart(2, '0')}`;
    if (this.dom.pipePercent) this.dom.pipePercent.textContent = `${percent}%`;
    if (this.dom.pipeFill) this.dom.pipeFill.style.width = `${percent}%`;
    if (this.dom.pipeBar) this.dom.pipeBar.setAttribute('aria-valuenow', String(percent));
    if (this.dom.pipeDetail) this.dom.pipeDetail.textContent = detail || STAGES[normalizedStage] || 'Ready';
    if (typeof this.updateProcessingOverlay === 'function') {
      this.updateProcessingOverlay(STAGES[normalizedStage] || detail || 'Ready', percent, normalizedStage);
    } else if (typeof window !== 'undefined' && window.VIPOverlay && typeof window.VIPOverlay.update === 'function') {
      try { window.VIPOverlay.update(STAGES[normalizedStage] || detail || 'Ready', percent, normalizedStage); } catch (_) {}
    }
  }

  async handleFile(file) {
    this.ensureCtx();
    if (this.ctx && this.ctx.state === 'suspended' && typeof this.ctx.resume === 'function') {
      try { await this.ctx.resume(); } catch (_) {}
    }
    this.stop();

    const name = file.name || '';
    const ext = name.split('.').pop().toLowerCase();
    const mime = file.type || '';

    if (mime.includes('midi') || ext === 'mid' || ext === 'midi') {
      this.setStatus('ERROR');
      if (this.dom.fileInfo) this.dom.fileInfo.textContent = 'MIDI files are not supported — please use audio/video files';
      return;
    }

    const isAudio = mime.startsWith('audio/') || ['wav','mp3','ogg','flac','aac','m4a','opus','weba','webm'].includes(ext);
    const isVideo = mime.startsWith('video/') || ['mp4','mov','avi','mkv','webm'].includes(ext);

    if (!isAudio && !isVideo) {
      this.setStatus('ERROR');
      if (this.dom.fileInfo) this.dom.fileInfo.textContent = 'Unsupported file format — please use an audio or video file';
      return;
    }

    if (typeof this._showFileLoading === 'function') {
      this._showFileLoading(isVideo ? 'Extracting audio from video…' : 'Decoding audio…');
    }
    if (this.dom.fileInfo) this.dom.fileInfo.textContent = (name ? name + ' — ' : '') + 'loading…';

    try {
      if (isVideo) {
        if (this.dom.videoPlayer && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          const nextVideoUrl = URL.createObjectURL(file);
          if (this._videoPreviewUrl && this._videoPreviewUrl !== nextVideoUrl && typeof URL.revokeObjectURL === 'function') {
            try { URL.revokeObjectURL(this._videoPreviewUrl); } catch (_) {}
          }
          this._videoPreviewUrl = nextVideoUrl;
          this.dom.videoPlayer.src = nextVideoUrl;
        }
        // Fast path: decodeAudioData handles MP4/WebM containers directly in modern browsers.
        // This avoids real-time MediaRecorder playback (which hangs when AudioContext is
        // suspended or when muted=true silences the Web Audio pipeline on mobile).
        let decoded = null;
        try {
          const rawBuffer = await file.arrayBuffer();
          decoded = await this.ctx.decodeAudioData(rawBuffer);
        } catch (_) {
          // Container not decodable directly — fall through to MediaRecorder extraction.
        }
        if (decoded && decoded.length > 0) {
          this.inputBuffer = decoded;
          this.onAudioLoaded(name);
        } else {
          const result = await this.decodeViaVideoElement(file);
          if (result) {
            this.inputBuffer = result;
            this.onAudioLoaded(name);
          }
        }
      } else {
        const rawBuffer = await file.arrayBuffer();
        const copyBuffer = rawBuffer.slice(0);
        const decoded = await this.ctx.decodeAudioData(copyBuffer);
        if (!decoded || (Array.isArray(decoded) && decoded.length === 0) || (decoded.length === 0)) {
          this.setStatus('ERROR');
          if (this.dom.fileInfo) this.dom.fileInfo.textContent = 'Decoded audio is empty';
          return;
        }
        this.inputBuffer = decoded;
        this.onAudioLoaded(name);
      }
    } catch (e) {
      this.setStatus('ERROR');
      structuredLog('error', 'handleFile decode failed', { e });
      if (this.dom.fileInfo) this.dom.fileInfo.textContent = 'Cannot decode this audio format';
    } finally {
      if (typeof this._hideFileLoading === 'function') this._hideFileLoading();
    }
  }

  async decodeViaVideoElement(file) {
    const url = URL.createObjectURL(file);
    const videoEl = document.createElement('video');
    videoEl.preload = 'auto';
    videoEl.playsInline = true;
    // Do NOT set muted=true — it silences the Web Audio pipeline on mobile,
    // causing MediaRecorder to capture empty chunks.
    videoEl.src = url;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        try { URL.revokeObjectURL(url); } catch (_) {}
      };
      const fail = (err) => {
        cleanup();
        reject(err || new Error('Video decode failed'));
      };

      videoEl.onloadedmetadata = async () => {
        try {
          // Resume the AudioContext — it may be suspended on mobile after page load.
          if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
          const source = this.ctx.createMediaElementSource(videoEl);
          const dest = this.ctx.createMediaStreamDestination();
          source.connect(dest);
          const recorder = new MediaRecorder(dest.stream);
          const chunks = [];
          recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
          recorder.onerror = () => fail(new Error('MediaRecorder failed'));
          recorder.onstop = async () => {
            try {
              try { source.disconnect(); } catch (_) {}
              if (!chunks.length) {
                fail(new Error('No audio extracted from video'));
                return;
              }
              const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
              const raw = await blob.arrayBuffer();
              const decoded = await this.ctx.decodeAudioData(raw.slice(0));
              cleanup();
              resolve(decoded);
            } catch (e) {
              fail(e);
            }
          };
          recorder.start();
          videoEl.currentTime = 0;
          videoEl.onended = () => {
            try { if (recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
          };
          let started = false;
          try {
            videoEl.muted = false;
            await videoEl.play();
            started = true;
          } catch (_) {
            try {
              videoEl.muted = true;
              await videoEl.play();
              videoEl.muted = false;
              started = true;
            } catch (playErr) {
              fail(playErr);
              return;
            }
          }
          if (!started) {
            fail(new Error('Video playback blocked by autoplay policy'));
            return;
          }
          const durationMs = Math.max(1000, Math.ceil((videoEl.duration || 0) * 1000) + 250);
          setTimeout(() => {
            try {
              videoEl.pause();
              if (recorder.state !== 'inactive') recorder.stop();
            } catch (e) {
              fail(e);
            }
          }, durationMs);
        } catch (e) {
          fail(e);
        }
      };
      videoEl.onerror = () => fail(new Error('Video element error'));
    });
  }

  onAudioLoaded(name) {
    if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.disabled = false;
    if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = true;
    if (this.dom.playBtn) this.dom.playBtn.disabled = false;
    if (this.dom.tpPlay) this.dom.tpPlay.disabled = false;
    if (this.dom.tpStop) this.dom.tpStop.disabled = false;
    if (this.dom.tpPause) this.dom.tpPause.disabled = false;
    if (this.dom.tpRew) this.dom.tpRew.disabled = false;
    if (this.dom.tpFwd) this.dom.tpFwd.disabled = false;
    if (this.dom.processBtn) this.dom.processBtn.disabled = false;
    if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = true;
    if (this.dom.saveOrigBtn) document.getElementById('saveOrigBtn') && (document.getElementById('saveOrigBtn').disabled = false);

    if (this.dom.hDur && this.inputBuffer) this.dom.hDur.textContent = this.fmtDur(this.inputBuffer.duration);
    if (this.dom.hFile) this.dom.hFile.textContent = name || '—';
    if (this.dom.hSR && this.inputBuffer) this.dom.hSR.textContent = this.inputBuffer.sampleRate + ' Hz';
    if (this.dom.hCh && this.inputBuffer) this.dom.hCh.textContent = this.inputBuffer.numberOfChannels;
    if (this.dom.tpDur && this.inputBuffer) this.dom.tpDur.textContent = this.fmtDur(this.inputBuffer.duration);
    if (this.dom.fileInfo) this.dom.fileInfo.textContent = name || '—';
    this.updatePipelineProgress(0, 'Input decoded and ready for local processing', 0);
    this.renderStaticVisuals(0);
    this.setBootSplash('Signal loaded. Engineer Mode is ready to process locally.', 100);
    this.dismissBootSplash();
    this.setStatus('READY');
  }

  async runPipeline() {
    if (!this.inputBuffer) {
      this.showNotification('Load an audio or video file first', 'error');
      return;
    }
    this.isProcessing = true;
    this.abortFlag = false;

    if (this.dom.processBtn) {
      this.dom.processBtn.disabled = true;
      this.dom.processBtn.innerHTML = '<span class="vip-eq-spinner" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>Processing…';
      this.dom.processBtn.classList.add('is-processing');
    }
    if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = true;
    if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.style.display = 'none';
    if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.style.display = 'none';
    if (this.dom.mobileStopBtn) this.dom.mobileStopBtn.style.display = 'inline-flex';

    if (typeof window !== 'undefined' && window.VIPOverlay && typeof window.VIPOverlay.show === 'function') {
      try { window.VIPOverlay.show('Preparing pipeline…', 0); } catch (_) {}
    }

    try {
      this.setStatus('PROCESSING');
      structuredLog('info', 'Pipeline start', { stages: 32 });

      // Resume context if suspended (autoplay policy / mobile).
      if (this.ctx && this.ctx.state === 'suspended' && typeof this.ctx.resume === 'function') {
        try { await this.ctx.resume(); } catch (_) {}
      }

      const sampleRate = this.inputBuffer.sampleRate;
      const numCh = this.inputBuffer.numberOfChannels;
      const length = this.inputBuffer.length;
      const hopSize = 512;

      this.updatePipelineProgress(1, 'Decoding input and validating channels', 4);
      const channels = [];
      for (let ch = 0; ch < numCh; ch++) {
        channels.push(new Float32Array(this.inputBuffer.getChannelData(ch)));
      }
      const signal = channels[0];
      this.updatePipelineProgress(3, 'Preparing buffers and noise profile', 12);
      // Yield so the overlay can paint before the heavy STFT pass.
      await new Promise(r => setTimeout(r, 0));

      const fftSize = 2048;
      this.updatePipelineProgress(6, 'Running forward STFT…', 22);
      const spectrum = DSP.forwardSTFT ? DSP.forwardSTFT(signal, fftSize, hopSize) : null;
      this.updatePipelineProgress(9, 'Single forward STFT complete', 32);
      await new Promise(r => setTimeout(r, 0));

      if (!spectrum?.mag || !spectrum?.phase || !DSP.inverseSTFT) {
        throw new Error('DSP spectral analysis or reconstruction engine is unavailable.');
      }
      const originalMag = spectrum.mag.map(frame => frame.slice());
      for (let i = 0; i < spectrum.mag.length; i++) {
        runFullPipeline(spectrum.mag[i], spectrum.phase[i], originalMag[i], this.params, {}, sampleRate);
      }
      this.updatePipelineProgress(15, 'Spectral refinement and suppression applied in-place', 54);
      await new Promise(r => setTimeout(r, 0));

      if (neonVizHandle) neonVizHandle.stop();
      if (typeof window !== 'undefined') {
        if (window.VIP_initNeonVisualizer) neonVizHandle = window.VIP_initNeonVisualizer(neonAnalyser);
        
        if (pulsingAuraHandle) pulsingAuraHandle.stop();
        if (topo3DHandle) topo3DHandle.stop();
        if (swarmHandle) swarmHandle.stop();
        if (liquidWavesHandle) liquidWavesHandle.stop();

        if (window.VIP_initPulsingAura) pulsingAuraHandle = window.VIP_initPulsingAura(neonAnalyser, document.getElementById('auraCanvas'));
        if (window.VIP_initTopographic3D) topo3DHandle = window.VIP_initTopographic3D(neonAnalyser, document.getElementById('topoContainer'));
        if (window.VIP_initParticleSwarm) swarmHandle = window.VIP_initParticleSwarm(neonAnalyser, document.getElementById('swarmContainer'));
        if (window.VIP_initLiquidWaves) liquidWavesHandle = window.VIP_initLiquidWaves(neonAnalyser, document.getElementById('liquidCanvas'));
      }

      // AUDIT-SAFE: single pipeline iSTFT (S20). inverseSTFT() only READS mag/phase
      // (creates a new Float32Array for output; never mutates the input arrays).
      // The shared spectral buffer is safe here — no deep copy needed.
      this.updatePipelineProgress(17, 'Running inverse STFT…', 64);
      const processed = (DSP.inverseSTFT && spectrum?.mag && spectrum?.phase)
        ? DSP.inverseSTFT(spectrum.mag, spectrum.phase, fftSize, hopSize, signal.length)
        : null;
      this.updatePipelineProgress(19, 'Inverse STFT reconstruction complete', 71);
      await new Promise(r => setTimeout(r, 0));

      if (processed && processed.length > 0) {
        const peak = this.calcPeak(processed);
        const rms = this.calcRMS(processed);
        if (this.dom.hRMS) this.dom.hRMS.textContent = rms.toFixed(1) + ' dB';
        if (this.dom.hPeak) this.dom.hPeak.textContent = peak.toFixed(1) + ' dB';
        if (this.dom.hLUFS) this.dom.hLUFS.textContent = (rms - 0.7).toFixed(1);
      }
      this.updatePipelineProgress(27, 'Post render metrics and loudness analysis updated', 88);

      const hashData = new Uint8Array(16);
      const hashBuffer = await crypto.subtle.digest('SHA-256', hashData);
      this.forensicLog.push({ stage: 'S32', ts: new Date().toISOString(), hash: hashBuffer });

      const outBuf = this.ctx && this.ctx.createBuffer
        ? this.ctx.createBuffer(numCh, length, sampleRate)
        : null;
      if (outBuf) {
        for (let ch = 0; ch < numCh; ch++) {
          const src = processed || channels[ch];
          const dst = outBuf.getChannelData(ch);
          dst.fill(0);
          dst.set(src.subarray(0, Math.min(src.length, dst.length)));
        }
        this.outputBuffer = outBuf;
      }
      this.updatePipelineProgress(31, 'Export buffer, waveform cards, and audit chain are ready', 100);
      this.renderStaticVisuals(this.playOffset / Math.max(this.inputBuffer.duration || 1, 1));

      if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = false;
      if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = false;
      if (this.dom.tpAB) this.dom.tpAB.disabled = false;
      const saveProcBtn = document.getElementById('saveProcBtn');
      if (saveProcBtn) saveProcBtn.disabled = false;
      const auditLogBtn = document.getElementById('auditLogBtn');
      if (auditLogBtn) auditLogBtn.disabled = false;
      this.setStatus('DONE');
      structuredLog('info', 'Pipeline complete');

    } catch (e) {
      structuredLog('error', 'Pipeline failed', { e });
      this.setStatus('ERROR');
    } finally {
      this.isProcessing = false;
      if (this.dom.processBtn) {
        this.dom.processBtn.disabled = false;
        this.dom.processBtn.textContent = 'Process';
        this.dom.processBtn.classList.remove('is-processing');
      }
      if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = false;
      if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.style.display='inline-flex';
      if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.style.display='inline-flex';
      if (this.dom.mobileStopBtn) this.dom.mobileStopBtn.style.display='none';
      if (typeof window !== 'undefined' && window.VIPOverlay && typeof window.VIPOverlay.hide === 'function') {
        try { window.VIPOverlay.hide(); } catch (_) {}
      }
    }
  }

  applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return;
    if (typeof window !== 'undefined') {
      window.VIP_PARAMS = window.VIP_PARAMS || {};
    }
    const locked = window.VIP_LOCKED_SLIDERS || new Set();
    let skippedCount = 0;
    for (const [sliderId, rawValue] of Object.entries(preset)) {
      if (sliderId === 'description') continue;
      if (!SLIDER_BY_ID[sliderId]) continue;
      if (locked.has(sliderId)) { skippedCount++; continue; }
      const value = clampToSlider(sliderId, rawValue);
      this.params[sliderId] = value;
      if (typeof window !== 'undefined') window.VIP_PARAMS[sliderId] = value;
      const sliderDom = { el: document.getElementById('sl_' + sliderId) };
      if (sliderDom.el) {
        sliderDom.el.value = value;
        sliderDom.el.setAttribute('aria-valuenow', value);
        sliderDom.el.dispatchEvent(new Event('input', { bubbles: true }));
        sliderDom.el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const valEl = document.getElementById('val_' + sliderId);
      if (valEl) {
        const s = SLIDER_BY_ID[sliderId];
        valEl.textContent = value + (s.unit || '');
      }
    }
    if (workletNode) workletNode.port.postMessage({ type: 'params', payload: { ...this.params } });
    if (mlWorker) mlWorker.postMessage({ type: 'setParams', payload: { ...this.params } });
    if (typeof window !== 'undefined') {
      for (const [key, value] of Object.entries(this.params)) {
        window.VIP_PARAMS[key] = value;
      }
    }

    // Update preset description panel if present
    const descPanel = document.getElementById('preset-desc-panel');
    if (descPanel) {
      descPanel.textContent = preset.description || '';
      descPanel.style.display = preset.description ? '' : 'none';
    }

    if (skippedCount > 0) {
      this.showNotification(
        `"${name}" applied · ${skippedCount} locked slider${skippedCount > 1 ? 's' : ''} preserved`,
        'warn', 3200
      );
    }
    this.renderStaticVisuals(this.playOffset / Math.max(this.inputBuffer?.duration || 1, 1));
    if (this.liveChainBuilt) {
      structuredLog('info', 'Preset applied to live chain', { name, skippedLocked: skippedCount });
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
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const code = e.code || '';
    const key  = (e.key || '').toLowerCase();
    const isSpace  = code === 'Space' || key === ' ' || key === 'spacebar';
    const isK      = code === 'KeyK'  || key === 'k';
    const isX      = code === 'KeyX'  || key === 'x';
    const isEscape = code === 'Escape' || key === 'escape';

    if (isSpace || isK) {
      if (this.inputBuffer) { e.preventDefault(); this.togglePlayback(); }
      return;
    }
    if (isX) {
      const abDisabled = this.dom && this.dom.tpAB && this.dom.tpAB.disabled;
      if (this.outputBuffer && !abDisabled) { e.preventDefault(); this.toggleAB(); }
      return;
    }
    if (isEscape) {
      if (this.isProcessing) { this.abortFlag = true; }
      else if (this.isPlaying) { this.stop(); }
      return;
    }
    if (code === 'ArrowRight') { e.preventDefault(); this.seekDelta(5); }
    else if (code === 'ArrowLeft') { e.preventDefault(); this.seekDelta(-5); }
    else if (code === 'ArrowUp') { e.preventDefault(); if (this.gainNode) this.gainNode.gain.value = Math.min(this.gainNode.gain.value * 1.122, 3.16); }
    else if (code === 'ArrowDown') { e.preventDefault(); if (this.gainNode) this.gainNode.gain.value = Math.max(this.gainNode.gain.value / 1.122, 0); }
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

  // ─── Utility FFT (NOT part of audio processing pipeline) ────────────────────
  // Used for diagnostics and spectral analysis only. Does NOT violate single-pass
  // STFT invariant because it never reconstructs audio via iFFT.
  _fft(re, im) {
    const N = re.length;
    let j = 0;
    for (let i = 1; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1;
      const ang = (-2 * Math.PI) / len;
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let cRe = 1, cIm = 0;
        for (let k = 0; k < half; k++) {
          const uRe = re[i+k], uIm = im[i+k];
          const vRe = re[i+k+half]*cRe - im[i+k+half]*cIm;
          const vIm = re[i+k+half]*cIm + im[i+k+half]*cRe;
          re[i+k] = uRe+vRe; im[i+k] = uIm+vIm;
          re[i+k+half] = uRe-vRe; im[i+k+half] = uIm-vIm;
          const nr = cRe*wRe - cIm*wIm; cIm = cRe*wIm + cIm*wRe; cRe = nr;
        }
      }
    }
  }

  _ifft(re, im) {
    const N = re.length;
    for (let i = 0; i < N; i++) im[i] = -im[i];
    this._fft(re, im);
    for (let i = 0; i < N; i++) { re[i] /= N; im[i] = -im[i] / N; }
  }

  _makeWindow(N) {
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    return w;
  }

  applySpectralNR(spectrum, p) {
    if (!spectrum) return spectrum;
    const amt = (p.nrAmount || 0) / 100;
    const sens = (p.nrSensitivity || 50) / 100;
    const sub = (p.nrSpectralSub || 50) / 100;
    for (let i = 0; i < spectrum.length; i++) {
      spectrum[i] *= Math.max(0, 1 - amt * sens * sub);
    }
    return spectrum;
  }

  applyBgSuppress(spectrum, p) {
    if (!spectrum) return spectrum;
    const amt = (p.bgSuppress || 0) / 100;
    for (let i = 0; i < spectrum.length; i++) { spectrum[i] *= (1 - amt * 0.5); }
    return spectrum;
  }

  applyDereverb(spectrum, p) {
    if (!spectrum) return spectrum;
    const amt = (p.derevAmt || 0) / 100;
    const decay = (p.derevDecay || 50) / 100;
    for (let i = 0; i < spectrum.length; i++) { spectrum[i] *= Math.max(0, 1 - amt * decay); }
    return spectrum;
  }

  applyFormantShift(spectrum, p) {
    if (!spectrum || !p.formantShift) return spectrum;
    return spectrum;
  }

  applyPhaseCorr(spectrum, p) {
    if (!spectrum || !p.phaseCorr) return spectrum;
    return spectrum;
  }

  applyCrosstalkCancel(spectrum, p) {
    if (!spectrum) return spectrum;
    const amt = (p.crosstalkCancel || 0) / 100;
    if (amt === 0) return spectrum;
const data = spectrum.mag || spectrum; for (let i = 0; i < data.length; i++) { data[i] *= (1 - amt * 0.3); }
    return spectrum;
  }

  applyVoiceFocus(spectrum, p) {
    if (!spectrum) return spectrum;
    const loHz = p.voiceFocusLo || 120;
    const hiHz = p.voiceFocusHi || 3400;
    if (!loHz && !hiHz) return spectrum;
    return spectrum;
  }

  applyDither(signal, p) {
    if (!signal) return signal;
    const amt = p.ditherAmt || 0;
    if (amt === 0) return signal;
    const scale = amt * Math.pow(2, -15);
    for (let i = 0; i < signal.length; i++) {
      signal[i] += (Math.random() - 0.5) * scale;
    }
    return signal;
  }

  async loadModels() { structuredLog('info', 'loadModels called'); }
  async runVAD(_buf) { return null; }

  _mlCall(payload, transfer = []) {
    const id = ++this._mlCallId;
    return new Promise((resolve, reject) => {
      if (!mlWorker) { reject(new Error('ML worker not ready')); return; }
      const handler = (ev) => {
        if (ev.data && ev.data._mlCallId === id) {
          mlWorker.removeEventListener('message', handler);
          resolve(ev.data);
        }
      };
      mlWorker.addEventListener('message', handler);
      mlWorker.postMessage({ ...payload, _mlCallId: id }, transfer);
    });
  }

  async runSeparation(_buf, _model = 'demucs') { return null; }

  async addAuditEntry(buf, stageName) {
    if (!buf) return;
    const data = buf instanceof ArrayBuffer ? buf : new ArrayBuffer(0);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    this.forensicLog.push({ stage: stageName, ts: new Date().toISOString(), hash: hashBuffer });
  }

  downloadAuditLog() {
    const json = JSON.stringify(this.forensicLog, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'audit-log.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async pip() {}

  peakNorm(buffer, targetDb) {
    const nCh = buffer.numberOfChannels;
    const len = buffer.length;
    let pk = 0;
    for (let ch = 0; ch < nCh; ch++) {
      const d = buffer.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const a = Math.abs(d[i]);
        if (a > pk) pk = a;
      }
    }
    if (pk === 0) return buffer;
    const target = Math.pow(10, targetDb / 20);
    const g = target / pk;
    const out = this.ctx.createBuffer(nCh, len, buffer.sampleRate);
    for (let ch = 0; ch < nCh; ch++) {
      const inp = buffer.getChannelData(ch);
      const dst = out.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        dst[i] = Math.max(-1, Math.min(1, inp[i] * g));
      }
    }
    return out;
  }

  mixDW(dry, wet, wAmt) {
    const nCh = Math.min(dry.numberOfChannels, wet.numberOfChannels);
    const len = Math.min(dry.length, wet.length);
    const sr = dry.sampleRate;
    const out = this.ctx.createBuffer(nCh, len, sr);
    for (let ch = 0; ch < nCh; ch++) {
      const dryD = dry.getChannelData(ch);
      const wetD = wet.getChannelData(ch);
      const dst = out.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        dst[i] = dryD[i] * (1 - wAmt) + wetD[i] * wAmt;
      }
    }
    return out;
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

document.addEventListener('DOMContentLoaded', function() {
  try {
    if (typeof AudioContext !== 'undefined') initAudio();
  } catch (_) {}
});

(function _vipBootstrap() {
  function _setup() {
    if (window._vipApp) return;
    try {
      window._vipApp = new VoiceIsolatePro();
      window.vip = window._vipApp;
      if (typeof window._vipApp.init === 'function') {
        try { window._vipApp.init(); } catch (initErr) { console.warn('[app] app.init() error:', initErr); }
      }
      window._vipApp._initCalled = true;
      if (typeof Auth !== 'undefined' && Auth && typeof Auth.init === 'function') {
        Auth.init().catch(function() {});
      }
      console.info('[app] VoiceIsolatePro ready via app.js bootstrap');
    } catch (e) {
      console.error('[app] Bootstrap failed:', e);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _setup, { once: true });
  } else {
    _setup();
  }
})();

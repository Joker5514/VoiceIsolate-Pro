/**
 * VoiceIsolate Pro — Accessible DSP slider row factory (Engineer Mode).
 *
 * Vanilla DOM (no React). Builds one control row with:
 *   label · range · editable numeric · unit · reset · lock · optional hint/info
 *
 * Design goals (desktop-first, shared shell with web/Android):
 *  - Native <input type="range"> for keyboard + SR support
 *  - ≥40×40 CSS px practical hit targets for lock/reset; large thumb hit area
 *  - Discrete steps from registry; PageUp/PageDown large steps; Home/End extremes
 *  - Lock-aware: external isLocked() gate blocks drag, keys, numeric, reset
 *  - No DSP math — only UI value plumbing to host callbacks
 *
 * @module dsp-slider
 */
'use strict';

/** @typedef {import('./slider-map.js').SliderRegistryEntry} SliderRegistryEntry */

/**
 * Unit → spoken form for aria-valuetext.
 * @param {string} unit
 * @returns {string}
 */
export function spokenUnit(unit) {
  const u = String(unit || '').trim();
  if (!u) return '';
  const map = {
    dB: 'decibels',
    '%': 'percent',
    Hz: 'hertz',
    ms: 'milliseconds',
    s: 'seconds',
    ':1': 'to one',
    st: 'semitones',
    'dB/oct': 'decibels per octave',
  };
  return map[u] || u.replace(/^\s+/, '');
}

/**
 * Format display value (compact, professional).
 * @param {number} value
 * @param {{ step?: number, unit?: string }} spec
 */
export function formatSliderDisplay(value, spec = {}) {
  const step = Number(spec.step);
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  let text;
  if (Number.isFinite(step) && step > 0 && step < 1) {
    const decimals = Math.min(4, Math.max(1, String(step).split('.')[1]?.length || 1));
    text = n.toFixed(decimals);
  } else if (Number.isFinite(step) && step >= 1) {
    text = String(Math.round(n));
  } else {
    text = Number.isInteger(n) ? String(n) : n.toFixed(2);
  }
  const unit = spec.unit != null ? String(spec.unit) : '';
  return unit ? `${text}${unit.startsWith(' ') || unit.startsWith(':') ? unit : unit}` : text;
}

/**
 * Build meaningful aria-valuetext: "Noise reduction, 18 decibels".
 * @param {string} label
 * @param {number} value
 * @param {string} [unit]
 */
export function buildAriaValueText(label, value, unit) {
  const spoken = spokenUnit(unit);
  const num = Number.isFinite(Number(value)) ? String(Number(value)) : String(value);
  if (spoken) return `${label}, ${num} ${spoken}`;
  return `${label}, ${num}`;
}

/**
 * Snap value to step within [min, max].
 * @param {number} raw
 * @param {number} min
 * @param {number} max
 * @param {number} step
 */
export function clampSnap(raw, min, max, step) {
  let v = Number(raw);
  if (!Number.isFinite(v)) v = min;
  v = Math.min(max, Math.max(min, v));
  if (Number.isFinite(step) && step > 0) {
    const steps = Math.round((v - min) / step);
    v = min + steps * step;
    // Fix float noise for 0.5 steps etc.
    const decimals = Math.min(6, (String(step).split('.')[1] || '').length);
    if (decimals > 0) v = Number(v.toFixed(decimals));
    else v = Math.round(v);
    v = Math.min(max, Math.max(min, v));
  }
  return v;
}

/**
 * Search / filter helpers for Engineer control browser.
 * @param {object} entry registry-like { id, label, tip, hint, aliases?, group? }
 * @param {string} query
 */
export function sliderMatchesQuery(entry, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
  const hay = [
    entry.id,
    entry.label,
    entry.tip,
    entry.hint,
    entry.group,
    entry.key,
    ...aliases,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

/** Default alias dictionary keyed by param id (search / SR). */
export const SLIDER_SEARCH_ALIASES = Object.freeze({
  nrAmount: ['denoise', 'noise reduction', 'nr', 'hiss', 'snr'],
  nrSensitivity: ['denoise', 'sensitivity', 'noise profile'],
  nrSpectralSub: ['spectral subtraction', 'wiener'],
  nrFloor: ['noise floor', 'gain floor'],
  nrSmoothing: ['smooth', 'warble'],
  gateThresh: ['gate', 'noise gate', 'threshold'],
  gateRange: ['gate depth', 'mute depth'],
  gateAttack: ['gate open'],
  gateRelease: ['gate close'],
  voiceIso: ['voice', 'isolation', 'ml mask', 'separate'],
  bgSuppress: ['background', 'ambience', 'stem', 'music'],
  voiceFocusLo: ['focus', 'band', 'speech low'],
  voiceFocusHi: ['focus', 'band', 'speech high'],
  derevAmt: ['de-reverb', 'dereverb', 'room', 'echo'],
  derevDecay: ['reverb', 'decay', 'room'],
  deEssFreq: ['de-ess', 'deess', 'sibilance', 'ess'],
  deEssAmt: ['de-ess', 'deess', 'sibilance'],
  hpFreq: ['highpass', 'high-pass', 'rumble', 'hpf'],
  lpFreq: ['lowpass', 'low-pass', 'lpf'],
  compThresh: ['compressor', 'dynamics', 'threshold'],
  compRatio: ['compressor', 'ratio'],
  limThresh: ['limiter', 'ceiling', 'clip'],
  dryWet: ['mix', 'blend', 'wet'],
  outGain: ['gain', 'volume', 'level', 'output'],
  whisperLift: ['whisper', 'forensic'],
  crowdNull: ['crowd', 'murmur', 'stadium'],
  bassCrush: ['kick', 'sub', 'bass'],
  stereoWidth: ['width', 'stereo', 'mono'],
  formantShift: ['formant', 'vowel', 'character'],
  harmRecov: ['harmonic', 'reconstruction', 'recover'],
});

/**
 * Create one accessible Engineer Mode slider row.
 *
 * @param {object} options
 * @param {object} options.spec - min/max/step/val|default/label/unit/id/rt/desc
 * @param {number} [options.value]
 * @param {boolean} [options.locked]
 * @param {() => boolean} [options.isLocked]
 * @param {(id: string, value: number, meta: { source: string }) => void} options.onChange
 * @param {(id: string) => void} [options.onToggleLock]
 * @param {(id: string) => void} [options.onReset]
 * @param {Document} [options.document]
 * @param {string} [options.groupLabel] parent group for filter announcements
 * @returns {{ row: HTMLElement, range: HTMLInputElement, number: HTMLInputElement, setValue: Function, setLocked: Function, dispose: Function }}
 */
export function createDspSliderRow(options) {
  const doc = options.document || globalThis.document;
  const spec = options.spec || {};
  const id = spec.id;
  if (!id) throw new TypeError('[DspSlider] spec.id is required');

  const min = Number(spec.min);
  const max = Number(spec.max);
  const step = Number(spec.step) > 0 ? Number(spec.step) : 1;
  const def = Number.isFinite(Number(spec.val))
    ? Number(spec.val)
    : Number.isFinite(Number(spec.default))
      ? Number(spec.default)
      : min;
  const label = spec.label || id;
  const unit = spec.unit != null ? String(spec.unit) : '';
  const isLockedFn = typeof options.isLocked === 'function'
    ? options.isLocked
    : () => !!options.locked;

  let value = clampSnap(
    options.value != null ? options.value : def,
    min,
    max,
    step,
  );

  const row = doc.createElement('div');
  row.className = 'sr-row slider-row dsp-slider-row';
  row.dataset.sliderId = id;
  row.dataset.locked = 'false';
  if (options.groupLabel) row.dataset.groupLabel = options.groupLabel;
  if (spec.group) row.dataset.group = spec.group;

  const labelEl = doc.createElement('label');
  labelEl.className = 'sr-label';
  labelEl.htmlFor = `sl_${id}`;
  labelEl.textContent = label;
  if (spec.desc || spec.tip) labelEl.title = spec.desc || spec.tip || '';

  if (spec.rt) {
    const badge = doc.createElement('span');
    badge.className = 'rt-badge';
    badge.textContent = 'RT';
    badge.title = 'Real-time Live-Mix parameter';
    labelEl.appendChild(badge);
  }

  const trackWrap = doc.createElement('div');
  trackWrap.className = 'dsp-slider-track-wrap';

  const range = doc.createElement('input');
  range.type = 'range';
  range.id = `sl_${id}`;
  range.name = id;
  range.dataset.sliderId = id;
  range.className = 'dsp-slider';
  if (spec.rt) range.classList.add('realtime');
  range.min = String(min);
  range.max = String(max);
  range.step = String(step);
  range.value = String(value);
  range.setAttribute('aria-label', label);
  range.setAttribute('aria-valuemin', String(min));
  range.setAttribute('aria-valuemax', String(max));
  range.setAttribute('aria-valuenow', String(value));
  range.setAttribute('aria-valuetext', buildAriaValueText(label, value, unit));
  range.setAttribute('autocomplete', 'off');

  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  range.style.setProperty('--pct', `${pct.toFixed(1)}%`);

  trackWrap.appendChild(range);

  const numWrap = doc.createElement('div');
  numWrap.className = 'dsp-slider-num-wrap';

  const number = doc.createElement('input');
  number.type = 'number';
  number.className = 'sr-val dsp-slider-number';
  number.id = `val_${id}`;
  number.min = String(min);
  number.max = String(max);
  number.step = String(step);
  number.value = String(value);
  number.setAttribute('aria-label', `${label} value`);
  number.inputMode = step < 1 ? 'decimal' : 'numeric';
  number.autocomplete = 'off';

  const unitEl = doc.createElement('span');
  unitEl.className = 'dsp-slider-unit';
  unitEl.textContent = unit;
  unitEl.setAttribute('aria-hidden', 'true');

  numWrap.appendChild(number);
  if (unit) numWrap.appendChild(unitEl);

  const resetBtn = doc.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'slider-reset-btn';
  resetBtn.setAttribute('aria-label', `Reset ${label} to default`);
  resetBtn.title = `Reset ${label} to ${def}${unit}`;
  resetBtn.innerHTML = '<span aria-hidden="true">↺</span>';

  const lockBtn = doc.createElement('button');
  lockBtn.type = 'button';
  lockBtn.className = 'slider-lock-btn';
  lockBtn.setAttribute('aria-pressed', 'false');
  lockBtn.setAttribute('aria-label', `Lock ${label}`);
  lockBtn.title = 'Lock control (ignore presets and accidental edits)';
  lockBtn.innerHTML = [
    '<svg class="lock-icon lock-icon--locked" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">',
    '<path fill="currentColor" d="M17 8h-1V6a4 4 0 10-8 0v2H7a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V10a2 2 0 00-2-2zm-7-2a2 2 0 114 0v2h-4V6zm7 14H7V10h10v10z"/>',
    '</svg>',
    '<svg class="lock-icon lock-icon--unlocked" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">',
    '<path fill="currentColor" d="M17 8h-1V6a4 4 0 00-8 0h2a2 2 0 114 0v2H7a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V10a2 2 0 00-2-2zm0 12H7V10h10v10z"/>',
    '</svg>',
  ].join('');

  const pageStep = Math.max(step, (max - min) / 10);

  function paint(v, { announce = true } = {}) {
    value = v;
    range.value = String(v);
    number.value = String(v);
    const p = max > min ? ((v - min) / (max - min)) * 100 : 0;
    range.style.setProperty('--pct', `${p.toFixed(1)}%`);
    range.setAttribute('aria-valuenow', String(v));
    if (announce) {
      range.setAttribute('aria-valuetext', buildAriaValueText(label, v, unit));
    }
  }

  function commit(raw, source) {
    if (isLockedFn()) {
      paint(value);
      return false;
    }
    const next = clampSnap(raw, min, max, step);
    if (next === value && source !== 'reset') {
      paint(next);
      return false;
    }
    paint(next);
    if (typeof options.onChange === 'function') {
      options.onChange(id, next, { source });
    }
    return true;
  }

  function setLocked(locked) {
    const on = !!locked;
    row.dataset.locked = on ? 'true' : 'false';
    row.classList.toggle('slider-locked', on);
    row.classList.toggle('is-locked', on);
    lockBtn.classList.toggle('is-locked', on);
    lockBtn.setAttribute('aria-pressed', String(on));
    lockBtn.setAttribute('aria-label', on ? `Unlock ${label}` : `Lock ${label}`);
    lockBtn.title = on
      ? `Unlock ${label} (allow preset and edit changes)`
      : `Lock ${label} (ignore presets and accidental edits)`;
    range.classList.toggle('slider-input-locked', on);
    number.classList.toggle('slider-input-locked', on);
    range.readOnly = on;
    number.readOnly = on;
    if (on) {
      range.setAttribute('aria-readonly', 'true');
      number.setAttribute('aria-readonly', 'true');
    } else {
      range.removeAttribute('aria-readonly');
      number.removeAttribute('aria-readonly');
    }
    resetBtn.disabled = on;
  }

  const onPointerDown = (ev) => {
    if (isLockedFn()) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    doc.body?.classList.add('is-slider-dragging');
  };
  const onPointerUp = () => {
    doc.body?.classList.remove('is-slider-dragging');
  };
  const onRangeInput = () => commit(range.value, 'range');
  const onRangeKeydown = (ev) => {
    if (isLockedFn()) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(ev.key)) {
        ev.preventDefault();
      }
      return;
    }
    if (ev.key === 'PageUp') {
      ev.preventDefault();
      commit(value + pageStep, 'keyboard');
    } else if (ev.key === 'PageDown') {
      ev.preventDefault();
      commit(value - pageStep, 'keyboard');
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      commit(min, 'keyboard');
    } else if (ev.key === 'End') {
      ev.preventDefault();
      commit(max, 'keyboard');
    }
  };
  const onNumberChange = () => commit(number.value, 'number');
  const onNumberKeydown = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commit(number.value, 'number');
      number.blur();
    }
  };
  const onReset = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (isLockedFn()) return;
    if (typeof options.onReset === 'function') options.onReset(id);
    else commit(def, 'reset');
  };
  const onLock = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (typeof options.onToggleLock === 'function') options.onToggleLock(id);
  };

  range.addEventListener('pointerdown', onPointerDown);
  range.addEventListener('pointerup', onPointerUp);
  range.addEventListener('pointercancel', onPointerUp);
  range.addEventListener('lostpointercapture', onPointerUp);
  range.addEventListener('input', onRangeInput);
  range.addEventListener('keydown', onRangeKeydown);
  number.addEventListener('change', onNumberChange);
  number.addEventListener('keydown', onNumberKeydown);
  number.addEventListener('blur', onNumberChange);
  resetBtn.addEventListener('click', onReset);
  lockBtn.addEventListener('click', onLock);

  // Double-click range → default (common DAW pattern)
  range.addEventListener('dblclick', (ev) => {
    ev.preventDefault();
    if (!isLockedFn()) commit(def, 'reset');
  });

  row.appendChild(labelEl);
  row.appendChild(trackWrap);
  row.appendChild(numWrap);
  row.appendChild(resetBtn);
  row.appendChild(lockBtn);

  setLocked(isLockedFn());

  return {
    row,
    range,
    number,
    resetBtn,
    lockBtn,
    get value() {
      return value;
    },
    setValue(v, { silent = false } = {}) {
      const next = clampSnap(v, min, max, step);
      paint(next);
      if (!silent && typeof options.onChange === 'function') {
        options.onChange(id, next, { source: 'programmatic' });
      }
    },
    setLocked,
    dispose() {
      range.removeEventListener('pointerdown', onPointerDown);
      range.removeEventListener('pointerup', onPointerUp);
      range.removeEventListener('pointercancel', onPointerUp);
      range.removeEventListener('lostpointercapture', onPointerUp);
      range.removeEventListener('input', onRangeInput);
      range.removeEventListener('keydown', onRangeKeydown);
      number.removeEventListener('change', onNumberChange);
      number.removeEventListener('keydown', onNumberKeydown);
      number.removeEventListener('blur', onNumberChange);
      resetBtn.removeEventListener('click', onReset);
      lockBtn.removeEventListener('click', onLock);
      doc.body?.classList.remove('is-slider-dragging');
    },
  };
}

export default {
  createDspSliderRow,
  clampSnap,
  formatSliderDisplay,
  buildAriaValueText,
  spokenUnit,
  sliderMatchesQuery,
  SLIDER_SEARCH_ALIASES,
};

/**
 * VoiceIsolate Pro — Engineer Action & Boundary Contract (Layer 1: Core)
 *
 * VIP-021: Canonical action normalization, selection boundary validation, and
 * validated parameter mapping for Engineer Signal Canvas & RegionActionPalette.
 * Pure module: no DOM, no Web Audio, no I/O.
 */
'use strict';

import { clampParam, LIVE_MIX_PARAM_IDS } from './ParameterSchema.js';

export const ENGINEER_ACTIONS = Object.freeze({
  ISOLATE: 'isolate',
  ENHANCE: 'enhance',
  REDUCE_NOISE: 'reduce-noise',
  BOOST_WHISPER: 'boost-whisper',
  PREVIEW: 'preview',
  ZOOM: 'zoom',
  CLEAR: 'clear',
});

const ACTION_ALIASES = Object.freeze({
  isolate: ENGINEER_ACTIONS.ISOLATE,
  enhance: ENGINEER_ACTIONS.ENHANCE,
  enhance_voice: ENGINEER_ACTIONS.ENHANCE,
  'enhance-voice': ENGINEER_ACTIONS.ENHANCE,
  'reduce-noise': ENGINEER_ACTIONS.REDUCE_NOISE,
  reduce_noise: ENGINEER_ACTIONS.REDUCE_NOISE,
  'boost-whisper': ENGINEER_ACTIONS.BOOST_WHISPER,
  boost_whisper: ENGINEER_ACTIONS.BOOST_WHISPER,
  preview: ENGINEER_ACTIONS.PREVIEW,
  zoom: ENGINEER_ACTIONS.ZOOM,
  clear: ENGINEER_ACTIONS.CLEAR,
});

/**
 * Normalize hyphenated or underscored action identifiers from DOM or
 * `RegionActionPalette` to a single canonical action ID.
 * @param {string} rawAction
 * @returns {string|null}
 */
export function normalizeEngineerAction(rawAction) {
  if (typeof rawAction !== 'string') return null;
  const key = rawAction.trim().toLowerCase();
  return ACTION_ALIASES[key] || null;
}

const MIN_SELECTION_SEC = 0.01;

/**
 * Validate and clamp a time selection `[startSec, endSec]` against a track's
 * `durationSec`. Never produces out-of-range, inverted, or NaN bounds.
 *
 * @param {number} startSec
 * @param {number} endSec
 * @param {number} durationSec
 * @returns {{
 *   ok: boolean,
 *   startSec: number,
 *   endSec: number,
 *   durationSec: number,
 *   startNorm: number,
 *   endNorm: number,
 *   reason: string|null,
 * }}
 */
export function validateSelectionBounds(startSec, endSec, durationSec) {
  const dur = Number(durationSec);
  if (!Number.isFinite(dur) || dur <= 0) {
    return {
      ok: false,
      startSec: 0,
      endSec: 0,
      durationSec: 0,
      startNorm: 0,
      endNorm: 0,
      reason: 'Import and decode an audio file before running selection actions.',
    };
  }
  const rawA = Number(startSec);
  const rawB = Number(endSec);
  if (!Number.isFinite(rawA) || !Number.isFinite(rawB)) {
    return {
      ok: false,
      startSec: 0,
      endSec: 0,
      durationSec: dur,
      startNorm: 0,
      endNorm: 0,
      reason: 'Invalid selection timestamps.',
    };
  }
  const lo = Math.max(0, Math.min(dur, Math.min(rawA, rawB)));
  const hi = Math.max(0, Math.min(dur, Math.max(rawA, rawB)));
  if (hi - lo < Math.min(MIN_SELECTION_SEC, dur * 0.5)) {
    return {
      ok: false,
      startSec: lo,
      endSec: hi,
      durationSec: dur,
      startNorm: lo / dur,
      endNorm: hi / dur,
      reason: 'Selected region is too short (< 10 ms). Drag a wider region on the waveform.',
    };
  }
  return {
    ok: true,
    startSec: lo,
    endSec: hi,
    durationSec: dur,
    startNorm: lo / dur,
    endNorm: hi / dur,
    reason: null,
  };
}

/**
 * Map a canonical Engineer region action to schema-clamped DSP parameter targets
 * and explicit scope disclosure (Live-Mix immediate vs Process-time).
 *
 * @param {string} rawAction
 * @returns {{
 *   action: string|null,
 *   supported: boolean,
 *   kind: 'pipeline'|'parameters'|'playback'|'view'|'unsupported',
 *   params: Record<string, number>,
 *   liveMixImmediate: string[],
 *   requiresReprocess: string[],
 *   scopeNote: string,
 * }}
 */
export function resolveActionParameterPlan(rawAction) {
  const action = normalizeEngineerAction(rawAction);
  if (!action) {
    return {
      action: null,
      supported: false,
      kind: 'unsupported',
      params: {},
      liveMixImmediate: [],
      requiresReprocess: [],
      scopeNote: `Action "${String(rawAction)}" is not supported.`,
    };
  }

  if (action === ENGINEER_ACTIONS.ISOLATE) {
    return {
      action,
      supported: true,
      kind: 'pipeline',
      params: {},
      liveMixImmediate: [],
      requiresReprocess: [],
      scopeNote: 'Marks selection as a protected voice zone and runs local isolation.',
    };
  }

  if (action === ENGINEER_ACTIONS.PREVIEW) {
    return {
      action,
      supported: true,
      kind: 'playback',
      params: {},
      liveMixImmediate: [],
      requiresReprocess: [],
      scopeNote: 'Plays back the selected region locally from start to end.',
    };
  }

  if (action === ENGINEER_ACTIONS.ZOOM || action === ENGINEER_ACTIONS.CLEAR) {
    return {
      action,
      supported: true,
      kind: 'view',
      params: {},
      liveMixImmediate: [],
      requiresReprocess: [],
      scopeNote: action === ENGINEER_ACTIONS.ZOOM
        ? 'Zooms Signal Canvas to selected bounds.'
        : 'Clears selection and resets Signal Canvas zoom.',
    };
  }

  const rawTargets = action === ENGINEER_ACTIONS.BOOST_WHISPER
    ? { whisperLift: 12, voiceTunnel: 60 }
    : action === ENGINEER_ACTIONS.ENHANCE
      ? { whisperLift: 6, voiceTunnel: 60 }
      : { nrAmount: 70, bgSuppress: 60 }; // REDUCE_NOISE

  /** @type {Record<string, number>} */
  const clamped = {};
  const liveMixImmediate = [];
  const requiresReprocess = [];
  const liveMixSet = new Set(LIVE_MIX_PARAM_IDS || []);
  for (const [id, val] of Object.entries(rawTargets)) {
    clamped[id] = clampParam(id, val);
    if (liveMixSet.has(id)) liveMixImmediate.push(id);
    else requiresReprocess.push(id);
  }

  const scopeNote = liveMixImmediate.length > 0 && requiresReprocess.length > 0
    ? `${liveMixImmediate.join(', ')} updated immediately in Live-Mix; ${requiresReprocess.join(', ')} apply file-wide on Reprocess.`
    : requiresReprocess.length > 0
      ? `${requiresReprocess.join(', ')} calibrated (file-wide on Reprocess).`
      : `${liveMixImmediate.join(', ')} updated immediately in Live-Mix.`;

  return {
    action,
    supported: true,
    kind: 'parameters',
    params: clamped,
    liveMixImmediate,
    requiresReprocess,
    scopeNote,
  };
}

/**
 * Deterministic 2D log-magnitude spectrogram builder for Signal Canvas
 * (`#engineerSpecCanvas`), replacing the demo `Math.random()` placeholder.
 * Computes energy across `cols` time slices × `rows` frequency bins over
 * `channel[startSample..endSample]` using a 256-point Hann DFT.
 *
 * @param {Float32Array} channel
 * @param {number} cols
 * @param {number} rows
 * @param {{ startNorm?: number, endNorm?: number }} [zoom]
 * @returns {Float32Array} row-major `[rows * cols]` normalized intensities in `[0, 1]`
 */
export function computeSpectrogramGrid(channel, cols, rows, zoom = {}) {
  const out = new Float32Array(Math.max(1, cols * rows));
  if (!channel || channel.length === 0 || cols <= 0 || rows <= 0) return out;

  const zStart = Math.max(0, Math.min(1, Number(zoom.startNorm ?? 0)));
  const zEnd = Math.max(zStart + 1e-6, Math.min(1, Number(zoom.endNorm ?? 1)));
  const s0 = Math.floor(zStart * channel.length);
  const s1 = Math.max(s0 + 1, Math.min(channel.length, Math.ceil(zEnd * channel.length)));
  const span = s1 - s0;

  const N = 256;
  const halfBins = N >> 1; // 128 bins (DC..Nyquist)
  const hann = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    hann[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
  }

  // Precompute radix-2 bit-reversal & twiddle tables for N = 256
  const rev = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    let x = i;
    let y = 0;
    for (let b = 0; b < 8; b++) {
      y = (y << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = y;
  }

  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const binMag = new Float32Array(halfBins);

  for (let x = 0; x < cols; x++) {
    const center = s0 + Math.floor(((x + 0.5) / cols) * span);
    const frameStart = center - (N >> 1);
    for (let n = 0; n < N; n++) {
      const idx = frameStart + n;
      const sample = idx >= s0 && idx < s1 ? channel[idx] : 0;
      re[rev[n]] = sample * hann[n];
      im[rev[n]] = 0;
    }

    // Iterative Cooley-Tukey radix-2 FFT (N = 256 -> 8 stages, very fast)
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1;
      const ang = (-2 * Math.PI) / len;
      const wLenRe = Math.cos(ang);
      const wLenIm = Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let wRe = 1;
        let wIm = 0;
        for (let j = 0; j < half; j++) {
          const uRe = re[i + j];
          const uIm = im[i + j];
          const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
          const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
          re[i + j] = uRe + vRe;
          im[i + j] = uIm + vIm;
          re[i + j + half] = uRe - vRe;
          im[i + j + half] = uIm - vIm;
          const nextWRe = wRe * wLenRe - wIm * wLenIm;
          wIm = wRe * wLenIm + wIm * wLenRe;
          wRe = nextWRe;
        }
      }
    }

    for (let k = 0; k < halfBins; k++) {
      const mag = Math.hypot(re[k], im[k]) / halfBins;
      // Map [-80 dB .. -6 dB] -> [0 .. 1]
      const db = 20 * Math.log10(Math.max(1e-5, mag));
      binMag[k] = Math.max(0, Math.min(1, (db + 80) / 74));
    }

    for (let y = 0; y < rows; y++) {
      // Row 0 = top (high frequency), Row rows-1 = bottom (low frequency)
      const freqNorm = 1 - y / Math.max(1, rows - 1);
      const kFloat = freqNorm * (halfBins - 1);
      const k0 = Math.floor(kFloat);
      const k1 = Math.min(halfBins - 1, k0 + 1);
      const frac = kFloat - k0;
      out[y * cols + x] = binMag[k0] * (1 - frac) + binMag[k1] * frac;
    }
  }

  return out;
}

export default {
  ENGINEER_ACTIONS,
  normalizeEngineerAction,
  validateSelectionBounds,
  resolveActionParameterPlan,
  computeSpectrogramGrid,
};

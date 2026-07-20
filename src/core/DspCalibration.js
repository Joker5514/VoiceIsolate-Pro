/**
 * VoiceIsolate Pro — DSP Calibration (Layer 1: Core)
 *
 * Safe defaults, sample-rate scaling, and gain-staging helpers so stages
 * behave predictably across browsers and devices.
 */
'use strict';

import { SAMPLE_RATE } from './audio-config.js';

/** Canonical loudness target for export / make-up (LUFS-ish aim, not a full meter). */
export const LOUDNESS_TARGET_LUFS = -16;

/** Preview compensation so wet chains don't explode into the meter. */
export const PREVIEW_GAIN_COMP_DB = -1.5;

/** Safe wet/dry default (100 = fully processed). */
export const DEFAULT_WET_DRY = 100;

/**
 * Scale a time constant (ms) between sample rates.
 * @param {number} ms
 * @param {number} fromSr
 * @param {number} toSr
 */
export function scaleTimeMs(ms, fromSr, toSr) {
  if (!fromSr || !toSr || fromSr === toSr) return ms;
  // Envelope times are absolute; keep ms, only quantize to samples if needed.
  return ms;
}

/**
 * Scale a frequency parameter when sample rate changes (Nyquist clamp).
 * @param {number} hz
 * @param {number} sampleRate
 */
export function clampHz(hz, sampleRate = SAMPLE_RATE) {
  const nyq = sampleRate * 0.49;
  return Math.max(20, Math.min(nyq, hz));
}

/**
 * Gate threshold defaults by use case (dBFS).
 */
export const GATE_DEFAULTS = Object.freeze({
  cleanSpeech: { thresh: -44, range: -58, attack: 4, release: 180, hold: 40 },
  whisper: { thresh: -68, range: -78, attack: 2, release: 140, hold: 35 },
  forensic: { thresh: -62, range: -78, attack: 2, release: 90, hold: 18 },
  podcast: { thresh: -52, range: -62, attack: 5, release: 200, hold: 45 },
});

/**
 * Noise reduction / spectral defaults (normalized 0–100 where applicable).
 */
export const NR_DEFAULTS = Object.freeze({
  cleanSpeech: { amount: 52, sensitivity: 48, spectralSub: 32, floorDb: -68, smoothing: 30 },
  whisper: { amount: 55, sensitivity: 45, spectralSub: 40, floorDb: -78, smoothing: 65 },
  noisy: { amount: 82, sensitivity: 75, spectralSub: 70, floorDb: -78, smoothing: 70 },
  forensic: { amount: 90, sensitivity: 80, spectralSub: 82, floorDb: -82, smoothing: 78 },
});

/**
 * Hum removal defaults.
 */
export const HUM_DEFAULTS = Object.freeze({
  strength: 60,
  freqs: Object.freeze([50, 60]),
  harmonics: 5,
});

/**
 * Voice enhancement EQ defaults (dB) — presence-forward, no air spike.
 */
export const VOICE_EQ_DEFAULTS = Object.freeze({
  sub: 0, bass: 0, warmth: 0.5, body: 1, lowMid: 0.5,
  mid: 1, presence: 1.5, clarity: 0.5, air: 0, brill: 0,
});

/**
 * Prevent gain explosions: clamp makeup + out gain combination.
 * @param {number} makeupDb
 * @param {number} outGainDb
 */
export function clampGainStaging(makeupDb, outGainDb) {
  const makeup = Math.max(0, Math.min(12, Number(makeupDb) || 0));
  const out = Math.max(-24, Math.min(12, Number(outGainDb) || 0));
  const sum = makeup + out;
  if (sum > 14) {
    const scale = 14 / sum;
    return { makeupDb: makeup * scale, outGainDb: out * scale, limited: true };
  }
  return { makeupDb: makeup, outGainDb: out, limited: false };
}

/**
 * Wiener / spectral subtraction intensity → safe [0,1] mask mix.
 * @param {number} uiAmount 0–100
 */
export function wienerIntensity(uiAmount) {
  const a = Math.max(0, Math.min(100, Number(uiAmount) || 0)) / 100;
  // Soft knee so 100% is strong but not total annihilation of noise floor
  return 0.15 + a * 0.75;
}

/**
 * Dereverb amount mapping (0–100 → algorithm strength).
 */
export function dereverbStrength(uiAmount) {
  const a = Math.max(0, Math.min(100, Number(uiAmount) || 0)) / 100;
  return a * a; // quadratic: gentle at low, strong at high
}

/**
 * Bootstrap calibrated VIP_PARAMS patch for a scenario key.
 * @param {'cleanSpeech'|'whisper'|'forensic'|'podcast'|'noisy'} scenario
 */
export function bootstrapScenario(scenario = 'cleanSpeech') {
  const gate = GATE_DEFAULTS[scenario] || GATE_DEFAULTS.cleanSpeech;
  const nr = NR_DEFAULTS[scenario] || NR_DEFAULTS.cleanSpeech;
  const eq = VOICE_EQ_DEFAULTS;
  return {
    gateThresh: gate.thresh,
    gateRange: gate.range,
    gateAttack: gate.attack,
    gateRelease: gate.release,
    gateHold: gate.hold,
    nrAmount: nr.amount,
    nrSensitivity: nr.sensitivity,
    nrSpectralSub: nr.spectralSub,
    nrFloor: nr.floorDb,
    nrSmoothing: nr.smoothing,
    eqSub: eq.sub,
    eqBass: eq.bass,
    eqWarmth: eq.warmth,
    eqBody: eq.body,
    eqLowMid: eq.lowMid,
    eqMid: eq.mid,
    eqPresence: eq.presence,
    eqClarity: eq.clarity,
    eqAir: eq.air,
    eqBrill: eq.brill,
    dryWet: DEFAULT_WET_DRY,
    previewCompDb: PREVIEW_GAIN_COMP_DB,
    loudnessTarget: LOUDNESS_TARGET_LUFS,
  };
}

export default {
  LOUDNESS_TARGET_LUFS,
  PREVIEW_GAIN_COMP_DB,
  GATE_DEFAULTS,
  NR_DEFAULTS,
  HUM_DEFAULTS,
  VOICE_EQ_DEFAULTS,
  scaleTimeMs,
  clampHz,
  clampGainStaging,
  wienerIntensity,
  dereverbStrength,
  bootstrapScenario,
};

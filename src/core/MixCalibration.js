/**
 * VoiceIsolate Pro — Mix Calibration (Layer 1: Core)
 *
 * Canonical real-time slider defaults, landing presets, and stem-level
 * auto-calibration. Every preset is a full 23-slider map so partial presets
 * never leave the graph in an inconsistent state.
 */
'use strict';

/** Neutral real-time slider baseline (matches SliderUI initial values). */
export const RT_SLIDER_DEFAULTS = Object.freeze({
  noiseReductionSlider: 100,
  voiceLevelSlider: 100,
  volumeSlider: 100,
  eqLowSlider: 0,
  eqHighSlider: 0,
  eqLowMidSlider: 0,
  eqMidSlider: 0,
  eqHighMidSlider: 0,
  highpassSlider: 20,
  lowpassSlider: 20000,
  compThresholdSlider: 0,
  compRatioSlider: 1,
  compAttackSlider: 20,
  compReleaseSlider: 250,
  compKneeSlider: 0,
  makeupGainSlider: 0,
  stereoWidthSlider: 100,
  gateThresholdSlider: -45,
  gateRangeSlider: 0,
  gateAttackSlider: 5,
  gateReleaseSlider: 100,
  deEsserFreqSlider: 6000,
  deEsserAmountSlider: 0,
});

/** Merge preset partials onto the neutral baseline. */
export function buildPreset(overrides) {
  return { ...RT_SLIDER_DEFAULTS, ...overrides };
}

export const LANDING_PRESET_NAMES = Object.freeze([
  'voice-clarity',
  'balanced',
  'podcast-warm',
  'whisper-boost',
  'residual-monitor',
  'original',
]);

export const LANDING_PRESETS = Object.freeze({
  'voice-clarity': buildPreset({
    noiseReductionSlider: 100,
    voiceLevelSlider: 115,
    eqLowSlider: -4,
    eqHighSlider: 3,
    eqLowMidSlider: 0,
    eqMidSlider: 1,
    eqHighMidSlider: 2,
    compThresholdSlider: -24,
    compRatioSlider: 4,
    compReleaseSlider: 180,
    makeupGainSlider: 2,
    gateThresholdSlider: -48,
    deEsserAmountSlider: 8,
  }),
  balanced: buildPreset({
    noiseReductionSlider: 70,
    eqHighSlider: 1,
    compThresholdSlider: -20,
    compRatioSlider: 2.5,
  }),
  'podcast-warm': buildPreset({
    noiseReductionSlider: 90,
    voiceLevelSlider: 110,
    volumeSlider: 95,
    eqLowSlider: 3,
    eqHighSlider: 1,
    eqLowMidSlider: 1,
    compThresholdSlider: -22,
    compRatioSlider: 3,
    makeupGainSlider: 2,
    deEsserFreqSlider: 6500,
    deEsserAmountSlider: 20,
  }),
  'whisper-boost': buildPreset({
    noiseReductionSlider: 85,
    voiceLevelSlider: 140,
    eqLowSlider: -6,
    eqHighSlider: 4,
    eqLowMidSlider: 2,
    eqMidSlider: 4,
    eqHighMidSlider: 3,
    highpassSlider: 100,
    lowpassSlider: 14000,
    compThresholdSlider: -36,
    compRatioSlider: 4,
    compAttackSlider: 10,
    compReleaseSlider: 150,
    compKneeSlider: 6,
    makeupGainSlider: 6,
    gateThresholdSlider: -68,
    gateRangeSlider: 0,
    gateAttackSlider: 3,
    gateReleaseSlider: 150,
    deEsserFreqSlider: 5500,
    deEsserAmountSlider: 12,
  }),
  'residual-monitor': buildPreset({
    noiseReductionSlider: 0,
    voiceLevelSlider: 0,
  }),
  original: buildPreset({
    noiseReductionSlider: 0,
  }),
});

export const SCENE_TO_LANDING_PRESET = Object.freeze({
  whisper: 'whisper-boost',
  quiet: 'voice-clarity',
  normal: 'balanced',
  loud: 'balanced',
  podcast: 'podcast-warm',
  interview: 'balanced',
  broadcast: 'voice-clarity',
  forensic: 'voice-clarity',
  music: 'balanced',
  film: 'balanced',
});

export const SCENE_TO_ENGINEER_PRESET = Object.freeze({
  whisper: 'Whisper Boost',
  quiet: 'Voice Clarity',
  normal: 'Voice Clarity',
  loud: 'Podcast Clean',
  podcast: 'Podcast Clean',
  interview: 'Voice Clarity',
  broadcast: 'Podcast Clean',
  forensic: 'Forensic Extract',
  music: 'Music Vocal',
  film: 'Live Performance',
});

/** Compute RMS with subsampling for long buffers. */
export function calcRms(audio) {
  if (!audio || audio.length === 0) return 0;
  const step = Math.max(1, Math.floor(audio.length / 48000));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < audio.length; i += step) {
    sum += audio[i] * audio[i];
    count++;
  }
  return Math.sqrt(sum / count);
}

/** Downmix channel arrays to mono for analysis. */
export function downmixToMono(channels) {
  if (!channels?.length) return new Float32Array(0);
  const len = channels[0].length;
  const mono = new Float32Array(len);
  const inv = 1 / channels.length;
  for (let ch = 0; ch < channels.length; ch++) {
    const c = channels[ch];
    for (let i = 0; i < len; i++) mono[i] += c[i] * inv;
  }
  return mono;
}

/**
 * Classify content loudness for calibration.
 * @param {number} rms  linear RMS (0–1)
 * @returns {'whisper'|'quiet'|'normal'|'loud'}
 */
export function classifyLevel(rms) {
  const rmsDb = 20 * Math.log10(rms + 1e-10);
  if (rmsDb < -42) return 'whisper';
  if (rmsDb < -30) return 'quiet';
  if (rmsDb < -18) return 'normal';
  return 'loud';
}

/**
 * Fine-tune slider overrides from measured stem loudness.
 * @param {'whisper'|'quiet'|'normal'|'loud'} level
 * @param {number} rmsDb
 * @returns {Record<string, number>}
 */
export function levelOverrides(level, rmsDb) {
  const overrides = {};
  if (level === 'whisper') {
    overrides.voiceLevelSlider = Math.min(180, Math.max(125, Math.round(130 + (-rmsDb - 42) * 2)));
    overrides.gateThresholdSlider = Math.min(-60, Math.round(rmsDb - 8));
    overrides.noiseReductionSlider = Math.min(95, Math.max(75, Math.round(90 + (rmsDb + 50) * 0.5)));
    overrides.gateRangeSlider = 0;
  } else if (level === 'quiet') {
    overrides.voiceLevelSlider = 120;
    overrides.gateThresholdSlider = -55;
    overrides.noiseReductionSlider = 90;
  } else if (level === 'loud') {
    overrides.voiceLevelSlider = 95;
    overrides.compThresholdSlider = -28;
    overrides.compRatioSlider = 3;
    overrides.makeupGainSlider = 0;
  }
  return overrides;
}

/**
 * Analyze clean stem and return a landing preset recommendation.
 * @param {Float32Array[]} cleanChannels
 * @param {number} [_sampleRate]
 */
export function calibrateFromStems(cleanChannels, _sampleRate = 48000) {
  const mono = downmixToMono(cleanChannels);
  if (mono.length === 0) {
    return { preset: 'balanced', level: 'normal', rmsDb: -60, overrides: {}, sliders: LANDING_PRESETS.balanced };
  }
  const rms = calcRms(mono);
  const rmsDb = 20 * Math.log10(rms + 1e-10);
  const level = classifyLevel(rms);
  const preset = SCENE_TO_LANDING_PRESET[level] || 'balanced';
  const overrides = levelOverrides(level, rmsDb);
  const sliders = mergePreset(preset, overrides);
  return { preset, level, rmsDb, overrides, sliders };
}

/** Merge a named preset with per-file overrides. */
export function mergePreset(presetName, overrides = {}) {
  const base = LANDING_PRESETS[presetName] || LANDING_PRESETS.balanced;
  return { ...base, ...overrides };
}

/**
 * Recommend an Engineer Mode preset from processed audio.
 * @param {Float32Array[]} channels
 */
export function recommendEngineerPreset(channels) {
  const mono = downmixToMono(channels);
  if (mono.length === 0) return { preset: 'Voice Clarity', level: 'normal', rmsDb: -60 };
  const rms = calcRms(mono);
  const rmsDb = 20 * Math.log10(rms + 1e-10);
  const level = classifyLevel(rms);
  const preset = SCENE_TO_ENGINEER_PRESET[level] || 'Voice Clarity';
  return { preset, level, rmsDb };
}

export default {
  RT_SLIDER_DEFAULTS,
  LANDING_PRESETS,
  LANDING_PRESET_NAMES,
  buildPreset,
  calcRms,
  downmixToMono,
  classifyLevel,
  levelOverrides,
  calibrateFromStems,
  mergePreset,
  recommendEngineerPreset,
};
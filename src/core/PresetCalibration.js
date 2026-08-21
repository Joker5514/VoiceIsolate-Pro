/**
 * VoiceIsolate Pro — Preset Calibration Catalog (Layer 1: Core)
 *
 * Canonical Engineer Mode presets after cleanup. Each preset has a clear use
 * case and maps to real DSP parameters. Pure data + helpers.
 */
'use strict';

import { bootstrapScenario } from './DspCalibration.js';

/**
 * Extreme-off defaults for whisper-path controls (safe when not needed).
 */
export const EXTREME_OFF = Object.freeze({
  whisperLift: 0,
  crowdNull: 0,
  bassCrush: 0,
  reverbStrip: 0,
  voiceTunnel: 0,
  musicKill: 0,
  snrFloor: -52,
  whisperMode: 0,
  whisperClarity: 65,
  whisperSensitivity: 55,
  whisperThreshold: 50,
  transientShaper: 0,
  breathControl: 0,
  roomCorrection: 0,
  subHarmonic: 0,
});

function base(overrides) {
  const clean = bootstrapScenario('cleanSpeech');
  return {
    description: '',
    gateThresh: clean.gateThresh,
    gateRange: clean.gateRange,
    gateAttack: clean.gateAttack,
    gateRelease: clean.gateRelease,
    gateHold: clean.gateHold,
    gateLookahead: 5,
    nrAmount: clean.nrAmount,
    nrSensitivity: clean.nrSensitivity,
    nrSpectralSub: clean.nrSpectralSub,
    nrFloor: clean.nrFloor,
    nrSmoothing: clean.nrSmoothing,
    eqSub: clean.eqSub,
    eqBass: clean.eqBass,
    eqWarmth: clean.eqWarmth,
    eqBody: clean.eqBody,
    eqLowMid: clean.eqLowMid,
    eqMid: clean.eqMid,
    eqPresence: clean.eqPresence,
    eqClarity: clean.eqClarity,
    eqAir: clean.eqAir,
    eqBrill: clean.eqBrill,
    compThresh: -22,
    compRatio: 3.5,
    compAttack: 8,
    compRelease: 140,
    compKnee: 5,
    compMakeup: 1.5,
    limThresh: -1,
    limRelease: 45,
    hpFreq: 70,
    hpQ: 0.7,
    lpFreq: 14000,
    lpQ: 0.7,
    deEssFreq: 6500,
    deEssAmt: 5,
    specTilt: 0,
    formantShift: 0,
    derevAmt: 8,
    derevDecay: 30,
    harmRecov: 0,
    harmOrder: 3,
    stereoWidth: 100,
    phaseCorr: 0,
    voiceIso: 72,
    bgSuppress: 38,
    voiceFocusLo: 100,
    voiceFocusHi: 4200,
    crosstalkCancel: 0,
    outGain: 1,
    dryWet: 100,
    ditherAmt: 0,
    outWidth: 100,
    humRemoval: 0,
    ...EXTREME_OFF,
    ...overrides,
  };
}

/**
 * Calibrated Engineer presets (post-cleanup).
 * Removed redundant extremes; added Room Echo Reduction + Hum Removal + Aggressive Isolate.
 */
export const CALIBRATED_ENGINEER_PRESETS = Object.freeze({
  'Voice Clarity': base({
    description: 'Isolate speech and enhance intelligibility with balanced noise reduction',
  }),
  'Podcast Clean': base({
    description: 'Studio-clean podcast isolation with de-essing and steady loudness',
    gateThresh: -52,
    gateRange: -62,
    gateAttack: 5,
    gateRelease: 200,
    nrAmount: 55,
    eqSub: -1,
    eqWarmth: 1,
    eqBody: 0.5,
    eqMid: 0.5,
    eqPresence: 1,
    deEssAmt: 8,
    deEssFreq: 6500,
    hpFreq: 90,
    breathControl: 28,
    outGain: 0,
  }),
  'Whisper Boost': base({
    description: 'Amplify and isolate soft whispering voices without over-gating consonants',
    gateThresh: -70,
    gateRange: -78,
    gateAttack: 2,
    gateRelease: 140,
    nrAmount: 55,
    nrSensitivity: 45,
    nrSpectralSub: 42,
    nrFloor: -78,
    nrSmoothing: 68,
    eqBody: 2.5,
    eqLowMid: 2,
    eqMid: 3,
    eqPresence: 3.5,
    eqClarity: 2,
    eqAir: 0.5,
    compThresh: -36,
    compRatio: 4.5,
    compMakeup: 7,
    outGain: 5,
    whisperLift: 18,
    voiceTunnel: 65,
    whisperMode: 1,
    whisperClarity: 78,
    whisperSensitivity: 72,
    whisperThreshold: 42,
    snrFloor: -58,
    voiceIso: 78,
    bgSuppress: 55,
    derevAmt: 14,
  }),
  'Phone/Radio': base({
    description: 'Band-limit and isolate speech for phone / radio recovery',
    gateThresh: -48,
    nrAmount: 78,
    nrSensitivity: 68,
    eqSub: -12,
    eqBass: -8,
    eqWarmth: -3,
    eqBody: 0.5,
    eqLowMid: 2.5,
    eqMid: 1.5,
    eqAir: -6,
    eqBrill: -10,
    hpFreq: 280,
    lpFreq: 3800,
    stereoWidth: 0,
    outWidth: 0,
    voiceIso: 88,
    bgSuppress: 74,
    harmRecov: 28,
  }),
  'Room Echo Reduction': base({
    description: 'Reduce room tone and reverb tails while preserving speech clarity',
    gateThresh: -50,
    nrAmount: 48,
    nrSmoothing: 40,
    derevAmt: 62,
    derevDecay: 58,
    roomCorrection: 55,
    reverbStrip: 420,
    eqPresence: 1.5,
    eqClarity: 1,
    voiceIso: 70,
    bgSuppress: 45,
    outGain: 1,
  }),
  'Hum Removal': base({
    description: 'Target mains hum/buzz with conservative speech preservation',
    gateThresh: -46,
    nrAmount: 40,
    // humRemoval is analyzer/meta (not a rack slider) — keep for RecommendationEngine.
    humRemoval: 85,
    phaseCorr: 28,
    eqSub: -2,
    eqBass: -1,
    hpFreq: 85,
    nrSpectralSub: 55,
    voiceIso: 65,
    bgSuppress: 30,
    outGain: 0,
  }),
  'Forensic Extract': base({
    description: 'Maximum voice extraction for low-SNR analysis — may introduce artifacts',
    gateThresh: -62,
    gateRange: -78,
    gateAttack: 2,
    gateRelease: 90,
    nrAmount: 90,
    nrSensitivity: 78,
    nrSpectralSub: 80,
    nrFloor: -82,
    nrSmoothing: 75,
    eqSub: -6,
    eqBass: -2,
    eqBody: 1.5,
    eqLowMid: 1.5,
    eqMid: 2.5,
    eqPresence: 2.5,
    eqClarity: 1.5,
    eqBrill: -2,
    compThresh: -28,
    compRatio: 6,
    // Makeup + outGain capped so stacked gain stays within limiter headroom.
    compMakeup: 4,
    outGain: 3,
    limThresh: -1,
    derevAmt: 45,
    voiceIso: 92,
    bgSuppress: 85,
    whisperMode: 1,
    whisperLift: 10,
    snrFloor: -56,
  }),
  'Aggressive Isolate': base({
    description: 'Strong voice isolation against music beds and dense backgrounds',
    gateThresh: -58,
    nrAmount: 88,
    nrSensitivity: 80,
    musicKill: 82,
    bassCrush: 70,
    crowdNull: 70,
    voiceTunnel: 75,
    voiceIso: 94,
    bgSuppress: 90,
    eqPresence: 3,
    eqClarity: 2,
    outGain: 3,
    whisperMode: 0,
  }),
  'Surveillance': base({
    description: 'Field / outdoor noisy recovery with balanced aggression',
    gateThresh: -64,
    gateRange: -78,
    nrAmount: 86,
    nrSensitivity: 80,
    nrSpectralSub: 75,
    nrFloor: -80,
    eqBody: 1.5,
    eqMid: 2.5,
    eqPresence: 2.5,
    voiceIso: 90,
    bgSuppress: 84,
    crowdNull: 75,
    derevAmt: 32,
    outGain: 3,
    limThresh: -1,
    whisperLift: 8,
    whisperMode: 1,
  }),
});

/** Presets removed in cleanup (redirect map for UI/tests). */
export const PRESET_REDIRECTS = Object.freeze({
  'Whisper in a Club': 'Aggressive Isolate',
  'Stadium Crowd': 'Surveillance',
});

/**
 * Resolve a preset name through redirects.
 * @param {string} name
 */
export function resolvePresetName(name) {
  if (!name) return 'Voice Clarity';
  if (CALIBRATED_ENGINEER_PRESETS[name]) return name;
  if (PRESET_REDIRECTS[name]) return PRESET_REDIRECTS[name];
  return 'Voice Clarity';
}

/**
 * Get full preset map (copy) for UI injection.
 */
export function getCalibratedPresets() {
  const out = {};
  for (const [k, v] of Object.entries(CALIBRATED_ENGINEER_PRESETS)) {
    out[k] = { ...v };
  }
  return out;
}

export default {
  EXTREME_OFF,
  CALIBRATED_ENGINEER_PRESETS,
  PRESET_REDIRECTS,
  resolvePresetName,
  getCalibratedPresets,
};

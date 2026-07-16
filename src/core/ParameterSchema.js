/**
 * VoiceIsolate Pro — Typed Engineer Parameter Schema (Layer 1: Core)
 *
 * Maps Engineer Mode slider IDs to DSP / ML roles for UI tooltips, research
 * export, and preset validation. Pure data — no DOM, no Web Audio.
 *
 * rt:true  → may drive PlaybackMixer / worklet AudioParams during Live-Mix.
 * rt:false → offline / reprocess-only (spectral, multi-pass, model selection).
 */
'use strict';

/**
 * @typedef {'gate'|'nr'|'eq'|'dynamics'|'filter'|'deess'|'spatial'|'isolation'|'output'|'whisper'|'meta'} ParamCategory
 * @typedef {'audioParam'|'portMessage'|'offlineOnly'|'display'} ControlPath
 *
 * @typedef {object} ParamSpec
 * @property {string} id
 * @property {string} label
 * @property {ParamCategory} category
 * @property {number} min
 * @property {number} max
 * @property {number} default
 * @property {number} [step]
 * @property {string} unit
 * @property {boolean} rt
 * @property {ControlPath} path
 * @property {string} effect  Short academic/UI description of perceptual effect
 * @property {string} [workletParam]
 */

/** @type {readonly ParamSpec[]} */
export const PARAMETER_SCHEMA = Object.freeze([
  // ── Gate ──────────────────────────────────────────────────────────────
  { id: 'gateThresh', label: 'Gate Threshold', category: 'gate', min: -100, max: 0, default: -42, step: 1, unit: 'dB', rt: true, path: 'audioParam', effect: 'Level below which the gate closes. Raise to cut more residual noise between phrases; lower to preserve quiet speech.', workletParam: 'threshold' },
  { id: 'gateRange', label: 'Gate Range', category: 'gate', min: -80, max: -5, default: -60, step: 1, unit: 'dB', rt: true, path: 'audioParam', effect: 'Attenuation depth when the gate is closed (UI negative dB; mixer uses positive depth).', workletParam: 'range' },
  { id: 'gateAttack', label: 'Gate Attack', category: 'gate', min: 0, max: 100, default: 5, step: 1, unit: 'ms', rt: true, path: 'audioParam', effect: 'How fast the gate opens when speech exceeds threshold.', workletParam: 'attack' },
  { id: 'gateRelease', label: 'Gate Release', category: 'gate', min: 50, max: 2000, default: 200, step: 10, unit: 'ms', rt: true, path: 'audioParam', effect: 'How fast the gate closes after speech falls below threshold.', workletParam: 'release' },
  { id: 'gateHold', label: 'Gate Hold', category: 'gate', min: 0, max: 500, default: 50, step: 5, unit: 'ms', rt: true, path: 'audioParam', effect: 'Minimum open time to reduce chattering on breathy speech.', workletParam: 'hold' },
  { id: 'gateLookahead', label: 'Gate Lookahead', category: 'gate', min: 0, max: 20, default: 5, step: 1, unit: 'ms', rt: false, path: 'offlineOnly', effect: 'Offline gate anticipatory delay; not applied in live worklet path.' },

  // ── Noise reduction (offline spectral) ────────────────────────────────
  { id: 'nrAmount', label: 'NR Amount', category: 'nr', min: 0, max: 100, default: 70, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Spectral noise reduction strength (Wiener / subtraction). Higher = cleaner but more artifacts.' },
  { id: 'nrSensitivity', label: 'NR Sensitivity', category: 'nr', min: 0, max: 100, default: 55, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'How aggressively noise PSD is tracked vs speech.' },
  { id: 'nrSpectralSub', label: 'Spectral Subtraction', category: 'nr', min: 0, max: 100, default: 50, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Oversubtraction factor for steady-state noise.' },
  { id: 'nrFloor', label: 'NR Floor', category: 'nr', min: -96, max: -20, default: -72, step: 1, unit: 'dB', rt: false, path: 'offlineOnly', effect: 'Minimum residual noise floor after NR.' },
  { id: 'nrSmoothing', label: 'NR Smoothing', category: 'nr', min: 0, max: 100, default: 65, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Temporal smoothing of spectral gain to reduce musical noise.' },

  // ── EQ ────────────────────────────────────────────────────────────────
  { id: 'eqSub', label: 'EQ Sub', category: 'eq', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Sub-bass shelf gain on the live-mix bus.' },
  { id: 'eqBass', label: 'EQ Bass', category: 'eq', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Low-band graphic EQ.' },
  { id: 'eqWarmth', label: 'EQ Warmth', category: 'eq', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Low-mid warmth band.' },
  { id: 'eqBody', label: 'EQ Body', category: 'eq', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Speech body / chest resonance band.' },
  { id: 'eqLowMid', label: 'EQ Low-Mid', category: 'eq', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Mud-control low-mid peaking band.' },
  { id: 'eqMid', label: 'EQ Mid', category: 'eq', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Primary speech intelligibility mid band.' },
  { id: 'eqPresence', label: 'EQ Presence', category: 'eq', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Presence / consonant clarity.' },
  { id: 'eqClarity', label: 'EQ Clarity', category: 'eq', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Upper presence / sibilance region balance.' },
  { id: 'eqAir', label: 'EQ Air', category: 'eq', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'High-shelf air / brilliance.' },
  { id: 'eqBrill', label: 'EQ Brilliance', category: 'eq', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Extreme high-shelf polish.' },

  // ── Dynamics ──────────────────────────────────────────────────────────
  { id: 'compThresh', label: 'Comp Threshold', category: 'dynamics', min: -60, max: 0, default: -24, step: 1, unit: 'dB', rt: true, path: 'audioParam', effect: 'Compressor onset level.' },
  { id: 'compRatio', label: 'Comp Ratio', category: 'dynamics', min: 1, max: 20, default: 4, step: 0.1, unit: ':1', rt: true, path: 'audioParam', effect: 'Compression ratio above threshold.' },
  { id: 'compAttack', label: 'Comp Attack', category: 'dynamics', min: 0, max: 100, default: 10, step: 1, unit: 'ms', rt: true, path: 'audioParam', effect: 'Compressor attack time.' },
  { id: 'compRelease', label: 'Comp Release', category: 'dynamics', min: 20, max: 1000, default: 150, step: 10, unit: 'ms', rt: true, path: 'audioParam', effect: 'Compressor release time.' },
  { id: 'compKnee', label: 'Comp Knee', category: 'dynamics', min: 0, max: 40, default: 6, step: 1, unit: 'dB', rt: true, path: 'audioParam', effect: 'Soft-knee width.' },
  { id: 'compMakeup', label: 'Makeup Gain', category: 'dynamics', min: 0, max: 24, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Post-compressor makeup.' },
  { id: 'limThresh', label: 'Limiter Threshold', category: 'dynamics', min: -12, max: 0, default: -1, step: 0.1, unit: 'dB', rt: true, path: 'audioParam', effect: 'Brickwall limiter ceiling.' },
  { id: 'limRelease', label: 'Limiter Release', category: 'dynamics', min: 10, max: 500, default: 50, step: 5, unit: 'ms', rt: true, path: 'audioParam', effect: 'Limiter recovery time.' },

  // ── Filters ───────────────────────────────────────────────────────────
  { id: 'hpFreq', label: 'Highpass', category: 'filter', min: 20, max: 500, default: 80, step: 1, unit: 'Hz', rt: true, path: 'audioParam', effect: 'Removes rumble / subsonic energy below cutoff.' },
  { id: 'hpQ', label: 'HP Q', category: 'filter', min: 0.1, max: 4, default: 0.7, step: 0.05, unit: '', rt: true, path: 'audioParam', effect: 'Highpass resonance / slope character.' },
  { id: 'lpFreq', label: 'Lowpass', category: 'filter', min: 2000, max: 20000, default: 16000, step: 10, unit: 'Hz', rt: true, path: 'audioParam', effect: 'Removes hiss / extreme highs above cutoff.' },
  { id: 'lpQ', label: 'LP Q', category: 'filter', min: 0.1, max: 4, default: 0.7, step: 0.05, unit: '', rt: true, path: 'audioParam', effect: 'Lowpass resonance.' },

  // ── De-esser ──────────────────────────────────────────────────────────
  { id: 'deEssFreq', label: 'De-Ess Freq', category: 'deess', min: 2000, max: 12000, default: 6000, step: 50, unit: 'Hz', rt: true, path: 'audioParam', effect: 'Sibilance detection band center.', workletParam: 'frequency' },
  { id: 'deEssAmt', label: 'De-Ess Amount', category: 'deess', min: 0, max: 30, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Sibilance reduction depth (legacy dB scale mapped to worklet 0–1).', workletParam: 'amount' },

  // ── Spectral offline ──────────────────────────────────────────────────
  { id: 'specTilt', label: 'Spectral Tilt', category: 'nr', min: -6, max: 6, default: 0, step: 0.1, unit: 'dB', rt: true, path: 'audioParam', effect: 'Brighten (+) or darken (−) around 1 kHz pivot on the live bus.' },
  { id: 'formantShift', label: 'Formant Shift', category: 'isolation', min: -12, max: 12, default: 0, step: 0.5, unit: 'st', rt: false, path: 'offlineOnly', effect: 'Offline formant relocation (semitones). Use sparingly.' },
  { id: 'derevAmt', label: 'Dereverb Amount', category: 'nr', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Spectral tail subtraction strength.' },
  { id: 'derevDecay', label: 'Dereverb Decay', category: 'nr', min: 0, max: 100, default: 40, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Assumed RT60 scale for tail model.' },
  { id: 'harmRecov', label: 'Harmonic Recovery', category: 'isolation', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Boosts harmonic structure of voiced speech after isolation.' },
  { id: 'harmOrder', label: 'Harmonic Order', category: 'isolation', min: 1, max: 8, default: 3, step: 1, unit: '', rt: false, path: 'offlineOnly', effect: 'Number of harmonics reinforced by recovery.' },

  // ── Spatial ───────────────────────────────────────────────────────────
  { id: 'stereoWidth', label: 'Stereo Width', category: 'spatial', min: 0, max: 200, default: 100, step: 1, unit: '%', rt: true, path: 'audioParam', effect: 'Mid/side width of the live mix.' },
  { id: 'phaseCorr', label: 'Phase Correction', category: 'spatial', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Offline inter-channel phase alignment.' },

  // ── Isolation ─────────────────────────────────────────────────────────
  { id: 'voiceIso', label: 'Voice Isolation', category: 'isolation', min: 0, max: 100, default: 80, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'How strongly non-voice residual is suppressed in offline path.' },
  { id: 'bgSuppress', label: 'Background Suppress', category: 'isolation', min: 0, max: 100, default: 55, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Companion background ducking depth.' },
  { id: 'voiceFocusLo', label: 'Voice Focus Lo', category: 'isolation', min: 40, max: 400, default: 120, step: 1, unit: 'Hz', rt: false, path: 'offlineOnly', effect: 'Lower edge of offline voice focus band.' },
  { id: 'voiceFocusHi', label: 'Voice Focus Hi', category: 'isolation', min: 2000, max: 10000, default: 4000, step: 10, unit: 'Hz', rt: false, path: 'offlineOnly', effect: 'Upper edge of offline voice focus band.' },
  { id: 'crosstalkCancel', label: 'Crosstalk Cancel', category: 'isolation', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Stereo channel bleed reduction (skipped on mid-only path).' },

  // ── Output ────────────────────────────────────────────────────────────
  { id: 'outGain', label: 'Output Gain', category: 'output', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Post-chain trim.' },
  { id: 'dryWet', label: 'Dry/Wet', category: 'output', min: 0, max: 100, default: 100, step: 1, unit: '%', rt: true, path: 'audioParam', effect: 'Blend unprocessed vs processed bus.' },
  { id: 'ditherAmt', label: 'Dither', category: 'output', min: 0, max: 2, default: 1, step: 1, unit: '', rt: false, path: 'offlineOnly', effect: 'Export dither intensity for 16-bit targets.' },
  { id: 'outWidth', label: 'Out Width', category: 'output', min: 0, max: 200, default: 100, step: 1, unit: '%', rt: true, path: 'audioParam', effect: 'Final stereo width scale.' },

  // ── Whisper / extreme ─────────────────────────────────────────────────
  { id: 'whisperLift', label: 'Whisper Lift', category: 'whisper', min: 0, max: 40, default: 0, step: 1, unit: 'dB', rt: true, path: 'portMessage', effect: 'Post-mask gain where voice confidence is high. Raise for buried whispers.' },
  { id: 'crowdNull', label: 'Crowd Null', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Targets 200–2500 Hz crowd murmur (extreme path).' },
  { id: 'bassCrush', label: 'Bass Crush', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: true, path: 'portMessage', effect: 'Attenuates sub/kick that mask whisper formants.' },
  { id: 'reverbStrip', label: 'Reverb Strip', category: 'whisper', min: 0, max: 2000, default: 0, step: 10, unit: 'ms', rt: false, path: 'offlineOnly', effect: 'Extreme RT60-style spectral dereverb.' },
  { id: 'voiceTunnel', label: 'Voice Tunnel', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: true, path: 'portMessage', effect: 'Narrow formant-band emphasis for intelligibility.' },
  { id: 'musicKill', label: 'Music Kill', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Suppresses steady harmonic music under speech.' },
  { id: 'snrFloor', label: 'SNR Floor', category: 'whisper', min: -80, max: -20, default: -52, step: 1, unit: 'dBFS', rt: false, path: 'offlineOnly', effect: 'Bins below this power treated as noise-only in extreme isolation.' },
  { id: 'whisperMode', label: 'Whisper Mode', category: 'whisper', min: 0, max: 3, default: 0, step: 1, unit: '', rt: false, path: 'offlineOnly', effect: '0=Off, 1=Light, 2=Heavy, 3=Forensic multi-pass aggression.' },
  { id: 'whisperClarity', label: 'Whisper Clarity', category: 'whisper', min: 0, max: 100, default: 65, step: 1, unit: '%', rt: true, path: 'portMessage', effect: 'Minimum gain floor / clarity for WhisperHunter.' },
  { id: 'whisperSensitivity', label: 'Whisper Sensitivity', category: 'whisper', min: 0, max: 100, default: 55, step: 1, unit: '%', rt: true, path: 'portMessage', effect: 'VAD energy sensitivity for quiet speech.' },
  { id: 'whisperThreshold', label: 'Whisper Threshold', category: 'whisper', min: 0, max: 100, default: 50, step: 1, unit: '%', rt: true, path: 'portMessage', effect: 'Suppression curve steepness for WhisperHunter.' },
  { id: 'transientShaper', label: 'Transient Shaper', category: 'whisper', min: -100, max: 100, default: 0, step: 5, unit: '', rt: true, path: 'portMessage', effect: 'Bipolar consonant transient emphasis.' },
  { id: 'breathControl', label: 'Breath Control', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Attenuates breath noise between phrases.' },
  { id: 'roomCorrection', label: 'Room Correction', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Adds to dereverb for room tails.' },
  { id: 'subHarmonic', label: 'Sub Harmonic', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: true, path: 'portMessage', effect: 'Restores low-frequency body under thin whispers.' },
]);

/** @type {ReadonlyMap<string, ParamSpec>} */
export const PARAMETER_BY_ID = Object.freeze(
  new Map(PARAMETER_SCHEMA.map((p) => [p.id, p]))
);

/**
 * @param {string} id
 * @returns {ParamSpec|undefined}
 */
export function getParamSpec(id) {
  return PARAMETER_BY_ID.get(id);
}

/**
 * @param {ParamCategory} category
 * @returns {ParamSpec[]}
 */
export function paramsByCategory(category) {
  return PARAMETER_SCHEMA.filter((p) => p.category === category);
}

/** Real-time Live-Mix eligible parameter ids. */
export function realtimeParamIds() {
  return PARAMETER_SCHEMA.filter((p) => p.rt).map((p) => p.id);
}

/**
 * Clamp a value to the schema range for an id.
 * @param {string} id
 * @param {number} value
 * @returns {number}
 */
export function clampParam(id, value) {
  const spec = PARAMETER_BY_ID.get(id);
  const v = Number(value);
  if (!spec || !Number.isFinite(v)) return spec ? spec.default : 0;
  return Math.min(spec.max, Math.max(spec.min, v));
}

/**
 * Snapshot current params for research export.
 * @param {Record<string, number>} values
 * @returns {object}
 */
export function snapshotParams(values = {}) {
  const out = {};
  for (const spec of PARAMETER_SCHEMA) {
    const raw = values[spec.id];
    out[spec.id] = Number.isFinite(Number(raw)) ? Number(raw) : spec.default;
  }
  return out;
}

export default {
  PARAMETER_SCHEMA,
  PARAMETER_BY_ID,
  getParamSpec,
  paramsByCategory,
  realtimeParamIds,
  clampParam,
  snapshotParams,
};

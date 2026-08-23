/**
 * VoiceIsolate Pro — Typed Engineer Parameter Schema (Layer 1: Core)
 *
 * Maps Engineer Mode slider IDs to DSP / ML roles for UI tooltips, research
 * export, and preset validation. Pure data — no DOM, no Web Audio.
 *
 * rt:true  → may drive PlaybackMixer / worklet AudioParams during Live-Mix.
 * rt:false → Process-time or export-only work. Process-time controls are sent
 *            as one immutable snapshot to the ML worker; they never re-run ML
 *            while a user drags a slider.
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
  { id: 'gateThresh', label: 'Gate Threshold', category: 'gate', min: -120, max: 0, default: -42, step: 5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Level below which the gate closes. Raise to cut more residual noise between phrases; lower to preserve quiet speech.', workletParam: 'threshold' },
  { id: 'gateRange', label: 'Gate Range', category: 'gate', min: -120, max: 0, default: -60, step: 5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Attenuation depth when the gate is closed (UI negative dB; mixer uses positive depth).', workletParam: 'range' },
  { id: 'gateAttack', label: 'Gate Attack', category: 'gate', min: 0, max: 100, default: 5, step: 5, unit: 'ms', rt: true, path: 'audioParam', effect: 'How fast the gate opens when speech exceeds threshold.', workletParam: 'attack' },
  { id: 'gateRelease', label: 'Gate Release', category: 'gate', min: 10, max: 2000, default: 200, step: 50, unit: 'ms', rt: true, path: 'audioParam', effect: 'How fast the gate closes after speech falls below threshold.', workletParam: 'release' },
  { id: 'gateHold', label: 'Gate Hold', category: 'gate', min: 0, max: 500, default: 20, step: 25, unit: 'ms', rt: true, path: 'audioParam', effect: 'Minimum open time to reduce chattering on breathy speech.', workletParam: 'hold' },
  { id: 'gateLookahead', label: 'Gate Lookahead', category: 'gate', min: 0, max: 20, default: 2, step: 1, unit: 'ms', rt: true, path: 'audioParam', effect: 'Playback gate anticipatory delay. Adds up to 20 ms of Live-Mix latency so plosives open cleanly.', workletParam: 'lookahead' },

  // ── Noise reduction (offline spectral) ────────────────────────────────
  { id: 'nrAmount', label: 'NR Amount', category: 'nr', min: 0, max: 100, default: 52, step: 5, unit: '%', rt: false, path: 'offlineOnly', effect: 'Process-time spectral noise reduction strength. Higher = cleaner but more artifacts; press Process to apply.' },
  { id: 'nrSensitivity', label: 'NR Sensitivity', category: 'nr', min: 0, max: 100, default: 48, step: 5, unit: '%', rt: false, path: 'offlineOnly', effect: 'How aggressively noise PSD is tracked vs speech.' },
  { id: 'nrSpectralSub', label: 'Spectral Subtraction', category: 'nr', min: 0, max: 100, default: 35, step: 5, unit: '%', rt: false, path: 'offlineOnly', effect: 'Oversubtraction factor for steady-state noise.' },
  { id: 'nrFloor', label: 'NR Floor', category: 'nr', min: -120, max: -20, default: -68, step: 5, unit: 'dB', rt: false, path: 'offlineOnly', effect: 'Minimum residual noise floor after NR.' },
  { id: 'nrSmoothing', label: 'NR Smoothing', category: 'nr', min: 0, max: 100, default: 32, step: 5, unit: '%', rt: false, path: 'offlineOnly', effect: 'Temporal smoothing of spectral gain to reduce musical noise.' },

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
  { id: 'compRatio', label: 'Comp Ratio', category: 'dynamics', min: 1, max: 20, default: 4, step: 0.5, unit: ':1', rt: true, path: 'audioParam', effect: 'Compression ratio above threshold.' },
  { id: 'compAttack', label: 'Comp Attack', category: 'dynamics', min: 0.1, max: 200, default: 10, step: 5, unit: 'ms', rt: true, path: 'audioParam', effect: 'Compressor attack time.' },
  { id: 'compRelease', label: 'Comp Release', category: 'dynamics', min: 10, max: 2000, default: 150, step: 50, unit: 'ms', rt: true, path: 'audioParam', effect: 'Compressor release time.' },
  { id: 'compKnee', label: 'Comp Knee', category: 'dynamics', min: 0, max: 24, default: 6, step: 1, unit: 'dB', rt: true, path: 'audioParam', effect: 'Soft-knee width.' },
  { id: 'compMakeup', label: 'Makeup Gain', category: 'dynamics', min: -12, max: 24, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Post-compressor makeup.' },
  { id: 'limThresh', label: 'Limiter Threshold', category: 'dynamics', min: -24, max: 0, default: -1, step: 1, unit: 'dB', rt: true, path: 'audioParam', effect: 'Brickwall limiter ceiling.' },
  { id: 'limRelease', label: 'Limiter Release', category: 'dynamics', min: 1, max: 500, default: 50, step: 10, unit: 'ms', rt: true, path: 'audioParam', effect: 'Limiter recovery time.' },

  // ── Filters ───────────────────────────────────────────────────────────
  { id: 'hpFreq', label: 'Highpass', category: 'filter', min: 10, max: 1000, default: 80, step: 10, unit: 'Hz', rt: true, path: 'audioParam', effect: 'Removes rumble / subsonic energy below cutoff.' },
  { id: 'hpQ', label: 'HP Q', category: 'filter', min: 0.5, max: 10, default: 0.707, step: 0.5, unit: '', rt: true, path: 'audioParam', effect: 'Highpass resonance / slope character.' },
  { id: 'lpFreq', label: 'Lowpass', category: 'filter', min: 1000, max: 20000, default: 14000, step: 500, unit: 'Hz', rt: true, path: 'audioParam', effect: 'Removes hiss / extreme highs above cutoff.' },
  { id: 'lpQ', label: 'LP Q', category: 'filter', min: 0.5, max: 10, default: 0.707, step: 0.5, unit: '', rt: true, path: 'audioParam', effect: 'Lowpass resonance.' },

  // ── De-esser ──────────────────────────────────────────────────────────
  { id: 'deEssFreq', label: 'De-Ess Freq', category: 'deess', min: 2000, max: 16000, default: 6500, step: 500, unit: 'Hz', rt: true, path: 'audioParam', effect: 'Sibilance detection band center.', workletParam: 'frequency' },
  { id: 'deEssAmt', label: 'De-Ess Amount', category: 'deess', min: 0, max: 24, default: 5, step: 1, unit: 'dB', rt: true, path: 'audioParam', effect: 'Sibilance reduction depth (legacy dB scale mapped to worklet 0–1).', workletParam: 'amount' },

  // ── Spectral offline ──────────────────────────────────────────────────
  { id: 'specTilt', label: 'Spectral Tilt', category: 'nr', min: -12, max: 12, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Brighten (+) or darken (−) around 1 kHz pivot on the live bus.' },
  { id: 'formantShift', label: 'Formant Shift', category: 'isolation', min: -12, max: 12, default: 0, step: 1, unit: 'st', rt: false, path: 'offlineOnly', effect: 'Offline formant relocation (semitones). Use sparingly.' },
  { id: 'derevAmt', label: 'Dereverb Amount', category: 'nr', min: 0, max: 100, default: 0, step: 5, unit: '%', rt: false, path: 'offlineOnly', effect: 'Spectral tail subtraction strength.' },
  { id: 'derevDecay', label: 'Dereverb Decay', category: 'nr', min: 0, max: 100, default: 30, step: 5, unit: '%', rt: false, path: 'offlineOnly', effect: 'Assumed RT60 scale for tail model.' },
  { id: 'harmRecov', label: 'Harmonic Recovery', category: 'isolation', min: 0, max: 100, default: 0, step: 5, unit: '%', rt: false, path: 'offlineOnly', effect: 'Boosts harmonic structure of voiced speech after isolation.' },
  { id: 'harmOrder', label: 'Harmonic Order', category: 'isolation', min: 1, max: 8, default: 3, step: 1, unit: '', rt: false, path: 'offlineOnly', effect: 'Number of harmonics reinforced by recovery.' },

  // ── Spatial ───────────────────────────────────────────────────────────
  { id: 'stereoWidth', label: 'Stereo Width', category: 'spatial', min: 0, max: 200, default: 100, step: 10, unit: '%', rt: true, path: 'audioParam', effect: 'Mid/side width of the live mix.' },
  { id: 'phaseCorr', label: 'Mono Correlation', category: 'spatial', min: 0, max: 100, default: 0, step: 5, unit: '%', rt: false, path: 'offlineOnly', effect: 'Process-time stereo midpoint blend for a more mono-stable result; it does not estimate a channel delay.' },

  // ── Isolation ─────────────────────────────────────────────────────────
  { id: 'voiceIso', label: 'Voice Isolation', category: 'isolation', min: 0, max: 100, default: 72, step: 5, unit: '%', rt: true, path: 'audioParam', effect: 'Live-Mix clean-stem balance after a single ML separation.' },
  { id: 'bgSuppress', label: 'Background Suppress', category: 'isolation', min: 0, max: 100, default: 38, step: 5, unit: '%', rt: true, path: 'audioParam', effect: 'Live-Mix residual/noise-stem attenuation after a single ML separation.' },
  { id: 'voiceFocusLo', label: 'Voice Focus Lo', category: 'isolation', min: 50, max: 1000, default: 100, step: 25, unit: 'Hz', rt: false, path: 'offlineOnly', effect: 'Lower edge of offline voice focus band.' },
  { id: 'voiceFocusHi', label: 'Voice Focus Hi', category: 'isolation', min: 1000, max: 16000, default: 4500, step: 500, unit: 'Hz', rt: false, path: 'offlineOnly', effect: 'Upper edge of offline voice focus band.' },
  { id: 'crosstalkCancel', label: 'Crosstalk Cancel', category: 'isolation', min: 0, max: 100, default: 0, step: 5, unit: '%', rt: false, path: 'offlineOnly', effect: 'Stereo channel bleed reduction (skipped on mid-only path).' },

  // ── Output ────────────────────────────────────────────────────────────
  { id: 'outGain', label: 'Output Gain', category: 'output', min: -24, max: 12, default: 0, step: 0.5, unit: 'dB', rt: true, path: 'audioParam', effect: 'Post-chain trim.' },
  { id: 'dryWet', label: 'Dry/Wet', category: 'output', min: 0, max: 100, default: 100, step: 5, unit: '%', rt: true, path: 'audioParam', effect: 'Blend unprocessed vs processed bus.' },
  { id: 'ditherAmt', label: 'Dither', category: 'output', min: 0, max: 3, default: 0, step: 1, unit: '', rt: false, path: 'offlineOnly', effect: 'Export dither intensity for 16-bit targets.' },
  { id: 'outWidth', label: 'Out Width', category: 'output', min: 0, max: 200, default: 100, step: 10, unit: '%', rt: true, path: 'audioParam', effect: 'Final stereo width scale.' },

  // ── Whisper / extreme ─────────────────────────────────────────────────
  { id: 'whisperLift', label: 'Whisper Lift', category: 'whisper', min: 0, max: 40, default: 0, step: 1, unit: 'dB', rt: false, path: 'offlineOnly', effect: 'Process-time post-mask lift for high-confidence voice bins. The 0–40 dB display maps continuously to a bounded 0–12 dB internal gain.' },
  { id: 'crowdNull', label: 'Crowd Null', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Targets 200–2500 Hz crowd murmur (extreme path).' },
  { id: 'bassCrush', label: 'Bass Crush', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Process-time attenuation of sub/kick that masks whisper formants.' },
  { id: 'reverbStrip', label: 'Reverb Strip', category: 'whisper', min: 0, max: 2000, default: 0, step: 10, unit: 'ms', rt: false, path: 'offlineOnly', effect: 'Extreme RT60-style spectral dereverb.' },
  { id: 'voiceTunnel', label: 'Voice Tunnel', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Process-time narrow formant-band emphasis for intelligibility.' },
  { id: 'musicKill', label: 'Music Kill', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Suppresses steady harmonic music under speech.' },
  { id: 'snrFloor', label: 'SNR Floor', category: 'whisper', min: -80, max: -20, default: -52, step: 1, unit: 'dBFS', rt: false, path: 'offlineOnly', effect: 'Bins below this power treated as noise-only in extreme isolation.' },
  { id: 'whisperMode', label: 'Whisper Mode', category: 'whisper', min: 0, max: 3, default: 0, step: 1, unit: '', rt: false, path: 'offlineOnly', effect: '0=Off, 1=Light, 2=Heavy, 3=Forensic multi-pass aggression.' },
  { id: 'whisperClarity', label: 'Whisper Clarity', category: 'whisper', min: 0, max: 100, default: 65, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Process-time minimum gain floor / clarity for WhisperHunter.' },
  { id: 'whisperSensitivity', label: 'Whisper Sensitivity', category: 'whisper', min: 0, max: 100, default: 55, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Process-time VAD energy sensitivity for quiet speech.' },
  { id: 'whisperThreshold', label: 'Whisper Threshold', category: 'whisper', min: 0, max: 100, default: 50, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Process-time suppression curve steepness for WhisperHunter.' },
  { id: 'transientShaper', label: 'Transient Shaper', category: 'whisper', min: -100, max: 100, default: 0, step: 5, unit: '', rt: false, path: 'offlineOnly', effect: 'Process-time bipolar consonant transient emphasis.' },
  { id: 'breathControl', label: 'Breath Control', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Attenuates breath noise between phrases.' },
  { id: 'roomCorrection', label: 'Room Correction', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Adds to dereverb for room tails.' },
  { id: 'subHarmonic', label: 'Sub Harmonic', category: 'whisper', min: 0, max: 100, default: 0, step: 1, unit: '%', rt: false, path: 'offlineOnly', effect: 'Restores low-frequency body under thin whispers during Process.' },
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

/** Versioned contract for the Process-time ML worker message. */
export const ML_PROCESSING_CONFIG_VERSION = 1;

/** Controls consumed inside MLWorker's existing fused STFT/iSTFT cycle. */
export const ML_SPECTRAL_PARAM_IDS = Object.freeze([
  'nrAmount', 'nrSensitivity', 'nrSpectralSub', 'nrFloor', 'nrSmoothing',
  'formantShift', 'derevAmt', 'derevDecay', 'harmRecov', 'harmOrder',
  'voiceFocusLo', 'voiceFocusHi',
  'whisperLift', 'crowdNull', 'bassCrush', 'reverbStrip', 'voiceTunnel',
  'musicKill', 'snrFloor', 'whisperMode', 'whisperClarity',
  'whisperSensitivity', 'whisperThreshold', 'transientShaper',
  'breathControl', 'roomCorrection', 'subHarmonic',
]);

/** Stereo-only controls applied after stem expansion without another STFT. */
export const ML_POST_STEM_PARAM_IDS = Object.freeze([
  'phaseCorr', 'crosstalkCancel',
]);

/** Controls that deliberately act only while encoding a lossy integer export. */
export const EXPORT_PARAM_IDS = Object.freeze(['ditherAmt']);

/** PlaybackMixer / active worklet controls. Keep in parity with EngineerModeBridge. */
export const LIVE_MIX_PARAM_IDS = Object.freeze([
  'gateThresh', 'gateRange', 'gateAttack', 'gateRelease', 'gateHold', 'gateLookahead',
  'eqSub', 'eqBass', 'eqWarmth', 'eqBody', 'eqLowMid', 'eqMid', 'eqPresence', 'eqClarity', 'eqAir', 'eqBrill',
  'compThresh', 'compRatio', 'compAttack', 'compRelease', 'compKnee', 'compMakeup',
  'limThresh', 'limRelease',
  'hpFreq', 'hpQ', 'lpFreq', 'lpQ', 'deEssFreq', 'deEssAmt',
  'specTilt', 'outGain', 'dryWet', 'outWidth', 'stereoWidth',
  'voiceIso', 'bgSuppress',
]);

function valueForConfig(id, values) {
  const spec = PARAMETER_BY_ID.get(id);
  if (!spec) return 0;
  const value = Number(values?.[id]);
  if (!Number.isFinite(value)) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, value));
}

/**
 * Stable, non-cryptographic configuration fingerprint for result caches and
 * worker telemetry. It intentionally covers only controls that alter rendered
 * stems, not Live-Mix or export-only controls.
 * @param {Record<string, number>} groups
 * @returns {string}
 */
function processingRevision(groups) {
  const parts = [];
  for (const [group, values] of Object.entries(groups)) {
    for (const key of Object.keys(values).sort()) parts.push(`${group}.${key}=${values[key]}`);
  }
  let hash = 2166136261;
  const text = parts.join('|');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `emc${ML_PROCESSING_CONFIG_VERSION}-${(hash >>> 0).toString(36)}`;
}

/**
 * Build the immutable, finite-only Process-time snapshot sent to MLWorker.
 * The caller should supply calibrated effective values. Slider events never
 * call this worker directly; the snapshot is taken only when Process starts.
 *
 * @param {Record<string, number>} [values]
 */
export function buildMlProcessingConfig(values = {}) {
  const spectral = {};
  const postStem = {};
  const liveOnly = {};
  const exportConfig = {};
  for (const id of ML_SPECTRAL_PARAM_IDS) spectral[id] = valueForConfig(id, values);
  for (const id of ML_POST_STEM_PARAM_IDS) postStem[id] = valueForConfig(id, values);
  for (const id of EXPORT_PARAM_IDS) exportConfig[id] = valueForConfig(id, values);
  // These are carried for telemetry and a single canonical snapshot, but do
  // not alter the ML stem cache because their consumers are non-ML.
  for (const id of ['gateLookahead', 'voiceIso', 'bgSuppress']) {
    liveOnly[id] = valueForConfig(id, values);
  }
  const revision = processingRevision({ spectral, postStem });
  return Object.freeze({
    version: ML_PROCESSING_CONFIG_VERSION,
    revision,
    spectral: Object.freeze(spectral),
    postStem: Object.freeze(postStem),
    liveOnly: Object.freeze(liveOnly),
    export: Object.freeze(exportConfig),
  });
}

export default {
  PARAMETER_SCHEMA,
  PARAMETER_BY_ID,
  getParamSpec,
  paramsByCategory,
  realtimeParamIds,
  clampParam,
  snapshotParams,
  buildMlProcessingConfig,
};

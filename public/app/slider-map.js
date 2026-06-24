/**
 * VoiceIsolate Pro — Slider Registry (canonical source of truth)
 *
 * Every slider in Engineer Mode is declared here.  The HTML DOM, app.js
 * event wiring, and EngineerModeBridge all derive from this registry.
 *
 * Fields:
 *   id       – unique DOM id (also the key in VIP_PARAMS)
 *   label    – human-readable label shown next to the slider
 *   min      – minimum value
 *   max      – maximum value
 *   step     – increment step
 *   default  – factory-default value
 *   unit     – display unit suffix (dB, Hz, ms, %, x, s, LUFS)
 *   rt       – true  → slider value is pushed live to AudioParam via EngineerModeBridge
 *              false → stored in VIP_PARAMS for offline / re-render pipeline only
 *
 * Maintenance freeze note: do NOT refactor these entries to the new src/
 * architecture; that is a separate milestone.  Only fix factually wrong values.
 */

const SLIDER_REGISTRY = {
  /* ──────────────────────────────────────────────
   * STAGE 1 — Stem Levels  (4 sliders)
   * ────────────────────────────────────────────── */
  stemVocal:  { label: 'Vocal Level',       min: -60, max: 12,   step: 0.1, default: 0,    unit: 'dB',   rt: true  },
  stemDrums:  { label: 'Drums Level',       min: -60, max: 12,   step: 0.1, default: 0,    unit: 'dB',   rt: true  },
  stemBass:   { label: 'Bass Level',        min: -60, max: 12,   step: 0.1, default: 0,    unit: 'dB',   rt: true  },
  stemOther:  { label: 'Other Level',       min: -60, max: 12,   step: 0.1, default: 0,    unit: 'dB',   rt: true  },

  /* ──────────────────────────────────────────────
   * STAGE 2 — Vocal EQ  (8 sliders)
   * ────────────────────────────────────────────── */
  vocalEqLowFreq:   { label: 'Low Freq',         min: 20,   max: 500,   step: 1,    default: 80,    unit: 'Hz',   rt: true  },
  vocalEqLowGain:   { label: 'Low Gain',         min: -24,  max: 24,    step: 0.1,  default: 0,     unit: 'dB',   rt: true  },
  vocalEqMidFreq:   { label: 'Mid Freq',         min: 200,  max: 8000,  step: 1,    default: 2500,  unit: 'Hz',   rt: true  },
  vocalEqMidGain:   { label: 'Mid Gain',         min: -24,  max: 24,    step: 0.1,  default: 0,     unit: 'dB',   rt: true  },
  vocalEqMidQ:      { label: 'Mid Q',            min: 0.1,  max: 18,    step: 0.1,  default: 1.0,   unit: 'x',    rt: true  },
  vocalEqHighFreq:  { label: 'High Freq',        min: 2000, max: 20000, step: 1,    default: 8000,  unit: 'Hz',   rt: true  },
  vocalEqHighGain:  { label: 'High Gain',        min: -24,  max: 24,    step: 0.1,  default: 0,     unit: 'dB',   rt: true  },
  vocalEqHighShelfQ:{ label: 'High Shelf Q',     min: 0.1,  max: 2,     step: 0.01, default: 0.707, unit: 'x',    rt: true  },

  /* ──────────────────────────────────────────────
   * STAGE 3 — Drums Processing  (6 sliders)
   * ────────────────────────────────────────────── */
  drumsEqLowGain:        { label: 'Low Gain',           min: -24, max: 24,   step: 0.1, default: 0,    unit: 'dB',  rt: true  },
  drumsEqMidFreq:        { label: 'Mid Freq',           min: 200, max: 8000, step: 1,   default: 4000, unit: 'Hz',  rt: true  },
  drumsEqMidGain:        { label: 'Mid Gain',           min: -24, max: 24,   step: 0.1, default: 0,    unit: 'dB',  rt: true  },
  drumsCompressThreshold:{ label: 'Compress Threshold', min: -60, max: 0,    step: 0.1, default: -20,  unit: 'dB',  rt: true  },
  drumsCompressRatio:    { label: 'Compress Ratio',     min: 1,   max: 20,   step: 0.1, default: 4,    unit: 'x',   rt: true  },
  drumsCompressAttack:   { label: 'Compress Attack',    min: 0.1, max: 100,  step: 0.1, default: 5,    unit: 'ms',  rt: true  },

  /* ──────────────────────────────────────────────
   * STAGE 4 — Bass Processing  (6 sliders)
   * ────────────────────────────────────────────── */
  bassEqLowFreq:        { label: 'Low Freq',           min: 20,  max: 200,  step: 1,   default: 60,   unit: 'Hz',  rt: true  },
  bassEqLowGain:        { label: 'Low Gain',           min: -24, max: 24,   step: 0.1, default: 0,    unit: 'dB',  rt: true  },
  bassEqMidFreq:        { label: 'Mid Freq',           min: 100, max: 2000, step: 1,   default: 500,  unit: 'Hz',  rt: true  },
  bassEqMidGain:        { label: 'Mid Gain',           min: -24, max: 24,   step: 0.1, default: 0,    unit: 'dB',  rt: true  },
  bassCompressThreshold:{ label: 'Compress Threshold', min: -60, max: 0,    step: 0.1, default: -24,  unit: 'dB',  rt: true  },
  bassCompressRatio:    { label: 'Compress Ratio',     min: 1,   max: 20,   step: 0.1, default: 6,    unit: 'x',   rt: true  },

  /* ──────────────────────────────────────────────
   * STAGE 5 — Other / Instrument Processing  (6 sliders)
   * ────────────────────────────────────────────── */
  otherEqMidFreq:        { label: 'Mid Freq',           min: 200,  max: 8000,  step: 1,   default: 2000,  unit: 'Hz',  rt: true  },
  otherEqMidGain:        { label: 'Mid Gain',           min: -24,  max: 24,    step: 0.1, default: 0,     unit: 'dB',  rt: true  },
  otherEqHighFreq:       { label: 'High Freq',          min: 2000, max: 20000, step: 1,   default: 10000, unit: 'Hz',  rt: true  },
  otherEqHighGain:       { label: 'High Gain',          min: -24,  max: 24,    step: 0.1, default: 0,     unit: 'dB',  rt: true  },
  otherCompressThreshold:{ label: 'Compress Threshold', min: -60,  max: 0,     step: 0.1, default: -18,   unit: 'dB',  rt: true  },
  otherCompressRatio:    { label: 'Compress Ratio',     min: 1,    max: 20,    step: 0.1, default: 3,     unit: 'x',   rt: true  },

  /* ──────────────────────────────────────────────
   * STAGE 6 — Vocal Effects  (6 sliders)
   * ────────────────────────────────────────────── */
  vocalDeessFreq:      { label: 'De-Ess Freq',      min: 2000, max: 12000, step: 1,   default: 6500, unit: 'Hz',  rt: true  },
  vocalDeessThreshold: { label: 'De-Ess Threshold',  min: -40,  max: 0,     step: 0.1, default: -20,  unit: 'dB',  rt: true  },
  vocalDeessReduction: { label: 'De-Ess Reduction',  min: 0,    max: 24,    step: 0.1, default: 6,    unit: 'dB',  rt: true  },
  vocalReverbMix:      { label: 'Reverb Mix',        min: 0,    max: 100,   step: 1,   default: 15,   unit: '%',   rt: true  },
  vocalReverbDecay:    { label: 'Reverb Decay',      min: 0.1,  max: 10,    step: 0.1, default: 1.5,  unit: 's',   rt: true  },
  vocalReverbPreDelay: { label: 'Reverb Pre-Delay',  min: 0,    max: 200,   step: 1,   default: 20,   unit: 'ms',  rt: true  },

  /* ──────────────────────────────────────────────
   * STAGE 7 — Master Channel  (8 sliders)
   * ────────────────────────────────────────────── */
  masterGain:           { label: 'Master Gain',        min: -60,  max: 12,    step: 0.1, default: 0,    unit: 'dB',   rt: true  },
  masterPan:            { label: 'Master Pan',         min: -1,   max: 1,     step: 0.01,default: 0,    unit: 'x',    rt: true  },
  masterStereoWidth:    { label: 'Stereo Width',       min: 0,    max: 200,   step: 1,   default: 100,  unit: '%',    rt: true  },
  masterLimiterThreshold:{ label: 'Limiter Threshold',  min: -60,  max: 0,     step: 0.1, default: -1,   unit: 'dB',   rt: true  },
  masterLimiterCeiling: { label: 'Limiter Ceiling',    min: -60,  max: 0,     step: 0.1, default: -0.3, unit: 'dB',   rt: true  },
  masterLimiterRelease: { label: 'Limiter Release',    min: 10,   max: 1000,  step: 1,   default: 50,   unit: 'ms',   rt: true  },
  masterLoudness:       { label: 'Loudness Target',    min: -40,  max: 0,     step: 0.1, default: -14,  unit: 'LUFS', rt: false },
  masterDither:         { label: 'Dither Amount',      min: 0,    max: 100,   step: 1,   default: 50,   unit: '%',    rt: false },

  /* ──────────────────────────────────────────────
   * STAGE 8 — Delay Effects  (4 sliders)
   * ────────────────────────────────────────────── */
  delayTime:    { label: 'Delay Time',    min: 10,   max: 2000, step: 1,   default: 375,  unit: 'ms',  rt: true  },
  delayFeedback:{ label: 'Delay Feedback', min: 0,    max: 95,   step: 0.1, default: 30,   unit: '%',   rt: true  },
  delayMix:     { label: 'Delay Mix',     min: 0,    max: 100,  step: 1,   default: 10,   unit: '%',   rt: true  },
  delayFilter:  { label: 'Delay Filter',  min: 200,  max: 16000,step: 1,   default: 4000, unit: 'Hz',  rt: true  },

  /* ──────────────────────────────────────────────
   * STAGE 9 — Noise Gate  (4 sliders)
   * ────────────────────────────────────────────── */
  gateThreshold:{ label: 'Gate Threshold', min: -80,  max: 0,   step: 0.1, default: -50,  unit: 'dB',  rt: true  },
  gateAttack:   { label: 'Gate Attack',    min: 0.1,  max: 50,  step: 0.1, default: 1,    unit: 'ms',  rt: true  },
  gateRelease:  { label: 'Gate Release',   min: 10,   max: 1000,step: 1,   default: 100,  unit: 'ms',  rt: true  },
  gateHold:     { label: 'Gate Hold',      min: 0,    max: 500, step: 1,   default: 50,   unit: 'ms',  rt: true  },
};

/**
 * STAGES defines the grouping / accordion order.
 * Each entry references a set of slider IDs and provides a human-readable
 * group title and a FontAwesome icon class for the header.
 */
const STAGES = [
  {
    id: 'stage-stem-levels',
    title: 'Stem Levels',
    icon: 'fa-layer-group',
    sliders: ['stemVocal', 'stemDrums', 'stemBass', 'stemOther'],
  },
  {
    id: 'stage-vocal-eq',
    title: 'Vocal EQ',
    icon: 'fa-sliders-h',
    sliders: [
      'vocalEqLowFreq', 'vocalEqLowGain',
      'vocalEqMidFreq', 'vocalEqMidGain', 'vocalEqMidQ',
      'vocalEqHighFreq', 'vocalEqHighGain', 'vocalEqHighShelfQ',
    ],
  },
  {
    id: 'stage-drums-processing',
    title: 'Drums Processing',
    icon: 'fa-drum',
    sliders: [
      'drumsEqLowGain', 'drumsEqMidFreq', 'drumsEqMidGain',
      'drumsCompressThreshold', 'drumsCompressRatio', 'drumsCompressAttack',
    ],
  },
  {
    id: 'stage-bass-processing',
    title: 'Bass Processing',
    icon: 'fa-wave-square',
    sliders: [
      'bassEqLowFreq', 'bassEqLowGain',
      'bassEqMidFreq', 'bassEqMidGain',
      'bassCompressThreshold', 'bassCompressRatio',
    ],
  },
  {
    id: 'stage-other-processing',
    title: 'Other / Instrument Processing',
    icon: 'fa-guitar',
    sliders: [
      'otherEqMidFreq', 'otherEqMidGain',
      'otherEqHighFreq', 'otherEqHighGain',
      'otherCompressThreshold', 'otherCompressRatio',
    ],
  },
  {
    id: 'stage-vocal-effects',
    title: 'Vocal Effects',
    icon: 'fa-microphone',
    sliders: [
      'vocalDeessFreq', 'vocalDeessThreshold', 'vocalDeessReduction',
      'vocalReverbMix', 'vocalReverbDecay', 'vocalReverbPreDelay',
    ],
  },
  {
    id: 'stage-master-channel',
    title: 'Master Channel',
    icon: 'fa-volume-high',
    sliders: [
      'masterGain', 'masterPan', 'masterStereoWidth',
      'masterLimiterThreshold', 'masterLimiterCeiling', 'masterLimiterRelease',
      'masterLoudness', 'masterDither',
    ],
  },
  {
    id: 'stage-delay-effects',
    title: 'Delay Effects',
    icon: 'fa-clock',
    sliders: ['delayTime', 'delayFeedback', 'delayMix', 'delayFilter'],
  },
  {
    id: 'stage-noise-gate',
    title: 'Noise Gate',
    icon: 'fa-shield-halved',
    sliders: ['gateThreshold', 'gateAttack', 'gateRelease', 'gateHold'],
  },
];

/* Verify we declared exactly 52 sliders */
const REGISTRY_COUNT = Object.keys(SLIDER_REGISTRY).length;
const STAGE_SLIDER_COUNT = STAGES.reduce((sum, s) => sum + s.sliders.length, 0);
if (REGISTRY_COUNT !== 52) {
  console.error(`[slider-map] SLIDER_REGISTRY has ${REGISTRY_COUNT} entries, expected 52`);
}
if (STAGE_SLIDER_COUNT !== 52) {
  console.error(`[slider-map] STAGES reference ${STAGE_SLIDER_COUNT} sliders, expected 52`);
}
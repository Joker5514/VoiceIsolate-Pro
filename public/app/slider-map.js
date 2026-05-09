/**
 * VoiceIsolate Pro — slider-map.js
 * ==============================================
 * Maps every slider ID to its DSP routing target
 * and optional transform function.
 *
 * target: 'worklet' | 'worker' | 'both' | 'local'
 *   worklet → AudioWorklet port.postMessage
 *   worker  → ml-worker postMessage
 *   both    → both
 *   local   → only updates window.VIP_PARAMS (no RT dispatch)
 *
 * key: the property name expected by the receiver
 * transform: optional function(rawSliderValue) → mapped value
 */

export const STAGES = [
  'Gate',
  'Noise Reduction',
  'HP Filter',
  'LP Filter',
  'EQ Sub',
  'EQ Bass',
  'EQ Warmth',
  'EQ Body',
  'EQ LowMid',
  'EQ Mid',
  'EQ Presence',
  'EQ Clarity',
  'EQ Air',
  'EQ Brilliance',
  'Compressor',
  'Limiter',
  'De-Esser',
  'Spectral Tilt',
  'Voice Iso (ML)',
  'BG Suppress',
  'Voice Focus',
  'Dereverb (ML)',
  'Harmonic Recovery',
  'Formant Shift',
  'Stereo Width',
  'Phase Correction',
  'Crosstalk Cancel',
  'Dither',
  'Output Gain',
  'Dry/Wet',
  'Out Width',
  'Peak Normalize',
];

/** @type {Array<{id:string, key:string, target:string, transform?:Function}>} */
export const SLIDER_REGISTRY = [
  // ── Gate ──────────────────────────────────────────────────────────────
  { id:'gateThresh',   key:'gateThresh',   target:'worklet' },
  { id:'gateRange',    key:'gateRange',    target:'worklet' },
  { id:'gateAttack',   key:'gateAttack',   target:'worklet' },
  { id:'gateRelease',  key:'gateRelease',  target:'worklet' },
  { id:'gateHold',     key:'gateHold',     target:'worklet' },
  { id:'gateLookahead',key:'gateLookahead',target:'local'   }, // non-RT

  // ── Noise Reduction (spectral, non-RT) ───────────────────────────────
  { id:'nrAmount',     key:'nrAmount',     target:'both',
    transform: v => v / 100 },                     // 0-1
  { id:'nrSensitivity',key:'nrSensitivity',target:'worker',
    transform: v => v / 100 },
  { id:'nrSpectralSub',key:'nrSpectralSub',target:'worker',
    transform: v => v / 100 },
  { id:'nrFloor',      key:'nrFloor',      target:'worker' },
  { id:'nrSmoothing',  key:'nrSmoothing',  target:'worker',
    transform: v => v / 100 },

  // ── EQ (all RT via worklet) ───────────────────────────────────────────
  { id:'eqSub',     key:'eqSub',     target:'worklet' },
  { id:'eqBass',    key:'eqBass',    target:'worklet' },
  { id:'eqWarmth',  key:'eqWarmth',  target:'worklet' },
  { id:'eqBody',    key:'eqBody',    target:'worklet' },
  { id:'eqLowMid',  key:'eqLowMid',  target:'worklet' },
  { id:'eqMid',     key:'eqMid',     target:'worklet' },
  { id:'eqPresence',key:'eqPresence',target:'worklet' },
  { id:'eqClarity', key:'eqClarity', target:'worklet' },
  { id:'eqAir',     key:'eqAir',     target:'worklet' },
  { id:'eqBrill',   key:'eqBrill',   target:'worklet' },

  // ── Dynamics ──────────────────────────────────────────────────────────
  { id:'compThresh',  key:'compThresh',  target:'worklet' },
  { id:'compRatio',   key:'compRatio',   target:'worklet' },
  { id:'compAttack',  key:'compAttack',  target:'worklet' },
  { id:'compRelease', key:'compRelease', target:'worklet' },
  { id:'compKnee',    key:'compKnee',    target:'worklet' },
  { id:'compMakeup',  key:'compMakeup',  target:'worklet' },
  { id:'limThresh',   key:'limThresh',   target:'worklet' },
  { id:'limRelease',  key:'limRelease',  target:'worklet' },

  // ── Spectral ──────────────────────────────────────────────────────────
  { id:'hpFreq',      key:'hpFreq',      target:'worklet' },
  { id:'hpQ',         key:'hpQ',         target:'worklet' },
  { id:'lpFreq',      key:'lpFreq',      target:'worklet' },
  { id:'lpQ',         key:'lpQ',         target:'worklet' },
  { id:'deEssFreq',   key:'deEssFreq',   target:'worklet' },
  { id:'deEssAmt',    key:'deEssAmt',    target:'worklet' },
  { id:'specTilt',    key:'specTilt',    target:'worklet' },
  { id:'formantShift',key:'formantShift',target:'worker'  }, // non-RT

  // ── Advanced / ML ─────────────────────────────────────────────────────
  { id:'derevAmt',    key:'derevAmt',    target:'worker',
    transform: v => v / 100 },
  { id:'derevDecay',  key:'derevDecay',  target:'worker',
    transform: v => v / 100 },
  { id:'harmRecov',   key:'harmRecov',   target:'worker',
    transform: v => v / 100 },
  { id:'harmOrder',   key:'harmOrder',   target:'worker' },
  { id:'stereoWidth', key:'stereoWidth', target:'worklet',
    transform: v => v / 100 },
  { id:'phaseCorr',   key:'phaseCorr',   target:'worker',
    transform: v => v / 100 },

  // ── Separation ────────────────────────────────────────────────────────
  { id:'voiceIso',       key:'voiceIso',       target:'worker',
    transform: v => v / 100 },
  { id:'bgSuppress',     key:'bgSuppress',     target:'worker',
    transform: v => v / 100 },
  { id:'voiceFocusLo',   key:'voiceFocusLo',   target:'worker' },
  { id:'voiceFocusHi',   key:'voiceFocusHi',   target:'worker' },
  { id:'crosstalkCancel',key:'crosstalkCancel',target:'worker',
    transform: v => v / 100 },

  // ── Output ────────────────────────────────────────────────────────────
  { id:'outGain',   key:'outGain',   target:'worklet' },
  { id:'dryWet',    key:'dryWet',    target:'worklet',
    transform: v => v / 100 },
  { id:'ditherAmt', key:'ditherAmt', target:'worklet' },
  { id:'outWidth',  key:'outWidth',  target:'worklet',
    transform: v => v / 100 },
];

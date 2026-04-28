/**
 * VoiceIsolate Pro — Slider Registry and Pipeline Stages
 *
 * Pure data module — no side effects, no Web Audio API calls,
 * no SharedArrayBuffer references.
 *
 * SLIDER_REGISTRY: flat array of all 52 slider descriptors that map each
 *   HTML slider element to its DSP parameter key, value transform, and
 *   dispatch target ('worklet' | 'worker' | 'both').
 *
 * STAGES: ordered array of 32 pipeline stage labels (S01–S32) matching
 *   the Deca-Pass pipeline defined in pipeline-orchestrator.js.
 */

// ── SLIDER_REGISTRY (52 entries) ─────────────────────────────────────────────
// Shape: { id, key, transform, target }
//   id        — HTML element ID (matches SLIDERS definitions in app.js)
//   key       — DSP parameter key sent to worklet / worker
//   transform — maps raw slider value → dispatch value (identity by default)
//   target    — 'worklet' (rt:true sliders) | 'worker' (rt:false sliders)

export const SLIDER_REGISTRY = [
  // ── Gate ──────────────────────────────────────────────────────────────────
  { id: 'gateThresh',      key: 'gateThresh',      transform: v => v, target: 'worklet' },
  { id: 'gateRange',       key: 'gateRange',        transform: v => v, target: 'worker'  },
  { id: 'gateAttack',      key: 'gateAttack',       transform: v => v, target: 'worklet' },
  { id: 'gateRelease',     key: 'gateRelease',      transform: v => v, target: 'worklet' },
  { id: 'gateHold',        key: 'gateHold',         transform: v => v, target: 'worker'  },
  { id: 'gateLookahead',   key: 'gateLookahead',    transform: v => v, target: 'worker'  },

  // ── Noise Reduction ───────────────────────────────────────────────────────
  { id: 'nrAmount',        key: 'nrAmount',         transform: v => v, target: 'worker'  },
  { id: 'nrSensitivity',   key: 'nrSensitivity',    transform: v => v, target: 'worker'  },
  { id: 'nrSpectralSub',   key: 'nrSpectralSub',    transform: v => v, target: 'worker'  },
  { id: 'nrFloor',         key: 'nrFloor',          transform: v => v, target: 'worker'  },
  { id: 'nrSmoothing',     key: 'nrSmoothing',      transform: v => v, target: 'worker'  },

  // ── EQ ────────────────────────────────────────────────────────────────────
  { id: 'eqSub',           key: 'eqSub',            transform: v => v, target: 'worklet' },
  { id: 'eqBass',          key: 'eqBass',           transform: v => v, target: 'worklet' },
  { id: 'eqWarmth',        key: 'eqWarmth',         transform: v => v, target: 'worklet' },
  { id: 'eqBody',          key: 'eqBody',           transform: v => v, target: 'worklet' },
  { id: 'eqLowMid',        key: 'eqLowMid',         transform: v => v, target: 'worklet' },
  { id: 'eqMid',           key: 'eqMid',            transform: v => v, target: 'worklet' },
  { id: 'eqPresence',      key: 'eqPresence',       transform: v => v, target: 'worklet' },
  { id: 'eqClarity',       key: 'eqClarity',        transform: v => v, target: 'worklet' },
  { id: 'eqAir',           key: 'eqAir',            transform: v => v, target: 'worklet' },
  { id: 'eqBrill',         key: 'eqBrill',          transform: v => v, target: 'worklet' },

  // ── Dynamics ──────────────────────────────────────────────────────────────
  { id: 'compThresh',      key: 'compThresh',       transform: v => v, target: 'worklet' },
  { id: 'compRatio',       key: 'compRatio',        transform: v => v, target: 'worklet' },
  { id: 'compAttack',      key: 'compAttack',       transform: v => v, target: 'worklet' },
  { id: 'compRelease',     key: 'compRelease',      transform: v => v, target: 'worklet' },
  { id: 'compKnee',        key: 'compKnee',         transform: v => v, target: 'worklet' },
  { id: 'compMakeup',      key: 'compMakeup',       transform: v => v, target: 'worklet' },
  { id: 'limThresh',       key: 'limThresh',        transform: v => v, target: 'worklet' },
  { id: 'limRelease',      key: 'limRelease',       transform: v => v, target: 'worklet' },

  // ── Spectral ──────────────────────────────────────────────────────────────
  { id: 'hpFreq',          key: 'hpFreq',           transform: v => v, target: 'worklet' },
  { id: 'hpQ',             key: 'hpQ',              transform: v => v, target: 'worklet' },
  { id: 'lpFreq',          key: 'lpFreq',           transform: v => v, target: 'worklet' },
  { id: 'lpQ',             key: 'lpQ',              transform: v => v, target: 'worklet' },
  { id: 'deEssFreq',       key: 'deEssFreq',        transform: v => v, target: 'worklet' },
  { id: 'deEssAmt',        key: 'deEssAmt',         transform: v => v, target: 'worklet' },
  { id: 'specTilt',        key: 'specTilt',         transform: v => v, target: 'worklet' },
  { id: 'formantShift',    key: 'formantShift',     transform: v => v, target: 'worker'  },

  // ── Advanced ──────────────────────────────────────────────────────────────
  { id: 'derevAmt',        key: 'derevAmt',         transform: v => v, target: 'worker'  },
  { id: 'derevDecay',      key: 'derevDecay',       transform: v => v, target: 'worker'  },
  { id: 'harmRecov',       key: 'harmRecov',        transform: v => v, target: 'worker'  },
  { id: 'harmOrder',       key: 'harmOrder',        transform: v => v, target: 'worker'  },
  { id: 'stereoWidth',     key: 'stereoWidth',      transform: v => v, target: 'worklet' },
  { id: 'phaseCorr',       key: 'phaseCorr',        transform: v => v, target: 'worker'  },

  // ── Separation ────────────────────────────────────────────────────────────
  { id: 'voiceIso',        key: 'voiceIso',         transform: v => v, target: 'worker'  },
  { id: 'bgSuppress',      key: 'bgSuppress',       transform: v => v, target: 'worker'  },
  { id: 'voiceFocusLo',    key: 'voiceFocusLo',     transform: v => v, target: 'worklet' },
  { id: 'voiceFocusHi',    key: 'voiceFocusHi',     transform: v => v, target: 'worklet' },
  { id: 'crosstalkCancel', key: 'crosstalkCancel',  transform: v => v, target: 'worker'  },

  // ── Output ────────────────────────────────────────────────────────────────
  { id: 'outGain',         key: 'outGain',          transform: v => v, target: 'worklet' },
  { id: 'dryWet',          key: 'dryWet',           transform: v => v, target: 'worker'  },
  { id: 'ditherAmt',       key: 'ditherAmt',        transform: v => v, target: 'worker'  },
  { id: 'outWidth',        key: 'outWidth',         transform: v => v, target: 'worklet' },
];

// ── STAGES (32-stage Deca-Pass pipeline) ─────────────────────────────────────
export const STAGES = [
  'S01: Input Decode',                    // 0
  'S02: Buffer Allocation',               // 1
  'S03: DC Offset Removal',               // 2
  'S04: Peak Normalization',              // 3
  'S05: Voice Activity Detection',        // 4
  'S06: Noise Gate (Time-Domain)',        // 5
  'S07: Click/Pop Removal',              // 6
  'S08: Hum Removal (60Hz + Harmonics)', // 7
  'S09: De-Essing',                       // 8
  'S10: Forward STFT',                    // 9
  'S11: Adaptive Wiener NR',             // 10
  'S12: Residual Wiener Pass',           // 11
  'S13: ERB Spectral Gate (32-band)',    // 12
  'S14: Voice-Band Spectral Emphasis',   // 13
  'S15: Crosstalk Cancellation',         // 14
  'S16: Temporal Smoothing (Anti-Garble)', // 15
  'S17: Spectral Tilt Compensation',     // 16
  'S18: Dereverberation',                // 17
  'S19: Harmonic Reconstruction v2',     // 18
  'S20: Inverse STFT',                   // 19
  'S21: OfflineAudioContext Setup',      // 20
  'S22: High-Pass / Low-Pass Filters',  // 21
  'S23: 10-Band Parametric EQ',          // 22
  'S24: Dynamics Compression',           // 23
  'S25: Brickwall Limiter',              // 24
  'S26: Rendering OfflineAudioContext',  // 25
  'S27: Post-Render Cleanup',           // 26
  'S28: Dry/Wet Mix',                    // 27
  'S29: Peak Normalization',             // 28
  'S30: Quality Metrics',                // 29
  'S31: Waveform Update',               // 30
  'S32: Final Export Ready'              // 31
];

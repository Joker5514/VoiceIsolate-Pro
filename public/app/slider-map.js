/**
 * VoiceIsolate Pro — slider-map.js
 * Canonical slider/stage data for Engineer Mode.
 *
 * This is a **pure data module** — no Web Audio API, no SharedArrayBuffer, no
 * DOM, no side effects. It exports the two structures `app.js` imports:
 *   • SLIDER_REGISTRY — the ordered 52-slider list used to index the shared
 *     parameter buffer (id → transform → target).
 *   • STAGES — the 32-stage Deca-Pass pipeline labels.
 *
 * The slider DOM is built by `app.js` (_renderSliders), and real-time slider
 * values are routed through `app.onSlider` → the Live-Mix bridge
 * (src/pipeline/EngineerModeBridge.js). The old in-module DOM builders and the
 * worklet/worker `dispatchParam` routing were removed with the live-pipeline
 * orchestrator (CLAUDE.md §1.1 / §5) — they dispatched to nodes that no longer
 * exist. Do not reintroduce them here.
 */

export const STAGES = [
  'S01: Input Decode',
  'S02: Buffer Allocation',
  'S03: DC Offset Removal',
  'S04: Peak Normalization',
  'S05: Voice Activity Detection',
  'S06: Time-Domain Noise Gate',
  'S07: Click/Pop Removal',
  'S08: Hum Removal',
  'S09: De-essing',
  'S10: Forward STFT',
  'S11: Adaptive Wiener NR',
  'S12: Residual Wiener Pass',
  'S13: ERB Spectral Gate',
  'S14: Voice-Band Emphasis',
  'S15: Crosstalk Cancel',
  'S16: Temporal Smoothing',
  'S17: Spectral Tilt',
  'S18: Dereverb',
  'S19: Harmonic Reconstruction',
  'S20: Inverse STFT',
  'S21: OfflineAudioContext Setup',
  'S22: HP/LP Filters',
  'S23: 10-Band EQ',
  'S24: Compression',
  'S25: Limiter',
  'S26: Render',
  'S27: Post-Render Cleanup',
  'S28: Dry/Wet Mix',
  'S29: Peak Normalization',
  'S30: Quality Metrics',
  'S31: Waveform Update',
  'S32: Final Export Ready',
];

export const SLIDER_REGISTRY = [
  { id: 'gateThresh',      key: 'gateThresh',      transform: v => v, target: 'worklet' },
  { id: 'gateRange',       key: 'gateRange',       transform: v => v, target: 'worklet' },
  { id: 'gateAttack',      key: 'gateAttack',      transform: v => v, target: 'worklet' },
  { id: 'gateRelease',     key: 'gateRelease',     transform: v => v, target: 'worklet' },
  { id: 'gateHold',        key: 'gateHold',        transform: v => v, target: 'worklet' },
  { id: 'gateLookahead',   key: 'gateLookahead',   transform: v => v, target: 'worker' },
  { id: 'nrAmount',        key: 'nrAmount',        transform: v => v / 100, target: 'both'   },
  { id: 'nrSensitivity',   key: 'nrSensitivity',   transform: v => v, target: 'worker' },
  { id: 'nrSpectralSub',   key: 'nrSpectralSub',   transform: v => v, target: 'worker' },
  { id: 'nrFloor',         key: 'nrFloor',         transform: v => v, target: 'worker' },
  { id: 'nrSmoothing',     key: 'nrSmoothing',     transform: v => v, target: 'worker' },
  { id: 'eqSub',           key: 'eqSub',           transform: v => v, target: 'worklet' },
  { id: 'eqBass',          key: 'eqBass',          transform: v => v, target: 'worklet' },
  { id: 'eqWarmth',        key: 'eqWarmth',        transform: v => v, target: 'worklet' },
  { id: 'eqBody',          key: 'eqBody',          transform: v => v, target: 'worklet' },
  { id: 'eqLowMid',        key: 'eqLowMid',        transform: v => v, target: 'worklet' },
  { id: 'eqMid',           key: 'eqMid',           transform: v => v, target: 'worklet' },
  { id: 'eqPresence',      key: 'eqPresence',      transform: v => v, target: 'worklet' },
  { id: 'eqClarity',       key: 'eqClarity',       transform: v => v, target: 'worklet' },
  { id: 'eqAir',           key: 'eqAir',           transform: v => v, target: 'worklet' },
  { id: 'eqBrill',         key: 'eqBrill',         transform: v => v, target: 'worklet' },
  { id: 'compThresh',      key: 'compThresh',      transform: v => v, target: 'worklet' },
  { id: 'compRatio',       key: 'compRatio',       transform: v => v, target: 'worklet' },
  { id: 'compAttack',      key: 'compAttack',      transform: v => v, target: 'worklet' },
  { id: 'compRelease',     key: 'compRelease',     transform: v => v, target: 'worklet' },
  { id: 'compKnee',        key: 'compKnee',        transform: v => v, target: 'worklet' },
  { id: 'compMakeup',      key: 'compMakeup',      transform: v => v, target: 'worklet' },
  { id: 'limThresh',       key: 'limThresh',       transform: v => v, target: 'worklet' },
  { id: 'limRelease',      key: 'limRelease',      transform: v => v, target: 'worklet' },
  { id: 'hpFreq',          key: 'hpFreq',          transform: v => v, target: 'worklet' },
  { id: 'hpQ',             key: 'hpQ',             transform: v => v, target: 'worklet' },
  { id: 'lpFreq',          key: 'lpFreq',          transform: v => v, target: 'worklet' },
  { id: 'lpQ',             key: 'lpQ',             transform: v => v, target: 'worklet' },
  { id: 'deEssFreq',       key: 'deEssFreq',       transform: v => v, target: 'worklet' },
  { id: 'deEssAmt',        key: 'deEssAmt',        transform: v => v, target: 'worklet' },
  { id: 'specTilt',        key: 'specTilt',        transform: v => v, target: 'worklet' },
  { id: 'formantShift',    key: 'formantShift',    transform: v => v, target: 'worker' },
  { id: 'derevAmt',        key: 'derevAmt',        transform: v => v, target: 'worker' },
  { id: 'derevDecay',      key: 'derevDecay',      transform: v => v, target: 'worker' },
  { id: 'harmRecov',       key: 'harmRecov',       transform: v => v, target: 'worker' },
  { id: 'harmOrder',       key: 'harmOrder',       transform: v => v, target: 'worker' },
  { id: 'stereoWidth',     key: 'stereoWidth',     transform: v => v, target: 'worklet' },
  { id: 'phaseCorr',       key: 'phaseCorr',       transform: v => v, target: 'worker' },
  { id: 'voiceIso',        key: 'voiceIso',        transform: v => v, target: 'worker' },
  { id: 'bgSuppress',      key: 'bgSuppress',      transform: v => v, target: 'worker' },
  { id: 'voiceFocusLo',    key: 'voiceFocusLo',    transform: v => v, target: 'worker' },
  { id: 'voiceFocusHi',    key: 'voiceFocusHi',    transform: v => v, target: 'worker' },
  { id: 'crosstalkCancel', key: 'crosstalkCancel', transform: v => v, target: 'worker' },
  { id: 'outGain',         key: 'outGain',         transform: v => v, target: 'worklet' },
  { id: 'dryWet',          key: 'dryWet',          transform: v => v / 100, target: 'worklet' },
  { id: 'ditherAmt',       key: 'ditherAmt',       transform: v => v, target: 'worklet' },
  { id: 'outWidth',        key: 'outWidth',        transform: v => v, target: 'worklet' },
];

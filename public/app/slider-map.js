/**
 * VoiceIsolate Pro — slider-map.js  (audited v2.0)
 * ==========================================================
 * Pure data module.  No DOM, no Web Audio, no side-effects.
 *
 * Each entry now includes the fields _renderSliders() needs:
 *   id        – DOM id and worklet/worker param key
 *   label     – human display name
 *   min/max   – range boundaries
 *   step      – tick interval (also used for haptic-snap)
 *   default   – value at boot / reset
 *   unit      – display suffix
 *   transform – value → worklet/worker scale conversion
 *   target    – 'worklet' | 'worker' | 'both'
 *   rt        – true → cyan accent (live, <10 ms latency)
 *   group     – panel id inside index.html
 *   tip       – tooltip description
 *
 * AUDIT NOTES:
 *  • gateAttack / gateRelease / gateHold / gateLookahead:  added
 *    correct dsp-processor._params keys (worklet ignores unknowns
 *    gracefully so old entries were no-ops — now correctly routed).
 *  • nrAmount transform fixed: registry had v/100 but dsp-processor
 *    already expects 0-1 float, so transform kept as v/100 matching
 *    index slider range 0-100.
 *  • deEssFreq / deEssAmt: were 'worklet' but dsp-processor does NOT
 *    implement them — rerouted to 'worker' (ml-worker handles de-ess).
 *  • stereoWidth / outWidth: dsp-processor has no stereo path —
 *    kept as worklet with step 1 for future OfflineAudioContext node.
 *  • harmOrder: integer-only param → step 1.
 *  • All EQ bands: step 0.5 dB for fine musical control.
 *  • compRatio: step 0.5 for precision, log-feel handled by _renderSliders.
 *  • hpFreq / lpFreq: step 10 Hz — snaps to 10 Hz increments.
 *  • Tick counts target 10-20 visible marks per slider for good UX.
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
  // ── Noise Gate (6 sliders) ─────────────────────────────────────────────────
  {
    id: 'gateThresh', key: 'gateThresh', label: 'Gate Threshold',
    min: -120, max: 0, step: 5, default: -42, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-gate',
    tip: 'RMS level below which the gate closes and mutes the signal. –42 dB suits most voice recordings.'
  },
  {
    id: 'gateRange', key: 'gateRange', label: 'Gate Range',
    min: -120, max: 0, step: 5, default: -60, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-gate',
    tip: 'How much attenuation is applied when the gate is closed. –60 dB = near-silence; 0 dB = no effect.'
  },
  {
    id: 'gateAttack', key: 'gateAttack', label: 'Gate Attack',
    min: 0, max: 100, step: 5, default: 5, unit: 'ms',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-gate',
    tip: 'How fast the gate opens when signal exceeds the threshold. Lower = snappier.'
  },
  {
    id: 'gateRelease', key: 'gateRelease', label: 'Gate Release',
    min: 10, max: 2000, step: 50, default: 200, unit: 'ms',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-gate',
    tip: 'How fast the gate closes after signal drops below threshold. Longer = smoother tail.'
  },
  {
    id: 'gateHold', key: 'gateHold', label: 'Gate Hold',
    min: 0, max: 500, step: 25, default: 20, unit: 'ms',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-gate',
    tip: 'Minimum time gate stays open after signal drops. Prevents chattering during pauses.'
  },
  {
    id: 'gateLookahead', key: 'gateLookahead', label: 'Lookahead',
    min: 0, max: 20, step: 1, default: 2, unit: 'ms',
    transform: v => v, target: 'worker', rt: false, group: 'tab-gate',
    tip: 'Offline only. Pre-reads upcoming signal so the gate opens before a transient hits.'
  },

  // ── Noise Reduction (5 sliders) ────────────────────────────────────────────
  {
    id: 'nrAmount', key: 'nrAmount', label: 'NR Amount',
    min: 0, max: 100, step: 5, default: 78, unit: '%',
    transform: v => v / 100, target: 'both', rt: true, group: 'tab-nr',
    tip: 'Strength of spectral noise reduction. 0 = off, 100 = maximum suppression. Start at 70–80% for hiss/fan noise.'
  },
  {
    id: 'nrSensitivity', key: 'nrSensitivity', label: 'NR Sensitivity',
    min: 0, max: 100, step: 5, default: 50, unit: '%',
    transform: v => v, target: 'worker', rt: false, group: 'tab-nr',
    tip: 'How aggressively the noise profile is estimated. Higher = more bins treated as noise.'
  },
  {
    id: 'nrSpectralSub', key: 'nrSpectralSub', label: 'Spectral Sub',
    min: 0, max: 100, step: 5, default: 50, unit: '%',
    transform: v => v, target: 'worker', rt: false, group: 'tab-nr',
    tip: 'Amount of spectral subtraction applied in the Wiener pass. Balances musical noise vs. residual.'
  },
  {
    id: 'nrFloor', key: 'nrFloor', label: 'NR Floor',
    min: -120, max: -20, step: 5, default: -80, unit: 'dB',
    transform: v => v, target: 'worker', rt: false, group: 'tab-nr',
    tip: 'Minimum gain floor for NR bins. Prevents over-suppression artifacts on tonal content.'
  },
  {
    id: 'nrSmoothing', key: 'nrSmoothing', label: 'NR Smoothing',
    min: 0, max: 100, step: 5, default: 40, unit: '%',
    transform: v => v, target: 'worker', rt: false, group: 'tab-nr',
    tip: 'Temporal smoothing on the noise estimate. Higher = fewer musical noise artifacts, slower response.'
  },

  // ── EQ — 10 bands (11 sliders) ─────────────────────────────────────────────
  {
    id: 'eqSub', key: 'eqSub', label: 'Sub (< 60 Hz)',
    min: -24, max: 24, step: 0.5, default: 0, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-eq',
    tip: 'Deep bass shelf below 60 Hz. Cut to remove rumble; rarely boosted for voice.'
  },
  {
    id: 'eqBass', key: 'eqBass', label: 'Bass (60–200 Hz)',
    min: -24, max: 24, step: 0.5, default: 0, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-eq',
    tip: 'Low-end warmth. Cut –3 to –6 dB to tighten a boomy room mic.'
  },
  {
    id: 'eqWarmth', key: 'eqWarmth', label: 'Warmth (200–500 Hz)',
    min: -24, max: 24, step: 0.5, default: 0, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-eq',
    tip: 'Body and warmth of the voice. Boost to fill out a thin-sounding mic; cut to reduce muddiness.'
  },
  {
    id: 'eqBody', key: 'eqBody', label: 'Body (500 Hz–1 kHz)',
    min: -24, max: 24, step: 0.5, default: 0, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-eq',
    tip: 'Core fundamental of the speaking voice. Boost for weight; cut the "boxy" 500 Hz peak.'
  },
  {
    id: 'eqLowMid', key: 'eqLowMid', label: 'Low Mid (1–2 kHz)',
    min: -24, max: 24, step: 0.5, default: 0, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-eq',
    tip: 'Nasal and honky zone. Often cut –2 to –4 dB to clean up indoor recordings.'
  },
  {
    id: 'eqMid', key: 'eqMid', label: 'Mid (2–4 kHz)',
    min: -24, max: 24, step: 0.5, default: 0, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-eq',
    tip: 'Intelligibility range. Boost to bring speech forward in a mix.'
  },
  {
    id: 'eqPresence', key: 'eqPresence', label: 'Presence (4–6 kHz)',
    min: -24, max: 24, step: 0.5, default: 0, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-eq',
    tip: 'Attack and presence of consonants. +2 dB makes voices cut through a podcast mix.'
  },
  {
    id: 'eqClarity', key: 'eqClarity', label: 'Clarity (6–10 kHz)',
    min: -24, max: 24, step: 0.5, default: 0, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-eq',
    tip: 'Clarity and bite of sibilants and fricatives. Cut if harshness is a problem.'
  },
  {
    id: 'eqAir', key: 'eqAir', label: 'Air (10–16 kHz)',
    min: -24, max: 24, step: 0.5, default: 0, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-eq',
    tip: 'High-frequency air and openness. Subtle boost adds studio sheen to voice.'
  },
  {
    id: 'eqBrill', key: 'eqBrill', label: 'Brilliance (> 16 kHz)',
    min: -24, max: 24, step: 0.5, default: 0, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-eq',
    tip: 'Top-of-spectrum shimmer. Subtle boost adds sparkle; cut if speaker setup lacks HF extension.'
  },

  // ── Dynamics (7 sliders) ───────────────────────────────────────────────────
  {
    id: 'compThresh', key: 'compThresh', label: 'Comp Threshold',
    min: -60, max: 0, step: 1, default: -24, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-dyn',
    tip: 'Level at which the compressor begins reducing gain. Lower = more compression.'
  },
  {
    id: 'compRatio', key: 'compRatio', label: 'Comp Ratio',
    min: 1, max: 20, step: 0.5, default: 4, unit: ':1',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-dyn',
    tip: 'Compression ratio above threshold. 4:1 = for every 4 dB over, output rises 1 dB.'
  },
  {
    id: 'compAttack', key: 'compAttack', label: 'Comp Attack',
    min: 0.1, max: 200, step: 5, default: 10, unit: 'ms',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-dyn',
    tip: 'Time for compressor to reach full gain reduction after threshold crossing.'
  },
  {
    id: 'compRelease', key: 'compRelease', label: 'Comp Release',
    min: 10, max: 2000, step: 50, default: 150, unit: 'ms',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-dyn',
    tip: 'Time for compressor to return to unity gain after level drops below threshold.'
  },
  {
    id: 'compKnee', key: 'compKnee', label: 'Comp Knee',
    min: 0, max: 24, step: 1, default: 6, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-dyn',
    tip: 'Soft-knee width around the threshold. Larger = more gradual onset, less pumping.'
  },
  {
    id: 'compMakeup', key: 'compMakeup', label: 'Makeup Gain',
    min: -12, max: 24, step: 0.5, default: 0, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-dyn',
    tip: 'Compensates for gain loss from compression. Apply until average level matches uncompressed.'
  },
  {
    id: 'limThresh', key: 'limThresh', label: 'Limiter Threshold',
    min: -24, max: 0, step: 1, default: -1, unit: 'dBFS',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-dyn',
    tip: 'Hard ceiling for the brickwall limiter. –1 dBFS is the standard broadcast ceiling.'
  },
  {
    id: 'limRelease', key: 'limRelease', label: 'Limiter Release',
    min: 1, max: 500, step: 10, default: 50, unit: 'ms',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-dyn',
    tip: 'Recovery time for the brickwall limiter. Faster = more transparent but risks distortion.'
  },

  // ── Spectral (8 sliders) ───────────────────────────────────────────────────
  {
    id: 'hpFreq', key: 'hpFreq', label: 'HP Freq',
    min: 10, max: 1000, step: 10, default: 80, unit: 'Hz',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-spec',
    tip: 'High-pass filter cutoff. Everything below this frequency is attenuated. 80 Hz removes mic rumble.'
  },
  {
    id: 'hpQ', key: 'hpQ', label: 'HP Q',
    min: 0.5, max: 10, step: 0.5, default: 0.707, unit: '',
    transform: v => v, target: 'worklet', rt: false, group: 'tab-spec',
    tip: 'High-pass filter resonance (Q). 0.707 = Butterworth (flat); higher = ringing peak at cutoff.'
  },
  {
    id: 'lpFreq', key: 'lpFreq', label: 'LP Freq',
    min: 1000, max: 20000, step: 500, default: 18000, unit: 'Hz',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-spec',
    tip: 'Low-pass filter cutoff. Attenuates everything above this frequency. Use to cut hiss or harsh air.'
  },
  {
    id: 'lpQ', key: 'lpQ', label: 'LP Q',
    min: 0.5, max: 10, step: 0.5, default: 0.707, unit: '',
    transform: v => v, target: 'worklet', rt: false, group: 'tab-spec',
    tip: 'Low-pass filter resonance (Q). 0.707 = flat Butterworth response.'
  },
  {
    id: 'deEssFreq', key: 'deEssFreq', label: 'De-ess Freq',
    min: 2000, max: 16000, step: 500, default: 7000, unit: 'Hz',
    transform: v => v, target: 'worker', rt: false, group: 'tab-spec',
    tip: 'Center frequency for de-esser detection. Set to the harshest sibilant peak (typically 6–8 kHz).'
  },
  {
    id: 'deEssAmt', key: 'deEssAmt', label: 'De-ess Amount',
    min: 0, max: 24, step: 1, default: 6, unit: 'dB',
    transform: v => v, target: 'worker', rt: false, group: 'tab-spec',
    tip: 'Maximum attenuation applied to sibilant peaks. 6 dB is subtle; 12+ dB is heavy correction.'
  },
  {
    id: 'specTilt', key: 'specTilt', label: 'Spectral Tilt',
    min: -12, max: 12, step: 0.5, default: 0, unit: 'dB/oct',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-spec',
    tip: 'Tilts the entire spectrum brighter (+) or darker (–) relative to 1 kHz. A fast tonal balance control.'
  },
  {
    id: 'formantShift', key: 'formantShift', label: 'Formant Shift',
    min: -12, max: 12, step: 1, default: 0, unit: 'st',
    transform: v => v, target: 'worker', rt: false, group: 'tab-spec',
    tip: 'Shifts vowel formants up or down in semitones without affecting pitch. Changes vocal character.'
  },

  // ── Advanced (6 sliders) ───────────────────────────────────────────────────
  {
    id: 'derevAmt', key: 'derevAmt', label: 'Dereverb Amount',
    min: 0, max: 100, step: 5, default: 0, unit: '%',
    transform: v => v, target: 'worker', rt: false, group: 'tab-adv',
    tip: 'Strength of dereverberation. Reduces room echo and flutter. Start at 40–60% for echoey rooms.'
  },
  {
    id: 'derevDecay', key: 'derevDecay', label: 'Rev Decay Est.',
    min: 0, max: 100, step: 5, default: 30, unit: '%',
    transform: v => v, target: 'worker', rt: false, group: 'tab-adv',
    tip: 'Estimated reverb tail length (normalized). Match to room RT60 — longer rooms need higher values.'
  },
  {
    id: 'harmRecov', key: 'harmRecov', label: 'Harmonic Recovery',
    min: 0, max: 100, step: 5, default: 0, unit: '%',
    transform: v => v, target: 'worker', rt: false, group: 'tab-adv',
    tip: 'Reconstructs harmonics lost to aggressive noise reduction. Adds back natural voice shimmer.'
  },
  {
    id: 'harmOrder', key: 'harmOrder', label: 'Harmonic Order',
    min: 1, max: 8, step: 1, default: 3, unit: '',
    transform: v => v, target: 'worker', rt: false, group: 'tab-adv',
    tip: 'How many harmonic partials to reconstruct (1 = fundamental only, higher = fuller restoration).'
  },
  {
    id: 'stereoWidth', key: 'stereoWidth', label: 'Stereo Width',
    min: 0, max: 200, step: 10, default: 100, unit: '%',
    transform: v => v, target: 'worklet', rt: false, group: 'tab-adv',
    tip: '0% = mono, 100% = natural stereo, 200% = extra-wide. Affects M/S balance post-processing.'
  },
  {
    id: 'phaseCorr', key: 'phaseCorr', label: 'Phase Correlation',
    min: 0, max: 100, step: 5, default: 0, unit: '%',
    transform: v => v, target: 'worker', rt: false, group: 'tab-adv',
    tip: 'Corrects phase cancellation between stereo channels. Useful for dual-mic setups with time offset.'
  },

  // ── Separation (6 sliders) ─────────────────────────────────────────────────
  {
    id: 'voiceIso', key: 'voiceIso', label: 'Voice Isolation',
    min: 0, max: 100, step: 5, default: 70, unit: '%',
    transform: v => v, target: 'worker', rt: false, group: 'tab-sep',
    tip: 'ML mask strength for isolating the primary voice from all other sources. 70–85% for clean extraction.'
  },
  {
    id: 'bgSuppress', key: 'bgSuppress', label: 'BG Suppress',
    min: 0, max: 100, step: 5, default: 50, unit: '%',
    transform: v => v, target: 'worker', rt: false, group: 'tab-sep',
    tip: 'Suppression strength on non-voice stems (music, effects). Higher = more aggressive background removal.'
  },
  {
    id: 'voiceFocusLo', key: 'voiceFocusLo', label: 'Voice Focus Lo',
    min: 50, max: 1000, step: 25, default: 200, unit: 'Hz',
    transform: v => v, target: 'worker', rt: false, group: 'tab-sep',
    tip: 'Low edge of the target voice frequency band for separation. Lower = include more bass fundamentals.'
  },
  {
    id: 'voiceFocusHi', key: 'voiceFocusHi', label: 'Voice Focus Hi',
    min: 1000, max: 16000, step: 500, default: 8000, unit: 'Hz',
    transform: v => v, target: 'worker', rt: false, group: 'tab-sep',
    tip: 'High edge of the target voice frequency band. 8 kHz covers all speech content; higher adds air.'
  },
  {
    id: 'crosstalkCancel', key: 'crosstalkCancel', label: 'Crosstalk Cancel',
    min: 0, max: 100, step: 5, default: 0, unit: '%',
    transform: v => v, target: 'worker', rt: false, group: 'tab-sep',
    tip: 'Reduces bleed between two simultaneous microphones by subtracting the correlated signal.'
  },

  // ── Output (4 sliders) ────────────────────────────────────────────────────
  {
    id: 'outGain', key: 'outGain', label: 'Output Gain',
    min: -24, max: 12, step: 0.5, default: 0, unit: 'dB',
    transform: v => v, target: 'worklet', rt: true, group: 'tab-out',
    tip: 'Final gain trim applied after all processing. Use to match loudness between presets.'
  },
  {
    id: 'dryWet', key: 'dryWet', label: 'Dry / Wet',
    min: 0, max: 100, step: 5, default: 100, unit: '%',
    transform: v => v / 100, target: 'worklet', rt: true, group: 'tab-out',
    tip: '0% = pass-through original, 100% = fully processed. Blend for parallel processing effect.'
  },
  {
    id: 'ditherAmt', key: 'ditherAmt', label: 'Dither',
    min: 0, max: 3, step: 1, default: 1, unit: '',
    transform: v => v, target: 'worklet', rt: false, group: 'tab-out',
    tip: 'Noise shaping dither applied before bit-depth reduction: 0=off, 1=TPDF, 2=shaped, 3=high-pass.'
  },
  {
    id: 'outWidth', key: 'outWidth', label: 'Output Width',
    min: 0, max: 200, step: 10, default: 100, unit: '%',
    transform: v => v, target: 'worklet', rt: false, group: 'tab-out',
    tip: 'Final stereo width on the output bus. 100% = unchanged, 0% = mono sum, 200% = widened.'
  },
];

/**
 * TICK CONFIGURATION  — used by slider-ticks.js to render tick marks.
 * Each slider's `step` and range define the tick positions.
 * The snap JS reads `step` directly from SLIDER_REGISTRY entries.
 *
 * Rules for designers:
 *   • Aim for 10–20 visible ticks per slider (range / step ≈ 10–20).
 *   • Use coarser step for very wide ranges (e.g., 0–2000 ms → step 50 = 40 ticks — acceptable).
 *   • Integer step sliders snap hard; float steps (0.5) have fine intermediate stops.
 */

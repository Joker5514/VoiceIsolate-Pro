import { calibrateRegistry } from './slider-calibration.js';

/**
 * VoiceIsolate Pro — slider-map.js  (audited v3.0)
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
 *   hint      – 1–2 sentence inline UI guidance (rendered as .slider-hint)
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

/** Inline 1–2 sentence hints for every slider row (Engineer Mode UI). */
export const SLIDER_HINTS = {
  gateThresh: 'Sets the level where the noise gate closes on quiet passages. Lower toward –50 dB when fan hum bleeds through pauses in a podcast recording.',
  gateRange: 'Controls how deeply the gate mutes audio when closed. Push toward –80 dB for near-silence between phrases; ease toward –40 dB if words sound clipped.',
  gateAttack: 'Sets how quickly the gate opens when speech returns. Shorten toward 5 ms for tight podcast edits; lengthen toward 30 ms to avoid chopping soft consonants.',
  gateRelease: 'Sets how slowly the gate closes after speech ends. Lengthen toward 400 ms for natural room tails; shorten toward 100 ms for aggressive noise removal.',
  gateHold: 'Keeps the gate open briefly after level drops to prevent flutter between syllables. Raise toward 80 ms when quiet vowels get chopped in forensic clips.',
  gateLookahead: 'Pre-reads audio so the gate opens before a word starts (offline only). Raise toward 5 ms when plosives are late-cutting in an interview export.',
  nrAmount: 'Sets overall spectral noise reduction strength. Raise toward 85% for steady hiss or air-conditioning; lower toward 50% if voices sound underwater.',
  nrSensitivity: 'Controls how aggressively quiet bins are treated as noise. Raise toward 70% in constant background hum; lower toward 30% to protect soft consonants.',
  nrSpectralSub: 'Balances subtraction depth against musical noise artifacts. Increase toward 65% for fan noise; decrease toward 25% when tonal ringing appears.',
  nrFloor: 'Sets the minimum gain any frequency can be reduced to. Raise toward –60 dB if suppression sounds hollow; lower toward –90 dB for maximum hiss removal.',
  nrSmoothing: 'Smooths noise estimates over time to reduce warble. Raise toward 60% for steady HVAC noise; lower toward 20% when transients feel dulled.',
  eqSub: 'Trims deep sub-bass below 60 Hz. Cut toward –6 dB when desk rumble or traffic shakes the mic on a voice-over track.',
  eqBass: 'Shapes low warmth between 60–200 Hz. Cut toward –4 dB for a boomy room; add +2 dB if the speaker sounds thin on a phone recording.',
  eqWarmth: 'Adjusts body in the 200–500 Hz zone. Boost toward +3 dB for a distant speaker; cut toward –3 dB when the room sounds muddy.',
  eqBody: 'Controls core vocal weight around 500 Hz–1 kHz. Cut toward –3 dB to reduce boxiness; add +2 dB when isolation leaves the voice small.',
  eqLowMid: 'Targets nasal honk near 1–2 kHz. Cut toward –4 dB for indoor Zoom calls; leave flat for already-balanced broadcast chains.',
  eqMid: 'Lifts intelligibility in the 2–4 kHz speech band. Boost toward +3 dB when the voice sits under music in a live mix.',
  eqPresence: 'Adds consonant edge from 4–6 kHz. Raise toward +4 dB for whisper clarity; cut toward –2 dB if sibilance gets harsh.',
  eqClarity: 'Shapes air and frication from 6–10 kHz. Boost toward +2 dB for forensic whispers; cut toward –3 dB when cymbals bleed on the mic.',
  eqAir: 'Adds openness above 10 kHz. Nudge toward +2 dB for studio polish; cut toward –4 dB if hiss dominates after heavy noise reduction.',
  eqBrill: 'Touches extreme top-end shimmer above 16 kHz. Use +1 dB sparingly for sheen; cut when the source has no real high-frequency content.',
  compThresh: 'Sets the level where compression begins. Lower toward –30 dB for even podcast loudness; raise toward –18 dB for light touch-up only.',
  compRatio: 'Controls how strongly levels above the threshold are reduced. Raise toward 6:1 for inconsistent field recordings; lower toward 2:1 for natural speech.',
  compAttack: 'Sets how fast compression engages on peaks. Shorten toward 5 ms to catch plosives; lengthen toward 30 ms to preserve vocal punch.',
  compRelease: 'Sets how fast compression lets go after peaks pass. Lengthen toward 300 ms for smooth narration; shorten toward 80 ms for tight broadcast levels.',
  compKnee: 'Softens the transition into compression around the threshold. Widen toward 12 dB for invisible leveling; narrow toward 3 dB for firmer control.',
  compMakeup: 'Restores level lost from compression. Raise toward +4 dB until the processed voice matches the raw loudness on your meter.',
  limThresh: 'Sets the brickwall ceiling that prevents clipping. Keep near –1 dBFS for broadcast delivery; lower toward –3 dBFS for extra headroom on export.',
  limRelease: 'Controls how quickly the limiter recovers after peaks. Shorten toward 30 ms for transparent podcast mastering; lengthen toward 100 ms if distortion flickers.',
  hpFreq: 'Removes low-frequency rumble below the cutoff. Raise toward 100 Hz for desk mic rumble; lower toward 60 Hz to keep a warm male voice.',
  hpQ: 'Sets steepness and resonance of the high-pass filter. Leave near 0.707 for a clean slope; raise toward 2 only when a narrow rumble band needs notching.',
  lpFreq: 'Rolls off harsh or noisy highs above the cutoff. Lower toward 12 kHz for telephone-band isolation; keep near 18 kHz for full-band speech.',
  lpQ: 'Sets the shape of the low-pass roll-off. Stay near 0.707 for natural air; increase only when targeting a specific whistling frequency.',
  deEssFreq: 'Centers sibilance detection on the harsh “S” band. Sweep toward 8 kHz for bright speakers; lower toward 6 kHz for darker microphones.',
  deEssAmt: 'Limits how much sibilance peaks are pulled down. Raise toward 10 dB for harsh podcast mics; keep near 4 dB for transparent correction.',
  specTilt: 'Brightens or darkens the whole spectrum relative to 1 kHz. Tilt toward +3 dB/oct if the room sounds dull; toward –2 dB/oct to tame harsh overheads.',
  formantShift: 'Moves vowel color up or down without changing pitch. Shift toward +2 semitones to lighten a muffled source; toward –2 to thicken a thin whisper.',
  derevAmt: 'Reduces room echo and reverb tail on the voice. Raise toward 55% for reflective conference rooms; stay near 0% for already-dry studio takes.',
  derevDecay: 'Estimates how long the room tail rings out. Raise toward 60% for large halls; lower toward 15% for small office reflections.',
  harmRecov: 'Rebuilds harmonics lost to aggressive noise reduction. Raise toward 40% when the voice sounds fizzy or hollow after heavy NR.',
  harmOrder: 'Sets how many overtones are restored. Raise toward 5 for fuller speech recovery; lower toward 2 if artifacts appear in the highs.',
  stereoWidth: 'Widens or collapses the stereo image. Pull toward 0% for mono podcast delivery; push toward 140% only when the source is a clean stereo room mic.',
  phaseCorr: 'Aligns stereo channels to fix cancellation. Raise toward 50% when dual lav mics on one subject sound thin or swishy.',
  voiceIso: 'Sets machine-learning voice mask strength. Raise toward 85% to pull speech from crowd noise; lower toward 55% if words sound gargled.',
  bgSuppress: 'Pushes down non-voice stems after separation. Raise toward 80% for music behind a reporter; lower toward 35% to keep natural ambience.',
  voiceFocusLo: 'Sets the bottom edge of the speech band to isolate. Lower toward 120 Hz for deep male voices; raise toward 250 Hz to ignore subwoofer bleed.',
  voiceFocusHi: 'Sets the top edge of the speech band to isolate. Lower toward 6 kHz for telephone speech; raise toward 10 kHz to keep breath and air.',
  crosstalkCancel: 'Subtracts bleed between two microphones on one subject. Raise toward 60% for interview crosstalk; leave at 0% for single-mic recordings.',
  outGain: 'Trims final output level after all processing. Boost toward +6 dB when isolation lowered loudness; cut toward –3 dB if export peaks near 0 dBFS.',
  dryWet: 'Blends original audio with the processed result. Lower toward 40% to compare before/after; keep at 100% for full isolation output.',
  ditherAmt: 'Adds tiny noise when reducing bit depth (0=off, 1=TPDF, 2=shaped, 3=high-pass). Use mode 1 for 16-bit podcast export; 0 for 32-bit float workflows.',
  outWidth: 'Sets final stereo spread on the output bus. Narrow toward 0% for mono distribution; widen toward 130% only when the source is true stereo.',
  whisperLift: 'Boosts bins where the voice mask is confident after isolation. Raise toward 24 dB when a whisper is buried under club noise; lower toward 10 dB for subtle lift.',
  crowdNull: 'Targets crowd murmur in the 200–2500 Hz band. Raise toward 85% for stadium ambience; lower toward 50% if speech sounds phasey.',
  bassCrush: 'Attenuates kick and sub energy that masks whispers. Raise toward 95% in EDM environments; lower toward 60% if the voice loses body.',
  reverbStrip: 'Sets estimated room decay time for dereverb strength. Lengthen toward 900 ms for echoey halls; shorten toward 300 ms for tight booths.',
  voiceTunnel: 'Narrows processing to speech formants for intelligibility. Raise toward 80% for forensic whispers; lower toward 40% for natural tone.',
  musicKill: 'Suppresses steady harmonic music under speech. Raise toward 90% for DJ background; lower toward 50% if music pumping becomes audible.',
  snrFloor: 'Bins quieter than this are treated as noise-only. Lower toward –60 dBFS to rescue faint whispers; raise toward –45 dBFS to reduce musical artifacts.',
  whisperMode: 'Sets how many aggressive passes run (Off / Light / Heavy / Forensic). Choose Heavy for club whispers; Forensic only when maximum extraction is worth the wait.',
  whisperClarity: 'Sets the minimum clarity floor so whispers are not crushed. Raise toward 80% when consonants vanish; lower toward 45% for lighter touch.',
  whisperSensitivity: 'Controls how easily quiet whispers trigger processing. Raise toward 75% in noisy venues; lower toward 35% in quiet rooms to avoid false triggers.',
  whisperThreshold: 'Steepens how hard non-whisper content is suppressed. Raise toward 70% for aggressive extraction; lower toward 35% for gentler results.',
  transientShaper: 'Emphasizes or softens consonant attacks. Push toward +40 to sharpen buried consonants; pull toward –30 to tame harsh plosives.',
  breathControl: 'Reduces breath noise between phrases. Raise toward 70% for ASMR-clean delivery; lower toward 15% to keep natural breathing.',
  roomCorrection: 'Corrects room coloration on whisper tails. Raise toward 65% for reflective spaces; lower toward 20% for already-dry sources.',
  subHarmonic: 'Adds synthetic low body to thin whispers. Raise toward 40% when the voice lacks chest resonance; leave at 0% for full-range recordings.',
};

const RAW_SLIDER_REGISTRY = [
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

  // ── Extreme Isolation (8 sliders) — [WHISPER UPDATE] ───────────────────────
  {
    id: 'whisperLift', key: 'whisperLift', label: 'Whisper Lift Gain',
    min: 0, max: 40, step: 1, default: 18, unit: 'dB',
    transform: v => v, target: 'both', rt: true, group: 'tab-extreme',
    tip: 'Post-mask amplification on bins where voice confidence exceeds 0.55.'
  },
  {
    id: 'crowdNull', key: 'crowdNull', label: 'Crowd Null Depth',
    min: 0, max: 100, step: 1, default: 72, unit: '%',
    transform: v => v, target: 'both', rt: false, group: 'tab-extreme',
    tip: 'Second-pass spectral subtraction targeting 200–2500 Hz crowd murmur.'
  },
  {
    id: 'bassCrush', key: 'bassCrush', label: 'Bass Crush (Sub/Kick)',
    min: 0, max: 100, step: 1, default: 90, unit: '%',
    transform: v => v, target: 'both', rt: true, group: 'tab-extreme',
    tip: 'Attenuates kick drum and sub bass that mask whisper formants.'
  },
  {
    id: 'reverbStrip', key: 'reverbStrip', label: 'Reverb Strip (RT60)',
    min: 0, max: 2000, step: 10, default: 600, unit: 'ms',
    transform: v => v, target: 'both', rt: false, group: 'tab-extreme',
    tip: 'Single-pass spectral dereverb driven by estimated RT60.'
  },
  {
    id: 'voiceTunnel', key: 'voiceTunnel', label: 'Voice Tunnel (Formant)',
    min: 0, max: 100, step: 1, default: 65, unit: '%',
    transform: v => v, target: 'both', rt: true, group: 'tab-extreme',
    tip: 'Narrow-band formant emphasis for whisper intelligibility.'
  },
  {
    id: 'musicKill', key: 'musicKill', label: 'Music Kill (Comb)',
    min: 0, max: 100, step: 1, default: 80, unit: '%',
    transform: v => v, target: 'both', rt: false, group: 'tab-extreme',
    tip: 'Suppresses steady-state harmonic music while preserving speech transients.'
  },
  {
    id: 'snrFloor', key: 'snrFloor', label: 'SNR Rescue Floor',
    min: -80, max: -20, step: 1, default: -52, unit: 'dBFS',
    transform: v => v, target: 'both', rt: false, group: 'tab-extreme',
    tip: 'Minimum power threshold — bins below are treated as noise-only.'
  },
  {
    id: 'whisperMode', key: 'whisperMode', label: 'Whisper Mode',
    min: 0, max: 3, step: 1, default: 2, unit: '',
    transform: v => v, target: 'both', rt: false, group: 'tab-extreme',
    tip: 'Processing aggression: Off, Light, Heavy, or Forensic multi-pass.'
  },

  // ── Whisper Hunter DSP sliders (Part 1 + Part 4) ───────────────────────────
  {
    id: 'whisperClarity', key: 'whisperClarity', label: 'Whisper Clarity',
    min: 0, max: 100, step: 1, default: 65, unit: '%',
    transform: v => v, target: 'both', rt: true, group: 'tab-extreme',
    tip: 'Sigmoid-mapped clarity floor for WhisperHunter gain (p_clarity).'
  },
  {
    id: 'whisperSensitivity', key: 'whisperSensitivity', label: 'Whisper Sensitivity',
    min: 0, max: 100, step: 1, default: 55, unit: '%',
    transform: v => v, target: 'both', rt: true, group: 'tab-extreme',
    tip: 'Scales W-VAD energy threshold θ_e — higher catches quieter whispers.'
  },
  {
    id: 'whisperThreshold', key: 'whisperThreshold', label: 'Whisper Threshold',
    min: 0, max: 100, step: 1, default: 50, unit: '%',
    transform: v => v, target: 'both', rt: true, group: 'tab-extreme',
    tip: 'Steepens suppression curve w_str = 1 + 2·p_threshold.'
  },
  {
    id: 'transientShaper', key: 'transientShaper', label: 'Transient Shaper',
    min: -100, max: 100, step: 5, default: 0, unit: '',
    transform: v => v, target: 'both', rt: true, group: 'tab-extreme',
    tip: 'Bipolar transient emphasis: negative softens, positive sharpens consonants.'
  },
  {
    id: 'breathControl', key: 'breathControl', label: 'Breath Control',
    min: 0, max: 100, step: 1, default: 30, unit: '%',
    transform: v => v, target: 'worker', rt: false, group: 'tab-extreme',
    tip: 'Attenuates breath noise between whispered phrases.'
  },
  {
    id: 'roomCorrection', key: 'roomCorrection', label: 'Room Correction',
    min: 0, max: 100, step: 1, default: 40, unit: '%',
    transform: v => v, target: 'both', rt: false, group: 'tab-extreme',
    tip: 'Spectral room correction complementing dereverb for whisper tails.'
  },
  {
    id: 'subHarmonic', key: 'subHarmonic', label: 'Sub Harmonic',
    min: 0, max: 100, step: 1, default: 0, unit: '%',
    transform: v => v, target: 'both', rt: true, group: 'tab-extreme',
    tip: 'Sub-harmonic body reinforcement for thin whisper recordings.'
  },
];

/** Attach inline hints from SLIDER_HINTS to each registry entry. */
function attachSliderHints(entries) {
  return entries.map((entry) => ({
    ...entry,
    hint: entry.hint || SLIDER_HINTS[entry.id] || '',
  }));
}

/** Calibrated registry with Part 3 transfer functions + Part 1 examples + hints */
export const SLIDER_REGISTRY = calibrateRegistry(attachSliderHints(RAW_SLIDER_REGISTRY));

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

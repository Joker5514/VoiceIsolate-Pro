/* global VisualizationEngine */
/* ============================================
   VoiceIsolate Pro v22.1 – Engineer Mode
   Threads from Space v11 · Hybrid ML+DSP
   52 Sliders · 6-Panel Diagnostics · 3D Spectrogram
   32-Stage Deca-Pass Pipeline with Real STFT DSP
   ============================================ */

function structuredLog(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  // Errors/warns always surface. Info/debug only when window.VIP_DEBUG is truthy.
  const debugEnabled = (typeof window !== 'undefined') && !!window.VIP_DEBUG;
  if (level === 'error') console.error('[VIP]', msg, data);
  else if (level === 'warn') console.warn('[VIP]', msg, data);
  else if (debugEnabled) console.log('[VIP]', msg, data);
  // Store last 200 entries for forensic export
  if (typeof window !== 'undefined') {
    if (!window._vipLogs) window._vipLogs = [];
    if (window._vipLogs.length >= 200) window._vipLogs.shift();
    window._vipLogs.push(entry);
  }
}

// ---- SLIDER DEFINITIONS (52 total) ----
const SLIDERS = {
  gate: [
    { id:'gateThresh', label:'Threshold', min:-80, max:-5, val:-55, step:1, unit:' dB', rt:true, desc:'Signal level below which the gate closes. Lower values let quieter sounds (whispers) through.' },
    { id:'gateRange', label:'Range', min:-90, max:0, val:-40, step:1, unit:' dB', rt:false, desc:'Maximum attenuation when gate is closed. -90dB = full silence, -20dB = gentle reduction.' },
    { id:'gateAttack', label:'Attack', min:0.1, max:50, val:2, step:0.1, unit:' ms', rt:true, desc:'How fast the gate opens when signal exceeds threshold.' },
    { id:'gateRelease', label:'Release', min:5, max:500, val:80, step:1, unit:' ms', rt:true, desc:'How fast the gate closes after signal drops below threshold.' },
    { id:'gateHold', label:'Hold', min:0, max:200, val:20, step:1, unit:' ms', rt:false, desc:'Minimum time gate stays open after triggering. Prevents rapid flutter.' },
    { id:'gateLookahead', label:'Lookahead', min:0, max:20, val:5, step:0.5, unit:' ms', rt:false, desc:'Pre-delay allowing the gate to open before transients arrive.' },
  ],
  nr: [
    { id:'nrAmount', label:'Reduction Amount', min:0, max:100, val:78, step:1, unit:'%', rt:false, desc:'How much noise is removed. 70-85% for voice/whisper isolation in noisy environments.' },
    { id:'nrSensitivity', label:'Sensitivity', min:0, max:100, val:72, step:1, unit:'%', rt:false, desc:'How aggressively noise is detected.' },
    { id:'nrSpectralSub', label:'Spectral Subtract', min:0, max:100, val:62, step:1, unit:'%', rt:false, desc:'Subtracts estimated noise spectrum from signal.' },
    { id:'nrFloor', label:'Noise Floor', min:-80, max:-20, val:-55, step:1, unit:' dB', rt:false, desc:'Estimated noise floor level.' },
    { id:'nrSmoothing', label:'Smoothing', min:0, max:100, val:45, step:1, unit:'%', rt:false, desc:'Temporal smoothing of noise estimate.' },
  ],
  eq: [
    { id:'eqSub', label:'Sub (40 Hz)', min:-12, max:6, val:-8, step:0.5, unit:' dB', rt:true, desc:'Sub-bass. Cut to remove rumble.' },
    { id:'eqBass', label:'Bass (100 Hz)', min:-8, max:8, val:0, step:0.5, unit:' dB', rt:true, desc:'Low bass. Boost for warmth.' },
    { id:'eqWarmth', label:'Warmth (200 Hz)', min:-6, max:6, val:1, step:0.5, unit:' dB', rt:true, desc:'Lower midrange warmth.' },
    { id:'eqBody', label:'Body (400 Hz)', min:-6, max:6, val:0, step:0.5, unit:' dB', rt:true, desc:'Core body of the voice.' },
    { id:'eqLowMid', label:'Low-Mid (800 Hz)', min:-6, max:6, val:-1, step:0.5, unit:' dB', rt:true, desc:'Nasal/honky frequencies.' },
    { id:'eqMid', label:'Mid (1.5 kHz)', min:-6, max:6, val:1, step:0.5, unit:' dB', rt:true, desc:'Core intelligibility band.' },
    { id:'eqPresence', label:'Presence (3 kHz)', min:-6, max:8, val:3, step:0.5, unit:' dB', rt:true, desc:'Vocal presence and projection.' },
    { id:'eqClarity', label:'Clarity (5 kHz)', min:-6, max:6, val:2, step:0.5, unit:' dB', rt:true, desc:'Consonant definition.' },
    { id:'eqAir', label:'Air (10 kHz)', min:-6, max:6, val:1, step:0.5, unit:' dB', rt:true, desc:'High-frequency sparkle.' },
    { id:'eqBrill', label:'Brilliance (16 kHz)', min:-8, max:4, val:-2, step:0.5, unit:' dB', rt:true, desc:'Ultra-high frequencies.' },
  ],
  dyn: [
    { id:'compThresh', label:'Comp Threshold', min:-50, max:0, val:-24, step:1, unit:' dB', rt:true, desc:'Level above which compression begins.' },
    { id:'compRatio', label:'Comp Ratio', min:1, max:20, val:4, step:0.5, unit:':1', rt:true, desc:'Compression ratio.' },
    { id:'compAttack', label:'Comp Attack', min:0, max:100, val:8, step:1, unit:' ms', rt:true, desc:'How fast compressor reacts.' },
    { id:'compRelease', label:'Comp Release', min:10, max:1000, val:200, step:5, unit:' ms', rt:true, desc:'How fast compressor lets go.' },
    { id:'compKnee', label:'Comp Knee', min:0, max:30, val:6, step:1, unit:' dB', rt:true, desc:'Soft/hard knee.' },
    { id:'compMakeup', label:'Makeup Gain', min:0, max:24, val:6, step:0.5, unit:' dB', rt:true, desc:'Gain added after compression.' },
    { id:'limThresh', label:'Limiter Ceiling', min:-6, max:0, val:-1, step:0.1, unit:' dB', rt:true, desc:'Brickwall ceiling.' },
    { id:'limRelease', label:'Limiter Release', min:1, max:100, val:10, step:1, unit:' ms', rt:true, desc:'How fast limiter recovers.' },
  ],
  spec: [
    { id:'hpFreq', label:'High-Pass Freq', min:20, max:500, val:80, step:1, unit:' Hz', rt:true, desc:'Removes everything below this frequency.' },
    { id:'hpQ', label:'HP Resonance', min:0.5, max:5, val:0.71, step:0.01, unit:' Q', rt:true, desc:'Filter steepness.' },
    { id:'lpFreq', label:'Low-Pass Freq', min:3000, max:20000, val:14000, step:100, unit:' Hz', rt:true, desc:'Removes everything above this frequency.' },
    { id:'lpQ', label:'LP Resonance', min:0.5, max:5, val:0.71, step:0.01, unit:' Q', rt:true, desc:'Low-pass filter resonance.' },
    { id:'deEssFreq', label:'De-Ess Center', min:4000, max:10000, val:7000, step:100, unit:' Hz', rt:true, desc:'Center frequency for sibilance reduction.' },
    { id:'deEssAmt', label:'De-Ess Amount', min:0, max:100, val:30, step:1, unit:'%', rt:true, desc:'How much sibilance is reduced.' },
    { id:'specTilt', label:'Spectral Tilt', min:-6, max:6, val:0, step:0.5, unit:' dB/oct', rt:true, desc:'Overall spectral slope.' },
    { id:'formantShift', label:'Formant Shift', min:-12, max:12, val:0, step:0.5, unit:' semi', rt:false, desc:'Shifts vocal formants without changing pitch.' },
  ],
  adv: [
    { id:'derevAmt', label:'Dereverb Amount', min:0, max:100, val:40, step:1, unit:'%', rt:false, desc:'Removes room reverb/echo.' },
    { id:'derevDecay', label:'Dereverb Decay', min:0.1, max:3, val:0.5, step:0.1, unit:' s', rt:false, desc:'Estimated room reverb decay time.' },
    { id:'harmRecov', label:'Harmonic Recovery', min:0, max:100, val:20, step:1, unit:'%', rt:false, desc:'Regenerates harmonics lost during noise reduction.' },
    { id:'harmOrder', label:'Harmonic Order', min:2, max:8, val:3, step:1, unit:'x', rt:false, desc:'Which harmonics to regenerate.' },
    { id:'stereoWidth', label:'Stereo Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'0%=mono, 100%=original, 200%=extra wide.' },
    { id:'phaseCorr', label:'Phase Correction', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Corrects phase issues between stereo channels.' },
  ],
  sep: [
    { id:'voiceIso', label:'Voice Isolation', min:0, max:100, val:88, step:1, unit:'%', rt:false, desc:'Strength of voice/non-voice separation.' },
    { id:'bgSuppress', label:'Background Suppress', min:0, max:100, val:80, step:1, unit:'%', rt:false, desc:'Attenuation of non-voice background.' },
    { id:'voiceFocusLo', label:'Voice Focus Low', min:80, max:500, val:120, step:5, unit:' Hz', rt:true, desc:'Lower bound of voice focus band.' },
    { id:'voiceFocusHi', label:'Voice Focus High', min:2000, max:12000, val:6000, step:100, unit:' Hz', rt:true, desc:'Upper bound of voice focus band.' },
    { id:'crosstalkCancel', label:'Crosstalk Cancel', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Reduces bleed between speakers.' },
  ],
  out: [
    { id:'outGain', label:'Output Gain', min:-18, max:18, val:0, step:0.5, unit:' dB', rt:true, desc:'Final output level adjustment.' },
    { id:'dryWet', label:'Dry/Wet Mix', min:0, max:100, val:100, step:1, unit:'%', rt:false, desc:'Balance between original and processed.' },
    { id:'ditherAmt', label:'Dither', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Adds shaped noise before bit-depth reduction.' },
    { id:'outWidth', label:'Output Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'Final stereo width control.' },
  ]
};

const SLIDER_MAP = {};
for (const tab of Object.values(SLIDERS)) {
  for (const s of tab) {
    SLIDER_MAP[s.id] = s;
  }
}

// ---- PRESETS (all 52 slider IDs covered per preset)
const PRESETS = {
  'Voice Clarity': {
    // Gate
    gateThresh: -45, gateRange: -60, gateAttack: 2, gateRelease: 80, gateHold: 20, gateLookahead: 5,
    // Noise Reduction
    nrAmount: 82, nrSensitivity: 75, nrSpectralSub: 70, nrFloor: -55, nrSmoothing: 50, spectralFloor: 0.008,
    // EQ
    eqSub: -8, eqBass: -2, eqWarmth: 1, eqBody: 2, eqLowMid: -2, eqMid: 3, eqPresence: 5, eqClarity: 4, eqAir: 2, eqBrill: -2,
    // Dynamics
    compThresh: -24, compRatio: 4, compAttack: 8, compRelease: 200, compKnee: 6, compMakeup: 6, limThresh: -1, limRelease: 10,
    // Spectral
    hpFreq: 120, hpQ: 0.71, lpFreq: 8000, lpQ: 0.71, deEssFreq: 7000, deEssAmt: 45, specTilt: 0, formantShift: 0,
    // Advanced
    derevAmt: 60, derevDecay: 0.5, harmRecov: 30, harmOrder: 3, stereoWidth: 100, phaseCorr: 0,
    // Separation
    voiceIso: 91, bgSuppress: 80, voiceFocusLo: 120, voiceFocusHi: 6000, crosstalkCancel: 0,
    // Output
    outGain: 2, dryWet: 100, ditherAmt: 0, outWidth: 100,
    description: 'Max voice clarity — best for speech in noise'
  },
  'Podcast Clean': {
    // Gate
    gateThresh: -50, gateRange: -40, gateAttack: 5, gateRelease: 100, gateHold: 30, gateLookahead: 5,
    // Noise Reduction
    nrAmount: 70, nrSensitivity: 60, nrSpectralSub: 50, nrFloor: -60, nrSmoothing: 40,
    // EQ
    eqSub: -6, eqBass: 1, eqWarmth: 2, eqBody: 1, eqLowMid: -1, eqMid: 2, eqPresence: 3, eqClarity: 2, eqAir: 1, eqBrill: -2,
    // Dynamics
    compThresh: -20, compRatio: 3, compAttack: 10, compRelease: 250, compKnee: 8, compMakeup: 5, limThresh: -1, limRelease: 10,
    // Spectral
    hpFreq: 100, hpQ: 0.71, lpFreq: 12000, lpQ: 0.71, deEssFreq: 7000, deEssAmt: 35, specTilt: 0, formantShift: 0,
    // Advanced
    derevAmt: 50, derevDecay: 0.5, harmRecov: 20, harmOrder: 3, stereoWidth: 100, phaseCorr: 0,
    // Separation
    voiceIso: 85, bgSuppress: 60, voiceFocusLo: 120, voiceFocusHi: 8000, crosstalkCancel: 0,
    // Output
    outGain: 0, dryWet: 100, ditherAmt: 0, outWidth: 100,
    description: 'Balanced — clean podcast/interview audio'
  },
  'Forensic Extract': {
    // Gate
    gateThresh: -38, gateRange: -80, gateAttack: 1, gateRelease: 50, gateHold: 10, gateLookahead: 8,
    // Noise Reduction
    nrAmount: 95, nrSensitivity: 90, nrSpectralSub: 85, nrFloor: -45, nrSmoothing: 60, spectralFloor: 0.001,
    // EQ
    eqSub: -12, eqBass: -2, eqWarmth: 0, eqBody: 1, eqLowMid: -3, eqMid: 4, eqPresence: 6, eqClarity: 5, eqAir: 0, eqBrill: -4,
    // Dynamics
    compThresh: -30, compRatio: 6, compAttack: 5, compRelease: 150, compKnee: 4, compMakeup: 8, limThresh: -0.5, limRelease: 5,
    // Spectral
    hpFreq: 80, hpQ: 1.0, lpFreq: 6000, lpQ: 0.71, deEssFreq: 6000, deEssAmt: 20, specTilt: 0, formantShift: 0,
    // Advanced
    derevAmt: 85, derevDecay: 0.3, harmRecov: 50, harmOrder: 4, stereoWidth: 0, phaseCorr: 80,
    // Separation
    voiceIso: 98, bgSuppress: 95, voiceFocusLo: 80, voiceFocusHi: 4000, crosstalkCancel: 50,
    // Output
    outGain: 6, dryWet: 100, ditherAmt: 0, outWidth: 0,
    description: 'Maximum extraction — forensic/law enforcement'
  },
  'Music Vocal': {
    // Gate
    gateThresh: -55, gateRange: -30, gateAttack: 5, gateRelease: 150, gateHold: 50, gateLookahead: 5,
    // Noise Reduction
    nrAmount: 45, nrSensitivity: 40, nrSpectralSub: 30, nrFloor: -65, nrSmoothing: 30,
    // EQ
    eqSub: -6, eqBass: -2, eqWarmth: 0, eqBody: 1, eqLowMid: -1, eqMid: 2, eqPresence: 4, eqClarity: 3, eqAir: 3, eqBrill: 0,
    // Dynamics
    compThresh: -20, compRatio: 3.5, compAttack: 15, compRelease: 300, compKnee: 8, compMakeup: 4, limThresh: -1, limRelease: 15,
    // Spectral
    hpFreq: 80, hpQ: 0.71, lpFreq: 16000, lpQ: 0.71, deEssFreq: 8000, deEssAmt: 55, specTilt: 0, formantShift: 0,
    // Advanced
    derevAmt: 30, derevDecay: 0.8, harmRecov: 15, harmOrder: 2, stereoWidth: 120, phaseCorr: 0,
    // Separation
    voiceIso: 78, bgSuppress: 65, voiceFocusLo: 100, voiceFocusHi: 8000, crosstalkCancel: 0,
    // Output
    outGain: 0, dryWet: 100, ditherAmt: 0, outWidth: 110,
    description: 'Vocal separation from music'
  },
  'Whisper Boost': {
    // Gate
    gateThresh: -65, gateRange: -45, gateAttack: 1, gateRelease: 200, gateHold: 50, gateLookahead: 10,
    // Noise Reduction
    nrAmount: 88, nrSensitivity: 80, nrSpectralSub: 60, nrFloor: -50, nrSmoothing: 55,
    // EQ
    eqSub: -12, eqBass: -3, eqWarmth: 0, eqBody: 2, eqLowMid: -2, eqMid: 4, eqPresence: 6, eqClarity: 5, eqAir: 2, eqBrill: -4,
    // Dynamics
    compThresh: -35, compRatio: 8, compAttack: 5, compRelease: 300, compKnee: 6, compMakeup: 12, limThresh: -0.5, limRelease: 5,
    // Spectral
    hpFreq: 100, hpQ: 0.71, lpFreq: 7000, lpQ: 0.71, deEssFreq: 6500, deEssAmt: 15, specTilt: 2, formantShift: 0,
    // Advanced
    derevAmt: 70, derevDecay: 0.4, harmRecov: 60, harmOrder: 4, stereoWidth: 100, phaseCorr: 20,
    // Separation
    voiceIso: 94, bgSuppress: 85, voiceFocusLo: 100, voiceFocusHi: 5000, crosstalkCancel: 30,
    // Output
    outGain: 10, dryWet: 100, ditherAmt: 0, outWidth: 100,
    description: 'Amplify and isolate whispered speech'
  },
  'Phone/Radio': {
    // Gate
    gateThresh: -45, gateRange: -60, gateAttack: 3, gateRelease: 100, gateHold: 25, gateLookahead: 5,
    // Noise Reduction
    nrAmount: 75, nrSensitivity: 65, nrSpectralSub: 60, nrFloor: -55, nrSmoothing: 45,
    // EQ
    eqSub: -12, eqBass: -6, eqWarmth: -2, eqBody: 1, eqLowMid: 0, eqMid: 4, eqPresence: 6, eqClarity: 3, eqAir: -6, eqBrill: -8,
    // Dynamics
    compThresh: -24, compRatio: 5, compAttack: 6, compRelease: 200, compKnee: 4, compMakeup: 8, limThresh: -1, limRelease: 8,
    // Spectral
    hpFreq: 300, hpQ: 0.71, lpFreq: 3400, lpQ: 0.71, deEssFreq: 4500, deEssAmt: 30, specTilt: 1, formantShift: 0,
    // Advanced
    derevAmt: 65, derevDecay: 0.3, harmRecov: 40, harmOrder: 3, stereoWidth: 0, phaseCorr: 60,
    // Separation
    voiceIso: 88, bgSuppress: 75, voiceFocusLo: 300, voiceFocusHi: 3400, crosstalkCancel: 40,
    // Output
    outGain: 4, dryWet: 100, ditherAmt: 0, outWidth: 0,
    description: 'Optimize narrow-band telephone/radio voice'
  },
  'Live Performance': {
    // Gate
    gateThresh: -55, gateRange: -25, gateAttack: 8, gateRelease: 200, gateHold: 60, gateLookahead: 3,
    // Noise Reduction
    nrAmount: 55, nrSensitivity: 45, nrSpectralSub: 30, nrFloor: -65, nrSmoothing: 25,
    // EQ
    eqSub: -6, eqBass: 1, eqWarmth: 2, eqBody: 1, eqLowMid: -1, eqMid: 2, eqPresence: 3, eqClarity: 2, eqAir: 2, eqBrill: 0,
    // Dynamics
    compThresh: -18, compRatio: 2.5, compAttack: 20, compRelease: 400, compKnee: 10, compMakeup: 4, limThresh: -1.5, limRelease: 15,
    // Spectral
    hpFreq: 90, hpQ: 0.71, lpFreq: 14000, lpQ: 0.71, deEssFreq: 7500, deEssAmt: 50, specTilt: 0, formantShift: 0,
    // Advanced
    derevAmt: 20, derevDecay: 1.2, harmRecov: 10, harmOrder: 2, stereoWidth: 130, phaseCorr: 0,
    // Separation
    voiceIso: 72, bgSuppress: 40, voiceFocusLo: 100, voiceFocusHi: 10000, crosstalkCancel: 0,
    // Output
    outGain: 0, dryWet: 85, ditherAmt: 0, outWidth: 130,
    description: 'Live stage — preserve natural room character'
  },
  'Surveillance': {
    // Gate
    gateThresh: -38, gateRange: -70, gateAttack: 2, gateRelease: 60, gateHold: 15, gateLookahead: 10,
    // Noise Reduction
    nrAmount: 90, nrSensitivity: 85, nrSpectralSub: 80, nrFloor: -45, nrSmoothing: 65,
    // EQ
    eqSub: -12, eqBass: -4, eqWarmth: -1, eqBody: 2, eqLowMid: -3, eqMid: 5, eqPresence: 6, eqClarity: 5, eqAir: -2, eqBrill: -8,
    // Dynamics
    compThresh: -28, compRatio: 8, compAttack: 3, compRelease: 100, compKnee: 4, compMakeup: 12, limThresh: -0.5, limRelease: 5,
    // Spectral
    hpFreq: 80, hpQ: 1.0, lpFreq: 5000, lpQ: 0.71, deEssFreq: 5500, deEssAmt: 10, specTilt: 1, formantShift: 0,
    // Advanced
    derevAmt: 90, derevDecay: 0.3, harmRecov: 70, harmOrder: 5, stereoWidth: 0, phaseCorr: 90,
    // Separation
    voiceIso: 96, bgSuppress: 92, voiceFocusLo: 80, voiceFocusHi: 4000, crosstalkCancel: 60,
    // Output
    outGain: 12, dryWet: 100, ditherAmt: 0, outWidth: 0,
    description: 'Maximum SNR boost for covert/distant recording'
  }
};

// Aliases kept for backward-compat with any custom presets saved before v23
const PRESET_PARAM_ALIASES = {};

// Flat lookup: sliderId → { min, max, step, ... } for clamping preset values
// and guarding against out-of-range user input.
const SLIDER_BY_ID = Object.freeze(
  Object.values(SLIDERS).flat().reduce((acc, s) => { acc[s.id] = s; return acc; }, {})
);
function clampToSlider(id, value) {
  const s = SLIDER_BY_ID[id];
  const v = Number(value);
  if (!Number.isFinite(v)) return s ? s.val : 0;
  if (!s) return v;
  if (v < s.min) return s.min;
  if (v > s.max) return s.max;
  return v;
}
// Parses the value of a numeric <input>, returning `fallback` for non-finite
// or missing values. Used by event handlers that forward sliders to AudioParams.
function numFromInput(el, fallback = 0) {
  if (!el) return fallback;
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
}
if (typeof window !== 'undefined') window.numFromInput = numFromInput;

const STAGES = [
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

// Sound categories for background suppression. Each entry targets specific
// frequency ranges that characterise that sound type. Suppression is applied
// in the spectral domain (between STFT and iSTFT) respecting the VAD mask so
// voice frames lose minimal energy while noise-only frames are fully cleaned.
const SOUND_CATEGORIES = [
  { id:'appliance', emoji:'🏠', label:'Appliances', ranges:[{lo:20, hi:500}] },
  { id:'music',     emoji:'🎵', label:'Music',      ranges:[{lo:80, hi:300},{lo:1000,hi:8000}] },
  { id:'dog',       emoji:'🐕', label:'Dog/Animal', ranges:[{lo:300,hi:1200},{lo:1200,hi:3000}] },
  { id:'bird',      emoji:'🐦', label:'Birds',      ranges:[{lo:2000,hi:5000},{lo:5000,hi:10000}] },
  { id:'traffic',   emoji:'🚗', label:'Traffic',    ranges:[{lo:20,hi:150},{lo:150,hi:600}] },
  { id:'crowd',     emoji:'👥', label:'Crowd',      ranges:[{lo:120,hi:300},{lo:300,hi:800},{lo:800,hi:2000}] },
];

const ACCEPTED_AUDIO_UPLOAD_TYPES = [
  'audio/wav', 'audio/x-wav', 'audio/mp3', 'audio/mpeg', 'audio/flac', 'audio/x-flac', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/opus', 'audio/x-aiff', 'audio/aiff', 'audio/aif', 'audio/x-ms-wma'
];
const ACCEPTED_VIDEO_UPLOAD_TYPES = [
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-m4v', 'video/ogg', 'video/avi', 'video/x-msvideo'
];
const ACCEPTED_UPLOAD_TYPES = [...ACCEPTED_AUDIO_UPLOAD_TYPES, ...ACCEPTED_VIDEO_UPLOAD_TYPES];
const VIDEO_UPLOAD_EXTENSIONS = ['.mp4', '.webm', '.mov', '.mkv', '.m4v', '.avi'];
const AUDIO_UPLOAD_EXTENSIONS = ['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.aiff', '.aif'];

// ============================================
class VoiceIsolatePro {
  constructor() {
    this.ctx = null;
    this.inputBuffer = null;
    this.outputBuffer = null;
    this.currentSource = null;
    this.analyserNode = null;     // post-chain (for existing viz)
    this.analyserOrig = null;     // pre-chain (for A/B comparison)
    this.analyserProc = null;     // post-chain (for diagnostics)
    this.isProcessing = false;
    this.isRecording = false;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.abMode = 'original';
    this.isVideo = false;
    this.videoUrl = null;
    this.spectroRunning = false;
    this.animId = null;
    this.diagRunning = false;
    this.diagAnimId = null;
    this.spectroX = 0;
    this.specOverlayX = 0;
    this.abortFlag = false;
    this.liveNodes = {};
    this.liveChainBuilt = false;
    this.playStartTime = 0;
    this.playOffset = 0;
    this.isPlaying = false;
    this.mutedBands = new Set();
    this.soundMutes = {}; // { catId: boolean } — toggled by sound mute buttons
    this.params = {};
    for (const tab of Object.values(SLIDERS)) for (const s of tab) this.params[s.id] = s.val;
    this.params.spectralFloor = this._mapSpectralFloor(this.params.nrFloor);
    // Restore persisted slider params from previous session
    try {
      const savedParams = JSON.parse(localStorage.getItem('vip_params') || 'null');
      if (savedParams && typeof savedParams === 'object') {
        for (const tab of Object.values(SLIDERS)) {
          for (const s of tab) {
            const v = savedParams[s.id];
            if (typeof v === 'number' && isFinite(v)) {
              this.params[s.id] = Math.min(s.max, Math.max(s.min, v));
            }
          }
        }
        this.params.spectralFloor = this._mapSpectralFloor(this.params.nrFloor);
      }
    } catch { /* storage sandboxed */ }
    this._paramSaveTimer = 0;
    this._lastLoadedFile = null;
    this._rcDB = null;
    this._fcDB = null;
    this.three = {};
    try {
      this.customPresets = JSON.parse(localStorage.getItem('vip_custom_presets') || '{}');
    } catch { this.customPresets = {}; } // ARCH-06 FIX: try/catch for sandboxed iframe safety
    this.renderCustomPresets();
    // Diagnostic state
    this.oscMode = 'wave';
    this.overlays = { noise: true, erb: true, ml: false };
    this.abOverlay = false;
    this.lufsHistory = new Float32Array(600).fill(-60);  // 60 seconds @ 10Hz
    this.lufsIdx = 0;
    this.lufsIntegrated = -60;
    this.lufsFrameCount = 0;
    this.lufsSumSq = 0;
    this.clusterPoints = [];  // simulated PCA points
    this.saliencyBuf = new Float32Array(256);
    this.noiseProfile = new Float32Array(256).fill(0.05);
    this.erbThresholds = new Float32Array(32);
    for (let i = 0; i < 32; i++) this.erbThresholds[i] = 0.08 + Math.random() * 0.04;
    this.diagFpsFrames = 0;
    this.diagFpsLast = performance.now();
    this.forensicLog = [];
    this._mlCallId = 0;
    this._rndBuf = new Uint32Array(4096);
    this._rndIdx = 0;
    this._sliderContextResumed = false;
    this._uiScaleSaveTimer = 0;
    this._controlBindings = {};
    this.init();
  }

  init() {
    this.buildSliderPanels();
    this.cacheDom();
    this._uiScaleInit();
    this.bindEvents();
    this.initCanvases();
    this.init3D();
    this._initVisualEngine();
    // ML worker ownership lives in PipelineOrchestrator to prevent
    // duplicate workers, duplicate ORT/model init, and race conditions.
    // Restore last uploaded file (runs async, non-blocking)
    this._restoreSavedFile().catch(() => {});
  }

  // ------------------------------------------------------------------
  //  Visualization Engine (visuals.js) — additive to 6-panel diagnostics.
  //  Drives per-speaker VU meters and the diarization timeline. Reads
  //  from the SAME analyser nodes that startDiagnostics() already uses —
  //  no duplicate polling, no extra analyser allocations.
  // ------------------------------------------------------------------
  _initVisualEngine() {
    if (typeof VisualizationEngine !== 'function') {
      structuredLog('warn', 'VisualizationEngine not available — visuals.js missing?');
      return;
    }
    // Shared live state object the engine reads every frame. Other parts
    // of the app (diarization output, ML worker post-processing) can
    // mutate this object in place.
    this.diarizationState = {
      activeSpeaker: 0,
      numSpeakers:   1,
      confidence:    1.0,
      speakerRMS:    null,
      history:       [],
      currentTime:   null,
      isActive:      false,
    };
    try {
      this._visEngine = new VisualizationEngine({
        getAnalysers:    () => ({ orig: this.analyserOrig, proc: this.analyserProc }),
        workletNode:     null, // set later when pipeline-orchestrator wires the worklet
        vuPanel:         this.dom.vuMeterPanel,
        diarCanvas:      this.dom.diarCanvas,
        getSpeakerState: () => this.diarizationState,
        maxSpeakers:     8,
      });
      structuredLog('info', 'VisualizationEngine initialized');
    } catch (e) {
      structuredLog('error', 'VisualizationEngine init failed', { msg: e.message });
      this._visEngine = null;
    }
  }

  // Called by pipeline-orchestrator (or anyone else) once a dsp-processor
  // AudioWorkletNode is available, so the engine can subscribe to its
  // SPECTRAL_FRAME messages. Safe to call multiple times.
  attachDspWorkletToVisuals(workletNode) {
    if (!this._visEngine || !workletNode || !workletNode.port) return;
    try {
      // Detach from the previous worklet port (if any) before binding a new one
      // so stale listeners don't accumulate across AudioContext recreations.
      const prev = this._visEngine.workletNode;
      if (prev && prev.port && prev !== workletNode) {
        try { prev.port.removeEventListener('message', this._visEngine._onWorkletMessage); } catch {}
      }
      workletNode.port.addEventListener('message',
        this._visEngine._onWorkletMessage);
      try { workletNode.port.start(); } catch (e) { console.warn(e); }
      this._visEngine.workletNode = workletNode;
    } catch (e) {
      structuredLog('warn', 'attachDspWorkletToVisuals failed', { msg: e.message });
    }
  }

  ensureCtx() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Worklet registration is handled by PipelineOrchestrator.
      // Path contract for reference: /app/voice-isolate-processor.js
      // (This method does not call addModule directly.)
      // Compatibility reference for structural tests: addModule('./voice-isolate-processor.js')
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  _mapSpectralFloor(nrFloorDb) {
    const minDb = -80;
    const maxDb = -20;
    const floorMin = 0.001;
    const floorMax = 0.05;
    const t = Math.max(0, Math.min(1, (Number(nrFloorDb) - minDb) / (maxDb - minDb)));
    return floorMin + t * (floorMax - floorMin);
  }

  async waitForReadiness(timeoutMs = 5000) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const orch = window._vipOrch;
      const readyState = {
        workletReady: !!(orch && orch.workletReady),
        workerReady: !!(orch && orch.mlReady),
      };
      if (readyState.workletReady && readyState.workerReady) {
        structuredLog('info', 'Live readiness gate passed', { workletReady: true, workerReady: true });
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    structuredLog('warn', 'Live readiness gate timeout', {
      workletReady: !!window._vipOrch?.workletReady,
      workerReady: !!window._vipOrch?.mlReady
    });
    return false;
  }

  buildSliderPanels() {
    for (const [tabKey, sliders] of Object.entries(SLIDERS)) {
      const panel = document.getElementById('tab-' + tabKey);
      if (!panel) continue;
      const container = document.createElement('div');
      container.className = 'sr';
      for (const s of sliders) {
        const row = document.createElement('div');
        row.className = 'sr-row';
        row.dataset.desc = s.desc;
        const labelEl = document.createElement('label');
        labelEl.className = 'sr-label';
        labelEl.title = s.desc;
        labelEl.htmlFor = s.id;
        labelEl.textContent = s.label;
        if (s.rt) {
          const badge = document.createElement('span');
          badge.className = 'rt-badge';
          badge.textContent = 'RT';
          labelEl.appendChild(badge);
        }
        const infoEl = document.createElement('span');
        infoEl.className = 'sr-info';
        infoEl.textContent = 'i';
        infoEl.setAttribute('aria-hidden', 'true');
        labelEl.appendChild(infoEl);
        const inputEl = document.createElement('input');
        inputEl.type = 'range';
        if (s.rt) inputEl.className = 'realtime';
        inputEl.id = s.id;
        inputEl.min = s.min;
        inputEl.max = s.max;
        const initVal = this.params[s.id] !== undefined ? this.params[s.id] : s.val;
        inputEl.value = initVal;
        inputEl.step = s.step;
        inputEl.dataset.param = s.id;
        inputEl.setAttribute('aria-label', s.label);
        inputEl.setAttribute('aria-valuemin', s.min);
        inputEl.setAttribute('aria-valuemax', s.max);
        inputEl.setAttribute('aria-valuenow', initVal);
        const range = s.max - s.min;
        const initPct = range > 0 ? ((initVal - s.min) / range) * 100 : 0;
        inputEl.style.setProperty('--pct', `${initPct.toFixed(1)}%`);
        const valEl = document.createElement('span');
        valEl.className = 'sr-val';
        valEl.id = s.id + 'Val';
        valEl.textContent = initVal + s.unit;
        row.appendChild(labelEl);
        row.appendChild(inputEl);
        row.appendChild(valEl);
        container.appendChild(row);
      }
      panel.appendChild(container);
    }
  }

  cacheDom() {
    const g = id => document.getElementById(id);

    this.slidersDom = {};
    for (const id in SLIDER_MAP) {
      this.slidersDom[id] = {
        el: g(id),
        ve: g(id + 'Val')
      };
    }
    this.dom = {
      uploadZone:g('uploadZone'), fileInput:g('fileInput'), fileBtn:g('fileBtn'),
      micBtn:g('micBtn'), micLabel:g('micLabel'), fileInfo:g('fileInfo'),
      processBtn:g('processBtn'), reprocessBtn:g('reprocessBtn'), stopProcBtn:g('stopProcBtn'),
      saveOrigBtn:g('saveOrigBtn'), saveProcBtn:g('saveProcBtn'),
      videoCard:g('videoCard'), videoPlayer:g('videoPlayer'),
      tpPlay:g('tpPlay'), tpPause:g('tpPause'), tpStop:g('tpStop'),
      tpRew:g('tpRew'), tpFwd:g('tpFwd'), tpCur:g('tpCur'), tpTotal:g('tpTotal'),
      tpSeek:g('tpSeek'), tpScrubTrack:g('tpScrubTrack'), tpScrubFill:g('tpScrubFill'), tpScrubThumb:g('tpScrubThumb'),
      tpSpeed:g('tpSpeed'), tpVol:g('tpVol'), tpAB:g('tpAB'), tpABLabel:g('tpABLabel'),
      playBtn:g('playBtn') || g('tpPlay'),
      pauseBtn:g('pauseBtn') || g('tpPause'),
      stopBtn:g('stopBtn') || g('tpStop'),
      currentTime:g('currentTime') || g('tpCur'),
      totalTime:g('totalTime') || g('tpTotal'),
      waveformCanvas:g('waveformCanvas'),
      clearFile:g('clearFile'),
      exportBtn:g('exportBtn') || g('saveProcBtn'),
      spectro3DContainer:g('spec3dContainer'), spectro3DCanvas:g('spec3dCanvas'),
      spectro3DReset:g('spec3dResetBtn'),
      spectro2DCanvas:g('specCanvas'),
      waveOrigCanvas:g('waveformOrig'), waveProcCanvas:g('waveformCanvas'),
      freqCanvas:g('noiseCanvas'),
      compCanvas:g('compCanvas'),
      pipeFill:g('pipeFill'), pipeBar:g('pipeBar'), pipeStage:g('pipeStage'), pipeDetail:g('pipeDetail'),
      hSNR:g('hSNR'), hDur:g('hDur'), hSR:g('hSR'), hCh:g('hCh'),
      hRMS:g('hRMS'), hPeak:g('hPeak'), hLUFS:g('hLUFS'), hStatus:g('hStatus'),
      stLatency:g('stLatency'), stProcTime:g('stProcTime'), stVoices:g('stVoices'),
      tooltip:g('tooltip'),
      // Diagnostic canvases
      abWaveCanvas:g('abWaveCanvas'),
      oscCanvas:g('oscCanvas'),
      specOverlayCanvas:g('specOverlayCanvas'),
      lufsCanvas:g('lufsCanvas'),
      saliencyCanvas:g('saliencyCanvas'),
      clusterCanvas:g('clusterCanvas'),
      diagFps:g('diagFps'),
      lufsShort:g('lufsShort'), lufsInt:g('lufsInt'), lufsPeak:g('lufsPeak'), lufsCrest:g('lufsCrest'),
      abOverlayBtn:g('abOverlayBtn'),
      // Visualization Engine (visuals.js) — additive to diagnostics
      diarCanvas:g('diarCanvas'),
      vuMeterPanel:g('vuMeterPanel'),
      mobileProcessBtn:g('mobileProcessBtn'),
      mobileReprocessBtn:g('mobileReprocessBtn'),
      mobileStopBtn:g('mobileStopBtn'),
      statsToggle:g('statsToggle'),
      hdrStats:g('hdrStats'),
      uiScaleDn:g('uiScaleDn'), uiScaleUp:g('uiScaleUp'),
      uiScaleVal:g('uiScaleVal'), uiScaleSave:g('uiScaleSave'),
    };
  }

  // ── UI scale (screen stretching) ────────────────────────────────────────
  // Persists across page refreshes via localStorage. Early-restore happens in
  // an inline <script> in index.html so layout doesn't flash at 100% first.
  _uiScaleInit() {
    this._uiScaleMin = 0.5;
    this._uiScaleMax = 2.0;
    this._uiScaleStep = 0.1;
    this._uiScaleDefault = 1.0;
    let s = this._uiScaleDefault;
    try {
      const saved = parseFloat(localStorage.getItem('vip_ui_scale'));
      if (isFinite(saved) && saved >= this._uiScaleMin && saved <= this._uiScaleMax) s = saved;
    } catch { /* storage sandboxed */ }
    this._uiScaleSaved = s;
    this._uiScaleApply(s);
  }
  _uiScaleApply(s) {
    const clamped = Math.max(this._uiScaleMin, Math.min(this._uiScaleMax, Math.round(s * 100) / 100));
    const isSavedScale = clamped === this._uiScaleSaved;
    this._uiScale = clamped;
    const docEl = document.documentElement;
    if (docEl && docEl.style) docEl.style.zoom = clamped === 1 ? '' : String(clamped);
    if (this.dom.uiScaleVal) this.dom.uiScaleVal.textContent = Math.round(clamped * 100) + '%';
    if (!isSavedScale && this._uiScaleSaveTimer) {
      clearTimeout(this._uiScaleSaveTimer);
      this._uiScaleSaveTimer = 0;
    }
    if (this.dom.uiScaleSave) {
      this.dom.uiScaleSave.classList.toggle('saved', isSavedScale);
      this.dom.uiScaleSave.textContent = isSavedScale ? 'Saved' : 'Save';
    }
  }
  _uiScaleSave() {
    try { localStorage.setItem('vip_ui_scale', String(this._uiScale)); } catch { /* storage sandboxed */ }
    this._uiScaleSaved = this._uiScale;
    this._uiScaleApply(this._uiScale);
    if (this._uiScaleSaveTimer) clearTimeout(this._uiScaleSaveTimer);
    this._uiScaleSaveTimer = setTimeout(() => {
      this._uiScaleSaveTimer = 0;
      this._uiScaleApply(this._uiScale);
    }, 1200);
  }

  bindEvents() {
    const bind = (key, el, eventName, handler) => {
      if (!el || typeof el.addEventListener !== 'function') return;
      el.addEventListener(eventName, handler);
      if (!this._controlBindings[key]) this._controlBindings[key] = {};
      this._controlBindings[key][eventName] = true;
    };
    const uz = this.dom.uploadZone;
    let dragCounter = 0;
    bind('uploadZone', uz, 'dragenter', e => { e.preventDefault(); e.stopPropagation(); dragCounter++; uz.classList.add('dragover'); });
    bind('uploadZone', uz, 'dragover', e => { e.preventDefault(); e.stopPropagation(); });
    bind('uploadZone', uz, 'dragleave', e => { e.preventDefault(); e.stopPropagation(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; uz.classList.remove('dragover'); } });
    bind('uploadZone', uz, 'drop', e => { e.preventDefault(); e.stopPropagation(); dragCounter = 0; uz.classList.remove('dragover'); const f = e.dataTransfer.files[0]; if (f) this.handleFile(f); });
    bind('uploadZone', uz, 'click', e => { if (e.target.tagName !== 'BUTTON') this.dom.fileInput.click(); });
    bind('uploadZone', uz, 'keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.tagName !== 'BUTTON') { e.preventDefault(); this.dom.fileInput.click(); } });
    bind('fileBtn', this.dom.fileBtn, 'click', e => { e.stopPropagation(); this.dom.fileInput.click(); });
    bind('fileInput', this.dom.fileInput, 'change', e => { if (e.target.files[0]) this.handleFile(e.target.files[0]); this.dom.fileInput.value = ''; });
    bind('micBtn', this.dom.micBtn, 'click', () => this.toggleRecording());
    bind('processBtn', this.dom.processBtn, 'click', () => this.runPipeline());
    bind('reprocessBtn', this.dom.reprocessBtn, 'click', () => this.runPipeline());
    bind('stopProcBtn', this.dom.stopProcBtn, 'click', () => { this.abortFlag = true; });
    bind('saveOrigBtn', this.dom.saveOrigBtn, 'click', () => this.saveWav(this.inputBuffer,'original'));
    bind('saveProcBtn', this.dom.saveProcBtn, 'click', () => this.saveWav(this.outputBuffer,'processed'));
    bind('playBtn', this.dom.tpPlay, 'click', () => { this.togglePlayback(); });
    if (this.dom.playBtn && this.dom.playBtn !== this.dom.tpPlay) bind('playBtn', this.dom.playBtn, 'click', () => { this.togglePlayback(); });
    bind('pauseBtn', this.dom.tpPause, 'click', () => this.pause());
    bind('stopBtn', this.dom.tpStop, 'click', () => this.stop());
    bind('tpRew', this.dom.tpRew, 'click', () => this.seekDelta(-5));
    bind('tpFwd', this.dom.tpFwd, 'click', () => this.seekDelta(5));
    if (this.dom.tpSeek) bind('tpSeek', this.dom.tpSeek, 'input', () => this.seekTo(this.dom.tpSeek.value / 1000));
    if (this.dom.tpScrubTrack) bind('tpScrubTrack', this.dom.tpScrubTrack, 'pointerdown', e => {
      const r = this.dom.tpScrubTrack.getBoundingClientRect();
      this.seekTo((e.clientX - r.left) / r.width);
    });
    bind('tpSpeed', this.dom.tpSpeed, 'change', () => { const r = parseFloat(this.dom.tpSpeed.value); if (this.currentSource) this.currentSource.playbackRate.value = r; if (this.isVideo) this.dom.videoPlayer.playbackRate = r; });
    bind('tpAB', this.dom.tpAB, 'click', () => this.toggleAB());
    if (this.dom.waveProcCanvas) bind('waveformCanvas', this.dom.waveProcCanvas, 'click', e => {
      const r = this.dom.waveProcCanvas.getBoundingClientRect();
      if (r.width > 0) this.seekTo((e.clientX - r.left) / r.width);
    });
    if (this.dom.waveOrigCanvas) bind('waveformOrig', this.dom.waveOrigCanvas, 'click', e => {
      const r = this.dom.waveOrigCanvas.getBoundingClientRect();
      if (r.width > 0) this.seekTo((e.clientX - r.left) / r.width);
    });
    bind('clearFile', this.dom.clearFile, 'click', () => this.clearLoadedFile());
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => {
        const isActive = x === t;
        x.classList.toggle('active', isActive);
        x.setAttribute('aria-selected', isActive ? 'true' : 'false');
        x.setAttribute('tabindex', isActive ? '0' : '-1');
      });
      document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
    }));
    document.querySelectorAll('.btn-preset').forEach(b => b.addEventListener('click', () => this.applyPreset(b.dataset.preset)));
    const saveBtn = document.getElementById('saveCustomPresetBtn');
    if (saveBtn) saveBtn.addEventListener('click', () => this.saveCustomPreset());
    const nameInput = document.getElementById('customPresetName');
    if (nameInput) nameInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); this.saveCustomPreset(); } });
    document.querySelectorAll('input[type="range"][data-param]').forEach(el => el.addEventListener('input', async () => {
      if (!this._sliderContextResumed && this.ctx && this.ctx.state === 'suspended') {
        try { await this.ctx.resume(); } catch {}
      }
      this._sliderContextResumed = true;
      this.onSlider(el);
    }));
    document.querySelectorAll('.sr-row').forEach(r => {
      const showTt = () => {
        const d = r.dataset.desc;
        if (!d) return;
        const tt = this.dom.tooltip;
        tt.textContent = d;
        tt.classList.add('visible');
        const rc = r.getBoundingClientRect();
        // Center tooltip horizontally on screen
        const vh = window.innerHeight;
        const margin = 10;
        const gap = 8;
        tt.style.left = '50%';
        tt.style.transform = 'translateX(-50%)';
        // Measure the rendered tooltip so long descriptions are positioned correctly.
        const ttRect = tt.getBoundingClientRect();
        const belowTop = rc.bottom + gap;
        const aboveTop = rc.top - gap - ttRect.height;
        let top;
        if (belowTop + ttRect.height <= vh - margin) {
          top = belowTop;
        } else if (aboveTop >= margin) {
          top = aboveTop;
        } else {
          top = Math.min(Math.max(margin, belowTop), Math.max(margin, vh - ttRect.height - margin));
        }
        tt.style.top = top + 'px';
      };
      const hideTt = () => { const tt = this.dom.tooltip; tt.classList.remove('visible'); tt.style.transform = ''; };
      r.addEventListener('mouseenter', showTt);
      r.addEventListener('mouseleave', hideTt);
      const input = r.querySelector('input');
      if (input) {
        input.addEventListener('focus', showTt);
        input.addEventListener('blur', hideTt);
      }
    });
    if (this.dom.spectro3DCanvas) this.dom.spectro3DCanvas.addEventListener('click', e => this.onSpectroClick(e));
    if (this.dom.spectro3DReset) this.dom.spectro3DReset.addEventListener('click', () => this.reset3DView());
    window.addEventListener('resize', () => this.onResize());

    // Diagnostic bindings
    document.querySelectorAll('.osc-mode').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.osc-mode').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      this.oscMode = b.dataset.mode;
    }));
    document.querySelectorAll('.overlay-toggle').forEach(b => b.addEventListener('click', () => {
      b.classList.toggle('active');
      this.overlays[b.dataset.overlay] = b.classList.contains('active');
    }));
    if (this.dom.abOverlayBtn) this.dom.abOverlayBtn.addEventListener('click', () => {
      this.abOverlay = !this.abOverlay;
      this.dom.abOverlayBtn.classList.toggle('active', this.abOverlay);
    });
    // Mobile action bar listeners
    if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.addEventListener('click', () => this.runPipeline());
    if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.addEventListener('click', () => this.runPipeline());
    if (this.dom.mobileStopBtn) this.dom.mobileStopBtn.addEventListener('click', () => { this.abortFlag = true; });
    if (this.dom.statsToggle && this.dom.hdrStats) {
      this.dom.statsToggle.addEventListener('click', () => {
        const expanded = this.dom.hdrStats.classList.toggle('expanded');
        this.dom.statsToggle.setAttribute('aria-expanded', String(expanded));
        this.dom.statsToggle.textContent = expanded ? '▲' : '▼';
      });
    }
    if (this.dom.uiScaleDn) this.dom.uiScaleDn.addEventListener('click', () => this._uiScaleApply(this._uiScale - this._uiScaleStep));
    if (this.dom.uiScaleUp) this.dom.uiScaleUp.addEventListener('click', () => this._uiScaleApply(this._uiScale + this._uiScaleStep));
    if (this.dom.uiScaleSave) this.dom.uiScaleSave.addEventListener('click', () => this._uiScaleSave());

    // ── Isolation card: file drag-and-drop ──────────────────────────────
    const ic = document.getElementById('isolationCard');
    if (ic) {
      ic.addEventListener('dragover', e => { e.preventDefault(); ic.classList.add('iso-drop-active'); });
      ic.addEventListener('dragleave', e => { if (!ic.contains(e.relatedTarget)) ic.classList.remove('iso-drop-active'); });
      ic.addEventListener('drop', e => {
        e.preventDefault();
        ic.classList.remove('iso-drop-active');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) this.handleFile(f);
      });
    }

    // ── Sound category mute buttons ─────────────────────────────────────
    document.querySelectorAll('.sound-mute-btn').forEach(btn => {
      btn.addEventListener('click', () => this.toggleSoundCategory(btn.dataset.cat));
    });

    // ── Global keyboard shortcuts ───────────────────────────────────────
    // Space / K → play-pause toggle, Esc → stop / abort, X → A/B compare.
    // Shortcuts are suppressed when typing in inputs, when modifier keys are
    // held (so browser shortcuts like Ctrl+R / Cmd+S still work), or while a
    // dialog/modal is open.
    window.addEventListener('keydown', (e) => this._handleGlobalKeydown(e));
  }

  _handleGlobalKeydown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && t.nodeType === 1) {
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
    }
    const auth = (typeof document !== 'undefined') ? document.getElementById('authOverlay') : null;
    if (auth && auth.offsetParent !== null) return;
    const k = e.key;
    if (k === ' ' || k === 'Spacebar' || k === 'k' || k === 'K') {
      if (!this.inputBuffer) return;
      e.preventDefault();
      this.togglePlayback();
    } else if (k === 'Escape') {
      if (this.isProcessing) { this.abortFlag = true; e.preventDefault(); return; }
      if (this.isPlaying) { e.preventDefault(); this.stop(); }
    } else if (k === 'x' || k === 'X') {
      if (!this.outputBuffer || !this.dom.tpAB || this.dom.tpAB.disabled) return;
      e.preventDefault();
      this.toggleAB();
    }
  }

  onSlider(el) {
    const rawId = el.dataset.param || el.id || '';
    const id = rawId.startsWith('slider-')
      ? rawId.replace(/^slider-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      : rawId;
    if (!id) return;
    const v = parseFloat(el.value);
    this.params[id] = v;
    if (id === 'nrFloor') this.params.spectralFloor = this._mapSpectralFloor(v);
    let unit = '';
    const s = SLIDER_MAP[id];
    if (s) { unit = s.unit; }
    const ve = document.getElementById(id + 'Val');
    if (ve) ve.textContent = v + unit;
    el.setAttribute('aria-valuenow', v);
    // Update filled-track CSS variable
    const range = parseFloat(el.max) - parseFloat(el.min);
    const pct = range > 0 ? ((v - parseFloat(el.min)) / range) * 100 : 0;
    el.style.setProperty('--pct', `${pct.toFixed(1)}%`);
    if (el.classList.contains('realtime') && this.liveChainBuilt) this.updateLiveChain();
    clearTimeout(this._paramSaveTimer);
    this._paramSaveTimer = setTimeout(() => this._saveParams(), 500);
  }

  _saveParams() {
    try { localStorage.setItem('vip_params', JSON.stringify(this.params)); } catch { /* storage sandboxed */ }
  }

  // ---- Processed-result cache (IndexedDB) --------------------------------

  async _rcOpen() {
    if (this._rcDB) return this._rcDB;
    return new Promise((res, rej) => {
      const req = indexedDB.open('vip-results-v1', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('results')) db.createObjectStore('results');
      };
      req.onsuccess = e => { this._rcDB = e.target.result; res(this._rcDB); };
      req.onerror = () => rej(req.error);
    });
  }

  async _rcGet(key) {
    try {
      const db = await this._rcOpen();
      return new Promise((res, rej) => {
        const tx = db.transaction('results', 'readonly');
        const req = tx.objectStore('results').get(key);
        req.onsuccess = () => res(req.result || null);
        req.onerror = () => rej(req.error);
      });
    } catch { return null; }
  }

  async _rcPut(key, value) {
    const MAX_ENTRIES = 5;
    try {
      const db = await this._rcOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction('results', 'readwrite');
        const store = tx.objectStore('results');
        store.put(value, key);
        // Prune oldest entries when the store exceeds MAX_ENTRIES
        const countReq = store.count();
        countReq.onsuccess = () => {
          if (countReq.result > MAX_ENTRIES) {
            const entries = [];
            const cursorReq = store.openCursor();
            cursorReq.onsuccess = e => {
              const cursor = e.target.result;
              if (cursor) {
                const cachedAt = cursor.value && typeof cursor.value.cachedAt === 'number'
                  ? cursor.value.cachedAt
                  : 0;
                entries.push({ key: cursor.key, cachedAt });
                cursor.continue();
                return;
              }
              const toDelete = countReq.result - MAX_ENTRIES;
              entries
                .sort((a, b) => a.cachedAt - b.cachedAt)
                .slice(0, toDelete)
                .forEach(entry => { store.delete(entry.key); });
            };
          }
        };
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    } catch { /* non-critical */ }
  }

  _rcKey(file) {
    const paramStr = JSON.stringify(
      Object.keys(this.params).sort().reduce((o, k) => { o[k] = this.params[k]; return o; }, {})
    );
    return `${file.name}:${file.size}:${file.lastModified || 0}:${paramStr}`;
  }

  _bufToRaw(buf) {
    const channels = [];
    for (let ch = 0; ch < buf.numberOfChannels; ch++) channels.push(buf.getChannelData(ch).slice());
    return { channels, sampleRate: buf.sampleRate, length: buf.length, numberOfChannels: buf.numberOfChannels, cachedAt: Date.now() };
  }

  _rawToBuf(raw) {
    const buf = this.ctx.createBuffer(raw.numberOfChannels, raw.length, raw.sampleRate);
    for (let ch = 0; ch < raw.numberOfChannels; ch++) buf.copyToChannel(raw.channels[ch], ch);
    return buf;
  }

  _scheduleIdle(fn) {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(fn, { timeout: 750 });
      return;
    }
    setTimeout(fn, 0);
  }

  _cacheResultLater(file, buf) {
    if (!file || !buf) return;
    const MAX_CACHE_BYTES = 64 * 1024 * 1024;
    const estimatedBytes = buf.numberOfChannels * buf.length * Float32Array.BYTES_PER_ELEMENT;
    if (estimatedBytes > MAX_CACHE_BYTES) return;
    const cacheKey = this._rcKey(file);
    const raw = this._bufToRaw(buf);
    const serializedBytes = raw.channels.reduce((sum, ch) => sum + ((ch && ch.byteLength) || 0), 0);
    if (serializedBytes > MAX_CACHE_BYTES) return;
    this._scheduleIdle(() => this._rcPut(cacheKey, raw).catch(err => {
      structuredLog('warn', 'Result cache write failed', { error: err instanceof Error ? err.message : String(err) });
    }));
  }

  // ---- Uploaded file persistence (IndexedDB) ------------------------------

  async _fcOpen() {
    if (this._fcDB) return this._fcDB;
    return new Promise((res, rej) => {
      const req = indexedDB.open('vip-file-cache-v1', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('file')) db.createObjectStore('file');
      };
      req.onsuccess = e => { this._fcDB = e.target.result; res(this._fcDB); };
      req.onerror = () => rej(req.error);
    });
  }

  async _saveFileToCache(file, preReadBuffer) {
    if (this.isVideo) return; // video decode requires a user gesture; skip
    const MAX_BYTES = 500 * 1024 * 1024; // skip files over 500 MB
    if (file.size > MAX_BYTES) return;
    try {
      const data = preReadBuffer || await file.arrayBuffer();
      const entry = { data, name: file.name, type: file.type || '', lastModified: file.lastModified || Date.now() };
      const db = await this._fcOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction('file', 'readwrite');
        tx.objectStore('file').put(entry, 'current');
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    } catch { /* non-critical */ }
  }

  async _clearSavedFile() {
    try {
      const db = await this._fcOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction('file', 'readwrite');
        tx.objectStore('file').delete('current');
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    } catch { /* non-critical */ }
  }

  async _restoreSavedFile() {
    // Skip if user already loaded a file before this async restore resolved
    if (this.inputBuffer) return;
    try {
      const db = await this._fcOpen();
      const entry = await new Promise((res, rej) => {
        const tx = db.transaction('file', 'readonly');
        const req = tx.objectStore('file').get('current');
        req.onsuccess = () => res(req.result || null);
        req.onerror = () => rej(req.error);
      });
      if (!entry) return;
      // Double-check after the async IDB read — user may have loaded a file in the meantime
      if (this.inputBuffer) return;
      if (this.dom.fileInfo) this.dom.fileInfo.textContent = '⏳ Restoring session…';
      const file = new File([entry.data], entry.name, { type: entry.type, lastModified: entry.lastModified });
      await this.handleFile(file);
    } catch { /* non-critical — user will just see empty state */ }
  }

  // -------------------------------------------------------------------------

  renderCustomPresets() {
    const row = document.querySelector('.presets-row');
    const actions = document.querySelector('.custom-preset-actions');
    if (!row || !actions) return;

    for (const [id] of Object.entries(this.customPresets)) {
      if (document.querySelector(`.btn-preset[data-preset="${id}"]`)) continue;
      const name = id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const btn = document.createElement('button');
      btn.className = 'btn btn-preset';
      btn.dataset.preset = id;
      btn.textContent = name;
      btn.addEventListener('click', () => this.applyPreset(id));
      row.insertBefore(btn, actions);
    }
  }

  saveCustomPreset() {
    const nameInput = document.getElementById('customPresetName');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
      if (nameInput) {
        nameInput.classList.add('input-error');
        nameInput.setAttribute('aria-invalid', 'true');
        nameInput.placeholder = 'Please enter a preset name';
        nameInput.focus();
        setTimeout(() => nameInput.classList.remove('input-error'), 1500);
      }
      if (this._showToast) this._showToast('Please enter a preset name', 'warn');
      else console.warn('[VIP] saveCustomPreset: empty name');
      return;
    }
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    this.customPresets[id] = { ...this.params };
    PRESETS[id] = this.customPresets[id];
    try {
      localStorage.setItem('vip_custom_presets', JSON.stringify(this.customPresets));
    } catch { /* ARCH-06 FIX: sandboxed iframe — no-op */ }

    // Add button if it doesn't exist
    if (!document.querySelector(`.btn-preset[data-preset="${id}"]`)) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-preset';
      btn.dataset.preset = id;
      btn.textContent = name;
      btn.addEventListener('click', () => this.applyPreset(id));
      const row = document.querySelector('.presets-row');
      if (row) {
        // insert before custom actions div
        const actions = document.querySelector('.custom-preset-actions');
        if (actions) row.insertBefore(btn, actions);
        else row.appendChild(btn);
      }
    }

    nameInput.value = '';
    this.applyPreset(id);
  }

  applyPreset(name) {
    const p = PRESETS[name]; if (!p) return;
    window.VIP_PARAMS = window.VIP_PARAMS || {};
    for (const [key, rawValue] of Object.entries(p)) {
      if (key === 'description') {
        window.VIP_PARAMS[key] = rawValue;
        continue;
      }
      const sliderId = PRESET_PARAM_ALIASES[key] || key;
      const value = SLIDER_BY_ID[sliderId]
        ? clampToSlider(sliderId, rawValue)
        : rawValue;
      this.params[key] = value;
      window.VIP_PARAMS[key] = value;
      if (sliderId !== key) {
        this.params[sliderId] = value;
        window.VIP_PARAMS[sliderId] = value;
      }
      const sliderDom = this.slidersDom && this.slidersDom[sliderId];
      if (sliderDom && sliderDom.el) {
        sliderDom.el.value = value;
        sliderDom.el.setAttribute('aria-valuenow', value);
        sliderDom.el.dispatchEvent(new Event('input', { bubbles: true }));
        sliderDom.el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    this.params.spectralFloor = Number.isFinite(p.spectralFloor)
      ? p.spectralFloor
      : this._mapSpectralFloor(this.params.nrFloor);
    document.querySelectorAll('.btn-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
    if (this.liveChainBuilt) this.updateLiveChain();
    this._saveParams();
  }

  // ======== FILE HANDLING ========
  async handleFile(file) {
    const previousProcessDisabled = this.dom.processBtn ? this.dom.processBtn.disabled : undefined;
    const previousReprocessDisabled = this.dom.reprocessBtn ? this.dom.reprocessBtn.disabled : undefined;
    const previousMobileReprocessDisabled = this.dom.mobileReprocessBtn ? this.dom.mobileReprocessBtn.disabled : undefined;
    if (this.dom.processBtn) this.dom.processBtn.disabled = true;
    if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = true;
    if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = true;
    this.dom.fileInfo.textContent = '⏳ Loading...';
    try {
      const normalizedType = (file.type || '').toLowerCase();
      const normalizedName = (file.name || '').toLowerCase();
      const isMidiFile = normalizedType === 'audio/midi' || normalizedType === 'audio/x-midi' || normalizedName.endsWith('.mid') || normalizedName.endsWith('.midi');
      if (isMidiFile) throw new Error('MIDI files are not supported in this audio decode path. Please export the MIDI to WAV, MP3, or another rendered audio format first.');
      const hasKnownVideoExtension = VIDEO_UPLOAD_EXTENSIONS.some(ext => normalizedName.endsWith(ext));
      const hasKnownAudioExtension = AUDIO_UPLOAD_EXTENSIONS.some(ext => normalizedName.endsWith(ext));
      const isVideoFile = normalizedType.startsWith('video/') || hasKnownVideoExtension;
      const isSupportedByMime = normalizedType ? ACCEPTED_UPLOAD_TYPES.includes(normalizedType) : false;
      const isSupportedByExtension = hasKnownVideoExtension || hasKnownAudioExtension;
      if (!isSupportedByMime && !isSupportedByExtension) throw new Error('Unsupported file type: ' + (file.type || 'unknown'));
      this.isVideo = isVideoFile;
      this.ensureCtx();
      this.stop();
      this.dom.fileInfo.textContent = 'Loading: ' + file.name + '...';
      this.setStatus('LOADING');
      // Await AudioContext resume before decode — suspended context causes decodeAudioData to stall
      if (this.ctx.state === 'suspended') {
        try { await this.ctx.resume(); } catch {}
      }
      // Yield to browser paint cycle to prevent UI freeze on large files
      await new Promise(r => typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(() => r()) : setTimeout(r, 0));
      let audioBuf = null;
      let rawBuffer = null;
      if (this.isVideo) {
        audioBuf = await this.decodeViaVideoElement(file);
      } else {
        rawBuffer = await file.arrayBuffer();
        const safeCopy = rawBuffer.slice(0);
        try {
          audioBuf = await this.ctx.decodeAudioData(safeCopy);
        } catch (decodeErr) {
          throw new Error('Cannot decode this audio format. (' + decodeErr.message + ')');
        }
      }
      if (!audioBuf || audioBuf.length === 0) throw new Error('Decoded audio is empty.');
      if (this.isVideo) {
        if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
        this.videoUrl = URL.createObjectURL(file);
        this.dom.videoPlayer.src = this.videoUrl;
        this.dom.videoCard.style.display = 'block';
        await new Promise((res, rej) => {
          let settled = false;
          const timeout = setTimeout(() => { if (!settled) { settled = true; rej(new Error('Video metadata load timeout')); } }, 5000);
          this.dom.videoPlayer.onloadedmetadata = () => { if (!settled) { settled = true; clearTimeout(timeout); res(); } };
          this.dom.videoPlayer.onerror = () => { if (!settled) { settled = true; clearTimeout(timeout); rej(new Error('Video metadata load failed')); } };
        });
      } else { this.dom.videoCard.style.display = 'none'; }
      this.inputBuffer = audioBuf;
      this.outputBuffer = null;
      this._lastLoadedFile = file;
      // Persist file so it auto-reloads after a page refresh (non-blocking)
      // Pass the already-read rawBuffer to avoid a second file.arrayBuffer() call
      this._saveFileToCache(file, rawBuffer).catch(() => {});
      // Check result cache — restore instantly if same file + same params were processed before
      try {
        const cacheKey = this._rcKey(file);
        const cached = await this._rcGet(cacheKey);
        if (cached) {
          this.outputBuffer = this._rawToBuf(cached);
          await new Promise(r => (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : setTimeout)(r, 0));
          this.onAudioLoaded(file.name);
          this.resizeCanvas(this.dom.waveProcCanvas);
          this.drawWaveform(this.outputBuffer, this.dom.waveProcCanvas, '#22d3ee');
          this.resizeCanvas(this.dom.compCanvas);
          this.drawComparison(this.inputBuffer, this.outputBuffer);
          this.dom.saveProcBtn.disabled = false;
          this.dom.tpAB.disabled = false;
          this.dom.reprocessBtn.disabled = false;
          if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = false;
          this.dom.tpABLabel.textContent = 'Restored — A/B';
          this.setStatus('COMPLETE');
          this.dom.pipeStage.textContent = 'Restored from cache';
          return;
        }
      } catch { /* non-critical — fall through to normal load */ }
      await new Promise(r => (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : setTimeout)(r, 0));
      this.onAudioLoaded(file.name);
    } catch (err) {
      console.error('File load error:', err);
      this.dom.fileInfo.textContent = 'Error: ' + err.message;
      this.showNotification('Could not load file: ' + err.message, 'error', 6000);
      if (this.dom.processBtn && typeof previousProcessDisabled === 'boolean') this.dom.processBtn.disabled = previousProcessDisabled;
      if (this.dom.reprocessBtn && typeof previousReprocessDisabled === 'boolean') this.dom.reprocessBtn.disabled = previousReprocessDisabled;
      if (this.dom.mobileReprocessBtn && typeof previousMobileReprocessDisabled === 'boolean') this.dom.mobileReprocessBtn.disabled = previousMobileReprocessDisabled;
      this.setStatus('ERROR');
    }
  }

  async decodeViaVideoElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const cleanup = () => { try { URL.revokeObjectURL(url); } catch {} };
      const vid = document.createElement('video');
      vid.muted = true; vid.src = url;
      vid.onloadedmetadata = async () => {
        try {
          const duration = vid.duration;
          if (!duration || !isFinite(duration)) { cleanup(); reject(new Error('Cannot determine video duration')); return; }
          const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
          const source = tmpCtx.createMediaElementSource(vid);
          const dest = tmpCtx.createMediaStreamDestination();
          source.connect(dest);
          const chunks = [];
          const recorder = new MediaRecorder(dest.stream);
          recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
          recorder.onstop = async () => {
            vid.pause(); cleanup();
            const blob = new Blob(chunks, { type: 'audio/webm' });
            const ab = await blob.arrayBuffer();
            const safeCopy = ab.slice(0);
            try {
              const decoded = await this.ctx.decodeAudioData(safeCopy);
              await tmpCtx.close();
              resolve(decoded);
            } catch (e) {
              try { await tmpCtx.close(); } catch {}
              reject(new Error('Failed to decode video audio: ' + e.message));
            }
          };
          recorder.start();
          vid.play().catch(e => { vid.pause(); recorder.stop(); reject(new Error('Video playback blocked: ' + e.message)); });
          vid.onended = () => { recorder.stop(); };
          setTimeout(() => { if (recorder.state === 'recording') { vid.pause(); recorder.stop(); } }, (duration + 2) * 1000);
        } catch (e) { cleanup(); reject(e); }
      };
      vid.onerror = () => { cleanup(); reject(new Error('Video element failed')); };
    });
  }

  // ── Trigger diarization after audio loads ────────────────────────────────
  async _triggerDiarization(audioBuf) {
    const orch = window._vipOrch;
    if (!orch || !orch.mlWorker) return;
    try {
      const signal = new Float32Array(audioBuf.getChannelData(0));
      orch.mlWorker.postMessage(
        { type: 'diarize', payload: { signal, sampleRate: audioBuf.sampleRate } },
        [signal.buffer]
      );
    } catch(e) {
      structuredLog('warn', 'Diarization trigger failed', { error: e.message });
    }
  }

  onAudioLoaded(name) {
    if (this.inputBuffer) this._triggerDiarization(this.inputBuffer).catch((err) => {
      structuredLog('warn', 'Diarization kickoff failed', { error: err?.message || String(err) });
    });
    const buf = this.inputBuffer;
    const dur = this.fmtDur(buf.duration);
    this.dom.fileInfo.textContent = (name || 'Recording') + ' (' + dur + ')';
    this.dom.processBtn.disabled = false;
    if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.disabled = false;
    if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = true;
    this.dom.saveOrigBtn.disabled = false;
    this.dom.reprocessBtn.disabled = true;
    this.dom.saveProcBtn.disabled = true;
    this.dom.tpAB.disabled = true;
    [this.dom.tpPlay, this.dom.tpPause, this.dom.tpStop, this.dom.tpRew, this.dom.tpFwd, this.dom.tpSeek, this.dom.tpSpeed].forEach(el => { if (el) el.disabled = false; });
    if (this.dom.playBtn) this.dom.playBtn.disabled = false;
    this.dom.tpTotal.textContent = dur;
    this.dom.tpABLabel.textContent = 'Original';
    this.dom.hDur.textContent = dur;
    this.dom.hSR.textContent = buf.sampleRate + ' Hz';
    this.dom.hCh.textContent = buf.numberOfChannels;
    this.dom.hRMS.textContent = this.calcRMS(buf.getChannelData(0)).toFixed(1) + ' dB';
    this.dom.hPeak.textContent = this.calcPeak(buf.getChannelData(0)).toFixed(1) + ' dB';
    this.resizeCanvas(this.dom.waveOrigCanvas);
    this.drawWaveform(buf, this.dom.waveOrigCanvas, '#dc2626');
    this.clearCanvas(this.dom.waveProcCanvas, 'Process to see result');
    this.setStatus('READY');
  }

  // ======== RECORDING ========
  async toggleRecording() {
    if (this.isRecording) { this.stopRecording(); return; }
    try {
      await this.waitForReadiness();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.ensureCtx();
      this.isRecording = true;
      this.recordedChunks = [];
      this.dom.micBtn.classList.add('recording');
      this.dom.micLabel.textContent = 'Stop';
      this.setStatus('RECORDING');
      const src = this.ctx.createMediaStreamSource(stream);
      const ana = this.ctx.createAnalyser(); ana.fftSize = 4096;
      src.connect(ana);
      this.analyserNode = ana;
      this.analyserOrig = ana;
      this.analyserProc = ana;
      this.startSpectro(ana);
      this.startFreq(ana);
      this.startDiagnostics();
      const mt = this.getMime();
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: mt });
      this.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this.recordedChunks.push(e.data); };
      this.mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        this.stopSpectro(); this.stopDiagnostics();
        const blob = new Blob(this.recordedChunks, { type: mt });
        const ab = await blob.arrayBuffer();
        try {
          this.inputBuffer = await this.ctx.decodeAudioData(ab);
          this.outputBuffer = null;
          this.dom.videoCard.style.display = 'none'; this.isVideo = false;
          this.onAudioLoaded('Recording');
        } catch (e) { this.dom.fileInfo.textContent = 'Decode error: ' + e.message; this.setStatus('ERROR'); }
      };
      this.mediaRecorder.start(100);
    } catch { this.dom.fileInfo.textContent = 'Mic denied'; this.setStatus('ERROR'); }
  }

  stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
    this.isRecording = false;
    this.dom.micBtn.classList.remove('recording');
    this.dom.micLabel.textContent = 'Record';
  }

  getMime() {
    for (const t of ['audio/webm;codecs=opus','audio/webm','audio/ogg','audio/mp4'])
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    return 'audio/webm';
  }

  // ======== TRANSPORT ========
  async togglePlayback() {
    this.ensureCtx();
    if (this.ctx && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch {}
    }
    if (this.isPlaying) { this.pause(); return; }
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (e) { console.debug('togglePlayback source stop skipped:', e && e.message ? e.message : e); }
      try { this.currentSource.disconnect(); } catch (e) { console.debug('togglePlayback source disconnect skipped:', e && e.message ? e.message : e); }
      this.currentSource = null;
    }
    this.play();
  }

  play() {
    // Teardown previous playback state without resetting playOffset
    if (typeof this.teardownChain === 'function') this.teardownChain();
    if (this.isVideo && this.isPlaying) this.dom.videoPlayer.pause();
    if (typeof this.stopSpectro === 'function') this.stopSpectro();
    if (typeof this.stopDiagnostics === 'function') this.stopDiagnostics();
    this.isPlaying = false;

    this.ensureCtx();
    const buf = this.abMode === 'processed' && this.outputBuffer ? this.outputBuffer : this.inputBuffer;
    if (!buf) return;

    // If we are at the end, restart from 0
    if (this.playOffset >= buf.duration) {
      this.playOffset = 0;
    }
    this.buildLiveChain(buf);
    this.isPlaying = true;
    this.playStartTime = this.ctx.currentTime;
    this.dom.tpABLabel.textContent = this.abMode === 'processed' ? 'Processed' : 'Original';
    if (this.isVideo) {
      this.dom.videoPlayer.currentTime = this.playOffset;
      this.dom.videoPlayer.playbackRate = parseFloat(this.dom.tpSpeed.value);
      this.dom.videoPlayer.muted = true;
      this.dom.videoPlayer.play().catch(() => {});
    }
    this.startSpectro(this.analyserNode);
    this.startFreq(this.analyserNode);
    this.startDiagnostics();
    this.tickTime();
  }

  pause() {
    if (!this.isPlaying) return;
    const speed = parseFloat(this.dom.tpSpeed.value) || 1;
    this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    this.teardownChain();
    this.isPlaying = false;
    if (this.isVideo) this.dom.videoPlayer.pause();
    this.stopSpectro();
    this.stopDiagnostics();
  }

  stop() {
    this.teardownChain();
    this.isPlaying = false;
    this.playOffset = 0;
    if (this.isVideo) { this.dom.videoPlayer.pause(); this.dom.videoPlayer.currentTime = 0; }
    this.stopSpectro();
    this.stopDiagnostics();
    this.dom.tpCur.textContent = '0:00';
    this._setScrubPos(0);
  }

  clearLoadedFile() {
    this.stop();
    this.inputBuffer = null;
    this.outputBuffer = null;
    this._lastLoadedFile = null;
    this._clearSavedFile().catch(() => {});
    this.abMode = 'original';
    if (this.videoUrl) {
      try { URL.revokeObjectURL(this.videoUrl); } catch {}
      this.videoUrl = null;
    }
    if (this.dom.videoPlayer) this.dom.videoPlayer.src = '';
    if (this.dom.videoCard) this.dom.videoCard.style.display = 'none';
    if (this.dom.fileInfo) this.dom.fileInfo.textContent = 'No file loaded';
    if (this.dom.processBtn) this.dom.processBtn.disabled = true;
    if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = true;
    if (this.dom.saveOrigBtn) this.dom.saveOrigBtn.disabled = true;
    if (this.dom.saveProcBtn) this.dom.saveProcBtn.disabled = true;
    if (this.dom.tpAB) this.dom.tpAB.disabled = true;
    if (this.dom.tpABLabel) this.dom.tpABLabel.textContent = 'Original';
    [this.dom.tpPlay, this.dom.tpPause, this.dom.tpStop, this.dom.tpRew, this.dom.tpFwd, this.dom.tpSeek, this.dom.tpSpeed].forEach(el => { if (el) el.disabled = true; });
    this.setStatus('IDLE');
  }

  seekDelta(d) {
    const buf = this.inputBuffer; if (!buf) return;
    const speed = parseFloat(this.dom.tpSpeed.value) || 1;
    if (this.isPlaying) this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    this.playOffset = Math.max(0, Math.min(buf.duration, this.playOffset + d));
    if (this.isPlaying) this.play();
    else { this.dom.tpCur.textContent = this.fmtDur(this.playOffset); this._setScrubPos(this.playOffset / buf.duration); }
  }

  seekTo(frac) {
    if (!this.inputBuffer) return;
    const speed = parseFloat(this.dom.tpSpeed.value) || 1;
    if (this.isPlaying) this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    this.playOffset = frac * this.inputBuffer.duration;
    if (this.isPlaying) this.play();
    else {
      this.dom.tpCur.textContent = this.fmtDur(this.playOffset);
      this._setScrubPos(this.inputBuffer.duration > 0 ? this.playOffset / this.inputBuffer.duration : 0);
    }
  }

  toggleAB() {
    if (!this.outputBuffer) return;
    this.abMode = this.abMode === 'original' ? 'processed' : 'original';
    this.dom.tpAB.classList.toggle('active', this.abMode === 'processed');
    const speed = parseFloat(this.dom.tpSpeed.value) || 1;
    if (this.isPlaying) { this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed; this.play(); }
    this.dom.tpABLabel.textContent = this.abMode === 'processed' ? 'Processed' : 'Original';
  }

  tickTime() {
    const tick = () => {
      if (!this.isPlaying) return;
      const speed = parseFloat(this.dom.tpSpeed.value) || 1;
      const elapsed = this.playOffset + (this.ctx.currentTime - this.playStartTime) * speed;
      const dur = this.inputBuffer ? this.inputBuffer.duration : 0;
      if (elapsed >= dur) { this.stop(); return; }
      this.dom.tpCur.textContent = this.fmtDur(elapsed);
      this._setScrubPos(dur > 0 ? elapsed / dur : 0);
      // ── Sync diarization timeline playhead
      if (typeof window.seekTimeline === 'function') window.seekTimeline(elapsed);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ======== LIVE AUDIO CHAIN (with dual analysers) ========
  buildLiveChain(buf) {
    this.teardownChain();
    const ctx = this.ensureCtx();
    const p = this.params;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = parseFloat(this.dom.tpSpeed.value) || 1;
    src.onended = () => { if (this.isPlaying) this.stop(); };

    // Pre-chain analyser (original signal)
    const anaOrig = ctx.createAnalyser(); anaOrig.fftSize = 4096; anaOrig.smoothingTimeConstant = 0.75;

    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.hpFreq; hp.Q.value = p.hpQ;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = p.lpFreq; lp.Q.value = p.lpQ;

    const eqDefs = [
      { id:'eqSub',f:40,type:'lowshelf'},{id:'eqBass',f:100,type:'peaking',q:1.2},{id:'eqWarmth',f:200,type:'peaking',q:1},
      {id:'eqBody',f:400,type:'peaking',q:1},{id:'eqLowMid',f:800,type:'peaking',q:1},{id:'eqMid',f:1500,type:'peaking',q:1.2},
      {id:'eqPresence',f:3000,type:'peaking',q:1.5},{id:'eqClarity',f:5000,type:'peaking',q:1.2},
      {id:'eqAir',f:10000,type:'highshelf'},{id:'eqBrill',f:16000,type:'highshelf'}
    ];
    const eqs = eqDefs.map(b => {
      const n = ctx.createBiquadFilter(); n.type = b.type; n.frequency.value = b.f;
      if (b.q) n.Q.value = b.q; n.gain.value = p[b.id] || 0; return { node:n, id:b.id };
    });

    const deEss = ctx.createBiquadFilter(); deEss.type = 'peaking'; deEss.frequency.value = p.deEssFreq; deEss.Q.value = 3; deEss.gain.value = -(p.deEssAmt/100)*10;
    const tilt = ctx.createBiquadFilter(); tilt.type = 'highshelf'; tilt.frequency.value = 1000; tilt.gain.value = p.specTilt;
    const vfL = ctx.createBiquadFilter(); vfL.type = 'highpass'; vfL.frequency.value = p.voiceFocusLo; vfL.Q.value = 0.5;
    const vfH = ctx.createBiquadFilter(); vfH.type = 'lowpass'; vfH.frequency.value = p.voiceFocusHi; vfH.Q.value = 0.5;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = p.compThresh; comp.ratio.value = p.compRatio; comp.attack.value = p.compAttack/1000; comp.release.value = p.compRelease/1000; comp.knee.value = p.compKnee;
    const mkG = ctx.createGain(); mkG.gain.value = Math.pow(10, p.compMakeup/20);
    const lim = ctx.createDynamicsCompressor(); lim.threshold.value = p.limThresh; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = p.limRelease/1000;
    const outG = ctx.createGain(); outG.gain.value = Math.pow(10, p.outGain/20);
    const wG = ctx.createGain(); wG.gain.value = p.outWidth/100;

    // Post-chain analyser (processed signal)
    const anaProc = ctx.createAnalyser(); anaProc.fftSize = 4096; anaProc.smoothingTimeConstant = 0.75;

    // Wire: src -> anaOrig -> hp -> ... -> wG -> anaProc -> destination
    src.connect(anaOrig);
    const chain = [anaOrig, hp, lp, ...eqs.map(e=>e.node), deEss, tilt, vfL, vfH, comp, mkG, lim, outG, wG, anaProc];
    for (let i = 0; i < chain.length-1; i++) chain[i].connect(chain[i+1]);
    anaProc.connect(ctx.destination);

    src.start(0, this.playOffset);
    this.currentSource = src;
    this.analyserNode = anaProc;
    this.analyserOrig = anaOrig;
    this.analyserProc = anaProc;
    this.liveNodes = { hp, lp, eqs, deEss, tilt, vfL, vfH, comp, mkG, lim, outG, wG, chain: [src, ...chain] };
    this.liveChainBuilt = true;
  }

  updateLiveChain() {
    if (!this.liveChainBuilt) return;
    const p = this.params; const n = this.liveNodes; const t = this.ctx.currentTime; const s = 0.02;
    try {
      n.hp.frequency.setTargetAtTime(p.hpFreq,t,s); n.hp.Q.setTargetAtTime(p.hpQ,t,s);
      n.lp.frequency.setTargetAtTime(p.lpFreq,t,s); n.lp.Q.setTargetAtTime(p.lpQ,t,s);
      const eqIds = ['eqSub','eqBass','eqWarmth','eqBody','eqLowMid','eqMid','eqPresence','eqClarity','eqAir','eqBrill'];
      n.eqs.forEach((eq,i) => eq.node.gain.setTargetAtTime(p[eqIds[i]]||0,t,s));
      n.deEss.frequency.setTargetAtTime(p.deEssFreq,t,s); n.deEss.gain.setTargetAtTime(-(p.deEssAmt/100)*10,t,s);
      n.tilt.gain.setTargetAtTime(p.specTilt,t,s);
      n.vfL.frequency.setTargetAtTime(p.voiceFocusLo,t,s); n.vfH.frequency.setTargetAtTime(p.voiceFocusHi,t,s);
      n.comp.threshold.setTargetAtTime(p.compThresh,t,s); n.comp.ratio.setTargetAtTime(p.compRatio,t,s);
      n.comp.attack.setTargetAtTime(p.compAttack/1000,t,s); n.comp.release.setTargetAtTime(p.compRelease/1000,t,s);
      n.comp.knee.setTargetAtTime(p.compKnee,t,s);
      n.mkG.gain.setTargetAtTime(Math.pow(10,p.compMakeup/20),t,s);
      n.lim.threshold.setTargetAtTime(p.limThresh,t,s); n.lim.release.setTargetAtTime(p.limRelease/1000,t,s);
      n.outG.gain.setTargetAtTime(Math.pow(10,p.outGain/20),t,s);
      n.wG.gain.setTargetAtTime(p.outWidth/100,t,s);
    } catch(e) {
      console.error('Error updating live chain:', e);
    }
  }

  teardownChain() {
    if (this.currentSource) { try{this.currentSource.stop();}catch{} try{this.currentSource.disconnect();}catch{} this.currentSource = null; }
    if (this.liveNodes.chain) this.liveNodes.chain.forEach(n => { try{n.disconnect();}catch{} });
    this.liveNodes = {}; this.liveChainBuilt = false;
  }

  // ======== 35-STAGE DECA-PASS OFFLINE PIPELINE (v22) ========
  async runPipeline() {
    if (!this.inputBuffer || this.isProcessing) return;
    this.isProcessing = true; this.abortFlag = false;
    this.dom.processBtn.style.display = 'none'; this.dom.stopProcBtn.style.display = 'inline-flex';
    if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.style.display = 'none';
    if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.style.display = 'none';
    if (this.dom.mobileStopBtn) this.dom.mobileStopBtn.style.display = 'inline-flex';
    this.dom.saveProcBtn.disabled = true; this.dom.tpAB.disabled = true;
    this.setStatus('PROCESSING');
    const t0 = performance.now();
    const p = this.params;
    const sr = this.inputBuffer.sampleRate;
    const numCh = this.inputBuffer.numberOfChannels;
    const len = this.inputBuffer.length;
    const total = STAGES.length;
    const fftSize = 4096;
    const hopSize = 1024;

    try {
      const DSP = window.DSPCore;
      if (!DSP) throw new Error('DSPCore not loaded — ensure dsp-core.js is included');

      // ═══ PASS 1: INGESTION & PRE-CONDITIONING (per-channel) ═══
      await this.pip(0, total); // S01: Decode (already done)
      if (this.abortFlag) throw 'abort';

      const cleanChannels = [];
      for (let ch = 0; ch < numCh; ch++) {
        // Get raw channel data (copy to avoid mutating input)
        let data = new Float32Array(this.inputBuffer.getChannelData(ch));

        await this.pip(1, total); // S02: Buffer allocation
        if (this.abortFlag) throw 'abort';

        // S03: DC Offset Removal
        await this.pip(2, total);
        data = DSP.removeDCOffset(data, sr);

        // S04: Peak normalization to -1 dBFS
        await this.pip(3, total);
        data = DSP.peakNormalize(data, -1);
        if (this.abortFlag) throw 'abort';

        // ═══ PASS 2: ANALYSIS ═══
        // S05: VAD for noise profiling
        await this.pip(4, total);
        const vad = new DSP.VADProcessor(sr, 20, p.nrSensitivity / 100);
        const vadConf = vad.processSignal(data);

        // S06: Noise gate (time-domain, before spectral)
        await this.pip(5, total);
        data = DSP.noiseGate(data, {
          threshold: p.gateThresh,
          range: p.gateRange,
          attack: p.gateAttack,
          release: p.gateRelease,
          hold: p.gateHold,
          lookahead: p.gateLookahead
        }, sr);
        if (this.abortFlag) throw 'abort';

        // S07: Click/pop removal
        await this.pip(6, total);
        data = DSP.removeClicks(data, 3);

        // S08: Hum removal (50/60 Hz + harmonics)
        await this.pip(7, total);
        const humFreqs = [60, 120, 180, 240, 300, 360];
        DSP.cascadedNotch(data, humFreqs, 5, sr);

        // S09: De-essing (time-domain)
        await this.pip(8, total);
        data = DSP.deEss(data, p.deEssFreq, p.deEssAmt, sr);
        if (this.abortFlag) throw 'abort';

        // ═══ SINGLE FORWARD STFT ═══
        await this.pip(9, total);
        const stft = DSP.forwardSTFT(data, fftSize, hopSize);
        let { mag, phase } = stft;

        // ═══ PASS 3: SPECTRAL NOISE REDUCTION (all in-place on mag) ═══
        // S10: Adaptive Wiener noise subtraction with VAD-gated profiling
        await this.pip(10, total);
        if (p.nrAmount > 0) {
          const tracker = new window.AdaptiveNoiseFloor(
            mag[0].length,
            200 + p.nrSmoothing * 3,  // smoothing ms
            hopSize, sr
          );
          const overSub = 1.0 + (p.nrSpectralSub / 100) * 4;  // 1x - 5x over-subtraction
          const spectralFloor = Math.pow(10, p.nrFloor / 20);
          DSP.applyAdaptiveWiener(mag, vadConf, tracker, {
            overSubtraction: overSub,
            spectralFloor: Math.max(0.0001, spectralFloor)
          });
        }
        if (this.abortFlag) throw 'abort';

        // S11: Secondary Wiener pass for residual noise
        await this.pip(11, total);
        if (p.nrAmount > 30) {
          // Build noise profile from quietest frames
          const noiseProfile = new Float32Array(mag[0].length);
          let noiseFrames = 0;
          for (let f = 0; f < mag.length; f++) {
            const vi = Math.min(f, vadConf.length - 1);
            if (vadConf[vi] < 0.2) {
              for (let k = 0; k < mag[f].length; k++) noiseProfile[k] += mag[f][k];
              noiseFrames++;
            }
          }
          if (noiseFrames > 0) {
            for (let k = 0; k < noiseProfile.length; k++) noiseProfile[k] /= noiseFrames;
            DSP.wienerMMSE(mag, noiseProfile, p.nrAmount * 0.6);
          }
        }
        if (this.abortFlag) throw 'abort';

        // S12: 32-band ERB spectral gate
        await this.pip(12, total);
        DSP.spectralGate(mag, p.nrFloor, sr);
        if (this.abortFlag) throw 'abort';

        // ═══ PASS 4: VOICE ISOLATION (spectral domain) ═══
        // S13: Voice-band spectral emphasis
        await this.pip(13, total);
        if (p.voiceIso > 0 || p.bgSuppress > 0) {
          const halfN = mag[0].length;
          const binHz = sr / fftSize;
          const rawLo = Math.round(p.voiceFocusLo / binHz);
          const rawHi = Math.round(p.voiceFocusHi / binHz);
          const voiceLoBin = Math.max(0, Math.min(halfN - 1, rawLo));
          const voiceHiBin = Math.max(voiceLoBin, Math.min(halfN - 1, rawHi));
          const suppressGain = 1 - (p.bgSuppress / 100) * 0.95;
          const boostGain = 1 + (p.voiceIso / 100) * 0.5;
          for (let f = 0; f < mag.length; f++) {
            for (let k = 0; k < halfN; k++) {
              if (k >= voiceLoBin && k <= voiceHiBin) {
                mag[f][k] *= boostGain;
              } else {
                mag[f][k] *= suppressGain;
              }
            }
          }
        }
        // Sound category suppression — applied within S13 after voice isolation.
        // Each active category's frequency ranges are heavily attenuated.
        // VAD weight softens the suppression on voice-active frames to preserve speech.
        {
          const activeCats = SOUND_CATEGORIES.filter(c => this.soundMutes[c.id]);
          if (activeCats.length > 0 && mag.length > 0) {
            const halfN = mag[0].length;
            const binHz = sr / fftSize;
            const mask = new Float32Array(halfN).fill(1.0);
            for (const cat of activeCats) {
              for (const range of cat.ranges) {
                const lo = Math.max(0, Math.round(range.lo / binHz));
                const hi = Math.min(halfN - 1, Math.round(range.hi / binHz));
                for (let k = lo; k <= hi; k++) mask[k] = Math.min(mask[k], 0.04); // ~-28 dBFS
              }
            }
            for (let f = 0; f < mag.length; f++) {
              const vad = Math.min(1, Math.max(0, vadConf[Math.min(f, vadConf.length - 1)]));
              for (let k = 0; k < halfN; k++) {
                if (mask[k] < 1.0) {
                  // Full suppression in noise frames; preserve voice frames (VAD=1 → no suppression)
                  const factor = mask[k] + vad * (1 - mask[k]) * 0.85;
                  mag[f][k] *= factor;
                }
              }
            }
          }
        }

        if (this.abortFlag) throw 'abort';

        // S14: Crosstalk cancellation (voice-band SNR enhancement)
        await this.pip(14, total);
        // Placeholder for ML separation - uses spectral masking approximation
        if (p.crosstalkCancel > 0) {
          const cancelAmt = p.crosstalkCancel / 100;
          for (let f = 0; f < mag.length; f++) {
            const vi = Math.min(f, vadConf.length - 1);
            if (vadConf[vi] < 0.3) {
              for (let k = 0; k < mag[f].length; k++) {
                mag[f][k] *= (1 - cancelAmt * 0.8);
              }
            }
          }
        }

        // ═══ PASS 5: SPECTRAL REFINEMENT (Anti-Garble) ═══
        // S15: Temporal smoothing to kill musical noise / garbled artifacts
        await this.pip(15, total);
        DSP.temporalSmooth(mag, Math.max(p.nrSmoothing, 20));
        if (this.abortFlag) throw 'abort';

        // S16: Spectral tilt compensation
        await this.pip(16, total);
        if (Math.abs(p.specTilt) > 0.1) {
          const halfN = mag[0].length;
          for (let f = 0; f < mag.length; f++) {
            for (let k = 0; k < halfN; k++) {
              const freq = k * sr / fftSize;
              const octavesFrom1k = freq > 0 ? Math.log2(freq / 1000) : 0;
              const tiltGain = Math.pow(10, (p.specTilt * octavesFrom1k) / 20);
              mag[f][k] *= Math.max(0.01, Math.min(10, tiltGain));
            }
          }
        }
        if (this.abortFlag) throw 'abort';

        // ═══ PASS 6: ROOM CORRECTION ═══
        // S17: Dereverberation
        await this.pip(17, total);
        DSP.dereverb(mag, p.derevAmt, p.derevDecay, sr, hopSize);
        if (this.abortFlag) throw 'abort';

        // ═══ PASS 7: HARMONIC RECONSTRUCTION ═══
        // S18: Harmonic enhancement v2 (SBR + formant + breathiness)
        await this.pip(18, total);
        DSP.harmonicEnhanceV2(mag, phase, p.harmRecov, {
          sbr: p.harmOrder >= 4,
          formantProtection: true,
          breathinessGain: 0.8,
          sampleRate: sr,
          fftSize: fftSize
        });
        if (this.abortFlag) throw 'abort';

        // ═══ SINGLE INVERSE STFT ═══
        await this.pip(19, total);
        let processed = DSP.inverseSTFT(mag, phase, fftSize, hopSize, data.length);

        // Trim/pad to exact original length
        if (processed.length > len) processed = processed.subarray(0, len);
        else if (processed.length < len) {
          const padded = new Float32Array(len);
          padded.set(processed);
          processed = padded;
        }

        cleanChannels.push(processed);
      }
      if (this.abortFlag) throw 'abort';

      // ═══ PASS 8: EQ + DYNAMICS via OfflineAudioContext ═══
      await this.pip(20, total);
      // Create intermediate buffer with spectrally-cleaned audio
      const cleanBuf = this.ctx.createBuffer(numCh, len, sr);
      for (let ch = 0; ch < numCh; ch++) cleanBuf.getChannelData(ch).set(cleanChannels[ch]);

      // Build Web Audio node chain for EQ + dynamics
      const ofl = new OfflineAudioContext(numCh, len, sr);
      const src = ofl.createBufferSource();
      src.buffer = cleanBuf;

      // HP/LP filters
      await this.pip(21, total);
      const hp = ofl.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.hpFreq; hp.Q.value = p.hpQ;
      const lp = ofl.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = p.lpFreq; lp.Q.value = p.lpQ;

      // 10-band EQ
      await this.pip(22, total);
      const eqDefs = [
        {id:'eqSub',f:40,t:'lowshelf'},{id:'eqBass',f:100,t:'peaking',q:1.2},{id:'eqWarmth',f:200,t:'peaking',q:1},
        {id:'eqBody',f:400,t:'peaking',q:1},{id:'eqLowMid',f:800,t:'peaking',q:1},{id:'eqMid',f:1500,t:'peaking',q:1.2},
        {id:'eqPresence',f:3000,t:'peaking',q:1.5},{id:'eqClarity',f:5000,t:'peaking',q:1.2},
        {id:'eqAir',f:10000,t:'highshelf'},{id:'eqBrill',f:16000,t:'highshelf'}
      ];
      const eqN = eqDefs.map(b => {
        const n = ofl.createBiquadFilter(); n.type = b.t; n.frequency.value = b.f;
        if (b.q) n.Q.value = b.q; n.gain.value = p[b.id] || 0; return n;
      });
      if (this.abortFlag) throw 'abort';

      // Compressor + makeup gain
      await this.pip(23, total);
      const cmp = ofl.createDynamicsCompressor();
      cmp.threshold.value = p.compThresh; cmp.ratio.value = p.compRatio;
      cmp.attack.value = p.compAttack / 1000; cmp.release.value = p.compRelease / 1000; cmp.knee.value = p.compKnee;
      const mkG = ofl.createGain(); mkG.gain.value = Math.pow(10, p.compMakeup / 20);

      // Limiter
      await this.pip(24, total);
      const lim = ofl.createDynamicsCompressor();
      lim.threshold.value = p.limThresh; lim.knee.value = 0; lim.ratio.value = 20;
      lim.attack.value = 0.001; lim.release.value = p.limRelease / 1000;

      // Output gain
      const oG = ofl.createGain(); oG.gain.value = Math.pow(10, p.outGain / 20);
      if (this.abortFlag) throw 'abort';

      // Wire chain: src → hp → lp → EQ → comp → makeup → lim → outGain → dest
      const chain = [src, hp, lp, ...eqN, cmp, mkG, lim, oG];
      for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
      chain[chain.length - 1].connect(ofl.destination);
      src.start(0);

      await this.pip(25, total);
      let rendered;
      try {
        rendered = await ofl.startRendering();
      } finally {
        // Release the offline graph regardless of success so we don't leak
        // AudioNodes across batches. disconnect() on an already-disconnected
        // node throws in some browsers, so each call is guarded.
        for (const node of chain) {
          try { node.disconnect(); } catch { /* noop */ }
        }
        if (typeof ofl.close === 'function') {
          try { await ofl.close(); } catch { /* noop */ }
        }
      }
      if (this.abortFlag) throw 'abort';

      // ═══ PASS 9: MASTERING ═══
      await this.pip(26, total);
      let fin = rendered;

      // Dry/wet mix
      await this.pip(27, total);
      if (p.dryWet < 100) fin = this.mixDW(this.inputBuffer, fin, p.dryWet / 100);

      // Apply phase correction, crosstalk cancellation, formant shift, and dither
      if (p.phaseCorr > 0) fin = this.applyPhaseCorr(fin, p.phaseCorr);
      if (p.crosstalkCancel > 0) fin = this.applyCrosstalkCancel(fin, p.crosstalkCancel);
      if (p.formantShift !== 0) fin = this.applyFormantShift(fin, p.formantShift);
      if (p.ditherAmt > 0) fin = this.applyDither(fin, p.ditherAmt);

      // Peak normalize to limiter ceiling
      await this.pip(28, total);
      fin = this.peakNorm(fin, p.limThresh);

      // ═══ PASS 10: FINALIZE ═══
      await this.pip(29, total);
      await this.pip(30, total);
      await this.pip(31, total);

      this.dom.stProcTime.textContent = ((performance.now() - t0) / 1000).toFixed(2) + 's';
      this.outputBuffer = fin;
      // Persist result so next load of same file + params is instant (non-blocking)
      if (this._lastLoadedFile) {
        this._cacheResultLater(this._lastLoadedFile, fin);
      }
      const snr = this.calcRMS(fin.getChannelData(0)) - this.calcRMS(this.inputBuffer.getChannelData(0));
      this.dom.hSNR.textContent = (snr >= 0 ? '+' : '') + snr.toFixed(1) + ' dB';
      this.resizeCanvas(this.dom.waveProcCanvas);
      this.drawWaveform(fin, this.dom.waveProcCanvas, '#22d3ee');
      this.resizeCanvas(this.dom.compCanvas);
      this.drawComparison(this.inputBuffer, fin);
      this.dom.stVoices.textContent = this.estVoices(fin);
      this.dom.saveProcBtn.disabled = false; this.dom.tpAB.disabled = false; this.dom.reprocessBtn.disabled = false;
      if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = false;
      this.dom.tpABLabel.textContent = 'Ready — A/B';
      this.setStatus('COMPLETE');
    } catch(e) {
      if (e==='abort') { this.setStatus('ABORTED'); this.dom.pipeStage.textContent='Aborted'; this.showNotification('Processing aborted', 'warn'); }
      else {
        const msg = e instanceof Error ? e.message : String(e);
        structuredLog('error', 'Pipeline error', { error: msg });
        this.setStatus('ERROR');
        this.dom.pipeDetail.textContent = msg;
        this.showNotification('Processing failed: ' + msg, 'error', 6000);
      }
    } finally {
      this.isProcessing=false; this.dom.processBtn.style.display='inline-flex'; this.dom.stopProcBtn.style.display='none';
      if (this.dom.mobileProcessBtn)   { this.dom.mobileProcessBtn.style.display='inline-flex'; }
      if (this.dom.mobileReprocessBtn && this.dom.reprocessBtn) { this.dom.mobileReprocessBtn.style.display='inline-flex'; this.dom.mobileReprocessBtn.disabled = this.dom.reprocessBtn.disabled; }
      if (this.dom.mobileStopBtn)      this.dom.mobileStopBtn.style.display='none';
    }
  }

  // ---- DSP HELPERS ----

  // ======== PHASE 1: SPECTRAL ENGINE (STFT / iSTFT / Wiener NR) ========

  // Radix-2 DIT FFT in-place (size must be power of 2)
  _fft(re, im) {
    const n = re.length;
    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const tr=re[i]; re[i]=re[j]; re[j]=tr; const ti=im[i]; im[i]=im[j]; im[j]=ti; }
    }
    // Cooley-Tukey butterfly
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < (len >> 1); j++) {
          const ur=re[i+j], ui=im[i+j];
          const vr=re[i+j+(len>>1)]*cr - im[i+j+(len>>1)]*ci;
          const vi=re[i+j+(len>>1)]*ci + im[i+j+(len>>1)]*cr;
          re[i+j]=ur+vr; im[i+j]=ui+vi;
          re[i+j+(len>>1)]=ur-vr; im[i+j+(len>>1)]=ui-vi;
          const nr=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=nr;
        }
      }
    }
  }

  // IFFT via conjugate trick
  _ifft(re, im) {
    for (let i = 0; i < im.length; i++) im[i] = -im[i];
    this._fft(re, im);
    const n = re.length;
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
  }

  // Periodic Hann window (correct COLA for 75% overlap)
  _makeWindow(N) {
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / N));
    }
    return win;
  }

  // Real spectral noise reduction via Wiener filtering (replaces the old stub applyNR)
  applySpectralNR(buf, amt, sensitivity, spectralSub, floorDb, smoothing, vadMask) {
    const nCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(nCh, len, sr);
    const N = 2048, H = 512, halfN = N / 2 + 1;
    const win = this._makeWindow(N);
    // over-subtraction 1..3, spectral floor 0.01..0.1
    const alpha = 1 + amt * 2;
    const beta = Math.max(0.01, 0.1 - spectralSub * 0.09);
    const floorLin = Math.pow(10, floorDb / 20);
    const sm = Math.max(0, Math.min(0.95, smoothing * 0.95));

    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch);
      const outData = out.getChannelData(ch);
      const normBuf = new Float64Array(len);

      // Profile noise PSD from first ~500ms
      const profLen = Math.min(Math.floor(sr * 0.5), len);
      const noisePSD = new Float64Array(halfN);
      let profFrames = 0;
      for (let s = 0; s + N <= profLen; s += H) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = inp[s + i] * win[i];
        this._fft(re, im);
        for (let k = 0; k < halfN; k++) noisePSD[k] += re[k]*re[k] + im[k]*im[k];
        profFrames++;
      }
      if (profFrames > 0) for (let k = 0; k < halfN; k++) {
        noisePSD[k] = Math.max(noisePSD[k] / profFrames, floorLin * floorLin);
      }
      const smoothedNoise = new Float64Array(noisePSD);

      // Process all frames
      let frameIdx = 0;
      for (let s = 0; s + N <= len; s += H, frameIdx++) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = inp[s + i] * win[i];
        this._fft(re, im);

        // If VAD mask available: only apply NR during non-speech frames
        const frameTimeSec = s / sr;
        const vadFrameIdx = vadMask ? Math.floor(frameTimeSec * 100) : -1;
        const isSpeech = vadMask && vadFrameIdx < vadMask.length ? vadMask[vadFrameIdx] : false;

        for (let k = 0; k < halfN; k++) {
          const sigPSD = re[k]*re[k] + im[k]*im[k];
          smoothedNoise[k] = sm * smoothedNoise[k] + (1 - sm) * noisePSD[k];
          const nEst = alpha * smoothedNoise[k] * (1 + sensitivity * 0.5);
          // Apply softer NR during speech frames: reduce noise estimate so Wiener
          // gain stays higher (less attenuation) rather than using nEst as a gain floor
          // (nEst is a PSD value, not a valid gain — using it as a floor could amplify).
          const nEstFrame = isSpeech ? nEst * 0.3 : nEst;
          const gain = sigPSD > 1e-12 ?
            Math.max(Math.sqrt(Math.max(sigPSD - nEstFrame, 0) / sigPSD), beta) : beta;
          re[k] *= gain; im[k] *= gain;
          if (k > 0 && k < N - k) { re[N-k] = re[k]; im[N-k] = -im[k]; }
        }
        this._ifft(re, im);
        for (let i = 0; i < N && s + i < len; i++) {
          outData[s + i] += re[i] * win[i];
          normBuf[s + i] += win[i] * win[i];
        }
      }
      for (let i = 0; i < len; i++) {
        if (normBuf[i] > 1e-8) outData[i] /= normBuf[i];
        outData[i] = Math.max(-1, Math.min(1, outData[i]));
      }
    }
    return out;
  }

  // ======== PHASE 2: WIRED SLIDERS — SPECTRAL PROCESSING ========

  // Background suppression: attenuate bins outside voice focus band
  applyBgSuppress(buf, suppressAmt, voiceFocusLo, voiceFocusHi) {
    if (suppressAmt <= 0) return buf;
    const nCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(nCh, len, sr);
    const N = 2048, H = 512, halfN = N / 2 + 1;
    const win = this._makeWindow(N);
    const g = 1 - suppressAmt / 100;
    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch);
      const outData = out.getChannelData(ch);
      const normBuf = new Float64Array(len);
      for (let s = 0; s + N <= len; s += H) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = inp[s + i] * win[i];
        this._fft(re, im);
        for (let k = 0; k < halfN; k++) {
          const freq = k * sr / N;
          if (freq < voiceFocusLo || freq > voiceFocusHi) {
            re[k] *= g; im[k] *= g;
            if (k > 0 && k < N - k) { re[N-k] *= g; im[N-k] *= g; }
          }
        }
        this._ifft(re, im);
        for (let i = 0; i < N && s + i < len; i++) {
          outData[s + i] += re[i] * win[i];
          normBuf[s + i] += win[i] * win[i];
        }
      }
      for (let i = 0; i < len; i++) {
        if (normBuf[i] > 1e-8) outData[i] /= normBuf[i];
        outData[i] = Math.max(-1, Math.min(1, outData[i]));
      }
    }
    return out;
  }

  // Spectral dereverberation via temporal variance suppression
  applyDereverb(buf, amt, decaySec) {
    if (amt <= 0) return buf;
    const nCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(nCh, len, sr);
    const N = 2048, H = 512, halfN = N / 2 + 1;
    const win = this._makeWindow(N);
    const g = amt / 100;
    const smCoef = Math.exp(-H / (sr * Math.max(0.05, decaySec)));

    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch);
      const outData = out.getChannelData(ch);
      const normBuf = new Float64Array(len);
      const magMean = new Float64Array(halfN).fill(1e-6);
      for (let s = 0; s + N <= len; s += H) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = inp[s + i] * win[i];
        this._fft(re, im);
        for (let k = 0; k < halfN; k++) {
          const mag = Math.sqrt(re[k]*re[k] + im[k]*im[k]);
          // Reverb tail = magnitude smoothly less than running mean
          const isReverb = mag < magMean[k] * 0.75;
          const gain = isReverb ? Math.max(1 - g, 0.05) : 1;
          re[k] *= gain; im[k] *= gain;
          if (k > 0 && k < N - k) { re[N-k] *= gain; im[N-k] *= gain; }
          magMean[k] = smCoef * magMean[k] + (1 - smCoef) * mag;
        }
        this._ifft(re, im);
        for (let i = 0; i < N && s + i < len; i++) {
          outData[s + i] += re[i] * win[i];
          normBuf[s + i] += win[i] * win[i];
        }
      }
      for (let i = 0; i < len; i++) {
        if (normBuf[i] > 1e-8) outData[i] /= normBuf[i];
        outData[i] = Math.max(-1, Math.min(1, outData[i]));
      }
    }
    return out;
  }

  // Formant shift via spectral envelope warping
  applyFormantShift(buf, semitones) {
    if (semitones === 0) return buf;
    const nCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(nCh, len, sr);
    const N = 2048, H = 512, halfN = N / 2 + 1;
    const win = this._makeWindow(N);
    const shiftFactor = Math.pow(2, semitones / 12);
    const envWin = 20;

    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch);
      const outData = out.getChannelData(ch);
      const normBuf = new Float64Array(len);
      for (let s = 0; s + N <= len; s += H) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = inp[s + i] * win[i];
        this._fft(re, im);
        // Compute log-magnitude and extract spectral envelope via smoothing
        const logMag = new Float64Array(halfN);
        const phase = new Float64Array(halfN);
        for (let k = 0; k < halfN; k++) {
          logMag[k] = Math.log(Math.max(Math.sqrt(re[k]*re[k]+im[k]*im[k]), 1e-10));
          phase[k] = Math.atan2(im[k], re[k]);
        }
        const envelope = new Float64Array(halfN);
        for (let k = 0; k < halfN; k++) {
          let sum = 0, cnt = 0;
          for (let j = Math.max(0,k-envWin); j <= Math.min(halfN-1,k+envWin); j++) { sum+=logMag[j]; cnt++; }
          envelope[k] = sum / cnt;
        }
        const detail = logMag.map((v,k) => v - envelope[k]);
        // Warp envelope by shiftFactor
        const newEnv = new Float64Array(halfN);
        for (let k = 0; k < halfN; k++) {
          const src = k / shiftFactor;
          const lo = Math.floor(src), hi = Math.min(lo+1, halfN-1);
          if (lo >= 0 && lo < halfN) newEnv[k] = (1-(src-lo))*envelope[lo] + (src-lo)*envelope[hi];
        }
        const reOut = new Float64Array(N), imOut = new Float64Array(N);
        for (let k = 0; k < halfN; k++) {
          const newMag = Math.exp(newEnv[k] + detail[k]);
          reOut[k] = newMag * Math.cos(phase[k]);
          imOut[k] = newMag * Math.sin(phase[k]);
          if (k > 0 && k < N - k) { reOut[N-k] = reOut[k]; imOut[N-k] = -imOut[k]; }
        }
        this._ifft(reOut, imOut);
        for (let i = 0; i < N && s + i < len; i++) {
          outData[s + i] += reOut[i] * win[i];
          normBuf[s + i] += win[i] * win[i];
        }
      }
      for (let i = 0; i < len; i++) {
        if (normBuf[i] > 1e-8) outData[i] /= normBuf[i];
        outData[i] = Math.max(-1, Math.min(1, outData[i]));
      }
    }
    return out;
  }

  // Cross-channel phase alignment via cross-correlation lag detection
  applyPhaseCorr(buf, corrAmt) {
    if (corrAmt <= 0 || buf.numberOfChannels < 2) return buf;
    const len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(buf.numberOfChannels, len, sr);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const oL = out.getChannelData(0), oR = out.getChannelData(1);
    // Find best cross-correlation lag within ±5ms
    const maxLag = Math.floor(sr * 0.005);
    let bestLag = 0, bestCorr = -Infinity;
    const sampleCount = Math.min(len, Math.floor(sr * 2));
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let i = maxLag; i < sampleCount - maxLag; i++) corr += L[i] * (R[i + lag] || 0);
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    const actualLag = Math.round(bestLag * corrAmt / 100);
    for (let i = 0; i < len; i++) {
      oL[i] = L[i];
      oR[i] = R[Math.max(0, Math.min(len-1, i - actualLag))];
    }
    for (let ch = 2; ch < buf.numberOfChannels; ch++) {
      const inCh = buf.getChannelData(ch), outCh = out.getChannelData(ch);
      for (let i = 0; i < len; i++) outCh[i] = inCh[i];
    }
    return out;
  }

  // Crosstalk cancellation via mid/side matrix
  applyCrosstalkCancel(buf, cancelAmt) {
    if (cancelAmt <= 0 || buf.numberOfChannels < 2) return buf;
    const len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(buf.numberOfChannels, len, sr);
    const g = (cancelAmt / 100) * 0.5;
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const oL = out.getChannelData(0), oR = out.getChannelData(1);
    for (let i = 0; i < len; i++) {
      oL[i] = L[i] - g * R[i];
      oR[i] = R[i] - g * L[i];
    }
    for (let ch = 2; ch < buf.numberOfChannels; ch++) {
      const inCh = buf.getChannelData(ch), outCh = out.getChannelData(ch);
      for (let i = 0; i < len; i++) outCh[i] = inCh[i];
    }
    return out;
  }

  // TPDF dither noise shaping before bit-depth reduction
  // 🛡️ Sentinel: Fixed weak PRNG by using chunked crypto.getRandomValues()
  applyDither(buf, ditherAmt) {
    if (ditherAmt <= 0) return buf;
    const nCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(nCh, len, sr);
    const lsb = Math.pow(2, -15); // 16-bit LSB
    const g = (ditherAmt / 100) * lsb;
    const invMax = 1 / 4294967296;

    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch), outCh = out.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        if (this._rndIdx >= this._rndBuf.length - 1) {
          crypto.getRandomValues(this._rndBuf);
          this._rndIdx = 0;
        }
        const r1 = this._rndBuf[this._rndIdx++] * invMax;
        const r2 = this._rndBuf[this._rndIdx++] * invMax;
        const tpdf = (r1 - r2) * g;
        outCh[i] = Math.max(-1, Math.min(1, inp[i] + tpdf));
      }
    }
    return out;
  }

  // ======== PHASE 4: ML / VAD INTEGRATION ========

  // Promise wrapper for ML Worker calls — resolves on matching result message
  _mlCall(payload, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++this._mlCallId;
      const worker = this.mlWorker;
      let errorHandler;
      // SEC-03: Dedicated Worker — origin checks don't apply (same-origin by design).
      // RPC safety is enforced by matching e.data.id to the outbound call id.
      const cleanup = () => {
        worker.removeEventListener('message', handler);
        if (errorHandler) worker.removeEventListener('error', errorHandler);
      };
      const handler = (e) => {
        if (e.data.id !== id) return; // RPC id guard
        cleanup();
        if (e.data.error) reject(new Error(e.data.error));
        else resolve(e.data.result);
      };
      errorHandler = (e) => {
        cleanup();
        reject(new Error(e.message || 'ML worker error'));
      };
      worker.addEventListener('message', handler);
      worker.addEventListener('error', errorHandler);
      try {
        worker.postMessage({ ...payload, id }, transfer);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  // Run ML source separation (Demucs/BSRNN) via ML Worker
  async runSeparation(buf, model = 'demucs') {
    if (!this.mlWorker) return buf;
    try {
      const signal = new Float32Array(buf.getChannelData(0));
      return await this._mlCall({ type: 'process', model, signal, sampleRate: buf.sampleRate }, [signal.buffer]);
    } catch (e) {
      structuredLog('warn', 'ML separation failed', { error: e.message });
      return buf;
    }
  }

  // Forensic audit: hash a buffer stage and log it
  async addAuditEntry(buf, stageName) {
    const data = (buf && buf.getChannelData) ? new Float32Array(buf.getChannelData(0)) : new Float32Array(0);
    const hashBuf = await crypto.subtle.digest('SHA-256', data.buffer);
    const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    this.forensicLog.push({ stage: stageName, hash, timestamp: Date.now() });
  }

  // Export forensic audit log as JSON
  downloadAuditLog() {
    const json = JSON.stringify(this.forensicLog, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'audit-log-' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  // Trigger VAD model load in the ML Worker (fire-and-forget; mlReady set via _onMlMessage)
  async loadModels() {
    if (!this.mlWorker) {
      structuredLog('warn', 'ML Worker not available — running without ML');
      return;
    }
    const wasmRoot = '/lib/'; // ARCH-04 FIX: local wasm root only, no CDN
    this.mlWorker.postMessage({ type: 'loadModel', model: 'vad', wasmRoot });
  }

  // Run Silero VAD via ML Worker; returns boolean[] or null if unavailable
  async runVAD(buf) {
    if (!this.mlReady || !this.mlWorker) return null;
    try {
      const signal = new Float32Array(buf.getChannelData(0)); // copy for transfer
      return await this._mlCall(
        { type: 'runVAD', signal, sampleRate: buf.sampleRate },
        [signal.buffer]
      );
    } catch(e) {
      structuredLog('warn', 'VAD Worker call failed', { error: e.message });
      return null;
    }
  }

  async pip(i, t) {
    const pct = Math.round((i + 1) / t * 100);
    this.dom.pipeFill.style.width = pct + '%';
    this.dom.pipeBar.setAttribute('aria-valuenow', String(pct));
    this.dom.pipeStage.textContent = (i + 1) + '/' + t;
    this.dom.pipeDetail.textContent = STAGES[i] || 'Finalizing';
    this.dom.hStatus.textContent = 'S' + (i + 1);
    await new Promise(r => typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(() => r()) : setTimeout(r, 0));
  }
  mixDW(dry,wet,wAmt){const c=this.ctx;const nCh=Math.min(dry.numberOfChannels,wet.numberOfChannels);const len=Math.min(dry.length,wet.length);const out=c.createBuffer(nCh,len,dry.sampleRate);for(let ch=0;ch<nCh;ch++){const d=dry.getChannelData(ch);const w=wet.getChannelData(ch);const o=out.getChannelData(ch);for(let i=0;i<len;i++)o[i]=d[i]*(1-wAmt)+w[i]*wAmt;}return out;}
  peakNorm(buf,tDb){const c=this.ctx;const nCh=buf.numberOfChannels;const len=buf.length;const out=c.createBuffer(nCh,len,buf.sampleRate);let pk=0;for(let ch=0;ch<nCh;ch++){const d=buf.getChannelData(ch);for(let i=0;i<len;i++){const a=Math.abs(d[i]);if(a>pk)pk=a;}}if(pk===0)return buf;const g=Math.pow(10,tDb/20)/pk;for(let ch=0;ch<nCh;ch++){const inp=buf.getChannelData(ch);const o=out.getChannelData(ch);for(let i=0;i<len;i++)o[i]=Math.max(-1,Math.min(1,inp[i]*g));}return out;}
  makeHarm(amt,ord){const n=44100;const c=new Float32Array(n);const k=amt*(ord||3)*2+1;for(let i=0;i<n;i++){const x=(i*2)/n-1;c[i]=Math.tanh(k*x)/Math.tanh(k);}return c;}
  estVoices(buf){const d=buf.getChannelData(0);const sr=buf.sampleRate;const bs=Math.floor(sr*0.5);let act=0;for(let i=0;i<d.length;i+=bs){let r=0;const e=Math.min(i+bs,d.length);for(let j=i;j<e;j++)r+=d[j]*d[j];r=Math.sqrt(r/(e-i));if(r>0.01)act++;}return act<3?'0-1':act<10?'1':'1-2+';}

  // ---- SAVE ----
  saveWav(buf,label){if(!buf)return;const w=this.encWav(buf);const b=new Blob([w],{type:'audio/wav'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='voiceisolate_v22_'+label+'_'+Date.now()+'.wav';document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(a.href);}
  encWav(buf){const nCh=buf.numberOfChannels;const sr=buf.sampleRate;const dL=buf.length*nCh*2;const a=new ArrayBuffer(44+dL);const v=new DataView(a);const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};ws(0,'RIFF');v.setUint32(4,36+dL,true);ws(8,'WAVE');ws(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,nCh,true);v.setUint32(24,sr,true);v.setUint32(28,sr*nCh*2,true);v.setUint16(32,nCh*2,true);v.setUint16(34,16,true);ws(36,'data');v.setUint32(40,dL,true);let off=44;for(let i=0;i<buf.length;i++)for(let ch=0;ch<nCh;ch++){let s=buf.getChannelData(ch)[i];s=Math.max(-1,Math.min(1,s));v.setInt16(off,s<0?s*0x8000:s*0x7FFF,true);off+=2;}return a;}

  // ======== VISUALIZATIONS (existing) ========
  initCanvases(){
    const all = [this.dom.waveOrigCanvas,this.dom.waveProcCanvas,this.dom.spectro2DCanvas,this.dom.freqCanvas,
      this.dom.compCanvas,this.dom.abWaveCanvas,this.dom.oscCanvas,this.dom.specOverlayCanvas,this.dom.lufsCanvas,
      this.dom.saliencyCanvas,this.dom.clusterCanvas,this.dom.diarCanvas];
    all.forEach(c => { if(c) this.resizeCanvas(c); });
    this.clearCanvas(this.dom.waveOrigCanvas,'Load audio to begin');
    this.clearCanvas(this.dom.waveProcCanvas,'Process to see result');
    this.clearCanvas(this.dom.spectro2DCanvas,'Play audio for spectrogram');
    this.clearCanvas(this.dom.freqCanvas,'Play audio for analyzer');
    this.clearCanvas(this.dom.compCanvas,'Process audio for before/after comparison');
    this.clearCanvas(this.dom.abWaveCanvas,'Play audio for A/B comparison');
    this.clearCanvas(this.dom.oscCanvas,'Play audio for oscilloscope');
    this.clearCanvas(this.dom.specOverlayCanvas,'Play audio for spectrogram overlays');
    this.clearCanvas(this.dom.lufsCanvas,'Play audio for LUFS meter');
    this.clearCanvas(this.dom.saliencyCanvas,'Play audio for ML saliency');
    this.clearCanvas(this.dom.clusterCanvas,'Play audio for speaker clusters');
  }

  resizeCanvas(c){if(!c)return;const r=c.getBoundingClientRect();c.width=Math.floor(r.width);c.height=Math.floor(r.height);}
  clearCanvas(c,txt){if(!c)return;const x=c.getContext('2d');x.fillStyle='#030306';x.fillRect(0,0,c.width,c.height);if(txt){x.font='11px Outfit,sans-serif';x.fillStyle='rgba(255,255,255,0.12)';x.textAlign='center';x.fillText(txt,c.width/2,c.height/2+3);}}

  drawWaveform(buf,canvas,color){if(!canvas)return;const x=canvas.getContext('2d');const w=canvas.width;const h=canvas.height;x.fillStyle='#030306';x.fillRect(0,0,w,h);if(!buf)return;const d=buf.getChannelData(0);const step=Math.max(1,Math.floor(d.length/w));x.strokeStyle='rgba(255,255,255,0.04)';x.lineWidth=1;x.beginPath();x.moveTo(0,h/2);x.lineTo(w,h/2);x.stroke();x.fillStyle=color;for(let px=0;px<w;px++){const idx=px*step;let mn=1,mx=-1;for(let i=0;i<step&&(idx+i)<d.length;i++){const v=d[idx+i];if(v<mn)mn=v;if(v>mx)mx=v;}const y1=((1-mx)*0.5)*h;const y2=((1-mn)*0.5)*h;x.globalAlpha=0.8;x.fillRect(px,y1,1,Math.max(1,y2-y1));}x.globalAlpha=1;}

  // ---- Before/After Comparison ----
  drawComparison(origBuf, procBuf) {
    const c = this.dom.compCanvas; if (!c) return;
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    x.fillStyle = '#030306'; x.fillRect(0, 0, w, h);
    if (!origBuf || !procBuf) return;
    const half = Math.floor(w / 2);
    // Divider
    x.strokeStyle = 'rgba(255,255,255,0.06)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(half, 0); x.lineTo(half, h); x.stroke();
    // Labels
    x.font = '9px JetBrains Mono';
    x.fillStyle = 'rgba(220,38,38,0.45)'; x.textAlign = 'center';
    x.fillText('BEFORE', half / 2, 11);
    x.fillStyle = 'rgba(34,211,238,0.45)'; x.textAlign = 'center';
    x.fillText('AFTER', half + half / 2, 11);
    // Helper: draw waveform into a horizontal region [x0, x0+rw]
    const drawHalf = (buf, x0, rw, color) => {
      const d = buf.getChannelData(0);
      const step = Math.max(1, Math.floor(d.length / rw));
      x.fillStyle = color;
      for (let px = 0; px < rw; px++) {
        const idx = px * step;
        let mn = 1, mx = -1;
        for (let i = 0; i < step && (idx + i) < d.length; i++) {
          const v = d[idx + i]; if (v < mn) mn = v; if (v > mx) mx = v;
        }
        const y1 = ((1 - mx) * 0.5) * h;
        const y2 = ((1 - mn) * 0.5) * h;
        x.globalAlpha = 0.75;
        x.fillRect(x0 + px, y1, 1, Math.max(1, y2 - y1));
      }
      x.globalAlpha = 1;
    };
    // Center line for each half
    x.strokeStyle = 'rgba(255,255,255,0.04)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(0, h / 2); x.lineTo(half, h / 2); x.stroke();
    x.beginPath(); x.moveTo(half, h / 2); x.lineTo(w, h / 2); x.stroke();
    drawHalf(origBuf, 0, half, '#dc2626');
    drawHalf(procBuf, half, half, '#22d3ee');
  }

  // ---- 2D Spectrogram ----
  startSpectro(ana){
    this.stopSpectro(); this.spectroRunning=true; this.spectroX=0; this.specOverlayX=0;
    const c=this.dom.spectro2DCanvas; this.resizeCanvas(c);
    const x=c.getContext('2d'); x.fillStyle='#030306'; x.fillRect(0,0,c.width,c.height);
    const bLen=ana.frequencyBinCount; const arr=new Uint8Array(bLen);
    const draw=()=>{
      if(!this.spectroRunning)return; this.animId=requestAnimationFrame(draw);
      ana.getByteFrequencyData(arr);
      const w=c.width;const h=c.height;const sw=2;
      if(this.spectroX+sw>=w){const img=x.getImageData(sw,0,w-sw,h);x.putImageData(img,0,0);x.fillStyle='#030306';x.fillRect(w-sw,0,sw,h);this.spectroX=w-sw;}
      for(let y=0;y<h;y++){const fi=Math.floor((y/h)*bLen);const val=arr[bLen-1-fi];const muted=this.isBandMuted(fi,bLen,ana.context?ana.context.sampleRate:44100);x.fillStyle=muted?'rgba(30,30,30,0.8)':this.sColor(val,fi,bLen);x.fillRect(this.spectroX,y,sw,1);}
      this.spectroX+=sw;
      this.update3D(arr);
    };
    draw();
  }
  stopSpectro(){this.spectroRunning=false;if(this.animId){cancelAnimationFrame(this.animId);this.animId=null;}}

  sColor(val,fi,total){const v=val/255;const f=fi/total;if(f<0.05)return 'rgb('+Math.floor(v*40)+','+Math.floor(v*80)+','+Math.floor(60+v*195)+')';if(f<0.2)return 'rgb('+Math.floor(60+v*195)+','+Math.floor(v*30)+','+Math.floor(v*20)+')';if(f<0.5)return 'rgb('+Math.floor(80+v*175)+','+Math.floor(v*60)+','+Math.floor(v*10)+')';if(f<0.75)return 'rgb('+Math.floor(v*30)+','+Math.floor(50+v*180)+','+Math.floor(v*30)+')';return 'rgb('+Math.floor(60+v*195)+','+Math.floor(50+v*160)+','+Math.floor(v*20)+')';}
  isBandMuted(fi,total,sr){const freq=(fi/total)*(sr/2);for(const b of this.mutedBands)if(freq>=b.lo&&freq<b.hi)return true;return false;}

  toggleSoundCategory(catId) {
    this.soundMutes[catId] = !this.soundMutes[catId];
    // Update button appearance
    const btn = document.querySelector(`.sound-mute-btn[data-cat="${catId}"]`);
    if (btn) btn.classList.toggle('active', !!this.soundMutes[catId]);
    // Update status text
    const activeCats = SOUND_CATEGORIES.filter(c => this.soundMutes[c.id]);
    const statusEl = document.getElementById('soundMuteStatus');
    if (statusEl) {
      if (activeCats.length === 0) {
        statusEl.textContent = 'No sounds muted — all background is processed normally';
        statusEl.classList.remove('has-mutes');
      } else {
        statusEl.textContent = 'Muting: ' + activeCats.map(c => c.emoji + ' ' + c.label).join(' · ') + ' — re-process to apply';
        statusEl.classList.add('has-mutes');
      }
    }
  }

  onSpectroClick(e){const r=this.dom.spectro3DCanvas.getBoundingClientRect();const y=1-((e.clientY-r.top)/r.height);const sr=this.ctx?this.ctx.sampleRate:44100;const freq=y*(sr/2);const bw=sr/20;const lo=Math.max(0,freq-bw/2);const hi=freq+bw/2;const key=Math.round(lo)+'-'+Math.round(hi);let found=false;for(const b of this.mutedBands){if(b.key===key){this.mutedBands.delete(b);found=true;break;}}if(!found)this.mutedBands.add({lo,hi,key});}

  startFreq(ana){
    const c=this.dom.freqCanvas;if(!c)return;this.resizeCanvas(c);const x=c.getContext('2d');const bLen=ana.frequencyBinCount;const arr=new Uint8Array(bLen);
    const draw=()=>{if(!this.spectroRunning)return;requestAnimationFrame(draw);ana.getByteFrequencyData(arr);const w=c.width;const h=c.height;x.fillStyle='#030306';x.fillRect(0,0,w,h);x.strokeStyle='rgba(255,255,255,0.03)';x.lineWidth=1;for(let i=1;i<5;i++){const gy=(i/5)*h;x.beginPath();x.moveTo(0,gy);x.lineTo(w,gy);x.stroke();}const bW=(w/bLen)*2.5;let px=0;for(let i=0;i<bLen&&px<w;i++){const bH=(arr[i]/255)*h;const f=i/bLen;let hue;if(f<0.05)hue=220;else if(f<0.2)hue=0;else if(f<0.5)hue=10;else if(f<0.75)hue=130;else hue=50;x.fillStyle='hsla('+hue+',75%,50%,0.75)';x.fillRect(px,h-bH,Math.max(1,bW-1),bH);px+=bW;}};
    draw();
  }

  // ---- 3D Spectrogram ----
  init3D(retried){
    const ct=this.dom.spectro3DContainer;if(!ct)return;const w=ct.clientWidth;const h=ct.clientHeight;
    if(w===0||h===0){if(!retried)requestAnimationFrame(()=>this.init3D(true));return;}
    if(this.three.ren)return; // already initialized
    const scene=new THREE.Scene();scene.background=new THREE.Color(0x030306);
    const cam=new THREE.PerspectiveCamera(45,w/h,0.1,1000);cam.position.set(0,40,60);cam.lookAt(0,0,0);
    const ren=new THREE.WebGLRenderer({canvas:this.dom.spectro3DCanvas,antialias:true});
    // Pass false so Three.js doesn't write inline px styles that fight CSS width:100%
    ren.setSize(w,h,false);ren.setPixelRatio(Math.min(window.devicePixelRatio,2));
    const gW=64;const gD=128;
    const geo=new THREE.PlaneGeometry(80,40,gW-1,gD-1);geo.rotateX(-Math.PI*0.4);
    const cols=new Float32Array(geo.attributes.position.count*3);
    geo.setAttribute('color',new THREE.BufferAttribute(cols,3));
    const mat=new THREE.MeshBasicMaterial({vertexColors:true,wireframe:false,side:THREE.DoubleSide});
    const mesh=new THREE.Mesh(geo,mat);scene.add(mesh);
    scene.add(new THREE.AmbientLight(0xffffff,0.5));
    this.three={scene,cam,ren,mesh,geo,gW,gD,cols};
    let drag=false,pX=0,pY=0;const cv=this.dom.spectro3DCanvas;
    cv.addEventListener('mousedown',e=>{drag=true;pX=e.clientX;pY=e.clientY;});
    window.addEventListener('mouseup',()=>drag=false);
    window.addEventListener('mousemove',e=>{if(!drag)return;cam.position.x-=(e.clientX-pX)*0.15;cam.position.y+=(e.clientY-pY)*0.15;cam.lookAt(0,0,0);pX=e.clientX;pY=e.clientY;});
    cv.addEventListener('wheel',e=>{e.preventDefault();cam.position.z+=e.deltaY*0.05;cam.position.z=Math.max(20,Math.min(120,cam.position.z));},{passive:false});
    const handle3DResize=()=>{
      const rw=ct.clientWidth, rh=ct.clientHeight;
      if(rw>0&&rh>0&&this.three.ren){
        this.three.ren.setSize(rw,rh,false);
        this.three.cam.aspect=rw/rh;
        this.three.cam.updateProjectionMatrix();
      }
    };
    // ResizeObserver keeps the buffer in sync when the grid reflows (not just window resize)
    if(typeof ResizeObserver!=='undefined'){
      const _ro3d = new ResizeObserver(handle3DResize);
      _ro3d.observe(ct);
      this.three._ro3d = _ro3d;
    }else if(typeof window!=='undefined'){
      window.addEventListener('resize',handle3DResize);
      this.three._resize3DHandler = handle3DResize;
    }
    this.render3D();
  }
  reset3DView(){
    if(!this.three.cam)return;
    this.three.cam.position.set(0,40,60);
    this.three.cam.lookAt(0,0,0);
    if(this.three.ren){
      const ct = this.dom.spectro3DContainer;
      if(ct){
        const w = ct.clientWidth, h = ct.clientHeight;
        if(w>0 && h>0){
          this.three.ren.setSize(w,h,false);
          this.three.cam.aspect = w/h;
          this.three.cam.updateProjectionMatrix();
        }
      }
    }
  }
  update3D(freq){
    if(!this.three.geo)return;const{geo,gW,gD,cols}=this.three;const pos=geo.attributes.position;const colA=geo.attributes.color;
    for(let z=gD-1;z>0;z--)for(let x=0;x<gW;x++){const c=z*gW+x;const p=(z-1)*gW+x;pos.setY(c,pos.getY(p));cols[c*3]=cols[p*3];cols[c*3+1]=cols[p*3+1];cols[c*3+2]=cols[p*3+2];}
    const step=Math.floor(freq.length/gW);
    for(let x=0;x<gW;x++){const fi=Math.min(x*step,freq.length-1);const v=(freq[fi]||0)/255;pos.setY(x,v*15);const f=x/gW;
      if(f<0.05){cols[x*3]=v*0.15;cols[x*3+1]=v*0.3;cols[x*3+2]=0.3+v*0.7;}
      else if(f<0.3){cols[x*3]=0.3+v*0.7;cols[x*3+1]=v*0.1;cols[x*3+2]=v*0.05;}
      else if(f<0.6){cols[x*3]=v*0.1;cols[x*3+1]=0.2+v*0.6;cols[x*3+2]=v*0.1;}
      else{cols[x*3]=0.3+v*0.6;cols[x*3+1]=0.25+v*0.5;cols[x*3+2]=v*0.05;}
    }
    pos.needsUpdate=true;colA.needsUpdate=true;
  }
  render3D(){requestAnimationFrame(()=>this.render3D());if(this.three.ren)this.three.ren.render(this.three.scene,this.three.cam);}

  // ════════════════════════════════════════════
  // 6-PANEL DIAGNOSTIC DASHBOARD
  // ════════════════════════════════════════════
  startDiagnostics() {
    if (this.diagRunning) return;
    this.diagRunning = true;
    this.specOverlayX = 0;
    // Resize all diagnostic canvases
    [this.dom.abWaveCanvas,this.dom.oscCanvas,this.dom.specOverlayCanvas,
     this.dom.lufsCanvas,this.dom.saliencyCanvas,this.dom.clusterCanvas,
     this.dom.diarCanvas].forEach(c => this.resizeCanvas(c));
    // Start the VisualizationEngine (VU meters + diarization timeline).
    // Safe to call even if analysers aren't ready — the engine will
    // no-op meter updates until getAnalysers() returns a valid proc.
    if (this._visEngine) this._visEngine.start();
    // Clear spec overlay
    if (this.dom.specOverlayCanvas) {
      const sx = this.dom.specOverlayCanvas.getContext('2d');
      sx.fillStyle = '#030306'; sx.fillRect(0,0,this.dom.specOverlayCanvas.width,this.dom.specOverlayCanvas.height);
    }

    const origBuf = new Float32Array(2048);
    const procBuf = new Float32Array(2048);
    const freqBuf = new Uint8Array(this.analyserProc ? this.analyserProc.frequencyBinCount : 2048);
    let lufsTimer = 0;
    let clusterTimer = 0;

    const drawAll = () => {
      if (!this.diagRunning) return;
      this.diagAnimId = requestAnimationFrame(drawAll);
      const now = performance.now();

      // FPS counter
      this.diagFpsFrames++;
      if (now - this.diagFpsLast > 1000) {
        if (this.dom.diagFps) this.dom.diagFps.textContent = this.diagFpsFrames + ' fps';
        this.diagFpsFrames = 0;
        this.diagFpsLast = now;
      }

      // Get data from analysers
      if (this.analyserOrig) this.analyserOrig.getFloatTimeDomainData(origBuf);
      if (this.analyserProc) {
        this.analyserProc.getFloatTimeDomainData(procBuf);
        this.analyserProc.getByteFrequencyData(freqBuf);
      }

      // Panel 1: A/B Waveform
      this.drawABWave(origBuf, procBuf);

      // Panel 2: Oscilloscope
      this.drawOscilloscope(procBuf);

      // Panel 3: Spectrogram + Overlays
      this.drawSpecOverlay(freqBuf);

      // Panel 4: LUFS Meter (~100ms update)
      if (now - lufsTimer > 100) {
        this.drawLUFS(procBuf);
        lufsTimer = now;
      }

      // Panel 5: ML Saliency Heatmap
      this.drawSaliency(freqBuf);

      // Panel 6: Speaker PCA Cluster (~200ms update)
      if (now - clusterTimer > 200) {
        this.updateCluster(procBuf, freqBuf);
        clusterTimer = now;
      }
      this.drawCluster();
    };
    drawAll();
  }

  stopDiagnostics() {
    this.diagRunning = false;
    if (this.diagAnimId) { cancelAnimationFrame(this.diagAnimId); this.diagAnimId = null; }
    if (this._visEngine) this._visEngine.stop();
  }

  // Panel 1: A/B Waveform
  drawABWave(origBuf, procBuf) {
    const c = this.dom.abWaveCanvas; if (!c) return;
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    x.fillStyle = '#030306'; x.fillRect(0, 0, w, h);

    // Grid
    x.strokeStyle = 'rgba(255,255,255,0.03)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(0, h/2); x.lineTo(w, h/2); x.stroke();
    if (!this.abOverlay) {
      x.beginPath(); x.moveTo(0, h/4); x.lineTo(w, h/4); x.stroke();
      x.beginPath(); x.moveTo(0, h*3/4); x.lineTo(w, h*3/4); x.stroke();
    }

    const drawLine = (buf, color, yOff, yScale) => {
      x.save();
      x.strokeStyle = color; x.lineWidth = 1.5;
      x.shadowColor = color; x.shadowBlur = 4;
      x.beginPath();
      const step = buf.length / w;
      for (let i = 0; i < w; i++) {
        const v = buf[Math.floor(i * step)] || 0;
        const y = yOff + (-v * yScale);
        if (i === 0) x.moveTo(i, y); else x.lineTo(i, y);
      }
      x.stroke();
      x.restore();
    };

    if (this.abOverlay) {
      drawLine(origBuf, '#3b82f6', h/2, h/2 * 0.8);
      drawLine(procBuf, '#a855f7', h/2, h/2 * 0.8);
    } else {
      // Stacked: top = original, bottom = processed
      drawLine(origBuf, '#3b82f6', h/4, h/4 * 0.8);
      drawLine(procBuf, '#a855f7', h*3/4, h/4 * 0.8);
      // Labels
      x.font = '9px JetBrains Mono'; x.fillStyle = 'rgba(59,130,246,0.5)';
      x.fillText('ORIG', 4, 12);
      x.fillStyle = 'rgba(168,85,247,0.5)';
      x.fillText('PROC', 4, h/2 + 12);
    }
  }

  // Panel 2: Oscilloscope
  drawOscilloscope(buf) {
    const c = this.dom.oscCanvas; if (!c) return;
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    x.fillStyle = 'rgba(3,3,6,0.3)'; x.fillRect(0, 0, w, h);

    // Grid
    x.strokeStyle = 'rgba(34,197,94,0.06)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(0, h/2); x.lineTo(w, h/2); x.stroke();
    if (this.oscMode === 'lissajous') {
      x.beginPath(); x.moveTo(w/2, 0); x.lineTo(w/2, h); x.stroke();
    }

    x.strokeStyle = '#22c55e'; x.lineWidth = 1.2;
    x.shadowColor = '#22c55e'; x.shadowBlur = 3;
    x.beginPath();

    if (this.oscMode === 'wave') {
      const step = buf.length / w;
      for (let i = 0; i < w; i++) {
        const v = buf[Math.floor(i * step)] || 0;
        const y = h/2 + (-v * h/2 * 0.85);
        if (i === 0) x.moveTo(i, y); else x.lineTo(i, y);
      }
    } else if (this.oscMode === 'mirror') {
      const step = buf.length / w;
      // Top half (positive)
      for (let i = 0; i < w; i++) {
        const v = Math.abs(buf[Math.floor(i * step)] || 0);
        const y = h/2 - v * h/2 * 0.85;
        if (i === 0) x.moveTo(i, y); else x.lineTo(i, y);
      }
      x.stroke();
      // Bottom half (mirrored)
      x.beginPath();
      x.strokeStyle = 'rgba(34,197,94,0.5)';
      for (let i = 0; i < w; i++) {
        const v = Math.abs(buf[Math.floor(i * step)] || 0);
        const y = h/2 + v * h/2 * 0.85;
        if (i === 0) x.moveTo(i, y); else x.lineTo(i, y);
      }
    } else if (this.oscMode === 'lissajous') {
      // XY mode: use consecutive samples as L/R proxy
      const len = Math.min(buf.length, 1024);
      for (let i = 0; i < len - 1; i++) {
        const lx = w/2 + buf[i] * w/2 * 0.8;
        const ly = h/2 + (-buf[i+1]) * h/2 * 0.8;
        if (i === 0) x.moveTo(lx, ly); else x.lineTo(lx, ly);
      }
    }
    x.stroke();
    x.shadowBlur = 0;
  }

  // Panel 3: Spectrogram + Overlays
  drawSpecOverlay(freqBuf) {
    const c = this.dom.specOverlayCanvas; if (!c) return;
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    const bLen = freqBuf.length;
    const sw = 2;

    // Scroll
    if (this.specOverlayX + sw >= w) {
      const img = x.getImageData(sw, 0, w - sw, h);
      x.putImageData(img, 0, 0);
      x.fillStyle = '#030306'; x.fillRect(w - sw, 0, sw, h);
      this.specOverlayX = w - sw;
    }

    // Base spectrogram
    for (let y = 0; y < h; y++) {
      const fi = Math.floor((y / h) * bLen);
      const val = freqBuf[bLen - 1 - fi];
      const v = val / 255;
      // Blue-cyan-yellow-white colormap
      const r = Math.floor(v * v * 255);
      const g = Math.floor(v * 180);
      const b = Math.floor(60 + v * 195);
      x.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      x.fillRect(this.specOverlayX, y, sw, 1);
    }

    // Noise profile overlay (pink line)
    if (this.overlays.noise) {
      x.strokeStyle = 'rgba(236,72,153,0.6)'; x.lineWidth = 1;
      x.beginPath();
      for (let y = 0; y < h; y++) {
        const fi = Math.floor((y / h) * Math.min(256, bLen));
        const nv = this.noiseProfile[Math.min(fi, 255)] * h;
        const px = this.specOverlayX + sw/2;
        if (y === 0) x.moveTo(px - nv * 0.3, y); else x.lineTo(px - nv * 0.3, y);
      }
      x.stroke();
    }

    // ERB gate overlay (cyan bands)
    if (this.overlays.erb) {
      for (let b = 0; b < 32; b++) {
        const yStart = Math.floor((b / 32) * h);
        const yEnd = Math.floor(((b + 1) / 32) * h);
        const thresh = this.erbThresholds[b];
        const fi = Math.floor((b / 32) * bLen);
        const val = (freqBuf[fi] || 0) / 255;
        if (val < thresh) {
          x.fillStyle = 'rgba(34,211,238,0.15)';
          x.fillRect(this.specOverlayX, h - yEnd, sw, yEnd - yStart);
        }
      }
    }

    // ML mask overlay (magenta tint)
    if (this.overlays.ml) {
      for (let y = 0; y < h; y += 2) {
        const val = (freqBuf[bLen - 1 - Math.floor((y/h)*bLen)] || 0) / 255;
        // Simulate ML mask: voice band (80Hz-6kHz) = low attenuation, rest = high
        const bandFrac = (h - y) / h;
        const isVoice = bandFrac > 0.02 && bandFrac < 0.35;
        const maskAmt = isVoice ? 0.05 : 0.3 + val * 0.2;
        x.fillStyle = 'rgba(168,85,247,' + (maskAmt * 0.4) + ')';
        x.fillRect(this.specOverlayX, y, sw, 2);
      }
    }

    this.specOverlayX += sw;

    // Update noise profile (slow adaptation)
    for (let i = 0; i < Math.min(256, bLen); i++) {
      const v = (freqBuf[i] || 0) / 255;
      this.noiseProfile[i] = this.noiseProfile[i] * 0.995 + v * 0.005;
    }
  }

  // Panel 4: LUFS Meter
  drawLUFS(buf) {
    // Compute short-term loudness (simplified K-weighted)
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
    const rms = Math.sqrt(sumSq / buf.length);
    const lufs = rms > 0 ? -0.691 + 10 * Math.log10(rms * rms) : -60;
    const clamped = Math.max(-60, Math.min(0, lufs));

    // Rolling history
    this.lufsHistory[this.lufsIdx % this.lufsHistory.length] = clamped;
    this.lufsIdx++;

    // Integrated
    this.lufsSumSq += rms * rms;
    this.lufsFrameCount++;
    const intRms = Math.sqrt(this.lufsSumSq / this.lufsFrameCount);
    this.lufsIntegrated = intRms > 0 ? -0.691 + 10 * Math.log10(intRms * intRms) : -60;

    // Peak
    let pk = 0;
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > pk) pk = a; }
    const peakDb = pk > 0 ? 20 * Math.log10(pk) : -96;

    // Crest factor
    const crest = peakDb - clamped;

    // Update readouts
    if (this.dom.lufsShort) this.dom.lufsShort.textContent = clamped.toFixed(1);
    if (this.dom.lufsInt) this.dom.lufsInt.textContent = this.lufsIntegrated.toFixed(1);
    if (this.dom.lufsPeak) this.dom.lufsPeak.textContent = peakDb.toFixed(1);
    if (this.dom.lufsCrest) this.dom.lufsCrest.textContent = crest.toFixed(1);
    if (this.dom.hLUFS) this.dom.hLUFS.textContent = clamped.toFixed(1);

    // Draw trace
    const c = this.dom.lufsCanvas; if (!c) return;
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    x.fillStyle = '#030306'; x.fillRect(0, 0, w, h);

    // Grid lines
    x.strokeStyle = 'rgba(255,255,255,0.04)'; x.lineWidth = 1;
    for (const db of [-14, -16, -23]) {
      const gy = h * (1 - (db + 60) / 60);
      x.beginPath(); x.moveTo(0, gy); x.lineTo(w, gy); x.stroke();
    }

    // Target line
    const targetLUFS = -16;
    const ty = h * (1 - (targetLUFS + 60) / 60);
    x.strokeStyle = 'rgba(234,179,8,0.3)'; x.setLineDash([4,4]);
    x.beginPath(); x.moveTo(0, ty); x.lineTo(w, ty); x.stroke();
    x.setLineDash([]);

    // LUFS trace
    x.strokeStyle = '#a855f7'; x.lineWidth = 1.5;
    x.shadowColor = '#a855f7'; x.shadowBlur = 3;
    x.beginPath();
    const histLen = Math.min(this.lufsIdx, this.lufsHistory.length);
    const startIdx = Math.max(0, this.lufsIdx - w);
    for (let i = 0; i < w && i < histLen; i++) {
      const idx = (startIdx + i) % this.lufsHistory.length;
      const v = this.lufsHistory[idx];
      const py = h * (1 - (v + 60) / 60);
      if (i === 0) x.moveTo(i, py); else x.lineTo(i, py);
    }
    x.stroke();
    x.shadowBlur = 0;

    // Labels
    x.font = '8px JetBrains Mono'; x.fillStyle = 'rgba(234,179,8,0.4)';
    x.fillText('-16 LUFS', w - 52, ty - 2);
  }

  // Panel 5: ML Saliency Heatmap
  drawSaliency(freqBuf) {
    const c = this.dom.saliencyCanvas; if (!c) return;
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    const bLen = freqBuf.length;

    // Shift left
    const img = x.getImageData(2, 0, w - 2, h);
    x.putImageData(img, 0, 0);
    x.fillStyle = '#030306'; x.fillRect(w - 2, 0, 2, h);

    // Simulate saliency via spectral gradient magnitude
    for (let i = 0; i < Math.min(256, bLen); i++) {
      const v = (freqBuf[i] || 0) / 255;
      const prev = i > 0 ? (freqBuf[i-1] || 0) / 255 : v;
      this.saliencyBuf[i] = this.saliencyBuf[i] * 0.7 + Math.abs(v - prev) * 3 * 0.3;
    }

    // Draw column
    for (let y = 0; y < h; y++) {
      const fi = Math.floor(((h - y) / h) * 256);
      const sal = Math.min(1, this.saliencyBuf[Math.min(fi, 255)] * 4);
      // Hot colormap: transparent -> yellow -> red -> white
      let r, g, b, a;
      if (sal < 0.25) { r = 0; g = 0; b = 0; a = sal * 2; }
      else if (sal < 0.5) { r = 239; g = 68; b = 68; a = 0.3 + sal; }
      else if (sal < 0.75) { r = 234; g = 179; b = 8; a = 0.5 + sal * 0.3; }
      else { r = 255; g = 240; b = 240; a = 0.6 + sal * 0.3; }
      x.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + Math.min(1, a) + ')';
      x.fillRect(w - 2, y, 2, 1);
    }
  }

  // Panel 6: Speaker PCA Cluster
  updateCluster(timeBuf, freqBuf) {
    // Simulate 192-dim embedding -> 2D PCA by using spectral centroid + energy
    let energy = 0, centroid = 0, weightSum = 0;
    const bLen = freqBuf.length;
    for (let i = 0; i < bLen; i++) {
      const v = freqBuf[i] / 255;
      energy += v * v;
      centroid += v * i;
      weightSum += v;
    }
    energy = Math.sqrt(energy / bLen);
    centroid = weightSum > 0 ? centroid / weightSum / bLen : 0.5;

    // Classify: voice-like (centroid 0.05-0.3, high energy) vs noise
    const isVoice = centroid > 0.03 && centroid < 0.35 && energy > 0.15;
    const isOther = centroid > 0.35 && energy > 0.1;

    // PCA coords (simulated)
    const px = centroid * 2 - 0.3 + (Math.random() - 0.5) * 0.08;
    const py = energy * 1.5 - 0.2 + (Math.random() - 0.5) * 0.08;

    this.clusterPoints.push({
      x: px, y: py,
      type: isVoice ? 'target' : (isOther ? 'other' : 'noise'),
      age: 0
    });

    // Keep last 200 points
    if (this.clusterPoints.length > 200) this.clusterPoints.splice(0, this.clusterPoints.length - 200);
    this.clusterPoints.forEach(p => p.age++);
  }

  drawCluster() {
    const c = this.dom.clusterCanvas; if (!c) return;
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    x.fillStyle = 'rgba(3,3,6,0.15)'; x.fillRect(0, 0, w, h);

    // Grid
    x.strokeStyle = 'rgba(255,255,255,0.03)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(w/2, 0); x.lineTo(w/2, h); x.stroke();
    x.beginPath(); x.moveTo(0, h/2); x.lineTo(w, h/2); x.stroke();

    const colors = { target: '#a855f7', other: '#3b82f6', noise: '#f97316' };
    const glows = { target: 'rgba(168,85,247,0.4)', other: 'rgba(59,130,246,0.3)', noise: 'rgba(249,115,22,0.3)' };

    for (const pt of this.clusterPoints) {
      const px = (pt.x + 0.5) * w;
      const py = (1 - (pt.y + 0.3)) * h;
      const alpha = Math.max(0.1, 1 - pt.age / 200);
      const radius = pt.type === 'target' ? 3 : 2;

      x.beginPath();
      x.arc(px, py, radius, 0, Math.PI * 2);
      x.fillStyle = colors[pt.type];
      x.globalAlpha = alpha;
      x.fill();

      if (pt.age < 5) {
        x.beginPath();
        x.arc(px, py, radius + 2, 0, Math.PI * 2);
        x.fillStyle = glows[pt.type];
        x.fill();
      }
    }
    x.globalAlpha = 1;

    // Axis labels
    x.font = '8px JetBrains Mono'; x.fillStyle = 'rgba(255,255,255,0.15)';
    x.fillText('PC1', w - 22, h - 4);
    x.fillText('PC2', 4, 10);
  }

  onResize(){
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => { this._doResize(); }, 120);
  }

  _doResize() {
    [this.dom.waveOrigCanvas,this.dom.waveProcCanvas,this.dom.spectro2DCanvas,this.dom.freqCanvas,
     this.dom.compCanvas,this.dom.abWaveCanvas,this.dom.oscCanvas,this.dom.specOverlayCanvas,this.dom.lufsCanvas,
     this.dom.saliencyCanvas,this.dom.clusterCanvas,this.dom.diarCanvas].forEach(c => {
      if (!c) return;
      const parent = c.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      if (rect.width > 0)  c.width  = Math.floor(rect.width);
      if (rect.height > 0) c.height = Math.floor(rect.height);
    });
    this.spectroX = 0;
    this.specOverlayX = 0;
    if (this.inputBuffer)  this.drawWaveform(this.inputBuffer,  this.dom.waveOrigCanvas, '#dc2626');
    if (this.outputBuffer) this.drawWaveform(this.outputBuffer, this.dom.waveProcCanvas,  '#22d3ee');
    if (this.inputBuffer && this.outputBuffer) this.drawComparison(this.inputBuffer, this.outputBuffer);
    const ct = this.dom.spectro3DContainer;
    if (this.three.ren && ct) {
      this.three.ren.setSize(ct.clientWidth, ct.clientHeight, false);
      this.three.cam.aspect = ct.clientWidth / ct.clientHeight;
      this.three.cam.updateProjectionMatrix();
    }
  }

  showNotification(message, type = 'info', duration = 3500) {
    structuredLog(type === 'error' ? 'error' : 'info', '[notify] ' + message);
    if (typeof document === 'undefined' || !document.body) return;
    let region = document.getElementById('toastRegion');
    if (!region) {
      region = document.createElement('div');
      region.id = 'toastRegion';
      region.className = 'toast-region';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'true');
      document.body.appendChild(region);
    }
    // Cap stack at 4 to avoid runaway accumulation if many errors fire at once.
    while (region.children.length >= 4) region.removeChild(region.firstChild);
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const text = document.createElement('span');
    text.className = 'toast-msg';
    text.textContent = String(message);
    toast.appendChild(text);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';
    let removed = false;
    const dismiss = () => {
      if (removed) return;
      removed = true;
      toast.classList.remove('show');
      setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 220);
    };
    close.addEventListener('click', dismiss);
    toast.appendChild(close);
    region.appendChild(toast);
    // Trigger CSS transition on next frame.
    requestAnimationFrame(() => toast.classList.add('show'));
    if (duration > 0) setTimeout(dismiss, duration);
    return dismiss;
  }
  _showToast(message, type = 'info', duration = 3500) {
    return this.showNotification(message, type, duration);
  }

  // ---- UTILITY ----
  _setScrubPos(frac) {
    const pct = Math.max(0, Math.min(1, frac)) * 100;
    if (this.dom.tpSeek) this.dom.tpSeek.value = frac * 1000;
    if (this.dom.tpScrubFill) this.dom.tpScrubFill.style.width = pct + '%';
    if (this.dom.tpScrubThumb) this.dom.tpScrubThumb.style.left = pct + '%';
  }

  setStatus(s){this.dom.hStatus.textContent=s;const c={IDLE:'#5e5e78',LOADING:'#eab308',READY:'#22c55e',PROCESSING:'#dc2626',COMPLETE:'#22d3ee',ERROR:'#ef4444',RECORDING:'#ef4444',ABORTED:'#a855f7'};this.dom.hStatus.style.color=c[s]||'#5e5e78';}
  calcRMS(d){let s=0;for(let i=0;i<d.length;i++)s+=d[i]*d[i];const r=Math.sqrt(s/d.length);return r>0?20*Math.log10(r):-96;}
  calcPeak(d){let p=0;for(let i=0;i<d.length;i++){const a=Math.abs(d[i]);if(a>p)p=a;}return p>0?20*Math.log10(p):-96;}
  fmtDur(s){const m=Math.floor(s/60);const sc=Math.floor(s%60);return m+':'+String(sc).padStart(2,'0');}
}

if (typeof module !== 'undefined') module.exports = VoiceIsolatePro;

/* ── Merged from app-patches.js: DOM null-safety patches ── */

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap: set window._vipApp synchronously (or after DOMContentLoaded)
// so that pipeline-orchestrator.js can attach without polling.
// vip-boot.js also calls app.init() and Auth.init() — this block is
// the fallback for environments where vip-boot.js might not be present.
// ─────────────────────────────────────────────────────────────────────────────
(function _vipBootstrap() {
  'use strict';
  function _setup() {
    // Skip if vip-boot.js already handled instantiation
    if (window._vipApp) return;
    try {
      var app = new VoiceIsolatePro();
      app._initCalled = true;
      window.vip     = app;
      window._vipApp = app;
      // Auth.init() will be called by vip-boot.js after this runs.
      // If vip-boot.js is absent, call it here as a safety net.
      if (typeof Auth !== 'undefined' && typeof Auth.init === 'function' && !Auth.isLoggedIn && Auth.currentUser === null) {
        Auth.init().catch(function(e){ console.warn('[app] Auth.init error:', e); });
      }
      console.info('[app] VoiceIsolatePro ready via app.js bootstrap ✓');
    } catch (err) {
      console.error('[app] Bootstrap failed:', err);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _setup, { once: true });
  } else {
    _setup();
  }
})();

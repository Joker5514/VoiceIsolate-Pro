/**
 * slider-calibration.js — calibrated DSP transfer functions + usage examples
 * [WHISPER UPDATE] Part 1 & Part 3
 */
'use strict';

export function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export function normUi(v, min, max) {
  if (!Number.isFinite(v) || max <= min) return 0;
  return clamp01((v - min) / (max - min));
}

export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/** Calibrated transfer families (Part 3) */
export const TF = {
  passthrough(v) { return v; },

  expNR(v, e) {
    const ui = normUi(v, e.min, e.max) * 100;
    return clamp01(1 - Math.exp(-4 * (ui / 100)));
  },

  logHz(v, e) {
    const lo = Math.max(e.min, 1e-3);
    const hi = Math.max(e.max, lo + 1);
    const t = normUi(v, e.min, e.max);
    return lo * Math.pow(hi / lo, t);
  },

  quadGain(v, e) {
    return Math.pow(normUi(v, e.min, e.max), 2);
  },

  sqrtTime(v, e) {
    return Math.round(e.min + (e.max - e.min) * Math.sqrt(normUi(v, e.min, e.max)));
  },

  sigmoidWhisper(v, e) {
    const ui = normUi(v, e.min, e.max) * 100;
    return clamp01(sigmoid((ui - 50) / 15));
  },

  bipolarTransient(v, e) {
    return (normUi(v, e.min, e.max) * 2) - 1;
  },

  dryWet(v, e) {
    return normUi(v, e.min, e.max);
  },

  dbPassthrough(v) { return v; },

  eqDb(v, e) {
    return Math.max(e.min, Math.min(e.max, v));
  },
};

/** Per-slider family assignment */
export const SLIDER_FAMILY = {
  gateThresh: 'dbPassthrough', gateRange: 'dbPassthrough',
  gateAttack: 'sqrtTime', gateRelease: 'sqrtTime', gateHold: 'sqrtTime', gateLookahead: 'sqrtTime',
  nrAmount: 'expNR', nrSensitivity: 'expNR', nrSpectralSub: 'expNR', nrFloor: 'dbPassthrough', nrSmoothing: 'expNR',
  eqSub: 'eqDb', eqBass: 'eqDb', eqWarmth: 'eqDb', eqBody: 'eqDb', eqLowMid: 'eqDb',
  eqMid: 'eqDb', eqPresence: 'eqDb', eqClarity: 'eqDb', eqAir: 'eqDb', eqBrill: 'eqDb',
  compThresh: 'dbPassthrough', compRatio: 'quadGain', compAttack: 'sqrtTime', compRelease: 'sqrtTime',
  compKnee: 'quadGain', compMakeup: 'quadGain', limThresh: 'dbPassthrough', limRelease: 'sqrtTime',
  hpFreq: 'logHz', hpQ: 'quadGain', lpFreq: 'logHz', lpQ: 'quadGain',
  deEssFreq: 'logHz', deEssAmt: 'quadGain', specTilt: 'bipolarTransient', formantShift: 'bipolarTransient',
  derevAmt: 'quadGain', derevDecay: 'quadGain', harmRecov: 'quadGain', harmOrder: 'passthrough',
  stereoWidth: 'quadGain', phaseCorr: 'quadGain',
  voiceIso: 'quadGain', bgSuppress: 'quadGain', voiceFocusLo: 'logHz', voiceFocusHi: 'logHz', crosstalkCancel: 'quadGain',
  outGain: 'quadGain', dryWet: 'dryWet', ditherAmt: 'passthrough', outWidth: 'quadGain',
  whisperLift: 'quadGain', crowdNull: 'expNR', bassCrush: 'expNR', reverbStrip: 'sqrtTime',
  voiceTunnel: 'quadGain', musicKill: 'expNR', snrFloor: 'dbPassthrough', whisperMode: 'passthrough',
  whisperClarity: 'sigmoidWhisper', whisperSensitivity: 'sigmoidWhisper', whisperThreshold: 'sigmoidWhisper',
  transientShaper: 'bipolarTransient', breathControl: 'quadGain', roomCorrection: 'quadGain',
  subHarmonic: 'quadGain',
};

/** Usage examples (Part 1) — sliders added after legacy 40 + whisper family */
export const SLIDER_EXAMPLES = {
  harmRecov: [
    { label: 'Podcast Voice', value: 40 },
    { label: 'Studio Vocal', value: 55 },
    { label: 'Field Recording', value: 88 },
  ],
  harmOrder: [
    { label: 'Light Restore', value: 2 },
    { label: 'Natural Speech', value: 3 },
    { label: 'Deep Recovery', value: 6 },
  ],
  stereoWidth: [
    { label: 'Mono Sum', value: 0 },
    { label: 'Natural Stereo', value: 100 },
    { label: 'Wide Stage', value: 160 },
  ],
  phaseCorr: [
    { label: 'Off', value: 0 },
    { label: 'Dual Mic Fix', value: 40 },
    { label: 'Max Correction', value: 80 },
  ],
  voiceIso: [
    { label: 'Podcast Voice', value: 72 },
    { label: 'Studio Vocal', value: 55 },
    { label: 'Field Recording', value: 88 },
  ],
  bgSuppress: [
    { label: 'Light Duck', value: 35 },
    { label: 'Interview', value: 60 },
    { label: 'Forensic', value: 90 },
  ],
  voiceFocusLo: [
    { label: 'Deep Male', value: 80 },
    { label: 'Standard', value: 200 },
    { label: 'Telephone', value: 300 },
  ],
  voiceFocusHi: [
    { label: 'Telephone', value: 3400 },
    { label: 'Broadcast', value: 5000 },
    { label: 'Full Band', value: 8000 },
  ],
  crosstalkCancel: [
    { label: 'Off', value: 0 },
    { label: 'Two-Mic Interview', value: 40 },
    { label: 'Heavy Bleed', value: 75 },
  ],
  outGain: [
    { label: 'Match Input', value: 0 },
    { label: 'Podcast Level', value: 3 },
    { label: 'Whisper Boost', value: 12 },
  ],
  dryWet: [
    { label: 'Full Original', value: 0 },
    { label: 'Blend', value: 75 },
    { label: 'Fully Processed', value: 100 },
  ],
  ditherAmt: [
    { label: 'Off', value: 0 },
    { label: 'Export 16-bit', value: 1 },
    { label: 'Shaped', value: 2 },
  ],
  outWidth: [
    { label: 'Mono', value: 0 },
    { label: 'Natural', value: 100 },
    { label: 'Wide', value: 150 },
  ],
  whisperLift: [
    { label: 'Subtle Lift', value: 12 },
    { label: 'Club Whisper', value: 22 },
    { label: 'Forensic Max', value: 35 },
  ],
  crowdNull: [
    { label: 'Light Crowd', value: 45 },
    { label: 'Stadium', value: 88 },
    { label: 'Max Null', value: 95 },
  ],
  bassCrush: [
    { label: 'Rumble Only', value: 55 },
    { label: 'Club Kick', value: 90 },
    { label: 'Total Sub Kill', value: 98 },
  ],
  reverbStrip: [
    { label: 'Office', value: 200 },
    { label: 'Club RT60', value: 900 },
    { label: 'Cathedral', value: 1800 },
  ],
  voiceTunnel: [
    { label: 'Wide Speech', value: 45 },
    { label: 'Formant Focus', value: 78 },
    { label: 'Narrow Tunnel', value: 92 },
  ],
  musicKill: [
    { label: 'Light Duck', value: 50 },
    { label: 'DJ Background', value: 80 },
    { label: 'Kill Steady Music', value: 95 },
  ],
  snrFloor: [
    { label: 'Catch Faint', value: -58 },
    { label: 'Balanced', value: -52 },
    { label: 'Less Artifacts', value: -42 },
  ],
  whisperMode: [
    { label: 'Off', value: 0 },
    { label: 'Heavy', value: 2 },
    { label: 'Forensic', value: 3 },
  ],
  whisperClarity: [
    { label: 'Podcast Voice', value: 72 },
    { label: 'Studio Vocal', value: 55 },
    { label: 'Field Recording', value: 88 },
  ],
  whisperSensitivity: [
    { label: 'Noisy Club', value: 82 },
    { label: 'Office Ambient', value: 55 },
    { label: 'Silent Room', value: 28 },
  ],
  whisperThreshold: [
    { label: 'Gentle', value: 35 },
    { label: 'Balanced', value: 50 },
    { label: 'Aggressive', value: 78 },
  ],
  transientShaper: [
    { label: 'Soften Attacks', value: -40 },
    { label: 'Neutral', value: 0 },
    { label: 'Sharpen Consonants', value: 45 },
  ],
  breathControl: [
    { label: 'Natural', value: 20 },
    { label: 'ASMR Clean', value: 55 },
    { label: 'Remove Breaths', value: 85 },
  ],
  roomCorrection: [
    { label: 'Light Room', value: 25 },
    { label: 'Echoey Hall', value: 60 },
    { label: 'Deep Dereverb', value: 90 },
  ],
  subHarmonic: [
    { label: 'Off', value: 0 },
    { label: 'Warmth', value: 35 },
    { label: 'Body Boost', value: 65 },
  ],
  eqAir: [
    { label: 'Podcast Voice', value: 72 },
    { label: 'Studio Vocal', value: 55 },
    { label: 'Field Recording', value: 88 },
  ],
  deEssAmt: [
    { label: 'Light', value: 3 },
    { label: 'Podcast', value: 6 },
    { label: 'Harsh Sibilance', value: 12 },
  ],
  derevAmt: [
    { label: 'Small Room', value: 25 },
    { label: 'Conference Hall', value: 55 },
    { label: 'Cathedral', value: 85 },
  ],
  derevDecay: [
    { label: 'Dry Booth', value: 10 },
    { label: 'Office', value: 30 },
    { label: 'Large Hall', value: 70 },
  ],
};

/**
 * Apply calibrated transforms, examples, and workletParam to registry entries.
 */
export function calibrateRegistry(entries) {
  return entries.map((entry) => {
    const family = SLIDER_FAMILY[entry.id] || 'passthrough';
    const tfFn = TF[family] || TF.passthrough;
    const examples = entry.examples || SLIDER_EXAMPLES[entry.id] || null;
    return {
      ...entry,
      workletParam: entry.workletParam || entry.key || entry.id,
      examples,
      family,
      transform: (v) => tfFn(v, entry),
      uiToDsp: (v) => tfFn(v, entry),
    };
  });
}
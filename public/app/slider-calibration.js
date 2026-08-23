/**
 * slider-calibration.js — calibrated DSP transfer functions, coupling rules,
 * and soft artifact guards for separation/isolation sliders.
 *
 * Pure module: no DOM, no side-effects on UI slider positions.
 * Effective values only — visible UI ranges stay unchanged.
 *
 * [HARDENING v25] Separation/isolation slider discipline
 */
'use strict';

export function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function normUi(v, min, max) {
  if (!Number.isFinite(v) || max <= min) return 0;
  return clamp01((v - min) / (max - min));
}

export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/** Debug flag for soft-clamp console warnings (dev only). */
export const CALIBRATION_DEBUG =
  (typeof globalThis !== 'undefined' && globalThis.VIP_DEBUG_CALIBRATION === true);

// ── Coupling / speech-band constants ────────────────────────────────────────
/** Effective voiceIso above this may cap bgSuppress unless speech-safe span. */
export const VOICE_ISO_HIGH_THRESHOLD = 75;
/** Max bgSuppress (effective) when voiceIso is high and band is not speech-safe. */
export const BG_SUPPRESS_CAP_WHEN_ISO_HIGH = 72;
/**
 * Speech-safe span: band must cover at least this frequency width AND
 * intersect the natural speech corridor (≈300–3400 Hz fundamentals+formants).
 */
export const SPEECH_SAFE_MIN_WIDTH_HZ = 2600;
export const SPEECH_SAFE_LO_HZ = 800;
export const SPEECH_SAFE_HI_HZ = 3400;
/** Absolute minimum protected speech window width (never collapse below this). */
export const PROTECTED_SPEECH_MIN_WIDTH_HZ = 1800;
/** Prefer clamping edges toward this natural speech corridor. */
export const SPEECH_CORRIDOR_LO_HZ = 200;
export const SPEECH_CORRIDOR_HI_HZ = 5000;
/** "Stable middle corridor" band-width bounds for bgSuppress auto-correction. */
export const STABLE_BAND_NARROW_HZ = 2200;
export const STABLE_BAND_WIDE_HZ = 9000;
/** Soft-clamp risk thresholds. */
export const ARTIFACT_ISO_EXTREME = 88;
export const ARTIFACT_BG_EXTREME = 82;
export const ARTIFACT_NARROW_BAND_HZ = 2000;

/** Calibrated transfer families (legacy registry + Part 3) */
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
  // Separation sliders: ui→dsp family still used by registry transform; discipline
  // curves live in calibrate() and applyCoupling() for effective DSP values.
  voiceIso: 'passthrough', bgSuppress: 'passthrough',
  voiceFocusLo: 'passthrough', voiceFocusHi: 'passthrough', crosstalkCancel: 'passthrough',
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
    { label: 'Mono Stabilize', value: 40 },
    { label: 'Maximum Blend', value: 80 },
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

// ── Non-linear discipline curves (Task 1a) ──────────────────────────────────

/**
 * Cubic ease-out: f(t) = 1 - (1-t)^3, t in [0,1].
 * Smooth deceleration — large early steps, tiny late steps.
 */
export function easeOutCubic(t) {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

/**
 * Logarithmic taper for upper-range compression (alternate family).
 * f(t) = log(1 + k*t) / log(1+k), k>0. Higher k → more compression at top.
 */
export function logTaper(t, k = 4) {
  const x = clamp01(t);
  return Math.log(1 + k * x) / Math.log(1 + k);
}

/**
 * voiceIso discipline curve (UI raw 0–100 → effective 0–100).
 *
 * Formula (documented):
 *   pivot = 72  (default UI value; preserves current default behavior)
 *   headroom = 14  (max effective lift above pivot at UI=100 → effective ≤ 86)
 *   For raw ≤ pivot:
 *     effective = raw                       // near-linear (identity)
 *   For raw > pivot:
 *     t = (raw - pivot) / (100 - pivot)     // 0 at 72, 1 at 100
 *     effective = pivot + headroom * easeOutCubic(t)
 *   Consequence: UI travel 80→100 (last 20 points) only yields a small
 *   bounded increase in effective isolation (ease-out cubic decelerates hard).
 *
 * At raw=72: effective=72. At raw=100: effective=86. At raw=0: effective=0.
 */
export function curveVoiceIso(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0;
  const pivot = 72;
  const headroom = 14;
  if (v <= pivot) return clamp(v, 0, 100);
  const t = (v - pivot) / (100 - pivot);
  return clamp(pivot + headroom * easeOutCubic(t), 0, 100);
}

/**
 * bgSuppress upper-range safety curve (UI 0–100 → effective 0–100).
 * Linear to 60; above 60, log-taper into remaining 28 effective points
 * so aggressive top-end does not jump abruptly.
 */
export function curveBgSuppress(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0;
  const pivot = 60;
  const headroom = 28; // max effective at 100 = 88
  if (v <= pivot) return clamp(v, 0, 100);
  const t = (v - pivot) / (100 - pivot);
  return clamp(pivot + headroom * logTaper(t, 5), 0, 100);
}

/**
 * crosstalkCancel: conservative by default — strong soft-start, full strength
 * only approached at high UI values (further gated by stereo heuristic in coupling).
 * effective = 100 * (raw/100)^1.85  (power-curve soft-start)
 */
export function curveCrosstalkCancel(raw) {
  const v = clamp(Number(raw) || 0, 0, 100);
  return clamp(100 * Math.pow(v / 100, 1.85), 0, 100);
}

/**
 * Pure per-slider calibration: raw UI value → effective DSP-domain value
 * (same unit scale as the slider display; UI positions are never mutated).
 *
 * @param {string} sliderId
 * @param {number} rawValue
 * @returns {number} effectiveValue
 */
export function calibrate(sliderId, rawValue) {
  const v = Number(rawValue);
  if (!Number.isFinite(v)) return 0;
  switch (sliderId) {
    case 'voiceIso':
      return curveVoiceIso(v);
    case 'bgSuppress':
      return curveBgSuppress(v);
    case 'crosstalkCancel':
      return curveCrosstalkCancel(v);
    case 'voiceFocusLo':
    case 'voiceFocusHi':
      return v; // band edges coupled separately; raw Hz preserved until coupling
    default:
      return v;
  }
}

// ── Coupling rules (Task 1b) ────────────────────────────────────────────────

/**
 * True when voiceFocusLo/Hi define a speech-safe span:
 * width ≥ SPEECH_SAFE_MIN_WIDTH_HZ and band covers [SPEECH_SAFE_LO, SPEECH_SAFE_HI].
 */
export function isSpeechSafeSpan(loHz, hiHz) {
  const lo = Number(loHz);
  const hi = Number(hiHz);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return false;
  const width = hi - lo;
  if (width < SPEECH_SAFE_MIN_WIDTH_HZ) return false;
  return lo <= SPEECH_SAFE_LO_HZ && hi >= SPEECH_SAFE_HI_HZ;
}

/**
 * Enforce protected speech window on focus band edges.
 * Never mutates UI — returns clamped effective { voiceFocusLo, voiceFocusHi }.
 * Bias: when collapsing, prefer keeping [SPEECH_CORRIDOR_LO, SPEECH_CORRIDOR_HI].
 */
export function protectSpeechWindow(loHz, hiHz) {
  let lo = Number(loHz);
  let hi = Number(hiHz);
  if (!Number.isFinite(lo)) lo = SPEECH_CORRIDOR_LO_HZ;
  if (!Number.isFinite(hi)) hi = SPEECH_CORRIDOR_HI_HZ;
  if (hi < lo) {
    const mid = (lo + hi) / 2;
    lo = mid - PROTECTED_SPEECH_MIN_WIDTH_HZ / 2;
    hi = mid + PROTECTED_SPEECH_MIN_WIDTH_HZ / 2;
  }
  let width = hi - lo;
  if (width < PROTECTED_SPEECH_MIN_WIDTH_HZ) {
    const deficit = PROTECTED_SPEECH_MIN_WIDTH_HZ - width;
    // Expand toward natural speech corridor first
    const preferLo = SPEECH_CORRIDOR_LO_HZ;
    const preferHi = SPEECH_CORRIDOR_HI_HZ;
    let expandLo = Math.min(deficit / 2, Math.max(0, lo - preferLo));
    let expandHi = Math.min(deficit / 2, Math.max(0, preferHi - hi));
    lo -= expandLo;
    hi += expandHi;
    width = hi - lo;
    if (width < PROTECTED_SPEECH_MIN_WIDTH_HZ) {
      const still = PROTECTED_SPEECH_MIN_WIDTH_HZ - width;
      lo -= still / 2;
      hi += still / 2;
    }
  }
  lo = clamp(lo, 50, 1000);
  hi = clamp(hi, 1000, 16000);
  if (hi - lo < PROTECTED_SPEECH_MIN_WIDTH_HZ) {
    hi = Math.min(16000, lo + PROTECTED_SPEECH_MIN_WIDTH_HZ);
    if (hi - lo < PROTECTED_SPEECH_MIN_WIDTH_HZ) {
      lo = Math.max(50, hi - PROTECTED_SPEECH_MIN_WIDTH_HZ);
    }
  }
  return { voiceFocusLo: lo, voiceFocusHi: hi };
}

/**
 * Simple stereo-channel-difference heuristic when no pipeline correlation
 * detector is available. Returns strength 0..1.
 * @param {{ leftRms?: number, rightRms?: number, channelDiff?: number, stereoActive?: boolean }|null} stereoHint
 */
export function stereoCorrelationGate(stereoHint) {
  if (!stereoHint || typeof stereoHint !== 'object') return 0;
  if (stereoHint.stereoActive === true) {
    if (Number.isFinite(stereoHint.channelDiff)) {
      return clamp01(Math.abs(stereoHint.channelDiff));
    }
    const L = Number(stereoHint.leftRms) || 0;
    const R = Number(stereoHint.rightRms) || 0;
    const sum = L + R;
    if (sum <= 1e-12) return 0;
    return clamp01(Math.abs(L - R) / sum);
  }
  if (Number.isFinite(stereoHint.channelDiff)) {
    return clamp01(Math.abs(stereoHint.channelDiff));
  }
  return 0;
}

/**
 * Apply coupling rules to a raw (or partially calibrated) param map.
 * Side-effect-only on returned effective values — never mutates inputs or UI.
 *
 * @param {Record<string, number>} rawParams UI/raw values
 * @param {{ stereoHint?: object, debug?: boolean }} [opts]
 * @returns {{ effective: Record<string, number>, clamps: string[] }}
 */
export function applyCoupling(rawParams, opts = {}) {
  const p = rawParams && typeof rawParams === 'object' ? rawParams : {};
  const clamps = [];
  const effective = { ...p };

  // Per-slider discipline curves first
  effective.voiceIso = calibrate('voiceIso', p.voiceIso ?? 72);
  effective.bgSuppress = calibrate('bgSuppress', p.bgSuppress ?? 38);
  effective.crosstalkCancel = calibrate('crosstalkCancel', p.crosstalkCancel ?? 0);

  const band = protectSpeechWindow(p.voiceFocusLo ?? 100, p.voiceFocusHi ?? 4500);
  if (band.voiceFocusLo !== (p.voiceFocusLo ?? 100) || band.voiceFocusHi !== (p.voiceFocusHi ?? 4500)) {
    clamps.push('protected-speech-window');
  }
  effective.voiceFocusLo = band.voiceFocusLo;
  effective.voiceFocusHi = band.voiceFocusHi;

  const bandWidth = effective.voiceFocusHi - effective.voiceFocusLo;
  const speechSafe = isSpeechSafeSpan(effective.voiceFocusLo, effective.voiceFocusHi);

  // Cap bgSuppress when voiceIso is high unless speech-safe span
  if (effective.voiceIso > VOICE_ISO_HIGH_THRESHOLD && !speechSafe) {
    if (effective.bgSuppress > BG_SUPPRESS_CAP_WHEN_ISO_HIGH) {
      effective.bgSuppress = BG_SUPPRESS_CAP_WHEN_ISO_HIGH;
      clamps.push('bgSuppress-cap-high-iso');
    }
  }

  // Stable middle corridor: auto-correct bgSuppress when band too narrow/wide
  if (effective.bgSuppress > 55) {
    if (bandWidth < STABLE_BAND_NARROW_HZ) {
      // Narrow band + high suppress → intelligibility risk; pull suppress down
      const scale = clamp01(bandWidth / STABLE_BAND_NARROW_HZ);
      const corrected = effective.bgSuppress * (0.55 + 0.45 * scale);
      if (corrected < effective.bgSuppress - 0.5) {
        effective.bgSuppress = corrected;
        clamps.push('bgSuppress-stable-narrow');
      }
    } else if (bandWidth > STABLE_BAND_WIDE_HZ) {
      // Too wide → bleed risk; mild reduce so we don't leave wash under high suppress
      const over = (bandWidth - STABLE_BAND_WIDE_HZ) / STABLE_BAND_WIDE_HZ;
      const corrected = effective.bgSuppress * (1 - 0.12 * clamp01(over));
      if (corrected < effective.bgSuppress - 0.5) {
        effective.bgSuppress = corrected;
        clamps.push('bgSuppress-stable-wide');
      }
    }
  }

  // Crosstalk: scale by stereo gate (conservative without stereo evidence)
  const gate = stereoCorrelationGate(opts.stereoHint || null);
  const xtBase = effective.crosstalkCancel;
  // Gate 0 → ~25% of curve strength; gate 1 → full strength
  effective.crosstalkCancel = xtBase * (0.25 + 0.75 * gate);
  if (gate < 0.35 && xtBase > 1) {
    clamps.push('crosstalk-stereo-gate');
  }

  return { effective, clamps };
}

// ── Artifact soft clamps (Task 1c) ──────────────────────────────────────────

/**
 * Soft-clamp known bad combinations (e.g. extreme iso + extreme suppress + narrow band).
 * De-risks effective values sent to DSP; does not snap visible sliders.
 *
 * @param {Record<string, number>} effectiveParams
 * @param {{ debug?: boolean }} [opts]
 * @returns {{ effective: Record<string, number>, activated: string[] }}
 */
export function softClampArtifacts(effectiveParams, opts = {}) {
  const e = { ...(effectiveParams || {}) };
  const activated = [];
  const lo = e.voiceFocusLo ?? 100;
  const hi = e.voiceFocusHi ?? 4500;
  const width = hi - lo;
  const iso = e.voiceIso ?? 0;
  const bg = e.bgSuppress ?? 0;

  const extremeCombo =
    iso >= ARTIFACT_ISO_EXTREME &&
    bg >= ARTIFACT_BG_EXTREME &&
    width <= ARTIFACT_NARROW_BAND_HZ;

  if (extremeCombo) {
    // De-risk: pull both extremes toward safer envelope
    e.voiceIso = Math.min(iso, 82);
    e.bgSuppress = Math.min(bg, 70);
    // Nudge band slightly wider toward speech corridor if possible
    const safeBand = protectSpeechWindow(
      Math.min(lo, SPEECH_CORRIDOR_LO_HZ + 50),
      Math.max(hi, SPEECH_CORRIDOR_HI_HZ - 200),
    );
    e.voiceFocusLo = safeBand.voiceFocusLo;
    e.voiceFocusHi = safeBand.voiceFocusHi;
    activated.push('extreme-iso-bg-narrow-band');
  }

  // Secondary: very high tunnel + high musicKill style risk proxies via bg+iso mid-high
  if (iso >= 90 && bg >= 75 && width < STABLE_BAND_NARROW_HZ) {
    e.bgSuppress = Math.min(e.bgSuppress, 68);
    activated.push('high-iso-narrow-bg');
  }

  const debug = opts.debug === true || CALIBRATION_DEBUG;
  if (debug && activated.length && typeof console !== 'undefined' && console.warn) {
    console.warn('[VIP calibration] soft clamp activated:', activated.join(', '), {
      before: { voiceIso: iso, bgSuppress: bg, width },
      after: { voiceIso: e.voiceIso, bgSuppress: e.bgSuppress, width: e.voiceFocusHi - e.voiceFocusLo },
    });
  }

  return { effective: e, activated };
}

/**
 * Full pipeline: raw UI params → discipline curves → coupling → soft clamps.
 * Single entry point for DSP-side effective values.
 *
 * @param {Record<string, number>} rawParams
 * @param {{ stereoHint?: object, debug?: boolean }} [opts]
 * @returns {Record<string, number>}
 */
export function getEffectiveDspParams(rawParams, opts = {}) {
  const { effective: coupled, clamps } = applyCoupling(rawParams, opts);
  const { effective, activated } = softClampArtifacts(coupled, opts);
  if ((opts.debug || CALIBRATION_DEBUG) && (clamps.length || activated.length)) {
    // Non-blocking dev log for coupling (softClamp logs its own)
    if (clamps.length && typeof console !== 'undefined' && console.debug) {
      console.debug('[VIP calibration] coupling clamps:', clamps.join(', '));
    }
  }
  return effective;
}

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
      // Discipline curve (identity for non-separation sliders)
      calibrate: (v) => calibrate(entry.id, v),
    };
  });
}

/**
 * VoiceIsolate Pro — Preset Calibration Catalog (Layer 1: Core)
 *
 * Canonical Engineer Mode presets after cleanup. Each preset has a clear use
 * case and maps to real DSP parameters. Pure data + helpers.
 */
'use strict';

import { bootstrapScenario } from './DspCalibration.js';
import { buildMlProcessingConfig, getParamSpec } from './ParameterSchema.js';

/**
 * Canonical Standard configuration (DSP-01, LOCAL 2026-11-25).
 *
 * ONE validated processing configuration shared by the Landing default, the
 * Stems default, the Engineer default, and RecommendationEngine-generated
 * default plans. It IS the 'Voice Clarity' preset: maskStrength 0.15 is the
 * sweep winner (scripts/quality/sweep-mask-strength.cjs, LOCAL) — the
 * largest grid value passing all four Standard fixtures at ΔSI-SDR ≥ 0 dB
 * (white +1.56, HVAC +1.05, hum +1.99, music +0.15).
 *
 * PROVISIONAL safe default, not a universal optimum: the music margin is
 * +0.15 dB on a synthetic fixture and the real-audio music-bed stratum
 * (Drive-video round 2) has veto power over finalizing it. Do not describe
 * 0.15 as validated on real music until that stratum lands.
 *
 * The plan's snippet names the gate key `gateFloorDb`; the repo schema
 * calls it `gateThresh` — same value, adapted to the existing schema.
 */
export const STANDARD_CONFIG_VERSION = 1;
export const STANDARD_PROFILE_ID = 'voice-clarity';
export const STANDARD_DEFAULT = Object.freeze({
  profileId: STANDARD_PROFILE_ID,
  profile: 'Voice Clarity',
  maskStrength: 0.15,
  whisperMode: 1,
  whisperLift: 8,
  gateThresh: -58,
});

/** The four canonical keys and their validated values. */
export const STANDARD_CANONICAL_KEYS = Object.freeze({
  maskStrength: 0.15,
  whisperMode: 1,
  whisperLift: 8,
  gateThresh: -58,
});

/**
 * The canonical keys the ML worker consumes and enforces (spectral group).
 * gateThresh is NOT here: it is a Live-Mix realtime parameter (the vip-gate
 * worklet threshold, `rt: true` in ParameterSchema) — part of the Standard
 * PROFILE, set by the preset and applied at playback, but it never reaches
 * the worker (buildMlProcessingConfig drops it from `spectral`, and the
 * worker never reads it). The sweep's measured worker config is therefore
 * these three keys; gateThresh −58 is an Engineer-preset Live-Mix tuning
 * from the S4 whisper fix, governed at the resolver level (a diverged
 * gateThresh still marks the config 'diverged') but enforced by the gate
 * worklet, not the worker. The host forwards exactly this set as the
 * worker's standardConfig; the worker refuses a canonical claim whose
 * spectral values differ from it.
 */
export const STANDARD_WORKER_KEYS = Object.freeze({
  maskStrength: 0.15,
  whisperMode: 1,
  whisperLift: 8,
});

/**
 * Status of the canonical Standard default (DSP-01 + step-8 decision gate).
 *
 * 'provisional' — the 0.15 default is the best-measured safe default on
 * the evidence so far (synthetic floor passes on all four Standard
 * fixtures; Drive rounds 1–2 support it on real audio), but the +0.15 dB
 * synthetic music margin is UNCONFIRMED on real audio: no clip in the
 * 28-clip Drive inventory contains a music bed, and the external
 * music-bed validation (step-8 gate) has not run. Do NOT change this to
 * 'final' until that external recording is measured and passes; the
 * consolidated quality gate (scripts/quality/quality-gate-consolidated.cjs)
 * refuses a 'final' status without that evidence file.
 */
export const STANDARD_DEFAULT_STATUS = 'provisional';

/** Names that resolve to the Standard profile (aliases included). */
export function isStandardProfileName(name) {
  if (!name) return true; // no preset named = the default = Standard
  return resolvePresetName(name) === STANDARD_DEFAULT.profile;
}

/**
 * Numeric overrides of the 'Voice Clarity' preset (numbers only), the
 * values the sweep measured. Used as the base for the canonical build.
 */
export function getStandardDefaultOverrides() {
  const preset = CALIBRATED_ENGINEER_PRESETS[STANDARD_DEFAULT.profile];
  const out = {};
  for (const [k, v] of Object.entries(preset)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Validate the four canonical keys in a values object.
 * Missing keys are NOT errors here — the builder fills them from the
 * canonical default and records the substitution. Present-but-invalid
 * (non-finite or out of schema range) IS an error: a corrupt value must
 * fail closed, never be silently "fixed" into the canonical value.
 * @param {Record<string, unknown>} [values]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateStandardConfig(values = {}) {
  const errors = [];
  for (const [id, canonical] of Object.entries(STANDARD_CANONICAL_KEYS)) {
    if (values?.[id] === undefined || values?.[id] === null) continue;
    const raw = values[id];
    // Type first: a string-typed value ('0.15') arriving through the message
    // protocol is a type/unit mismatch and must be refused, not coerced.
    // Only genuine JS numbers are accepted for a canonical key.
    if (typeof raw !== 'number') {
      errors.push(`${id} is not a number (got ${typeof raw}: ${String(raw)})`);
      continue;
    }
    const spec = getParamSpec(id);
    const v = raw;
    if (!Number.isFinite(v)) {
      errors.push(`${id} is not a finite number (got ${String(values[id])})`);
    } else if (spec && (v < spec.min || v > spec.max)) {
      errors.push(`${id}=${v} is outside the schema range [${spec.min}, ${spec.max}]`);
    } else if (id === 'whisperMode' && !Number.isInteger(v)) {
      errors.push(`whisperMode=${v} is not an integer`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Build the canonical Standard processing config from effective values.
 *
 * Contract (DSP-01):
 * - Starts from the 'Voice Clarity' preset numbers, overlaid with the
 *   caller's effective values for the four canonical keys.
 * - A canonical key ABSENT from the caller's values is filled from the
 *   canonical default and recorded in `standard.substitutions` (safe
 *   fallback, never silent: the substitution is in the returned config).
 * - A canonical key PRESENT but invalid (non-finite / out of range)
 *   throws — fail closed, no silent fallback to a harmful legacy value.
 * - The result is frozen and carries a `standard` block: profileId,
 *   configVersion, status 'canonical', the resolver/source id, the
 *   requested values, the effective values, and every substitution.
 * - `revision` is version-prefixed (`std1:emc1-…`) so a config-version
 *   change invalidates cached plans even when the values are unchanged.
 *   The underlying emc1- hash is untouched (see ParameterSchema).
 * - A caller that wants a NON-canonical config must use
 *   buildMlProcessingConfig directly (or resolveEngineerProcessingConfig,
 *   which decides based on the active preset).
 *
 * @param {Record<string, number>} [values] effective values (e.g. from getEffectiveParams)
 * @param {{ source?: string, requested?: Record<string, unknown>|null }} [options]
 * @returns {ReturnType<typeof buildMlProcessingConfig> & { standard: object }}
 */
export function buildStandardProcessingConfig(values = {}, options = {}) {
  const { source = 'canonical-standard', requested = null } = options;
  const validation = validateStandardConfig(values);
  if (!validation.ok) {
    throw new Error(
      `[VIP] Standard config rejected (${source}): ${validation.errors.join('; ')} — refusing to fall back to a legacy mask value.`,
    );
  }
  const substitutions = [];
  const effective = { ...getStandardDefaultOverrides() };
  for (const [id, canonical] of Object.entries(STANDARD_CANONICAL_KEYS)) {
    const raw = values?.[id];
    if (raw === undefined || raw === null) {
      effective[id] = canonical;
      substitutions.push({
        id,
        requested: raw === undefined ? undefined : raw,
        effective: canonical,
        reason: 'missing — resolved to canonical Standard default',
      });
    } else {
      effective[id] = Number(raw);
    }
  }
  // Non-canonical effective values pass through untouched (coupling already
  // applied by the caller); only the four canonical keys are governed here.
  for (const [k, v] of Object.entries(values || {})) {
    if (!(k in STANDARD_CANONICAL_KEYS)) effective[k] = v;
  }
  const built = buildMlProcessingConfig(effective);
  const standard = Object.freeze({
    profileId: STANDARD_PROFILE_ID,
    profile: STANDARD_DEFAULT.profile,
    configVersion: STANDARD_CONFIG_VERSION,
    status: 'canonical',
    source,
    requested: requested === null ? null : { ...requested },
    effective: Object.freeze({ ...STANDARD_CANONICAL_KEYS }),
    substitutions: Object.freeze(substitutions),
    divergences: Object.freeze([]),
  });
  return Object.freeze({
    ...built,
    revision: `std${STANDARD_CONFIG_VERSION}:${built.revision}`,
    standard,
  });
}

/**
 * Resolve the processing config for an Engineer Process from effective
 * values and the active preset name — the single decision point for the
 * Engineer default path (DSP-01).
 *
 * - Active preset resolves to the Standard profile (or no preset named):
 *   the four canonical keys are checked against the canonical values.
 *   A key present, valid, but DIFFERENT from canonical is a user
 *   divergence: the config is built plain (no standard claim) and the
 *   divergence is returned so the caller can record it — the user changed
 *   a control, so they no longer receive the measured configuration, and
 *   the plan must not claim otherwise.
 * - A key missing is filled by buildStandardProcessingConfig (recorded).
 * - A key present but invalid throws (fail closed, via the builder).
 * - Any other preset: plain buildMlProcessingConfig — the preset's own
 *   values (maskStrength from the preset when it sets one, else the
 *   schema default 1 = as trained). The standard block still records
 *   which preset produced it, so the worker can reject disabled ones.
 *
 * @param {Record<string, number>} [effectiveValues]
 * @param {string|null} [activePresetName]
 * @param {{ source?: string }} [options]
 * @returns {{ config: object, resolution: { mode: 'standard'|'diverged'|'preset', divergences: Array<object>, substitutions: Array<object> } }}
 */
export function resolveEngineerProcessingConfig(effectiveValues = {}, activePresetName = null, options = {}) {
  const { source = 'engineer-process' } = options;
  const values = effectiveValues || {};
  const presetName = resolvePresetName(activePresetName);
  const profileId = presetName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (presetName === STANDARD_DEFAULT.profile) {
    // Validate FIRST: an out-of-range / non-number canonical value is a
    // corrupt config and must throw (fail closed). Only in-range values
    // can be user divergences — without this check an invalid value such
    // as maskStrength 2 was classified as a "divergence" and silently
    // clamped to 1 by the builder (found by tests/standard-config-parity).
    const validation = validateStandardConfig(values);
    if (!validation.ok) {
      throw new Error(
        `[VIP] Standard config rejected (${source}): ${validation.errors.join('; ')} — refusing to fall back to a legacy mask value.`,
      );
    }
    const divergences = [];
    for (const [id, canonical] of Object.entries(STANDARD_CANONICAL_KEYS)) {
      const raw = values[id];
      if (raw === undefined || raw === null) continue;
      const v = Number(raw);
      if (Number.isFinite(v) && v !== canonical) {
        divergences.push({ id, requested: v, effective: v, reason: `differs from canonical Standard value ${canonical} (user control)` });
      }
    }
    if (divergences.length > 0) {
      const built = buildMlProcessingConfig(values);
      return {
        config: Object.freeze({
          ...built,
          standard: Object.freeze({
            profileId: STANDARD_PROFILE_ID,
            profile: STANDARD_DEFAULT.profile,
            configVersion: STANDARD_CONFIG_VERSION,
            status: 'diverged',
            source,
            requested: null,
            effective: null,
            substitutions: Object.freeze([]),
            divergences: Object.freeze(divergences),
          }),
        }),
        resolution: { mode: 'diverged', divergences, substitutions: [] },
      };
    }
    const config = buildStandardProcessingConfig(values, { source, requested: null });
    return {
      config,
      resolution: { mode: 'standard', divergences: [], substitutions: [...config.standard.substitutions] },
    };
  }
  const built = buildMlProcessingConfig(values);
  return {
    config: Object.freeze({
      ...built,
      standard: Object.freeze({
        profileId,
        profile: presetName,
        configVersion: STANDARD_CONFIG_VERSION,
        status: 'preset',
        source,
        requested: null,
        effective: null,
        substitutions: Object.freeze([]),
        divergences: Object.freeze([]),
      }),
    }),
    resolution: { mode: 'preset', divergences: [], substitutions: [] },
  };
}

/**
 * Resolve the processing config for the shared stems path (DSP-01).
 *
 * Rule (the same rule `separateStems` applies — this is the testable home
 * for it, so the Stems path is proven by the same code the path runs):
 * - An explicit processingConfig always wins (including an explicit null).
 * - No config + the single-bsrnn default chain → the canonical Standard
 *   config (the only chain the sweep measured at maskStrength 0.15).
 * - No config + any other chain → null (worker schema default,
 *   maskStrength 1 = as trained). Assigning the Standard config to an
 *   unmeasured chain would be a claim without evidence.
 * @param {string[]} modelIds resolved model chain
 * @param {object|undefined} processingConfig caller's config, if any
 * @returns {object|null}
 */
export function resolveStemDefaultConfig(modelIds, processingConfig) {
  if (processingConfig !== undefined) return processingConfig;
  return (Array.isArray(modelIds) && modelIds.length === 1 && modelIds[0] === 'bsrnn_vocals')
    ? buildStandardProcessingConfig({}, { source: 'stem-separation-default' })
    : null;
}

/**
 * Extreme-off defaults for whisper-path controls (safe when not needed).
 */
export const EXTREME_OFF = Object.freeze({
  whisperLift: 0,
  crowdNull: 0,
  bassCrush: 0,
  reverbStrip: 0,
  voiceTunnel: 0,
  musicKill: 0,
  snrFloor: -52,
  whisperMode: 0,
  whisperClarity: 65,
  whisperSensitivity: 55,
  whisperThreshold: 50,
  transientShaper: 0,
  breathControl: 0,
  roomCorrection: 0,
  subHarmonic: 0,
});

function base(overrides) {
  const clean = bootstrapScenario('cleanSpeech');
  return {
    description: '',
    gateThresh: clean.gateThresh,
    gateRange: clean.gateRange,
    gateAttack: clean.gateAttack,
    gateRelease: clean.gateRelease,
    gateHold: clean.gateHold,
    gateLookahead: 5,
    nrAmount: clean.nrAmount,
    nrSensitivity: clean.nrSensitivity,
    nrSpectralSub: clean.nrSpectralSub,
    nrFloor: clean.nrFloor,
    nrSmoothing: clean.nrSmoothing,
    eqSub: clean.eqSub,
    eqBass: clean.eqBass,
    eqWarmth: clean.eqWarmth,
    eqBody: clean.eqBody,
    eqLowMid: clean.eqLowMid,
    eqMid: clean.eqMid,
    eqPresence: clean.eqPresence,
    eqClarity: clean.eqClarity,
    eqAir: clean.eqAir,
    eqBrill: clean.eqBrill,
    compThresh: -22,
    compRatio: 3.5,
    compAttack: 8,
    compRelease: 140,
    compKnee: 5,
    compMakeup: 1.5,
    limThresh: -1,
    limRelease: 45,
    hpFreq: 70,
    hpQ: 0.7,
    lpFreq: 14000,
    lpQ: 0.7,
    deEssFreq: 6500,
    deEssAmt: 5,
    specTilt: 0,
    formantShift: 0,
    derevAmt: 8,
    derevDecay: 30,
    harmRecov: 0,
    harmOrder: 3,
    stereoWidth: 100,
    phaseCorr: 0,
    voiceIso: 72,
    bgSuppress: 38,
    voiceFocusLo: 100,
    voiceFocusHi: 4200,
    crosstalkCancel: 0,
    outGain: 1,
    dryWet: 100,
    ditherAmt: 0,
    outWidth: 100,
    humRemoval: 0,
    ...EXTREME_OFF,
    ...overrides,
  };
}

/**
 * Calibrated Engineer presets (post-cleanup).
 * Removed redundant extremes; added Room Echo Reduction + Hum Removal + Aggressive Isolate.
 */
export const CALIBRATED_ENGINEER_PRESETS = Object.freeze({
  'Voice Clarity': base({
    description: 'Isolate speech and enhance intelligibility with balanced noise reduction',
    // LM Arena fix session 4 (LOCAL 2026-11-25): whisper preservation.
    // whisperMode 1 + whisperLift 8 route quiet speech through the
    // Light whisper path (modeStrength 0.22) instead of gating it away;
    // gateThresh −58 (from the clean-speech bootstrap −44; the session-4
    // table quoted the schema default −42) keeps soft onsets audible.
    gateThresh: -58,
    whisperMode: 1,
    whisperLift: 8,
    // LM Arena fix session 1 (LOCAL 2026-11-25): mask recalibration.
    // Sweep winner (scripts/quality/sweep-mask-strength.cjs, LOCAL):
    // s=0.15 is the largest grid value passing all four Standard fixtures
    // at ΔSI-SDR ≥ 0 dB (white +1.56, HVAC +1.05, hum +1.99, music +0.15).
    // The session-1 starting candidate 0.25 failed on music (−0.06 dB);
    // the model's estimates understated the improvement at every s.
    maskStrength: 0.15,
  }),
  'Podcast Clean': base({
    description: 'Studio-clean podcast isolation with de-essing and steady loudness',
    gateThresh: -52,
    gateRange: -62,
    gateAttack: 5,
    gateRelease: 200,
    nrAmount: 55,
    eqSub: -1,
    eqWarmth: 1,
    eqBody: 0.5,
    eqMid: 0.5,
    eqPresence: 1,
    deEssAmt: 8,
    deEssFreq: 6500,
    hpFreq: 90,
    breathControl: 28,
    outGain: 0,
  }),
  'Whisper Boost': base({
    description: 'Amplify and isolate soft whispering voices without over-gating consonants',
    gateThresh: -70,
    gateRange: -78,
    gateAttack: 2,
    gateRelease: 140,
    // Gentle Process-time NR, no formant tunnel: both pushed whisper into the
    // Removed stem (t26u; tests/whisper-boost-gentle-cleanup.test.js).
    nrAmount: 30,
    nrSensitivity: 45,
    nrSpectralSub: 42,
    nrFloor: -78,
    nrSmoothing: 68,
    // Export chain (t26u): flat EQ and no compression. The -36 dB / 4.5:1
    // compressor lifted the music between whisper phrases (+11 dB vs input) and
    // cost ~8 dB SI-SDR on a 0 dB whisper+music mix; the EQ boosts cost ~1 dB
    // more. Level: makeup + outGain into the existing true-peak limiter.
    // See tests/whisper-boost-export-chain.test.js.
    eqSub: 0,
    eqBass: 0,
    eqWarmth: 0,
    eqBody: 0,
    eqLowMid: 0,
    eqMid: 0,
    eqPresence: 0,
    eqClarity: 0,
    eqAir: 0,
    eqBrill: 0,
    compThresh: -36,
    compRatio: 1,
    compMakeup: 7,
    outGain: 5,
    whisperLift: 18,
    voiceTunnel: 0,
    whisperMode: 1,
    whisperClarity: 78,
    whisperSensitivity: 72,
    whisperThreshold: 42,
    snrFloor: -58,
    voiceIso: 78,
    bgSuppress: 55,
    derevAmt: 14,
    // Sub/kick cut at Process time. 60 (t26u, synthetic whisper) put ~40 % of a
    // real whisper into the Removed stem; 20 keeps the real whisper-only stem
    // within 1 dB (t29u; tests/whisper-boost-basscrush.test.js).
    bassCrush: 20,
    musicKill: 0,
  }),
  'Phone/Radio': base({
    description: 'Band-limit and isolate speech for phone / radio recovery',
    gateThresh: -48,
    nrAmount: 78,
    nrSensitivity: 68,
    eqSub: -12,
    eqBass: -8,
    eqWarmth: -3,
    eqBody: 0.5,
    eqLowMid: 2.5,
    eqMid: 1.5,
    eqAir: -6,
    eqBrill: -10,
    hpFreq: 280,
    lpFreq: 3800,
    stereoWidth: 0,
    outWidth: 0,
    voiceIso: 88,
    bgSuppress: 74,
    harmRecov: 28,
  }),
  'Room Echo Reduction': base({
    description: 'Reduce room tone and reverb tails while preserving speech clarity',
    // LM Arena fix session 2 (LOCAL 2026-11-25): disabled pending
    // re-qualification — see PRESET_DISABLED below.
    disabled: true,
    disabledReason: 'Disabled: broad attenuation (speech-level ≈ −10 dB on every fixture) and hum/music below the floor. Re-qualification pending.',
    gateThresh: -50,
    nrAmount: 48,
    nrSmoothing: 40,
    derevAmt: 62,
    derevDecay: 58,
    roomCorrection: 55,
    reverbStrip: 420,
    eqPresence: 1.5,
    eqClarity: 1,
    voiceIso: 70,
    bgSuppress: 45,
    outGain: 1,
  }),
  'Hum Removal': base({
    description: 'Target mains hum/buzz with conservative speech preservation',
    gateThresh: -46,
    nrAmount: 40,
    // humRemoval is analyzer/meta (not a rack slider) — keep for RecommendationEngine.
    humRemoval: 85,
    phaseCorr: 28,
    eqSub: -2,
    eqBass: -1,
    hpFreq: 85,
    nrSpectralSub: 55,
    voiceIso: 65,
    bgSuppress: 30,
    outGain: 0,
  }),
  'Forensic Extract': base({
    description: 'Maximum voice extraction for low-SNR analysis — may introduce artifacts',
    gateThresh: -62,
    gateRange: -78,
    gateAttack: 2,
    gateRelease: 90,
    nrAmount: 90,
    nrSensitivity: 78,
    nrSpectralSub: 80,
    nrFloor: -82,
    nrSmoothing: 75,
    eqSub: -6,
    eqBass: -2,
    eqBody: 1.5,
    eqLowMid: 1.5,
    eqMid: 2.5,
    eqPresence: 2.5,
    eqClarity: 1.5,
    eqBrill: -2,
    compThresh: -28,
    compRatio: 6,
    // Makeup + outGain capped so stacked gain stays within limiter headroom.
    compMakeup: 4,
    outGain: 3,
    limThresh: -1,
    derevAmt: 45,
    voiceIso: 92,
    bgSuppress: 85,
    whisperMode: 1,
    whisperLift: 10,
    snrFloor: -56,
  }),
  'Aggressive Isolate': base({
    // LM Arena fix session 2 (LOCAL 2026-11-25): the music-bed claim is
    // withdrawn until the pinned music fixture measures it — the preset
    // stays disabled (PRESET_DISABLED below) meanwhile.
    description: 'Strong voice isolation for dense backgrounds',
    disabled: true,
    disabledReason: 'Disabled: fails every mandatory fixture at baseline (white −6.16 dB SI-SDR delta). Re-qualification pending.',
    gateThresh: -58,
    nrAmount: 88,
    nrSensitivity: 80,
    musicKill: 82,
    bassCrush: 70,
    crowdNull: 70,
    voiceTunnel: 75,
    voiceIso: 94,
    bgSuppress: 90,
    eqPresence: 3,
    eqClarity: 2,
    outGain: 3,
    whisperMode: 0,
  }),
  'Surveillance': base({
    description: 'Field / outdoor noisy recovery with balanced aggression',
    gateThresh: -64,
    gateRange: -78,
    nrAmount: 86,
    nrSensitivity: 80,
    nrSpectralSub: 75,
    nrFloor: -80,
    eqBody: 1.5,
    eqMid: 2.5,
    eqPresence: 2.5,
    voiceIso: 90,
    bgSuppress: 84,
    crowdNull: 75,
    derevAmt: 32,
    outGain: 3,
    limThresh: -1,
    whisperLift: 8,
    whisperMode: 1,
  }),
});

/**
 * Presets removed in cleanup (redirect map for UI/tests).
 * NOTE: 'Whisper in a Club' redirects to 'Aggressive Isolate', which is
 * disabled below — the redirect and the disablement compose: the alias
 * resolves to the disabled preset, and resolveEngineerPreset returns null
 * for it unless acknowledged. Old saved IDs hit the same gate.
 */
export const PRESET_REDIRECTS = Object.freeze({
  'Whisper in a Club': 'Aggressive Isolate',
  'Stadium Crowd': 'Surveillance',
});

/**
 * Disabled presets (LM Arena fix session 2, LOCAL 2026-11-25).
 *
 * Both fail every mandatory fixture at the 492e971 baseline (Audio Truth
 * Pack, LOCAL — synthetic fixtures, seed 41):
 * - 'Aggressive Isolate': white −6.16, HVAC −4.00, hum −7.80, music −3.65,
 *   whisper-white −4.21 dB SI-SDR delta; speech-level ≈ −11 dB on every
 *   fixture. Re-qualification: ΔSI-SDR ≥ 0 dB on every mandatory fixture
 *   (white, HVAC, hum, music, whisper-clean, whisper-white-10db) PLUS a
 *   music-specific efficacy measure before any music-suppression wording
 *   returns.
 * - 'Room Echo Reduction': hum −3.28, music −1.09 dB; speech-level
 *   ≈ −10 dB on every fixture (broad attenuation). Re-qualification:
 *   ΔSI-SDR ≥ 0 dB on every mandatory fixture AND plain-SDR confirms the
 *   broad attenuation is gone (no plain-SDR acceptance tolerance was
 *   supplied — define one before qualifying).
 *
 * The audio of a disabled preset is still measurable (the Truth Pack runs
 * it) — disablement is a selection policy, not a deletion. Nothing here
 * changes any preset's audio; it only stops the preset being applied.
 *
 * Single source of truth: the `disabled` / `disabledReason` flags on the
 * preset objects above. This map is derived from them so the resolver and
 * the Engineer UI (which reads the flags off the preset objects) cannot
 * drift apart.
 */
export const PRESET_DISABLED = Object.freeze(
  Object.fromEntries(
    Object.entries(CALIBRATED_ENGINEER_PRESETS)
      .filter(([, p]) => p.disabled === true)
      .map(([name, p]) => [name, p.disabledReason || 'Disabled pending re-qualification.']),
  ),
);

/** True when the resolved preset is disabled (aliases resolve first). */
export function isPresetDisabled(name) {
  return Object.prototype.hasOwnProperty.call(PRESET_DISABLED, resolvePresetName(name));
}

/** The disablement reason for a preset, or null when it is not disabled. */
export function presetDisabledReason(name) {
  return PRESET_DISABLED[resolvePresetName(name)] ?? null;
}

/**
 * Resolve a preset name for application. Disabled presets resolve to null
 * unless the caller passes `{ acknowledged: true }` — an explicit,
 * manual-only acknowledgement that the preset is disabled pending
 * re-qualification. Aliases resolve first, so old saved IDs and both
 * redirects hit the same gate.
 * @param {string} name
 * @param {{ acknowledged?: boolean }} [options]
 * @returns {string|null}
 */
export function resolveEngineerPreset(name, options = {}) {
  const resolved = resolvePresetName(name);
  if (Object.prototype.hasOwnProperty.call(PRESET_DISABLED, resolved) && options.acknowledged !== true) {
    return null;
  }
  return resolved;
}

/**
 * Resolve a preset name through redirects.
 * @param {string} name
 */
export function resolvePresetName(name) {
  if (!name) return 'Voice Clarity';
  if (CALIBRATED_ENGINEER_PRESETS[name]) return name;
  if (PRESET_REDIRECTS[name]) return PRESET_REDIRECTS[name];
  return 'Voice Clarity';
}

/**
 * Get full preset map (copy) for UI injection.
 */
export function getCalibratedPresets() {
  const out = {};
  for (const [k, v] of Object.entries(CALIBRATED_ENGINEER_PRESETS)) {
    out[k] = { ...v };
  }
  return out;
}

export default {
  EXTREME_OFF,
  CALIBRATED_ENGINEER_PRESETS,
  PRESET_REDIRECTS,
  PRESET_DISABLED,
  STANDARD_CONFIG_VERSION,
  STANDARD_PROFILE_ID,
  STANDARD_DEFAULT,
  STANDARD_CANONICAL_KEYS,
  STANDARD_WORKER_KEYS,
  isStandardProfileName,
  getStandardDefaultOverrides,
  validateStandardConfig,
  buildStandardProcessingConfig,
  resolveEngineerProcessingConfig,
  resolvePresetName,
  isPresetDisabled,
  presetDisabledReason,
  resolveEngineerPreset,
  getCalibratedPresets,
};

/**
 * dsp-stages.js — VoiceIsolate Pro · Threads from Space v8
 * ==========================================================
 * Implements the 32 named DSP stages of the Deca-Pass pipeline as
 * pure, side-effect-free spectral operators (magnitude/phase arrays in-place).
 *
 * All functions operate on Float32Array magnitude and/or phase arrays
 * in-place to maintain the Single-Pass STFT architecture:
 *   computeSTFT() → [these stage functions] → reconstructISTFT()
 *
 * Stages are grouped into 4 passes of 8 stages each:
 *   Pass 1 (1–8)   : Pre-processing & gating
 *   Pass 2 (9–16)  : Spectral ML masking
 *   Pass 3 (17–24) : Voice EQ & formant shaping
 *   Pass 4 (25–32) : Dynamics, limiting & output
 *
 * Usage:
 *   import { applyStage } from './dsp-stages.js';
 *   applyStage(stageName, mag, pha, params, sampleRate);
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Convert a frequency in Hz to the nearest FFT bin index.
 * @param {number} hz         - Frequency in Hz
 * @param {number} fftSize    - FFT size (default 4096)
 * @param {number} sampleRate - Sample rate (default 44100)
 * @returns {number} bin index
 */
function hzToBin(hz, fftSize = 4096, sampleRate = 44100) {
  return Math.round((hz / sampleRate) * fftSize);
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 1: Pre-processing (Stages 1–8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stage 1 — DC Removal
 * Zero out the DC bin (k=0) to prevent low-frequency rumble artifacts.
 */
export function stageDCRemoval(mag, pha) {
  mag[0] = 0;
  pha[0] = 0;
}

/**
 * Stage 2 — High-Pass Filter (spectral zeroing)
 * Attenuates bins below hpFreqHz with a soft roll-off (3-bin transition band).
 * @param {Float32Array} mag
 * @param {Float32Array} pha
 * @param {{ hpFreq: number }} params
 * @param {number} sampleRate
 */
export function stageHighPass(mag, pha, params, sampleRate = 44100) {
  const fftSize = (mag.length - 1) * 2;
  const cutoff  = hzToBin(params.hpFreq || 80, fftSize, sampleRate);
  const ramp    = 3;
  for (let k = 0; k <= Math.min(cutoff + ramp, mag.length - 1); k++) {
    const gain = k <= cutoff - ramp ? 0
               : k >= cutoff + ramp ? 1
               : (k - (cutoff - ramp)) / (2 * ramp);
    mag[k] *= gain;
  }
}

/**
 * Stage 3 — Low-Pass Filter (spectral zeroing)
 * Attenuates bins above lpFreqHz with a soft roll-off.
 */
export function stageLowPass(mag, pha, params, sampleRate = 44100) {
  const fftSize  = (mag.length - 1) * 2;
  const cutoff   = hzToBin(params.lpFreq || 18000, fftSize, sampleRate);
  const ramp     = 3;
  for (let k = Math.max(0, cutoff - ramp); k < mag.length; k++) {
    const gain = k >= cutoff + ramp ? 0
               : k <= cutoff - ramp ? 1
               : 1 - (k - (cutoff - ramp)) / (2 * ramp);
    mag[k] *= gain;
  }
}

/**
 * Stage 4 — Pre-Emphasis
 * Boost high frequencies before NR to equalise spectral energy.
 * Equivalent to a 1st-order high-shelf IIR applied in the spectral domain.
 */
export function stagePreEmphasis(mag, pha, params) {
  const strength = Math.max(0, Math.min(1, params.preEmphasis ?? 0.5));
  const halfBins = mag.length;
  for (let k = 1; k < halfBins; k++) {
    const shelf = 1 + strength * (k / halfBins);  // linear ramp up to 2× at Nyquist
    mag[k] *= shelf;
  }
}

/**
 * Stage 5 — Noise Gate (spectral)
 * Apply a per-bin gate: bins below the threshold are attenuated by gateRange dB.
 */
export function stageNoiseGate(mag, pha, params) {
  const threshLin = Math.pow(10, (params.gateThresh ?? -42) / 20);
  const rangeGain = Math.pow(10, (params.gateRange  ?? -60) / 20);
  for (let k = 0; k < mag.length; k++) {
    if (mag[k] < threshLin) mag[k] *= rangeGain;
  }
}

/**
 * Stage 6 — Spectral Subtraction (classical NR warm-up fallback)
 * Used when ML models are not yet warm. Reduces magnitude by nrAmount.
 * params.nrAmount is 0..100 (percent) from the slider; converted to 0..2 internally.
 */
export function stageSpectralSubtraction(mag, pha, params) {
  const alpha = Math.max(0, Math.min(2, (params.nrAmount ?? 78) / 50));
  const floor = 0.001;
  for (let k = 0; k < mag.length; k++) {
    mag[k] = Math.max(floor, mag[k] * Math.max(0, 1 - alpha * 0.4));
  }
}

/**
 * Stage 7 — Dithering (noise shaping)
 * Adds low-level white noise to prevent quantisation artifacts during
 * subsequent 16-bit export. params.ditherAmt is in bits (0..10 slider range);
 * 1 bit ≈ -96 dBFS for 16-bit export. Uses crypto.getRandomValues() for
 * cryptographically uniform noise (not Math.random()).
 */
export function stageDither(mag, pha, params) {
  const bits = params.ditherAmt ?? 1;
  // 1 bit dither at 16-bit depth: amplitude ≈ 2^-(17 - bits)
  const ditherLin = Math.pow(2, -(17 - Math.max(0, Math.min(10, bits))));
  const randBuf = new Uint32Array(mag.length);
  globalThis.crypto.getRandomValues(randBuf);
  for (let k = 0; k < mag.length; k++) {
    // Map Uint32 [0, 2^32) uniformly to [-1, 1) and scale by dither amplitude
    const r = (randBuf[k] / 4294967296) * 2 - 1;
    mag[k] += ditherLin * r;
    if (mag[k] < 0) mag[k] = 0;
  }
}

/**
 * Stage 8 — Input Level Trim
 * Scales magnitude by an input gain factor (linear, from dB param).
 */
export function stageInputGain(mag, pha, params) {
  const gain = Math.pow(10, (params.inputGain ?? 0) / 20);
  for (let k = 0; k < mag.length; k++) mag[k] *= gain;
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 2: Spectral ML Masking (Stages 9–16)
// These are applied from pipeline-orchestrator.js after ONNX inference.
// Stage 9  — Apply VAD gate mask
// Stage 10 — Apply Demucs vocal separation mask
// Stage 11 — Apply BSRNN vocal mask
// Stage 12 — Apply RNNoise residual NR mask
// Stage 13 — Blend / combine masks
// Stage 14 — Spectral floor enforcement
// Stage 15 — Harmonic restoration (VoiceFixer, ENTERPRISE)
// Stage 16 — Inter-stage normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stage 9 — Apply ML mask to magnitude spectrum.
 * @param {Float32Array} mag  - Magnitude bins (modified in place)
 * @param {Float32Array} pha  - Phase bins (unmodified)
 * @param {Float32Array} mask - Soft mask in [0,1] from ml-worker.js
 */
export function stageApplyMask(mag, pha, mask) {
  const len = Math.min(mag.length, mask.length);
  for (let k = 0; k < len; k++) {
    const m = Math.max(0, Math.min(1, mask[k]));
    mag[k] *= m;
  }
}

export function stageVADMask(mag, pha, params) {
  if (params.vadMask instanceof Float32Array) stageApplyMask(mag, pha, params.vadMask);
}

export function stageDemucsMask(mag, pha, params) {
  if (params.demucsMask instanceof Float32Array) stageApplyMask(mag, pha, params.demucsMask);
}

export function stageBSRNNMask(mag, pha, params) {
  if (params.bsrnnMask instanceof Float32Array) stageApplyMask(mag, pha, params.bsrnnMask);
}

export function stageRNNoiseMask(mag, pha, params) {
  if (params.rnnoiseMask instanceof Float32Array) stageApplyMask(mag, pha, params.rnnoiseMask);
}

export function stageMaskBlend(mag, pha, params) {
  if (!(params.blendMask instanceof Float32Array)) return;
  const blend = Math.max(0, Math.min(1, params.maskBlend ?? 1));
  const len = Math.min(mag.length, params.blendMask.length);
  for (let k = 0; k < len; k++) {
    const m = Math.max(0, Math.min(1, params.blendMask[k]));
    const blended = (1 - blend) + blend * m;
    mag[k] *= blended;
  }
}

/**
 * Stage 14 — Spectral floor enforcement.
 * Prevents complete spectral silence (preserves naturalness).
 */
export function stageSpectralFloor(mag, pha, params) {
  const floor = Math.max(0, params.spectralFloor ?? 0.005);
  for (let k = 0; k < mag.length; k++) {
    if (mag[k] < floor) mag[k] = floor;
  }
}

export function stageHarmonicRestore(mag, pha, params) {
  const amount = Math.max(0, Math.min(1, params.harmonicRestore ?? 0));
  if (amount === 0) return;
  for (let k = 1; k < mag.length; k++) {
    const prev = mag[k - 1];
    const next = k + 1 < mag.length ? mag[k + 1] : mag[k];
    const local = (prev + next) * 0.5;
    mag[k] += (local - mag[k]) * amount * 0.15;
  }
}

/**
 * Stage 16 — Peak normalisation.
 * Scale so that the loudest bin does not exceed normTarget (linear).
 */
export function stageNormalise(mag, pha, params) {
  const target = Math.pow(10, (params.normTarget ?? 0) / 20);
  let peak = 0;
  for (let k = 0; k < mag.length; k++) if (mag[k] > peak) peak = mag[k];
  if (peak > 0 && peak !== target) {
    const gain = target / peak;
    for (let k = 0; k < mag.length; k++) mag[k] *= gain;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 3: Voice EQ & Formant Shaping (Stages 17–24)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stage 17 — Formant Enhancer
 * Boost the first two formant regions (F1: 500–900 Hz, F2: 1000–2500 Hz)
 * to increase vocal presence and intelligibility.
 */
export function stageFormantEnhance(mag, pha, params, sampleRate = 44100) {
  const strength = Math.max(0, Math.min(2, params.formantEnhance ?? 1.0));
  const fftSize  = (mag.length - 1) * 2;
  const f1Lo = hzToBin(500,  fftSize, sampleRate);
  const f1Hi = hzToBin(900,  fftSize, sampleRate);
  const f2Lo = hzToBin(1000, fftSize, sampleRate);
  const f2Hi = hzToBin(2500, fftSize, sampleRate);
  for (let k = f1Lo; k <= Math.min(f1Hi, mag.length - 1); k++) {
    mag[k] *= 1 + 0.3 * strength;
  }
  for (let k = f2Lo; k <= Math.min(f2Hi, mag.length - 1); k++) {
    mag[k] *= 1 + 0.4 * strength;
  }
}

/**
 * Stage 18 — Presence Boost
 * Boost 2–6 kHz 'presence' region — improves speech clarity on recordings.
 */
export function stagePresenceBoost(mag, pha, params, sampleRate = 44100) {
  const strength = Math.max(0, Math.min(2, params.presenceBoost ?? 1.0));
  const fftSize  = (mag.length - 1) * 2;
  const lo = hzToBin(2000, fftSize, sampleRate);
  const hi = hzToBin(6000, fftSize, sampleRate);
  for (let k = lo; k <= Math.min(hi, mag.length - 1); k++) {
    mag[k] *= 1 + 0.25 * strength;
  }
}

/**
 * Stage 19 — De-Esser
 * Attenuate sibilant frequencies (5–10 kHz) to reduce harsh 'S'/'T' sounds.
 * params.deEssAmt is 0..30 dB (slider range); converted to 0..1 reduction factor.
 */
export function stageDeEsser(mag, pha, params, sampleRate = 44100) {
  const reduction = Math.max(0, Math.min(1, (params.deEssAmt ?? 9) / 30));
  const fftSize   = (mag.length - 1) * 2;
  const lo = hzToBin(5000,  fftSize, sampleRate);
  const hi = hzToBin(10000, fftSize, sampleRate);
  for (let k = lo; k <= Math.min(hi, mag.length - 1); k++) {
    mag[k] *= 1 - reduction;
  }
}

/**
 * Stage 20 — Vocal EQ: parametric 4-band
 * params.eq[] = [ { freq, gain, q }, ... ] (up to 4 bands)
 */
export function stageVocalEQ(mag, pha, params, sampleRate = 44100) {
  const bands = params.eq || [];
  const fftSize = (mag.length - 1) * 2;
  for (const band of bands) {
    const { freq = 1000, gain = 0, q = 1 } = band;
    const centerBin = hzToBin(freq, fftSize, sampleRate);
    const bw = Math.max(1, Math.round(centerBin / Math.max(0.1, q)));
    const linearGain = Math.pow(10, gain / 20);
    for (let k = Math.max(0, centerBin - bw); k <= Math.min(mag.length - 1, centerBin + bw); k++) {
      const t = 1 - Math.abs(k - centerBin) / bw;
      mag[k] *= 1 + (linearGain - 1) * t;
    }
  }
}

/**
 * Stage 21 — Air Band Boost
 * Adds subtle shimmer at 12–20 kHz — makes vocals sound "broadcast ready".
 */
export function stageAirBand(mag, pha, params, sampleRate = 44100) {
  const strength = Math.max(0, Math.min(1, params.airBand ?? 0.15));
  const fftSize  = (mag.length - 1) * 2;
  const lo = hzToBin(12000, fftSize, sampleRate);
  for (let k = lo; k < mag.length; k++) {
    mag[k] *= 1 + strength;
  }
}

/**
 * Stage 22 — Warmth (Low-Mid Boost)
 * Boosts 150–500 Hz to add body/warmth to thin vocals.
 */
export function stageWarmth(mag, pha, params, sampleRate = 44100) {
  const strength = Math.max(0, Math.min(1, params.warmth ?? 0.2));
  const fftSize  = (mag.length - 1) * 2;
  const lo = hzToBin(150, fftSize, sampleRate);
  const hi = hzToBin(500, fftSize, sampleRate);
  for (let k = lo; k <= Math.min(hi, mag.length - 1); k++) {
    mag[k] *= 1 + strength;
  }
}

/**
 * Stage 23 — Stereo Width (mid-side spectral processing)
 * Not applicable for mono; reserved for stereo interleaved buffers.
 * No-op for now — placeholder maintains stage count.
 */
export function stageStereoWidth(mag, pha, params) {
  void mag;
  void pha;
  void params;
  // Mono path: no-op. Stereo implementation routes mid/side channels separately.
}

/**
 * Stage 24 — De-Reverb (spectral mean subtraction)
 * Estimate and subtract reverb tail by subtracting a running spectral mean.
 * params.derevAmt is 0..100 (percent slider); converted to 0..1 strength.
 */
export function stageDeReverb(mag, pha, params) {
  // Simple spectral mean subtraction as a lightweight de-reverb approximation.
  const strength = Math.max(0, Math.min(1, (params.derevAmt ?? 0) / 100));
  let sum = 0;
  for (let k = 0; k < mag.length; k++) sum += mag[k];
  const mean = sum / mag.length;
  for (let k = 0; k < mag.length; k++) {
    mag[k] = Math.max(0, mag[k] - mean * strength);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 4: Dynamics, Limiting & Output (Stages 25–32)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stage 25 — Spectral Compressor
 * Per-bin dynamic range compression using instantaneous magnitude as the
 * envelope. Reduces peaks and brings up quiet detail (same as tube/valve warmth).
 */
export function stageSpectralCompressor(mag, pha, params) {
  const threshold  = Math.pow(10, (params.compThresh  ?? -24) / 20);
  const ratio      = Math.max(1, params.compRatio     ?? 4);
  const kneeDb     = Math.max(0, params.compKnee ?? 6);
  const hasSoftKnee = kneeDb > 1e-6;
  const knee       = hasSoftKnee ? Math.pow(10, kneeDb / 20) : 1;
  const makeupGain = Math.pow(10, (params.compMakeup  ?? 0)  / 20);

  for (let k = 0; k < mag.length; k++) {
    const m = mag[k];
    let out;
    if (!hasSoftKnee) {
      if (m <= threshold) {
        out = m;
      } else {
        out = threshold * Math.pow(m / threshold, 1 / ratio);
      }
    } else if (m < threshold / knee) {
      out = m;  // below knee — unity
    } else if (m < threshold * knee) {
      // Soft knee transition
      const db = 20 * Math.log10(Math.max(1e-9, m / threshold));
      const dbReduced = db + (1 / ratio - 1) * (db + kneeDb) ** 2 / (4 * kneeDb);
      out = threshold * Math.pow(10, dbReduced / 20);
    } else {
      // Above knee — full compression
      out = threshold * Math.pow(m / threshold, 1 / ratio);
    }
    mag[k] = out * makeupGain;
  }
}

/**
 * Stage 26 — Transient Shaper
 * Enhances or suppresses attack transients via an onset detector.
 * params.transientAttack: +/- ratio (0 = unity)
 */
export function stageTransientShaper(mag, pha, params) {
  const attack = Math.max(-1, Math.min(1, params.transientAttack ?? 0));
  if (attack === 0) return;
  // Spectral proxy: high-frequency bins (> Nyquist/2) carry transient energy
  const midBin = Math.floor(mag.length / 2);
  const gain   = 1 + attack;
  for (let k = midBin; k < mag.length; k++) mag[k] *= gain;
}

/**
 * Stage 27 — Saturation / Harmonic Exciter
 * Applies mild soft-clipping to the magnitude spectrum to add harmonic warmth.
 */
export function stageSaturation(mag, pha, params) {
  const drive = Math.max(0, Math.min(10, params.saturation ?? 0));
  if (drive === 0) return;
  const dFactor = 1 + drive * 0.1;
  for (let k = 0; k < mag.length; k++) {
    // Soft-knee tanh saturation
    mag[k] = Math.tanh(mag[k] * dFactor) / dFactor;
  }
}

/**
 * Stage 28 — Wet/Dry Mix (return path)
 * Blend processed magnitude with original unprocessed magnitude.
 * originalMag must be preserved before the pipeline starts.
 * params.dryWet is 0..100 (percent slider); converted to 0..1 fraction internally.
 */
export function stageWetDry(mag, pha, originalMag, params) {
  const wet = Math.max(0, Math.min(1, (params.dryWet ?? 100) / 100));
  const dry = 1 - wet;
  for (let k = 0; k < mag.length; k++) {
    mag[k] = wet * mag[k] + dry * (originalMag ? originalMag[k] : mag[k]);
  }
}

/**
 * Stage 29 — Output Gain
 * Apply final output trim (in dB) to the magnitude spectrum.
 */
export function stageOutputGain(mag, pha, params) {
  const gain = Math.pow(10, (params.outGain ?? 0) / 20);
  for (let k = 0; k < mag.length; k++) mag[k] *= gain;
}

/**
 * Stage 30 — True Peak Limiter (spectral)
 * Hard-limits the maximum bin magnitude to prevent digital clipping on iSTFT.
 */
export function stageLimiter(mag, pha, params) {
  const ceilLin = Math.pow(10, (params.limThresh ?? -1) / 20);
  for (let k = 0; k < mag.length; k++) {
    if (mag[k] > ceilLin) mag[k] = ceilLin;
  }
}

/**
 * Stage 31 — Silence Trim
 * Zero out any bins below the absolute noise floor (~-140 dBFS)
 * to prevent float denormal performance issues.
 */
export function stageSilenceTrim(mag, pha) {
  void pha;
  const floor = 1e-7; // ~-140 dBFS
  for (let k = 0; k < mag.length; k++) {
    if (mag[k] < floor) { mag[k] = 0; }
  }
}

/**
 * Stage 32 — Safety Clamp
 * Final sanity pass: replace NaN/Infinity with 0, clamp negatives.
 * This is the last stage before iSTFT and must never be skipped.
 */
export function stageSafetyClamp(mag, pha) {
  for (let k = 0; k < mag.length; k++) {
    if (!Number.isFinite(mag[k]) || mag[k] < 0) mag[k] = 0;
    if (!Number.isFinite(pha[k])) pha[k] = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage router — maps string stage names to handler functions
// ─────────────────────────────────────────────────────────────────────────────
const STAGE_MAP = {
  'dc-removal':          stageDCRemoval,
  'high-pass':           stageHighPass,
  'low-pass':            stageLowPass,
  'pre-emphasis':        stagePreEmphasis,
  'noise-gate':          stageNoiseGate,
  'spectral-subtraction':stageSpectralSubtraction,
  'dither':              stageDither,
  'input-gain':          stageInputGain,
  'vad-mask':            stageVADMask,
  'demucs-mask':         stageDemucsMask,
  'bsrnn-mask':          stageBSRNNMask,
  'rnnoise-mask':        stageRNNoiseMask,
  'mask-blend':          stageMaskBlend,
  'apply-mask':          (mag, pha, p) => p.mask && stageApplyMask(mag, pha, p.mask),
  'spectral-floor':      stageSpectralFloor,
  'harmonic-restore':    stageHarmonicRestore,
  'normalise':           stageNormalise,
  'formant-enhance':     stageFormantEnhance,
  'presence-boost':      stagePresenceBoost,
  'de-esser':            stageDeEsser,
  'vocal-eq':            stageVocalEQ,
  'air-band':            stageAirBand,
  'warmth':              stageWarmth,
  'stereo-width':        stageStereoWidth,
  'de-reverb':           stageDeReverb,
  'spectral-compressor': stageSpectralCompressor,
  'transient-shaper':    stageTransientShaper,
  'saturation':          stageSaturation,
  'wet-dry':             (mag, pha, p) => stageWetDry(mag, pha, p.originalMag, p),
  'output-gain':         stageOutputGain,
  'limiter':             stageLimiter,
  'silence-trim':        stageSilenceTrim,
  'safety-clamp':        stageSafetyClamp,
};

/**
 * Apply a named DSP stage to magnitude/phase arrays.
 *
 * @param {string}       stageName  - One of the keys in STAGE_MAP
 * @param {Float32Array} mag        - Magnitude spectrum (modified in place)
 * @param {Float32Array} pha        - Phase spectrum
 * @param {object}       params     - DSP parameter object (merged from slider-map.js)
 * @param {number}       sampleRate - Audio sample rate (default 44100)
 */
export function applyStage(stageName, mag, pha, params = {}, sampleRate = 44100) {
  const fn = STAGE_MAP[stageName];
  if (!fn) {
    globalThis.console?.warn?.(`[dsp-stages] Unknown stage: '${stageName}'`);
    return;
  }
  fn(mag, pha, params, sampleRate);
}

/**
 * Apply all 32 spectral DSP stages in order given a stage-enable map.
 * pipeline-orchestrator.js can call this for the classical spectral pass.
 *
 * Param units: stage functions read slider-map.js raw units (percent 0..100,
 * dB, Hz). Each stage converts internally to its required scale (e.g. nrAmount
 * 0..100 → 0..2, dryWet 0..100 → 0..1, deEssAmt 0..30 dB → 0..1 reduction).
 * The optional presenceBoost and formantEnhance keys are internal strengths (0..2)
 * not exposed as sliders; they default to 1.0 when absent.
 *
 * @param {Float32Array} mag        - Magnitude spectrum
 * @param {Float32Array} pha        - Phase spectrum
 * @param {Float32Array} originalMag- Unprocessed magnitude for wet/dry mix
 * @param {object}       params     - DSP params from slider-map.js (percent/dB/Hz; each stage normalises internally)
 * @param {object}       stageFlags - { [stageName]: boolean } enable/disable per stage
 * @param {number}       sampleRate
 */
export function runFullPipeline(mag, pha, originalMag, params = {}, stageFlags = {}, sampleRate = 44100) {
  const stages = [
    'dc-removal', 'high-pass', 'low-pass', 'pre-emphasis',
    'noise-gate', 'spectral-subtraction', 'dither', 'input-gain',
    'vad-mask', 'demucs-mask', 'bsrnn-mask', 'rnnoise-mask',
    'mask-blend', 'spectral-floor', 'harmonic-restore', 'normalise',
    'formant-enhance', 'presence-boost', 'de-esser', 'vocal-eq',
    'air-band', 'warmth', 'stereo-width', 'de-reverb',
    'spectral-compressor', 'transient-shaper', 'saturation', 'wet-dry',
    'output-gain', 'limiter', 'silence-trim', 'safety-clamp',
  ];

  const stageParams = { ...params, originalMag };
  for (const name of stages) {
    if (stageFlags[name] === false) continue; // explicitly disabled
    applyStage(name, mag, pha, stageParams, sampleRate);
  }
}

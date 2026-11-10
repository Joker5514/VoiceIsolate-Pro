/*
 * VoiceIsolate Pro — mask-aware high-frequency post-filter (Layer 2 classic-worker helper)
 *
 * Loaded by MLWorker with importScripts(); runs inside the one fused
 * STFT/iSTFT pass (runFusedSpectralMaskChain), on the already-masked bins,
 * before the Engineer frame processor. No extra analysis or reconstruction.
 *
 * Why: the shipped vocal masks leak noise above ~8 kHz (mask^0.5 / ^0.15
 * calibration keeps HF masks near 1 on noise-like bins). PR #714 hid that
 * with an always-on shelf (gain 1 → 0.45 from 8.4 kHz to Nyquist) that also
 * attenuated a unity mask; PR #895 removed it. This filter attenuates HF bins
 * only where BOTH
 *   1. the model is not confident (fused mask below MASK_SURE), and
 *   2. a noise tracker says the bin is noise (low speech-presence probability),
 * so a unity / confident mask, or a bin well above the tracked noise floor,
 * passes untouched.
 *
 * Noise tracker: minima-controlled recursive averaging (MCRA; Cohen &
 * Berdugo, IEEE SPL 9(1), 2002; Martin, IEEE TSAP 9(5), 2001): the input
 * power is smoothed over 3 bins and ~100 ms, its minimum tracked over two
 * sub-windows of ~0.75 s, and the noise estimate is the bias-corrected
 * minimum. Speech presence is a soft decision on the smoothed a posteriori
 * SNR, smoothed again over time (the MCRA indicator/averaging, used here as
 * a soft-decision SPP as in OM-LSA, Cohen & Berdugo, Signal Processing
 * 81(11), 2001, and Gerkmann & Hendriks, IEEE TASLP 20(4), 2012).
 * The resulting gain is smoothed across frequency (3 taps) and over time
 * with a bounded decay per frame (RNNoise's 0.6-per-frame cap; Valin,
 * MMSP 2018), so isolated bins cannot flicker (musical noise).
 */
'use strict';

(function installHfPostFilter(scope) {
  /** Transition into the processed band (Hz): no change below LO, full weight above HI. */
  const BAND_LO_HZ = 7000;
  const BAND_HI_HZ = 9000;
  /** Fused mask at or above this is "confident": no HF reduction at all. */
  const MASK_SURE = 0.995;
  /** Fused mask at or below this counts as fully uncertain. */
  const MASK_UNSURE = 0.9;
  /** Deepest HF gain (−16.5 dB) where the bin is noise and the mask unsure. */
  const GAIN_FLOOR = 0.15;
  /** Soft speech-presence decision on the a posteriori SNR (dB). */
  const SPP_LO_DB = 4;
  const SPP_HI_DB = 12;
  /** Minimum-statistics bias correction (Martin 2001; MCRA Bmin ≈ 1.66). */
  const MIN_BIAS = 1.66;
  /** Time constants (s): power smoothing, SPP smoothing, minimum window. */
  const POWER_TAU = 0.1;
  const SPP_TAU = 0.06;
  const MIN_WINDOW = 1.5;
  /** Bounded gain decay per 10 ms (RNNoise caps decay at 0.6 per 10 ms frame). */
  const DECAY_PER_10MS = 0.6;

  function smoothStep(x, a, b) {
    if (x <= a) return 0;
    if (x >= b) return 1;
    const t = (x - a) / (b - a);
    return t * t * (3 - 2 * t);
  }

  /**
   * @param {{ fftSize: number, hop: number, bins: number, sampleRate: number }} geometry
   * @param {{ enabled?: boolean }} [opts]
   */
  function createHfPostFilter(geometry, opts = {}) {
    const { fftSize, hop, bins, sampleRate } = geometry;
    if (opts.enabled === false || !(sampleRate > 2 * BAND_LO_HZ)) return null;
    const binHz = sampleRate / fftSize;
    const k0 = Math.min(bins, Math.max(1, Math.floor(BAND_LO_HZ / binHz)));
    const n = bins - k0;
    if (n <= 2) return null;
    const frameSec = hop / sampleRate;
    const aPow = Math.exp(-frameSec / POWER_TAU);
    const aSpp = Math.exp(-frameSec / SPP_TAU);
    const decay = Math.pow(DECAY_PER_10MS, frameSec / 0.01);
    // Two sub-windows (MCRA/MS): the minimum spans between 1 and 2 of them.
    const subFrames = Math.max(2, Math.round(MIN_WINDOW / 2 / frameSec));

    const weight = new Float32Array(n);
    for (let i = 0; i < n; i++) weight[i] = smoothStep((k0 + i) * binHz, BAND_LO_HZ, BAND_HI_HZ);
    const smoothed = new Float64Array(n); // S: time/freq-smoothed input power
    const minCur = new Float64Array(n); // running minimum of this sub-window
    const minPrev = new Float64Array(n); // minimum of the previous sub-window
    const spp = new Float32Array(n);
    const gain = new Float32Array(n).fill(1);
    const raw = new Float32Array(n);
    const sure = new Uint8Array(n);
    const pf = new Float64Array(n);
    let frames = 0;

    /**
     * Apply in place to one masked frame.
     * @param {Float32Array} re masked real bins (0..bins-1)
     * @param {Float32Array} im masked imaginary bins
     * @param {Float32Array} mags input magnitudes (unmasked) for this frame at `off`
     * @param {number} off offset of this frame in `mags`
     * @param {Float32Array} mask fused (smoothed) mask of this frame, per bin
     */
    function applyFrame(re, im, mags, off, mask) {
      // Frequency-smoothed input power (3 taps), MCRA's local energy.
      for (let i = 0; i < n; i++) {
        const k = k0 + i;
        const c = mags[off + k];
        const l = k > 0 ? mags[off + k - 1] : c;
        const r = k + 1 < bins ? mags[off + k + 1] : c;
        pf[i] = 0.25 * l * l + 0.5 * c * c + 0.25 * r * r;
      }
      const first = frames === 0;
      // Warm-up: the minimum starts at the first frame's power, which is
      // speech when a file opens on speech. Ramp the depth in over one
      // minimum sub-window so an opening is never mistaken for noise.
      const depth = Math.min(1, frames / subFrames) * (1 - GAIN_FLOOR);
      const roll = !first && frames % subFrames === 0;
      for (let i = 0; i < n; i++) {
        const s = first ? pf[i] : aPow * smoothed[i] + (1 - aPow) * pf[i];
        smoothed[i] = s;
        if (first) { minCur[i] = s; minPrev[i] = s; }
        else if (roll) { minPrev[i] = minCur[i]; minCur[i] = s; }
        else if (s < minCur[i]) minCur[i] = s;
        const noise = MIN_BIAS * Math.min(minCur[i], minPrev[i]) + 1e-20;
        // MCRA indicator on the smoothed power S / (Bmin * Smin): the
        // smoothing keeps single-frame noise peaks from flipping a bin to
        // "speech" (isolated pass-through bins are musical noise).
        const snrDb = 10 * Math.log10(s / noise + 1e-12);
        const q = smoothStep(snrDb, SPP_LO_DB, SPP_HI_DB);
        // Attack at once (onsets and sibilants pass), release over SPP_TAU.
        const held = aSpp * spp[i] + (1 - aSpp) * q;
        spp[i] = first || q > held ? q : held;
        // Uncertainty is 0 for a confident mask: those bins are never touched.
        const unsure = 1 - smoothStep(mask[k0 + i], MASK_UNSURE, MASK_SURE);
        sure[i] = unsure === 0 ? 1 : 0;
        raw[i] = 1 - weight[i] * unsure * (1 - spp[i]) * depth;
      }
      frames++;
      // 3-tap frequency smoothing, then a bounded decay over time (rises are
      // immediate, so onsets are not dulled).
      for (let i = 0; i < n; i++) {
        const l = i > 0 ? raw[i - 1] : raw[i];
        const r = i + 1 < n ? raw[i + 1] : raw[i];
        // A confident-mask bin keeps exactly 1. Others take the 3-tap
        // average, which pulls an isolated pass-through bin down to its
        // neighbours instead of leaving a lone spectral peak.
        let g = sure[i] ? 1 : 0.25 * l + 0.5 * raw[i] + 0.25 * r;
        if (!first && !sure[i]) g = Math.max(g, gain[i] * decay);
        if (g > 1) g = 1;
        gain[i] = g;
        if (g < 1) {
          re[k0 + i] *= g;
          im[k0 + i] *= g;
        }
      }
    }

    return { applyFrame, firstBin: k0 };
  }

  scope.createHfPostFilter = createHfPostFilter;
  scope.VipHfPostFilter = Object.freeze({
    BAND_LO_HZ, BAND_HI_HZ, MASK_SURE, MASK_UNSURE, GAIN_FLOOR, SPP_LO_DB, SPP_HI_DB,
  });
})(typeof self !== 'undefined' ? self : globalThis);

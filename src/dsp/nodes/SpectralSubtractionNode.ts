/**
 * VoiceIsolate Pro v14.0 – SpectralSubtractionNode
 * Multi-band Wiener filter with over-subtraction control and musical-noise
 * suppression via spectral flooring.
 *
 * Algorithm:
 *   Ŝ(k) = max( |X(k)|² - α·λ(k), β·|X(k)|² ) / |X(k)|²
 *   where:
 *     α = over-subtraction factor (1.0–2.0)
 *     β = spectral floor (0.002 recommended)
 *     λ(k) = noise power estimate at bin k
 */

import type { AudioConfig, DSPContext, DSPNode, GainVector, SpectralFrame } from '../types.js';

/** Frequency bands for multi-band processing (Hz boundaries) */
const BAND_BOUNDARIES_HZ = [0, 300, 1000, 3000, 8000, 12000, 24000];

/** Per-band over-subtraction factors: more aggressive for low freqs (HVAC noise) */
const BAND_ALPHA = [2.0, 1.8, 1.5, 1.3, 1.2, 1.1];

/** Spectral floor per band (prevents over-suppression) */
const BAND_BETA = [0.005, 0.003, 0.002, 0.002, 0.001, 0.001];

export class SpectralSubtractionNode implements DSPNode {
  readonly id = 'spectral-subtraction';
  readonly name = 'Multi-Band Wiener Filter';
  bypass = false;

  /** Global over-subtraction multiplier (UI-controllable) */
  overSubtractionFactor = 1.0; // scales BAND_ALPHA values

  /** Minimum post-filter SNR in dB (lower = more aggressive) */
  minSNRdB = -20;

  private bins = 0;
  private sampleRate = 0;
  private fftSize = 0;

  /** Smoothed gain vector from previous frame (prevents harsh transients) */
  private prevGain: GainVector = new Float32Array(0);
  /** Temporal smoothing: α for gain changes */
  private readonly gainAlpha = 0.85;

  /** Noise power estimator – Decision-Directed approach weight */
  private readonly ddAlpha = 0.98;
  private ddPriorSNR: Float32Array = new Float32Array(0);

  /** Band → [binLow, binHigh) mapping */
  private bands: Array<{ lo: number; hi: number; alpha: number; beta: number }> = [];

  async initialize(config: AudioConfig): Promise<void> {
    this.bins = config.fftSize / 2 + 1;
    this.sampleRate = config.sampleRate;
    this.fftSize = config.fftSize;
    this.prevGain = new Float32Array(this.bins).fill(1.0);
    this.ddPriorSNR = new Float32Array(this.bins).fill(1.0);

    // Build band mapping
    this.bands = [];
    for (let b = 0; b < BAND_BOUNDARIES_HZ.length - 1; b++) {
      const lo = Math.round((BAND_BOUNDARIES_HZ[b] * config.fftSize) / config.sampleRate);
      const hi = Math.min(
        this.bins,
        Math.round((BAND_BOUNDARIES_HZ[b + 1] * config.fftSize) / config.sampleRate)
      );
      if (lo < hi) {
        this.bands.push({ lo, hi, alpha: BAND_ALPHA[b], beta: BAND_BETA[b] });
      }
    }
  }

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass) {
      ctx.gainVector = new Float32Array(this.bins).fill(1.0);
      return;
    }

    const { spectralFrame, noiseProfile } = ctx;
    if (!spectralFrame || !noiseProfile?.isReady) return;

    const gain = this.computeGain(spectralFrame, noiseProfile.meanPower, noiseProfile.stdPower);

    // Temporal smoothing of gain vector
    for (let k = 0; k < this.bins; k++) {
      gain[k] = this.gainAlpha * this.prevGain[k] + (1 - this.gainAlpha) * gain[k];
      this.prevGain[k] = gain[k];
    }

    // Apply gain to spectral frame's magnitude
    for (let k = 0; k < this.bins; k++) {
      spectralFrame.magnitude[k] *= gain[k];
    }

    ctx.gainVector = gain;
    ctx.diagnostics['spectralSub.avgGain'] = this.averageGain(gain);
  }

  // ---------------------------------------------------------------------------

  private computeGain(
    frame: SpectralFrame,
    noiseMean: Float32Array,
    noiseStd: Float32Array
  ): GainVector {
    const gain = new Float32Array(this.bins);
    const minGain = Math.pow(10, this.minSNRdB / 20);

    for (const band of this.bands) {
      const alpha = band.alpha * this.overSubtractionFactor;
      const beta = band.beta;

      for (let k = band.lo; k < band.hi; k++) {
        const xPow = frame.magnitude[k] * frame.magnitude[k];
        const noisePow = noiseMean[k] + noiseStd[k]; // conservative estimate

        // Decision-Directed prior SNR update
        const postSNR = Math.max(xPow / (noisePow + 1e-12) - 1, 0);
        const priorSNR = this.ddAlpha * this.ddPriorSNR[k] + (1 - this.ddAlpha) * postSNR;
        this.ddPriorSNR[k] = priorSNR;

        // Wiener gain H(k) = priorSNR / (priorSNR + 1)
        const wienerGain = priorSNR / (priorSNR + 1);

        // Over-subtraction with spectral floor
        const numerator = Math.max(xPow - alpha * noisePow, beta * xPow);
        const subGain = xPow > 1e-12 ? Math.sqrt(numerator / xPow) : 0;

        // Combine Wiener estimate and spectral subtraction
        gain[k] = Math.max(Math.min(0.7 * wienerGain + 0.3 * subGain, 1.0), minGain);
      }
    }

    return gain;
  }

  private averageGain(gain: GainVector): number {
    let sum = 0;
    for (let k = 0; k < this.bins; k++) sum += gain[k];
    return sum / this.bins;
  }

  dispose(): void {
    this.prevGain = new Float32Array(0);
    this.ddPriorSNR = new Float32Array(0);
  }
}

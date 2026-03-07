/**
 * VoiceIsolate Pro v14.0 – ERBGateNode
 * 32-band Bark-scale spectral gate operating in the ERB (Equivalent Rectangular
 * Bandwidth) domain.  Each band gets an independent soft gate threshold computed
 * from the noise floor estimate; bands below threshold are attenuated.
 *
 * ERB scale: ERB(f) = 24.7 * (4.37 * f/1000 + 1)
 * Bark scale used to distribute 32 bands up to Nyquist.
 */

import type { AudioConfig, DSPContext, DSPNode, ERBBand, GainVector } from '../types.js';

/** Soft gate knee width in dB – transition region between open/closed gate */
const GATE_KNEE_DB = 6;
/** Gate close attenuation (dB). Residual to avoid total silence artefacts. */
const GATE_FLOOR_DB = -60;
/** Gate open ratio: 1.0 = full pass, can be < 1 for subtle gating */
const GATE_OPEN_RATIO = 1.0;
/** Temporal smoothing: separate attack/release constants */
const GATE_ATTACK_MS = 5;
const GATE_RELEASE_MS = 50;

export class ERBGateNode implements DSPNode {
  readonly id = 'erb-gate';
  readonly name = '32-Band ERB Spectral Gate';
  bypass = false;

  /** Gate threshold offset above noise floor in dB (UI-controllable) */
  thresholdOffsetDB = 6;

  private bands: ERBBand[] = [];
  private bins = 0;
  private sampleRate = 0;
  private fftSize = 0;

  /** Per-band smoothed gain (attack/release) */
  private bandGain: Float32Array = new Float32Array(32);
  private attackCoeff = 0;
  private releaseCoeff = 0;

  /** Pre-computed gate floor (linear) */
  private readonly gateFloor = Math.pow(10, GATE_FLOOR_DB / 20);

  async initialize(config: AudioConfig): Promise<void> {
    this.sampleRate = config.sampleRate;
    this.fftSize = config.fftSize;
    this.bins = config.fftSize / 2 + 1;
    this.bandGain = new Float32Array(32).fill(1.0);

    const hopDurMs = (1000 * config.hopSize) / config.sampleRate;
    this.attackCoeff = Math.exp(-2.2 / (GATE_ATTACK_MS / hopDurMs));
    this.releaseCoeff = Math.exp(-2.2 / (GATE_RELEASE_MS / hopDurMs));

    this.bands = this.buildERBBands(32, config.sampleRate, config.fftSize);
  }

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass) return;

    const { spectralFrame, noiseProfile } = ctx;
    if (!spectralFrame || !noiseProfile?.isReady) return;

    const gainVec: GainVector = ctx.gainVector ?? new Float32Array(this.bins).fill(1.0);

    for (let b = 0; b < this.bands.length; b++) {
      const band = this.bands[b];

      // Compute band signal power and noise power
      let signalPow = 0;
      let noisePow = 0;
      const span = band.binHigh - band.binLow;
      if (span <= 0) continue;

      for (let k = band.binLow; k < band.binHigh; k++) {
        signalPow += spectralFrame.magnitude[k] * spectralFrame.magnitude[k];
        noisePow += noiseProfile.meanPower[k] + noiseProfile.stdPower[k];
      }
      signalPow /= span;
      noisePow /= span;

      // Threshold: noise floor + offset
      const threshPow = noisePow * Math.pow(10, this.thresholdOffsetDB / 10);

      // Compute target gate gain (soft-knee)
      const targetGain = this.softGate(signalPow, threshPow);

      // Apply attack/release smoothing
      const coeff = targetGain >= this.bandGain[b] ? this.attackCoeff : this.releaseCoeff;
      this.bandGain[b] = coeff * this.bandGain[b] + (1 - coeff) * targetGain;

      // Apply band gain to magnitude and existing gain vector
      const g = this.bandGain[b];
      for (let k = band.binLow; k < band.binHigh; k++) {
        spectralFrame.magnitude[k] *= g;
        gainVec[k] *= g;
      }
    }

    ctx.gainVector = gainVec;
    ctx.diagnostics['erbGate.bands'] = this.bands.length;
  }

  // ---------------------------------------------------------------------------

  /**
   * Soft-knee gate: returns linear gain [gateFloor, 1.0]
   * Transition from closed to open over GATE_KNEE_DB around threshold.
   */
  private softGate(signalPow: number, threshPow: number): number {
    if (threshPow < 1e-12) return GATE_OPEN_RATIO;
    const snrDB = 10 * Math.log10((signalPow + 1e-12) / (threshPow + 1e-12));
    const kneeHalf = GATE_KNEE_DB / 2;

    if (snrDB >= kneeHalf) return GATE_OPEN_RATIO;
    if (snrDB <= -kneeHalf) return this.gateFloor;

    // Cubic interpolation within knee
    const t = (snrDB + kneeHalf) / GATE_KNEE_DB; // 0..1
    const smooth = t * t * (3 - 2 * t); // smoothstep
    return this.gateFloor + smooth * (GATE_OPEN_RATIO - this.gateFloor);
  }

  /**
   * Build 32 ERB-spaced bands up to Nyquist.
   * Uses Greenwood function approximation for Bark spacing.
   */
  private buildERBBands(numBands: number, sampleRate: number, fftSize: number): ERBBand[] {
    const nyquist = sampleRate / 2;
    const bands: ERBBand[] = [];

    // Generate center frequencies on ERB scale
    const erbLow = this.hzToERB(20);
    const erbHigh = this.hzToERB(nyquist);
    const erbStep = (erbHigh - erbLow) / numBands;

    for (let b = 0; b < numBands; b++) {
      const erbCenter = erbLow + (b + 0.5) * erbStep;
      const erbEdgeLo = erbLow + b * erbStep;
      const erbEdgeHi = erbLow + (b + 1) * erbStep;

      const centerHz = this.erbToHz(erbCenter);
      const loHz = this.erbToHz(erbEdgeLo);
      const hiHz = this.erbToHz(erbEdgeHi);
      const erbWidth = hiHz - loHz;

      const binLow = Math.max(0, Math.round((loHz * fftSize) / sampleRate));
      const binHigh = Math.min(fftSize / 2 + 1, Math.round((hiHz * fftSize) / sampleRate) + 1);

      bands.push({ index: b, binLow, binHigh, centerHz, erbWidth });
    }

    return bands;
  }

  /** Hz → ERB rate (Moore & Glasberg 1990) */
  private hzToERB(hz: number): number {
    return 21.4 * Math.log10(1 + hz / 229);
  }

  /** ERB rate → Hz */
  private erbToHz(erb: number): number {
    return 229 * (Math.pow(10, erb / 21.4) - 1);
  }

  get erbBands(): ERBBand[] {
    return this.bands;
  }

  dispose(): void {
    this.bandGain = new Float32Array(0);
    this.bands = [];
  }
}

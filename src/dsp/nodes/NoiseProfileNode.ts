/**
 * VoiceIsolate Pro v14.0 – NoiseProfileNode
 * Captures spectral statistics of the first `noiseProfileDuration` seconds,
 * then marks the profile as ready for downstream nodes.
 *
 * Strategy:
 *   1. Accumulate power spectra over N frames.
 *   2. Compute running mean and variance (Welford online algorithm).
 *   3. Apply exponential smoothing so the profile can slowly adapt.
 */

import type { AudioConfig, DSPContext, DSPNode, NoiseProfile, SpectralFrame } from '../types.js';
import { FFTEngine } from '../fft.js';

/** Minimum SNR (dB) below which a frame is considered "noise-only" */
const NOISE_GATE_DB = -40;

export class NoiseProfileNode implements DSPNode {
  readonly id = 'noise-profiler';
  readonly name = 'Noise Profiler';
  bypass = false;

  private config!: AudioConfig;
  private fft!: FFTEngine;
  private bins = 0;

  private profile: NoiseProfile = {
    meanPower: new Float32Array(0),
    stdPower: new Float32Array(0),
    isReady: false,
    frameCount: 0,
    capturedAt: 0,
  };

  /** Welford accumulators */
  private M: Float64Array = new Float64Array(0); // running mean
  private S: Float64Array = new Float64Array(0); // running sum of squared deviations

  /** Exponential smoothing factor for live adaptation after profile is ready */
  private readonly adaptAlpha = 0.001;

  /** Target frame count for initial capture */
  private targetFrames = 0;

  /** Callback fired once profile is ready */
  onProfileReady?: (profile: NoiseProfile) => void;

  async initialize(config: AudioConfig): Promise<void> {
    this.config = config;
    this.fft = new FFTEngine(config);
    this.bins = config.fftSize / 2 + 1;

    this.profile = {
      meanPower: new Float32Array(this.bins),
      stdPower: new Float32Array(this.bins),
      isReady: false,
      frameCount: 0,
      capturedAt: 0,
    };

    this.M = new Float64Array(this.bins);
    this.S = new Float64Array(this.bins);

    // Frames needed = profile duration * sampleRate / hopSize
    this.targetFrames = Math.ceil(
      (config.noiseProfileDuration * config.sampleRate) / config.hopSize
    );
  }

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass) {
      // Provide a flat (near-zero) profile so downstream nodes can still run
      if (!this.profile.isReady) this.markReady(ctx.inputFrame.timestamp);
      ctx.noiseProfile = this.profile;
      return;
    }

    if (!ctx.spectralFrame) {
      // No FFT frame yet – compute one in-place
      ctx.spectralFrame = this.analyzeChunk(ctx);
    }

    const frame = ctx.spectralFrame;
    const n = this.profile.frameCount + 1;

    if (!this.profile.isReady) {
      // Welford online update
      this.updateWelford(frame, n);
      this.profile.frameCount = n;

      if (n >= this.targetFrames) {
        this.finalizeProfile();
        this.markReady(frame.timestamp);
        this.onProfileReady?.(this.profile);
      }
    } else {
      // Slow exponential adaptation
      this.adaptProfile(frame);
    }

    ctx.noiseProfile = this.profile;
    ctx.diagnostics['noiseProfile.ready'] = this.profile.isReady ? 1 : 0;
    ctx.diagnostics['noiseProfile.frames'] = this.profile.frameCount;
  }

  // ---------------------------------------------------------------------------

  private analyzeChunk(ctx: DSPContext): SpectralFrame {
    const { data, frameCount } = ctx.inputFrame;
    const N = this.config.fftSize;
    const slice = data.length >= N ? data.subarray(0, N) : new Float32Array(N).fill(0);
    if (data.length < N) slice.set(data);
    return this.fft.analyze(slice, ctx.inputFrame.timestamp | 0, ctx.inputFrame.timestamp);
  }

  private updateWelford(frame: SpectralFrame, n: number): void {
    for (let k = 0; k < this.bins; k++) {
      const p = frame.magnitude[k] * frame.magnitude[k];
      const delta = p - this.M[k];
      this.M[k] += delta / n;
      const delta2 = p - this.M[k];
      this.S[k] += delta * delta2;
    }
  }

  private finalizeProfile(): void {
    const n = this.profile.frameCount;
    for (let k = 0; k < this.bins; k++) {
      this.profile.meanPower[k] = this.M[k];
      this.profile.stdPower[k] = n > 1 ? Math.sqrt(this.S[k] / (n - 1)) : 0;
    }
  }

  private adaptProfile(frame: SpectralFrame): void {
    const alpha = this.adaptAlpha;
    for (let k = 0; k < this.bins; k++) {
      const p = frame.magnitude[k] * frame.magnitude[k];
      const diff = p - this.profile.meanPower[k];
      // Only update if this bin looks like noise (power within 2σ of profile mean)
      if (Math.abs(diff) < 2 * this.profile.stdPower[k] + 1e-10) {
        this.profile.meanPower[k] += alpha * diff;
        this.profile.stdPower[k] =
          (1 - alpha) * this.profile.stdPower[k] +
          alpha * Math.sqrt(Math.abs(diff));
      }
    }
  }

  private markReady(timestamp: number): void {
    this.profile.isReady = true;
    this.profile.capturedAt = timestamp;
  }

  /** Force-inject a pre-captured noise profile (e.g. from a saved session) */
  injectProfile(mean: Float32Array, std: Float32Array): void {
    this.profile.meanPower.set(mean);
    this.profile.stdPower.set(std);
    this.profile.isReady = true;
    this.profile.capturedAt = Date.now() / 1000;
  }

  get currentProfile(): NoiseProfile {
    return this.profile;
  }

  dispose(): void {
    this.M = new Float64Array(0);
    this.S = new Float64Array(0);
  }
}

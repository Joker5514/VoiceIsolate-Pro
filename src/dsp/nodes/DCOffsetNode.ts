/**
 * VoiceIsolate Pro v14.0 – DCOffsetNode
 * High-pass IIR filter (1st-order) removes DC bias from PCM frames.
 * R ≈ 0.9998 → -3dB at ~0.5 Hz @ 48kHz; zero phase shift at audible frequencies.
 */

import type { AudioConfig, DSPContext, DSPNode } from '../types.js';

export class DCOffsetNode implements DSPNode {
  readonly id = 'dc-offset-remover';
  readonly name = 'DC Offset Remover';
  bypass = false;

  /** IIR coefficient – closer to 1.0 = lower cutoff frequency */
  private readonly R = 0.9998;

  /** Per-channel IIR state [x[n-1], y[n-1]] */
  private stateX: Float64Array = new Float64Array(0);
  private stateY: Float64Array = new Float64Array(0);

  private channels = 1;

  async initialize(config: AudioConfig): Promise<void> {
    this.channels = config.channels;
    this.stateX = new Float64Array(config.channels);
    this.stateY = new Float64Array(config.channels);
  }

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass) return;

    const { data, channels, frameCount } = ctx.inputFrame;
    const R = this.R;

    for (let ch = 0; ch < channels; ch++) {
      let xPrev = this.stateX[ch];
      let yPrev = this.stateY[ch];

      for (let i = 0; i < frameCount; i++) {
        const idx = i * channels + ch;
        const x = data[idx];
        // y[n] = x[n] - x[n-1] + R * y[n-1]
        const y = x - xPrev + R * yPrev;
        data[idx] = Math.max(-1, Math.min(1, y)); // clip guard
        xPrev = x;
        yPrev = y;
      }

      this.stateX[ch] = xPrev;
      this.stateY[ch] = yPrev;
    }

    ctx.diagnostics['dcOffset.processed'] = frameCount;
  }

  /** Reset IIR state (call when stream is interrupted) */
  reset(): void {
    this.stateX.fill(0);
    this.stateY.fill(0);
  }

  dispose(): void {
    this.reset();
  }
}

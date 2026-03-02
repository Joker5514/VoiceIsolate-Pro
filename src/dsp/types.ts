/**
 * VoiceIsolate Pro v14.0 - DSP Type Definitions
 */

/** Raw PCM audio buffer with metadata */
export interface PCMBuffer {
  /** Interleaved or per-channel float32 samples [-1.0, 1.0] */
  data: Float32Array;
  sampleRate: number;
  channels: number;
  /** Total sample frames (data.length / channels) */
  frameCount: number;
  /** Timestamp in seconds relative to stream start */
  timestamp: number;
}

/** Global audio pipeline configuration */
export interface AudioConfig {
  sampleRate: number;           // e.g. 48000
  channels: number;             // 1 (mono) or 2
  fftSize: number;              // 2048
  hopSize: number;              // fftSize * 0.25 = 512 (75% overlap)
  windowFunction: 'hann' | 'hamming' | 'blackman';
  /** Max acceptable processing latency in ms */
  maxLatencyMs: number;
  /** Noise profile capture duration in seconds */
  noiseProfileDuration: number; // 1.5
}

/** Frequency-domain frame produced by FFT stage */
export interface SpectralFrame {
  /** Real parts, length = fftSize/2 + 1 */
  real: Float32Array;
  /** Imaginary parts, length = fftSize/2 + 1 */
  imag: Float32Array;
  /** Magnitude spectrum, length = fftSize/2 + 1 */
  magnitude: Float32Array;
  /** Phase spectrum, length = fftSize/2 + 1 */
  phase: Float32Array;
  frameIndex: number;
  timestamp: number;
}

/** Noise profile learned from ambient silence */
export interface NoiseProfile {
  /** Mean power spectrum over profile window, length = fftSize/2 + 1 */
  meanPower: Float32Array;
  /** Standard deviation of noise power per bin */
  stdPower: Float32Array;
  /** True once profile collection is complete */
  isReady: boolean;
  /** How many frames contributed to this profile */
  frameCount: number;
  capturedAt: number;
}

/** ERB/Bark-scale band definition */
export interface ERBBand {
  index: number;
  /** Bin indices covered by this band [lo, hi) */
  binLow: number;
  binHigh: number;
  /** Center frequency in Hz */
  centerHz: number;
  /** ERB bandwidth in Hz */
  erbWidth: number;
}

/** Gain table applied per-frame by spectral gate */
export type GainVector = Float32Array; // length = fftSize/2 + 1

/** DSP processing context passed through the chain */
export interface DSPContext {
  config: AudioConfig;
  inputFrame: PCMBuffer;
  spectralFrame?: SpectralFrame;
  noiseProfile?: NoiseProfile;
  gainVector?: GainVector;
  /** Diagnostic / monitoring data emitted by nodes */
  diagnostics: Record<string, number | string>;
}

/** Core interface every DSP node must implement */
export interface DSPNode {
  readonly id: string;
  readonly name: string;
  /** Called once before streaming begins */
  initialize(config: AudioConfig): Promise<void>;
  /** Process one chunk; mutates ctx in place */
  process(ctx: DSPContext): Promise<void>;
  /** Release held resources */
  dispose(): void;
  /** Optional bypass toggle */
  bypass?: boolean;
}

/** Pipeline-level events */
export type PipelineEvent =
  | { type: 'noise_profile_ready'; profile: NoiseProfile }
  | { type: 'frame_processed'; frameIndex: number; latencyMs: number }
  | { type: 'error'; nodeId: string; error: Error };

export type PipelineEventHandler = (event: PipelineEvent) => void;

/** Result returned by DSPPipeline.processBuffer() */
export interface PipelineResult {
  output: PCMBuffer;
  droppedFrames: number;
  avgLatencyMs: number;
}

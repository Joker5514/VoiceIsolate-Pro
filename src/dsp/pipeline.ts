/**
 * VoiceIsolate Pro v14.0 – DSP Pipeline
 * 26-stage orchestrator: connects all DSP nodes with overlap-add processing.
 *
 * Stage layout:
 *  1  DC removal
 *  2  High-pass pre-filter (180 Hz)
 *  3  Normalise input gain
 *  4  FFT analysis
 *  5  Noise profile accumulation
 *  6  Spectral subtraction (multi-band Wiener)
 *  7  ERB spectral gate
 *  8  Voice activity detection (VAD)
 *  9  Formant-preserving speech enhancement
 * 10  De-reverberation (simple spectral subtraction on reverb tail)
 * 11  Adaptive gain control
 * 12  Spectral tilt compensation
 * 13  Harmonic enhancer
 * 14  Transient shaper
 * 15  Mid/Side spectral processing (stereo only)
 * 16  Comfort noise injection
 * 17  Spectral peak limiter
 * 18  iFFT synthesis + overlap-add
 * 19  Post-synthesis high-pass filter
 * 20  Post-synthesis low-pass filter (anti-alias guard)
 * 21  Dynamic range compressor
 * 22  True-peak limiter
 * 23  Output level metering
 * 24  Diagnostic aggregation
 * 25  Output clipping guard
 * 26  Write to output PCMBuffer
 */

import type {
  AudioConfig,
  DSPContext,
  DSPNode,
  PCMBuffer,
  PipelineEvent,
  PipelineEventHandler,
  PipelineResult,
} from './types.js';
import { FFTEngine } from './fft.js';
import { DCOffsetNode } from './nodes/DCOffsetNode.js';
import { NoiseProfileNode } from './nodes/NoiseProfileNode.js';
import { SpectralSubtractionNode } from './nodes/SpectralSubtractionNode.js';
import { ERBGateNode } from './nodes/ERBGateNode.js';

// ---------------------------------------------------------------------------
// Inline micro-nodes (stages not warranting separate files)
// ---------------------------------------------------------------------------

class HighPassNode implements DSPNode {
  readonly id = 'hp-filter';
  readonly name = 'High-Pass Filter';
  bypass = false;
  private readonly cutoff: number;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private a0 = 0; private a1 = 0; private a2 = 0; private b1 = 0; private b2 = 0;

  constructor(cutoffHz: number) { this.cutoff = cutoffHz; }

  async initialize(config: AudioConfig): Promise<void> {
    const { sampleRate } = config;
    const f0 = this.cutoff / sampleRate;
    const Q = 0.7071;
    const w0 = 2 * Math.PI * f0;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Q);
    const b0hp = (1 + cosW0) / 2;
    const b1hp = -(1 + cosW0);
    const a0 = 1 + alpha;
    this.a0 = b0hp / a0;
    this.a1 = b1hp / a0;
    this.a2 = b0hp / a0;
    this.b1 = -(-2 * cosW0) / a0;
    this.b2 = -(1 - alpha) / a0;
  }

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass) return;
    const { data, frameCount, channels } = ctx.inputFrame;
    for (let i = 0; i < frameCount; i++) {
      const idx = i * channels;
      const x0 = data[idx];
      const y0 = this.a0 * x0 + this.a1 * this.x1 + this.a2 * this.x2
                + this.b1 * this.y1 + this.b2 * this.y2;
      this.x2 = this.x1; this.x1 = x0;
      this.y2 = this.y1; this.y1 = y0;
      data[idx] = y0;
      if (channels > 1) data[idx + 1] = y0; // mono-source assumption
    }
  }
  dispose(): void {}
}

class InputGainNode implements DSPNode {
  readonly id = 'input-gain';
  readonly name = 'Input Gain Normaliser';
  bypass = false;
  gainDB = 0;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass || this.gainDB === 0) return;
    const g = Math.pow(10, this.gainDB / 20);
    const { data } = ctx.inputFrame;
    for (let i = 0; i < data.length; i++) data[i] *= g;
  }
  dispose(): void {}
}

class FFTAnalysisNode implements DSPNode {
  readonly id = 'fft-analysis';
  readonly name = 'FFT Analysis';
  bypass = false;
  private fft!: FFTEngine;
  private frameIndex = 0;

  async initialize(config: AudioConfig): Promise<void> {
    this.fft = new FFTEngine(config);
  }

  async process(ctx: DSPContext): Promise<void> {
    const { data, frameCount } = ctx.inputFrame;
    const N = this.fft.fftSize;
    const slice = frameCount >= N ? data.subarray(0, N) : (() => {
      const b = new Float32Array(N); b.set(data); return b;
    })();
    ctx.spectralFrame = this.fft.analyze(slice, this.frameIndex++, ctx.inputFrame.timestamp);
  }
  dispose(): void {}
}

class VADNode implements DSPNode {
  readonly id = 'vad';
  readonly name = 'Voice Activity Detector';
  bypass = false;
  private threshold = 0.01;
  isVoiceActive = false;
  private hangover = 0;
  private readonly hangoverFrames = 8;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    if (!ctx.spectralFrame) return;
    // Simple energy-based VAD
    const { magnitude } = ctx.spectralFrame;
    let energy = 0;
    // Focus on speech band: ~100–3400 Hz
    const lo = 5; const hi = Math.min(150, magnitude.length);
    for (let k = lo; k < hi; k++) energy += magnitude[k] * magnitude[k];
    energy /= (hi - lo);

    if (energy > this.threshold) {
      this.isVoiceActive = true;
      this.hangover = this.hangoverFrames;
    } else if (this.hangover > 0) {
      this.isVoiceActive = true;
      this.hangover--;
    } else {
      this.isVoiceActive = false;
    }
    ctx.diagnostics['vad.active'] = this.isVoiceActive ? 1 : 0;
    ctx.diagnostics['vad.energy'] = energy;
  }
  dispose(): void {}
}

class FormantEnhancerNode implements DSPNode {
  readonly id = 'formant-enhancer';
  readonly name = 'Formant Enhancer';
  bypass = false;
  gain = 1.5; // subtle boost

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass || !ctx.spectralFrame) return;
    // Boost 400-3400 Hz (F1–F3 region) by gain factor
    // This runs after subtraction so only voice bands benefit
    const { magnitude } = ctx.spectralFrame;
    const lo = Math.round(400 / (ctx.config.sampleRate / ctx.config.fftSize));
    const hi = Math.round(3400 / (ctx.config.sampleRate / ctx.config.fftSize));
    for (let k = lo; k < Math.min(hi, magnitude.length); k++) {
      magnitude[k] = Math.min(magnitude[k] * this.gain, 10);
    }
  }
  dispose(): void {}
}

class DerevNode implements DSPNode {
  readonly id = 'derev';
  readonly name = 'De-reverberation';
  bypass = false;
  private decayFactor = 0.85;
  private reverbTail: Float32Array = new Float32Array(0);

  async initialize(config: AudioConfig): Promise<void> {
    this.reverbTail = new Float32Array(config.fftSize / 2 + 1);
  }

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass || !ctx.spectralFrame) return;
    const { magnitude } = ctx.spectralFrame;
    for (let k = 0; k < magnitude.length; k++) {
      // Subtract estimated reverb tail
      const clean = Math.max(magnitude[k] - this.reverbTail[k] * 0.3, magnitude[k] * 0.1);
      this.reverbTail[k] = this.decayFactor * this.reverbTail[k] + (1 - this.decayFactor) * magnitude[k];
      magnitude[k] = clean;
    }
  }
  dispose(): void { this.reverbTail = new Float32Array(0); }
}

class AdaptiveGainNode implements DSPNode {
  readonly id = 'agc';
  readonly name = 'Adaptive Gain Control';
  bypass = false;
  private targetRMS = 0.1;
  private currentGain = 1.0;
  private readonly maxGain = 4.0;
  private readonly minGain = 0.25;
  private readonly tau = 0.995;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass) return;
    const { data } = ctx.inputFrame;
    let rms = 0;
    for (let i = 0; i < data.length; i++) rms += data[i] * data[i];
    rms = Math.sqrt(rms / data.length);
    if (rms > 1e-6) {
      const targetGain = this.targetRMS / rms;
      this.currentGain = this.tau * this.currentGain + (1 - this.tau) *
        Math.max(this.minGain, Math.min(this.maxGain, targetGain));
    }
    const g = this.currentGain;
    for (let i = 0; i < data.length; i++) data[i] *= g;
    ctx.diagnostics['agc.gain'] = g;
  }
  dispose(): void {}
}

class SpectralTiltNode implements DSPNode {
  readonly id = 'spectral-tilt';
  readonly name = 'Spectral Tilt Compensator';
  bypass = false;
  /** dB/octave: positive = high-shelf boost */
  tiltDB = 1.5;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass || !ctx.spectralFrame) return;
    const { magnitude } = ctx.spectralFrame;
    const bins = magnitude.length;
    const sr = ctx.config.sampleRate;
    const refBin = Math.round(1000 * ctx.config.fftSize / sr);
    for (let k = 1; k < bins; k++) {
      const octavesFromRef = Math.log2((k + 1) / (refBin + 1));
      const tiltGain = Math.pow(10, (this.tiltDB * octavesFromRef) / 20);
      magnitude[k] *= tiltGain;
    }
  }
  dispose(): void {}
}

class HarmonicEnhancerNode implements DSPNode {
  readonly id = 'harmonic-enhancer';
  readonly name = 'Harmonic Enhancer';
  bypass = false;
  harmonicGain = 0.05;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass || !ctx.spectralFrame) return;
    const { magnitude } = ctx.spectralFrame;
    const len = magnitude.length;
    // Add subtle 2nd-harmonic shimmer
    for (let k = 1; k < len >> 1; k++) {
      magnitude[k * 2] = Math.min(magnitude[k * 2] + magnitude[k] * this.harmonicGain, 10);
    }
  }
  dispose(): void {}
}

class TransientShaperNode implements DSPNode {
  readonly id = 'transient-shaper';
  readonly name = 'Transient Shaper';
  bypass = false;
  private prevEnergy = 0;
  attackBoost = 1.2;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass || !ctx.spectralFrame) return;
    const { magnitude } = ctx.spectralFrame;
    let energy = 0;
    for (let k = 0; k < magnitude.length; k++) energy += magnitude[k] * magnitude[k];
    const delta = energy - this.prevEnergy;
    if (delta > this.prevEnergy * 0.5) {
      // Transient detected – boost high-mids
      const lo = Math.min(40, magnitude.length);
      const hi = Math.min(300, magnitude.length);
      for (let k = lo; k < hi; k++) magnitude[k] *= this.attackBoost;
    }
    this.prevEnergy = energy;
  }
  dispose(): void {}
}

class ComfortNoiseNode implements DSPNode {
  readonly id = 'comfort-noise';
  readonly name = 'Comfort Noise Injection';
  bypass = false;
  noiseLevel = 0.0003;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass || !ctx.spectralFrame) return;
    const { magnitude } = ctx.spectralFrame;
    const level = this.noiseLevel;
    for (let k = 0; k < magnitude.length; k++) {
      magnitude[k] += level * (Math.random() * 2 - 1);
      if (magnitude[k] < 0) magnitude[k] = 0;
    }
  }
  dispose(): void {}
}

class SpectralPeakLimiterNode implements DSPNode {
  readonly id = 'spectral-limiter';
  readonly name = 'Spectral Peak Limiter';
  bypass = false;
  ceilLinear = 5.0;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass || !ctx.spectralFrame) return;
    const { magnitude } = ctx.spectralFrame;
    const ceil = this.ceilLinear;
    for (let k = 0; k < magnitude.length; k++) {
      if (magnitude[k] > ceil) magnitude[k] = ceil;
    }
  }
  dispose(): void {}
}

class IFFTSynthesisNode implements DSPNode {
  readonly id = 'ifft-synthesis';
  readonly name = 'IFFT + Overlap-Add';
  bypass = false;
  private fft!: FFTEngine;
  private config!: AudioConfig;
  private olaBuffer: Float32Array = new Float32Array(0);

  async initialize(config: AudioConfig): Promise<void> {
    this.config = config;
    this.fft = new FFTEngine(config);
    this.olaBuffer = new Float32Array(config.fftSize * 2);
  }

  async process(ctx: DSPContext): Promise<void> {
    if (!ctx.spectralFrame) return;
    const N = this.config.fftSize;
    const hop = this.config.hopSize;
    const outFrame = new Float32Array(N);
    this.fft.synthesize(ctx.spectralFrame, outFrame);

    // Accumulate into OLA buffer
    for (let i = 0; i < N; i++) this.olaBuffer[i] += outFrame[i];

    // Write one hop's worth to inputFrame.data (reuse buffer for in-place)
    const out = ctx.inputFrame.data;
    const hopMin = Math.min(hop, out.length);
    for (let i = 0; i < hopMin; i++) out[i] = this.olaBuffer[i];

    // Shift OLA buffer
    this.olaBuffer.copyWithin(0, hop);
    this.olaBuffer.fill(0, this.olaBuffer.length - hop);
  }
  dispose(): void { this.olaBuffer = new Float32Array(0); }
}

class PostHPNode implements DSPNode {
  readonly id = 'post-hp';
  readonly name = 'Post-synthesis High-Pass';
  bypass = false;
  private inner: HighPassNode;
  constructor() { this.inner = new HighPassNode(80); }
  async initialize(config: AudioConfig): Promise<void> { await this.inner.initialize(config); }
  async process(ctx: DSPContext): Promise<void> { await this.inner.process(ctx); }
  dispose(): void {}
}

class PostLPNode implements DSPNode {
  readonly id = 'post-lp';
  readonly name = 'Post-synthesis Low-Pass';
  bypass = false;
  private x1 = 0; private y1 = 0; private b0 = 0; private b1 = 0; private a1 = 0;

  async initialize(config: AudioConfig): Promise<void> {
    const fc = Math.min(20000, config.sampleRate / 2 - 200);
    const w = 2 * Math.PI * fc / config.sampleRate;
    const K = Math.tan(w / 2);
    this.b0 = K / (1 + K);
    this.b1 = this.b0;
    this.a1 = -(1 - K) / (1 + K);
  }

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass) return;
    const { data, channels } = ctx.inputFrame;
    for (let i = 0; i < data.length; i += channels) {
      const x = data[i];
      const y = this.b0 * x + this.b1 * this.x1 - this.a1 * this.y1;
      this.x1 = x; this.y1 = y;
      data[i] = y;
      if (channels > 1) data[i + 1] = y;
    }
  }
  dispose(): void {}
}

class CompressorNode implements DSPNode {
  readonly id = 'compressor';
  readonly name = 'Dynamic Range Compressor';
  bypass = false;
  thresholdDB = -18;
  ratio = 3;
  makeupDB = 2;
  private env = 0;
  private readonly attackCoeff = 0.003;
  private readonly releaseCoeff = 0.0001;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass) return;
    const { data } = ctx.inputFrame;
    const threshold = Math.pow(10, this.thresholdDB / 20);
    const makeup = Math.pow(10, this.makeupDB / 20);

    for (let i = 0; i < data.length; i++) {
      const level = Math.abs(data[i]);
      if (level > this.env) this.env += this.attackCoeff * (level - this.env);
      else this.env += this.releaseCoeff * (level - this.env);

      let gainReduction = 1.0;
      if (this.env > threshold) {
        gainReduction = threshold + (this.env - threshold) / this.ratio;
        gainReduction /= this.env;
      }
      data[i] *= gainReduction * makeup;
    }
  }
  dispose(): void {}
}

class TruePeakLimiterNode implements DSPNode {
  readonly id = 'true-peak-limiter';
  readonly name = 'True Peak Limiter';
  bypass = false;
  ceilLinear = 0.98;
  private gain = 1.0;
  private readonly release = 0.9999;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass) return;
    const { data } = ctx.inputFrame;
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    if (peak * this.gain > this.ceilLinear) this.gain = this.ceilLinear / peak;
    for (let i = 0; i < data.length; i++) data[i] *= this.gain;
    this.gain = Math.min(1.0, this.gain / this.release);
  }
  dispose(): void {}
}

class MeterNode implements DSPNode {
  readonly id = 'output-meter';
  readonly name = 'Output Level Meter';
  bypass = false;
  peakDB = -Infinity;
  rmsDB = -Infinity;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    const { data } = ctx.inputFrame;
    let peak = 0; let rms = 0;
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
      rms += data[i] * data[i];
    }
    this.peakDB = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    this.rmsDB = data.length > 0 ? 10 * Math.log10(rms / data.length + 1e-12) : -Infinity;
    ctx.diagnostics['meter.peakDB'] = this.peakDB;
    ctx.diagnostics['meter.rmsDB'] = this.rmsDB;
  }
  dispose(): void {}
}

class DiagnosticsNode implements DSPNode {
  readonly id = 'diagnostics';
  readonly name = 'Diagnostic Aggregator';
  bypass = false;
  onDiagnostics?: (d: Record<string, number | string>) => void;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    ctx.diagnostics['pipeline.timestamp'] = ctx.inputFrame.timestamp;
    this.onDiagnostics?.(ctx.diagnostics);
  }
  dispose(): void {}
}

class ClipGuardNode implements DSPNode {
  readonly id = 'clip-guard';
  readonly name = 'Output Clipping Guard';
  bypass = false;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    const { data } = ctx.inputFrame;
    for (let i = 0; i < data.length; i++) {
      if (data[i] > 1) data[i] = 1;
      else if (data[i] < -1) data[i] = -1;
    }
  }
  dispose(): void {}
}

class OutputWriterNode implements DSPNode {
  readonly id = 'output-writer';
  readonly name = 'Output Buffer Writer';
  bypass = false;
  private outputChunks: Float32Array[] = [];

  async initialize(_config: AudioConfig): Promise<void> {
    this.outputChunks = [];
  }

  async process(ctx: DSPContext): Promise<void> {
    this.outputChunks.push(ctx.inputFrame.data.slice());
  }

  collect(): Float32Array {
    const total = this.outputChunks.reduce((s, c) => s + c.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.outputChunks) { out.set(chunk, offset); offset += chunk.length; }
    this.outputChunks = [];
    return out;
  }
  dispose(): void { this.outputChunks = []; }
}

// ---------------------------------------------------------------------------
// MidSideNode (stereo only)
// ---------------------------------------------------------------------------
class MidSideNode implements DSPNode {
  readonly id = 'mid-side';
  readonly name = 'Mid/Side Spectral Processing';
  bypass = false;
  sideGain = 0.8;

  async initialize(_config: AudioConfig): Promise<void> {}

  async process(ctx: DSPContext): Promise<void> {
    if (this.bypass || ctx.config.channels < 2) return;
    const { data, frameCount } = ctx.inputFrame;
    for (let i = 0; i < frameCount; i++) {
      const l = data[i * 2];
      const r = data[i * 2 + 1];
      const mid = (l + r) * 0.5;
      const side = ((l - r) * 0.5) * this.sideGain;
      data[i * 2] = mid + side;
      data[i * 2 + 1] = mid - side;
    }
  }
  dispose(): void {}
}

// ---------------------------------------------------------------------------
// Main DSPPipeline
// ---------------------------------------------------------------------------

export class DSPPipeline {
  private config!: AudioConfig;
  private stages: DSPNode[] = [];
  private eventHandlers: PipelineEventHandler[] = [];
  private frameIndex = 0;
  private latencies: number[] = [];

  // Public node references for external control
  readonly dcOffset = new DCOffsetNode();
  readonly highPass = new HighPassNode(180);
  readonly inputGain = new InputGainNode();
  readonly fftAnalysis = new FFTAnalysisNode();
  readonly noiseProfile = new NoiseProfileNode();
  readonly spectralSub = new SpectralSubtractionNode();
  readonly erbGate = new ERBGateNode();
  readonly vad = new VADNode();
  readonly formantEnhancer = new FormantEnhancerNode();
  readonly derev = new DerevNode();
  readonly agc = new AdaptiveGainNode();
  readonly spectralTilt = new SpectralTiltNode();
  readonly harmonicEnhancer = new HarmonicEnhancerNode();
  readonly transientShaper = new TransientShaperNode();
  readonly midSide = new MidSideNode();
  readonly comfortNoise = new ComfortNoiseNode();
  readonly spectralLimiter = new SpectralPeakLimiterNode();
  readonly ifftSynthesis = new IFFTSynthesisNode();
  readonly postHP = new PostHPNode();
  readonly postLP = new PostLPNode();
  readonly compressor = new CompressorNode();
  readonly truePeakLimiter = new TruePeakLimiterNode();
  readonly meter = new MeterNode();
  readonly diagnostics = new DiagnosticsNode();
  readonly clipGuard = new ClipGuardNode();
  readonly outputWriter = new OutputWriterNode();

  constructor() {
    // Wire 26 stages in order
    this.stages = [
      /* 01 */ this.dcOffset,
      /* 02 */ this.highPass,
      /* 03 */ this.inputGain,
      /* 04 */ this.fftAnalysis,
      /* 05 */ this.noiseProfile,
      /* 06 */ this.spectralSub,
      /* 07 */ this.erbGate,
      /* 08 */ this.vad,
      /* 09 */ this.formantEnhancer,
      /* 10 */ this.derev,
      /* 11 */ this.agc,
      /* 12 */ this.spectralTilt,
      /* 13 */ this.harmonicEnhancer,
      /* 14 */ this.transientShaper,
      /* 15 */ this.midSide,
      /* 16 */ this.comfortNoise,
      /* 17 */ this.spectralLimiter,
      /* 18 */ this.ifftSynthesis,
      /* 19 */ this.postHP,
      /* 20 */ this.postLP,
      /* 21 */ this.compressor,
      /* 22 */ this.truePeakLimiter,
      /* 23 */ this.meter,
      /* 24 */ this.diagnostics,
      /* 25 */ this.clipGuard,
      /* 26 */ this.outputWriter,
    ];

    // Wire noise profile ready event
    this.noiseProfile.onProfileReady = (profile) => {
      this.emit({ type: 'noise_profile_ready', profile });
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(config: AudioConfig): Promise<void> {
    this.config = config;
    await Promise.all(this.stages.map((n) => n.initialize(config)));
  }

  /** Process a full AudioBuffer (Web Audio API format) */
  async processAudioBuffer(audioBuffer: AudioBuffer): Promise<PipelineResult> {
    const { sampleRate, numberOfChannels, length } = audioBuffer;
    const hopSize = this.config.hopSize;
    const fftSize = this.config.fftSize;
    let droppedFrames = 0;

    // Interleave channels
    const interleaved = new Float32Array(length * numberOfChannels);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        interleaved[i * numberOfChannels + ch] = channelData[i];
      }
    }

    // Process in hop-sized chunks
    const numHops = Math.ceil(length / hopSize);
    for (let h = 0; h < numHops; h++) {
      const start = h * hopSize * numberOfChannels;
      const end = Math.min(start + fftSize * numberOfChannels, interleaved.length);
      const chunk = interleaved.subarray(start, end);
      const padded = chunk.length < fftSize * numberOfChannels
        ? (() => { const b = new Float32Array(fftSize * numberOfChannels); b.set(chunk); return b; })()
        : chunk;

      const t0 = performance.now();
      try {
        await this.processChunk(padded, numberOfChannels, h * hopSize / sampleRate);
      } catch (err) {
        droppedFrames++;
        this.emit({ type: 'error', nodeId: 'pipeline', error: err as Error });
      }
      const latency = performance.now() - t0;
      this.latencies.push(latency);
      if (this.latencies.length > 100) this.latencies.shift();
      this.emit({ type: 'frame_processed', frameIndex: this.frameIndex, latencyMs: latency });
      this.frameIndex++;
    }

    const rawOutput = this.outputWriter.collect();

    // Deinterleave back to AudioBuffer
    const outCtx = new OfflineAudioContext(numberOfChannels, length, sampleRate);
    const outBuffer = outCtx.createBuffer(numberOfChannels, length, sampleRate);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const channelData = outBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        channelData[i] = rawOutput[i * numberOfChannels + ch] ?? 0;
      }
    }

    return {
      output: {
        data: rawOutput,
        sampleRate,
        channels: numberOfChannels,
        frameCount: length,
        timestamp: 0,
      },
      droppedFrames,
      avgLatencyMs: this.avgLatency(),
    };
  }

  /** Process a raw PCMBuffer directly */
  async processBuffer(input: PCMBuffer): Promise<PCMBuffer> {
    const hopSize = this.config.hopSize;
    const numHops = Math.ceil(input.frameCount / hopSize);

    for (let h = 0; h < numHops; h++) {
      const start = h * hopSize * input.channels;
      const end = Math.min(start + this.config.fftSize * input.channels, input.data.length);
      const chunk = input.data.subarray(start, end);
      await this.processChunk(chunk, input.channels, input.timestamp + h * hopSize / input.sampleRate);
    }

    return {
      data: this.outputWriter.collect(),
      sampleRate: input.sampleRate,
      channels: input.channels,
      frameCount: input.frameCount,
      timestamp: input.timestamp,
    };
  }

  // ---------------------------------------------------------------------------

  private async processChunk(data: Float32Array, channels: number, timestamp: number): Promise<void> {
    const ctx: DSPContext = {
      config: this.config,
      inputFrame: {
        data: data.slice(), // defensive copy
        sampleRate: this.config.sampleRate,
        channels,
        frameCount: Math.floor(data.length / channels),
        timestamp,
      },
      diagnostics: {},
    };

    for (const node of this.stages) {
      if (!node.bypass) {
        await node.process(ctx);
      }
    }
  }

  // ---------------------------------------------------------------------------

  on(handler: PipelineEventHandler): void {
    this.eventHandlers.push(handler);
  }

  off(handler: PipelineEventHandler): void {
    this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
  }

  private emit(event: PipelineEvent): void {
    for (const h of this.eventHandlers) h(event);
  }

  private avgLatency(): number {
    if (!this.latencies.length) return 0;
    return this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length;
  }

  /** Bypass a specific node by ID */
  bypassNode(id: string, value: boolean): void {
    const node = this.stages.find((n) => n.id === id);
    if (node) node.bypass = value;
  }

  /** Get all stage IDs in order */
  get stageIds(): string[] {
    return this.stages.map((n) => n.id);
  }

  dispose(): void {
    for (const node of this.stages) node.dispose();
    this.stages = [];
    this.eventHandlers = [];
    this.latencies = [];
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/** Create a pipeline with sensible defaults for voice isolation at 48kHz */
export function createVoiceIsolatePipeline(
  sampleRate = 48000,
  channels = 1
): { pipeline: DSPPipeline; config: AudioConfig } {
  const config: AudioConfig = {
    sampleRate,
    channels,
    fftSize: 2048,
    hopSize: 512, // 75% overlap
    windowFunction: 'hann',
    maxLatencyMs: 100,
    noiseProfileDuration: 1.5,
  };

  const pipeline = new DSPPipeline();
  return { pipeline, config };
}

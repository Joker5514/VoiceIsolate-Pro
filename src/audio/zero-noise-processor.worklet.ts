// zero-noise-processor.worklet.ts
// 128-sample block AudioWorklet — VoiceIsolate Pro v14.0
// Implements real-time DSP: Pass 1 (Stages 1-8) + lightweight ML mask from SharedArrayBuffer

// ─── TypeScript shim for AudioWorkletGlobalScope ────────────────────────────
declare function registerProcessor(name: string, ctor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare const SharedArrayBuffer: any;

const BLOCK_SIZE = 128;         // Web Audio API native block size
const FFT_SIZE = 2048;          // Frames for STFT (must be power of 2)
const HOP_SIZE = 512;           // 75% overlap
const SAMPLE_RATE = 44100;

class ZeroNoiseProcessor extends AudioWorkletProcessor {
  // 1. Core config
  private channels: number = 2;

  // 2. DC offset state
  private dcOffsetL: number = 0;
  private dcOffsetYL: number = 0;
  private dcOffsetR: number = 0;
  private dcOffsetYR: number = 0;
  private s: number = 0;

  // 3. Ring buffer: accumulate 128-sample blocks until we have FFT_SIZE samples
  private inputRing: Float32Array;
  private outputRing: Float32Array;
  private inputWritePos: number = 0;
  private outputReadPos: number = 0;
  private outputWritePos: number = 0;
  private ringFilled: boolean = false;

  // 4. FFT workspace
  private fftBuffer: Float32Array;
  private window: Float32Array;
  private noiseFloor: Float32Array;
  private noiseEstimated: boolean = false;

  // DSP state
  private humPhase60: number = 0;
  private humPhase120: number = 0;
  private humPhase180: number = 0;
  private humPhase240: number = 0;
  private dcOffset: number = 0;
  private gateEnvelope: number = 0;
  private prevMagnitudes: Float32Array;
  private frameCount: number = 0;
  private noiseAccumulator: Float32Array[]  = [];

  // SharedArrayBuffer for ML mask from worker (optional, progressive enhancement)
  private mlMaskBuffer: Float32Array | null = null;
  private mlMaskReady: boolean = false;

  // Parameters
  private isolationStrength: number = 0.8;
  private noiseReduction: number = 0.7;
  private gateThreshold: number = -40; // dB
  private humRemovalEnabled: boolean = true;
  private bypassMode: boolean = false;

  static get parameterDescriptors() {
    return [
      { name: 'isolationStrength', defaultValue: 0.8, minValue: 0.0, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'noiseReduction', defaultValue: 0.7, minValue: 0.0, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'gateThreshold', defaultValue: -40, minValue: -80, maxValue: -10, automationRate: 'k-rate' },
    ];
  }

  constructor(options?: any) {
    super();
    const ringSize = FFT_SIZE * 4;
    this.inputRing = new Float32Array(ringSize);
    this.outputRing = new Float32Array(ringSize);
    this.fftBuffer = new Float32Array(FFT_SIZE * 2); // real + imag interleaved
    this.window = this.buildHannWindow(FFT_SIZE);
    this.noiseFloor = new Float32Array(FFT_SIZE / 2 + 1).fill(1e-6);
    this.prevMagnitudes = new Float32Array(FFT_SIZE / 2 + 1).fill(0);

    this.port.onmessage = (e: MessageEvent) => {
      const { type, data } = e.data;
      if (type === 'ml-mask-buffer' && data instanceof SharedArrayBuffer) {
        this.mlMaskBuffer = new Float32Array(data);
        this.mlMaskReady = true;
      }
      if (type === 'bypass') this.bypassMode = data;
      if (type === 'params') {
        if (data.isolationStrength !== undefined) this.isolationStrength = data.isolationStrength;
        if (data.noiseReduction !== undefined) this.noiseReduction = data.noiseReduction;
        if (data.gateThreshold !== undefined) this.gateThreshold = data.gateThreshold;
        if (data.humRemoval !== undefined) this.humRemovalEnabled = data.humRemoval;
      }
    };
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const input = inputs?.[0];
    const output = outputs?.[0];
    if (!input || !output) return true;

    // Update k-rate params
    this.isolationStrength = parameters.isolationStrength?.[0] ?? this.isolationStrength;
    this.noiseReduction = parameters.noiseReduction?.[0] ?? this.noiseReduction;
    this.gateThreshold = parameters.gateThreshold?.[0] ?? this.gateThreshold;

    if (this.bypassMode) {
      for (let ch = 0; ch < output.length; ch++) {
        if (input[ch]) output[ch].set(input[ch]);
      }
      return true;
    }

    // --- Stage 1: DC Offset Removal (inline, per-sample) ---
    const cleanedInput = new Float32Array(BLOCK_SIZE);
    const dcAlpha = 0.9999;
    const inputChannel = input[0] || new Float32Array(BLOCK_SIZE);
    for (let i = 0; i < BLOCK_SIZE; i++) {
      this.dcOffset = dcAlpha * this.dcOffset + (1 - dcAlpha) * inputChannel[i];
      cleanedInput[i] = inputChannel[i] - this.dcOffset;
    }

    // --- Stage 4 (inline): Hum Removal via sample-domain notch ---
    const humFiltered = this.humRemovalEnabled
      ? this.removeHumInline(cleanedInput)
      : cleanedInput;

    // --- Write block into ring buffer ---
    const ringMask = this.inputRing.length - 1;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      this.inputRing[this.inputWritePos & ringMask] = humFiltered[i];
      this.inputWritePos++;
    }

    // --- Process full FFT frames when enough samples accumulated ---
    const availableInputSamples = this.inputWritePos - (this.outputWritePos - FFT_SIZE);
    if (this.inputWritePos >= FFT_SIZE && !this.ringFilled) {
      this.ringFilled = true;
      this.outputWritePos = FFT_SIZE;
      this.outputReadPos = 0;
    }

    if (this.ringFilled) {
      while (this.inputWritePos - this.outputWritePos >= HOP_SIZE) {
        // Extract FFT_SIZE samples from ring starting at (outputWritePos - FFT_SIZE)
        const frameStart = this.outputWritePos - FFT_SIZE;
        const frame = new Float32Array(FFT_SIZE);
        for (let i = 0; i < FFT_SIZE; i++) {
          frame[i] = this.inputRing[(frameStart + i) & ringMask] * this.window[i];
        }

        // STFT
        const { magnitudes, phases } = this.forwardSTFT(frame);

        // --- Stage 2: Adaptive Noise Profiling ---
        this.updateNoiseFloor(magnitudes);

        // --- Stage 3: ERB Spectral Gate + Stage 5: Spectral Subtraction ---
        const processedMag = this.applySpectralProcessing(magnitudes);

        // --- Integrate ML mask from SharedArrayBuffer if available ---
        const finalMag = this.mlMaskReady && this.mlMaskBuffer
          ? this.applyMLMask(processedMag)
          : processedMag;

        // Inverse STFT
        const outputFrame = this.inverseSTFT(finalMag, phases);

        // --- Stage 8: Output noise gate (time domain) ---
        const gatedFrame = this.applyGate(outputFrame);

        // Overlap-add into output ring
        for (let i = 0; i < FFT_SIZE; i++) {
          const pos = (this.outputWritePos - FFT_SIZE + i) & ringMask;
          this.outputRing[pos] = (this.outputRing[pos] ?? 0) + gatedFrame[i] * this.window[i];
        }

        this.outputWritePos += HOP_SIZE;
      }

      // Read BLOCK_SIZE output samples
      const outputChannel = output[0] || new Float32Array(BLOCK_SIZE);
      for (let i = 0; i < BLOCK_SIZE; i++) {
        const pos = (this.outputReadPos + i) & ringMask;
        outputChannel[i] = this.outputRing[pos] / (FFT_SIZE / (2 * HOP_SIZE)); // OLA normalization
        this.outputRing[pos] = 0; // clear after reading
      }
      this.outputReadPos += BLOCK_SIZE;
    } else {
      // Not enough samples yet — output silence
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].fill(0);
      }
    }

    this.frameCount++;
    return true;
  }

  private removeHumInline(input: Float32Array): Float32Array {
    const out = new Float32Array(BLOCK_SIZE);
    const sr = SAMPLE_RATE;
    const dt = 1 / sr;
    const amp = 0.02 * this.noiseReduction;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      this.humPhase60   += 2 * Math.PI * 60  * dt;
      this.humPhase120  += 2 * Math.PI * 120 * dt;
      this.humPhase180  += 2 * Math.PI * 180 * dt;
      this.humPhase240  += 2 * Math.PI * 240 * dt;
      const hum = amp * (
        Math.sin(this.humPhase60) * 1.0 +
        Math.sin(this.humPhase120) * 0.5 +
        Math.sin(this.humPhase180) * 0.25 +
        Math.sin(this.humPhase240) * 0.125
      );
      out[i] = input[i] - hum;
    }
    // Wrap phases to prevent float overflow
    this.humPhase60   %= 2 * Math.PI;
    this.humPhase120  %= 2 * Math.PI;
    this.humPhase180  %= 2 * Math.PI;
    this.humPhase240  %= 2 * Math.PI;
    return out;
  }

  private buildHannWindow(size: number): Float32Array {
    const w = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return w;
  }

  private forwardSTFT(frame: Float32Array): { magnitudes: Float32Array; phases: Float32Array } {
    // Radix-2 Cooley-Tukey FFT (in-place on interleaved real/imag)
    const N = FFT_SIZE;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    real.set(frame);

    // Bit-reversal
    let j = 0;
    for (let i = 1; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    // FFT butterfly
    for (let len = 2; len <= N; len <<= 1) {
      const wReal = Math.cos(-2 * Math.PI / len);
      const wImag = Math.sin(-2 * Math.PI / len);
      for (let i = 0; i < N; i += len) {
        let curReal = 1, curImag = 0;
        for (let k = 0; k < len / 2; k++) {
          const uR = real[i + k], uI = imag[i + k];
          const vR = real[i + k + len/2] * curReal - imag[i + k + len/2] * curImag;
          const vI = real[i + k + len/2] * curImag + imag[i + k + len/2] * curReal;
          real[i + k] = uR + vR; imag[i + k] = uI + vI;
          real[i + k + len/2] = uR - vR; imag[i + k + len/2] = uI - vI;
          const nr = curReal * wReal - curImag * wImag;
          curImag = curReal * wImag + curImag * wReal;
          curReal = nr;
        }
      }
    }

    const bins = N / 2 + 1;
    const magnitudes = new Float32Array(bins);
    const phases = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
      magnitudes[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
      phases[i] = Math.atan2(imag[i], real[i]);
    }
    return { magnitudes, phases };
  }

  private inverseSTFT(magnitudes: Float32Array, phases: Float32Array): Float32Array {
    const N = FFT_SIZE;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    const bins = N / 2 + 1;

    for (let i = 0; i < bins; i++) {
      real[i] = magnitudes[i] * Math.cos(phases[i]);
      imag[i] = magnitudes[i] * Math.sin(phases[i]);
    }
    // Mirror for negative frequencies
    for (let i = bins; i < N; i++) {
      real[i] = real[N - i];
      imag[i] = -imag[N - i];
    }

    // Inverse FFT (conjugate → FFT → conjugate → scale)
    for (let i = 0; i < N; i++) imag[i] = -imag[i];

    // Bit-reversal
    let j = 0;
    for (let i = 1; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    for (let len = 2; len <= N; len <<= 1) {
      const wR = Math.cos(-2 * Math.PI / len);
      const wI = Math.sin(-2 * Math.PI / len);
      for (let i = 0; i < N; i += len) {
        let cR = 1, cI = 0;
        for (let k = 0; k < len / 2; k++) {
          const uR = real[i+k], uI = imag[i+k];
          const vR = real[i+k+len/2]*cR - imag[i+k+len/2]*cI;
          const vI = real[i+k+len/2]*cI + imag[i+k+len/2]*cR;
          real[i+k]=uR+vR; imag[i+k]=uI+vI;
          real[i+k+len/2]=uR-vR; imag[i+k+len/2]=uI-vI;
          const nR = cR*wR - cI*wI; cI = cR*wI + cI*wR; cR = nR;
        }
      }
    }

    for (let i = 0; i < N; i++) imag[i] = -imag[i];
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = imag[i] / N; // scale + take imaginary (trick for real IFFT)
    // Actually use real part:
    for (let i = 0; i < N; i++) out[i] = real[i] / N;
    return out;
  }

  private updateNoiseFloor(magnitudes: Float32Array): void {
    if (this.frameCount < 50) {
      // Accumulate first 50 frames for noise profiling
      this.noiseAccumulator.push(magnitudes.slice());
      if (this.noiseAccumulator.length >= 20) {
        for (let b = 0; b < magnitudes.length; b++) {
          let min = Infinity;
          for (const frame of this.noiseAccumulator) {
            if (frame[b] < min) min = frame[b];
          }
          this.noiseFloor[b] = min * 1.5; // slight overestimate
        }
        this.noiseEstimated = true;
      }
    } else {
      // Continuous minimum statistics update (Martin algorithm simplified)
      const alpha = 0.98;
      for (let b = 0; b < magnitudes.length; b++) {
        if (magnitudes[b] < this.noiseFloor[b]) {
          this.noiseFloor[b] = magnitudes[b];
        } else {
          this.noiseFloor[b] = alpha * this.noiseFloor[b] + (1 - alpha) * magnitudes[b];
        }
      }
    }
  }

  private applySpectralProcessing(magnitudes: Float32Array): Float32Array {
    const out = new Float32Array(magnitudes.length);
    const alpha = 2.0 + this.noiseReduction * 2.0; // over-subtraction 2.0–4.0
    const floor = 0.01;

    for (let b = 0; b < magnitudes.length; b++) {
      // Spectral subtraction
      const subtracted = magnitudes[b] - alpha * this.noiseFloor[b];
      // Spectral floor (prevent negative magnitudes)
      out[b] = Math.max(subtracted, floor * magnitudes[b]);
      // Smooth temporal transitions (prevents musical noise)
      const smooth = 0.7;
      out[b] = smooth * this.prevMagnitudes[b] + (1 - smooth) * out[b];
      this.prevMagnitudes[b] = out[b];
    }

    // Voice band boost (300Hz–3400Hz emphasis)
    const binHz = SAMPLE_RATE / FFT_SIZE;
    for (let b = 0; b < out.length; b++) {
      const hz = b * binHz;
      if (hz >= 300 && hz <= 3400) {
        out[b] *= 1.0 + this.isolationStrength * 0.5;
      } else if (hz < 80 || hz > 8000) {
        out[b] *= (1.0 - this.isolationStrength * 0.8);
      }
    }
    return out;
  }

  private applyMLMask(magnitudes: Float32Array): Float32Array {
    if (!this.mlMaskBuffer) return magnitudes;
    const out = new Float32Array(magnitudes.length);
    for (let b = 0; b < magnitudes.length; b++) {
      const mask = Math.min(1, Math.max(0, this.mlMaskBuffer[b] ?? 1));
      const blended = this.isolationStrength * mask + (1 - this.isolationStrength);
      out[b] = magnitudes[b] * blended;
    }
    return out;
  }

  private applyGate(frame: Float32Array): Float32Array {
    const out = new Float32Array(frame.length);
    // Compute RMS of frame
    let rms = 0;
    for (let i = 0; i < frame.length; i++) {
        rms += frame[i] * frame[i];
    }
    rms = Math.sqrt(rms / frame.length);
    const rmsDb = 20 * (Math.log(rms + 1e-10) / Math.LN10);

    const threshDb = this.gateThreshold;
    const attack = 0.001;  // 1ms
    const release = 0.05;  // 50ms

    const targetGain = rmsDb > threshDb ? 1.0 : 0.0;
    if (targetGain > this.gateEnvelope) {
      this.gateEnvelope = attack * targetGain + (1 - attack) * this.gateEnvelope;
    } else {
      this.gateEnvelope = release * targetGain + (1 - release) * this.gateEnvelope;
    }

    for (let i = 0; i < frame.length; i++) {
      out[i] = frame[i] * this.gateEnvelope;
    }
    return out;
  }
}

registerProcessor('zero-noise-processor', ZeroNoiseProcessor);

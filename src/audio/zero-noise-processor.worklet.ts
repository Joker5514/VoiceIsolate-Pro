// zero-noise-processor.worklet.ts
// 128-sample block AudioWorklet — VoiceIsolate Pro v14.0
// Implements real-time DSP: Pass 1 (Stages 1-8) + lightweight ML mask from SharedArrayBuffer

// ─── TypeScript shim for AudioWorkletGlobalScope ────────────────────────────
declare function registerProcessor(name: string, ctor: new (options?: any) => AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: any);
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare var SharedArrayBuffer: any;

const BLOCK_SIZE = 128;         // Web Audio API native block size
const FFT_SIZE = 2048;          // Frames for STFT (must be power of 2)
const HOP_SIZE = 512;           // 75% overlap
const SAMPLE_RATE = 44100;

class ZeroNoiseProcessor extends AudioWorkletProcessor {
  // Ring buffer: accumulate 128-sample blocks until we have FFT_SIZE samples
  private inputRing: Float32Array;
  private outputRing: Float32Array;
  private inputWritePos: number = 0;
  private outputReadPos: number = 0;
  private outputWritePos: number = 0;
  private ringFilled: boolean = false;

  // FFT workspace
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

  // Pre-allocated buffers to prevent GC overhead in hot loops
  private cleanedInput: Float32Array;
  private humOut: Float32Array;
  private frameBuffer: Float32Array;
  private stftReal: Float32Array;
  private stftImag: Float32Array;
  private stftMagnitudes: Float32Array;
  private stftPhases: Float32Array;
  private istftReal: Float32Array;
  private istftImag: Float32Array;
  private istftOut: Float32Array;
  private spectralOut: Float32Array;
  private mlMaskOut: Float32Array;
  private gateOut: Float32Array;

  static get parameterDescriptors() {
    return [
      { name: 'isolationStrength', defaultValue: 0.8, minValue: 0.0, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'noiseReduction', defaultValue: 0.7, minValue: 0.0, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'gateThreshold', defaultValue: -40, minValue: -80, maxValue: -10, automationRate: 'k-rate' },
    ];
  }

  constructor(options?: any) {
    super(options);
    const ringSize = FFT_SIZE * 4;
    this.inputRing = new Float32Array(ringSize);
    this.outputRing = new Float32Array(ringSize);
    this.fftBuffer = new Float32Array(FFT_SIZE * 2); // real + imag interleaved
    this.window = this.buildHannWindow(FFT_SIZE);
    const bins = FFT_SIZE / 2 + 1;
    this.noiseFloor = new Float32Array(bins).fill(1e-6);
    this.prevMagnitudes = new Float32Array(bins).fill(0);

    this.cleanedInput = new Float32Array(BLOCK_SIZE);
    this.humOut = new Float32Array(BLOCK_SIZE);
    this.frameBuffer = new Float32Array(FFT_SIZE);
    this.stftReal = new Float32Array(FFT_SIZE);
    this.stftImag = new Float32Array(FFT_SIZE);
    this.stftMagnitudes = new Float32Array(bins);
    this.stftPhases = new Float32Array(bins);
    this.istftReal = new Float32Array(FFT_SIZE);
    this.istftImag = new Float32Array(FFT_SIZE);
    this.istftOut = new Float32Array(FFT_SIZE);
    this.spectralOut = new Float32Array(bins);
    this.mlMaskOut = new Float32Array(bins);
    this.gateOut = new Float32Array(FFT_SIZE);

    this.port.onmessage = (e: MessageEvent) => {
      const { type, data } = e.data;
      if (type === 'ml-mask-buffer' && typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer) {
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
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    // Update k-rate params
    this.isolationStrength = parameters.isolationStrength?.[0] ?? this.isolationStrength;
    this.noiseReduction = parameters.noiseReduction?.[0] ?? this.noiseReduction;
    this.gateThreshold = parameters.gateThreshold?.[0] ?? this.gateThreshold;

    if (this.bypassMode) {
      output.set(input);
      return true;
    }

    // --- Stage 1: DC Offset Removal (inline, per-sample) ---
    const dcAlpha = 0.9999;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      this.dcOffset = dcAlpha * this.dcOffset + (1 - dcAlpha) * input[i];
      this.cleanedInput[i] = input[i] - this.dcOffset;
    }

    // --- Stage 4 (inline): Hum Removal via sample-domain notch ---
    const humFiltered = this.humRemovalEnabled
      ? this.removeHumInline(this.cleanedInput)
      : this.cleanedInput;

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
        for (let i = 0; i < FFT_SIZE; i++) {
          this.frameBuffer[i] = this.inputRing[(frameStart + i) & ringMask] * this.window[i];
        }

        // STFT
        const { magnitudes, phases } = this.forwardSTFT(this.frameBuffer);

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
      for (let i = 0; i < BLOCK_SIZE; i++) {
        const pos = (this.outputReadPos + i) & ringMask;
        output[i] = this.outputRing[pos] / (FFT_SIZE / (2 * HOP_SIZE)); // OLA normalization
        this.outputRing[pos] = 0; // clear after reading
      }
      this.outputReadPos += BLOCK_SIZE;
    } else {
      // Not enough samples yet — output silence
      output.fill(0);
    }

    this.frameCount++;
    return true;
  }

  private removeHumInline(input: Float32Array): Float32Array {
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
      this.humOut[i] = input[i] - hum;
    }
    // Wrap phases to prevent float overflow
    this.humPhase60   %= 2 * Math.PI;
    this.humPhase120  %= 2 * Math.PI;
    this.humPhase180  %= 2 * Math.PI;
    this.humPhase240  %= 2 * Math.PI;
    return this.humOut;
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
    this.stftReal.set(frame);
    this.stftImag.fill(0);

    // Bit-reversal
    let j = 0;
    for (let i = 1; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let tmpR = this.stftReal[i]; this.stftReal[i] = this.stftReal[j]; this.stftReal[j] = tmpR;
        let tmpI = this.stftImag[i]; this.stftImag[i] = this.stftImag[j]; this.stftImag[j] = tmpI;
      }
    }

    // FFT butterfly
    for (let len = 2; len <= N; len <<= 1) {
      const wReal = Math.cos(-2 * Math.PI / len);
      const wImag = Math.sin(-2 * Math.PI / len);
      for (let i = 0; i < N; i += len) {
        let curReal = 1, curImag = 0;
        for (let k = 0; k < len / 2; k++) {
          const uR = this.stftReal[i + k], uI = this.stftImag[i + k];
          const vR = this.stftReal[i + k + len/2] * curReal - this.stftImag[i + k + len/2] * curImag;
          const vI = this.stftReal[i + k + len/2] * curImag + this.stftImag[i + k + len/2] * curReal;
          this.stftReal[i + k] = uR + vR; this.stftImag[i + k] = uI + vI;
          this.stftReal[i + k + len/2] = uR - vR; this.stftImag[i + k + len/2] = uI - vI;
          const nr = curReal * wReal - curImag * wImag;
          curImag = curReal * wImag + curImag * wReal;
          curReal = nr;
        }
      }
    }

    const bins = N / 2 + 1;
    for (let i = 0; i < bins; i++) {
      this.stftMagnitudes[i] = Math.sqrt(this.stftReal[i] * this.stftReal[i] + this.stftImag[i] * this.stftImag[i]);
      this.stftPhases[i] = Math.atan2(this.stftImag[i], this.stftReal[i]);
    }
    return { magnitudes: this.stftMagnitudes, phases: this.stftPhases };
  }

  private inverseSTFT(magnitudes: Float32Array, phases: Float32Array): Float32Array {
    const N = FFT_SIZE;
    const bins = N / 2 + 1;

    for (let i = 0; i < bins; i++) {
      this.istftReal[i] = magnitudes[i] * Math.cos(phases[i]);
      this.istftImag[i] = magnitudes[i] * Math.sin(phases[i]);
    }
    // Mirror for negative frequencies
    for (let i = bins; i < N; i++) {
      this.istftReal[i] = this.istftReal[N - i];
      this.istftImag[i] = -this.istftImag[N - i];
    }

    // Inverse FFT (conjugate → FFT → conjugate → scale)
    for (let i = 0; i < N; i++) this.istftImag[i] = -this.istftImag[i];

    // Bit-reversal
    let j = 0;
    for (let i = 1; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let tmpR = this.istftReal[i]; this.istftReal[i] = this.istftReal[j]; this.istftReal[j] = tmpR;
        let tmpI = this.istftImag[i]; this.istftImag[i] = this.istftImag[j]; this.istftImag[j] = tmpI;
      }
    }

    for (let len = 2; len <= N; len <<= 1) {
      const wR = Math.cos(-2 * Math.PI / len);
      const wI = Math.sin(-2 * Math.PI / len);
      for (let i = 0; i < N; i += len) {
        let cR = 1, cI = 0;
        for (let k = 0; k < len / 2; k++) {
          const uR = this.istftReal[i+k], uI = this.istftImag[i+k];
          const vR = this.istftReal[i+k+len/2]*cR - this.istftImag[i+k+len/2]*cI;
          const vI = this.istftReal[i+k+len/2]*cI + this.istftImag[i+k+len/2]*cR;
          this.istftReal[i+k]=uR+vR; this.istftImag[i+k]=uI+vI;
          this.istftReal[i+k+len/2]=uR-vR; this.istftImag[i+k+len/2]=uI-vI;
          const nR = cR*wR - cI*wI; cI = cR*wI + cI*wR; cR = nR;
        }
      }
    }

    for (let i = 0; i < N; i++) this.istftImag[i] = -this.istftImag[i];

    // Actually use real part:
    for (let i = 0; i < N; i++) this.istftOut[i] = this.istftReal[i] / N;
    return this.istftOut;
  }

  private updateNoiseFloor(magnitudes: Float32Array): void {
    if (this.frameCount < 50) {
      // Accumulate first 50 frames for noise profiling
      // Avoid .slice() inside hot loop, but it's only 50 times.
      // Better to copy.
      const magCopy = new Float32Array(magnitudes.length);
      magCopy.set(magnitudes);
      this.noiseAccumulator.push(magCopy);
      if (this.noiseAccumulator.length >= 20) {
        for (let b = 0; b < magnitudes.length; b++) {
          let min = Infinity;
          for (let k = 0; k < this.noiseAccumulator.length; k++) {
            const frame = this.noiseAccumulator[k];
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
    const alpha = 2.0 + this.noiseReduction * 2.0; // over-subtraction 2.0–4.0
    const floor = 0.01;

    for (let b = 0; b < magnitudes.length; b++) {
      // Spectral subtraction
      const subtracted = magnitudes[b] - alpha * this.noiseFloor[b];
      // Spectral floor (prevent negative magnitudes)
      this.spectralOut[b] = Math.max(subtracted, floor * magnitudes[b]);
      // Smooth temporal transitions (prevents musical noise)
      const smooth = 0.7;
      this.spectralOut[b] = smooth * this.prevMagnitudes[b] + (1 - smooth) * this.spectralOut[b];
      this.prevMagnitudes[b] = this.spectralOut[b];
    }

    // Voice band boost (300Hz–3400Hz emphasis)
    const binHz = SAMPLE_RATE / FFT_SIZE;
    for (let b = 0; b < this.spectralOut.length; b++) {
      const hz = b * binHz;
      if (hz >= 300 && hz <= 3400) {
        this.spectralOut[b] *= 1.0 + this.isolationStrength * 0.5;
      } else if (hz < 80 || hz > 8000) {
        this.spectralOut[b] *= (1.0 - this.isolationStrength * 0.8);
      }
    }
    return this.spectralOut;
  }

  private applyMLMask(magnitudes: Float32Array): Float32Array {
    if (!this.mlMaskBuffer) return magnitudes;
    for (let b = 0; b < magnitudes.length; b++) {
      const mask = Math.min(1, Math.max(0, this.mlMaskBuffer[b] ?? 1));
      const blended = this.isolationStrength * mask + (1 - this.isolationStrength);
      this.mlMaskOut[b] = magnitudes[b] * blended;
    }
    return this.mlMaskOut;
  }

  private applyGate(frame: Float32Array): Float32Array {
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
      this.gateOut[i] = frame[i] * this.gateEnvelope;
    }
    return this.gateOut;
  }
}

registerProcessor('zero-noise-processor', ZeroNoiseProcessor);

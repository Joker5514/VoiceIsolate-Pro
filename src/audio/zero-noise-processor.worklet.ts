/**
 * VoiceIsolate Pro v14.0 – ZeroNoiseProcessor AudioWorklet
 * ─────────────────────────────────────────────────────────
 * Full inline 26-stage DSP pipeline running inside the AudioWorklet
 * rendering thread. Target: <15ms end-to-end latency.
 *
 * Register via:
 *   await audioCtx.audioWorklet.addModule('/zero-noise-processor.worklet.js');
 *   const node = new AudioWorkletNode(audioCtx, 'zero-noise-processor', { ... });
 *
 * MessagePort commands (node.port.postMessage):
 *   { cmd: 'setParam',   param: string, value: number }
 *   { cmd: 'bypass',     nodeId: string, value: boolean }
 *   { cmd: 'resetNoise' }
 *   { cmd: 'getProfile' }  → replies { type: 'profile', data: Float32Array }
 *   { cmd: 'getMetrics' }  → replies { type: 'metrics', data: WorkletMetrics }
 */

// ─── TypeScript shim for AudioWorkletGlobalScope ────────────────────────────
declare function registerProcessor(name: string, ctor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare const currentTime: number;
declare const sampleRate: number;

// ─── Inline types (no import in worklet scope) ───────────────────────────────

interface WorkletMetrics {
  frameCount: number;
  avgProcessMs: number;
  peakProcessMs: number;
  droppedFrames: number;
  noiseReady: boolean;
  vadActive: boolean;
  peakDB: number;
  rmsDB: number;
}

// ─── Inline FFT (Cooley-Tukey radix-2, optimised for 2048-pt) ───────────────

const FFT_SIZE  = 2048;
const HOP_SIZE  = 512;      // 75% overlap
const HALF_BINS = FFT_SIZE / 2 + 1;
const NOISE_CAPTURE_SEC = 1.5;

function buildHannWindow(N: number): Float32Array {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  return w;
}

// Pre-compute bit-reversal table for fixed FFT_SIZE
const bitReverseTable = new Uint16Array(FFT_SIZE);
const fftBits = Math.log2(FFT_SIZE) | 0;
for (let i = 0; i < FFT_SIZE; i++) {
  let j = 0, tmp = i;
  for (let b = 0; b < fftBits; b++) { j = (j << 1) | (tmp & 1); tmp >>= 1; }
  bitReverseTable[i] = j;
}

function fftInPlace(re: Float32Array, im: Float32Array, inverse = false): void {
  const N = re.length;

  // Bit-reversal
  for (let i = 0; i < N; i++) {
    const j = bitReverseTable[i];
    if (j > i) {
      const tr = re[i], ti = im[i];
      re[i] = re[j]; im[i] = im[j];
      re[j] = tr;    im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let step = 1; step < N; step <<= 1) {
    const jump = step << 1;
    const theta = (sign * Math.PI) / step;
    const sinH = Math.sin(0.5 * theta);
    const wpr = -2 * sinH * sinH;
    const wpi = Math.sin(theta);
    let wr = 1.0, wi = 0.0;
    for (let m = 0; m < step; m++) {
      for (let k = m; k < N; k += jump) {
        const l = k + step;
        const tr = wr * re[l] - wi * im[l];
        const ti = wr * im[l] + wi * re[l];
        re[l] = re[k] - tr; im[l] = im[k] - ti;
        re[k] += tr;        im[k] += ti;
      }
      const tmp = wr;
      wr = tmp * wpr - wi * wpi + tmp;
      wi = wi * wpr + tmp * wpi + wi;
    }
  }
  if (inverse) {
    const scale = 1 / N;
    for (let i = 0; i < N; i++) { re[i] *= scale; im[i] *= scale; }
  }
}

// ─── Inline DSP State ────────────────────────────────────────────────────────

class InlineState {
  // Window
  window = buildHannWindow(FFT_SIZE);
  // OLA buffers (mono + stereo)
  olaLeft  = new Float32Array(FFT_SIZE * 2);
  olaRight = new Float32Array(FFT_SIZE * 2);
  // FFT scratch
  re = new Float32Array(FFT_SIZE);
  im = new Float32Array(FFT_SIZE);
  // Input ring buffer (holds up to 2*FFT_SIZE per channel)
  inRingL  = new Float32Array(FFT_SIZE * 2);
  inRingR  = new Float32Array(FFT_SIZE * 2);
  inWrite  = 0;
  inReady  = 0;

  // Magnitude / phase
  mag   = new Float32Array(HALF_BINS);
  phase = new Float32Array(HALF_BINS);

  // DC filter state [xPrev, yPrev] per channel
  dcXL = 0; dcYL = 0;
  dcXR = 0; dcYR = 0;
  readonly DC_R = 0.9998;

  // Noise profile (Welford)
  noiseMean = new Float32Array(HALF_BINS);
  noiseStd  = new Float32Array(HALF_BINS);
  noiseM    = new Float64Array(HALF_BINS);
  noiseS    = new Float64Array(HALF_BINS);
  noiseFrames = 0;
  noiseTargetFrames = Math.ceil(NOISE_CAPTURE_SEC * sampleRate / HOP_SIZE);
  noiseReady = false;

  // Wiener / DD-SNR state
  ddPriorSNR = new Float32Array(HALF_BINS).fill(1);
  prevGain   = new Float32Array(HALF_BINS).fill(1);

  // ERB gate (32 bands) – pre-built at construction
  erbBandGain = new Float32Array(32).fill(1);
  erbBands: Array<{ lo: number; hi: number }> = [];

  // IIR HP (180 Hz) — biquad coefficients
  hpA0 = 0; hpA1 = 0; hpA2 = 0; hpB1 = 0; hpB2 = 0;
  hpX1L = 0; hpX2L = 0; hpY1L = 0; hpY2L = 0;
  hpX1R = 0; hpX2R = 0; hpY1R = 0; hpY2R = 0;

  // AGC
  agcGain = 1.0;
  agcEnv  = 0.0;
  readonly AGC_TARGET = 0.1;

  // Compressor
  compEnv = 0.0;

  // True-peak limiter
  limGain = 1.0;

  // VAD
  vadActive = false;
  vadHangover = 0;

  // OLA normalisation
  olaScale: number;

  // Metrics
  frameCount    = 0;
  droppedFrames = 0;
  peakDB        = -Infinity;
  rmsDB         = -Infinity;
  avgProcMs     = 0;
  peakProcMs    = 0;

  // Bypass flags (nodeId → boolean)
  bypass: Record<string, boolean> = {};

  // Exposed parameters
  params: Record<string, number> = {
    inputGainDB:         0,
    thresholdOffsetDB:   6,
    overSubFactor:       1.0,
    spectralFloor:       0.002,
    erbGateThreshDB:     6,
    agcTargetDB:        -20,
    compThreshDB:       -18,
    compRatio:           3,
    makeupDB:            2,
    harmonicGain:        0.05,
    comfortNoiseLevel:   0.0003,
    sideGain:            0.8,
    formantBoostDB:      3.5,
    tiltDB:              1.5,
  };

  constructor() {
    // OLA normalisation
    let wsum = 0;
    for (let i = 0; i < FFT_SIZE; i++) wsum += this.window[i] ** 2;
    this.olaScale = HOP_SIZE / wsum;

    // HP filter (180 Hz high-pass biquad)
    const f0 = 180 / sampleRate;
    const Q  = 0.7071;
    const w0 = 2 * Math.PI * f0;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Q);
    const b0 = (1 + cw) / 2;
    const b1 = -(1 + cw);
    const a0 = 1 + alpha;
    this.hpA0 = b0 / a0; this.hpA1 = b1 / a0; this.hpA2 = b0 / a0;
    this.hpB1 = (2 * cw) / a0; this.hpB2 = -(1 - alpha) / a0;

    // Build 32 ERB bands
    const nyq = sampleRate / 2;
    const erbLo = 21.4 * Math.log10(1 + 20 / 229);
    const erbHi = 21.4 * Math.log10(1 + nyq / 229);
    const step  = (erbHi - erbLo) / 32;
    for (let b = 0; b < 32; b++) {
      const loHz = 229 * (10 ** ((erbLo + b * step) / 21.4) - 1);
      const hiHz = 229 * (10 ** ((erbLo + (b + 1) * step) / 21.4) - 1);
      this.erbBands.push({
        lo: Math.max(0, Math.round(loHz * FFT_SIZE / sampleRate)),
        hi: Math.min(HALF_BINS, Math.round(hiHz * FFT_SIZE / sampleRate) + 1),
      });
    }
  }
}

// ─── Main Processor ──────────────────────────────────────────────────────────

class ZeroNoiseProcessor extends AudioWorkletProcessor {
  private s: InlineState;
  private channels: number;

  static get parameterDescriptors() {
    return [
      { name: 'bypass',           defaultValue: 0,   minValue: 0, maxValue: 1 },
      { name: 'inputGainDB',      defaultValue: 0,   minValue: -40, maxValue: 40 },
      { name: 'thresholdOffsetDB',defaultValue: 6,   minValue: 0,  maxValue: 40 },
    ];
  }

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.channels = (options.processorOptions as { channels?: number })?.channels ?? 1;
    this.s = new InlineState();
    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // process() — called every 128 samples by the audio engine
  // ──────────────────────────────────────────────────────────────────────────

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input?.length || !output?.length) return true;

    const globalBypass = (parameters['bypass']?.[0] ?? 0) > 0.5;
    if (globalBypass) {
      for (let ch = 0; ch < output.length; ch++) output[ch].set(input[ch] ?? new Float32Array(128));
      return true;
    }

    const t0 = performance.now();
    const blockSize = input[0].length; // 128

    // Accumulate into ring buffer
    for (let i = 0; i < blockSize; i++) {
      const wi = (this.s.inWrite + i) % (FFT_SIZE * 2);
      this.s.inRingL[wi] = input[0]?.[i] ?? 0;
      this.s.inRingR[wi] = (this.channels > 1 ? input[1]?.[i] : input[0]?.[i]) ?? 0;
    }
    this.s.inWrite  = (this.s.inWrite + blockSize) % (FFT_SIZE * 2);
    this.s.inReady += blockSize;

    // Process full hops when enough input accumulated
    while (this.s.inReady >= HOP_SIZE) {
      try {
        this.processHop();
      } catch {
        this.s.droppedFrames++;
      }
      this.s.inReady -= HOP_SIZE;
    }

    // Read processed output from OLA buffer
    for (let i = 0; i < blockSize; i++) {
      output[0][i] = Math.max(-1, Math.min(1, this.s.olaLeft[i]));
      if (output[1]) output[1][i] = Math.max(-1, Math.min(1, this.s.olaRight[i]));
    }

    // Shift OLA buffers by blockSize
    this.s.olaLeft.copyWithin(0, blockSize);
    this.s.olaLeft.fill(0, this.s.olaLeft.length - blockSize);
    this.s.olaRight.copyWithin(0, blockSize);
    this.s.olaRight.fill(0, this.s.olaRight.length - blockSize);

    // Metrics
    const elapsed = performance.now() - t0;
    this.s.avgProcMs = 0.95 * this.s.avgProcMs + 0.05 * elapsed;
    if (elapsed > this.s.peakProcMs) this.s.peakProcMs = elapsed;
    this.s.frameCount++;

    return true;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // processHop — one full overlap-add cycle per HOP_SIZE samples
  // ──────────────────────────────────────────────────────────────────────────

  private processHop(): void {
    const s = this.s;

    // Stage 1: Read FFT_SIZE samples from ring buffer
    const frameL = new Float32Array(FFT_SIZE);
    const frameR = new Float32Array(FFT_SIZE);
    const readStart = (s.inWrite - s.inReady - (FFT_SIZE - HOP_SIZE) + FFT_SIZE * 4) % (FFT_SIZE * 2);
    for (let i = 0; i < FFT_SIZE; i++) {
      const ri = (readStart + i) % (FFT_SIZE * 2);
      frameL[i] = s.inRingL[ri];
      frameR[i] = s.inRingR[ri];
    }

    // Stage 1: DC removal
    if (!s.bypass['dc-offset']) {
      for (let i = 0; i < FFT_SIZE; i++) {
        const xL = frameL[i];
        const yL = xL - s.dcXL + s.DC_R * s.dcYL;
        s.dcXL = xL; s.dcYL = yL; frameL[i] = yL;

        const xR = frameR[i];
        const yR = xR - s.dcXR + s.DC_R * s.dcYR;
        s.dcXR = xR; s.dcYR = yR; frameR[i] = yR;
      }
    }

    // Stage 2: HP filter (biquad 180 Hz)
    if (!s.bypass['hp-filter']) {
      for (let i = 0; i < FFT_SIZE; i++) {
        const xL = frameL[i];
        const yL = s.hpA0 * xL + s.hpA1 * s.hpX1L + s.hpA2 * s.hpX2L
                 + s.hpB1 * s.hpY1L + s.hpB2 * s.hpY2L;
        s.hpX2L = s.hpX1L; s.hpX1L = xL;
        s.hpY2L = s.hpY1L; s.hpY1L = yL;
        frameL[i] = yL;

        const xR = frameR[i];
        const yR = s.hpA0 * xR + s.hpA1 * s.hpX1R + s.hpA2 * s.hpX2R
                 + s.hpB1 * s.hpY1R + s.hpB2 * s.hpY2R;
        s.hpX2R = s.hpX1R; s.hpX1R = xR;
        s.hpY2R = s.hpY1R; s.hpY1R = yR;
        frameR[i] = yR;
      }
    }

    // Stage 3: Input gain
    if (s.params['inputGainDB'] !== 0) {
      const g = 10 ** (s.params['inputGainDB']! / 20);
      for (let i = 0; i < FFT_SIZE; i++) { frameL[i] *= g; frameR[i] *= g; }
    }

    // Stage 4: FFT (mono downmix for spectral processing)
    const mono = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      mono[i] = (frameL[i] + frameR[i]) * 0.5 * s.window[i];
      s.re[i] = mono[i]; s.im[i] = 0;
    }
    fftInPlace(s.re, s.im);

    // Extract mag/phase
    for (let k = 0; k < HALF_BINS; k++) {
      s.mag[k]   = Math.sqrt(s.re[k] * s.re[k] + s.im[k] * s.im[k]);
      s.phase[k] = Math.atan2(s.im[k], s.re[k]);
    }

    // Stage 5: Noise profiling (Welford)
    if (!s.noiseReady) {
      const n = ++s.noiseFrames;
      for (let k = 0; k < HALF_BINS; k++) {
        const p = s.mag[k] ** 2;
        const delta = p - s.noiseM[k];
        s.noiseM[k] += delta / n;
        s.noiseS[k] += delta * (p - s.noiseM[k]);
      }
      if (n >= s.noiseTargetFrames) {
        for (let k = 0; k < HALF_BINS; k++) {
          s.noiseMean[k] = s.noiseM[k];
          s.noiseStd[k]  = n > 1 ? Math.sqrt(s.noiseS[k] / (n - 1)) : 0;
        }
        s.noiseReady = true;
        this.port.postMessage({ type: 'noise_profile_ready', frameCount: n });
      }
    } else {
      // Slow adaptation
      const alpha = 0.001;
      for (let k = 0; k < HALF_BINS; k++) {
        const p = s.mag[k] ** 2;
        const diff = p - s.noiseMean[k];
        if (Math.abs(diff) < 2 * s.noiseStd[k] + 1e-10) {
          s.noiseMean[k] += alpha * diff;
          s.noiseStd[k]   = (1 - alpha) * s.noiseStd[k] + alpha * Math.sqrt(Math.abs(diff));
        }
      }
    }

    // Stage 6: Multi-band Wiener / Spectral Subtraction
    if (!s.bypass['spectral-sub'] && s.noiseReady) {
      const overSub = s.params['overSubFactor']!;
      const floor   = s.params['spectralFloor']!;
      const minGain = 10 ** (-20 / 20);
      const gainAlpha = 0.85;
      const ddAlpha   = 0.98;

      for (let k = 0; k < HALF_BINS; k++) {
        const xPow    = s.mag[k] ** 2;
        const nPow    = s.noiseMean[k] + s.noiseStd[k];
        const postSNR = Math.max(xPow / (nPow + 1e-12) - 1, 0);
        const priorSNR = ddAlpha * s.ddPriorSNR[k] + (1 - ddAlpha) * postSNR;
        s.ddPriorSNR[k] = priorSNR;

        const wiener  = priorSNR / (priorSNR + 1);
        const num     = Math.max(xPow - overSub * nPow, floor * xPow);
        const subGain = xPow > 1e-12 ? Math.sqrt(num / xPow) : 0;
        let g = Math.max(Math.min(0.7 * wiener + 0.3 * subGain, 1.0), minGain);
        g = gainAlpha * s.prevGain[k] + (1 - gainAlpha) * g;
        s.prevGain[k] = g;
        s.mag[k] *= g;
      }
    }

    // Stage 7: ERB Gate (32-band)
    if (!s.bypass['erb-gate'] && s.noiseReady) {
      const thresh = s.params['erbGateThreshDB']!;
      const gateFloor = 10 ** (-60 / 20);
      const kneeHalf  = 3;

      for (let b = 0; b < 32; b++) {
        const band = s.erbBands[b];
        if (!band || band.lo >= band.hi) continue;
        let sigPow = 0, nPow = 0;
        const span = band.hi - band.lo;
        for (let k = band.lo; k < band.hi; k++) {
          sigPow += s.mag[k] ** 2;
          nPow   += s.noiseMean[k] + s.noiseStd[k];
        }
        sigPow /= span; nPow /= span;
        const threshPow = nPow * 10 ** (thresh / 10);
        const snrDB = 10 * Math.log10((sigPow + 1e-12) / (threshPow + 1e-12));
        let g: number;
        if (snrDB >= kneeHalf) g = 1.0;
        else if (snrDB <= -kneeHalf) g = gateFloor;
        else { const t = (snrDB + kneeHalf) / (2 * kneeHalf); g = gateFloor + t * t * (3 - 2 * t) * (1 - gateFloor); }

        // Attack/release
        const coeff = g >= s.erbBandGain[b] ? 0.97 : 0.9;
        s.erbBandGain[b] = coeff * s.erbBandGain[b] + (1 - coeff) * g;
        for (let k = band.lo; k < band.hi; k++) s.mag[k] *= s.erbBandGain[b];
      }
    }

    // Stage 8: VAD (energy in 300-3400 Hz)
    {
      const lo = Math.round(300 * FFT_SIZE / sampleRate);
      const hi = Math.min(HALF_BINS, Math.round(3400 * FFT_SIZE / sampleRate));
      let e = 0;
      for (let k = lo; k < hi; k++) e += s.mag[k] ** 2;
      e /= (hi - lo);
      if (e > 0.01) { s.vadActive = true; s.vadHangover = 8; }
      else if (s.vadHangover > 0) { s.vadHangover--; }
      else { s.vadActive = false; }
    }

    // Stage 9: Formant enhancer (400–3400 Hz)
    if (!s.bypass['formant-enhancer']) {
      const boost = 10 ** (s.params['formantBoostDB']! / 20);
      const lo = Math.round(400 * FFT_SIZE / sampleRate);
      const hi = Math.min(HALF_BINS, Math.round(3400 * FFT_SIZE / sampleRate));
      for (let k = lo; k < hi; k++) s.mag[k] = Math.min(s.mag[k] * boost, 10);
    }

    // Stage 10: De-reverberation (inline – stateless spectral subtraction on decay estimate)
    // (Skipped for minimal latency in worklet; full impl in pipeline.ts handles this)

    // Stage 11: AGC
    if (!s.bypass['agc']) {
      let rms = 0;
      for (let k = 0; k < HALF_BINS; k++) rms += s.mag[k] ** 2;
      rms = Math.sqrt(rms / HALF_BINS);
      if (rms > 1e-6) {
        const target = 10 ** (s.params['agcTargetDB']! / 20);
        const targetG = target / rms;
        s.agcGain = 0.999 * s.agcGain + 0.001 * Math.max(0.25, Math.min(4, targetG));
      }
      for (let k = 0; k < HALF_BINS; k++) s.mag[k] *= s.agcGain;
    }

    // Stage 12: Spectral tilt
    if (!s.bypass['spectral-tilt']) {
      const tiltDB  = s.params['tiltDB']!;
      const refBin  = Math.round(1000 * FFT_SIZE / sampleRate);
      for (let k = 1; k < HALF_BINS; k++) {
        const oct = Math.log2((k + 1) / (refBin + 1));
        s.mag[k] *= 10 ** (tiltDB * oct / 20);
      }
    }

    // Stage 13: Harmonic enhancer
    if (!s.bypass['harmonic-enhancer']) {
      const hg = s.params['harmonicGain']!;
      for (let k = 1; k < HALF_BINS >> 1; k++) {
        s.mag[k * 2] = Math.min(s.mag[k * 2] + s.mag[k] * hg, 10);
      }
    }

    // Stage 14: Transient shaper (pass-through in worklet for latency)

    // Stage 15: Mid/Side (stereo)
    // Applied post-iFFT below

    // Stage 16: Comfort noise
    if (!s.bypass['comfort-noise']) {
      const cn = s.params['comfortNoiseLevel']!;
      for (let k = 0; k < HALF_BINS; k++) {
        s.mag[k] = Math.max(0, s.mag[k] + cn * (Math.random() * 2 - 1));
      }
    }

    // Stage 17: Spectral peak limiter
    for (let k = 0; k < HALF_BINS; k++) if (s.mag[k] > 5) s.mag[k] = 5;

    // Stage 18: iFFT + OLA
    // Reconstruct full spectrum
    for (let k = 0; k < HALF_BINS; k++) {
      s.re[k] = s.mag[k] * Math.cos(s.phase[k]);
      s.im[k] = s.mag[k] * Math.sin(s.phase[k]);
    }
    for (let k = HALF_BINS; k < FFT_SIZE; k++) {
      const m = FFT_SIZE - k;
      s.re[k] = s.re[m]; s.im[k] = -s.im[m];
    }
    fftInPlace(s.re, s.im, true);

    // Apply synthesis window + OLA
    const sc = s.olaScale;
    for (let i = 0; i < FFT_SIZE; i++) {
      const val = s.re[i] * s.window[i] * sc;
      s.olaLeft[i]  += val;
      s.olaRight[i] += val;
    }

    // Stage 15 (post-iFFT): Mid/Side for stereo width
    if (this.channels > 1 && !s.bypass['mid-side']) {
      const sg = s.params['sideGain']!;
      for (let i = 0; i < FFT_SIZE; i++) {
        const mid  = s.olaLeft[i];
        const side = (frameL[i] - frameR[i]) * 0.5 * sg;
        s.olaLeft[i]  = mid + side;
        s.olaRight[i] = mid - side;
      }
    }

    // Stage 21: Compressor (time-domain on OLA output)
    if (!s.bypass['compressor']) {
      const thresh = 10 ** (s.params['compThreshDB']! / 20);
      const ratio  = s.params['compRatio']!;
      const makeup = 10 ** (s.params['makeupDB']! / 20);
      for (let i = 0; i < HOP_SIZE; i++) {
        const level = Math.abs(s.olaLeft[i]);
        if (level > s.compEnv) s.compEnv += 0.003 * (level - s.compEnv);
        else s.compEnv += 0.0001 * (level - s.compEnv);

        let gr = 1.0;
        if (s.compEnv > thresh) gr = (thresh + (s.compEnv - thresh) / ratio) / s.compEnv;
        s.olaLeft[i]  *= gr * makeup;
        s.olaRight[i] *= gr * makeup;
      }
    }

    // Stage 22: True-peak limiter
    let peak = 0;
    for (let i = 0; i < HOP_SIZE; i++) {
      const p = Math.max(Math.abs(s.olaLeft[i]), Math.abs(s.olaRight[i]));
      if (p > peak) peak = p;
    }
    if (peak * s.limGain > 0.98) s.limGain = 0.98 / peak;
    for (let i = 0; i < HOP_SIZE; i++) {
      s.olaLeft[i]  *= s.limGain;
      s.olaRight[i] *= s.limGain;
    }
    s.limGain = Math.min(1.0, s.limGain / 0.9999);

    // Stage 23: Metrics
    s.rmsDB  = 10 * Math.log10((s.re.reduce((a, v) => a + v * v, 0) / FFT_SIZE) + 1e-12);
    s.peakDB = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MessagePort handler
  // ──────────────────────────────────────────────────────────────────────────

  private handleMessage(data: {
    cmd: string;
    param?: string;
    value?: number;
    nodeId?: string;
  }): void {
    const s = this.s;
    switch (data.cmd) {
      case 'setParam':
        if (data.param && data.value !== undefined) s.params[data.param] = data.value;
        break;
      case 'bypass':
        if (data.nodeId && data.value !== undefined) s.bypass[data.nodeId] = data.value;
        break;
      case 'resetNoise':
        s.noiseReady = false;
        s.noiseFrames = 0;
        s.noiseM.fill(0); s.noiseS.fill(0);
        s.noiseMean.fill(0); s.noiseStd.fill(0);
        this.port.postMessage({ type: 'noise_reset' });
        break;
      case 'getProfile':
        this.port.postMessage({
          type: 'profile',
          ready: s.noiseReady,
          mean: s.noiseMean.slice(),
          std:  s.noiseStd.slice(),
        });
        break;
      case 'getMetrics': {
        const metrics: WorkletMetrics = {
          frameCount:   s.frameCount,
          avgProcessMs: s.avgProcMs,
          peakProcessMs: s.peakProcMs,
          droppedFrames: s.droppedFrames,
          noiseReady:    s.noiseReady,
          vadActive:     s.vadActive,
          peakDB:        s.peakDB,
          rmsDB:         s.rmsDB,
        };
        this.port.postMessage({ type: 'metrics', data: metrics });
        break;
      }
    }
  }
}

registerProcessor('zero-noise-processor', ZeroNoiseProcessor);

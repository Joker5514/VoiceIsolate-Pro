/**
 * WhisperHunterAI — classical DSP whisper listen→process engine
 * 100% local · no ONNX · single-pass STFT compatible
 *
 * WhisperHunterAI Complete Transfer Equation:
 *
 * LISTEN:
 *   E(n)   = mean(|X(k,n)|²)
 *   SC(n)  = Σ[k·|X(k,n)|] / Σ|X(k,n)|
 *   vad(n) = (E(n) > 0.08·NF(n)) ∧ (SC(n) > k_800Hz)
 *   NF(n)  = 0.95·NF(n−1) + 0.05·E(n)  [when vad=0]
 *
 * PROCESS:
 *   G(k,n) = max(p_clarity, [1 − N̂(k)/(|X(k,n)|²+ε)]^w_str)
 *   Y(k,n) = G(k,n) · X(k,n)
 *   Y(k_h) *= 1 + p_harmonic·0.5  for h∈{1,2,3,4}  [if p_harmonic>0.1]
 *
 * Parameters driven by sliders (sigmoid-mapped 0→1):
 *   p_clarity   ← whisperClarity
 *   p_sensitive ← whisperSensitivity  (scales θ_e)
 *   p_threshold ← whisperThreshold  (scales w_str)
 *   p_harmonic  ← harmRecov
 */
'use strict';

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/** Map UI 0–100 to sigmoid DSP param centered at 50 */
export function mapWhisperUi(uiValue) {
  const ui = Math.max(0, Math.min(100, Number(uiValue) || 0));
  return sigmoid((ui - 50) / 15);
}

export class WhisperHunterAI {
  constructor(fftSize = 4096, sampleRate = 48000) {
    this.fftSize = fftSize;
    this.sampleRate = sampleRate;
    this.halfBins = fftSize / 2 + 1;
    this.noiseFloor = 0;
    this.noisePsd = new Float32Array(this.halfBins);
    this._alpha = 0.95;
    this._f0Est = 220;
    this._scBinThreshold = Math.round(800 / (sampleRate / fftSize));
    this._epsilon = 1e-10;
  }

  reset() {
    this.noiseFloor = 0;
    this.noisePsd.fill(0);
  }

  /**
   * Process one STFT frame in-place on complex spectrum.
   * @param {Float32Array} re - real bins (length halfBins)
   * @param {Float32Array} im - imag bins
   * @param {Object} params - { clarity, sensitivity, threshold, harmonic } each 0–1
   * @returns {number} vad flag 0|1
   */
  processFrame(re, im, params = {}) {
    const halfN = this.halfBins;
    const pClarity = params.clarity ?? 0.5;
    const pSensitive = params.sensitivity ?? 0.5;
    const pThreshold = params.threshold ?? 0.5;
    const pHarmonic = params.harmonic ?? 0;

    let energy = 0;
    let scNum = 0;
    let scDen = 0;
    const mags = new Float32Array(halfN);

    for (let k = 0; k < halfN; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mags[k] = mag;
      const pow = mag * mag;
      energy += pow;
      scNum += k * mag;
      scDen += mag;
    }
    energy /= halfN;
    const sc = scDen > 1e-12 ? scNum / scDen : 0;

    const thetaE = Math.max(this.noiseFloor * pSensitive, 1e-12);
    const vad = (energy > thetaE * 0.08) && (sc > this._scBinThreshold) ? 1 : 0;

    if (vad === 0) {
      this.noiseFloor = this._alpha * this.noiseFloor + (1 - this._alpha) * energy;
      for (let k = 0; k < halfN; k++) {
        this.noisePsd[k] = this._alpha * this.noisePsd[k] + (1 - this._alpha) * mags[k] * mags[k];
      }
      return 0;
    }

    const wStr = 1 + 2 * pThreshold;
    const binHz = this.sampleRate / this.fftSize;

    for (let k = 0; k < halfN; k++) {
      const sigPow = mags[k] * mags[k];
      const ratio = 1 - this.noisePsd[k] / (sigPow + this._epsilon);
      let gain = Math.pow(Math.max(0, ratio), wStr);
      gain = Math.max(pClarity, gain);
      re[k] *= gain;
      im[k] *= gain;
    }

    if (pHarmonic > 0.1) {
      for (let h = 1; h <= 4; h++) {
        const kh = Math.round((h * this._f0Est) / binHz);
        if (kh > 0 && kh < halfN) {
          const boost = 1 + pHarmonic * 0.5;
          re[kh] *= boost;
          im[kh] *= boost;
        }
      }
    }

    return 1;
  }

  /** Convenience: magnitude-only path updates complex via polar reconstruction */
  processMagnitudes(mag, pha, params) {
    const halfN = mag.length;
    const re = new Float32Array(halfN);
    const im = new Float32Array(halfN);
    for (let k = 0; k < halfN; k++) {
      re[k] = mag[k] * Math.cos(pha[k]);
      im[k] = mag[k] * Math.sin(pha[k]);
    }
    const vad = this.processFrame(re, im, params);
    for (let k = 0; k < halfN; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
    return vad;
  }
}

if (typeof window !== 'undefined') {
  window.WhisperHunterAI = WhisperHunterAI;
  window.mapWhisperUi = mapWhisperUi;
}
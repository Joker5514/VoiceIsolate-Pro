/**
 * DeEsserProcessor - AudioWorklet De-Esser Processor
 * 
 * Implements a dynamic de-esser that reduces harsh sibilant frequencies (3.5kHz-10kHz).
 * Uses a biquad high-shelf filter to isolate the sibilant band, applies dynamic
 * compression to that band, and mixes it back with the original signal.
 * 
 * @class DeEsserProcessor
 * @extends AudioWorkletProcessor
 */
class DeEsserProcessor extends AudioWorkletProcessor {
  /**
   * Define the parameters exposed to the audio graph
   * @returns {Array<AudioParamDescriptor>} Parameter descriptors
   */
  static get parameterDescriptors() {
    return [
      {
        // De-essing strength, 0–1. 0 = off (fully transparent), 1 = maximum
        // sibilance reduction. Named to match PlaybackMixer.setDeEsserAmount.
        name: 'amount',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        name: 'frequency',
        defaultValue: 6000,
        minValue: 3500,
        maxValue: 10000,
        automationRate: 'k-rate'
      }
    ];
  }

  /**
   * Initialize the de-esser processor
   */
  constructor() {
    super();
    
    // Biquad filter state for each channel (high-pass to isolate sibilants)
    // Each channel needs: x1, x2, y1, y2 (previous input/output samples)
    this.filterState = [
      { x1: 0, x2: 0, y1: 0, y2: 0 },
      { x1: 0, x2: 0, y1: 0, y2: 0 }
    ];
    
    // Envelope follower for sibilant band (per channel)
    this.sibilantEnvelope = [0, 0];
    
    // Current gain reduction (per channel)
    this.currentGain = [1, 1];
    
    // Cached filter coefficients
    this.filterCoeffs = {
      b0: 1, b1: 0, b2: 0,
      a1: 0, a2: 0
    };
    
    // Last frequency used (to detect when to recalculate coefficients)
    this.lastFrequency = 6000;
    
    // Sample rate
    this.sampleRate = 48000; // Default, will be updated
  }

  /**
   * Calculate biquad high-pass filter coefficients
   * @param {number} frequency - Cutoff frequency in Hz
   * @param {number} sampleRate - Sample rate in Hz
   * @param {number} Q - Quality factor (resonance)
   */
  calculateHighPassCoeffs(frequency, sampleRate, Q = 0.707) {
    const omega = 2 * Math.PI * frequency / sampleRate;
    const sinOmega = Math.sin(omega);
    const cosOmega = Math.cos(omega);
    const alpha = sinOmega / (2 * Q);
    
    // High-pass filter coefficients
    const b0 = (1 + cosOmega) / 2;
    const b1 = -(1 + cosOmega);
    const b2 = (1 + cosOmega) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cosOmega;
    const a2 = 1 - alpha;
    
    // Normalize by a0 without replacing the coefficient object. This method is
    // reached from process() when the k-rate frequency changes.
    const coeffs = this.filterCoeffs;
    coeffs.b0 = b0 / a0;
    coeffs.b1 = b1 / a0;
    coeffs.b2 = b2 / a0;
    coeffs.a1 = a1 / a0;
    coeffs.a2 = a2 / a0;
  }

  /**
   * Apply biquad filter to a single sample
   * @param {number} input - Input sample
   * @param {number} channel - Channel index
   * @returns {number} Filtered sample
   */
  applyBiquadFilter(input, channel) {
    const state = this.filterState[channel];
    const coeffs = this.filterCoeffs;
    
    // Biquad difference equation:
    // y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
    const output = coeffs.b0 * input + 
                   coeffs.b1 * state.x1 + 
                   coeffs.b2 * state.x2 - 
                   coeffs.a1 * state.y1 - 
                   coeffs.a2 * state.y2;
    
    // Update state
    state.x2 = state.x1;
    state.x1 = input;
    state.y2 = state.y1;
    state.y1 = output;
    
    return output;
  }

  /**
   * Calculate time constant for exponential smoothing
   * @param {number} timeMs - Time in milliseconds
   * @param {number} sampleRate - Sample rate in Hz
   * @returns {number} Time constant coefficient
   */
  calculateTimeConstant(timeMs, sampleRate) {
    if (timeMs <= 0) return 0;
    return Math.exp(-1 / (timeMs * 0.001 * sampleRate));
  }

  /**
   * Process audio samples
   * @param {Float32Array[][]} inputs - Input audio buffers
   * @param {Float32Array[][]} outputs - Output audio buffers
   * @param {Object} parameters - Parameter values
   * @returns {boolean} True to keep processor alive
   */
  _clampParam(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    // If no input or output, stay alive without touching buffers
    if (!input || input.length === 0 || !output || output.length === 0) {
      return true;
    }

    // Get parameter values (k-rate, so one value per block). Both params are read
    // defensively against their descriptor defaults so the processor still runs
    // if a caller (or a mock/test) omits one.
    const amount = this._clampParam(parameters.amount?.[0], 0, 0, 1);
    const frequency = this._clampParam(parameters.frequency?.[0], 6000, 3500, 10000);

    // Update sample rate from the AudioWorklet global (falls back to 48 kHz)
    const sr = typeof sampleRate !== 'undefined' ? sampleRate : this.sampleRate;
    if (Number.isFinite(sr) && sr > 0) this.sampleRate = sr;

    // Recalculate filter coefficients if frequency changed
    if (Math.abs(frequency - this.lastFrequency) > 0.1) {
      this.calculateHighPassCoeffs(frequency, this.sampleRate, 0.707);
      this.lastFrequency = frequency;
    }

    // Time constants for envelope follower
    const attackCoeff = this.calculateTimeConstant(1, this.sampleRate); // Fast attack (1ms)
    const releaseCoeff = this.calculateTimeConstant(50, this.sampleRate); // Slower release (50ms)

    // Process each channel
    const channelCount = Math.min(input.length, output.length, 2);
    
    for (let channel = 0; channel < channelCount; channel++) {
      const inputChannel = input[channel];
      const outputChannel = output[channel];
      
      if (!inputChannel || !outputChannel) continue;

      const blockSize = inputChannel.length;

      // Process each sample
      for (let i = 0; i < blockSize; i++) {
        const sample = inputChannel[i];
        
        // Handle edge cases
        if (!isFinite(sample)) {
          outputChannel[i] = 0;
          continue;
        }

        // Extract sibilant band using high-pass filter
        const sibilantSample = this.applyBiquadFilter(sample, channel);
        
        // Measure sibilant energy with envelope follower
        const sibilantLevel = Math.abs(sibilantSample);
        
        if (sibilantLevel > this.sibilantEnvelope[channel]) {
          // Attack
          this.sibilantEnvelope[channel] = attackCoeff * this.sibilantEnvelope[channel] + 
                                           (1 - attackCoeff) * sibilantLevel;
        } else {
          // Release
          this.sibilantEnvelope[channel] = releaseCoeff * this.sibilantEnvelope[channel] + 
                                           (1 - releaseCoeff) * sibilantLevel;
        }

        // Calculate gain reduction based on sibilant energy
        // Threshold for sibilance detection (normalized)
        const sibilantThreshold = 0.1;
        
        let targetGain = 1;
        if (this.sibilantEnvelope[channel] > sibilantThreshold) {
          // Calculate how much above threshold
          const excessDb = 20 * Math.log10(this.sibilantEnvelope[channel] / sibilantThreshold);
          
          // Linear reduction: higher amount = more dB reduction
          // amount=0 → 0 dB, amount=1 → full excessDb reduction
          const gainReductionDb = excessDb * amount;
          
          // Convert back to linear
          targetGain = 10 ** (-gainReductionDb / 20);
          
          // Clamp gain reduction
          targetGain = Math.max(0.1, Math.min(1, targetGain));
        }

        // Smooth gain changes
        const gainSmoothCoeff = 0.999;
        this.currentGain[channel] = gainSmoothCoeff * this.currentGain[channel] + 
                                    (1 - gainSmoothCoeff) * targetGain;

        // Apply gain reduction to sibilant band only
        const processedSibilant = sibilantSample * this.currentGain[channel];
        
        // Mix processed sibilant back with original
        // Original = sample, Sibilant = sibilantSample
        // We want: original - sibilant + processedSibilant
        const lowFreqComponent = sample - sibilantSample;
        outputChannel[i] = lowFreqComponent + processedSibilant;
      }
    }

    // Keep processor alive
    return true;
  }
}

// Register the processor with the audio worklet
registerProcessor('vip-deesser', DeEsserProcessor);

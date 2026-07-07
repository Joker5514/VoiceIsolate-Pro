/**
 * GateProcessor - AudioWorklet Noise Gate Processor
 * 
 * Implements a dynamic noise gate that attenuates audio signals below a threshold.
 * Uses exponential smoothing for natural attack and release envelopes.
 * 
 * @class GateProcessor
 * @extends AudioWorkletProcessor
 */
class GateProcessor extends AudioWorkletProcessor {
  /**
   * Define the parameters exposed to the audio graph
   * @returns {Array<AudioParamDescriptor>} Parameter descriptors
   */
  static get parameterDescriptors() {
    return [
      {
        name: 'threshold',
        defaultValue: -40,
        minValue: -100,
        maxValue: 0,
        automationRate: 'k-rate'
      },
      {
        // Attenuation depth applied while the gate is closed, in dB.
        // 0 = gate off (closed gain is unity → fully transparent).
        name: 'range',
        defaultValue: 0,
        minValue: 0,
        maxValue: 80,
        automationRate: 'k-rate'
      },
      {
        name: 'attack',
        defaultValue: 10,
        minValue: 0,
        maxValue: 1000,
        automationRate: 'k-rate'
      },
      {
        name: 'release',
        defaultValue: 100,
        minValue: 0,
        maxValue: 5000,
        automationRate: 'k-rate'
      },
      {
        // Minimum time the gate is held open after the signal drops below
        // threshold, in ms — stops the gate "chattering" on breathy speech.
        name: 'hold',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1000,
        automationRate: 'k-rate'
      }
    ];
  }

  /**
   * Initialize the gate processor
   */
  constructor() {
    super();

    // Envelope follower state for each channel
    this.envelopes = [0, 0];

    // Current gain reduction for each channel
    this.currentGain = [1, 1];

    // Remaining hold time, in samples, for each channel
    this.holdCounter = [0, 0];

    // Sample rate (will be set on first process call)
    this.sampleRate = 48000; // Default, will be updated
  }

  /**
   * Convert dB to linear amplitude
   * @param {number} db - Decibel value
   * @returns {number} Linear amplitude
   */
  dbToLinear(db) {
    return 10 ** (db / 20);
  }

  /**
   * Convert linear amplitude to dB
   * @param {number} linear - Linear amplitude
   * @returns {number} Decibel value
   */
  linearToDb(linear) {
    if (linear <= 0) return -100;
    return 20 * Math.log10(linear);
  }

  /**
   * Calculate time constant for exponential smoothing
   * @param {number} timeMs - Time in milliseconds
   * @param {number} sampleRate - Sample rate in Hz
   * @returns {number} Time constant coefficient
   */
  calculateTimeConstant(timeMs, sampleRate) {
    if (timeMs <= 0) return 0;
    // Convert ms to samples and calculate exponential coefficient
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

    // Get parameter values (k-rate, so one value per block). Every param is read
    // defensively against its descriptor default so the processor still runs if
    // a caller (or a mock/test) omits one.
    const thresholdDb = this._clampParam(parameters.threshold?.[0], -40, -100, 0);
    const rangeDb = this._clampParam(parameters.range?.[0], 0, 0, 80);
    const attackMs = this._clampParam(parameters.attack?.[0], 10, 0, 1000);
    const releaseMs = this._clampParam(parameters.release?.[0], 100, 0, 5000);
    const holdMs = this._clampParam(parameters.hold?.[0], 0, 0, 1000);

    // Update sample rate from the AudioWorklet global (falls back to 48 kHz)
    const sr = typeof sampleRate !== 'undefined' ? sampleRate : this.sampleRate;
    if (Number.isFinite(sr) && sr > 0) this.sampleRate = sr;

    // Calculate time constants for attack and release
    const attackCoeff = this.calculateTimeConstant(attackMs, this.sampleRate);
    const releaseCoeff = this.calculateTimeConstant(releaseMs, this.sampleRate);

    // Convert threshold to linear
    const thresholdLinear = this.dbToLinear(thresholdDb);
    // Closed-gate gain: attenuate by `range` dB. range = 0 → gain 1 (gate off,
    // fully transparent); range = 80 → −80 dB (effectively silent).
    const floorGain = this.dbToLinear(-rangeDb);
    // Hold time converted to whole samples.
    const holdSamples = Math.max(0, Math.round(holdMs * 0.001 * this.sampleRate));

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

        // Calculate envelope (absolute value for level detection)
        const inputLevel = Math.abs(sample);

        // Envelope follower with attack/release
        if (inputLevel > this.envelopes[channel]) {
          // Attack: signal is rising
          this.envelopes[channel] = attackCoeff * this.envelopes[channel] +
                                    (1 - attackCoeff) * inputLevel;
        } else {
          // Release: signal is falling
          this.envelopes[channel] = releaseCoeff * this.envelopes[channel] +
                                    (1 - releaseCoeff) * inputLevel;
        }

        // Gate open/closed decision, honouring the hold time. While the
        // envelope is above threshold the gate is open and the hold timer is
        // re-armed; once it drops, the gate stays open until the timer expires.
        let open;
        if (this.envelopes[channel] > thresholdLinear) {
          this.holdCounter[channel] = holdSamples;
          open = true;
        } else if (this.holdCounter[channel] > 0) {
          this.holdCounter[channel]--;
          open = true;
        } else {
          open = false;
        }

        // Open → unity; closed → the range floor.
        const targetGain = open ? 1 : floorGain;

        // Smooth gain changes with the attack coefficient when opening and the
        // release coefficient when closing, so the gate's timing controls
        // shape the actual envelope (and avoid clicks).
        const coeff = targetGain > this.currentGain[channel] ? attackCoeff : releaseCoeff;
        this.currentGain[channel] = coeff * this.currentGain[channel] +
                                    (1 - coeff) * targetGain;

        // Apply gain to output
        outputChannel[i] = sample * this.currentGain[channel];
      }
    }

    // Keep processor alive
    return true;
  }
}

// Register the processor with the audio worklet
registerProcessor('vip-gate', GateProcessor);

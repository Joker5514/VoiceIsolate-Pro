/**
 * GateProcessor - AudioWorklet Noise Gate Processor
 * 
 * Implements a dynamic noise gate that attenuates audio signals below a threshold.
 * Uses exponential smoothing for natural attack and release envelopes.
 * 
 * @class GateProcessor
 * @extends AudioWorkletProcessor
 */
// The gate closes only once the envelope falls this far below the threshold.
const GATE_HYSTERESIS_DB = 6;
const GATE_HYSTERESIS_RATIO = 10 ** (-GATE_HYSTERESIS_DB / 20);

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
        minValue: -120,
        maxValue: 0,
        automationRate: 'k-rate'
      },
      {
        // Attenuation depth applied while the gate is closed, in dB.
        // 0 = gate off (closed gain is unity → fully transparent).
        name: 'range',
        defaultValue: 0,
        minValue: 0,
        maxValue: 120,
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
      },
      {
        // Delay the audible path while the detector sees the current block.
        // This lets the gate open before a plosive reaches the output.
        name: 'lookahead',
        defaultValue: 0,
        minValue: 0,
        maxValue: 20,
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

    // Gate state for the hysteresis (linked across channels). Starts open so
    // the first audio is never cut while the envelope warms up.
    this.isOpen = true;
    // Per-sample scratch (no allocation in the sample loop).
    this._delayed = new Float32Array(2);
    this._finite = [true, true];

    // Per-channel delay rings for the bounded (0–20 ms) lookahead path.
    // Allocated lazily once the AudioWorklet sample rate is known; never in
    // the sample loop.
    this.delayBuffers = [null, null];
    this.delayIndexes = [0, 0];
    this.delayLength = 0;

    // Sample rate (will be set on first process call)
    this.sampleRate = 48000; // Default, will be updated

    // Clear lookahead history when PlaybackMixer starts a new source so prior
    // file/seek audio can never bleed into the next transport segment.
    if (this.port) {
      this.port.onmessage = (event) => {
        if (event?.data?.type === 'reset') this._resetState();
      };
    }
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

  _ensureLookaheadBuffers(sr) {
    const length = Math.max(2, Math.ceil(0.02 * sr) + 1);
    if (length === this.delayLength && this.delayBuffers[0] && this.delayBuffers[1]) return;
    this.delayBuffers = [new Float32Array(length), new Float32Array(length)];
    this.delayIndexes = [0, 0];
    this.delayLength = length;
  }

  _resetState() {
    this.envelopes = [0, 0];
    this.currentGain = [1, 1];
    this.holdCounter = [0, 0];
    this.isOpen = true;
    this.delayIndexes = [0, 0];
    for (const delay of this.delayBuffers) delay?.fill(0);
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
    const thresholdDb = this._clampParam(parameters.threshold?.[0], -40, -120, 0);
    const rangeDb = this._clampParam(parameters.range?.[0], 0, 0, 120);
    const attackMs = this._clampParam(parameters.attack?.[0], 10, 0, 1000);
    const releaseMs = this._clampParam(parameters.release?.[0], 100, 0, 5000);
    const holdMs = this._clampParam(parameters.hold?.[0], 0, 0, 1000);
    const lookaheadMs = this._clampParam(parameters.lookahead?.[0], 0, 0, 20);

    // Update sample rate from the AudioWorklet global (falls back to 48 kHz)
    const sr = typeof sampleRate !== 'undefined' ? sampleRate : this.sampleRate;
    if (Number.isFinite(sr) && sr > 0) this.sampleRate = sr;
    this._ensureLookaheadBuffers(this.sampleRate);

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
    const lookaheadSamples = Math.min(
      Math.max(0, this.delayLength - 1),
      Math.round(lookaheadMs * 0.001 * this.sampleRate),
    );

    // Stereo-linked: one detector (the louder channel) and one gain for both
    // channels, so a gate decision never moves the stereo image. Hysteresis:
    // the gate opens above `threshold` but only closes once the envelope is
    // HYSTERESIS_DB below it, so a level hovering at the threshold (steady
    // noise, a quiet tail) cannot flip the gate open/closed every few ms.
    const channelCount = Math.min(input.length, output.length, 2);
    const closeLinear = thresholdLinear * GATE_HYSTERESIS_RATIO;
    const ins = [];
    const outs = [];
    for (let channel = 0; channel < channelCount; channel++) {
      if (!input[channel] || !output[channel]) continue;
      ins.push(input[channel]);
      outs.push(output[channel]);
    }
    if (ins.length === 0) return true;
    const blockSize = ins[0].length;
    let envelope = this.envelopes[0];
    let gain = this.currentGain[0];
    let hold = this.holdCounter[0];
    let isOpen = this.isOpen;

    for (let i = 0; i < blockSize; i++) {
      let level = 0;
      for (let c = 0; c < ins.length; c++) {
        const sample = ins[c][i];
        const delay = this.delayBuffers[c];
        const delayIndex = this.delayIndexes[c];
        // Detector sees the current sample; audible output is delayed by the
        // requested lookahead. With lookahead=0 this stays transparent.
        const delayedIndex = delayIndex - lookaheadSamples < 0
          ? delayIndex - lookaheadSamples + delay.length
          : delayIndex - lookaheadSamples;
        const finite = Number.isFinite(sample);
        const delayedSample = lookaheadSamples > 0 ? delay[delayedIndex] : (finite ? sample : 0);
        delay[delayIndex] = finite ? sample : 0;
        this.delayIndexes[c] = (delayIndex + 1) % delay.length;
        this._delayed[c] = delayedSample;
        this._finite[c] = finite;
        if (finite) {
          const a = Math.abs(sample);
          if (a > level) level = a;
        }
      }

      // Envelope follower with attack/release.
      const envCoeff = level > envelope ? attackCoeff : releaseCoeff;
      envelope = envCoeff * envelope + (1 - envCoeff) * level;

      // Open above threshold (re-arming hold); close below the hysteresis
      // level once the hold time has run out.
      if (envelope > thresholdLinear) {
        isOpen = true;
        hold = holdSamples;
      } else if (isOpen && envelope < closeLinear) {
        if (hold > 0) hold--;
        else isOpen = false;
      }

      // Open → unity; closed → the range floor. Attack coefficient when
      // opening, release when closing, so the timing controls shape the gain
      // (and avoid clicks).
      const targetGain = isOpen ? 1 : floorGain;
      const coeff = targetGain > gain ? attackCoeff : releaseCoeff;
      gain = coeff * gain + (1 - coeff) * targetGain;

      for (let c = 0; c < ins.length; c++) {
        outs[c][i] = this._finite[c] ? this._delayed[c] * gain : 0;
      }
    }
    this.envelopes[0] = envelope; this.envelopes[1] = envelope;
    this.currentGain[0] = gain; this.currentGain[1] = gain;
    this.holdCounter[0] = hold; this.holdCounter[1] = hold;
    this.isOpen = isOpen;

    // Keep processor alive
    return true;
  }
}

// Register the processor with the audio worklet
registerProcessor('vip-gate', GateProcessor);

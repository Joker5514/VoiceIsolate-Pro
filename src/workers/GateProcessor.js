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
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    // If no input, pass through silence
    if (!input || input.length === 0) {
      return true;
    }

    // Get parameter values (k-rate, so one value per block)
    const thresholdDb = parameters.threshold[0];
    const attackMs = parameters.attack[0];
    const releaseMs = parameters.release[0];

    // Update sample rate from the actual buffer length and expected duration
    if (input[0]) {
      this.sampleRate = sampleRate || 48000; // Use global sampleRate if available
    }

    // Calculate time constants for attack and release
    const attackCoeff = this.calculateTimeConstant(attackMs, this.sampleRate);
    const releaseCoeff = this.calculateTimeConstant(releaseMs, this.sampleRate);

    // Convert threshold to linear
    const thresholdLinear = this.dbToLinear(thresholdDb);

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

        // Determine target gain based on threshold
        let targetGain;
        if (this.envelopes[channel] > thresholdLinear) {
          // Signal above threshold: full gain
          targetGain = 1;
        } else {
          // Signal below threshold: gate closed (attenuate)
          // Use ratio of envelope to threshold for smooth transition
          const ratio = this.envelopes[channel] / thresholdLinear;
          // Smooth curve: ratio^2 for gentler gating
          targetGain = ratio * ratio;
        }

        // Smooth gain changes to avoid clicks
        const gainSmoothCoeff = 0.9999; // Very fast smoothing for gain
        this.currentGain[channel] = gainSmoothCoeff * this.currentGain[channel] + 
                                    (1 - gainSmoothCoeff) * targetGain;

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

// Made with Bob

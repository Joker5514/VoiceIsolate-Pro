/**
 * VoiceIsolate Pro — DeEsser Processor Tests
 * 
 * Tests the DeEsserProcessor AudioWorklet implementation:
 * - Parameter clamping (amount, frequency)
 * - Audio processing logic (sibilant detection and reduction)
 * - Biquad filter implementation
 * - Edge cases (silence, clipping, boundary values)
 */

const fs = require('fs');
const path = require('path');

// Read the processor source
const processorPath = path.join(__dirname, '../src/workers/DeEsserProcessor.js');
const processorSource = fs.readFileSync(processorPath, 'utf8');

describe('DeEsserProcessor', () => {
  let DeEsserProcessor;
  let processor;
  let mockSampleRate;

  beforeEach(() => {
    // Mock AudioWorkletProcessor base class
    global.AudioWorkletProcessor = class {
      constructor() {
        this.port = {
          postMessage: jest.fn(),
        };
      }
    };

    // Mock registerProcessor
    global.registerProcessor = jest.fn();

    // Mock global sampleRate
    mockSampleRate = 48000;
    global.sampleRate = mockSampleRate;

    // Execute the processor code to get the class
    eval(processorSource);
    DeEsserProcessor = global.registerProcessor.mock.calls[0][1];

    // Create a new processor instance
    processor = new DeEsserProcessor();
  });

  afterEach(() => {
    delete global.AudioWorkletProcessor;
    delete global.registerProcessor;
    delete global.sampleRate;
  });

  describe('Defensive guards', () => {
    it('returns true when output bus is missing', () => {
      const input = [new Float32Array(128).fill(0.5)];
      expect(processor.process([input], [[]], {})).toBe(true);
    });

    it('clamps out-of-range frequency to descriptor bounds', () => {
      const input = [new Float32Array(128).fill(0.5)];
      const output = [new Float32Array(128)];
      expect(() => processor.process([input], [output], { frequency: [99999] })).not.toThrow();
      expect(processor.lastFrequency).toBe(16000);
    });
  });

  describe('Parameter Descriptors', () => {
    it('should define amount parameter defaulting to 0 (de-esser off)', () => {
      const descriptors = DeEsserProcessor.parameterDescriptors;
      const amount = descriptors.find(d => d.name === 'amount');

      expect(amount).toBeDefined();
      expect(amount.defaultValue).toBe(0);
      expect(amount.minValue).toBe(0);
      expect(amount.maxValue).toBe(1);
      expect(amount.automationRate).toBe('k-rate');
    });

    it('should define frequency parameter with correct range', () => {
      const descriptors = DeEsserProcessor.parameterDescriptors;
      const frequency = descriptors.find(d => d.name === 'frequency');

      expect(frequency).toBeDefined();
      expect(frequency.defaultValue).toBe(6500);
      expect(frequency.minValue).toBe(2000);
      expect(frequency.maxValue).toBe(16000);
      expect(frequency.automationRate).toBe('k-rate');
    });
  });

  describe('Initialization', () => {
    it('should initialize with default state', () => {
      expect(processor.filterState).toHaveLength(2);
      expect(processor.filterState[0]).toEqual({ x1: 0, x2: 0, y1: 0, y2: 0 });
      expect(processor.filterState[1]).toEqual({ x1: 0, x2: 0, y1: 0, y2: 0 });
      expect(processor.sibilantEnvelope).toEqual([0, 0]);
      expect(processor.currentGain).toEqual([1, 1]);
      expect(processor.sampleRate).toBe(48000);
      expect(processor.lastFrequency).toBe(6500);
    });
  });

  describe('Filter Coefficient Calculation', () => {
    it('mutates the existing coefficient object instead of reallocating it', () => {
      const coeffs = processor.filterCoeffs;

      processor.calculateHighPassCoeffs(8000, 48000, 0.707);

      expect(processor.filterCoeffs).toBe(coeffs);
      expect(processor.filterCoeffs.b0).not.toBe(1);
    });

    it('should calculate high-pass filter coefficients', () => {
      processor.calculateHighPassCoeffs(6000, 48000, 0.707);

      expect(processor.filterCoeffs.b0).toBeDefined();
      expect(processor.filterCoeffs.b1).toBeDefined();
      expect(processor.filterCoeffs.b2).toBeDefined();
      expect(processor.filterCoeffs.a1).toBeDefined();
      expect(processor.filterCoeffs.a2).toBeDefined();

      // Coefficients should be finite numbers
      expect(isFinite(processor.filterCoeffs.b0)).toBe(true);
      expect(isFinite(processor.filterCoeffs.b1)).toBe(true);
      expect(isFinite(processor.filterCoeffs.b2)).toBe(true);
      expect(isFinite(processor.filterCoeffs.a1)).toBe(true);
      expect(isFinite(processor.filterCoeffs.a2)).toBe(true);
    });

    it('should handle different frequencies', () => {
      const frequencies = [3500, 6000, 8000, 10000];

      frequencies.forEach(freq => {
        processor.calculateHighPassCoeffs(freq, 48000, 0.707);
        
        // All coefficients should be valid
        expect(isFinite(processor.filterCoeffs.b0)).toBe(true);
        expect(isFinite(processor.filterCoeffs.a1)).toBe(true);
      });
    });

    it('should handle different sample rates', () => {
      const sampleRates = [44100, 48000, 96000];

      sampleRates.forEach(sr => {
        processor.calculateHighPassCoeffs(6000, sr, 0.707);
        
        // All coefficients should be valid
        expect(isFinite(processor.filterCoeffs.b0)).toBe(true);
        expect(isFinite(processor.filterCoeffs.a1)).toBe(true);
      });
    });
  });

  describe('Biquad Filter Application', () => {
    it('should apply filter to samples', () => {
      processor.calculateHighPassCoeffs(6000, 48000, 0.707);

      const input = 0.5;
      const output = processor.applyBiquadFilter(input, 0);

      expect(isFinite(output)).toBe(true);
    });

    it('should maintain filter state', () => {
      processor.calculateHighPassCoeffs(6000, 48000, 0.707);

      // Process multiple samples
      processor.applyBiquadFilter(0.5, 0);
      processor.applyBiquadFilter(0.3, 0);

      // State should be updated
      expect(processor.filterState[0].x1).not.toBe(0);
      expect(processor.filterState[0].y1).not.toBe(0);
    });

    it('should process channels independently', () => {
      processor.calculateHighPassCoeffs(6000, 48000, 0.707);

      processor.applyBiquadFilter(0.5, 0);
      processor.applyBiquadFilter(0.3, 1);

      // Each channel should have its own state
      expect(processor.filterState[0].x1).not.toBe(processor.filterState[1].x1);
    });
  });

  describe('Time Constant Calculation', () => {
    it('should calculate time constant correctly', () => {
      const coeff = processor.calculateTimeConstant(10, 48000);
      expect(coeff).toBeGreaterThan(0);
      expect(coeff).toBeLessThan(1);
    });

    it('should return 0 for zero time', () => {
      expect(processor.calculateTimeConstant(0, 48000)).toBe(0);
    });

    it('should handle different time values', () => {
      const times = [1, 10, 50, 100, 500];

      times.forEach(time => {
        const coeff = processor.calculateTimeConstant(time, 48000);
        expect(coeff).toBeGreaterThan(0);
        expect(coeff).toBeLessThan(1);
      });
    });
  });

  describe('Audio Processing', () => {
    it('should pass through silence unchanged', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];
      const parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      const result = processor.process(inputs, outputs, parameters);

      expect(result).toBe(true);
      expect(outputs[0][0].every(s => Math.abs(s) < 0.001)).toBe(true);
      expect(outputs[0][1].every(s => Math.abs(s) < 0.001)).toBe(true);
    });

    it('should process audio signal', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];

      // Fill with test signal
      for (let i = 0; i < blockSize; i++) {
        inputs[0][0][i] = Math.sin(2 * Math.PI * 1000 * i / 48000) * 0.5;
        inputs[0][1][i] = Math.sin(2 * Math.PI * 1000 * i / 48000) * 0.5;
      }

      const parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      const result = processor.process(inputs, outputs, parameters);

      expect(result).toBe(true);
      expect(outputs[0][0].some(s => s !== 0)).toBe(true);
    });

    it('should handle mono input', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0].fill(0.1);

      const parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      const result = processor.process(inputs, outputs, parameters);

      expect(result).toBe(true);
    });

    it('should handle stereo input independently', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];

      // Different signals in each channel
      inputs[0][0].fill(0.5);
      inputs[0][1].fill(0.2);

      const parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      processor.process(inputs, outputs, parameters);

      // Channels should be processed independently
      const leftAvg = outputs[0][0].reduce((a, b) => a + Math.abs(b), 0) / blockSize;
      const rightAvg = outputs[0][1].reduce((a, b) => a + Math.abs(b), 0) / blockSize;
      
      // Both should have output
      expect(leftAvg).toBeGreaterThan(0);
      expect(rightAvg).toBeGreaterThan(0);
    });

    it('should recalculate filter when frequency changes', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0].fill(0.1);

      // First process with one frequency
      let parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      processor.process(inputs, outputs, parameters);
      const firstFreq = processor.lastFrequency;
      const coeffs = processor.filterCoeffs;

      // Process with different frequency
      parameters = {
        amount: [0.5],
        frequency: [8000],
      };

      processor.process(inputs, outputs, parameters);
      const secondFreq = processor.lastFrequency;

      expect(secondFreq).not.toBe(firstFreq);
      expect(secondFreq).toBe(8000);
      expect(processor.filterCoeffs).toBe(coeffs);
    });

    it('should not recalculate filter for small frequency changes', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0].fill(0.1);

      const parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      processor.process(inputs, outputs, parameters);
      const coeffsBefore = { ...processor.filterCoeffs };

      // Very small change (less than 0.1 Hz)
      parameters.frequency = [6000.05];
      processor.process(inputs, outputs, parameters);

      // Coefficients should be the same
      expect(processor.filterCoeffs.b0).toBe(coeffsBefore.b0);
    });
  });

  describe('De-essing Behavior', () => {
    it('should reduce gain when amount is high', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      // High-frequency content that should trigger de-essing
      for (let i = 0; i < blockSize; i++) {
        inputs[0][0][i] = Math.sin(2 * Math.PI * 7000 * i / 48000) * 0.5;
      }

      const parameters = {
        amount: [1.0], // Maximum de-essing
        frequency: [6000],
      };

      // Process multiple blocks to build up envelope
      for (let i = 0; i < 10; i++) {
        processor.process(inputs, outputs, parameters);
      }

      // Gain should be reduced
      expect(processor.currentGain[0]).toBeLessThan(1.0);
    });

    it('should apply less reduction when amount is low', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      for (let i = 0; i < blockSize; i++) {
        inputs[0][0][i] = Math.sin(2 * Math.PI * 7000 * i / 48000) * 0.5;
      }

      // Low amount - minimal de-essing
      const parameters = {
        amount: [0.1],
        frequency: [6000],
      };

      // Process multiple blocks
      for (let i = 0; i < 10; i++) {
        processor.process(inputs, outputs, parameters);
      }

      // Gain should be closer to 1.0
      expect(processor.currentGain[0]).toBeGreaterThan(0.8);
    });

    it('should not affect signal when amount is 0', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0].fill(0.5);

      const parameters = {
        amount: [0],
        frequency: [6000],
      };

      processor.process(inputs, outputs, parameters);

      // With amount 0, gain should remain at 1.0
      expect(processor.currentGain[0]).toBeCloseTo(1.0, 2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty input', () => {
      const inputs = [[]];
      const outputs = [[]];
      const parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      const result = processor.process(inputs, outputs, parameters);

      expect(result).toBe(true);
    });

    it('should handle null input', () => {
      const inputs = [null];
      const outputs = [[new Float32Array(128)]];
      const parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      const result = processor.process(inputs, outputs, parameters);

      expect(result).toBe(true);
    });

    it('should handle NaN values', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0][0] = NaN;
      inputs[0][0][1] = Infinity;
      inputs[0][0][2] = -Infinity;

      const parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      processor.process(inputs, outputs, parameters);

      // Non-finite values should be replaced with 0
      expect(outputs[0][0][0]).toBe(0);
      expect(outputs[0][0][1]).toBe(0);
      expect(outputs[0][0][2]).toBe(0);
    });

    it('should handle extreme frequency values', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0].fill(0.1);

      // Minimum frequency
      let parameters = {
        amount: [0.5],
        frequency: [3500],
      };

      let result = processor.process(inputs, outputs, parameters);
      expect(result).toBe(true);

      // Maximum frequency
      parameters = {
        amount: [0.5],
        frequency: [10000],
      };

      result = processor.process(inputs, outputs, parameters);
      expect(result).toBe(true);
    });

    it('should handle extreme amount values', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0].fill(0.1);

      // Minimum amount
      let parameters = {
        amount: [0],
        frequency: [6000],
      };

      let result = processor.process(inputs, outputs, parameters);
      expect(result).toBe(true);

      // Maximum amount
      parameters = {
        amount: [1],
        frequency: [6000],
      };

      result = processor.process(inputs, outputs, parameters);
      expect(result).toBe(true);
    });

    it('should handle clipping input values', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      // Values beyond typical [-1, 1] range
      inputs[0][0].fill(2.0);

      const parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      processor.process(inputs, outputs, parameters);

      // Should process without crashing
      expect(outputs[0][0].some(s => s !== 0)).toBe(true);
    });

    it('should maintain state across multiple process calls', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      const parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      // First call with signal
      for (let i = 0; i < blockSize; i++) {
        inputs[0][0][i] = Math.sin(2 * Math.PI * 7000 * i / 48000) * 0.5;
      }
      processor.process(inputs, outputs, parameters);

      // Second call with silence - envelope should decay
      inputs[0][0].fill(0);
      outputs[0][0].fill(0);
      processor.process(inputs, outputs, parameters);

      // Envelope state should be maintained
      expect(processor.sibilantEnvelope[0]).toBeGreaterThanOrEqual(0);
    });

    it('should handle missing sampleRate global', () => {
      delete global.sampleRate;

      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0].fill(0.1);

      const parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      const result = processor.process(inputs, outputs, parameters);

      // Should use default sample rate
      expect(result).toBe(true);
      expect(processor.sampleRate).toBe(48000);
    });
  });

  describe('Envelope Behavior', () => {
    it('should build up sibilant envelope with high-frequency content', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      // High-frequency signal
      for (let i = 0; i < blockSize; i++) {
        inputs[0][0][i] = Math.sin(2 * Math.PI * 7000 * i / 48000) * 0.5;
      }

      const parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      // Process multiple blocks to build envelope
      for (let i = 0; i < 5; i++) {
        processor.process(inputs, outputs, parameters);
      }

      // Envelope should have built up
      expect(processor.sibilantEnvelope[0]).toBeGreaterThan(0);
    });

    it('should decay envelope with silence', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      const parameters = {
        amount: [0.5],
        frequency: [6000],
      };

      // Build up envelope
      for (let i = 0; i < blockSize; i++) {
        inputs[0][0][i] = Math.sin(2 * Math.PI * 7000 * i / 48000) * 0.5;
      }
      for (let i = 0; i < 5; i++) {
        processor.process(inputs, outputs, parameters);
      }

      const peakEnvelope = processor.sibilantEnvelope[0];

      // Now silence - envelope should decay
      inputs[0][0].fill(0);
      for (let i = 0; i < 5; i++) {
        processor.process(inputs, outputs, parameters);
      }

      expect(processor.sibilantEnvelope[0]).toBeLessThan(peakEnvelope);
    });
  });
});

// Made with Bob

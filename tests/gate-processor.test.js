/**
 * VoiceIsolate Pro — Gate Processor Tests
 * 
 * Tests the GateProcessor AudioWorklet implementation:
 * - Parameter clamping (threshold, attack, release)
 * - Audio processing logic (gate open/close behavior)
 * - Edge cases (silence, clipping, boundary values)
 */

const fs = require('fs');
const path = require('path');

// Read the processor source
const processorPath = path.join(__dirname, '../src/workers/GateProcessor.js');
const processorSource = fs.readFileSync(processorPath, 'utf8');

describe('GateProcessor', () => {
  let GateProcessor;
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
    GateProcessor = global.registerProcessor.mock.calls[0][1];

    // Create a new processor instance
    processor = new GateProcessor();
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

    it('clamps non-finite threshold to the default', () => {
      const input = [new Float32Array(128).fill(0.5)];
      const output = [new Float32Array(128)];
      expect(() => processor.process([input], [output], { threshold: [NaN] })).not.toThrow();
    });
  });

  describe('Parameter Descriptors', () => {
    it('should define threshold parameter with correct range', () => {
      const descriptors = GateProcessor.parameterDescriptors;
      const threshold = descriptors.find(d => d.name === 'threshold');

      expect(threshold).toBeDefined();
      expect(threshold.defaultValue).toBe(-40);
      expect(threshold.minValue).toBe(-100);
      expect(threshold.maxValue).toBe(0);
      expect(threshold.automationRate).toBe('k-rate');
    });

    it('should define range parameter defaulting to 0 (gate off)', () => {
      const descriptors = GateProcessor.parameterDescriptors;
      const range = descriptors.find(d => d.name === 'range');

      expect(range).toBeDefined();
      expect(range.defaultValue).toBe(0);
      expect(range.minValue).toBe(0);
      expect(range.maxValue).toBe(80);
      expect(range.automationRate).toBe('k-rate');
    });

    it('should define hold parameter with correct range', () => {
      const descriptors = GateProcessor.parameterDescriptors;
      const hold = descriptors.find(d => d.name === 'hold');

      expect(hold).toBeDefined();
      expect(hold.defaultValue).toBe(0);
      expect(hold.minValue).toBe(0);
      expect(hold.maxValue).toBe(1000);
      expect(hold.automationRate).toBe('k-rate');
    });

    it('should define attack parameter with correct range', () => {
      const descriptors = GateProcessor.parameterDescriptors;
      const attack = descriptors.find(d => d.name === 'attack');

      expect(attack).toBeDefined();
      expect(attack.defaultValue).toBe(10);
      expect(attack.minValue).toBe(0);
      expect(attack.maxValue).toBe(1000);
      expect(attack.automationRate).toBe('k-rate');
    });

    it('should define release parameter with correct range', () => {
      const descriptors = GateProcessor.parameterDescriptors;
      const release = descriptors.find(d => d.name === 'release');

      expect(release).toBeDefined();
      expect(release.defaultValue).toBe(100);
      expect(release.minValue).toBe(0);
      expect(release.maxValue).toBe(5000);
      expect(release.automationRate).toBe('k-rate');
    });
  });

  describe('Initialization', () => {
    it('should initialize with default state', () => {
      expect(processor.envelopes).toEqual([0, 0]);
      expect(processor.currentGain).toEqual([1, 1]);
      expect(processor.holdCounter).toEqual([0, 0]);
      expect(processor.sampleRate).toBe(48000);
    });
  });

  describe('Utility Functions', () => {
    it('should convert dB to linear correctly', () => {
      expect(processor.dbToLinear(0)).toBeCloseTo(1, 5);
      expect(processor.dbToLinear(-6)).toBeCloseTo(0.501187, 5);
      expect(processor.dbToLinear(-20)).toBeCloseTo(0.1, 5);
      expect(processor.dbToLinear(-40)).toBeCloseTo(0.01, 5);
      expect(processor.dbToLinear(-100)).toBeCloseTo(0.00001, 5);
    });

    it('should convert linear to dB correctly', () => {
      expect(processor.linearToDb(1)).toBeCloseTo(0, 5);
      expect(processor.linearToDb(0.5)).toBeCloseTo(-6.02, 1);
      expect(processor.linearToDb(0.1)).toBeCloseTo(-20, 5);
      expect(processor.linearToDb(0.01)).toBeCloseTo(-40, 5);
      expect(processor.linearToDb(0)).toBe(-100);
    });

    it('should calculate time constant correctly', () => {
      const coeff = processor.calculateTimeConstant(10, 48000);
      expect(coeff).toBeGreaterThan(0);
      expect(coeff).toBeLessThan(1);

      // Zero time should return 0
      expect(processor.calculateTimeConstant(0, 48000)).toBe(0);
    });
  });

  describe('Audio Processing', () => {
    it('should pass through silence unchanged', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];
      const parameters = {
        threshold: [-40],
        attack: [10],
        release: [100],
      };

      const result = processor.process(inputs, outputs, parameters);

      expect(result).toBe(true);
      expect(outputs[0][0].every(s => s === 0)).toBe(true);
      expect(outputs[0][1].every(s => s === 0)).toBe(true);
    });

    it('should open gate for signal above threshold', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];

      // Fill with signal above threshold (-40 dB = 0.01 linear)
      inputs[0][0].fill(0.1); // Well above threshold
      inputs[0][1].fill(0.1);

      const parameters = {
        threshold: [-40],
        attack: [10],
        release: [100],
      };

      processor.process(inputs, outputs, parameters);

      // Gate should be open, so output should be close to input
      // (may not be exactly equal due to envelope smoothing)
      const avgOutput = outputs[0][0].reduce((a, b) => a + b, 0) / blockSize;
      expect(avgOutput).toBeGreaterThan(0.05); // Significant output
    });

    it('should close gate for signal below threshold', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];

      // Fill with signal below threshold (-40 dB = 0.01 linear)
      inputs[0][0].fill(0.001); // Well below threshold
      inputs[0][1].fill(0.001);

      const parameters = {
        threshold: [-40],
        range: [60],   // attenuate 60 dB when closed
        attack: [10],
        release: [100],
      };

      // Run enough blocks for the release ramp to fully close the gate.
      for (let i = 0; i < 30; i++) processor.process(inputs, outputs, parameters);

      // Gate should be closed, so output should be heavily attenuated
      const avgOutput = outputs[0][0].reduce((a, b) => a + Math.abs(b), 0) / blockSize;
      expect(avgOutput).toBeLessThan(0.0005);
    });

    it('should stay transparent when range is 0 (gate off)', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      // Signal below threshold — but with range 0 the gate must not attenuate.
      inputs[0][0].fill(0.001);

      const parameters = {
        threshold: [-40],
        range: [0],
        attack: [10],
        release: [100],
      };

      for (let i = 0; i < 30; i++) processor.process(inputs, outputs, parameters);

      // Closed-gate gain is unity, so output ≈ input.
      const avgOutput = outputs[0][0].reduce((a, b) => a + b, 0) / blockSize;
      expect(avgOutput).toBeCloseTo(0.001, 4);
    });

    it('should hold the gate open for the hold time after signal drops', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      // ~85 ms hold at 48 kHz ≈ 4080 samples ≈ 32 blocks of 128.
      const parameters = {
        threshold: [-40],
        range: [60],
        attack: [0],
        release: [0],
        hold: [85],
      };

      // Open the gate with a loud block, which arms the hold timer.
      inputs[0][0].fill(0.5);
      processor.process(inputs, outputs, parameters);

      // Now feed silence: the gate must stay open (full gain) during the hold.
      inputs[0][0].fill(0);
      processor.process(inputs, outputs, parameters);
      expect(processor.currentGain[0]).toBeGreaterThan(0.9);
      expect(processor.holdCounter[0]).toBeGreaterThan(0);
    });

    it('should handle mono input', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0].fill(0.1);

      const parameters = {
        threshold: [-40],
        attack: [10],
        release: [100],
      };

      const result = processor.process(inputs, outputs, parameters);

      expect(result).toBe(true);
      expect(outputs[0][0].some(s => s !== 0)).toBe(true);
    });

    it('should handle stereo input independently', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize), new Float32Array(blockSize)]];

      // Left channel above threshold, right channel below
      inputs[0][0].fill(0.1);
      inputs[0][1].fill(0.001);

      const parameters = {
        threshold: [-40],
        range: [60],
        attack: [10],
        release: [100],
      };

      for (let i = 0; i < 30; i++) processor.process(inputs, outputs, parameters);

      // Left should stay open (passes), right should be gated down.
      const leftAvg = outputs[0][0].reduce((a, b) => a + Math.abs(b), 0) / blockSize;
      const rightAvg = outputs[0][1].reduce((a, b) => a + Math.abs(b), 0) / blockSize;
      expect(leftAvg).toBeGreaterThan(rightAvg);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty input', () => {
      const inputs = [[]];
      const outputs = [[]];
      const parameters = {
        threshold: [-40],
        attack: [10],
        release: [100],
      };

      const result = processor.process(inputs, outputs, parameters);

      expect(result).toBe(true);
    });

    it('should handle null input', () => {
      const inputs = [null];
      const outputs = [[new Float32Array(128)]];
      const parameters = {
        threshold: [-40],
        attack: [10],
        release: [100],
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
        threshold: [-40],
        attack: [10],
        release: [100],
      };

      processor.process(inputs, outputs, parameters);

      // Non-finite values should be replaced with 0
      expect(outputs[0][0][0]).toBe(0);
      expect(outputs[0][0][1]).toBe(0);
      expect(outputs[0][0][2]).toBe(0);
    });

    it('should handle extreme threshold values', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0].fill(0.1);

      // Very low threshold - gate should always be open
      let parameters = {
        threshold: [-100],
        range: [60],
        attack: [10],
        release: [100],
      };

      processor.process(inputs, outputs, parameters);
      let avgOutput = outputs[0][0].reduce((a, b) => a + b, 0) / blockSize;
      expect(avgOutput).toBeGreaterThan(0.05);

      // Reset processor
      processor = new GateProcessor();
      outputs[0][0].fill(0);

      // Very high threshold - gate should be closed
      parameters = {
        threshold: [0],
        range: [60],
        attack: [10],
        release: [100],
      };

      for (let i = 0; i < 30; i++) processor.process(inputs, outputs, parameters);
      avgOutput = outputs[0][0].reduce((a, b) => a + Math.abs(b), 0) / blockSize;
      expect(avgOutput).toBeLessThan(0.05);
    });

    it('should handle zero attack time', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0].fill(0.1);

      const parameters = {
        threshold: [-40],
        attack: [0],
        release: [100],
      };

      const result = processor.process(inputs, outputs, parameters);

      expect(result).toBe(true);
      // Should still process without crashing
    });

    it('should handle zero release time', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0].fill(0.1);

      const parameters = {
        threshold: [-40],
        attack: [10],
        release: [0],
      };

      const result = processor.process(inputs, outputs, parameters);

      expect(result).toBe(true);
      // Should still process without crashing
    });

    it('should handle very long attack/release times', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0].fill(0.1);

      const parameters = {
        threshold: [-40],
        attack: [1000],
        release: [5000],
      };

      const result = processor.process(inputs, outputs, parameters);

      expect(result).toBe(true);
    });

    it('should handle clipping input values', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      // Values beyond typical [-1, 1] range
      inputs[0][0].fill(2.0);

      const parameters = {
        threshold: [-40],
        attack: [10],
        release: [100],
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
        threshold: [-40],
        attack: [10],
        release: [100],
      };

      // First call with signal
      inputs[0][0].fill(0.1);
      processor.process(inputs, outputs, parameters);
      const firstOutput = outputs[0][0][blockSize - 1];

      // Second call with silence - envelope should decay
      inputs[0][0].fill(0);
      outputs[0][0].fill(0);
      processor.process(inputs, outputs, parameters);

      // Envelope state should be maintained
      expect(processor.envelopes[0]).toBeGreaterThan(0);
    });
  });

  describe('Envelope Behavior', () => {
    it('should build up envelope during attack', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      inputs[0][0].fill(0.1);

      const parameters = {
        threshold: [-40],
        attack: [10],
        release: [100],
      };

      // Process multiple blocks to build envelope
      for (let i = 0; i < 5; i++) {
        processor.process(inputs, outputs, parameters);
      }

      // Envelope should have built up
      expect(processor.envelopes[0]).toBeGreaterThan(0);
    });

    it('should decay envelope during release', () => {
      const blockSize = 128;
      const inputs = [[new Float32Array(blockSize)]];
      const outputs = [[new Float32Array(blockSize)]];

      const parameters = {
        threshold: [-40],
        attack: [10],
        release: [100],
      };

      // Build up envelope
      inputs[0][0].fill(0.1);
      for (let i = 0; i < 5; i++) {
        processor.process(inputs, outputs, parameters);
      }

      const peakEnvelope = processor.envelopes[0];

      // Now silence - envelope should decay
      inputs[0][0].fill(0);
      for (let i = 0; i < 5; i++) {
        processor.process(inputs, outputs, parameters);
      }

      expect(processor.envelopes[0]).toBeLessThan(peakEnvelope);
    });
  });
});

// Made with Bob

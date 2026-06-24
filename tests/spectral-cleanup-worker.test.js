/**
 * VoiceIsolate Pro — Spectral Cleanup Worker Tests
 * 
 * Tests the message handling protocol for SpectralCleanupWorker.js:
 * - Request/response protocol
 * - Error responses
 * - Transferable handling
 * - Request ID tracking
 * - Parameter handling (noiseReduction, dereverb)
 */

const fs = require('fs');
const path = require('path');

// Read the worker source
const workerPath = path.join(__dirname, '../src/workers/SpectralCleanupWorker.js');
const workerSource = fs.readFileSync(workerPath, 'utf8');

// Mock the spectral cleanup core module
const mockSpectralCleanup = {
  reduceNoise: jest.fn(),
  dereverb: jest.fn(),
};

describe('SpectralCleanupWorker', () => {
  let workerGlobal;
  let postedMessages;

  beforeEach(() => {
    postedMessages = [];
    
    // Reset mocks
    mockSpectralCleanup.reduceNoise.mockReset();
    mockSpectralCleanup.dereverb.mockReset();

    // Default mock implementations (pass-through)
    mockSpectralCleanup.reduceNoise.mockImplementation((audio) => audio);
    mockSpectralCleanup.dereverb.mockImplementation((audio) => audio);

    // Create worker global context
    workerGlobal = {
      self: {
        postMessage: jest.fn((msg, transfer) => {
          postedMessages.push({ msg, transfer });
        }),
        onmessage: null,
      },
      Float32Array: Float32Array,
      Number: Number,
      console: console,
    };

    // Mock the ES module import by creating a module loader
    const moduleCode = workerSource.replace(
      /import\s+{[^}]+}\s+from\s+['"][^'"]+['"];?/g,
      ''
    );

    // Inject the mocked functions into the worker context
    const argNames = [...Object.keys(workerGlobal), 'reduceNoise', 'dereverb'];
    const argValues = [...Object.values(workerGlobal), mockSpectralCleanup.reduceNoise, mockSpectralCleanup.dereverb];

    // Execute worker code with injected globals
    const fn = new Function(...argNames, moduleCode);
    fn(...argValues);
  });

  describe('Message Protocol', () => {
    it('should handle cleanup message with valid data', async () => {
      const testChannels = [
        new Float32Array([0.1, 0.2, 0.3]),
        new Float32Array([0.4, 0.5, 0.6]),
      ];
      const requestId = 'test-request-123';

      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId,
          channels: testChannels,
          sampleRate: 48000,
          noiseReduction: 0.5,
          dereverb: 0.3,
        },
      });

      // Verify both processing functions were called
      expect(mockSpectralCleanup.reduceNoise).toHaveBeenCalledTimes(2);
      expect(mockSpectralCleanup.dereverb).toHaveBeenCalledTimes(2);

      // Verify response message
      expect(postedMessages).toHaveLength(1);
      const { msg, transfer } = postedMessages[0];
      expect(msg.type).toBe('cleaned');
      expect(msg.requestId).toBe(requestId);
      expect(msg.channels).toHaveLength(2);
      expect(msg.sampleRate).toBe(48000);

      // Verify transferables were used
      expect(transfer).toBeDefined();
      expect(transfer).toHaveLength(2);
    });

    it('should skip noise reduction when amount is 0', async () => {
      const testChannels = [new Float32Array([0.1, 0.2])];

      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-no-nr',
          channels: testChannels,
          sampleRate: 48000,
          noiseReduction: 0,
          dereverb: 0.5,
        },
      });

      expect(mockSpectralCleanup.reduceNoise).not.toHaveBeenCalled();
      expect(mockSpectralCleanup.dereverb).toHaveBeenCalledTimes(1);
    });

    it('should skip dereverb when amount is 0', async () => {
      const testChannels = [new Float32Array([0.1, 0.2])];

      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-no-dr',
          channels: testChannels,
          sampleRate: 48000,
          noiseReduction: 0.5,
          dereverb: 0,
        },
      });

      expect(mockSpectralCleanup.reduceNoise).toHaveBeenCalledTimes(1);
      expect(mockSpectralCleanup.dereverb).not.toHaveBeenCalled();
    });

    it('should skip both when amounts are 0', async () => {
      const testChannels = [new Float32Array([0.1, 0.2])];

      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-no-processing',
          channels: testChannels,
          sampleRate: 48000,
          noiseReduction: 0,
          dereverb: 0,
        },
      });

      expect(mockSpectralCleanup.reduceNoise).not.toHaveBeenCalled();
      expect(mockSpectralCleanup.dereverb).not.toHaveBeenCalled();
      
      // Should still return the channels
      expect(postedMessages[0].msg.type).toBe('cleaned');
    });

    it('should convert non-Float32Array channels to Float32Array', async () => {
      const regularArrays = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];

      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-convert',
          channels: regularArrays,
          sampleRate: 48000,
          noiseReduction: 0.5,
          dereverb: 0,
        },
      });

      // Verify conversion happened
      const firstCall = mockSpectralCleanup.reduceNoise.mock.calls[0][0];
      expect(firstCall).toBeInstanceOf(Float32Array);
    });

    it('should track request ID through the pipeline', async () => {
      const requestIds = ['req-1', 'req-2', 'req-3'];

      for (const requestId of requestIds) {
        await workerGlobal.self.onmessage({
          data: {
            type: 'cleanup',
            requestId,
            channels: [new Float32Array([0.1])],
            sampleRate: 48000,
            noiseReduction: 0.5,
            dereverb: 0.5,
          },
        });
      }

      expect(postedMessages).toHaveLength(3);
      requestIds.forEach((id, index) => {
        expect(postedMessages[index].msg.requestId).toBe(id);
      });
    });

    it('should pass correct parameters to processing functions', async () => {
      const testChannels = [new Float32Array([0.1, 0.2])];
      const sampleRate = 44100;
      const nrAmount = 0.75;
      const drAmount = 0.6;

      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-params',
          channels: testChannels,
          sampleRate,
          noiseReduction: nrAmount,
          dereverb: drAmount,
        },
      });

      // Check reduceNoise parameters
      expect(mockSpectralCleanup.reduceNoise).toHaveBeenCalledWith(
        expect.any(Float32Array),
        { amount: nrAmount, sampleRate }
      );

      // Check dereverb parameters
      expect(mockSpectralCleanup.dereverb).toHaveBeenCalledWith(
        expect.any(Float32Array),
        { amount: drAmount, sampleRate }
      );
    });
  });

  describe('Error Handling', () => {
    it('should post error message for unknown message type', async () => {
      await workerGlobal.self.onmessage({
        data: {
          type: 'unknown-type',
          requestId: 'test-error',
        },
      });

      expect(postedMessages).toHaveLength(1);
      const { msg } = postedMessages[0];
      expect(msg.type).toBe('error');
      expect(msg.requestId).toBe('test-error');
      expect(msg.message).toContain('Unknown message type');
      expect(msg.message).toContain('unknown-type');
    });

    it('should handle noise reduction errors gracefully', async () => {
      const errorMessage = 'Noise reduction failed';
      mockSpectralCleanup.reduceNoise.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-nr-error',
          channels: [new Float32Array([0.1])],
          sampleRate: 48000,
          noiseReduction: 0.5,
          dereverb: 0,
        },
      });

      expect(postedMessages).toHaveLength(1);
      const { msg } = postedMessages[0];
      expect(msg.type).toBe('error');
      expect(msg.requestId).toBe('test-nr-error');
      expect(msg.message).toBe(errorMessage);
    });

    it('should handle dereverb errors gracefully', async () => {
      const errorMessage = 'Dereverb failed';
      mockSpectralCleanup.dereverb.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-dr-error',
          channels: [new Float32Array([0.1])],
          sampleRate: 48000,
          noiseReduction: 0,
          dereverb: 0.5,
        },
      });

      expect(postedMessages).toHaveLength(1);
      const { msg } = postedMessages[0];
      expect(msg.type).toBe('error');
      expect(msg.message).toBe(errorMessage);
    });

    it('should handle errors without Error objects', async () => {
      mockSpectralCleanup.reduceNoise.mockImplementation(() => {
        throw 'String error';
      });

      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-string-error',
          channels: [new Float32Array([0.1])],
          sampleRate: 48000,
          noiseReduction: 0.5,
          dereverb: 0,
        },
      });

      expect(postedMessages).toHaveLength(1);
      const { msg } = postedMessages[0];
      expect(msg.type).toBe('error');
      expect(msg.message).toBe('String error');
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing data object', async () => {
      await workerGlobal.self.onmessage({ data: null });

      expect(postedMessages).toHaveLength(1);
      expect(postedMessages[0].msg.type).toBe('error');
    });

    it('should handle empty channels array', async () => {
      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-empty',
          channels: [],
          sampleRate: 48000,
          noiseReduction: 0.5,
          dereverb: 0.5,
        },
      });

      expect(postedMessages).toHaveLength(1);
      const { msg } = postedMessages[0];
      expect(msg.type).toBe('cleaned');
      expect(msg.channels).toHaveLength(0);
    });

    it('should handle missing channels field', async () => {
      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-no-channels',
          sampleRate: 48000,
          noiseReduction: 0.5,
          dereverb: 0.5,
        },
      });

      expect(postedMessages).toHaveLength(1);
      const { msg } = postedMessages[0];
      expect(msg.type).toBe('cleaned');
      expect(msg.channels).toHaveLength(0);
    });

    it('should handle missing requestId', async () => {
      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          channels: [new Float32Array([0.1])],
          sampleRate: 48000,
          noiseReduction: 0,
          dereverb: 0,
        },
      });

      expect(postedMessages).toHaveLength(1);
      expect(postedMessages[0].msg.type).toBe('cleaned');
      expect(postedMessages[0].msg.requestId).toBeUndefined();
    });

    it('should default missing noiseReduction to 0', async () => {
      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-default-nr',
          channels: [new Float32Array([0.1])],
          sampleRate: 48000,
          dereverb: 0.5,
        },
      });

      expect(mockSpectralCleanup.reduceNoise).not.toHaveBeenCalled();
      expect(mockSpectralCleanup.dereverb).toHaveBeenCalled();
    });

    it('should default missing dereverb to 0', async () => {
      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-default-dr',
          channels: [new Float32Array([0.1])],
          sampleRate: 48000,
          noiseReduction: 0.5,
        },
      });

      expect(mockSpectralCleanup.reduceNoise).toHaveBeenCalled();
      expect(mockSpectralCleanup.dereverb).not.toHaveBeenCalled();
    });

    it('should handle null channel elements', async () => {
      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-null-channel',
          channels: [null, new Float32Array([0.1])],
          sampleRate: 48000,
          noiseReduction: 0,
          dereverb: 0,
        },
      });

      expect(postedMessages).toHaveLength(1);
      const { msg } = postedMessages[0];
      expect(msg.type).toBe('cleaned');
      expect(msg.channels).toHaveLength(2);
      expect(msg.channels[0]).toBeInstanceOf(Float32Array);
      expect(msg.channels[0].length).toBe(0);
    });
  });

  describe('Transferable Handling', () => {
    it('should use transferables for output channels', async () => {
      const testChannels = [
        new Float32Array([0.1, 0.2]),
        new Float32Array([0.3, 0.4]),
      ];

      await workerGlobal.self.onmessage({
        data: {
          type: 'cleanup',
          requestId: 'test-transfer',
          channels: testChannels,
          sampleRate: 48000,
          noiseReduction: 0,
          dereverb: 0,
        },
      });

      const { transfer } = postedMessages[0];
      expect(transfer).toBeDefined();
      expect(transfer).toHaveLength(2);
      
      // Verify each transfer is an ArrayBuffer (cross-realm safe check)
      transfer.forEach((t) => {
        expect(Object.prototype.toString.call(t)).toBe('[object ArrayBuffer]');
      });
    });
  });
});

// Made with Bob

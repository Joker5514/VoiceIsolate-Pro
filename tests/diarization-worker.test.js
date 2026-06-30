/**
 * VoiceIsolate Pro — Diarization Worker Tests
 * 
 * Tests the message handling protocol for DiarizationWorker.js:
 * - Request/response protocol
 * - Error responses
 * - Transferable handling
 * - Request ID tracking
 */

const fs = require('fs');
const path = require('path');

// Read the worker source
const workerPath = path.join(__dirname, '../src/workers/DiarizationWorker.js');
const workerSource = fs.readFileSync(workerPath, 'utf8');

// Mock the diarization core module
const mockDiarization = {
  diarizeChannel: jest.fn(),
  summarizeSpeakers: jest.fn(),
};

describe('DiarizationWorker', () => {
  let workerGlobal;
  let postedMessages;

  beforeEach(() => {
    postedMessages = [];
    
    // Reset mocks
    mockDiarization.diarizeChannel.mockReset();
    mockDiarization.summarizeSpeakers.mockReset();

    // Create worker global context
    workerGlobal = {
      self: {
        postMessage: jest.fn((msg) => postedMessages.push(msg)),
        onmessage: null,
      },
      Float32Array: Float32Array,
      console: console,
    };

    // Mock the ES module import by creating a module loader
    const moduleCode = workerSource.replace(
      /import\s+{[^}]+}\s+from\s+['"][^'"]+['"];?/g,
      ''
    );

    // Inject the mocked functions into the worker context
    const argNames = [...Object.keys(workerGlobal), 'diarizeChannel', 'summarizeSpeakers'];
    const argValues = [...Object.values(workerGlobal), mockDiarization.diarizeChannel, mockDiarization.summarizeSpeakers];

    // Execute worker code with injected globals
    const fn = new Function(...argNames, moduleCode);
    fn(...argValues);
  });

  describe('Message Protocol', () => {
    it('should handle diarize message with valid data', async () => {
      const mockSegments = [
        { start: 0, end: 1.5, speaker: 0 },
        { start: 1.5, end: 3.0, speaker: 1 },
      ];
      const mockSummary = [
        { id: 0, duration: 1.5, segments: 1 },
        { id: 1, duration: 1.5, segments: 1 },
      ];

      mockDiarization.diarizeChannel.mockReturnValue(mockSegments);
      mockDiarization.summarizeSpeakers.mockReturnValue(mockSummary);

      const testSamples = new Float32Array(48000); // 1 second at 48kHz
      const requestId = 'test-request-123';

      await workerGlobal.self.onmessage({
        data: {
          type: 'diarize',
          requestId,
          samples: testSamples,
          sampleRate: 48000,
        },
      });

      // Verify diarization was called with correct parameters
      expect(mockDiarization.diarizeChannel).toHaveBeenCalledWith(
        expect.any(Float32Array),
        48000
      );

      // Verify summarize was called with segments
      expect(mockDiarization.summarizeSpeakers).toHaveBeenCalledWith(mockSegments);

      // Verify response message
      expect(postedMessages).toHaveLength(1);
      const response = postedMessages[0];
      expect(response.type).toBe('segments');
      expect(response.requestId).toBe(requestId);
      expect(response.segments).toEqual(mockSegments);
      expect(response.speakers).toEqual(mockSummary);
    });

    it('should convert non-Float32Array samples to Float32Array', async () => {
      mockDiarization.diarizeChannel.mockReturnValue([]);
      mockDiarization.summarizeSpeakers.mockReturnValue([]);

      const regularArray = [1, 2, 3, 4];

      await workerGlobal.self.onmessage({
        data: {
          type: 'diarize',
          requestId: 'test-123',
          samples: regularArray,
          sampleRate: 48000,
        },
      });

      // Verify it was converted to Float32Array (cross-realm safe check)
      const callArg = mockDiarization.diarizeChannel.mock.calls[0][0];
      expect(Object.prototype.toString.call(callArg)).toBe('[object Float32Array]');
      expect(Array.from(callArg)).toEqual(regularArray);
    });

    it('should handle empty samples array', async () => {
      mockDiarization.diarizeChannel.mockReturnValue([]);
      mockDiarization.summarizeSpeakers.mockReturnValue([]);

      await workerGlobal.self.onmessage({
        data: {
          type: 'diarize',
          requestId: 'test-empty',
          samples: [],
          sampleRate: 48000,
        },
      });

      expect(mockDiarization.diarizeChannel).toHaveBeenCalledWith(
        expect.any(Float32Array),
        48000
      );
      expect(postedMessages[0].type).toBe('segments');
    });

    it('should track request ID through the pipeline', async () => {
      mockDiarization.diarizeChannel.mockReturnValue([]);
      mockDiarization.summarizeSpeakers.mockReturnValue([]);

      const requestIds = ['req-1', 'req-2', 'req-3'];

      for (const requestId of requestIds) {
        await workerGlobal.self.onmessage({
          data: {
            type: 'diarize',
            requestId,
            samples: new Float32Array(100),
            sampleRate: 48000,
          },
        });
      }

      expect(postedMessages).toHaveLength(3);
      requestIds.forEach((id, index) => {
        expect(postedMessages[index].requestId).toBe(id);
      });
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
      const response = postedMessages[0];
      expect(response.type).toBe('error');
      expect(response.requestId).toBe('test-error');
      expect(response.message).toContain('Unknown message type');
      expect(response.message).toContain('unknown-type');
    });

    it('should handle diarization errors gracefully', async () => {
      const errorMessage = 'Diarization failed: invalid audio';
      mockDiarization.diarizeChannel.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      await workerGlobal.self.onmessage({
        data: {
          type: 'diarize',
          requestId: 'test-error-123',
          samples: new Float32Array(100),
          sampleRate: 48000,
        },
      });

      expect(postedMessages).toHaveLength(1);
      const response = postedMessages[0];
      expect(response.type).toBe('error');
      expect(response.requestId).toBe('test-error-123');
      expect(response.message).toBe(errorMessage);
    });

    it('should handle errors without Error objects', async () => {
      mockDiarization.diarizeChannel.mockImplementation(() => {
        throw 'String error';
      });

      await workerGlobal.self.onmessage({
        data: {
          type: 'diarize',
          requestId: 'test-string-error',
          samples: new Float32Array(100),
          sampleRate: 48000,
        },
      });

      expect(postedMessages).toHaveLength(1);
      const response = postedMessages[0];
      expect(response.type).toBe('error');
      expect(response.message).toBe('String error');
    });

    it('should include requestId in error response when available', async () => {
      mockDiarization.diarizeChannel.mockImplementation(() => {
        throw new Error('Test error');
      });

      await workerGlobal.self.onmessage({
        data: {
          type: 'diarize',
          requestId: 'error-with-id',
          samples: new Float32Array(100),
          sampleRate: 48000,
        },
      });

      expect(postedMessages[0].requestId).toBe('error-with-id');
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing data object', async () => {
      await workerGlobal.self.onmessage({ data: null });

      expect(postedMessages).toHaveLength(1);
      expect(postedMessages[0].type).toBe('error');
    });

    it('should handle missing samples field', async () => {
      mockDiarization.diarizeChannel.mockReturnValue([]);
      mockDiarization.summarizeSpeakers.mockReturnValue([]);

      await workerGlobal.self.onmessage({
        data: {
          type: 'diarize',
          requestId: 'no-samples',
          sampleRate: 48000,
        },
      });

      // Should create empty Float32Array
      const callArg = mockDiarization.diarizeChannel.mock.calls[0][0];
      expect(callArg).toBeInstanceOf(Float32Array);
      expect(callArg.length).toBe(0);
    });

    it('should handle missing requestId', async () => {
      mockDiarization.diarizeChannel.mockReturnValue([]);
      mockDiarization.summarizeSpeakers.mockReturnValue([]);

      await workerGlobal.self.onmessage({
        data: {
          type: 'diarize',
          samples: new Float32Array(100),
          sampleRate: 48000,
        },
      });

      expect(postedMessages).toHaveLength(1);
      expect(postedMessages[0].type).toBe('segments');
      expect(postedMessages[0].requestId).toBeUndefined();
    });
  });
});

// Made with Bob

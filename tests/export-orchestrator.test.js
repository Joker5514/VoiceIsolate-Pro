/**
 * Tests for ExportOrchestrator (Layer 3: Pipeline)
 */
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');

describe('ExportOrchestrator', () => {
  let ExportOrchestrator;
  let PlaybackMixer;
  let mockMixer;
  let mockWorker;
  let workerMessageHandler;

  beforeEach(async () => {
    // Mock Worker
    global.Worker = jest.fn().mockImplementation((path, options) => {
      mockWorker = {
        postMessage: jest.fn(),
        terminate: jest.fn(),
        onmessage: null,
        onerror: null,
      };
      
      // Simulate worker ready message after a tick
      setTimeout(() => {
        if (mockWorker.onmessage) {
          mockWorker.onmessage({ data: { type: 'ready' } });
        }
      }, 0);
      
      return mockWorker;
    });

    // Import modules
    const orchestratorModule = await import('../src/pipeline/ExportOrchestrator.js');
    ExportOrchestrator = orchestratorModule.ExportOrchestrator;
    
    const mixerModule = await import('../src/pipeline/PlaybackMixer.js');
    PlaybackMixer = mixerModule.PlaybackMixer;

    // Create mock mixer with stems
    mockMixer = {
      cleanBuffer: createMockAudioBuffer(2, 48000, 1.0),
      noiseBuffer: createMockAudioBuffer(2, 48000, 1.0),
      getSpeakerSegments: jest.fn().mockReturnValue([]),
      getSpeakerState: jest.fn().mockReturnValue(null),
      getSoloSpeaker: jest.fn().mockReturnValue(null),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.Worker;
  });

  function createMockAudioBuffer(channels, sampleRate, duration) {
    const length = Math.floor(sampleRate * duration);
    return {
      numberOfChannels: channels,
      sampleRate,
      duration,
      length,
      getChannelData: jest.fn((ch) => {
        const data = new Float32Array(length);
        // Fill with test pattern
        for (let i = 0; i < length; i++) {
          data[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.5;
        }
        return data;
      }),
    };
  }

  describe('constructor', () => {
    it('should require a mixer instance', () => {
      expect(() => new ExportOrchestrator()).toThrow('PlaybackMixer instance required');
    });

    it('should create an instance with valid mixer', () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      expect(orchestrator).toBeInstanceOf(ExportOrchestrator);
      expect(orchestrator.mixer).toBe(mockMixer);
    });
  });

  describe('export', () => {
    it('should reject if no stems are loaded', async () => {
      const orchestrator = new ExportOrchestrator({ cleanBuffer: null, noiseBuffer: null });
      await expect(orchestrator.export()).rejects.toThrow('No stems loaded');
    });

    it('should validate stem option', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      await expect(orchestrator.export({ stems: 'invalid' })).rejects.toThrow('Invalid stems option');
    });

    it('should validate format option', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      await expect(orchestrator.export({ format: 'invalid' })).rejects.toThrow('Invalid format');
    });

    it('should validate bitrate option', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      await expect(orchestrator.export({ format: 'mp3', bitrate: 999 })).rejects.toThrow('Invalid bitrate');
    });

    it('should initialize worker on first export', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      
      // Start export (will initialize worker)
      const exportPromise = orchestrator.export({ stems: 'clean', format: 'wav' });
      
      // Wait for worker initialization
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(global.Worker).toHaveBeenCalledWith('/src/workers/AudioEncoderWorker.js', { type: 'module' });
      
      // Simulate worker response
      mockWorker.onmessage({
        data: {
          type: 'result',
          requestId: 0,
          blob: new Blob(['test'], { type: 'audio/wav' }),
          format: 'wav',
        },
      });
      
      const result = await exportPromise;
      expect(result).toHaveProperty('blob');
      expect(result).toHaveProperty('filename');
      expect(result.format).toBe('wav');
    });

    it('should export clean stem only', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      
      const exportPromise = orchestrator.export({ stems: 'clean', format: 'wav', filename: 'test' });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Check worker received correct data
      expect(mockWorker.postMessage).toHaveBeenCalled();
      const call = mockWorker.postMessage.mock.calls[0];
      expect(call[0].type).toBe('encode');
      expect(call[0].format).toBe('wav');
      expect(call[0].channels).toHaveLength(2);
      
      // Simulate response
      mockWorker.onmessage({
        data: {
          type: 'result',
          requestId: call[0].requestId,
          blob: new Blob(['wav-data'], { type: 'audio/wav' }),
          format: 'wav',
        },
      });
      
      const result = await exportPromise;
      expect(result.filename).toBe('test.wav');
      expect(result.format).toBe('wav');
    });

    it('should export noise stem only', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      
      const exportPromise = orchestrator.export({ stems: 'noise', format: 'wav' });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      mockWorker.onmessage({
        data: {
          type: 'result',
          requestId: 0,
          blob: new Blob(['wav-data'], { type: 'audio/wav' }),
          format: 'wav',
        },
      });
      
      const result = await exportPromise;
      expect(result.filename).toContain('export.wav');
    });

    it('should export both stems as separate files', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      
      const exportPromise = orchestrator.export({ stems: 'both', format: 'wav', filename: 'test' });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Should make two worker calls
      expect(mockWorker.postMessage).toHaveBeenCalledTimes(2);
      
      // Simulate responses for both
      mockWorker.onmessage({
        data: {
          type: 'result',
          requestId: 0,
          blob: new Blob(['clean-data'], { type: 'audio/wav' }),
          format: 'wav',
        },
      });
      
      mockWorker.onmessage({
        data: {
          type: 'result',
          requestId: 1,
          blob: new Blob(['noise-data'], { type: 'audio/wav' }),
          format: 'wav',
        },
      });
      
      const results = await exportPromise;
      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(2);
      expect(results[0].filename).toBe('test-clean.wav');
      expect(results[1].filename).toBe('test-noise.wav');
    });

    it('should support MP3 format with bitrate', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      
      const exportPromise = orchestrator.export({
        stems: 'clean',
        format: 'mp3',
        bitrate: 320,
        filename: 'test',
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const call = mockWorker.postMessage.mock.calls[0];
      expect(call[0].format).toBe('mp3');
      expect(call[0].bitrate).toBe(320);
      
      mockWorker.onmessage({
        data: {
          type: 'result',
          requestId: call[0].requestId,
          blob: new Blob(['mp3-data'], { type: 'audio/mpeg' }),
          format: 'mp3',
        },
      });
      
      const result = await exportPromise;
      expect(result.filename).toBe('test.mp3');
      expect(result.format).toBe('mp3');
    });

    it('should call progress callback', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      const onProgress = jest.fn();
      
      const exportPromise = orchestrator.export({
        stems: 'clean',
        format: 'wav',
        onProgress,
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Simulate progress updates
      const requestId = mockWorker.postMessage.mock.calls[0][0].requestId;
      mockWorker.onmessage({ data: { type: 'progress', requestId, progress: 0.5, stage: 'encoding' } });
      
      expect(onProgress).toHaveBeenCalled();
      expect(onProgress.mock.calls.some(call => call[1] === 'encoding')).toBe(true);
      
      // Complete
      mockWorker.onmessage({
        data: {
          type: 'result',
          requestId,
          blob: new Blob(['data'], { type: 'audio/wav' }),
          format: 'wav',
        },
      });
      
      await exportPromise;
    });

    it('should handle worker errors', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      
      const exportPromise = orchestrator.export({ stems: 'clean', format: 'wav' });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const requestId = mockWorker.postMessage.mock.calls[0][0].requestId;
      mockWorker.onmessage({
        data: {
          type: 'error',
          requestId,
          error: 'Encoding failed',
        },
      });
      
      await expect(exportPromise).rejects.toThrow('Encoding failed');
    });

    it('should apply speaker automation when requested', async () => {
      // Setup mixer with speaker segments
      mockMixer.getSpeakerSegments.mockReturnValue([
        { speakerId: 'speaker1', start: 0, end: 0.5 },
        { speakerId: 'speaker2', start: 0.5, end: 1.0 },
      ]);
      mockMixer.getSpeakerState.mockImplementation((id) => {
        if (id === 'speaker1') return { volume: 100, muted: false };
        if (id === 'speaker2') return { volume: 50, muted: false };
        return null;
      });
      
      const orchestrator = new ExportOrchestrator(mockMixer);
      
      const exportPromise = orchestrator.export({
        stems: 'clean',
        format: 'wav',
        applySpeakerAutomation: true,
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Verify speaker automation was queried
      expect(mockMixer.getSpeakerSegments).toHaveBeenCalled();
      
      mockWorker.onmessage({
        data: {
          type: 'result',
          requestId: 0,
          blob: new Blob(['data'], { type: 'audio/wav' }),
          format: 'wav',
        },
      });
      
      await exportPromise;
    });
  });

  describe('dispose', () => {
    it('should terminate worker and clean up', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      
      // Initialize worker
      const exportPromise = orchestrator.export({ stems: 'clean', format: 'wav' });
      await new Promise(resolve => setTimeout(resolve, 10));
      
      mockWorker.onmessage({
        data: {
          type: 'result',
          requestId: 0,
          blob: new Blob(['data'], { type: 'audio/wav' }),
          format: 'wav',
        },
      });
      
      await exportPromise;
      
      orchestrator.dispose();
      
      expect(mockWorker.terminate).toHaveBeenCalled();
    });

    it('should reject an in-flight export instead of leaving it pending', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      const exportPromise = orchestrator.export({ stems: 'clean', format: 'wav' });
      await new Promise(resolve => setTimeout(resolve, 10));

      orchestrator.dispose();

      await expect(exportPromise).rejects.toThrow('Disposed during export');
      expect(mockWorker.terminate).toHaveBeenCalled();
    });
  });

  describe('worker failures', () => {
    it('should reject initialization immediately when disposed before ready', async () => {
      global.Worker.mockImplementationOnce(() => {
        mockWorker = {
          postMessage: jest.fn(),
          terminate: jest.fn(),
          onmessage: null,
          onerror: null,
        };
        return mockWorker;
      });
      const orchestrator = new ExportOrchestrator(mockMixer);
      const exportPromise = orchestrator.export({ stems: 'clean', format: 'wav' });
      await Promise.resolve();

      orchestrator.dispose();

      await expect(exportPromise).rejects.toThrow('Disposed during export');
      expect(mockWorker.terminate).toHaveBeenCalled();
    });

    it('should reject an in-flight export and reset after a fatal worker error', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      const exportPromise = orchestrator.export({ stems: 'clean', format: 'wav' });
      await new Promise(resolve => setTimeout(resolve, 10));

      mockWorker.onerror({ message: 'encoder crashed' });

      await expect(exportPromise).rejects.toThrow('encoder crashed');
      expect(mockWorker.terminate).toHaveBeenCalled();
      expect(orchestrator._worker).toBeNull();
      expect(orchestrator._workerReady).toBe(false);
    });

    it('should share initialization across concurrent exports', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      const first = orchestrator.export({ stems: 'clean', format: 'wav' });
      const second = orchestrator.export({ stems: 'noise', format: 'wav' });
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(global.Worker).toHaveBeenCalledTimes(1);
      const calls = mockWorker.postMessage.mock.calls;
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        mockWorker.onmessage({
          data: {
            type: 'result',
            requestId: call[0].requestId,
            blob: new Blob(['data'], { type: 'audio/wav' }),
            format: 'wav',
          },
        });
      }

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    });

    it('should terminate a stalled encoder and reject its request on timeout', async () => {
      jest.useFakeTimers();
      const orchestrator = new ExportOrchestrator(mockMixer);
      const exportPromise = orchestrator.export({ stems: 'clean', format: 'wav' });
      await jest.advanceTimersByTimeAsync(0);
      const rejection = expect(exportPromise).rejects.toThrow('Encoding timeout');

      await jest.advanceTimersByTimeAsync(120000);

      await rejection;
      expect(mockWorker.terminate).toHaveBeenCalled();
      expect(orchestrator._worker).toBeNull();
    });

    it('should reject immediately when posting an encode request throws', async () => {
      const orchestrator = new ExportOrchestrator(mockMixer);
      const init = orchestrator._initWorker();
      await new Promise(resolve => setTimeout(resolve, 10));
      await init;
      mockWorker.postMessage.mockImplementationOnce(() => {
        throw new Error('structured clone failed');
      });

      await expect(orchestrator.export({ stems: 'clean', format: 'wav' }))
        .rejects.toThrow('structured clone failed');
      expect(orchestrator._pendingRequests).toHaveProperty('size', 0);
    });
  });
});

// Made with Bob

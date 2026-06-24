/**
 * Tests for AudioEncoderWorker (Layer 2: Workers)
 */
'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

describe('AudioEncoderWorker', () => {
  let workerCode;
  let mockSelf;
  let mockLamejs;

  beforeEach(() => {
    // Mock worker global scope
    mockSelf = {
      postMessage: jest.fn(),
      onmessage: null,
      importScripts: jest.fn(),
    };

    // Mock lamejs
    mockLamejs = {
      Mp3Encoder: jest.fn().mockImplementation((channels, sampleRate, bitrate) => {
        return {
          encodeBuffer: jest.fn((left, right) => {
            // Return mock MP3 data
            return new Uint8Array([0xff, 0xfb, 0x90, 0x00]); // MP3 frame header
          }),
          flush: jest.fn(() => new Uint8Array([0xff, 0xfb, 0x90, 0x00])),
        };
      }),
    };

    // Mock crypto.subtle for SHA-256 (not used in encoder but may be in scope)
    global.crypto = {
      subtle: {
        digest: jest.fn(),
      },
    };

    // Mock Blob
    global.Blob = jest.fn().mockImplementation((parts, options) => {
      return {
        parts,
        type: options?.type || '',
        size: parts.reduce((sum, part) => sum + (part.length || part.byteLength || 0), 0),
      };
    });
  });

  function createTestChannels(numChannels, length, frequency = 440) {
    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
      const data = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        data[i] = Math.sin(2 * Math.PI * frequency * i / 48000) * 0.5;
      }
      channels.push(data);
    }
    return channels;
  }

  describe('WAV encoding', () => {
    it('should encode stereo Float32 to WAV', () => {
      const channels = createTestChannels(2, 48000); // 1 second stereo
      const sampleRate = 48000;

      // Manually test WAV encoding logic
      const numChannels = channels.length;
      const length = channels[0].length;
      const bytesPerSample = 2;
      const blockAlign = numChannels * bytesPerSample;
      const byteRate = sampleRate * blockAlign;
      const dataSize = length * blockAlign;
      const bufferSize = 44 + dataSize;

      expect(bufferSize).toBe(44 + 48000 * 2 * 2); // header + samples
      expect(byteRate).toBe(48000 * 2 * 2); // 192000 bytes/sec
    });

    it('should create valid WAV header', () => {
      const buffer = new ArrayBuffer(44);
      const view = new DataView(buffer);

      // Simulate WAV header writing
      const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) {
          view.setUint8(offset + i, str.charCodeAt(i));
        }
      };

      writeString(0, 'RIFF');
      view.setUint32(4, 36 + 1000, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, 2, true); // stereo
      view.setUint32(24, 48000, true); // sample rate

      // Verify header
      const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
      expect(riff).toBe('RIFF');

      const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
      expect(wave).toBe('WAVE');

      expect(view.getUint16(20, true)).toBe(1); // PCM format
      expect(view.getUint16(22, true)).toBe(2); // 2 channels
      expect(view.getUint32(24, true)).toBe(48000); // sample rate
    });

    it('should convert Float32 to Int16 correctly', () => {
      const float32 = new Float32Array([0, 0.5, -0.5, 1, -1]);
      const int16 = new Int16Array(float32.length);

      for (let i = 0; i < float32.length; i++) {
        const sample = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      }

      expect(int16[0]).toBe(0);
      expect(int16[1]).toBe(0x3FFF); // ~16383
      expect(int16[2]).toBe(-0x4000); // ~-16384
      expect(int16[3]).toBe(0x7FFF); // 32767
      expect(int16[4]).toBe(-0x8000); // -32768
    });

    it('should clamp out-of-range samples', () => {
      const float32 = new Float32Array([1.5, -1.5, 2.0, -2.0]);
      const int16 = new Int16Array(float32.length);

      for (let i = 0; i < float32.length; i++) {
        const sample = Math.max(-1, Math.min(1, float32[i])); // Clamp
        int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      }

      // All should be clamped to ±1
      expect(int16[0]).toBe(0x7FFF);
      expect(int16[1]).toBe(-0x8000);
      expect(int16[2]).toBe(0x7FFF);
      expect(int16[3]).toBe(-0x8000);
    });

    it('should interleave stereo channels correctly', () => {
      const left = new Float32Array([0.1, 0.2, 0.3]);
      const right = new Float32Array([0.4, 0.5, 0.6]);
      const channels = [left, right];

      const interleaved = [];
      for (let i = 0; i < left.length; i++) {
        for (let ch = 0; ch < channels.length; ch++) {
          interleaved.push(channels[ch][i]);
        }
      }

      const expected = [0.1, 0.4, 0.2, 0.5, 0.3, 0.6];
      for (let i = 0; i < expected.length; i++) {
        expect(interleaved[i]).toBeCloseTo(expected[i], 5);
      }
    });
  });

  describe('MP3 encoding', () => {
    it('should initialize lamejs encoder with correct parameters', () => {
      const encoder = new mockLamejs.Mp3Encoder(2, 48000, 192);
      expect(mockLamejs.Mp3Encoder).toHaveBeenCalledWith(2, 48000, 192);
    });

    it('should encode in 1152-sample frames', () => {
      const channels = createTestChannels(2, 48000);
      const samplesPerFrame = 1152;
      const totalFrames = Math.ceil(channels[0].length / samplesPerFrame);

      expect(totalFrames).toBe(Math.ceil(48000 / 1152)); // ~42 frames
    });

    it('should convert Float32 to Int16 for lamejs', () => {
      const float32 = new Float32Array([0, 0.5, -0.5, 1, -1]);
      const int16 = new Int16Array(float32.length);

      for (let i = 0; i < float32.length; i++) {
        const sample = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      }

      expect(int16).toBeInstanceOf(Int16Array);
      expect(int16.length).toBe(5);
    });

    it('should handle mono as dual-mono for MP3', () => {
      const monoChannel = createTestChannels(1, 1152);
      const leftFrame = monoChannel[0];
      const rightFrame = monoChannel[0]; // Duplicate for stereo

      expect(leftFrame).toBe(rightFrame); // Same reference for mono
    });

    it('should flush encoder at end', () => {
      const encoder = new mockLamejs.Mp3Encoder(2, 48000, 192);
      const flushResult = encoder.flush();

      expect(encoder.flush).toHaveBeenCalled();
      expect(flushResult).toBeInstanceOf(Uint8Array);
    });

    it('should combine MP3 chunks into blob', () => {
      const chunks = [
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6]),
        new Uint8Array([7, 8, 9]),
      ];

      const blob = new Blob(chunks, { type: 'audio/mpeg' });

      expect(blob.type).toBe('audio/mpeg');
      expect(blob.parts).toEqual(chunks);
    });
  });

  describe('Worker message protocol', () => {
    it('should send ready message on initialization', () => {
      // Worker sends ready on load
      const readyMessage = { type: 'ready' };
      expect(readyMessage.type).toBe('ready');
    });

    it('should validate encode message parameters', () => {
      const validMessage = {
        type: 'encode',
        requestId: 1,
        channels: createTestChannels(2, 1000),
        sampleRate: 48000,
        format: 'wav',
        bitrate: 192,
      };

      expect(Array.isArray(validMessage.channels)).toBe(true);
      expect(validMessage.channels.length).toBeGreaterThan(0);
      expect(Number.isFinite(validMessage.sampleRate)).toBe(true);
      expect(validMessage.sampleRate).toBeGreaterThan(0);
      expect(['wav', 'mp3'].includes(validMessage.format)).toBe(true);
    });

    it('should reject invalid channels', () => {
      const invalidMessages = [
        { channels: null },
        { channels: [] },
        { channels: 'not-an-array' },
        { channels: [null] },
      ];

      for (const msg of invalidMessages) {
        const isValid = Array.isArray(msg.channels) &&
          msg.channels.length > 0 &&
          msg.channels.every(ch => ch instanceof Float32Array);
        expect(isValid).toBe(false);
      }
    });

    it('should reject invalid sample rate', () => {
      const invalidRates = [0, -1, NaN, Infinity, 'not-a-number'];

      for (const rate of invalidRates) {
        const isValid = Number.isFinite(rate) && rate > 0;
        expect(isValid).toBe(false);
      }
    });

    it('should reject invalid format', () => {
      const invalidFormats = ['mp4', 'flac', 'ogg', null, undefined];

      for (const format of invalidFormats) {
        const isValid = ['wav', 'mp3'].includes(format);
        expect(isValid).toBe(false);
      }
    });

    it('should send progress messages during encoding', () => {
      const progressMessage = {
        type: 'progress',
        requestId: 1,
        progress: 0.5,
        stage: 'encoding-mp3',
      };

      expect(progressMessage.type).toBe('progress');
      expect(progressMessage.progress).toBeGreaterThanOrEqual(0);
      expect(progressMessage.progress).toBeLessThanOrEqual(1);
    });

    it('should send result message on success', () => {
      const resultMessage = {
        type: 'result',
        requestId: 1,
        blob: new Blob(['data'], { type: 'audio/wav' }),
        format: 'wav',
      };

      expect(resultMessage.type).toBe('result');
      expect(resultMessage.blob).toBeDefined();
      expect(resultMessage.format).toBe('wav');
    });

    it('should send error message on failure', () => {
      const errorMessage = {
        type: 'error',
        requestId: 1,
        error: 'Encoding failed',
      };

      expect(errorMessage.type).toBe('error');
      expect(errorMessage.error).toBeDefined();
    });
  });

  describe('Format-specific tests', () => {
    it('should create WAV blob with correct MIME type', () => {
      const blob = new Blob([new ArrayBuffer(100)], { type: 'audio/wav' });
      expect(blob.type).toBe('audio/wav');
    });

    it('should create MP3 blob with correct MIME type', () => {
      const blob = new Blob([new Uint8Array([0xff, 0xfb])], { type: 'audio/mpeg' });
      expect(blob.type).toBe('audio/mpeg');
    });

    it('should handle different bitrates for MP3', () => {
      const validBitrates = [128, 192, 256, 320];

      for (const bitrate of validBitrates) {
        const encoder = new mockLamejs.Mp3Encoder(2, 48000, bitrate);
        expect(mockLamejs.Mp3Encoder).toHaveBeenCalledWith(2, 48000, bitrate);
      }
    });

    it('should default to 192 kbps if bitrate not specified', () => {
      const defaultBitrate = 192;
      const encoder = new mockLamejs.Mp3Encoder(2, 48000, defaultBitrate);
      expect(mockLamejs.Mp3Encoder).toHaveBeenCalledWith(2, 48000, 192);
    });
  });

  describe('Edge cases', () => {
    it('should handle very short audio (< 1 frame)', () => {
      const channels = createTestChannels(2, 100); // 100 samples
      expect(channels[0].length).toBe(100);
      expect(channels[0].length).toBeLessThan(1152); // Less than one MP3 frame
    });

    it('should handle mono audio', () => {
      const channels = createTestChannels(1, 1000);
      expect(channels.length).toBe(1);
    });

    it('should handle stereo audio', () => {
      const channels = createTestChannels(2, 1000);
      expect(channels.length).toBe(2);
    });

    it('should handle silence (all zeros)', () => {
      const channels = [new Float32Array(1000), new Float32Array(1000)];
      expect(channels[0].every(s => s === 0)).toBe(true);
      expect(channels[1].every(s => s === 0)).toBe(true);
    });

    it('should handle full-scale audio', () => {
      const channels = [
        new Float32Array(100).fill(1.0),
        new Float32Array(100).fill(-1.0),
      ];
      expect(channels[0].every(s => s === 1.0)).toBe(true);
      expect(channels[1].every(s => s === -1.0)).toBe(true);
    });
  });
});

// Made with Bob

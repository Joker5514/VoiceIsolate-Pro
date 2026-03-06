import { describe, it, expect } from 'vitest';
import { AudioEncoders } from './encoders.js';

describe('AudioEncoders', () => {
  describe('encodeWav', () => {
    // Error paths
    it('throws an error if channelData is missing or empty', () => {
      expect(() => AudioEncoders.encodeWav(null, 44100)).toThrow('encodeWav: channelData must be a non-empty array of Float32Arrays');
      expect(() => AudioEncoders.encodeWav([], 44100)).toThrow('encodeWav: channelData must be a non-empty array of Float32Arrays');
    });

    it('throws an error if bitDepth is not 16 or 24', () => {
      const validData = [new Float32Array([0.1, -0.1])];
      expect(() => AudioEncoders.encodeWav(validData, 44100, 8)).toThrow('encodeWav: bitDepth must be 16 or 24');
      expect(() => AudioEncoders.encodeWav(validData, 44100, 32)).toThrow('encodeWav: bitDepth must be 16 or 24');
    });

    // Happy paths
    it('encodes 16-bit WAV data without throwing', () => {
      const validData = [new Float32Array([0.1, -0.1, 0.5])];
      const result = AudioEncoders.encodeWav(validData, 44100, 16);
      expect(result).toBeInstanceOf(ArrayBuffer);
      // Optional: Check if header has correct size/length
      expect(result.byteLength).toBeGreaterThan(44); // 44 bytes header + data
    });

    it('encodes 24-bit WAV data without throwing', () => {
      const validData = [new Float32Array([0.1, -0.1, 0.5])];
      const result = AudioEncoders.encodeWav(validData, 44100, 24);
      expect(result).toBeInstanceOf(ArrayBuffer);
      // Optional: Check if header has correct size/length
      expect(result.byteLength).toBeGreaterThan(44); // 44 bytes header + data
    });
  });
});

/**
 * VoiceIsolate Pro — estVoices Unit Tests
 * Tests voice activity estimation logic based on signal energy (RMS).
 */

const fs = require('fs');
const path = require('path');
const getAppCode = require('./helpers/get-app-code');

// Dynamically load the app.js source (with slider-map.js imports resolved)
// to bypass Jest's ES module strictness since app.js conditionally exports
// via CommonJS.
const appJsCode = getAppCode();

// Provide mocked module and browser globals to capture the export and prevent ReferenceErrors
const mockModule = { exports: {} };
const fn = new Function('module', 'window', 'document', appJsCode + '\nreturn module.exports;');
const VoiceIsolatePro = fn(mockModule, {}, { addEventListener: () => {} });

describe('estVoices', () => {
  const estVoices = VoiceIsolatePro.prototype.estVoices;

  // Minimal MockAudioBuffer matching the expected interface
  class MockAudioBuffer {
    constructor(sampleRate, dataArray) {
      this.sampleRate = sampleRate;
      this._data = new Float32Array(dataArray);
      this.length = this._data.length;
    }
    getChannelData(channel) {
      if (channel !== 0) throw new Error('Only channel 0 is supported in this mock');
      return this._data;
    }
  }

  /**
   * Helper to create an audio buffer with specific active (r > 0.01) blocks.
   * `sampleRate` is default 44100.
   * Block size `bs` is Math.floor(sampleRate * 0.5) (i.e. 22050 at 44100Hz).
   * For an active block, RMS must be > 0.01.
   * RMS = sqrt(sum(x^2)/N). So if x = 0.02 everywhere, RMS = 0.02 > 0.01.
   * If x = 0 everywhere, RMS = 0 < 0.01.
   */
  function createBufferWithActiveBlocks(numActiveBlocks, totalBlocks = numActiveBlocks, sampleRate = 44100) {
    const bs = Math.floor(sampleRate * 0.5);
    const data = new Float32Array(totalBlocks * bs);

    for (let i = 0; i < totalBlocks; i++) {
      const isActive = i < numActiveBlocks;
      const value = isActive ? 0.02 : 0; // 0.02 > 0.01 (threshold)
      for (let j = 0; j < bs; j++) {
        data[i * bs + j] = value;
      }
    }
    return new MockAudioBuffer(sampleRate, data);
  }

  test('should return "0-1" when active blocks < 3', () => {
    // 0 active blocks
    const buf0 = createBufferWithActiveBlocks(0, 5);
    expect(estVoices(buf0)).toBe('0-1');

    // 1 active block
    const buf1 = createBufferWithActiveBlocks(1, 5);
    expect(estVoices(buf1)).toBe('0-1');

    // 2 active blocks
    const buf2 = createBufferWithActiveBlocks(2, 5);
    expect(estVoices(buf2)).toBe('0-1');
  });

  test('should return "1" when 3 <= active blocks < 10', () => {
    // 3 active blocks
    const buf3 = createBufferWithActiveBlocks(3, 10);
    expect(estVoices(buf3)).toBe('1');

    // 5 active blocks
    const buf5 = createBufferWithActiveBlocks(5, 10);
    expect(estVoices(buf5)).toBe('1');

    // 9 active blocks
    const buf9 = createBufferWithActiveBlocks(9, 10);
    expect(estVoices(buf9)).toBe('1');
  });

  test('should return "1-2+" when active blocks >= 10', () => {
    // 10 active blocks
    const buf10 = createBufferWithActiveBlocks(10, 15);
    expect(estVoices(buf10)).toBe('1-2+');

    // 20 active blocks
    const buf20 = createBufferWithActiveBlocks(20, 20);
    expect(estVoices(buf20)).toBe('1-2+');
  });

  test('should handle completely silent buffer (all 0s)', () => {
    const sampleRate = 48000;
    const bs = Math.floor(sampleRate * 0.5);
    const data = new Float32Array(bs * 5); // 5 blocks of silence
    const buf = new MockAudioBuffer(sampleRate, data);
    expect(estVoices(buf)).toBe('0-1');
  });

  test('should handle noisy buffer with low energy (r <= 0.01)', () => {
    const sampleRate = 44100;
    const bs = Math.floor(sampleRate * 0.5);
    const data = new Float32Array(bs * 15);
    // Fill with values such that RMS <= 0.01
    // e.g., constant 0.009
    for(let i = 0; i < data.length; i++) {
      data[i] = 0.009;
    }
    const buf = new MockAudioBuffer(sampleRate, data);
    expect(estVoices(buf)).toBe('0-1'); // even though 15 blocks, none are active
  });

  test('should handle varying sample rates correctly', () => {
    // Sample rate 16000 -> block size = 8000
    const sampleRate = 16000;
    const buf = createBufferWithActiveBlocks(4, 4, sampleRate);
    expect(estVoices(buf)).toBe('1'); // 4 active blocks -> '1'
  });

  test('should handle incomplete blocks at the end', () => {
    const sampleRate = 44100;
    const bs = Math.floor(sampleRate * 0.5); // 22050
    // Total length = 3.5 blocks = 22050 * 3 + 10000 = 76150
    const data = new Float32Array(76150);

    // Fill first 3 blocks with active values
    for(let i = 0; i < bs * 3; i++) {
      data[i] = 0.02;
    }
    // Fill the last incomplete block (10000 samples) with active values
    for(let i = bs * 3; i < data.length; i++) {
      data[i] = 0.02;
    }

    const buf = new MockAudioBuffer(sampleRate, data);
    expect(estVoices(buf)).toBe('1'); // 3 full + 1 incomplete = 4 active blocks -> '1'
  });
});

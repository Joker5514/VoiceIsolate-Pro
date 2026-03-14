/**
 * VoiceIsolate Pro — Utility Unit Tests
 * Tests calcRMS, calcPeak, and fmtDur.
 */

const fs = require('fs');
const path = require('path');

// Read the app.js code as a string to extract the real implementation.
// This guarantees we are testing the actual code without dealing with
// Jest ESM/CJS module loading conflicts for a browser script.
const appJsPath = path.resolve(__dirname, '../app.js');
const appJsCode = fs.readFileSync(appJsPath, 'utf8');

// Use new Function to create the class from the source string.
// We pass in an empty module object to simulate the environment.
const extractVoiceIsolatePro = new Function(`
  const module = { exports: {} };
  const window = {};
  const document = { addEventListener: () => {} };
  ${appJsCode}
  return module.exports;
`);

const VoiceIsolatePro = extractVoiceIsolatePro();

describe('Utility Functions from app.js', () => {
  describe('calcRMS', () => {
    let calcRMS;
    beforeAll(() => {
      calcRMS = VoiceIsolatePro.prototype.calcRMS;
    });

    test('all 1s should be 0 dB', () => {
      const d = new Float32Array([1, 1, 1, 1]);
      expect(calcRMS(d)).toBeCloseTo(0, 5);
    });

    test('silence (all 0s) should be -96 dB', () => {
      const d = new Float32Array([0, 0, 0, 0]);
      expect(calcRMS(d)).toBe(-96);
    });

    test('known value: 0.5 should be ~ -6.02 dB', () => {
      const d = new Float32Array([0.5, 0.5, 0.5, 0.5]);
      expect(calcRMS(d)).toBeCloseTo(20 * Math.log10(0.5), 5);
    });

    test('mixed values', () => {
      const d = new Float32Array([1, 0, -1, 0]);
      // RMS = sqrt((1^2 + 0^2 + (-1)^2 + 0^2) / 4) = sqrt(2/4) = sqrt(0.5)
      expect(calcRMS(d)).toBeCloseTo(20 * Math.log10(Math.sqrt(0.5)), 5);
    });
  });

  describe('calcPeak', () => {
    let calcPeak;
    beforeAll(() => {
      calcPeak = VoiceIsolatePro.prototype.calcPeak;
    });

    test('all 0s should be -96 dB', () => {
      const d = new Float32Array([0, 0, 0, 0]);
      expect(calcPeak(d)).toBe(-96);
    });

    test('constant 1s should be 0 dB', () => {
      const d = new Float32Array([1, 1, 1, 1]);
      expect(calcPeak(d)).toBeCloseTo(0, 5);
    });

    test('mixed positive and negative values', () => {
      const d = new Float32Array([0.2, -0.9, 0.4]);
      expect(calcPeak(d)).toBeCloseTo(20 * Math.log10(0.9), 5);
    });

    test('single peak at different positions', () => {
      expect(calcPeak(new Float32Array([0.5, 0, 0]))).toBeCloseTo(20 * Math.log10(0.5), 5);
      expect(calcPeak(new Float32Array([0, 0.5, 0]))).toBeCloseTo(20 * Math.log10(0.5), 5);
      expect(calcPeak(new Float32Array([0, 0, 0.5]))).toBeCloseTo(20 * Math.log10(0.5), 5);
    });
  });

  describe('fmtDur', () => {
    let fmtDur;
    beforeAll(() => {
      fmtDur = VoiceIsolatePro.prototype.fmtDur;
    });

    test('0 seconds -> 0:00', () => {
      expect(fmtDur(0)).toBe('0:00');
    });

    test('59 seconds -> 0:59', () => {
      expect(fmtDur(59)).toBe('0:59');
    });

    test('60 seconds -> 1:00', () => {
      expect(fmtDur(60)).toBe('1:00');
    });

    test('119 seconds -> 1:59', () => {
      expect(fmtDur(119)).toBe('1:59');
    });

    test('3601 seconds -> 60:01', () => {
      expect(fmtDur(3601)).toBe('60:01');
    });
  });
});

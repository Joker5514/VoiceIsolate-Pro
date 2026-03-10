/**
 * VoiceIsolate Pro — Utility Unit Tests
 * Tests calcRMS, calcPeak, and fmtDur.
 * 
 * NOTE: These functions are duplicated as standalone implementations because
 * the main app.js contains browser-only DOM code that cannot be imported in Node.
 * 
 * IMPORTANT: If the implementations in public/app/app.js change, these standalone
 * functions must be manually updated to match. The original implementations are in:
 * - calcRMS: public/app/app.js (search for 'calcRMS(d)')
 * - calcPeak: public/app/app.js (search for 'calcPeak(d)')
 * - fmtDur: public/app/app.js (search for 'fmtDur(s)')
 */

describe('Utility Functions from app.js', () => {
  // Standalone implementations matching public/app/app.js methods
  function calcRMS(d) {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    const r = Math.sqrt(s / d.length);
    return r > 0 ? 20 * Math.log10(r) : -96;
  }

  function calcPeak(d) {
    let p = 0;
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > p) p = a;
    }
    return p > 0 ? 20 * Math.log10(p) : -96;
  }

  function fmtDur(s) {
    const m = Math.floor(s / 60);
    const sc = Math.floor(s % 60);
    return m + ':' + String(sc).padStart(2, '0');
  }

  function estVoices(buf) {
    const d = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const bs = Math.floor(sr * 0.5);
    let act = 0;
    for (let i = 0; i < d.length; i += bs) {
      let r = 0;
      const e = Math.min(i + bs, d.length);
      for (let j = i; j < e; j++) r += d[j] * d[j];
      r = Math.sqrt(r / (e - i));
      if (r > 0.01) act++;
    }
    return act < 3 ? '0-1' : act < 10 ? '1' : '1-2+';
  }

  describe('calcRMS', () => {
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

  describe('estVoices', () => {
    // Helper to create a mock AudioBuffer-like object
    function createMockBuffer(sr, data) {
      return {
        sampleRate: sr,
        getChannelData: () => data
      };
    }

    test('all zeros (silence) -> 0-1', () => {
      const sr = 44100;
      const data = new Float32Array(sr * 2); // 2 seconds of silence
      const buf = createMockBuffer(sr, data);
      expect(estVoices(buf)).toBe('0-1');
    });

    test('short burst of noise (< 3 active chunks) -> 0-1', () => {
      const sr = 44100;
      const data = new Float32Array(sr * 2); // 2 seconds total, 4 chunks of 0.5s
      // Make 2 chunks active
      for (let i = 0; i < sr * 1; i++) {
        data[i] = 0.5; // High RMS
      }
      const buf = createMockBuffer(sr, data);
      expect(estVoices(buf)).toBe('0-1');
    });

    test('sustained noise (3 <= active chunks < 10) -> 1', () => {
      const sr = 44100;
      const data = new Float32Array(sr * 5); // 5 seconds total, 10 chunks
      // Make 5 chunks active (2.5 seconds)
      for (let i = 0; i < sr * 2.5; i++) {
        data[i] = 0.5; // High RMS
      }
      const buf = createMockBuffer(sr, data);
      expect(estVoices(buf)).toBe('1');
    });

    test('continuous noise (>= 10 active chunks) -> 1-2+', () => {
      const sr = 44100;
      const data = new Float32Array(sr * 6); // 6 seconds total, 12 chunks
      // Make 11 chunks active (5.5 seconds)
      for (let i = 0; i < sr * 5.5; i++) {
        data[i] = 0.5; // High RMS
      }
      const buf = createMockBuffer(sr, data);
      expect(estVoices(buf)).toBe('1-2+');
    });
  });
});

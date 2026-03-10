/**
 * VoiceIsolate Pro — Utility Unit Tests
 * Tests calcRMS, calcPeak, fmtDur, and estVoices.
 * 
 * NOTE: These functions are duplicated as standalone implementations because
 * the main app.js contains browser-only DOM code that cannot be imported in Node.
 * 
 * IMPORTANT: If the implementations in public/app/app.js change, these standalone
 * functions must be manually updated to match. The original implementations are in:
 * - calcRMS: public/app/app.js (search for 'calcRMS(d)')
 * - calcPeak: public/app/app.js (search for 'calcPeak(d)')
 * - fmtDur: public/app/app.js (search for 'fmtDur(s)')
 * - estVoices: public/app/app.js (search for 'estVoices(buf)')
 */

describe('Utility Functions from app.js', () => {
  // Standalone implementations matching public/app/app.js methods
  function estVoices(buf){const d=buf.getChannelData(0);const sr=buf.sampleRate;const bs=Math.floor(sr*0.5);let act=0;for(let i=0;i<d.length;i+=bs){let r=0;const e=Math.min(i+bs,d.length);for(let j=i;j<e;j++)r+=d[j]*d[j];r=Math.sqrt(r/(e-i));if(r>0.01)act++;}return act<3?'0-1':act<10?'1':'1-2+';}

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
    test('Empty buffer or completely silent -> 0 active blocks -> returns "0-1"', () => {
      const buf = {
        sampleRate: 44100,
        getChannelData: () => new Float32Array(44100 * 2) // 2 seconds of silence
      };
      expect(estVoices(buf)).toBe('0-1');
    });

    test('2 active blocks -> act = 2, returns "0-1"', () => {
      const buf = {
        sampleRate: 44100,
        getChannelData: () => {
          const d = new Float32Array(44100 * 2); // 4 blocks of 0.5s
          // Block 1 (active)
          for (let i = 0; i < 22050; i++) d[i] = 1.0;
          // Block 2 (active)
          for (let i = 22050; i < 44100; i++) d[i] = 1.0;
          return d;
        }
      };
      expect(estVoices(buf)).toBe('0-1');
    });

    test('5 active blocks -> act = 5, returns "1"', () => {
      const buf = {
        sampleRate: 44100,
        getChannelData: () => {
          const d = new Float32Array(44100 * 5); // 10 blocks
          // 5 blocks active
          for (let i = 0; i < 5 * 22050; i++) d[i] = 1.0;
          return d;
        }
      };
      expect(estVoices(buf)).toBe('1');
    });

    test('12 active blocks -> act = 12, returns "1-2+"', () => {
      const buf = {
        sampleRate: 44100,
        getChannelData: () => {
          const d = new Float32Array(44100 * 10); // 20 blocks
          // 12 blocks active
          for (let i = 0; i < 12 * 22050; i++) d[i] = 1.0;
          return d;
        }
      };
      expect(estVoices(buf)).toBe('1-2+');
    });

    test('Block size is correctly half the sample rate', () => {
      // If sampleRate is 100, block size should be 50.
      const buf = {
        sampleRate: 100,
        getChannelData: () => {
          const d = new Float32Array(500); // 10 blocks
          // Let's make block 1 active
          for (let i = 0; i < 50; i++) d[i] = 1.0;
          // Let's make block 2 silent
          // Let's make block 3 active
          for (let i = 100; i < 150; i++) d[i] = 1.0;
          // Let's make block 4 silent
          // Let's make block 5 active
          for (let i = 200; i < 250; i++) d[i] = 1.0;
          return d;
        }
      };
      // 3 active blocks, so return should be '1' since act < 10 but not < 3
      expect(estVoices(buf)).toBe('1');
    });
  });
});

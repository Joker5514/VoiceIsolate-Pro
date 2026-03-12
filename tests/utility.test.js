/**
 * VoiceIsolate Pro — Utility Unit Tests
 * Tests calcRMS, calcPeak, fmtDur, and encWav.
 * 
 * NOTE: These functions are duplicated as standalone implementations because
 * the main app.js contains browser-only DOM code that cannot be imported in Node.
 * 
 * IMPORTANT: If the implementations in public/app/app.js change, these standalone
 * functions must be manually updated to match. The original implementations are in:
 * - calcRMS: public/app/app.js (search for 'calcRMS(d)')
 * - calcPeak: public/app/app.js (search for 'calcPeak(d)')
 * - fmtDur: public/app/app.js (search for 'fmtDur(s)')
 * - encWav: public/app/app.js (search for 'encWav(buf)')
 */

describe('Utility Functions from app.js', () => {
  // Standalone implementations matching public/app/app.js methods
  function encWav(buf) {
    const nCh = buf.numberOfChannels;
    const sr = buf.sampleRate;
    const dL = buf.length * nCh * 2;
    const a = new ArrayBuffer(44 + dL);
    const v = new DataView(a);
    const ws = (o, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    ws(0, 'RIFF');
    v.setUint32(4, 36 + dL, true);
    ws(8, 'WAVE');
    ws(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, nCh, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * nCh * 2, true);
    v.setUint16(32, nCh * 2, true);
    v.setUint16(34, 16, true);
    ws(36, 'data');
    v.setUint32(40, dL, true);
    let off = 44;
    for (let i = 0; i < buf.length; i++) {
      for (let ch = 0; ch < nCh; ch++) {
        let s = buf.getChannelData(ch)[i];
        s = Math.max(-1, Math.min(1, s));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    }
    return a;
  }

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

    test('empty array should return -96 dB', () => {
      expect(calcPeak(new Float32Array([]))).toBe(-96);
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
    // Helper to create a mock AudioBuffer
    function makeMockBuffer(sr, numActiveBlocks, numSilentBlocks) {
      const bs = Math.floor(sr * 0.5);
      const totalLen = (numActiveBlocks + numSilentBlocks) * bs;
      const d = new Float32Array(totalLen);

      // Fill active blocks with an RMS > 0.01 (e.g. constant 0.02)
      for (let i = 0; i < numActiveBlocks * bs; i++) {
        d[i] = 0.02;
      }
      // The rest is 0 (silence)

      return {
        sampleRate: sr,
        getChannelData: () => d
      };
    }

    test('0 active blocks should return "0-1"', () => {
      const buf = makeMockBuffer(44100, 0, 5);
      expect(estVoices(buf)).toBe('0-1');
    });

    test('2 active blocks should return "0-1"', () => {
      const buf = makeMockBuffer(44100, 2, 5);
      expect(estVoices(buf)).toBe('0-1');
    });

    test('3 active blocks should return "1"', () => {
      const buf = makeMockBuffer(44100, 3, 5);
      expect(estVoices(buf)).toBe('1');
    });

    test('9 active blocks should return "1"', () => {
      const buf = makeMockBuffer(44100, 9, 2);
      expect(estVoices(buf)).toBe('1');
    });

    test('10 active blocks should return "1-2+"', () => {
      const buf = makeMockBuffer(44100, 10, 0);
      expect(estVoices(buf)).toBe('1-2+');
    });

    test('15 active blocks should return "1-2+"', () => {
      const buf = makeMockBuffer(44100, 15, 0);
      expect(estVoices(buf)).toBe('1-2+');
    });

    test('handles empty buffer gracefully (0 blocks)', () => {
      const buf = makeMockBuffer(44100, 0, 0);
      expect(estVoices(buf)).toBe('0-1');
  describe('encWav', () => {
    // Helper to create a mock AudioBuffer
    function createMockBuffer(nCh, len, sr, fillValueOrFn) {
      const channels = [];
      for (let ch = 0; ch < nCh; ch++) {
        const d = new Float32Array(len);
        if (typeof fillValueOrFn === 'function') {
          for (let i = 0; i < len; i++) d[i] = fillValueOrFn(ch, i);
        } else if (fillValueOrFn !== undefined) {
          d.fill(fillValueOrFn);
        }
        channels.push(d);
      }
      return {
        numberOfChannels: nCh,
        length: len,
        sampleRate: sr,
        getChannelData: (ch) => channels[ch]
      };
    }

    test('should return an ArrayBuffer with the correct length', () => {
      const buf = createMockBuffer(2, 100, 44100, 0); // 2 channels, 100 samples
      const out = encWav(buf);

      expect(out).toBeInstanceOf(ArrayBuffer);

      // Header is 44 bytes.
      // Data is: 100 samples * 2 channels * 2 bytes/sample = 400 bytes.
      // Total = 444
      expect(out.byteLength).toBe(444);
    });

    test('should write correct WAV header fields', () => {
      const sr = 48000;
      const nCh = 1;
      const len = 50; // 50 samples * 1 ch * 2 bytes = 100 bytes of data
      const buf = createMockBuffer(nCh, len, sr, 0);
      const out = encWav(buf);

      const v = new DataView(out);
      const rs = (o, s) => {
        let str = '';
        for (let i = 0; i < s; i++) str += String.fromCharCode(v.getUint8(o + i));
        return str;
      };

      expect(rs(0, 4)).toBe('RIFF');
      expect(v.getUint32(4, true)).toBe(36 + len * nCh * 2); // File size - 8
      expect(rs(8, 4)).toBe('WAVE');
      expect(rs(12, 4)).toBe('fmt ');
      expect(v.getUint32(16, true)).toBe(16); // format chunk size
      expect(v.getUint16(20, true)).toBe(1); // audio format (PCM)
      expect(v.getUint16(22, true)).toBe(nCh); // num channels
      expect(v.getUint32(24, true)).toBe(sr); // sample rate
      expect(v.getUint32(28, true)).toBe(sr * nCh * 2); // byte rate
      expect(v.getUint16(32, true)).toBe(nCh * 2); // block align
      expect(v.getUint16(34, true)).toBe(16); // bits per sample
      expect(rs(36, 4)).toBe('data');
      expect(v.getUint32(40, true)).toBe(len * nCh * 2); // data chunk size
    });

    test('should correctly encode float PCM data to 16-bit integers and clamp values', () => {
      const nCh = 2;
      const len = 4;
      const sr = 44100;
      // Provide specific test values including clamping bounds
      const buf = createMockBuffer(nCh, len, sr, (ch, i) => {
        if (ch === 0) {
          // Channel 0: [0, 1.0, -1.0, 1.5]
          if (i === 0) return 0;
          if (i === 1) return 1.0;
          if (i === 2) return -1.0;
          if (i === 3) return 1.5; // Should clamp to 1.0
        } else {
          // Channel 1: [0.5, -0.5, -1.5, 0]
          if (i === 0) return 0.5;
          if (i === 1) return -0.5;
          if (i === 2) return -1.5; // Should clamp to -1.0
          if (i === 3) return 0;
        }
      });

      const out = encWav(buf);
      const v = new DataView(out);

      let off = 44;

      // Frame 0
      // ch 0: 0 -> 0
      expect(v.getInt16(off, true)).toBe(0); off += 2;
      // ch 1: 0.5 -> 0.5 * 32767 = 16383
      expect(v.getInt16(off, true)).toBeCloseTo(16383, -1); off += 2;

      // Frame 1
      // ch 0: 1.0 -> 32767
      expect(v.getInt16(off, true)).toBe(32767); off += 2;
      // ch 1: -0.5 -> -0.5 * 32768 = -16384
      expect(v.getInt16(off, true)).toBe(-16384); off += 2;

      // Frame 2
      // ch 0: -1.0 -> -32768
      expect(v.getInt16(off, true)).toBe(-32768); off += 2;
      // ch 1: -1.5 (clamped to -1.0) -> -32768
      expect(v.getInt16(off, true)).toBe(-32768); off += 2;

      // Frame 3
      // ch 0: 1.5 (clamped to 1.0) -> 32767
      expect(v.getInt16(off, true)).toBe(32767); off += 2;
      // ch 1: 0 -> 0
      expect(v.getInt16(off, true)).toBe(0); off += 2;
    });
  });
});

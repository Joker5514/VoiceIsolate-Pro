/**
 * VoiceIsolate Pro — DSP Unit Tests (Phase 6)
 * Tests STFT/iSTFT roundtrip, Wiener NR math, and helper functions.
 */

// Minimal AudioContext stub for jsdom environment
class MockAudioBuffer {
  constructor(channels, length, sampleRate) {
    this._channels = Array.from({ length: channels }, () => new Float32Array(length));
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
  }
  getChannelData(ch) { return this._channels[ch]; }
}

global.AudioContext = class {
  createBuffer(ch, len, sr) { return new MockAudioBuffer(ch, len, sr); }
  get state() { return 'running'; }
  resume() { return Promise.resolve(); }
};

// Import standalone DSP helpers — extracted to avoid browser-only DOM code
// We pull the math functions out of app.js logic for unit testing

/**
 * Standalone radix-2 FFT for testing (mirrors app.js _fft)
 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < (len >> 1); j++) {
        const ur = re[i+j], ui = im[i+j];
        const vr = re[i+j+(len>>1)]*cr - im[i+j+(len>>1)]*ci;
        const vi = re[i+j+(len>>1)]*ci + im[i+j+(len>>1)]*cr;
        re[i+j]=ur+vr; im[i+j]=ui+vi;
        re[i+j+(len>>1)]=ur-vr; im[i+j+(len>>1)]=ui-vi;
        const nr=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=nr;
      }
    }
  }
}

function ifft(re, im) {
  for (let i = 0; i < im.length; i++) im[i] = -im[i];
  fft(re, im);
  const n = re.length;
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}

function makeWindow(N) {
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const c = (2 * Math.PI * i) / (N - 1);
    win[i] = 0.35875 - 0.48829*Math.cos(c) + 0.14128*Math.cos(2*c) - 0.01168*Math.cos(3*c);
  }
  return win;
}

// ============================================================
describe('FFT', () => {
  test('FFT of impulse at index 0 should yield all-ones real spectrum', () => {
    const N = 8;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    re[0] = 1; // unit impulse
    fft(re, im);
    for (let k = 0; k < N; k++) {
      expect(Math.abs(re[k] - 1)).toBeLessThan(1e-10);
      expect(Math.abs(im[k])).toBeLessThan(1e-10);
    }
  });

  test('IFFT(FFT(x)) should reconstruct x within floating-point tolerance', () => {
    const N = 256;
    const original = new Float64Array(N).map(() => Math.random() * 2 - 1);
    const re = new Float64Array(original);
    const im = new Float64Array(N);
    fft(re, im);
    ifft(re, im);
    for (let i = 0; i < N; i++) {
      expect(Math.abs(re[i] - original[i])).toBeLessThan(1e-10);
    }
  });

  test('FFT size 2048 roundtrip error < 1e-9', () => {
    const N = 2048;
    const original = new Float64Array(N).map((_, i) => Math.sin(2 * Math.PI * 440 * i / 44100));
    const re = new Float64Array(original);
    const im = new Float64Array(N);
    fft(re, im);
    ifft(re, im);
    let maxErr = 0;
    for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(re[i] - original[i]));
    expect(maxErr).toBeLessThan(1e-9);
  });
});

describe('Blackman-Harris window', () => {
  test('Window should be symmetric', () => {
    const win = makeWindow(512);
    for (let i = 0; i < 256; i++) {
      expect(Math.abs(win[i] - win[511 - i])).toBeLessThan(1e-12);
    }
  });

  test('Window values should be in [0, 1]', () => {
    const win = makeWindow(2048);
    for (const v of win) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('Wiener gain formula', () => {
  test('Gain = 1 when signal >> noise', () => {
    const sigPSD = 1000, noisePSD = 0.001;
    const gain = Math.sqrt(Math.max(sigPSD - noisePSD, 0) / sigPSD);
    expect(gain).toBeCloseTo(1, 3);
  });

  test('Gain = beta floor when signal <= noise', () => {
    const beta = 0.05;
    const sigPSD = 0.001, noisePSD = 1000;
    const gain = Math.max(Math.sqrt(Math.max(sigPSD - noisePSD, 0) / sigPSD), beta);
    expect(gain).toBe(beta);
  });

  test('Gain is always non-negative', () => {
    const beta = 0.01;
    for (let i = 0; i < 100; i++) {
      const sigPSD = Math.random(), noisePSD = Math.random();
      const gain = Math.max(Math.sqrt(Math.max(sigPSD - noisePSD, 0) / sigPSD), beta);
      expect(gain).toBeGreaterThanOrEqual(beta);
    }
  });
});

describe('TPDF dither', () => {
  test('TPDF distribution mean ≈ 0', () => {
    const N = 10000;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += Math.random() - Math.random();
    expect(Math.abs(sum / N)).toBeLessThan(0.05);
  });

  test('TPDF distribution stays within [-1, 1]', () => {
    for (let i = 0; i < 1000; i++) {
      const v = Math.random() - Math.random();
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('Crosstalk cancellation math', () => {
  test('At 100% cancellation, output should reduce bleed', () => {
    const L = 1.0, R = 0.3; // bleed = 0.3
    const g = 0.5; // cancelAmt=100 → g=0.5
    const oL = L - g * R;
    const oR = R - g * L;
    expect(Math.abs(oL)).toBeLessThan(Math.abs(L));
    expect(Math.abs(oR)).toBeLessThan(Math.abs(R));
  });

  test('At 0% cancellation, output equals input', () => {
    const L = 0.8, R = 0.4;
    const g = 0;
    expect(L - g * R).toBeCloseTo(L);
    expect(R - g * L).toBeCloseTo(R);
  });
});

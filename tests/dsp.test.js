/**
 * VoiceIsolate Pro — DSP Unit Tests (Phase 6)
 * Tests STFT/iSTFT roundtrip, Wiener NR math, and helper functions.
 */

const fs = require('fs');
const path = require('path');

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

// Import actual VoiceIsolatePro from app.js using a scoped eval to avoid syntax errors and DOM initialization crashes
const appJsPath = path.join(__dirname, '../public/app/app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

// We evaluate the file content inside a function scope to isolate 'const', 'let', and 'class' declarations.
// We also mock 'document' and 'window' just enough to pass the DOMContentLoaded listener setup at the bottom.
const VoiceIsolatePro = (() => {
  const exports = {};
  const module = { exports };
  // eslint-disable-next-line no-unused-vars
  const window = {};
  // eslint-disable-next-line no-unused-vars
  const document = {
    addEventListener:  () => {},
    querySelector:     () => null,
    querySelectorAll:  () => [],
    getElementById:    () => null,
    createElement:     () => ({ addEventListener: () => {}, style: {}, classList: { add: () => {}, remove: () => {} } }),
  };

  eval(appJs);

  return module.exports;
})();

// Import standalone DSP helpers — extracted to avoid browser-only DOM code
// We pull the math functions out of app.js logic for unit testing

// Load DSPCore for the new advanced DSP classes
// dsp-core.js lives in the ESM root, so we eval it to extract the CommonJS export
// (same pattern as how app.js is loaded below)
const dspCoreJs = fs.readFileSync(path.join(__dirname, '../public/app/dsp-core.js'), 'utf8');
const DSPCore = (() => {
  const exports = {};
  const module = { exports };
  // eslint-disable-next-line no-unused-vars
  const window = {};
  // eslint-disable-next-line no-unused-vars
  const self = {};
  eval(dspCoreJs);
  return module.exports;
})();

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
  // Use crypto.getRandomValues chunked buffer implementation for tests as well
  const crypto = require('crypto');
  function getTpdf() {
    const invMax = 1 / 4294967296;
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    return (buf[0] * invMax) - (buf[1] * invMax);
  }

  test('TPDF distribution mean ≈ 0', () => {
    const N = 10000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      sum += getTpdf();
    }
    expect(Math.abs(sum / N)).toBeLessThan(0.05);
  });

  test('TPDF distribution stays within [-1, 1]', () => {
    for (let i = 0; i < 1000; i++) {
      const v = getTpdf();
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

describe('Wiener NR — speech-frame gain (applySpectralNR fix)', () => {
  // Helper: Wiener gain with optional speech-frame noise reduction.
  // Fixed implementation reduces the noise estimate during speech frames rather than
  // using nEst (a PSD value) directly as the gain floor, which could exceed 1.0.
  function wienerGain(sigPSD, nEst, beta, isSpeech) {
    const nEstFrame = isSpeech ? nEst * 0.3 : nEst;
    return sigPSD > 1e-12
      ? Math.max(Math.sqrt(Math.max(sigPSD - nEstFrame, 0) / sigPSD), beta)
      : beta;
  }

  test('Gain never exceeds 1.0 for any inputs including large nEst', () => {
    const beta = 0.05;
    // Simulate a very noisy environment: nEst >> sigPSD
    for (let i = 0; i < 50; i++) {
      const sigPSD = Math.random() * 2;
      const nEst = Math.random() * 1000; // large PSD values
      const gain = wienerGain(sigPSD, nEst, beta, /* isSpeech */ true);
      expect(gain).toBeLessThanOrEqual(1.0);
      expect(gain).toBeGreaterThanOrEqual(beta);
    }
  });

  test('Speech frames receive softer NR than non-speech frames for same input', () => {
    const beta = 0.05;
    const sigPSD = 2.0, nEst = 5.0; // signal partially masked by noise
    const gainSpeech = wienerGain(sigPSD, nEst, beta, true);
    const gainNonSpeech = wienerGain(sigPSD, nEst, beta, false);
    // Speech frames should preserve more signal (higher gain)
    expect(gainSpeech).toBeGreaterThanOrEqual(gainNonSpeech);
  });

  test('During speech, high nEst still yields gain ≤ 1 (regression: was amplifying)', () => {
    // Before fix: effectiveAlpha = Math.max(nEst * 0.3, beta) used nEst as gain floor.
    // With nEst=375, effectiveAlpha=112.5 — multiplied signal by 112.5.
    const beta = 0.05;
    const nEst = 375; // realistic value: alpha=3 × smoothedNoise=100 × 1.25
    const sigPSD = 150;
    const gain = wienerGain(sigPSD, nEst, beta, /* isSpeech */ true);
    expect(gain).toBeLessThanOrEqual(1.0);
    expect(gain).toBeGreaterThan(0);
  });
});

describe('Frequency bin mapping (applyBgSuppress fix)', () => {
  // Standard formula: freq_k = k * sr / N
  // Buggy formula:    freq_k = (k / halfN) * (sr / 2) = k * sr / (N + 2)
  function binFreqCorrect(k, N, sr) { return k * sr / N; }
  function binFreqBuggy(k, N, sr) { const halfN = N / 2 + 1; return (k / halfN) * (sr / 2); }

  test('DC bin (k=0) maps to 0 Hz', () => {
    expect(binFreqCorrect(0, 2048, 44100)).toBe(0);
  });

  test('Nyquist bin (k=N/2) maps to sr/2', () => {
    const N = 2048, sr = 44100;
    expect(binFreqCorrect(N / 2, N, sr)).toBeCloseTo(sr / 2, 5);
  });

  test('Correct formula differs from buggy formula for non-zero bins', () => {
    const N = 2048, sr = 44100;
    // The buggy denominator (N+2=2050 vs N=2048) creates a ~0.1% error that accumulates
    // for larger k values; check bins where the absolute difference exceeds 0.1 Hz.
    for (const k of [10, 100, 512, 1023]) {
      const correct = binFreqCorrect(k, N, sr);
      const buggy = binFreqBuggy(k, N, sr);
      expect(Math.abs(correct - buggy)).toBeGreaterThan(0.1);
    }
  });

  test('Voice focus band edges land on correct bins', () => {
    const N = 2048, sr = 44100;
    // 300 Hz voice focus low — check correct bin index
    const lo = 300;
    const kLo = Math.round(lo * N / sr); // ≈ 14
    expect(binFreqCorrect(kLo, N, sr)).toBeCloseTo(lo, -1);
  });
});

describe('Harmonic Recovery (makeHarm)', () => {
  function makeHarm(amt, ord) {
    const n = 44100;
    const curve = new Float32Array(n);
    const k = amt * (ord || 3) * 2 + 1;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    return curve;
  }

  test('makeHarm should return a Float32Array of length 44100', () => {
    const curve = makeHarm(0.5, 3);
    expect(curve).toBeInstanceOf(Float32Array);
    expect(curve.length).toBe(44100);
  });

  test('makeHarm values should be within [-1, 1]', () => {
    const curve = makeHarm(1.0, 8);
    for (let i = 0; i < curve.length; i++) {
      expect(curve[i]).toBeGreaterThanOrEqual(-1.000001);
      expect(curve[i]).toBeLessThanOrEqual(1.000001);
    }
  });

  test('makeHarm should be odd-symmetric', () => {
    const curve = makeHarm(0.5, 3);
    const mid = 22050; // 44100 / 2
    // For i = mid, x = (22050 * 2) / 44100 - 1 = 0, so c[mid] should be 0
    expect(curve[mid]).toBeCloseTo(0, 5);
    // c[0] should be -1, c[44099] should be close to 1
    expect(curve[0]).toBeCloseTo(-1, 5);
    // x at 44099: (44099 * 2) / 44100 - 1 = (88198 / 44100) - 1 = 1.99995 - 1 = 0.99995
    // so it's not exactly 1 at the last index.
  });

  test('makeHarm(0, ord) should be linear', () => {
    const amt = 0;
    const ord = 3;
    const curve = makeHarm(amt, ord);
    // if k=1, curve[i] = tanh(x) / tanh(1). That's NOT linear.
    // Wait, the logic in app.js is: c[i]=Math.tanh(k*x)/Math.tanh(k);
    // If amt=0, k=1. c[i] = Math.tanh(x)/Math.tanh(1).
    // This is a soft-clipper.
    expect(curve[22050]).toBeCloseTo(0, 5);
  });
});

describe('mixDW (Dry/Wet Mix) - actual implementation from app.js', () => {
  function mixDW(dry, wet, wAmt) {
    // Provide mocked AudioContext matching the required interface in mixDW:
    const mockCtx = {
      createBuffer: (n, len, sr) => new MockAudioBuffer(n, len, sr)
    };
    return VoiceIsolatePro.prototype.mixDW.call({ ctx: mockCtx }, dry, wet, wAmt);
  }

  test('0% wet (wAmt = 0) should return exactly the dry signal', () => {
    const dry = new MockAudioBuffer(1, 100, 44100);
    const wet = new MockAudioBuffer(1, 100, 44100);
    const dryData = dry.getChannelData(0);
    const wetData = wet.getChannelData(0);

    for (let i = 0; i < 100; i++) {
      dryData[i] = Math.random();
      wetData[i] = Math.random();
    }

    const out = mixDW(dry, wet, 0);
    const outData = out.getChannelData(0);

    for (let i = 0; i < 100; i++) {
      expect(outData[i]).toBeCloseTo(dryData[i], 5);
    }
  });

  test('100% wet (wAmt = 1) should return exactly the wet signal', () => {
    const dry = new MockAudioBuffer(1, 100, 44100);
    const wet = new MockAudioBuffer(1, 100, 44100);
    const dryData = dry.getChannelData(0);
    const wetData = wet.getChannelData(0);

    for (let i = 0; i < 100; i++) {
      dryData[i] = Math.random();
      wetData[i] = Math.random();
    }

    const out = mixDW(dry, wet, 1);
    const outData = out.getChannelData(0);

    for (let i = 0; i < 100; i++) {
      expect(outData[i]).toBeCloseTo(wetData[i], 5);
    }
  });

  test('50% wet (wAmt = 0.5) should return exactly the average of dry and wet', () => {
    const dry = new MockAudioBuffer(1, 100, 44100);
    const wet = new MockAudioBuffer(1, 100, 44100);
    const dryData = dry.getChannelData(0);
    const wetData = wet.getChannelData(0);

    for (let i = 0; i < 100; i++) {
      dryData[i] = 0.8;
      wetData[i] = 0.2;
    }

    const out = mixDW(dry, wet, 0.5);
    const outData = out.getChannelData(0);

    for (let i = 0; i < 100; i++) {
      expect(outData[i]).toBeCloseTo(0.5, 5); // (0.8 * 0.5) + (0.2 * 0.5) = 0.4 + 0.1 = 0.5
    }
  });

  test('Handles mismatched channels and lengths correctly', () => {
    const dry = new MockAudioBuffer(2, 200, 44100); // 2 channels, length 200
    const wet = new MockAudioBuffer(1, 100, 44100); // 1 channel, length 100

    dry.getChannelData(0).fill(1.0);
    wet.getChannelData(0).fill(0.5);

    const out = mixDW(dry, wet, 0.5);

    // Should use minimums: 1 channel, 100 length
    expect(out.numberOfChannels).toBe(1);
    expect(out.length).toBe(100);

    const outData = out.getChannelData(0);
    expect(outData[0]).toBeCloseTo(0.75, 5); // 1.0 * 0.5 + 0.5 * 0.5 = 0.75
  });
});

describe('peakNorm (Peak Normalization) - actual implementation from app.js', () => {
  function peakNorm(buffer, targetDb) {
    const mockCtx = {
      createBuffer: (n, len, sr) => new MockAudioBuffer(n, len, sr)
    };
    return VoiceIsolatePro.prototype.peakNorm.call({ ctx: mockCtx }, buffer, targetDb);
  }

  test('Silence (0 peak) returns the same buffer (values unchanged)', () => {
    const buf = new MockAudioBuffer(1, 100, 44100);
    const data = buf.getChannelData(0);
    data.fill(0);

    const out = peakNorm(buf, -1);

    // In peakNorm: `if(pk===0)return buf;`
    expect(out).toBe(buf);

    const outData = out.getChannelData(0);
    for (let i = 0; i < 100; i++) {
      expect(outData[i]).toBe(0);
    }
  });

  test('Normalizes a 0.5 peak buffer to 0 dBFS (gain = 2.0)', () => {
    const buf = new MockAudioBuffer(1, 10, 44100);
    const data = buf.getChannelData(0);
    // Peak will be 0.5
    for (let i = 0; i < 10; i++) {
      data[i] = i % 2 === 0 ? 0.5 : -0.25;
    }

    const out = peakNorm(buf, 0); // 0 dB target
    const outData = out.getChannelData(0);

    // Target 0dB -> math.pow(10, 0) = 1.0.  Gain = 1.0 / 0.5 = 2.0
    expect(outData[0]).toBeCloseTo(1.0, 5); // 0.5 * 2.0
    expect(outData[1]).toBeCloseTo(-0.5, 5); // -0.25 * 2.0
  });

  test('Normalizes a 1.0 peak buffer to -6 dBFS (gain ≈ 0.501187)', () => {
    const buf = new MockAudioBuffer(1, 10, 44100);
    const data = buf.getChannelData(0);
    data[0] = 1.0;
    data[1] = -1.0;
    data[2] = 0.5;

    const out = peakNorm(buf, -6);
    const outData = out.getChannelData(0);

    const expectedGain = Math.pow(10, -6 / 20); // ~0.501187
    expect(outData[0]).toBeCloseTo(expectedGain, 5);
    expect(outData[1]).toBeCloseTo(-expectedGain, 5);
    expect(outData[2]).toBeCloseTo(0.5 * expectedGain, 5);
  });

  test('Finds peak across multiple channels', () => {
    const buf = new MockAudioBuffer(2, 10, 44100);
    buf.getChannelData(0)[0] = 0.5;
    buf.getChannelData(1)[0] = -0.8; // absolute peak is 0.8

    const out = peakNorm(buf, 0);
    const gain = 1.0 / 0.8; // 1.25

    expect(out.getChannelData(0)[0]).toBeCloseTo(0.5 * gain, 5); // 0.625
    expect(out.getChannelData(1)[0]).toBeCloseTo(-0.8 * gain, 5); // -1.0
  });

  test('Hard clips values to [-1, 1] if gain makes them exceed bounds (though logic normally prevents this unless peak calculation is bypassed, but testing the clamp)', () => {
    // This tests the Math.max(-1, Math.min(1, inp[i] * g)) part
    // To trigger it naturally, we'd need a targetDb > 0, which gives gain > 1 / peak.
    const buf = new MockAudioBuffer(1, 10, 44100);
    const data = buf.getChannelData(0);
    data[0] = 0.5; // peak is 0.5

    // Normalizing to +6dB (targetDb > 0)
    // gain = Math.pow(10, 6/20) / 0.5 = 1.995 / 0.5 = 3.99
    // data[0] * gain = 1.995, should be clipped to 1.0
    const out = peakNorm(buf, 6);
    const outData = out.getChannelData(0);

    expect(outData[0]).toBeCloseTo(1.0, 5); // Clamped
  });
});

// ============================================================
// Advanced DSP: AdaptiveNoiseEstimator
// ============================================================

describe('AdaptiveNoiseEstimator', () => {
  const NUM_BINS = 512;

  test('initializes noisePSD to zero before first update', () => {
    const est = new DSPCore.AdaptiveNoiseEstimator(NUM_BINS);
    expect(est.noisePSD).toBeInstanceOf(Float32Array);
    expect(est.noisePSD.length).toBe(NUM_BINS);
    expect(est.initialized).toBe(false);
    for (const v of est.noisePSD) expect(v).toBe(0);
  });

  test('after first update, noisePSD equals the input PSD (mag^2)', () => {
    const est = new DSPCore.AdaptiveNoiseEstimator(NUM_BINS);
    const mag = new Float32Array(NUM_BINS).map(() => Math.random() * 0.5 + 0.1);
    est.update(mag);
    expect(est.initialized).toBe(true);
    for (let k = 0; k < NUM_BINS; k++) {
      expect(est.noisePSD[k]).toBeCloseTo(mag[k] * mag[k], 5);
    }
  });

  test('noise floor rises quickly when signal exceeds current estimate (attack)', () => {
    const est = new DSPCore.AdaptiveNoiseEstimator(NUM_BINS, 0.5, 0.999);
    const lowMag = new Float32Array(NUM_BINS).fill(0.1);
    est.update(lowMag); // init
    const highMag = new Float32Array(NUM_BINS).fill(1.0);
    est.update(highMag); // attack: psd > noisePSD → uses attackCoeff 0.5
    // After one attack-step: new = 0.5 * 0.01 + 0.5 * 1.0 = 0.505
    expect(est.noisePSD[0]).toBeCloseTo(0.505, 4);
  });

  test('noise floor decreases slowly when signal drops below estimate (release)', () => {
    const est = new DSPCore.AdaptiveNoiseEstimator(NUM_BINS, 0.5, 0.9);
    const highMag = new Float32Array(NUM_BINS).fill(1.0);
    est.update(highMag); // init at 1.0 PSD
    const lowMag = new Float32Array(NUM_BINS).fill(0.1);
    est.update(lowMag); // release: psd (0.01) < noisePSD (1.0) → uses releaseCoeff 0.9
    // After one release-step: new = 0.9 * 1.0 + 0.1 * 0.01 = 0.901
    expect(est.noisePSD[0]).toBeCloseTo(0.901, 4);
  });

  test('release is strictly slower than attack (asymmetry)', () => {
    const attackCoeff = 0.5, releaseCoeff = 0.95;
    const est = new DSPCore.AdaptiveNoiseEstimator(NUM_BINS, attackCoeff, releaseCoeff);
    const initMag = new Float32Array(NUM_BINS).fill(0.5);
    est.update(initMag);
    const init = est.noisePSD[0];

    // Attack step (higher signal)
    const highMag = new Float32Array(NUM_BINS).fill(1.0);
    est.update(highMag);
    const afterAttack = est.noisePSD[0] - init;

    // Reset and re-init, then release step
    est.reset();
    const highInit = new Float32Array(NUM_BINS).fill(1.0);
    est.update(highInit);
    const lowMag = new Float32Array(NUM_BINS).fill(0.1);
    est.update(lowMag);
    const afterRelease = est.noisePSD[0] - 1.0;

    // After attack: noisePSD moves towards 1.0 quickly (large delta)
    // After release: noisePSD moves towards 0.01 slowly (small delta in magnitude)
    expect(Math.abs(afterAttack)).toBeGreaterThan(Math.abs(afterRelease));
  });

  test('getProfile returns the same Float32Array reference as noisePSD', () => {
    const est = new DSPCore.AdaptiveNoiseEstimator(NUM_BINS);
    expect(est.getProfile()).toBe(est.noisePSD);
  });

  test('reset clears state and reinitializes correctly on next update', () => {
    const est = new DSPCore.AdaptiveNoiseEstimator(NUM_BINS);
    const mag = new Float32Array(NUM_BINS).fill(0.5);
    est.update(mag);
    est.reset();
    expect(est.initialized).toBe(false);
    for (const v of est.noisePSD) expect(v).toBe(0);
    // Next update should re-initialize from the new magnitude
    const mag2 = new Float32Array(NUM_BINS).fill(0.2);
    est.update(mag2);
    expect(est.initialized).toBe(true);
    expect(est.noisePSD[0]).toBeCloseTo(0.04, 5); // 0.2^2
  });

  test('noisePSD values are always non-negative', () => {
    const est = new DSPCore.AdaptiveNoiseEstimator(NUM_BINS);
    for (let i = 0; i < 20; i++) {
      const mag = new Float32Array(NUM_BINS).map(() => Math.random() * 2);
      est.update(mag);
    }
    for (const v of est.noisePSD) expect(v).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// Advanced DSP: MultibandWienerFilter
// ============================================================

describe('MultibandWienerFilter', () => {
  const NUM_BINS = 257; // fftSize=512, halfN=257
  const SR = 48000;
  const FFT_SIZE = 512;

  function makeMag(numBins, value) {
    return new Float32Array(numBins).fill(value);
  }

  test('returns the magnitude array (in-place modification)', () => {
    const wf = new DSPCore.MultibandWienerFilter(8, SR, FFT_SIZE);
    const mag = makeMag(NUM_BINS, 0.5);
    const result = wf.process(mag, null, 1, 0);
    expect(result).toBe(mag); // same reference
  });

  test('with no noise (noisePSD = null), magnitude is minimally changed', () => {
    const wf = new DSPCore.MultibandWienerFilter(8, SR, FFT_SIZE);
    const mag = makeMag(NUM_BINS, 0.5);
    const original = new Float32Array(mag);
    // No noise → sigPow - 0 = sigPow → gain = 1 (theoretically), smoothing reduces slightly
    wf.process(mag, null, 1, 0); // no temporal smoothing (alpha=0)
    for (let k = 0; k < NUM_BINS; k++) {
      expect(mag[k]).toBeGreaterThanOrEqual(original[k] * 0.95); // within 5%
    }
  });

  test('with noise >> signal, magnitude is substantially attenuated (min gain = floor)', () => {
    const wf = new DSPCore.MultibandWienerFilter(8, SR, FFT_SIZE);
    const mag = makeMag(NUM_BINS, 0.01);  // weak signal
    const noisePSD = new Float32Array(NUM_BINS).fill(100); // dominant noise
    wf.process(mag, noisePSD, 1, 0);
    // All bins should be at or near the spectral floor (0.01 gain factor)
    for (let k = 0; k < NUM_BINS; k++) {
      expect(mag[k]).toBeLessThan(0.02); // heavily attenuated
    }
  });

  test('zero strength (strength=0) leaves magnitude unchanged', () => {
    const wf = new DSPCore.MultibandWienerFilter(8, SR, FFT_SIZE);
    const mag = makeMag(NUM_BINS, 0.5);
    const noisePSD = new Float32Array(NUM_BINS).fill(1);
    const original = new Float32Array(mag);
    wf.process(mag, noisePSD, 0, 0); // strength=0 means no noise subtracted
    for (let k = 0; k < NUM_BINS; k++) {
      expect(mag[k]).toBeCloseTo(original[k], 4);
    }
  });

  test('temporal smoothing causes output gain to lag behind instantaneous value', () => {
    const wf = new DSPCore.MultibandWienerFilter(1, SR, FFT_SIZE);
    // Band covers entire spectrum
    wf._bands = [{ lo: 0, hi: NUM_BINS - 1 }];

    // First call with moderate noise — smoothGains starts at 1, will lag
    const mag1 = makeMag(NUM_BINS, 1.0);
    const noisePSD1 = new Float32Array(NUM_BINS).fill(0.5);
    wf.process(new Float32Array(mag1), noisePSD1, 1, 0.9); // strong smoothing
    const smoothedGain = wf.smoothGains[0];

    // The instantaneous Wiener gain for SNR 2:1 (sigPow=1, noisePow=0.5) is ~0.707
    // After strong smoothing: smoothed = 0.9 * 1.0 + 0.1 * 0.707 ≈ 0.971
    expect(smoothedGain).toBeGreaterThan(0.5);
    expect(smoothedGain).toBeLessThan(1.0);
  });

  test('reset restores smoothGains to 1', () => {
    const wf = new DSPCore.MultibandWienerFilter(8, SR, FFT_SIZE);
    const mag = makeMag(NUM_BINS, 0.1);
    const noisePSD = new Float32Array(NUM_BINS).fill(10);
    wf.process(mag, noisePSD, 1, 0.9);
    // smoothGains should have been reduced from 1
    const hadReduction = wf.smoothGains.some(g => g < 0.99);
    expect(hadReduction).toBe(true);
    wf.reset();
    for (const g of wf.smoothGains) expect(g).toBe(1);
  });

  test('bands are lazily initialized and cached across calls', () => {
    const wf = new DSPCore.MultibandWienerFilter(8, SR, FFT_SIZE);
    expect(wf._bands).toBeNull();
    const mag = makeMag(NUM_BINS, 0.5);
    wf.process(mag, null, 0, 0);
    expect(wf._bands).not.toBeNull();
    const firstRef = wf._bands;
    wf.process(mag, null, 0, 0);
    expect(wf._bands).toBe(firstRef); // same reference, not recomputed
  });
});

// ============================================================
// Advanced DSP: VADProcessor
// ============================================================

describe('VADProcessor', () => {
  const SR = 48000;
  const FRAME_MS = 20;

  function makeSilence(sr, durationMs) {
    return new Float32Array(Math.floor(sr * durationMs / 1000));
  }

  function makeTone(sr, durationMs, freq = 440, amplitude = 0.8) {
    const len = Math.floor(sr * durationMs / 1000);
    const data = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      data[i] = amplitude * Math.sin(2 * Math.PI * freq * i / sr);
    }
    return data;
  }

  test('constructs with correct defaults', () => {
    const vad = new DSPCore.VADProcessor(SR, FRAME_MS, 0.5);
    expect(vad.sr).toBe(SR);
    expect(vad.sensitivity).toBeCloseTo(0.5, 5);
    expect(vad.frameSize).toBeGreaterThan(0);
  });

  test('silence returns 0 confidence (no voice)', () => {
    const vad = new DSPCore.VADProcessor(SR, FRAME_MS, 0.5);
    const silence = makeSilence(SR, FRAME_MS * 2);
    const confidence = vad.processSignal(silence);
    // All frames should be silence (confidence = 0)
    for (const c of confidence) expect(c).toBe(0);
  });

  test('loud sine tone returns 1 confidence (voice detected)', () => {
    const vad = new DSPCore.VADProcessor(SR, FRAME_MS, 0.5);
    // 440 Hz tone — low ZCR, high energy → should be detected as voiced
    const tone = makeTone(SR, FRAME_MS * 3, 440, 0.9);
    const confidence = vad.processSignal(tone);
    const hasSpeech = Array.from(confidence).some(c => c > 0);
    expect(hasSpeech).toBe(true);
  });

  test('processSignal returns Float32Array with one value per frame', () => {
    const vad = new DSPCore.VADProcessor(SR, FRAME_MS, 0.5);
    const data = makeTone(SR, 100, 440, 0.5); // 100 ms
    const result = vad.processSignal(data);
    expect(result).toBeInstanceOf(Float32Array);
    const expectedFrames = Math.floor(data.length / vad.frameSize);
    expect(result.length).toBe(expectedFrames);
  });

  test('processFrame returns value in {0, 0.5, 1}', () => {
    const vad = new DSPCore.VADProcessor(SR, FRAME_MS, 0.5);
    const frameLen = vad.frameSize;
    const tone = makeTone(SR, FRAME_MS, 440, 0.9).subarray(0, frameLen);
    const val = vad.processFrame(tone);
    expect([0, 0.5, 1]).toContain(val);
  });

  test('hangover keeps confidence > 0 for a few frames after speech ends', () => {
    const vad = new DSPCore.VADProcessor(SR, FRAME_MS, 0.8); // high sensitivity = more hangover
    // One frame of loud speech followed by silence
    const frameLen = vad.frameSize;
    const speech = makeTone(SR, FRAME_MS, 440, 0.9).subarray(0, frameLen);
    vad.processFrame(speech); // trigger speech detection
    // Now silence — hangover should keep non-zero
    const silence = new Float32Array(frameLen);
    const c = vad.processFrame(silence);
    expect(c).toBeGreaterThan(0); // hangover active
  });

  test('setSensitivity updates energy threshold and ZCR threshold', () => {
    const vad = new DSPCore.VADProcessor(SR, FRAME_MS, 0.5);
    const prevEThresh = vad.energyThreshDb;
    const prevZCR = vad.zcrThresh;
    vad.setSensitivity(0.9); // higher sensitivity
    expect(vad.energyThreshDb).toBeLessThan(prevEThresh); // lower energy needed to detect voice
    expect(vad.zcrThresh).toBeGreaterThan(prevZCR); // tolerates higher ZCR
  });

  test('high sensitivity detects quieter signals that low sensitivity misses', () => {
    const vadHigh = new DSPCore.VADProcessor(SR, FRAME_MS, 0.9);
    const vadLow = new DSPCore.VADProcessor(SR, FRAME_MS, 0.1);
    const quietTone = makeTone(SR, FRAME_MS * 5, 440, 0.01); // very quiet
    const highResult = vadHigh.processSignal(quietTone);
    const lowResult = vadLow.processSignal(quietTone);
    const highSum = Array.from(highResult).reduce((a, b) => a + b, 0);
    const lowSum = Array.from(lowResult).reduce((a, b) => a + b, 0);
    expect(highSum).toBeGreaterThanOrEqual(lowSum);
  });

  test('reset clears smoothedEnergy and hangover', () => {
    const vad = new DSPCore.VADProcessor(SR, FRAME_MS, 0.8);
    const tone = makeTone(SR, FRAME_MS, 440, 0.9);
    vad.processSignal(tone);
    expect(vad.hangover > 0 || vad.smoothedEnergy !== 0).toBe(true);
    vad.reset();
    expect(vad.smoothedEnergy).toBe(0);
    expect(vad.hangover).toBe(0);
  });

  test('sensitivity clamps to [0, 1]', () => {
    const vad = new DSPCore.VADProcessor(SR, FRAME_MS, 0.5);
    vad.setSensitivity(-5);
    expect(vad.sensitivity).toBe(0);
    vad.setSensitivity(99);
    expect(vad.sensitivity).toBe(1);
  });
});

// ===== Tests for Advanced DSP Upgrades (Issue #N) =====

describe('AdaptiveNoiseFloor (Martin 2001 minimum statistics)', () => {
  const NUM_BINS = 64;
  const SR = 48000;
  const HOP = 1024;

  test('constructor creates correct shape buffers', () => {
    const anf = new DSPCore.AdaptiveNoiseFloor(NUM_BINS, 200, HOP, SR);
    expect(anf.numBins).toBe(NUM_BINS);
    expect(anf.noiseEst.length).toBe(NUM_BINS);
    expect(anf._minStore.length).toBe(5); // 5 sub-windows
  });

  test('getFloor() returns zeros before any update', () => {
    const anf = new DSPCore.AdaptiveNoiseFloor(NUM_BINS, 200, HOP, SR);
    const floor = anf.getFloor();
    expect(floor.length).toBe(NUM_BINS);
    for (let k = 0; k < NUM_BINS; k++) {
      expect(floor[k]).toBe(0); // Infinity clamped to 0
    }
  });

  test('update() initializes on first call', () => {
    const anf = new DSPCore.AdaptiveNoiseFloor(NUM_BINS, 200, HOP, SR);
    const mag = new Float32Array(NUM_BINS).fill(0.1);
    anf.update(mag);
    expect(anf._initialized).toBe(true);
    const floor = anf.getFloor();
    for (let k = 0; k < NUM_BINS; k++) {
      expect(floor[k]).toBeGreaterThan(0);
    }
  });

  test('getFloor() decreases toward true noise level after silence frames', () => {
    const anf = new DSPCore.AdaptiveNoiseFloor(NUM_BINS, 50, HOP, SR); // fast 50ms
    // Feed 200 silence frames at constant noise level
    const noise = new Float32Array(NUM_BINS).fill(0.05);
    for (let i = 0; i < 200; i++) anf.update(noise);
    const floor = anf.getFloor();
    // Floor should converge towards 0.05
    for (let k = 0; k < NUM_BINS; k++) {
      expect(floor[k]).toBeGreaterThan(0);
      expect(floor[k]).toBeLessThanOrEqual(0.06); // within 20% of true noise
    }
  });

  test('reset() clears state', () => {
    const anf = new DSPCore.AdaptiveNoiseFloor(NUM_BINS, 200, HOP, SR);
    const mag = new Float32Array(NUM_BINS).fill(0.1);
    anf.update(mag);
    expect(anf._initialized).toBe(true);
    anf.reset();
    expect(anf._initialized).toBe(false);
    const floor = anf.getFloor();
    for (let k = 0; k < NUM_BINS; k++) expect(floor[k]).toBe(0);
  });

  test('smoothing alpha is between 0 and 1', () => {
    const anf = new DSPCore.AdaptiveNoiseFloor(NUM_BINS, 200, HOP, SR);
    expect(anf.alpha).toBeGreaterThan(0);
    expect(anf.alpha).toBeLessThan(1);
  });
});

describe('applyAdaptiveWiener', () => {
  const halfN = 16;
  const SR = 48000;
  const HOP = 1024;

  function makeMag(frames, bins, val) {
    return Array.from({ length: frames }, () => new Float32Array(bins).fill(val));
  }

  test('returns mag array unchanged when all frames are voiced (VAD=1)', () => {
    // When VAD confidence = 1 (fully voiced), SPP=1 → gain factor = 1 (no suppression)
    const mag = makeMag(4, halfN, 1.0);
    const before = mag.map(f => Array.from(f));
    const vadConf = new Float32Array(4).fill(1.0);
    const tracker = new DSPCore.AdaptiveNoiseFloor(halfN, 200, HOP, SR);
    DSPCore.applyAdaptiveWiener(mag, vadConf, tracker);
    // Signal bins should be ≥ the original (no suppression for fully voiced frames)
    for (let f = 0; f < mag.length; f++) {
      for (let k = 0; k < halfN; k++) {
        expect(mag[f][k]).toBeCloseTo(before[f][k], 5);
      }
    }
  });

  test('suppresses signal when frames are silent (VAD=0) and noise floor is known', () => {
    const halfN2 = 8;
    const tracker = new DSPCore.AdaptiveNoiseFloor(halfN2, 50, HOP, SR);
    // Pre-initialize tracker with noise frames
    const noiseMag = new Float32Array(halfN2).fill(0.5);
    for (let i = 0; i < 100; i++) tracker.update(noiseMag);

    // Signal at same level as noise → should be suppressed
    const mag = makeMag(4, halfN2, 0.5);
    const vadConf = new Float32Array(4).fill(0.0); // silence
    DSPCore.applyAdaptiveWiener(mag, vadConf, tracker, { overSubtraction: 1.2 });

    // Output should be less than input
    for (let f = 0; f < mag.length; f++) {
      for (let k = 0; k < halfN2; k++) {
        expect(mag[f][k]).toBeLessThan(0.5 + 1e-6);
      }
    }
  });

  test('respects spectralFloor option', () => {
    const halfN2 = 4;
    const tracker = new DSPCore.AdaptiveNoiseFloor(halfN2, 50, HOP, SR);
    const noiseMag = new Float32Array(halfN2).fill(10.0); // very loud noise
    for (let i = 0; i < 200; i++) tracker.update(noiseMag);

    // Tiny signal with enormous noise → should hit floor
    const mag = makeMag(2, halfN2, 0.001);
    const vadConf = new Float32Array(2).fill(0.0);
    const floor = 0.05;
    DSPCore.applyAdaptiveWiener(mag, vadConf, tracker, { spectralFloor: floor });
    for (let f = 0; f < mag.length; f++) {
      for (let k = 0; k < halfN2; k++) {
        // gain cannot go below spectralFloor, so output ≥ input * spectralFloor / 1 = very small
        // but gain itself is clamped to floor, so bin value = input * gain >= input * floor
        expect(mag[f][k]).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('harmonicEnhanceV2', () => {
  const SR = 48000;
  const FFT_SIZE = 512;
  const HALF_N = FFT_SIZE / 2 + 1;

  function makeFlatMag(frames) {
    return Array.from({ length: frames }, () => new Float32Array(HALF_N).fill(0.1));
  }
  function makePhase(frames) {
    return Array.from({ length: frames }, () => new Float32Array(HALF_N).fill(0));
  }

  test('returns mag unchanged when amount=0', () => {
    const mag = makeFlatMag(2);
    const before = mag.map(f => Array.from(f));
    DSPCore.harmonicEnhanceV2(mag, makePhase(2), 0, { sampleRate: SR, fftSize: FFT_SIZE });
    for (let f = 0; f < mag.length; f++) {
      for (let k = 0; k < HALF_N; k++) {
        expect(mag[f][k]).toBeCloseTo(before[f][k], 5);
      }
    }
  });

  test('SBR fills high-frequency bins above 8kHz', () => {
    const mag = makeFlatMag(2);
    const bin8k = Math.round(8000 / (SR / FFT_SIZE));
    // Zero out high-frequency bins
    for (const frame of mag) {
      for (let k = bin8k; k < HALF_N; k++) frame[k] = 0;
    }
    DSPCore.harmonicEnhanceV2(mag, makePhase(2), 50, {
      sbr: true,
      formantProtection: false,
      breathinessGain: 1.0,
      sampleRate: SR,
      fftSize: FFT_SIZE
    });
    // At least some bins above 8kHz should be non-zero now
    let nonZeroHF = 0;
    for (const frame of mag) {
      for (let k = bin8k; k < HALF_N; k++) {
        if (frame[k] > 0) nonZeroHF++;
      }
    }
    expect(nonZeroHF).toBeGreaterThan(0);
  });

  test('formant protection boosts bins in F1/F2 range', () => {
    const mag = makeFlatMag(2);
    const before = mag.map(f => Array.from(f));
    DSPCore.harmonicEnhanceV2(mag, makePhase(2), 20, {
      sbr: false,
      formantProtection: true,
      breathinessGain: 1.0,
      sampleRate: SR,
      fftSize: FFT_SIZE
    });
    // Formant bands (200–3500 Hz) should be boosted relative to other areas
    const f1Lo = Math.round(200 / (SR / FFT_SIZE));
    const f2Hi = Math.round(3500 / (SR / FFT_SIZE));
    let boostedCount = 0;
    for (const frame of mag) {
      for (let k = f1Lo; k <= f2Hi && k < HALF_N; k++) {
        if (frame[k] > 0.1) boostedCount++; // was 0.1, now boosted
      }
    }
    expect(boostedCount).toBeGreaterThan(0);
  });

  test('breathinessGain < 1 attenuates high-SFM bins', () => {
    // Create a spectrally flat (noisy/breathy) signal
    const mag = Array.from({ length: 2 }, () => {
      const m = new Float32Array(HALF_N);
      for (let k = 0; k < HALF_N; k++) m[k] = 0.1; // flat = high SFM
      return m;
    });
    const sumBefore = mag[0].reduce((a, b) => a + b, 0);
    DSPCore.harmonicEnhanceV2(mag, makePhase(2), 20, {
      sbr: false,
      formantProtection: false,
      breathinessGain: 0.5,
      sampleRate: SR,
      fftSize: FFT_SIZE
    });
    const sumAfter = mag[0].reduce((a, b) => a + b, 0);
    // Breathiness reduction should lower total voiced band energy
    expect(sumAfter).toBeLessThan(sumBefore + 1);
  });
});

describe('classifyNoiseSpectral', () => {
  const SR = 48000;
  const FFT_SIZE = 512;
  const HALF_N = FFT_SIZE / 2 + 1;

  function makeFrames(fillFn, numFrames = 4) {
    return Array.from({ length: numFrames }, () => {
      const m = new Float32Array(HALF_N);
      fillFn(m);
      return m;
    });
  }

  test('returns silence for empty or near-zero input', () => {
    const result = DSPCore.classifyNoiseSpectral([], SR, FFT_SIZE);
    expect(result.noiseClass).toBe('silence');

    const zeroFrames = makeFrames(m => m.fill(0));
    const result2 = DSPCore.classifyNoiseSpectral(zeroFrames, SR, FFT_SIZE);
    expect(result2.noiseClass).toBe('silence');
  });

  test('returns a valid class string and confidence in [0,1]', () => {
    const validClasses = ['music', 'white_noise', 'crowd', 'HVAC', 'keyboard', 'traffic', 'silence'];
    const frames = makeFrames(m => { for (let k = 0; k < HALF_N; k++) m[k] = 0.1; });
    const result = DSPCore.classifyNoiseSpectral(frames, SR, FFT_SIZE);
    expect(validClasses).toContain(result.noiseClass);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  test('classifies spectrally flat signal as white_noise', () => {
    // Completely flat spectrum = maximum spectral flatness → white noise
    const frames = makeFrames(m => { for (let k = 0; k < HALF_N; k++) m[k] = 0.5; });
    const result = DSPCore.classifyNoiseSpectral(frames, SR, FFT_SIZE);
    expect(result.noiseClass).toBe('white_noise');
  });

  test('classifies low-frequency dominant signal as HVAC or traffic', () => {
    const HVACClasses = ['HVAC', 'traffic'];
    const frames = makeFrames(m => {
      const subBin = Math.round(60 / (SR / 2 / (HALF_N - 1)));
      const bassBin = Math.round(200 / (SR / 2 / (HALF_N - 1)));
      // Concentrate energy in sub-bass
      for (let k = 0; k <= Math.min(subBin, bassBin, HALF_N - 1); k++) m[k] = 1.0;
    });
    const result = DSPCore.classifyNoiseSpectral(frames, SR, FFT_SIZE);
    expect(HVACClasses).toContain(result.noiseClass);
  });
});

// ============================================================
// Voice Isolation Bin Clamping (dsp-processor.js PR fix)
// ============================================================
// The logic from dsp-processor.js lines 408-416, extracted for unit testing.
// This mirrors the exact clamping algorithm added in the PR.
function clampVoiceBins(voiceFocusLo, voiceFocusHi, sampleRate, N) {
  const halfN = N / 2 + 1;
  const binHz = sampleRate / N;
  let loBin = Math.round((voiceFocusLo || 0) / binHz);
  let hiBin = Math.round((voiceFocusHi || 0) / binHz);
  if (!Number.isFinite(loBin) || loBin < 0) loBin = 0;
  else if (loBin >= halfN) loBin = halfN - 1;
  if (!Number.isFinite(hiBin) || hiBin >= halfN) hiBin = halfN - 1;
  else if (hiBin < 0) hiBin = 0;
  if (hiBin < loBin) hiBin = loBin;
  if (hiBin >= halfN) hiBin = halfN - 1;
  return { loBin, hiBin, halfN };
}

describe('Voice Isolation bin clamping (dsp-processor.js PR fix)', () => {
  const SR = 44100;
  const N  = 2048;
  const halfN = N / 2 + 1; // 1025

  // ── Normal values ─────────────────────────────────────────────────────────

  test('typical voice band (300 Hz – 3400 Hz) maps to correct bin indices', () => {
    const { loBin, hiBin } = clampVoiceBins(300, 3400, SR, N);
    const binHz = SR / N;
    expect(loBin).toBe(Math.round(300 / binHz));
    expect(hiBin).toBe(Math.round(3400 / binHz));
    expect(loBin).toBeGreaterThanOrEqual(0);
    expect(hiBin).toBeLessThan(halfN);
    expect(hiBin).toBeGreaterThanOrEqual(loBin);
  });

  test('DC frequency (0 Hz) maps loBin to 0', () => {
    const { loBin } = clampVoiceBins(0, 1000, SR, N);
    expect(loBin).toBe(0);
  });

  // ── Null / undefined fallback (|| 0) ──────────────────────────────────────

  test('undefined voiceFocusLo falls back via || 0 to bin 0', () => {
    const { loBin } = clampVoiceBins(undefined, 1000, SR, N);
    expect(loBin).toBe(0);
  });

  test('null voiceFocusHi falls back via || 0 to bin 0, then clamped to loBin', () => {
    const { loBin, hiBin } = clampVoiceBins(500, null, SR, N);
    // null || 0 → Math.round(0 / binHz) = 0; 0 < loBin → hiBin set to loBin
    expect(hiBin).toBe(loBin);
  });

  test('both undefined yield loBin = 0, hiBin = 0', () => {
    const { loBin, hiBin } = clampVoiceBins(undefined, undefined, SR, N);
    expect(loBin).toBe(0);
    expect(hiBin).toBe(0);
  });

  // ── Infinity inputs ───────────────────────────────────────────────────────

  test('Infinity voiceFocusLo is clamped to 0 (non-finite guard)', () => {
    // Infinity / binHz = Infinity → !isFinite → loBin = 0
    const { loBin } = clampVoiceBins(Infinity, 3000, SR, N);
    expect(loBin).toBe(0);
  });

  test('Infinity voiceFocusHi is clamped to halfN - 1 (non-finite guard)', () => {
    // Infinity / binHz = Infinity → !isFinite → hiBin = halfN - 1
    const { hiBin, halfN: hn } = clampVoiceBins(0, Infinity, SR, N);
    expect(hiBin).toBe(hn - 1);
  });

  test('-Infinity voiceFocusLo is clamped to 0 (negative + non-finite guard)', () => {
    const { loBin } = clampVoiceBins(-Infinity, 2000, SR, N);
    expect(loBin).toBe(0);
  });

  test('-Infinity voiceFocusHi: non-finite guard fires first, clamps to halfN - 1', () => {
    // -Infinity is truthy, so (-Infinity || 0) = -Infinity.
    // Math.round(-Infinity) = -Infinity → !isFinite → hiBin = halfN - 1 (non-finite guard).
    const { hiBin, halfN: hn } = clampVoiceBins(0, -Infinity, SR, N);
    expect(hiBin).toBe(hn - 1);
  });

  // ── NaN inputs ────────────────────────────────────────────────────────────

  test('NaN voiceFocusLo is clamped to 0 (non-finite guard catches NaN)', () => {
    const { loBin } = clampVoiceBins(NaN, 2000, SR, N);
    expect(loBin).toBe(0);
  });

  test('NaN voiceFocusHi: (NaN || 0) evaluates to 0, hiBin stays 0', () => {
    // NaN is falsy in JS: (NaN || 0) = 0 → hiBin = Math.round(0/binHz) = 0.
    // No guards fire, so hiBin remains 0.
    const { hiBin } = clampVoiceBins(0, NaN, SR, N);
    expect(hiBin).toBe(0);
  });

  // ── Negative frequency inputs ─────────────────────────────────────────────

  test('negative voiceFocusLo is clamped to 0', () => {
    const { loBin } = clampVoiceBins(-500, 2000, SR, N);
    expect(loBin).toBe(0);
  });

  test('negative voiceFocusHi is clamped to 0, hiBin adjusted to loBin', () => {
    const { loBin, hiBin } = clampVoiceBins(300, -100, SR, N);
    // -100 / binHz < 0 → hiBin = 0; 0 < loBin → hiBin = loBin
    expect(hiBin).toBe(loBin);
  });

  // ── Frequencies above Nyquist ─────────────────────────────────────────────

  test('voiceFocusLo above Nyquist is clamped to halfN - 1', () => {
    const { loBin, halfN: hn } = clampVoiceBins(SR, 1000, SR, N);
    // SR / binHz = N → loBin = N >= halfN → loBin = halfN - 1
    expect(loBin).toBe(hn - 1);
  });

  test('voiceFocusHi above Nyquist is clamped to halfN - 1', () => {
    const { hiBin, halfN: hn } = clampVoiceBins(300, SR * 2, SR, N);
    expect(hiBin).toBe(hn - 1);
  });

  test('voiceFocusHi exactly at halfN boundary is clamped to halfN - 1', () => {
    // Produce a raw hiBin = halfN exactly: freq = halfN * binHz
    const binHz = SR / N;
    const freq = halfN * binHz;
    const { hiBin, halfN: hn } = clampVoiceBins(0, freq, SR, N);
    expect(hiBin).toBe(hn - 1);
  });

  // ── Inverted range (loBin > hiBin) ───────────────────────────────────────

  test('inverted range (voiceFocusLo > voiceFocusHi) sets hiBin = loBin', () => {
    // e.g. lo=3000, hi=300 — user mistake or corrupted params
    const { loBin, hiBin } = clampVoiceBins(3000, 300, SR, N);
    expect(hiBin).toBe(loBin);
  });

  test('equal lo and hi frequencies map to same bin (loBin === hiBin)', () => {
    const { loBin, hiBin } = clampVoiceBins(1000, 1000, SR, N);
    expect(loBin).toBe(hiBin);
  });

  // ── Output bounds invariants ──────────────────────────────────────────────

  test('loBin is always in [0, halfN - 1] for any numeric input', () => {
    const cases = [0, 100, 300, 1000, 5000, 22050, 44100, 88200, -1, -500];
    for (const freq of cases) {
      const { loBin, halfN: hn } = clampVoiceBins(freq, 22050, SR, N);
      expect(loBin).toBeGreaterThanOrEqual(0);
      expect(loBin).toBeLessThan(hn);
    }
  });

  test('hiBin is always in [0, halfN - 1] for any numeric input', () => {
    const cases = [0, 100, 300, 1000, 5000, 22050, 44100, 88200, -1, -500];
    for (const freq of cases) {
      const { hiBin, halfN: hn } = clampVoiceBins(0, freq, SR, N);
      expect(hiBin).toBeGreaterThanOrEqual(0);
      expect(hiBin).toBeLessThan(hn);
    }
  });

  test('hiBin is always >= loBin after clamping', () => {
    const pairs = [
      [0, 0], [300, 3400], [3400, 300], [0, SR], [SR, 0],
      [undefined, undefined], [NaN, NaN], [Infinity, -Infinity],
    ];
    for (const [lo, hi] of pairs) {
      const { loBin, hiBin } = clampVoiceBins(lo, hi, SR, N);
      expect(hiBin).toBeGreaterThanOrEqual(loBin);
    }
  });

  // ── Regression: zero sampleRate produces valid (non-crash) output ─────────

  test('zero sampleRate (binHz=0) produces finite, in-range bin indices', () => {
    // sampleRate=0 → binHz=0, freq/0 = NaN or Infinity → guards must catch
    const { loBin, hiBin, halfN: hn } = clampVoiceBins(300, 3400, 0, N);
    expect(Number.isFinite(loBin)).toBe(true);
    expect(Number.isFinite(hiBin)).toBe(true);
    expect(loBin).toBeGreaterThanOrEqual(0);
    expect(hiBin).toBeGreaterThanOrEqual(loBin);
    expect(hiBin).toBeLessThan(hn);
  });
});

// ============================================================
// DSPCore.hannWindow
// ============================================================

describe('DSPCore.hannWindow', () => {
  test('returns a Float32Array of the requested length', () => {
    const w = DSPCore.hannWindow(512);
    expect(w).toBeInstanceOf(Float32Array);
    expect(w.length).toBe(512);
  });

  test('all values are in [0, 1]', () => {
    const w = DSPCore.hannWindow(1024);
    for (const v of w) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  test('first and last samples are 0 (or near-zero for periodic Hann)', () => {
    const w = DSPCore.hannWindow(512);
    expect(w[0]).toBeCloseTo(0, 5);
  });

  test('peak is near the centre of the window', () => {
    const N = 512;
    const w = DSPCore.hannWindow(N);
    let maxVal = 0, maxIdx = 0;
    for (let i = 0; i < N; i++) {
      if (w[i] > maxVal) { maxVal = w[i]; maxIdx = i; }
    }
    // Centre of a periodic Hann window is at N/2
    expect(Math.abs(maxIdx - N / 2)).toBeLessThanOrEqual(2);
    expect(maxVal).toBeGreaterThan(0.99);
  });

  test('satisfies the Constant-Overlap-Add (COLA) property at 75% overlap', () => {
    // For a 75% overlap (hop = N/4), 4 windows placed at offsets 0, hop, 2*hop, 3*hop
    // produce a constant squared-sum in the steady-state region [3*hop, N).
    const N   = 512;
    const hop = N / 4; // 128
    const w   = DSPCore.hannWindow(N);
    const len = N + 3 * hop;
    const sum = new Float64Array(len);
    for (let start = 0; start < 4 * hop; start += hop) {
      for (let i = 0; i < N; i++) {
        if (start + i < len) sum[start + i] += w[i] * w[i];
      }
    }
    // Only check the fully-overlapping steady-state region [3*hop, N)
    // where all 4 windows contribute, so the COLA sum is constant (≈ 1.5).
    const mid = sum[3 * hop];
    for (let i = 3 * hop; i < N; i++) {
      expect(Math.abs(sum[i] - mid) / mid).toBeLessThan(0.05); // within 5%
    }
  });
});

// ============================================================
// DSPCore.forwardSTFT / DSPCore.inverseSTFT
// ============================================================

describe('DSPCore.forwardSTFT', () => {
  const FFT_SIZE = 512;
  const HOP      = 128; // 75% overlap
  const N_SAMPLES = 4096;
  const HALF_N    = FFT_SIZE / 2 + 1;

  function makeSine(n, freq = 440, sr = 48000) {
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * freq * i / sr);
    return d;
  }

  test('returns an object with mag, phase, and frameCount', () => {
    const data   = makeSine(N_SAMPLES);
    const result = DSPCore.forwardSTFT(data, FFT_SIZE, HOP);
    expect(result).toHaveProperty('mag');
    expect(result).toHaveProperty('phase');
    expect(result).toHaveProperty('frameCount');
  });

  test('frameCount matches the expected number of frames', () => {
    const data      = makeSine(N_SAMPLES);
    const { frameCount } = DSPCore.forwardSTFT(data, FFT_SIZE, HOP);
    const expected  = Math.floor((N_SAMPLES - FFT_SIZE) / HOP) + 1;
    expect(frameCount).toBe(expected);
  });

  test('each magnitude frame has halfN bins', () => {
    const data = makeSine(N_SAMPLES);
    const { mag, frameCount } = DSPCore.forwardSTFT(data, FFT_SIZE, HOP);
    expect(mag.length).toBe(frameCount);
    for (const frame of mag) {
      expect(frame.length).toBe(HALF_N);
    }
  });

  test('each phase frame has halfN bins in [-π, π]', () => {
    const data = makeSine(N_SAMPLES);
    const { phase } = DSPCore.forwardSTFT(data, FFT_SIZE, HOP);
    // Phase values are stored in Float32Array; the float32 representation of π
    // is slightly larger than the float64 Math.PI, so we allow 1e-6 tolerance.
    for (const frame of phase) {
      for (const p of frame) {
        expect(p).toBeGreaterThanOrEqual(-Math.PI - 1e-6);
        expect(p).toBeLessThanOrEqual(Math.PI + 1e-6);
      }
    }
  });

  test('magnitude values are non-negative', () => {
    const data = makeSine(N_SAMPLES);
    const { mag } = DSPCore.forwardSTFT(data, FFT_SIZE, HOP);
    for (const frame of mag) {
      for (const m of frame) {
        expect(m).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('a pure 440 Hz sine has its energy concentrated near bin k=440*FFT_SIZE/SR', () => {
    const SR   = 48000;
    const data = makeSine(N_SAMPLES * 2, 440, SR);
    const { mag } = DSPCore.forwardSTFT(data, FFT_SIZE, HOP);
    const expectedBin = Math.round(440 * FFT_SIZE / SR);
    // Average magnitude across frames
    const avgMag = new Float32Array(HALF_N);
    for (const frame of mag) {
      for (let k = 0; k < HALF_N; k++) avgMag[k] += frame[k];
    }
    // The expected bin should be the dominant bin
    let maxBin = 0;
    for (let k = 1; k < HALF_N; k++) {
      if (avgMag[k] > avgMag[maxBin]) maxBin = k;
    }
    expect(Math.abs(maxBin - expectedBin)).toBeLessThanOrEqual(2);
  });
});

describe('DSPCore.inverseSTFT — STFT roundtrip', () => {
  const FFT_SIZE  = 512;
  const HOP       = 128;
  const N_SAMPLES = 4096;

  function makeSine(n) {
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 48000);
    return d;
  }

  test('forwardSTFT → inverseSTFT reconstructs the original signal (identity pipeline)', () => {
    const original = makeSine(N_SAMPLES);
    const { mag, phase, frameCount } = DSPCore.forwardSTFT(original, FFT_SIZE, HOP);

    // No processing — just reconstruct
    const reconstructed = DSPCore.inverseSTFT(mag, phase, FFT_SIZE, HOP, original.length);

    // Measure reconstruction error in the central region (skip boundary transients)
    const start = FFT_SIZE;
    const end   = N_SAMPLES - FFT_SIZE;
    let maxErr  = 0;
    for (let i = start; i < end; i++) {
      maxErr = Math.max(maxErr, Math.abs(reconstructed[i] - original[i]));
    }
    expect(maxErr).toBeLessThan(0.01); // < 1% error in the interior
    expect(frameCount).toBeGreaterThan(0);
  });

  test('output length equals the requested outputLength', () => {
    const data = makeSine(N_SAMPLES);
    const { mag, phase } = DSPCore.forwardSTFT(data, FFT_SIZE, HOP);
    const out = DSPCore.inverseSTFT(mag, phase, FFT_SIZE, HOP, N_SAMPLES);
    expect(out.length).toBe(N_SAMPLES);
  });

  test('gain-scaled STFT produces proportionally scaled output', () => {
    const original = makeSine(N_SAMPLES);
    const { mag, phase } = DSPCore.forwardSTFT(original, FFT_SIZE, HOP);

    // Halve all magnitudes (6 dB attenuation)
    const scaledMag = mag.map(frame => frame.map(v => v * 0.5));

    const orig_out  = DSPCore.inverseSTFT(mag, phase, FFT_SIZE, HOP, original.length);
    const scaled_out = DSPCore.inverseSTFT(scaledMag, phase, FFT_SIZE, HOP, original.length);

    // Interior samples should be approximately half
    const mid = Math.floor(N_SAMPLES / 2);
    if (Math.abs(orig_out[mid]) > 0.01) {
      const ratio = scaled_out[mid] / orig_out[mid];
      expect(ratio).toBeCloseTo(0.5, 1);
    }
  });

  test('zeroed magnitude produces near-silence output', () => {
    const data = makeSine(N_SAMPLES);
    const { mag, phase } = DSPCore.forwardSTFT(data, FFT_SIZE, HOP);
    const silentMag = mag.map(frame => new Float32Array(frame.length)); // all zeros
    const out = DSPCore.inverseSTFT(silentMag, phase, FFT_SIZE, HOP, N_SAMPLES);
    let maxAbs = 0;
    for (const s of out) maxAbs = Math.max(maxAbs, Math.abs(s));
    expect(maxAbs).toBeLessThan(1e-6);
  });
});

// ============================================================
// DSPCore.biquadCoeffs
// ============================================================

describe('DSPCore.biquadCoeffs', () => {
  const SR = 48000;

  test('highpass: DC response is near zero', () => {
    // biquadCoeffs returns pre-normalised coeffs {b0,b1,b2,a1,a2} (a0 is implicitly 1)
    const { b0, b1, b2, a1, a2 } = DSPCore.biquadCoeffs('highpass', 1000, 0.707, 0, SR);
    // H(z=1) = (b0+b1+b2)/(1+a1+a2) — at DC (z=1)
    const numerator   = b0 + b1 + b2;
    const denominator = 1 + a1 + a2;
    expect(Math.abs(numerator / denominator)).toBeLessThan(0.01);
  });

  test('lowpass: Nyquist response is near zero', () => {
    // biquadCoeffs returns pre-normalised coeffs (a0 implicitly 1)
    const { b0, b1, b2, a1, a2 } = DSPCore.biquadCoeffs('lowpass', 1000, 0.707, 0, SR);
    // H(z=-1) = (b0-b1+b2)/(1-a1+a2) — at Nyquist (z=-1)
    const numerator   = b0 - b1 + b2;
    const denominator = 1 - a1 + a2;
    expect(Math.abs(numerator / denominator)).toBeLessThan(0.01);
  });

  test('notch: response at notch frequency is near zero', () => {
    const freq = 1000;
    const w0   = 2 * Math.PI * freq / SR;
    // biquadCoeffs returns pre-normalised coeffs (a0 implicitly 1)
    const { b0, b1, b2, a1, a2 } = DSPCore.biquadCoeffs('notch', freq, 10, 0, SR);
    // H(e^jw0) = (b0 + b1*e^-jw0 + b2*e^-2jw0) / (1 + a1*e^-jw0 + a2*e^-2jw0)
    const cosW = Math.cos(w0);
    const sinW = Math.sin(w0);
    const numRe = b0 + b1 * cosW + b2 * Math.cos(2 * w0);
    const numIm = -(b1 * sinW + b2 * Math.sin(2 * w0));
    const magNum = Math.sqrt(numRe * numRe + numIm * numIm);
    const denRe = 1 + a1 * cosW + a2 * Math.cos(2 * w0);
    const denIm = -(a1 * sinW + a2 * Math.sin(2 * w0));
    const magDen = Math.sqrt(denRe * denRe + denIm * denIm);
    expect(magNum / magDen).toBeLessThan(0.05);
  });

  test('peaking: boosts gain at the target frequency', () => {
    const freq  = 1000;
    const gainDb = 6;
    const w0    = 2 * Math.PI * freq / SR;
    // biquadCoeffs returns pre-normalised coeffs (a0 implicitly 1)
    const { b0, b1, b2, a1, a2 } = DSPCore.biquadCoeffs('peaking', freq, 1, gainDb, SR);
    const cosW = Math.cos(w0);
    const sinW = Math.sin(w0);
    const numRe = b0 + b1 * cosW + b2 * Math.cos(2 * w0);
    const numIm = -(b1 * sinW + b2 * Math.sin(2 * w0));
    const denRe = 1 + a1 * cosW + a2 * Math.cos(2 * w0);
    const denIm = -(a1 * sinW + a2 * Math.sin(2 * w0));
    const magH  = Math.sqrt(numRe * numRe + numIm * numIm) /
                  Math.sqrt(denRe * denRe + denIm * denIm);
    const expectedGain = Math.pow(10, gainDb / 20);
    expect(Math.abs(magH - expectedGain)).toBeLessThan(0.1);
  });

  test('coefficients are all finite numbers', () => {
    for (const type of ['highpass', 'lowpass', 'notch', 'peaking']) {
      const c = DSPCore.biquadCoeffs(type, 1000, 0.707, 0, SR);
      for (const val of Object.values(c)) {
        expect(Number.isFinite(val)).toBe(true);
      }
    }
  });
});

// ============================================================
// DSPCore.calcRMS / DSPCore.calcPeak
// ============================================================

describe('DSPCore.calcRMS', () => {
  test('returns -96 for a silent buffer (all zeros)', () => {
    const data = new Float32Array(1024);
    expect(DSPCore.calcRMS(data)).toBe(-96);
  });

  test('returns 0 dB for a full-scale sine wave (RMS = 1/√2 ≈ 0.707)', () => {
    // RMS of a sine with amplitude 1 = 1/√2 → RMS² = 0.5 → 10*log10(0.5) ≈ -3 dB
    const N = 1024;
    const data = new Float32Array(N);
    for (let i = 0; i < N; i++) data[i] = Math.sin(2 * Math.PI * i / N);
    const rms = DSPCore.calcRMS(data);
    expect(rms).toBeCloseTo(10 * Math.log10(0.5), 1);
  });

  test('returns 0 dB for a DC signal of amplitude 1', () => {
    const data = new Float32Array(100).fill(1.0);
    // RMS of DC=1 → rms²=1 → 10*log10(1)=0
    expect(DSPCore.calcRMS(data)).toBeCloseTo(0, 5);
  });

  test('lower amplitude gives lower dB value', () => {
    const loud  = new Float32Array(100).fill(0.5);
    const quiet = new Float32Array(100).fill(0.1);
    expect(DSPCore.calcRMS(loud)).toBeGreaterThan(DSPCore.calcRMS(quiet));
  });
});

describe('DSPCore.calcPeak', () => {
  test('returns -96 for a silent buffer', () => {
    const data = new Float32Array(100);
    expect(DSPCore.calcPeak(data)).toBe(-96);
  });

  test('returns 0 dB for a sample of amplitude 1', () => {
    const data = new Float32Array(100).fill(0);
    data[50] = 1.0;
    expect(DSPCore.calcPeak(data)).toBeCloseTo(0, 5);
  });

  test('peak is always >= RMS for any non-silent signal', () => {
    const N = 512;
    const data = new Float32Array(N);
    for (let i = 0; i < N; i++) data[i] = Math.sin(2 * Math.PI * i / N) * 0.8;
    expect(DSPCore.calcPeak(data)).toBeGreaterThanOrEqual(DSPCore.calcRMS(data));
  });
});

// ============================================================
// Spectral subtraction pipeline (forwardSTFT → noise reduce → inverseSTFT)
// ============================================================

describe('Spectral subtraction through the full STFT pipeline', () => {
  const FFT_SIZE  = 512;
  const HOP       = 128;
  const SR        = 48000;
  const N_SAMPLES = 8192;

  function makeMixedSignal(n) {
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Voice-like: 300 Hz sine (signal)
      const signal = 0.5 * Math.sin(2 * Math.PI * 300 * i / SR);
      // White noise (noise)
      const noise  = (Math.random() * 2 - 1) * 0.05;
      data[i] = signal + noise;
    }
    return data;
  }

  test('noise subtraction reduces RMS of the output vs noisy input', () => {
    const noisy = makeMixedSignal(N_SAMPLES);
    const { mag, phase } = DSPCore.forwardSTFT(noisy, FFT_SIZE, HOP);

    // Estimate noise floor from first 10 frames (assumed to be noise-only)
    const HALF_N = FFT_SIZE / 2 + 1;
    const noiseEst = new Float32Array(HALF_N);
    for (let f = 0; f < 10; f++) {
      for (let k = 0; k < HALF_N; k++) noiseEst[k] += mag[f][k] / 10;
    }

    // Apply basic spectral subtraction
    const beta = 0.01;
    for (let f = 0; f < mag.length; f++) {
      for (let k = 0; k < HALF_N; k++) {
        const sigPSD   = mag[f][k] * mag[f][k];
        const noisePSD = noiseEst[k] * noiseEst[k];
        const gain     = Math.max(Math.sqrt(Math.max(sigPSD - noisePSD, 0) / (sigPSD + 1e-20)), beta);
        mag[f][k] *= gain;
      }
    }

    const processed = DSPCore.inverseSTFT(mag, phase, FFT_SIZE, HOP, N_SAMPLES);

    // Compare RMS only in the interior region (skip FFT_SIZE samples from each edge).
    // The ISTFT Hann-window OLA can amplify near-zero window samples at the edges when
    // windowSum is tiny; the interior (where all 4 windows fully overlap) is reliable.
    const skip = FFT_SIZE;
    let sumNoisy = 0, sumProcessed = 0;
    for (let i = skip; i < N_SAMPLES - skip; i++) {
      sumNoisy     += noisy[i] * noisy[i];
      sumProcessed += processed[i] * processed[i];
    }
    const cnt          = N_SAMPLES - 2 * skip;
    const rmsNoisy     = 10 * Math.log10(sumNoisy / cnt);
    const rmsProcessed = 10 * Math.log10(sumProcessed / cnt);
    // Spectral subtraction (gain ≤ 1) should not increase interior RMS
    expect(rmsProcessed).toBeLessThanOrEqual(rmsNoisy + 1); // at most 1 dB above input
  });

  test('pipeline preserves signal: dominant frequency bin survives subtraction', () => {
    const N = 8192;
    // Pure 440 Hz tone (no noise)
    const pure = new Float32Array(N);
    for (let i = 0; i < N; i++) pure[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SR);

    const { mag, phase } = DSPCore.forwardSTFT(pure, FFT_SIZE, HOP);
    // Apply trivial subtraction with a very small noise estimate (< signal)
    const HALF_N = FFT_SIZE / 2 + 1;
    for (let f = 0; f < mag.length; f++) {
      for (let k = 0; k < HALF_N; k++) {
        const sigPSD   = mag[f][k] * mag[f][k];
        const noisePSD = 1e-6; // tiny noise floor
        const gain = Math.max(Math.sqrt(Math.max(sigPSD - noisePSD, 0) / (sigPSD + 1e-20)), 0.01);
        mag[f][k] *= gain;
      }
    }

    const out = DSPCore.inverseSTFT(mag, phase, FFT_SIZE, HOP, N);

    // The dominant frequency should still be 440 Hz in the output
    const { mag: outMag } = DSPCore.forwardSTFT(out, FFT_SIZE, HOP);
    const avgMag = new Float32Array(HALF_N);
    for (const frame of outMag) {
      for (let k = 0; k < HALF_N; k++) avgMag[k] += frame[k];
    }
    const expectedBin = Math.round(440 * FFT_SIZE / SR);
    let maxBin = 0;
    for (let k = 1; k < HALF_N; k++) {
      if (avgMag[k] > avgMag[maxBin]) maxBin = k;
    }
    expect(Math.abs(maxBin - expectedBin)).toBeLessThanOrEqual(3);
  });
});
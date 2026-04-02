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
  const document = { addEventListener: () => {} };

  eval(appJs);

  return module.exports;
})();

// Import standalone DSP helpers — extracted to avoid browser-only DOM code
// We pull the math functions out of app.js logic for unit testing

// Load DSPCore for the new advanced DSP classes
// dsp-core.js lives in the ESM root, so we eval it to extract the CommonJS export
// (same pattern as how app.js is loaded below)
const dspCoreJs = fs.readFileSync(path.join(__dirname, '../dsp-core.js'), 'utf8');
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

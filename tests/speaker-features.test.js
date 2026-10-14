'use strict';
/**
 * Speaker-embedding front end (src/workers/SpeakerFeatures.js): Kaldi fbank
 * pinned to kaldi-native-fbank, 16 kHz resampler, per-window CMN.
 */
const fs = require('fs');
const path = require('path');

// Classic-worker script: run it with `self` bound to a scope, as importScripts would.
const scope = {};
new Function('self', fs.readFileSync(path.join(__dirname, '../src/workers/SpeakerFeatures.js'), 'utf8'))(scope);
const F = scope.VipSpeakerFeatures;
const REF = require('./fixtures/kaldi-fbank-reference.json');

/** The fixture's signal: same formula and LCG as the generator (BigInt for exact ints). */
function referenceSignal() {
  const n = 9600;
  const x = new Float32Array(n);
  let seed = 12345n;
  for (let i = 0; i < n; i++) {
    seed = (1103515245n * seed + 12345n) % 2147483648n;
    const noise = Number(seed) / 2147483648 - 0.5;
    const t = i / 16000;
    x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.1 * Math.sin(2 * Math.PI * 1700 * t)
      + 0.15 * Math.sin(2 * Math.PI * (300 * t + (2700 / (2 * 0.6)) * t * t)) + 0.02 * noise;
  }
  return x;
}

function tone(freq, sr, seconds, amp = 0.5) {
  const x = new Float32Array(Math.round(sr * seconds));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return x;
}

const rms = (x, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
};

describe('kaldiFbank', () => {
  test('matches kaldi-native-fbank to 1e-3 (log domain)', () => {
    const { data, frames } = F.kaldiFbank(referenceSignal(), { cmn: false });
    expect(frames).toBe(REF.frames);
    let worst = 0;
    REF.rows.forEach((r, k) => {
      for (let m = 0; m < 80; m++) worst = Math.max(worst, Math.abs(data[r * 80 + m] - REF.values[k][m]));
    });
    expect(worst).toBeLessThan(1e-3);
  });

  test('frame count follows snip_edges (25 ms frames, 10 ms shift)', () => {
    expect(F.fbankFrameCount(399)).toBe(0);
    expect(F.fbankFrameCount(400)).toBe(1);
    expect(F.fbankFrameCount(16000)).toBe(98);
  });

  test('CMN zeroes every bin mean', () => {
    const { data, frames } = F.kaldiFbank(referenceSignal());
    for (let m = 0; m < 80; m++) {
      let s = 0;
      for (let f = 0; f < frames; f++) s += data[f * 80 + m];
      expect(Math.abs(s / frames)).toBeLessThan(1e-4);
    }
  });
});

describe('resampleTo16k', () => {
  test('48 kHz → 16 kHz keeps an in-band tone and removes an above-Nyquist one', () => {
    const pass = F.resampleTo16k(tone(1000, 48000, 1), 48000);
    expect(pass.length).toBe(16000);
    expect(rms(pass, 1000, 15000)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    const stop = F.resampleTo16k(tone(10000, 48000, 1), 48000);
    expect(20 * Math.log10(rms(stop, 1000, 15000) / (0.5 / Math.SQRT2))).toBeLessThan(-40);
  });

  test('16 kHz input is returned as is; 44.1 kHz gets the right length', () => {
    const x = tone(440, 16000, 0.5);
    expect(F.resampleTo16k(x, 16000)).toBe(x);
    expect(F.resampleTo16k(tone(440, 44100, 1), 44100).length).toBe(16000);
  });
});

describe('windowFeatures', () => {
  test('equals kaldiFbank with CMN on the same frames', () => {
    const x = referenceSignal();
    const raw = F.kaldiFbank(x, { cmn: false }).data;
    const { data, frames } = F.windowFeatures(raw, [[10, 40], [20, 50]]);
    expect(frames).toBe(30);
    // Window [20, 50) = samples from 20*160 for 29*160+400.
    const alone = F.kaldiFbank(x.subarray(20 * 160, 20 * 160 + 29 * 160 + 400)).data;
    let worst = 0;
    for (let i = 0; i < 30 * 80; i++) worst = Math.max(worst, Math.abs(data[30 * 80 + i] - alone[i]));
    expect(worst).toBeLessThan(1e-4);
  });
});

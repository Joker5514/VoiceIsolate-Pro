'use strict';
/**
 * DSPCore.dereverb computes its late-tail estimate with an O(1) recurrence
 * instead of re-summing the decay window for every bin of every frame (the
 * direct sum took ~31 s on the main thread for 5 min of audio on the DSP
 * fallback). This pins the recurrence to the direct reference it replaced.
 */
const fs = require('fs');
const path = require('path');

function loadCore() {
  const src = fs.readFileSync(path.join(__dirname, '../public/app/dsp-core.js'), 'utf8');
  const module = { exports: {} };
  new Function('module', 'window', 'self', src)(module, undefined, undefined);
  return module.exports;
}

/** The previous direct-sum implementation, verbatim apart from its name. */
function dereverbReference(mag, amount, decaySec, sr, hopSize) {
  if (amount <= 0) return mag;
  const framesPerSec = sr / (hopSize || 1024);
  const decayFrames = Math.max(1, Math.floor(decaySec * framesPerSec));
  const alpha = amount / 100;
  if (mag.length === 0) return mag;
  const numBins = mag[0].length;
  const weights = new Float32Array(decayFrames);
  let weightSum = 0;
  for (let d = 1; d <= decayFrames; d++) {
    weights[d - 1] = Math.exp(-3 * d / decayFrames);
    weightSum += weights[d - 1];
  }
  const history = new Array(decayFrames);
  for (let i = 0; i < decayFrames; i++) history[i] = new Float32Array(numBins);
  let histPos = 0;
  let histFilled = 0;
  for (let f = 0; f < mag.length; f++) {
    const cur = mag[f];
    const slot = history[histPos];
    for (let k = 0; k < numBins; k++) slot[k] = cur[k];
    histPos = (histPos + 1) % decayFrames;
    if (histFilled < decayFrames) histFilled++;
    if (histFilled > decayFrames - 1) {
      for (let k = 0; k < numBins; k++) {
        let reverbEst = 0;
        for (let d = 0; d < decayFrames; d++) {
          const idx = ((histPos - 2 - d) % decayFrames + decayFrames) % decayFrames;
          reverbEst += history[idx][k] * weights[d];
        }
        reverbEst /= weightSum;
        const gain = Math.max(0.1, 1 - alpha * reverbEst / (cur[k] + 1e-10));
        cur[k] *= gain;
      }
    }
  }
  return mag;
}

function spectrogram(frames, bins, seed) {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out = [];
  for (let f = 0; f < frames; f++) {
    const m = new Float32Array(bins);
    // Decaying bursts so the tail estimate actually bites.
    const burst = f % 37 < 4 ? 1 : 0.15;
    for (let k = 0; k < bins; k++) m[k] = burst * (0.2 + rand()) * Math.exp(-k / 300);
    out.push(m);
  }
  return out;
}

const clone = (m) => m.map((f) => new Float32Array(f));

describe('DSPCore.dereverb recurrence', () => {
  const core = loadCore();

  test.each([
    ['desktop hop, default decay', 0.324, 512, 60],
    ['long decay', 0.8, 512, 100],
    ['one-frame window', 0.001, 1024, 35],
    ['two-frame window', 0.03, 1024, 100],
  ])('matches the direct sum (%s)', (_label, decaySec, hop, amount) => {
    const mag = spectrogram(400, 257, 7);
    const ref = dereverbReference(clone(mag), amount, decaySec, 48000, hop);
    const got = core.dereverb(clone(mag), amount, decaySec, 48000, hop);
    let peak = 0;
    let err = 0;
    for (let f = 0; f < ref.length; f++) {
      for (let k = 0; k < ref[f].length; k++) {
        peak = Math.max(peak, Math.abs(ref[f][k]));
        err = Math.max(err, Math.abs(got[f][k] - ref[f][k]));
      }
    }
    expect(peak).toBeGreaterThan(0.1);
    expect(err / peak).toBeLessThan(1e-5);
  });

  test('cost no longer scales with the decay window', () => {
    const mag = spectrogram(3000, 1025, 3);
    const t0 = process.hrtime.bigint();
    core.dereverb(clone(mag), 60, 0.12, 48000, 512);
    const short = Number(process.hrtime.bigint() - t0);
    const t1 = process.hrtime.bigint();
    core.dereverb(clone(mag), 60, 0.8, 48000, 512);
    const long = Number(process.hrtime.bigint() - t1);
    // 0.12 s → 11 frames, 0.8 s → 75 frames: the direct sum was ~7x slower.
    expect(long / short).toBeLessThan(3);
  });
});

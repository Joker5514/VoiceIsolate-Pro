'use strict';
/** Objective audio metrics used by the quality matrix and its regression test. */

const db = (x) => 10 * Math.log10(Math.max(x, 1e-20));

/** Scale-invariant SDR (Le Roux et al. 2019), dB. */
function siSdr(est, ref, mask) {
  let dot = 0; let rr = 0;
  for (let i = 0; i < ref.length; i++) {
    if (mask && !mask[i]) continue;
    dot += est[i] * ref[i];
    rr += ref[i] * ref[i];
  }
  if (rr === 0) return NaN;
  const a = dot / rr;
  let s = 0; let e = 0;
  for (let i = 0; i < ref.length; i++) {
    if (mask && !mask[i]) continue;
    const t = a * ref[i];
    const d = est[i] - t;
    s += t * t; e += d * d;
  }
  return db(s / Math.max(e, 1e-20));
}

function rmsDb(x, mask) {
  let s = 0; let c = 0;
  for (let i = 0; i < x.length; i++) if (!mask || mask[i]) { s += x[i] * x[i]; c++; }
  return db(s / Math.max(1, c));
}

function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
  return p;
}

function nonFinite(x) {
  let c = 0;
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) c++;
  return c;
}

function dcOffset(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return s / Math.max(1, x.length);
}

/** In-place iterative radix-2 complex FFT (n must be a power of two). */
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
    const wr = Math.cos(ang); const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j; const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Mean per-frame energy (dB) in [lo, hi] Hz, Hann frames, no overlap. */
function bandEnergyDb(x, lo, hi, sr = 48000, frame = 2048, mask = null) {
  const k0 = Math.ceil(lo * frame / sr);
  const k1 = Math.min(frame / 2, Math.floor(hi * frame / sr));
  const re = new Float64Array(frame); const im = new Float64Array(frame);
  let total = 0; let frames = 0;
  for (let s = 0; s + frame <= x.length; s += frame) {
    if (mask && !mask[s + (frame >> 1)]) continue;
    for (let i = 0; i < frame; i++) {
      re[i] = x[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / frame));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = k0; k <= k1; k++) total += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  return db(total / Math.max(1, frames));
}

module.exports = { siSdr, rmsDb, peak, nonFinite, dcOffset, bandEnergyDb, db };

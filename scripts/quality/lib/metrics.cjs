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

/** Plain SDR (not scale-invariant), dB. Complements siSdr: SI-SDR forgives
 *  overall gain, SDR does not, so a chain that merely attenuates scores
 *  worse here. Returns NaN when the reference is silent. */
function sdr(est, ref, mask) {
  let rr = 0; let e = 0;
  for (let i = 0; i < ref.length; i++) {
    if (mask && !mask[i]) continue;
    rr += ref[i] * ref[i];
    const d = est[i] - ref[i];
    e += d * d;
  }
  if (rr === 0) return NaN;
  return db(rr / Math.max(e, 1e-20));
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

/**
 * Mean per-frame energy (dB) in [lo, hi] Hz, Hann frames, no overlap.
 * With `mask`, a frame counts when its centre sample is active, and masked-out
 * samples inside it are zeroed so energy outside the mask cannot leak in.
 */
function bandEnergyDb(x, lo, hi, sr = 48000, frame = 2048, mask = null) {
  const k0 = Math.ceil(lo * frame / sr);
  const k1 = Math.min(frame / 2, Math.floor(hi * frame / sr));
  const re = new Float64Array(frame); const im = new Float64Array(frame);
  let total = 0; let frames = 0;
  for (let s = 0; s + frame <= x.length; s += frame) {
    if (mask && !mask[s + (frame >> 1)]) continue;
    for (let i = 0; i < frame; i++) {
      const v = mask && !mask[s + i] ? 0 : x[s + i];
      re[i] = v * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / frame));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = k0; k <= k1; k++) total += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  return db(total / Math.max(1, frames));
}

module.exports = { fft, siSdr, sdr, rmsDb, peak, nonFinite, dcOffset, bandEnergyDb, db, stoi, estoi, compareAudio };

/* ------------------------------------------------------------------ */
/* STOI / ESTOI (MET-01)                                               */
/*                                                                     */
/* Extended STOI (Jensen & Taal, IEEE TASLP 2016) and ordinary STOI   */
/* (Taal et al., ICASSP 2010 / IEEE TASLP 2011), ported from the       */
/* pinned reference oracle pystoi 0.4.1 (see                           */
/* scripts/quality/estoi-oracle.py and estoi-requirements.txt). The    */
/* port mirrors the reference step by step — Octave-compatible         */
/* polyphase resampling to 10 kHz, silence-frame removal, Hann STFT,   */
/* 1/3-octave-band energies, 30-frame segments, per-segment            */
/* normalisation/clipping (STOI) or row+column normalisation (ESTOI)   */
/* — so the JS scores can be checked against pystoi to <= 1e-4 on the  */
/* pinned fixtures in scripts/quality/fixtures/estoi/.                 */
/*                                                                     */
/* LIMITATION: ESTOI is only valid on aligned clean-reference /        */
/* degraded pairs. It is NOT valid on field recordings without a clean */
/* reference (e.g. the Drive-video clips); use reference-free metrics  */
/* there instead. The implementation does no alignment search: like    */
/* the reference it requires equal-length inputs, and a time-shifted   */
/* degraded signal simply scores lower.                                */
/*                                                                     */
/* No global normalisation is applied to the inputs: the only          */
/* normalisation is the algorithm's own per-segment normalisation, so  */
/* a meaningful degradation (noise, clipping, shift) cannot be         */
/* silently normalised away.                                           */
/* ------------------------------------------------------------------ */

const ESTOI_FS = 10000; // reference sample rate (Hz)
const ESTOI_N_FRAME = 256; // STFT window (samples at 10 kHz)
const ESTOI_NFFT = 512;
const ESTOI_NUMBAND = 15; // 1/3-octave bands
const ESTOI_MINFREQ = 150; // centre of the lowest band (Hz)
const ESTOI_N_SEGMENT = 30; // frames per intermediate-intelligibility segment
const ESTOI_BETA = -15; // STOI lower SDR bound (dB)
const ESTOI_DYN_RANGE = 40; // silence-removal dynamic range (dB)
const ESTOI_FALLBACK = 1e-5; // pystoi's value when <30 usable frames remain
const ESTOI_EPS = 2.220446049250313e-16; // float64 eps (numpy finfo(float).eps)
// Minimum resampled length that can yield 30 STFT frames:
// frames = ceil((len - 256) / 128) >= 30  <=>  len >= 3969.
const ESTOI_MIN_LEN = 3969;

function estoiValidate(ref, deg, sampleRate, fnName) {
  if (!ref || !deg || typeof ref.length !== 'number' || typeof deg.length !== 'number') {
    throw new Error(`${fnName}: reference and degraded must be array-like (got ${typeof ref} / ${typeof deg})`);
  }
  if (ref.length === 0 || deg.length === 0) {
    throw new Error(`${fnName}: empty input (reference ${ref.length} samples, degraded ${deg.length} samples)`);
  }
  if (ref.length !== deg.length) {
    throw new Error(`${fnName}: reference and degraded must have the same length (got ${ref.length} and ${deg.length}); align them before scoring — no alignment search is performed`);
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isInteger(sampleRate)) {
    throw new Error(`${fnName}: sampleRate must be a positive integer (got ${sampleRate})`);
  }
  for (let i = 0; i < ref.length; i++) {
    if (!Number.isFinite(ref[i])) throw new Error(`${fnName}: reference contains a non-finite sample at index ${i}`);
    if (!Number.isFinite(deg[i])) throw new Error(`${fnName}: degraded contains a non-finite sample at index ${i}`);
  }
}

function gcdInt(a, b) {
  a = Math.abs(Math.trunc(a)); b = Math.abs(Math.trunc(b));
  while (b !== 0) { const t = a % b; a = b; b = t; }
  return a;
}

/** Modified Bessel function I0 via its power series. Matches
 *  scipy.special.i0 to float64 rounding (checked: I0(5.65434) agrees
 *  to the last printed digit). */
function besselI0(x) {
  const y = (x * x) / 4;
  let sum = 1; let term = 1;
  for (let k = 1; k < 100; k++) {
    term *= y / (k * k);
    sum += term;
    if (term < sum * 1e-18) break;
  }
  return sum;
}

function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Kaiser window, np.kaiser(M, beta). */
function kaiserWindow(m, beta) {
  const denom = besselI0(beta);
  const out = new Float64Array(m);
  for (let n = 0; n < m; n++) {
    const r = (2 * n) / (m - 1) - 1;
    out[n] = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / denom;
  }
  return out;
}

/** pystoi.utils._resample_window_oct(p, q): Kaiser-windowed sinc
 *  low-pass, normalised to unit sum. p/q are the (unreduced) resample
 *  factors; the reduction by gcd happens here, as in the reference. */
function resampleWindowOct(p, q) {
  const g = gcdInt(p, q);
  p /= g; q /= g;
  const log10Rejection = -3.0;
  const stopbandCutoff = 1.0 / (2 * Math.max(p, q));
  const rollOff = stopbandCutoff / 10;
  const rejectionDb = -20 * log10Rejection; // 60
  const L = Math.ceil((rejectionDb - 8) / (28.714 * rollOff));
  let beta;
  if (rejectionDb >= 21 && rejectionDb <= 50) {
    beta = 0.5842 * Math.pow(rejectionDb - 21, 0.4) + 0.07886 * (rejectionDb - 21);
  } else if (rejectionDb > 50) {
    beta = 0.1102 * (rejectionDb - 8.7);
  } else {
    beta = 0;
  }
  const kaiser = kaiserWindow(2 * L + 1, beta);
  const h = new Float64Array(2 * L + 1);
  let sum = 0;
  for (let i = 0; i <= 2 * L; i++) {
    const t = i - L;
    h[i] = kaiser[i] * (2 * p * stopbandCutoff) * sinc(2 * stopbandCutoff * t);
    sum += h[i];
  }
  for (let i = 0; i <= 2 * L; i++) h[i] /= sum;
  return h;
}

/** scipy.signal.resample_poly(x, up, down, window) with a caller-supplied
 *  FIR window, zero padding (padtype 'constant'). Mirrors scipy's
 *  centring: the filter is pre-padded so the output is zero-phase, and
 *  the first nPreRemove downsampled outputs are dropped. Computed
 *  directly in polyphase form (only the kept outputs are evaluated),
 *  which is arithmetically identical to upsample -> FIR -> downsample.
 *  Trailing zero post-padding in scipy contributes nothing and is
 *  skipped. */
function resamplePoly(x, up, down, window) {
  const g = gcdInt(up, down);
  up /= g; down /= g;
  if (up === 1 && down === 1) return Float64Array.from(x);
  const nIn = x.length;
  const nOut = Math.ceil((nIn * up) / down);
  const halfLen = (window.length - 1) >> 1;
  const h = new Float64Array(window.length);
  for (let i = 0; i < window.length; i++) h[i] = window[i] * up;
  const nPrePad = down - (halfLen % down);
  const nPreRemove = Math.floor((halfLen + nPrePad) / down);
  const hLen = h.length;
  const out = new Float64Array(nOut);
  for (let m = 0; m < nOut; m++) {
    const n = (m + nPreRemove) * down;
    // y[m] = sum_i hPad[n - up*i] * x[i]; hPad is nPrePad zeros + h.
    let iMin = Math.floor((n - (nPrePad + hLen)) / up) + 1;
    let iMax = Math.floor(n / up);
    if (iMin < 0) iMin = 0;
    if (iMax > nIn - 1) iMax = nIn - 1;
    let acc = 0;
    for (let i = iMin; i <= iMax; i++) {
      const j = n - up * i - nPrePad;
      if (j >= 0 && j < hLen) acc += h[j] * x[i];
    }
    out[m] = acc;
  }
  return out;
}

/** pystoi.utils.thirdoct(10000, 512, 15, 150): 15 x 257 binary matrix
 *  mapping FFT bins to 1/3-octave bands. Cached; argmin keeps the first
 *  minimum on ties, as np.argmin does. */
let obmCache = null;
function thirdOctaveMatrix() {
  if (obmCache) return obmCache;
  const nFreq = ESTOI_NFFT / 2 + 1; // 257
  const f = new Float64Array(nFreq);
  for (let k = 0; k < nFreq; k++) f[k] = (k * ESTOI_FS) / ESTOI_NFFT;
  const obm = [];
  for (let i = 0; i < ESTOI_NUMBAND; i++) {
    const freqLow = ESTOI_MINFREQ * Math.pow(2, (2 * i - 1) / 6);
    const freqHigh = ESTOI_MINFREQ * Math.pow(2, (2 * i + 1) / 6);
    let fl = 0; let bestLo = Infinity;
    let fh = 0; let bestHi = Infinity;
    for (let k = 0; k < nFreq; k++) {
      const dLo = (f[k] - freqLow) * (f[k] - freqLow);
      if (dLo < bestLo) { bestLo = dLo; fl = k; }
      const dHi = (f[k] - freqHigh) * (f[k] - freqHigh);
      if (dHi < bestHi) { bestHi = dHi; fh = k; }
    }
    const row = new Float64Array(nFreq);
    for (let k = fl; k < fh; k++) row[k] = 1;
    obm.push(row);
  }
  obmCache = obm;
  return obm;
}

/** np.hanning(258)[1:-1]: the symmetric Hann window pystoi uses for
 *  both silence detection and the STFT (NOT the periodic Hann used
 *  elsewhere in this file). */
function hannWindowSymmetric(n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (n + 1));
  return out;
}

/** pystoi.utils.stft: Hann frames of 256, hop 128, 512-point rFFT.
 *  Returns an array of per-frame magnitude arrays (bins 0..256). */
function estoiStft(x) {
  const hop = ESTOI_N_FRAME >> 1;
  const w = hannWindowSymmetric(ESTOI_N_FRAME);
  const frames = [];
  const re = new Float64Array(ESTOI_NFFT);
  const im = new Float64Array(ESTOI_NFFT);
  for (let start = 0; start < x.length - ESTOI_N_FRAME; start += hop) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < ESTOI_N_FRAME; i++) re[i] = w[i] * x[start + i];
    fft(re, im);
    const mag = new Float64Array(ESTOI_NFFT / 2 + 1);
    for (let k = 0; k <= ESTOI_NFFT / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    frames.push(mag);
  }
  return frames;
}

/** pystoi.utils.remove_silent_frames: drop Hann frames whose energy is
 *  more than 40 dB below the loudest frame (judged on the reference
 *  only), then overlap-add the surviving frames back into a continuous
 *  signal (verified identical to pystoi's _overlap_and_add). Returns
 *  the reconstructed pair; the caller checks the frame count. */
function removeSilentFrames(x, y) {
  const frameLen = ESTOI_N_FRAME;
  const hop = frameLen >> 1;
  const w = hannWindowSymmetric(frameLen);
  const xFrames = []; const yFrames = [];
  for (let start = 0; start < x.length - frameLen; start += hop) {
    const xf = new Float64Array(frameLen); const yf = new Float64Array(frameLen);
    for (let i = 0; i < frameLen; i++) { xf[i] = w[i] * x[start + i]; yf[i] = w[i] * y[start + i]; }
    xFrames.push(xf); yFrames.push(yf);
  }
  let maxE = -Infinity;
  const energies = new Float64Array(xFrames.length);
  for (let f = 0; f < xFrames.length; f++) {
    let s = 0;
    for (let i = 0; i < frameLen; i++) s += xFrames[f][i] * xFrames[f][i];
    const e = 20 * Math.log10(Math.sqrt(s) + ESTOI_EPS);
    energies[f] = e;
    if (e > maxE) maxE = e;
  }
  const kept = [];
  for (let f = 0; f < xFrames.length; f++) {
    if (maxE - ESTOI_DYN_RANGE - energies[f] < 0) kept.push(f);
  }
  const outLen = kept.length === 0 ? 0 : (kept.length - 1) * hop + frameLen;
  const xSil = new Float64Array(outLen); const ySil = new Float64Array(outLen);
  for (let k = 0; k < kept.length; k++) {
    const f = kept[k]; const off = k * hop;
    for (let i = 0; i < frameLen; i++) { xSil[off + i] += xFrames[f][i]; ySil[off + i] += yFrames[f][i]; }
  }
  return { xSil, ySil, keptFrames: kept.length };
}

/** 1/3-octave-band magnitudes: tob[band][frame] =
 *  sqrt(sum_k OBM[band][k] * |spec[frame][k]|^2). */
function thirdOctaveBands(frames) {
  const obm = thirdOctaveMatrix();
  const nFrames = frames.length;
  const nBins = ESTOI_NFFT / 2 + 1;
  const tob = [];
  for (let b = 0; b < ESTOI_NUMBAND; b++) {
    const row = obm[b];
    const bins = [];
    for (let k = 0; k < nBins; k++) if (row[k]) bins.push(k);
    const band = new Float64Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      const mag = frames[f];
      let s = 0;
      for (const k of bins) s += mag[k] * mag[k];
      band[f] = Math.sqrt(s);
    }
    tob.push(band);
  }
  return tob;
}

/** One 15 x 30 segment starting at frame j: seg[band][t]. */
function takeSegment(tob, j) {
  const seg = [];
  for (let b = 0; b < ESTOI_NUMBAND; b++) {
    const row = new Float64Array(ESTOI_N_SEGMENT);
    for (let t = 0; t < ESTOI_N_SEGMENT; t++) row[t] = tob[b][j + t];
    seg.push(row);
  }
  return seg;
}

/** pystoi.utils.row_col_normalize, without its unseeded EPS-scale
 *  random dither (which makes the reference non-deterministic on
 *  degenerate all-zero segments — see the silence note below).
 *  Row: subtract the row mean, scale each row to unit norm. Column:
 *  subtract the column mean, scale each column to unit norm. A row or
 *  column that is exactly zero after mean removal is left at zero
 *  instead of dividing by zero; that is the zero-noise limit of the
 *  reference behaviour and keeps silence deterministic. */
function rowColNormalize(seg) {
  const n = ESTOI_N_SEGMENT;
  const out = seg.map((row) => Float64Array.from(row));
  for (let b = 0; b < ESTOI_NUMBAND; b++) {
    const row = out[b];
    let mean = 0;
    for (let t = 0; t < n; t++) mean += row[t];
    mean /= n;
    let ss = 0;
    for (let t = 0; t < n; t++) { row[t] -= mean; ss += row[t] * row[t]; }
    const norm = Math.sqrt(ss);
    if (norm > 0) { const inv = 1 / norm; for (let t = 0; t < n; t++) row[t] *= inv; }
  }
  for (let t = 0; t < n; t++) {
    let mean = 0;
    for (let b = 0; b < ESTOI_NUMBAND; b++) mean += out[b][t];
    mean /= ESTOI_NUMBAND;
    let ss = 0;
    for (let b = 0; b < ESTOI_NUMBAND; b++) { out[b][t] -= mean; ss += out[b][t] * out[b][t]; }
    const norm = Math.sqrt(ss);
    if (norm > 0) { const inv = 1 / norm; for (let b = 0; b < ESTOI_NUMBAND; b++) out[b][t] *= inv; }
  }
  return out;
}

function rowNorm(row) {
  let s = 0;
  for (let t = 0; t < row.length; t++) s += row[t] * row[t];
  return Math.sqrt(s);
}

/** Shared front-end: validation, resampling to 10 kHz, silence removal,
 *  STFT, 1/3-octave bands. Returns null when fewer than 30 usable
 *  frames remain (the caller's fallback applies). */
function stoiEstoiFrontEnd(ref, deg, sampleRate, fnName) {
  estoiValidate(ref, deg, sampleRate, fnName);
  let x = Float64Array.from(ref);
  let y = Float64Array.from(deg);
  if (sampleRate !== ESTOI_FS) {
    const window = resampleWindowOct(ESTOI_FS, sampleRate);
    x = resamplePoly(x, ESTOI_FS, sampleRate, window);
    y = resamplePoly(y, ESTOI_FS, sampleRate, window);
  }
  if (x.length < ESTOI_MIN_LEN) {
    throw new Error(`${fnName}: input too short (${x.length} samples at 10 kHz after resampling; need at least ${ESTOI_MIN_LEN} to form ${ESTOI_N_SEGMENT} STFT frames)`);
  }
  const { xSil, ySil } = removeSilentFrames(x, y);
  const xFrames = estoiStft(xSil);
  const yFrames = estoiStft(ySil);
  if (xFrames.length < ESTOI_N_SEGMENT) {
    // Matches pystoi, which returns 1e-5 with a warning here. This is
    // reached for (near-)silent inputs whose surviving frames are too
    // few to form a segment — not for structurally short input, which
    // throws above. NOTE: pystoi's ESTOI on all-silence input is
    // non-deterministic (its row/column normalisation adds unseeded
    // EPS-scale random noise, scattering repeat runs around 0); this
    // implementation deterministically returns 0.0 for all-silence
    // input instead, because every segment is exactly zero after
    // mean removal. The silence fixture in the manifest is exempt
    // from the 1e-4 comparison for exactly this reason.
    return null;
  }
  return { xTob: thirdOctaveBands(xFrames), yTob: thirdOctaveBands(yFrames), nFrames: xFrames.length };
}

/**
 * Extended STOI (Jensen & Taal 2016), in [0, 1]. Higher = more
 * intelligible. Identical reference/degraded scores 1. See the MET-01
 * header comment for the validity limitation (aligned clean-reference
 * pairs only) and the silence behaviour.
 */
function estoi(reference, degraded, sampleRate) {
  const fe = stoiEstoiFrontEnd(reference, degraded, sampleRate, 'estoi');
  if (!fe) return ESTOI_FALLBACK;
  const n = ESTOI_N_SEGMENT;
  const J = fe.nFrames - n + 1;
  let total = 0;
  for (let j = 0; j < J; j++) {
    const xn = rowColNormalize(takeSegment(fe.xTob, j));
    const yn = rowColNormalize(takeSegment(fe.yTob, j));
    let s = 0;
    for (let b = 0; b < ESTOI_NUMBAND; b++) {
      for (let t = 0; t < n; t++) s += xn[b][t] * yn[b][t];
    }
    total += s / n;
  }
  const d = total / J;
  return Math.min(1, Math.max(0, d));
}

/**
 * Ordinary STOI (Taal et al. 2010/2011), in [0, 1]. Same front-end as
 * estoi; per-segment gain normalisation + clipping instead of
 * row/column normalisation. Included because the reference oracle
 * ships both and compareAudio reports both.
 */
function stoi(reference, degraded, sampleRate) {
  const fe = stoiEstoiFrontEnd(reference, degraded, sampleRate, 'stoi');
  if (!fe) return ESTOI_FALLBACK;
  const n = ESTOI_N_SEGMENT;
  const J = fe.nFrames - n + 1;
  const clipValue = Math.pow(10, -ESTOI_BETA / 20);
  let total = 0;
  for (let j = 0; j < J; j++) {
    const xSeg = takeSegment(fe.xTob, j);
    const ySeg = takeSegment(fe.yTob, j);
    for (let b = 0; b < ESTOI_NUMBAND; b++) {
      const xr = xSeg[b]; const yr = ySeg[b];
      const c = rowNorm(xr) / (rowNorm(yr) + ESTOI_EPS);
      const yp = new Float64Array(n);
      let xMean = 0; let yMean = 0;
      for (let t = 0; t < n; t++) {
        yp[t] = Math.min(yr[t] * c, xr[t] * (1 + clipValue));
        xMean += xr[t]; yMean += yp[t];
      }
      xMean /= n; yMean /= n;
      const xc = new Float64Array(n); const yc = new Float64Array(n);
      for (let t = 0; t < n; t++) { xc[t] = xr[t] - xMean; yc[t] = yp[t] - yMean; }
      const xn = rowNorm(xc) + ESTOI_EPS; const yn = rowNorm(yc) + ESTOI_EPS;
      for (let t = 0; t < n; t++) total += (yc[t] / yn) * (xc[t] / xn);
    }
  }
  const d = total / (J * ESTOI_NUMBAND);
  return Math.min(1, Math.max(0, d));
}

/**
 * All three reference-based metrics for one aligned pair.
 * siSdr is scale-invariant (forgives overall gain); stoi/estoi are the
 * intelligibility measures. Throws on the same invalid inputs as
 * stoi/estoi (siSdr itself returns NaN for a silent reference).
 */
function compareAudio(reference, degraded, sampleRate) {
  return {
    siSdr: siSdr(degraded, reference),
    stoi: stoi(reference, degraded, sampleRate),
    estoi: estoi(reference, degraded, sampleRate),
  };
}

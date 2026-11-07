/**
 * VoiceIsolate Pro — bandlimited sample-rate conversion (Layer 1: Core)
 *
 * Kaiser-windowed sinc. The brickwall target is min(fsIn, fsOut) / 2. The
 * transition sits just below that Nyquist (passband edge at 95% of it) so a
 * tone at 18 kHz on a 44.1 kHz file stays in the ripple band, and energy
 * above the lower Nyquist is rejected instead of folding.
 *
 * Each output sample is the inner product of the source with a kernel
 * centered on the exact output time, so the resampler has no group delay.
 * `sourceSpan` is the source range that kernel needs. Callers that resample
 * a window (ChunkedExtraction, CompressedAudioReader) read that span; the
 * same absolute index math then matches a one-shot resample of the file.
 *
 * Pure: no DOM, no Web Audio, no I/O. The classic worker loads the same
 * functions via src/workers/BandlimitedResampler.js (importScripts).
 */
'use strict';

/** Stopband target used to size the Kaiser window. Measured attenuation is higher. */
const ATTEN_DB = 110;
/** Passband edge as a fraction of the lower Nyquist. Stopband edge is the Nyquist. */
const PASSBAND_FRACTION = 0.95;
/** Above this many rational phases the fractional delay is quantized. */
const MAX_PHASES = 2048;
/** Hard cap on the kernel half-width (input samples). The ratios we ship sit under it. */
const MAX_RADIUS = 512;

const BANKS = new Map();

function asRate(value) {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new TypeError('[VIP][BandlimitedResampler] sample rate must be a positive finite number');
  }
  const rate = Math.round(value);
  if (Math.abs(value - rate) > 1e-3) {
    throw new TypeError('[VIP][BandlimitedResampler] sample rate must be an integer number of hertz');
  }
  return rate;
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function kaiserBeta(attenDb) {
  if (attenDb > 50) return 0.1102 * (attenDb - 8.7);
  if (attenDb >= 21) return 0.5842 * ((attenDb - 21) ** 0.4) + 0.07886 * (attenDb - 21);
  return 0;
}

function besselI0(x) {
  let sum = 1;
  let term = 1;
  const quarter = (x * x) * 0.25;
  for (let k = 1; k < 64; k++) {
    term *= quarter / (k * k);
    sum += term;
    if (term < 1e-15 * sum) break;
  }
  return sum;
}

function sinc(x) {
  if (Math.abs(x) < 1e-8) return 1 - ((Math.PI * Math.PI) * x * x) / 6;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

/**
 * n * down = q * up + r, with 0 <= r < up.
 * All three arguments are safe integers for any file this product will open.
 */
function splitMulDiv(n, down, up) {
  const qn = Math.floor(n / up);
  const rn = n - qn * up;
  const prod = rn * down;
  const carry = Math.floor(prod / up);
  return { q: qn * down + carry, r: prod - carry * up };
}

function designBank(fromRate, toRate) {
  const g = gcd(fromRate, toRate);
  const down = fromRate / g;
  const up = toRate / g;
  const nyquist = 0.5 * Math.min(fromRate, toRate);
  const passHz = PASSBAND_FRACTION * nyquist;
  const stopHz = nyquist;
  const fc = 0.5 * (passHz + stopHz);
  const scale = (2 * fc) / fromRate;
  const trans = Math.max(1e-6, (stopHz - passHz) / fromRate);
  const beta = kaiserBeta(ATTEN_DB);
  const nTaps = Math.ceil((ATTEN_DB - 8) / (2.285 * 2 * Math.PI * trans)) + 1;
  const radius = Math.min(MAX_RADIUS, Math.max(8, Math.ceil((nTaps - 1) / 2)));
  const exact = up <= MAX_PHASES;
  const phaseCount = exact ? up : MAX_PHASES;
  const i0beta = besselI0(beta);
  const phases = new Array(phaseCount);
  for (let p = 0; p < phaseCount; p++) {
    const frac = p / phaseCount;
    const h = new Float64Array(radius * 2 + 1);
    let sum = 0;
    for (let j = -radius; j <= radius; j++) {
      const tau = j - frac;
      const r = tau / radius;
      let w = 0;
      if (r > -1 && r < 1) w = besselI0(beta * Math.sqrt(1 - r * r)) / i0beta;
      const coeff = scale * sinc(scale * tau) * w;
      h[j + radius] = coeff;
      sum += coeff;
    }
    const norm = sum !== 0 ? 1 / sum : 1;
    for (let i = 0; i < h.length; i++) h[i] *= norm;
    phases[p] = h;
  }
  return {
    fromRate, toRate, up, down, radius, phases, phaseCount, exact, beta, fc,
  };
}

function bankFor(fromRate, toRate) {
  const key = `${fromRate}/${toRate}`;
  let bank = BANKS.get(key);
  if (!bank) {
    bank = designBank(fromRate, toRate);
    BANKS.set(key, bank);
  }
  return bank;
}

function phaseOf(r, bank) {
  if (bank.exact) return r;
  const frac = r / bank.up;
  let p = Math.round(frac * bank.phaseCount);
  if (p === bank.phaseCount) p = 0;
  return p;
}

/**
 * Source samples [srcStart, srcEnd) that contribute to output frames
 * [canonStart, canonStart + outFrames) at `toRate`. srcStart may be negative
 * at the start of a file; callers clamp to the file.
 */
export function sourceSpan(canonStart, outFrames, fromRate, toRate) {
  const from = asRate(fromRate);
  const to = asRate(toRate);
  const frames = Number.isFinite(outFrames) ? Math.max(0, Math.trunc(outFrames)) : 0;
  if (frames < 1) return { srcStart: 0, srcEnd: 0, radius: 0 };
  if (from === to) {
    return { srcStart: canonStart, srcEnd: canonStart + frames, radius: 0 };
  }
  const bank = bankFor(from, to);
  const first = splitMulDiv(canonStart, bank.down, bank.up).q - bank.radius;
  const last = splitMulDiv(canonStart + frames - 1, bank.down, bank.up).q + bank.radius;
  return { srcStart: first, srcEnd: last + 1, radius: bank.radius };
}

/** Kernel half-width in source samples. Zero when the rates already match. */
export function kernelRadius(fromRate, toRate) {
  const from = asRate(fromRate);
  const to = asRate(toRate);
  if (from === to) return 0;
  return bankFor(from, to).radius;
}

function writeMono(src, srcStart, bank, canonStart, dst) {
  const len = src.length;
  const radius = bank.radius;
  const { down, up } = bank;
  for (let i = 0; i < dst.length; i++) {
    const n = canonStart + i;
    if (n < 0) {
      dst[i] = 0;
      continue;
    }
    const { q, r } = splitMulDiv(n, down, up);
    const h = bank.phases[phaseOf(r, bank)];
    let acc = 0;
    const base = q - srcStart;
    for (let j = -radius; j <= radius; j++) {
      const idx = base + j;
      if (idx >= 0 && idx < len) acc += src[idx] * h[j + radius];
    }
    dst[i] = acc;
  }
}

/**
 * Resample one channel. Output length matches the historical linear resampler:
 * round(length * to / from), at least 1 for a non-empty input.
 * @param {ArrayLike<number>} samples
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resampleMono(samples, fromRate, toRate) {
  const from = asRate(fromRate);
  const to = asRate(toRate);
  const src = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
  if (src.length === 0) return new Float32Array(0);
  if (from === to) return new Float32Array(src);
  const outLen = Math.max(1, Math.round(src.length * (to / from)));
  const dst = new Float32Array(outLen);
  writeMono(src, 0, bankFor(from, to), 0, dst);
  return dst;
}

/**
 * Output frames [canonStart, canonStart + outFrames) at `toRate`, read from a
 * source slice whose sample 0 is absolute source frame `srcStart`. Samples
 * outside the slice are zero, which matches a one-shot resample when the
 * slice covers `sourceSpan`.
 * @returns {Float32Array[]}
 */
export function resampleWindow(channels, srcStart, fromRate, canonStart, outFrames, toRate) {
  const from = asRate(fromRate);
  const to = asRate(toRate);
  const frames = Number.isFinite(outFrames) ? Math.max(0, Math.trunc(outFrames)) : 0;
  const list = channels || [];
  const out = Array.from({ length: list.length }, () => new Float32Array(frames));
  if (!list.length || frames < 1) return out;
  const origin = Math.trunc(srcStart) || 0;
  if (from === to) {
    for (let c = 0; c < list.length; c++) {
      const src = list[c];
      const dst = out[c];
      const n = src ? src.length : 0;
      for (let i = 0; i < frames; i++) {
        const idx = canonStart + i - origin;
        dst[i] = idx >= 0 && idx < n ? src[idx] : 0;
      }
    }
    return out;
  }
  const bank = bankFor(from, to);
  for (let c = 0; c < list.length; c++) {
    const src = list[c] instanceof Float32Array ? list[c] : Float32Array.from(list[c] || []);
    writeMono(src, origin, bank, canonStart, out[c]);
  }
  return out;
}

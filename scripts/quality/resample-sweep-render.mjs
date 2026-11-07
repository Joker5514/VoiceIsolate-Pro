/**
 * Before/after sweep renders for the bandlimited resampler.
 *
 *   node scripts/quality/resample-sweep-render.mjs [outDir]
 *
 * Writes 16-bit WAVs and spectrogram PNGs of a 96 kHz linear sweep
 * (50 Hz → 40 kHz, 2 s) resampled to 48 kHz. "Before" is the removed
 * linear interpolator. "After" is src/core/BandlimitedResampler.js.
 * Default outDir is /opt/cursor/artifacts.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { resampleMono } from '../../src/core/BandlimitedResampler.js';

const outDir = process.argv[2] || '/opt/cursor/artifacts';
const SRC_RATE = 96000;
const DST_RATE = 48000;
const SECONDS = 2;
const F0 = 50;
const F1 = 40000;
const AMP = 0.5;

function sweep() {
  const n = Math.round(SRC_RATE * SECONDS);
  const x = new Float32Array(n);
  const k = (F1 - F0) / SECONDS;
  for (let i = 0; i < n; i++) {
    const t = i / SRC_RATE;
    x[i] = AMP * Math.sin(2 * Math.PI * (F0 * t + 0.5 * k * t * t));
  }
  return x;
}

function legacyLinear(samples, fromRate, toRate) {
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

function writeWav(file, samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(x < 0 ? Math.round(x * 32768) : Math.round(x * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const p = i + k;
        const q = p + half;
        const vr = re[q] * wr - im[q] * wi;
        const vi = re[q] * wi + im[q] * wr;
        re[q] = re[p] - vr;
        im[q] = im[p] - vi;
        re[p] += vr;
        im[p] += vi;
        const nwr = wr * wlenRe - wi * wlenIm;
        wi = wr * wlenIm + wi * wlenRe;
        wr = nwr;
      }
    }
  }
}

function spectrogramPng(samples, sampleRate, file) {
  const nfft = 1024;
  const hop = 128;
  const bins = nfft >> 1;
  const frames = Math.floor((samples.length - nfft) / hop);
  const hann = new Float64Array(nfft);
  for (let i = 0; i < nfft; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nfft);
  const db = new Float64Array(frames * bins);
  let peak = -Infinity;
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < nfft; i++) {
      re[i] = samples[off + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      const mag = Math.hypot(re[b], im[b]) / nfft;
      const v = 20 * Math.log10(mag + 1e-12);
      db[f * bins + b] = v;
      if (v > peak) peak = v;
    }
  }
  const floor = peak - 90;
  const rgb = Buffer.alloc(frames * bins * 3);
  for (let y = 0; y < bins; y++) {
    const bin = bins - 1 - y;
    for (let x = 0; x < frames; x++) {
      const t = Math.max(0, Math.min(1, (db[x * bins + bin] - floor) / (peak - floor)));
      const o = (y * frames + x) * 3;
      rgb[o] = Math.min(255, Math.round(255 * Math.min(1, t * 1.55)));
      rgb[o + 1] = Math.min(255, Math.round(255 * Math.max(0, t * 1.45 - 0.38)));
      rgb[o + 2] = Math.min(255, Math.round(255 * (t < 0.55 ? t * 1.15 : 1 - (t - 0.55) * 1.4)));
    }
  }
  fs.writeFileSync(file, encodePng(frames, bins, rgb));
  return { frames, bins, sampleRate, nfft, hop, peakDb: peak, floorDb: floor };
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    rgb.copy(raw, row + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(outDir, { recursive: true });
const input = sweep();
const before = legacyLinear(input, SRC_RATE, DST_RATE);
const after = resampleMono(input, SRC_RATE, DST_RATE);
const files = {
  beforeWav: path.join(outDir, 'resample-sweep-before-linear.wav'),
  afterWav: path.join(outDir, 'resample-sweep-after-kaiser.wav'),
  beforePng: path.join(outDir, 'resample-sweep-before-linear.png'),
  afterPng: path.join(outDir, 'resample-sweep-after-kaiser.png'),
};
writeWav(files.beforeWav, before, DST_RATE);
writeWav(files.afterWav, after, DST_RATE);
const beforeSpec = spectrogramPng(before, DST_RATE, files.beforePng);
const afterSpec = spectrogramPng(after, DST_RATE, files.afterPng);
console.log(JSON.stringify({
  sweep: { srcRate: SRC_RATE, dstRate: DST_RATE, seconds: SECONDS, f0Hz: F0, f1Hz: F1, amplitude: AMP },
  beforeSpec,
  afterSpec,
  files,
}, null, 2));

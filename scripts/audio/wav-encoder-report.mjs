/**
 * Measured before/after of the shared WAV encoder.
 * Run from the repo root: node scripts/audio/wav-encoder-report.mjs
 * Writes listening files and an error-spectrum plot under /opt/cursor/artifacts
 * when that directory exists, and always prints a JSON measurement record.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { encodeWavArrayBuffer, measureTruePeak, limitTruePeakInPlace } from '../../src/core/WavEncoder.js';

const outDir = fs.existsSync('/opt/cursor/artifacts')
  ? '/opt/cursor/artifacts'
  : path.join(process.cwd(), 'artifacts');
fs.mkdirSync(outDir, { recursive: true });

function legacyTruncate(samples) {
  const pcm = new Int16Array(samples.length);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s * 0x7FFF, true);
    pcm[i] = view.getInt16(i * 2, true);
  }
  return pcm;
}

function readPcm16(buffer) {
  const view = new DataView(buffer);
  const n = (buffer.byteLength - 44) / 2;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(44 + i * 2, true);
  return out;
}

const nCompare = 1000;
const compare = new Float32Array(nCompare);
for (let i = 0; i < nCompare; i++) compare[i] = Math.sin(i * 0.37) * (0.2 + (i % 17) / 40);
const modernCodes = readPcm16(encodeWavArrayBuffer([compare], 48000, { bitDepth: 16, ditherAmt: 0 }).buffer);
const legacyCodes = legacyTruncate(compare);
let differ = 0;
let maxDelta = 0;
for (let i = 0; i < nCompare; i++) {
  const delta = Math.abs(modernCodes[i] - legacyCodes[i]);
  if (delta) differ += 1;
  if (delta > maxDelta) maxDelta = delta;
}

const seconds = 0.35;
const renderN = Math.floor(48000 * seconds);
const quiet = new Float32Array(renderN);
for (let i = 0; i < renderN; i++) quiet[i] = 0.004 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
const beforeWav = wavFromPcm16(legacyTruncate(quiet), 48000);
const afterBuf = encodeWavArrayBuffer([quiet], 48000, { bitDepth: 16, ditherAmt: 3, ditherSeed: 12345 }).buffer;
fs.writeFileSync(path.join(outDir, 'wav-before-truncation.wav'), beforeWav);
fs.writeFileSync(path.join(outDir, 'wav-after-shaped.wav'), Buffer.from(afterBuf));

function wavFromPcm16(pcm, sampleRate) {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

function spectrumDb(err) {
  const n = err.length;
  const bins = n / 2;
  const mag = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    let re = 0;
    let im = 0;
    const w = -2 * Math.PI * k / n;
    for (let i = 0; i < n; i++) {
      re += err[i] * Math.cos(w * i);
      im += err[i] * Math.sin(w * i);
    }
    const power = (re * re + im * im) / n;
    mag[k] = 10 * Math.log10(power + 1e-20);
  }
  return mag;
}

function silenceError(mode) {
  const n = 8192;
  const pcm = readPcm16(encodeWavArrayBuffer([new Float32Array(n)], 48000, {
    bitDepth: 16, ditherAmt: mode, ditherSeed: 12345,
  }).buffer);
  const err = new Float64Array(n);
  for (let i = 0; i < n; i++) err[i] = pcm[i] / 32768;
  return err;
}

function bandDb(mag, i0, i1) {
  let sum = 0;
  let count = 0;
  for (let k = i0; k < i1; k++) {
    sum += 10 ** (mag[k] / 10);
    count += 1;
  }
  return 10 * Math.log10(sum / count);
}

const flat = spectrumDb(silenceError(1));
const shaped = spectrumDb(silenceError(3));
const lowEnd = Math.floor(8192 / 16);
const highStart = Math.floor(8192 * 3 / 8);
const highEnd = Math.floor(8192 / 2);
const tpdfHighOverLowDb = bandDb(flat, highStart, highEnd) - bandDb(flat, 1, lowEnd);
const errorFeedbackHighOverLowDb = bandDb(shaped, highStart, highEnd) - bandDb(shaped, 1, lowEnd);

const ispN = 4096;
const isp = new Float32Array(ispN);
let samplePeak = 0;
for (let i = 0; i < ispN; i++) {
  isp[i] = Math.sin((Math.PI / 2) * i + Math.PI / 6);
  samplePeak = Math.max(samplePeak, Math.abs(isp[i]));
}
const ceiling = 0.95;
const before = measureTruePeak([isp]);
limitTruePeakInPlace(isp, 20 * Math.log10(ceiling));
const after = measureTruePeak([isp]);

writeSpectrumPlot(
  path.join(outDir, 'error-spectrum.png'),
  smooth(flat, 48),
  smooth(shaped, 48),
);
writeWaveformPlot(
  path.join(outDir, 'before-after-error.png'),
  quantizationError(quiet, legacyTruncate(quiet)),
  quantizationError(quiet, readPcm16(afterBuf)),
);

const record = {
  legacyTruncationDiffers: differ,
  of: nCompare,
  maxAbsLsb: maxDelta,
  tpdfHighOverLowDb,
  errorFeedbackHighOverLowDb,
  tiltDb: errorFeedbackHighOverLowDb - tpdfHighOverLowDb,
  ispSamplePeak: samplePeak,
  ispTruePeakBefore: before,
  ispCeiling: ceiling,
  ispTruePeakAfter: after,
  renderSeconds: seconds,
  renderHz: 1000,
  renderAmplitude: 0.004,
  artifacts: {
    before: path.join(outDir, 'wav-before-truncation.wav'),
    after: path.join(outDir, 'wav-after-shaped.wav'),
    spectrum: path.join(outDir, 'error-spectrum.png'),
    waveform: path.join(outDir, 'before-after-error.png'),
  },
};
fs.writeFileSync(path.join(outDir, 'wav-encoder-measurements.json'), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));

function quantizationError(samples, pcm) {
  const n = Math.min(samples.length, pcm.length, 480);
  const err = new Float64Array(n);
  for (let i = 0; i < n; i++) err[i] = pcm[i] / 32768 - samples[i];
  return err;
}

function writeWaveformPlot(file, before, after) {
  const width = 880;
  const height = 360;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 248; rgba[i + 1] = 246; rgba[i + 2] = 241; rgba[i + 3] = 255;
  }
  const plot = { l: 48, t: 28, r: width - 20, b: height - 36 };
  const mid = (plot.t + plot.b) / 2;
  let peak = 1e-8;
  for (let i = 0; i < before.length; i++) {
    peak = Math.max(peak, Math.abs(before[i]), Math.abs(after[i]));
  }
  const yOf = (v) => mid - (v / peak) * ((plot.b - plot.t) / 2 - 8);
  const xOf = (i) => plot.l + (i / (before.length - 1)) * (plot.r - plot.l);
  for (let x = plot.l; x < plot.r; x++) {
    const o = (Math.round(mid) * width + x) * 4;
    rgba[o] = 210; rgba[o + 1] = 206; rgba[o + 2] = 198;
  }
  strokeSeries(rgba, width, before, xOf, yOf, [40, 90, 160]);
  strokeSeries(rgba, width, after, xOf, yOf, [176, 48, 32]);
  fs.writeFileSync(file, encodePng(width, height, rgba));
}

function strokeSeries(rgba, width, series, xOf, yOf, rgb) {
  let prev = null;
  for (let i = 0; i < series.length; i += 1) {
    const x = Math.round(xOf(i));
    const y = Math.round(yOf(series[i]));
    if (prev) line(rgba, width, prev.x, prev.y, x, y, rgb);
    prev = { x, y };
  }
}

function smooth(mag, radius) {
  const out = new Float64Array(mag.length);
  for (let i = 0; i < mag.length; i++) {
    let sum = 0;
    let count = 0;
    const a = Math.max(1, i - radius);
    const b = Math.min(mag.length - 1, i + radius);
    for (let k = a; k <= b; k++) {
      sum += 10 ** (mag[k] / 10);
      count += 1;
    }
    out[i] = 10 * Math.log10(sum / count);
  }
  return out;
}

function writeSpectrumPlot(file, flatMag, shapedMag) {
  const width = 880;
  const height = 420;
  const rgba = Buffer.alloc(width * height * 4, 255);
  const plot = { l: 64, r: width - 24, t: 36, b: height - 48 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = 248; rgba[o + 1] = 246; rgba[o + 2] = 241; rgba[o + 3] = 255;
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 1; k < flatMag.length; k++) {
    lo = Math.min(lo, flatMag[k], shapedMag[k]);
    hi = Math.max(hi, flatMag[k], shapedMag[k]);
  }
  const pad = Math.max(1, (hi - lo) * 0.12);
  lo -= pad;
  hi += pad;
  const yOf = (db) => {
    const t = (Math.max(lo, Math.min(hi, db)) - lo) / (hi - lo);
    return plot.b - t * (plot.b - plot.t);
  };
  const xOf = (k) => plot.l + (k / (flatMag.length - 1)) * (plot.r - plot.l);
  for (let db = -140; db <= -80; db += 20) {
    const y = Math.round(yOf(db));
    for (let x = plot.l; x < plot.r; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = 220; rgba[o + 1] = 216; rgba[o + 2] = 208;
    }
  }
  stroke(rgba, width, flatMag, xOf, yOf, [40, 90, 160]);
  stroke(rgba, width, shapedMag, xOf, yOf, [176, 48, 32]);
  const png = encodePng(width, height, rgba);
  fs.writeFileSync(file, png);
}

function stroke(rgba, width, mag, xOf, yOf, rgb) {
  let prev = null;
  for (let k = 1; k < mag.length; k += 2) {
    const x = Math.round(xOf(k));
    const y = Math.round(yOf(mag[k]));
    if (prev) line(rgba, width, prev.x, prev.y, x, y, rgb);
    prev = { x, y };
  }
}

function line(rgba, width, x0, y0, x1, y1, rgb) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + ((x1 - x0) * s) / steps);
    const y = Math.round(y0 + ((y1 - y0) * s) / steps);
    const o = (y * width + x) * 4;
    if (o < 0 || o + 3 >= rgba.length) continue;
    rgba[o] = rgb[0]; rgba[o + 1] = rgb[1]; rgba[o + 2] = rgb[2]; rgba[o + 3] = 255;
  }
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  const crc = zlib.crc32(Buffer.concat([Buffer.from(type), data]));
  out.writeUInt32BE(crc >>> 0, 8 + data.length);
  return out;
}

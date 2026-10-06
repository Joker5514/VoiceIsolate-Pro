// removeClicks on a band-limited, ramped sibilant-like fixture, with an injected-click positive control.
// Run from repo root: node scripts/audit/2026-10-06/dsp-sibilant-probe.cjs [--check]
const DSP = require(require('path').resolve(__dirname, '../../../public/app/dsp-core.js'));
const sr = 48000, N = sr * 2;
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
// Continuous voiced bed: 150 Hz harmonics at 0.05 peak-ish, whole clip (no hard edges).
const bed = new Float32Array(N);
for (let i = 0; i < N; i++) {
  let v = 0; for (let h = 1; h <= 10; h++) v += Math.sin(2 * Math.PI * 150 * h * i / sr) / h;
  bed[i] = 0.05 * v / 2;
}
// Sibilant: 160 sinusoids, 4-9 kHz, random phases, RMS 0.08, 1.0-1.2 s with 15 ms raised-cosine ramps.
const s0 = sr, s1 = Math.round(1.2 * sr), ramp = Math.round(0.015 * sr);
const sib = new Float32Array(N);
const K = 160, f = [], ph = [];
for (let k = 0; k < K; k++) { f.push(4000 + 5000 * rnd()); ph.push(2 * Math.PI * rnd()); }
for (let i = s0; i < s1; i++) {
  let v = 0; for (let k = 0; k < K; k++) v += Math.sin(2 * Math.PI * f[k] * i / sr + ph[k]);
  let g = 1;
  if (i - s0 < ramp) g = 0.5 - 0.5 * Math.cos(Math.PI * (i - s0) / ramp);
  if (s1 - i < ramp) g = 0.5 - 0.5 * Math.cos(Math.PI * (s1 - i) / ramp);
  sib[i] = g * v;
}
let q = 0; for (let i = s0 + ramp; i < s1 - ramp; i++) q += sib[i] * sib[i];
const scale = 0.08 / Math.sqrt(q / (s1 - s0 - 2 * ramp));
const x = new Float32Array(N); for (let i = 0; i < N; i++) x[i] = bed[i] + sib[i] * scale;
const rms = (a, s, e) => { let r = 0; for (let i = s; i < e; i++) r += a[i] * a[i]; return Math.sqrt(r / (e - s)); };
const err = (a, b, s, e) => { let r = 0; for (let i = s; i < e; i++) r += (a[i] - b[i]) ** 2; return Math.sqrt(r / (e - s)); };

// 1) Click-free input.
const y = Float32Array.from(x); DSP.removeClicks(y, 3);
let changedSib = 0, changedOther = 0;
for (let i = 0; i < N; i++) if (y[i] !== x[i]) { if (i >= s0 && i < s1) changedSib++; else changedOther++; }
const dB = 20 * Math.log10(rms(y, s0, s1) / rms(x, s0, s1));
console.log(`click-free: changed ${changedSib} samples in sibilant, ${changedOther} elsewhere; sibilant level ${dB.toFixed(2)} dB; sibilant rms err ${err(x, y, s0, s1).toFixed(4)}`);

// 2) Positive control: 5 single-sample clicks (+0.8) in the voiced bed only.
const clickAt = [0.2, 0.4, 0.6, 1.5, 1.8].map((t) => Math.round(t * sr));
const c = Float32Array.from(x); for (const i of clickAt) c[i] += 0.8;
const cy = Float32Array.from(c); DSP.removeClicks(cy, 3);
const repaired = clickAt.filter((i) => Math.abs(cy[i] - x[i]) < 0.05).length;
console.log(`control: ${repaired}/${clickAt.length} injected clicks repaired to within 0.05 of the clean signal`);

if (process.argv.includes('--check')) {
  const assert = require('assert');
  assert.strictEqual(repaired, clickAt.length, 'positive control: all clicks repaired');
  assert.strictEqual(changedOther, 0, 'no changes outside the sibilant');
  assert.strictEqual(changedSib, 3739, 'sibilant samples changed');
  assert.strictEqual(dB.toFixed(2), '-1.45', 'sibilant level change');
  console.log('check: OK');
}

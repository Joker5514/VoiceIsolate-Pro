const DSP = require(require('path').resolve(__dirname, '../../../public/app/dsp-core.js'));
const sr = 48000, N = sr * 2;
let seed = 1; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
// 0-1s: voiced tone 150Hz harmonics @0.3 ; 1-1.2s: sibilant noise HP @0.15 ; rest quiet voiced 0.05
const x = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const t = i / sr;
  if (t < 1) { let v = 0; for (let h = 1; h <= 10; h++) v += Math.sin(2*Math.PI*150*h*t)/h; x[i] = 0.3*v/2; }
  else if (t < 1.2) { x[i] = 0.15 * rnd(); }
  else { let v = 0; for (let h = 1; h <= 10; h++) v += Math.sin(2*Math.PI*150*h*t)/h; x[i] = 0.05*v/2; }
}
// crude HP for sibilant: first difference
for (let i = Math.floor(1.2*sr)-1; i > sr; i--) x[i] = x[i] - x[i-1];
const rms = (a, s, e) => { let q = 0; for (let i = s; i < e; i++) q += a[i]*a[i]; return Math.sqrt(q/(e-s)); };
const diff = (a, b, s, e) => { let q = 0; for (let i = s; i < e; i++) q += (a[i]-b[i])**2; return Math.sqrt(q/(e-s)); };
const y = Float32Array.from(x); DSP.removeClicks(y, 3);
let flagged = 0; for (let i = 0; i < N; i++) if (y[i] !== x[i]) flagged++;
console.log('removeClicks(sens=3) samples modified:', flagged, 'of', N);
console.log('  sibilant seg rms in/out', rms(x, sr, 1.2*sr).toFixed(4), rms(y, sr, 1.2*sr).toFixed(4), 'err', diff(x,y,sr,1.2*sr).toFixed(4));
console.log('  voiced seg modified rms err', diff(x,y,0,sr).toFixed(5));
// deEss: pure 200Hz tone at 0.3 (no sibilance at all)
const tone = new Float32Array(sr); for (let i = 0; i < sr; i++) tone[i] = 0.3*Math.sin(2*Math.PI*200*i/sr);
const t2 = Float32Array.from(tone); DSP.deEss(t2, 6500, 50, sr);
console.log('deEss(amt=50) on 200Hz tone @0.3 (no sibilance): rms in/out', rms(tone,4800,sr).toFixed(4), rms(t2,4800,sr).toFixed(4), 'gain dB', (20*Math.log10(rms(t2,4800,sr)/rms(tone,4800,sr))).toFixed(2));
const hi = new Float32Array(sr); for (let i = 0; i < sr; i++) hi[i] = 0.05*Math.sin(2*Math.PI*6500*i/sr);
const h2 = Float32Array.from(hi); DSP.deEss(h2, 6500, 50, sr);
console.log('deEss(amt=50) on 6.5kHz tone @0.05: gain dB', (20*Math.log10(rms(h2,4800,sr)/rms(hi,4800,sr))).toFixed(2));

if (process.argv.includes('--check')) {
  const assert = require('assert');
  assert.strictEqual(flagged, 4112, 'removeClicks modified-sample count');
  assert.strictEqual(rms(y, sr, 1.2 * sr).toFixed(4), '0.0931', 'sibilant RMS after removeClicks');
  assert.strictEqual((20 * Math.log10(rms(t2, 4800, sr) / rms(tone, 4800, sr))).toFixed(2), '-2.04', 'deEss gain on 200 Hz tone');
  assert.strictEqual((20 * Math.log10(rms(h2, 4800, sr) / rms(hi, 4800, sr))).toFixed(2), '-1.43', 'deEss gain on 6.5 kHz tone');
  console.log('check: OK');
}

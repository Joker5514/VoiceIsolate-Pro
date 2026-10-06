// Median of 5 warmed runs per fallback DSP pass on 300 s mono at 48 kHz (machine-dependent).
// Run from repo root: node scripts/audit/2026-10-06/dsp-timing.cjs
const DSP = require(require('path').resolve(__dirname, '../../../public/app/dsp-core.js'));
const sr = 48000, N = sr * 300;
const src = new Float32Array(N);
for (let i = 0; i < N; i++) src[i] = 0.2 * Math.sin(i * 0.031) + 0.01 * Math.sin(i * 1.7);
const gate = { threshold: -42, range: -60, attack: 5, release: 200, hold: 50, lookahead: 5 };
const passes = {
  removeDCOffset: (x) => DSP.removeDCOffset(x, sr),
  removeClicks: (x) => DSP.removeClicks(x, 3),
  noiseGate: (x) => DSP.noiseGate(x, gate, sr),
  deEss: (x) => DSP.deEss(x, 6500, 30, sr),
};
for (const [name, fn] of Object.entries(passes)) {
  fn(Float32Array.from(src)); // warm-up
  const t = [];
  for (let r = 0; r < 5; r++) { const x = Float32Array.from(src); const a = performance.now(); fn(x); t.push(performance.now() - a); }
  t.sort((a, b) => a - b);
  console.log(`${name}: median ${t[2].toFixed(0)} ms (min ${t[0].toFixed(0)}, max ${t[4].toFixed(0)})`);
}

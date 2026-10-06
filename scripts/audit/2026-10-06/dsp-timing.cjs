const DSP = require(require('path').resolve(__dirname, '../../../public/app/dsp-core.js')); const sr = 48000, N = sr * 300;
const x = new Float32Array(N); for (let i = 0; i < N; i++) x[i] = 0.2 * Math.sin(i * 0.031) + 0.01 * Math.sin(i * 1.7);
const t = (l, f) => { const a = performance.now(); f(); console.log(l, (performance.now() - a).toFixed(0), 'ms'); };
t('removeDCOffset', () => DSP.removeDCOffset(x, sr));
t('removeClicks', () => DSP.removeClicks(x, 3));
let y; t('noiseGate', () => { y = DSP.noiseGate(x, { threshold: -42, range: -60, attack: 5, release: 200, hold: 50, lookahead: 5 }, sr); });
t('deEss', () => DSP.deEss(y, 6500, 30, sr));

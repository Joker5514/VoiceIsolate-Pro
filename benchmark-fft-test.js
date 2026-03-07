import { performance } from 'perf_hooks';

const N = 2048;
const half = N / 2 + 1;
const re = new Float32Array(N);
const im = new Float32Array(N);
for (let i = 0; i < N; i++) re[i] = Math.random();

// Simulate FFTEngine.synthesize without optimization
function synthesizeOld(magnitude, phase) {
    const r = new Float32Array(N);
    const i = new Float32Array(N);
    for (let k = 0; k < half; k++) {
      r[k] = magnitude[k] * Math.cos(phase[k]);
      i[k] = magnitude[k] * Math.sin(phase[k]);
    }
}

// Simulate FFTEngine.synthesize with optimization (pre-allocated)
const preR = new Float32Array(N);
const preI = new Float32Array(N);
function synthesizeNew(magnitude, phase) {
    for (let k = 0; k < half; k++) {
      preR[k] = magnitude[k] * Math.cos(phase[k]);
      preI[k] = magnitude[k] * Math.sin(phase[k]);
    }
}

const mag = new Float32Array(half);
const ph = new Float32Array(half);

const ITERS = 10000;
let t0 = performance.now();
for(let i=0; i<ITERS; i++) synthesizeOld(mag, ph);
console.log('Old:', performance.now() - t0);

t0 = performance.now();
for(let i=0; i<ITERS; i++) synthesizeNew(mag, ph);
console.log('New:', performance.now() - t0);

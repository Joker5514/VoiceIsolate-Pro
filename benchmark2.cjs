const { performance } = require('perf_hooks');

const codeStrOptimized = `
const TWO_PI = 2.0 * Math.PI;

// Cache for twiddle factors
const twiddleCache = {
  forward: {}, // size -> { wReal: Float32Array, wImag: Float32Array }
  inverse: {}  // size -> { wReal: Float32Array, wImag: Float32Array }
};

function initTwiddleFactors(n, inverse) {
  const cacheMap = inverse ? twiddleCache.inverse : twiddleCache.forward;
  if (cacheMap[n]) return cacheMap[n];

  const wReal = new Float32Array(n);
  const wImag = new Float32Array(n);
  const sign = inverse ? 1.0 : -1.0;

  for (let size = 2; size <= n; size *= 2) {
    const angle = sign * TWO_PI / size;
    wReal[size] = Math.cos(angle);
    wImag[size] = Math.sin(angle);
  }

  const factors = { wReal, wImag };
  cacheMap[n] = factors;
  return factors;
}

function fft(real, imag, inverse) {
  const n = real.length;
  if (n === 0) return;

  // Initialize/get twiddle factors
  const factors = initTwiddleFactors(n, inverse);
  const wRealCache = factors.wReal;
  const wImagCache = factors.wImag;

  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  // Butterfly stages
  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size >> 1;
    const wReal = wRealCache[size];
    const wImag = wImagCache[size];
    for (let start = 0; start < n; start += size) {
      let curReal = 1.0;
      let curImag = 0.0;
      for (let k = 0; k < halfSize; k++) {
        const evenIdx = start + k;
        const oddIdx  = start + k + halfSize;
        const tReal = curReal * real[oddIdx] - curImag * imag[oddIdx];
        const tImag = curReal * imag[oddIdx] + curImag * real[oddIdx];
        real[oddIdx] = real[evenIdx] - tReal;
        imag[oddIdx] = imag[evenIdx] - tImag;
        real[evenIdx] += tReal;
        imag[evenIdx] += tImag;
        const newCurReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = newCurReal;
      }
    }
  }

  // Scale for inverse
  if (inverse) {
    for (let i2 = 0; i2 < n; i2++) {
      real[i2] /= n;
      imag[i2] /= n;
    }
  }
}
return fft;
`;

const runFFTOptim = new Function(codeStrOptimized)();

// Benchmark
const N = 2048;
const iterations = 5000;

const realOrig = new Float32Array(N);
const imagOrig = new Float32Array(N);

for (let i = 0; i < N; i++) {
  realOrig[i] = Math.sin(i * 2 * Math.PI / N) + Math.sin(i * 10 * Math.PI / N);
  imagOrig[i] = 0;
}

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  const r = new Float32Array(N);
  r.set(realOrig);
  const im = new Float32Array(N);
  im.set(imagOrig);
  runFFTOptim(r, im, false);
  runFFTOptim(r, im, true);
}
const end = performance.now();

console.log(`Optimized FFT time for ${iterations} iterations (N=${N}): ${(end - start).toFixed(2)} ms`);

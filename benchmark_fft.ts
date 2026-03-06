import { performance } from "perf_hooks";

// Original bit-reversal logic
function fftInPlaceOld(re: Float32Array, im: Float32Array, inverse = false): void {
  const N = re.length;
  const bits = Math.log2(N) | 0;

  // Bit-reversal
  for (let i = 0; i < N; i++) {
    let j = 0, tmp = i;
    for (let b = 0; b < bits; b++) { j = (j << 1) | (tmp & 1); tmp >>= 1; }
    if (j > i) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  const sign = inverse ? 1 : -1;
  for (let step = 1; step < N; step <<= 1) {
    const jump = step << 1;
    const theta = (sign * Math.PI) / step;
    const sinH = Math.sin(0.5 * theta);
    const wpr = -2 * sinH * sinH;
    const wpi = Math.sin(theta);
    let wr = 1.0, wi = 0.0;
    for (let m = 0; m < step; m++) {
      for (let k = m; k < N; k += jump) {
        const l = k + step;
        const tr = wr * re[l] - wi * im[l];
        const ti = wr * im[l] + wi * re[l];
        re[l] = re[k] - tr; im[l] = im[k] - ti;
        re[k] += tr;        im[k] += ti;
      }
      const tmp = wr;
      wr = tmp * wpr - wi * wpi + tmp;
      wi = wi * wpr + tmp * wpi + wi;
    }
  }
  if (inverse) {
    const scale = 1 / N;
    for (let i = 0; i < N; i++) { re[i] *= scale; im[i] *= scale; }
  }
}

// Optimized bit-reversal logic
const FFT_SIZE = 2048;
const bitReverseTable = new Uint16Array(FFT_SIZE);
const bits = Math.log2(FFT_SIZE) | 0;
for (let i = 0; i < FFT_SIZE; i++) {
  let j = 0, tmp = i;
  for (let b = 0; b < bits; b++) {
    j = (j << 1) | (tmp & 1);
    tmp >>= 1;
  }
  bitReverseTable[i] = j;
}

function fftInPlaceNew(re: Float32Array, im: Float32Array, inverse = false): void {
  const N = re.length;

  // Bit-reversal
  for (let i = 0; i < N; i++) {
    const j = bitReverseTable[i];
    if (j > i) {
      const tr = re[i], ti = im[i];
      re[i] = re[j];
      im[i] = im[j];
      re[j] = tr;
      im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let step = 1; step < N; step <<= 1) {
    const jump = step << 1;
    const theta = (sign * Math.PI) / step;
    const sinH = Math.sin(0.5 * theta);
    const wpr = -2 * sinH * sinH;
    const wpi = Math.sin(theta);
    let wr = 1.0, wi = 0.0;
    for (let m = 0; m < step; m++) {
      for (let k = m; k < N; k += jump) {
        const l = k + step;
        const tr = wr * re[l] - wi * im[l];
        const ti = wr * im[l] + wi * re[l];
        re[l] = re[k] - tr; im[l] = im[k] - ti;
        re[k] += tr;        im[k] += ti;
      }
      const tmp = wr;
      wr = tmp * wpr - wi * wpi + tmp;
      wi = wi * wpr + tmp * wpi + wi;
    }
  }
  if (inverse) {
    const scale = 1 / N;
    for (let i = 0; i < N; i++) { re[i] *= scale; im[i] *= scale; }
  }
}

const ITERATIONS = 10000;

// Setup test data
const reOld = new Float32Array(FFT_SIZE);
const imOld = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  reOld[i] = Math.random();
  imOld[i] = Math.random();
}

const reNew = new Float32Array(FFT_SIZE);
const imNew = new Float32Array(FFT_SIZE);
reNew.set(reOld);
imNew.set(imOld);

// Verify correctness
fftInPlaceOld(reOld, imOld);
fftInPlaceNew(reNew, imNew);

for (let i = 0; i < FFT_SIZE; i++) {
  if (Math.abs(reOld[i] - reNew[i]) > 1e-5 || Math.abs(imOld[i] - imNew[i]) > 1e-5) {
    console.error("Mismatch at index", i);
    process.exit(1);
  }
}
console.log("Correctness verified.");

// Benchmark
let startOld = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  fftInPlaceOld(reOld, imOld);
}
let endOld = performance.now();
console.log(`Old: ${endOld - startOld} ms for ${ITERATIONS} iterations`);

let startNew = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  fftInPlaceNew(reNew, imNew);
}
let endNew = performance.now();
console.log(`New: ${endNew - startNew} ms for ${ITERATIONS} iterations`);

const improvement = ((endOld - startOld) - (endNew - startNew)) / (endOld - startOld) * 100;
console.log(`Improvement: ${improvement.toFixed(2)}%`);

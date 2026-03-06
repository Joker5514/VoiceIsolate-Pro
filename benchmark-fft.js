import crypto from 'crypto';

// --- Original Implementation ---

function fftInPlaceOriginal(re, im, inverse = false) {
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

// --- Optimized Implementation ---

const FFT_SIZE = 2048;

function buildBitReverseTable(N) {
  const bits = Math.log2(N) | 0;
  const table = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    let j = 0, tmp = i;
    for (let b = 0; b < bits; b++) { j = (j << 1) | (tmp & 1); tmp >>= 1; }
    table[i] = j;
  }
  return table;
}

const BIT_REVERSE_TABLE = buildBitReverseTable(FFT_SIZE);

function fftInPlaceOptimized(re, im, inverse = false) {
  const N = re.length;

  // Bit-reversal
  for (let i = 0; i < N; i++) {
    const j = BIT_REVERSE_TABLE[i];
    if (j > i) {
      let tr = re[i]; re[i] = re[j]; re[j] = tr;
      let ti = im[i]; im[i] = im[j]; im[j] = ti;
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

// --- Benchmark ---

function generateRandomArray(size) {
  const arr = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = Math.random();
  }
  return arr;
}

const ITERATIONS = 10000;

function runBenchmark() {
  console.log(`Running benchmark with FFT_SIZE=${FFT_SIZE}, ITERATIONS=${ITERATIONS}`);

  // Create test data
  const testDataOriginal = [];
  const testDataOptimized = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const re = generateRandomArray(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    testDataOriginal.push({
      re: new Float32Array(re),
      im: new Float32Array(im)
    });
    testDataOptimized.push({
      re: new Float32Array(re),
      im: new Float32Array(im)
    });
  }

  // Warmup
  for (let i = 0; i < 100; i++) {
    fftInPlaceOriginal(new Float32Array(FFT_SIZE), new Float32Array(FFT_SIZE));
    fftInPlaceOptimized(new Float32Array(FFT_SIZE), new Float32Array(FFT_SIZE));
  }

  // Measure original
  const startOriginal = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const { re, im } = testDataOriginal[i];
    fftInPlaceOriginal(re, im);
  }
  const endOriginal = performance.now();

  // Measure optimized
  const startOptimized = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const { re, im } = testDataOptimized[i];
    fftInPlaceOptimized(re, im);
  }
  const endOptimized = performance.now();

  const originalDuration = endOriginal - startOriginal;
  const optimizedDuration = endOptimized - startOptimized;
  const improvement = ((originalDuration - optimizedDuration) / originalDuration) * 100;

  console.log(`Original duration:  ${originalDuration.toFixed(2)} ms`);
  console.log(`Optimized duration: ${optimizedDuration.toFixed(2)} ms`);
  console.log(`Improvement:        ${improvement.toFixed(2)}%`);

  // Verify correctness
  let isCorrect = true;
  for (let i = 0; i < FFT_SIZE; i++) {
    if (Math.abs(testDataOriginal[0].re[i] - testDataOptimized[0].re[i]) > 1e-5) {
      isCorrect = false;
      break;
    }
  }
  console.log(`Correctness test:   ${isCorrect ? 'PASSED' : 'FAILED'}`);
}

runBenchmark();

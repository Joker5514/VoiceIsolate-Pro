const fs = require('fs');
const vm = require('vm');

const workerCode = fs.readFileSync('src/js/workers/dsp-worker.js', 'utf8');
const context = vm.createContext({
  Float32Array,
  Math,
  postMessage: () => {}, // mock
  self: { postMessage: () => {} }
});
vm.runInContext(workerCode, context);

const stft = context.stft;
const istft = context.istft;

function runBenchmark() {
  const fftSize = 4096;
  const hopSize = 1024;
  const durationSec = 10;
  const sampleRate = 48000;
  const numSamples = durationSec * sampleRate;

  const testBuffer = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    testBuffer[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate);
  }

  // Warmup to trigger cache allocation
  stft(testBuffer, fftSize, hopSize);

  global.gc();

  const startMemory = process.memoryUsage().heapUsed;
  const startTime = performance.now();

  const frames = stft(testBuffer, fftSize, hopSize);

  const midTime = performance.now();
  const midMemory = process.memoryUsage().heapUsed;

  const resultBuffer = istft(frames, fftSize, hopSize, testBuffer.length);

  const endTime = performance.now();
  const endMemory = process.memoryUsage().heapUsed;

  console.log(`--- STFT GC Benchmark (Optimized) ---`);
  console.log(`Test Signal: ${durationSec}s @ ${sampleRate}Hz (${numSamples} samples)`);
  console.log(`FFT Size: ${fftSize}, Hop Size: ${hopSize}`);
  console.log(`Frames processed: ${frames.length}`);
  console.log(`STFT time: ${(midTime - startTime).toFixed(2)}ms`);
  console.log(`iSTFT time: ${(endTime - midTime).toFixed(2)}ms`);
  console.log(`Total time: ${(endTime - startTime).toFixed(2)}ms`);

  console.log(`Heap Alloc Delta STFT: ${((midMemory - startMemory) / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Heap Alloc Delta iSTFT: ${((endMemory - midMemory) / 1024 / 1024).toFixed(2)} MB`);
}

runBenchmark();

import { FFTEngine } from './src/dsp/fft.js';
import { SpectralFrame } from './src/dsp/types.js';

const sampleRate = 44100;
const fftSize = 2048;
const hopSize = 512;
const config = { sampleRate, fftSize, hopSize, windowFunction: 'hann' as const };
const engine = new FFTEngine(config);

const samples = new Float32Array(fftSize);
for (let i = 0; i < fftSize; i++) {
  samples[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate);
}

const frame = engine.analyze(samples, 0, 0);
const out = new Float32Array(fftSize);

const iterations = 10000;
const start = performance.now();
for (let i = 0; i < iterations; i++) {
  engine.synthesize(frame, out);
}
const end = performance.now();

console.log(`Synthesis time for ${iterations} iterations: ${(end - start).toFixed(2)} ms`);

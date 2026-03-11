## 2026-03-10 - TypedArray copyWithin optimization
**Learning:** In audio visualizations rendering 3D spectrograms, using three.js geometry attributes accessor methods (`setY`, `getY`) within nested loops adds significant call stack overhead.
**Action:** When working with continuous 3D visualizations from DSP pipelines, bypass high-level three.js accessors in favor of native `TypedArray.copyWithin` and direct flattened `attribute.array` manipulation to avoid function call overhead during 60FPS renders.

## 2026-03-10 - Compressor DSP Gain calculation optimization
**Learning:** High-frequency, per-sample loop calculations (like audio limiters or compressors) that sequence logarithmic and exponential operations (`Math.pow(10, -(20 * Math.log10(x) * slope) / 20)`) introduce major call stack overhead and are completely avoidable. Modern TS AudioWorklet environments also often balk at `Math.log10`.
**Action:** Always refactor and algebraically reduce log/pow sequences in hot loops into a single exponentiation (`Math.pow(x, -slope)`), completely removing the slow `Math.log10` step.

## 2024-05-18 - Optimize getChannelData in AudioBuffer encoding
**Learning:** Calling `AudioBuffer.prototype.getChannelData(ch)` inside an inner per-sample loop (e.g., `buf.length` * `nChannels` times) introduces significant function call and property access overhead, particularly in hot encoding loops like WAV generation. Benchmarks showed caching the arrays upfront provides roughly a 1.20x speedup in JS environments.
**Action:** When iterating over multi-channel AudioBuffer data, always pre-fetch and cache the `Float32Array` representations for each channel into a local array structure before the main sample loop.

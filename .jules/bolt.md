## 2026-03-10 - TypedArray copyWithin optimization
**Learning:** In audio visualizations rendering 3D spectrograms, using three.js geometry attributes accessor methods (`setY`, `getY`) within nested loops adds significant call stack overhead.
**Action:** When working with continuous 3D visualizations from DSP pipelines, bypass high-level three.js accessors in favor of native `TypedArray.copyWithin` and direct flattened `attribute.array` manipulation to avoid function call overhead during 60FPS renders.

## 2026-03-10 - Compressor DSP Gain calculation optimization
**Learning:** High-frequency, per-sample loop calculations (like audio limiters or compressors) that sequence logarithmic and exponential operations (`Math.pow(10, -(20 * Math.log10(x) * slope) / 20)`) introduce major call stack overhead and are completely avoidable. Modern TS AudioWorklet environments also often balk at `Math.log10`.
**Action:** Always refactor and algebraically reduce log/pow sequences in hot loops into a single exponentiation (`Math.pow(x, -slope)`), completely removing the slow `Math.log10` step.

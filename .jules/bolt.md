## 2026-03-10 - TypedArray copyWithin optimization
**Learning:** In audio visualizations rendering 3D spectrograms, using three.js geometry attributes accessor methods (`setY`, `getY`) within nested loops adds significant call stack overhead.
**Action:** When working with continuous 3D visualizations from DSP pipelines, bypass high-level three.js accessors in favor of native `TypedArray.copyWithin` and direct flattened `attribute.array` manipulation to avoid function call overhead during 60FPS renders.

## 2026-03-10 - Compressor DSP Gain calculation optimization
**Learning:** High-frequency, per-sample loop calculations (like audio limiters or compressors) that sequence logarithmic and exponential operations (`Math.pow(10, -(20 * Math.log10(x) * slope) / 20)`) introduce major call stack overhead and are completely avoidable. Modern TS AudioWorklet environments also often balk at `Math.log10`.
**Action:** Always refactor and algebraically reduce log/pow sequences in hot loops into a single exponentiation (`Math.pow(x, -slope)`), completely removing the slow `Math.log10` step.
## 2024-03-22 - Bypassing Three.js Accessors for Hot 3D Data
**Learning:** In hot loops like continuous 3D visualizations (e.g., streaming spectrograms), using Three.js high-level geometry accessors (`pos.setY`, `pos.getY`) introduces significant function call overhead.
**Action:** Bypass these accessors in favor of native `TypedArray.copyWithin` for arrays like colors or full coordinate sets. When specific offsets are required (like just shifting the Y coordinates), iterate directly backward over the flattened `attribute.array` (e.g., `pos.array`).
## 2024-05-24 - TypedArray memory allocation overhead in STFT loops
**Learning:** Frequent small allocations of `Float32Array` within high-frequency DSP loops (like the STFT `nFrames` loop) cause significant garbage collection overhead and memory churn, slowing down execution.
**Action:** Pre-allocate a single, contiguous "flat" `Float32Array` for the entire dataset upfront. Within the loop, use `.set()` for bulk copying and `.subarray()` to create zero-copy views into the pre-allocated buffer, replacing manual element-by-element assignment loops.

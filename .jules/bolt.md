## 2026-03-10 - TypedArray copyWithin optimization
**Learning:** In audio visualizations rendering 3D spectrograms, using three.js geometry attributes accessor methods (`setY`, `getY`) within nested loops adds significant call stack overhead.
**Action:** When working with continuous 3D visualizations from DSP pipelines, bypass high-level three.js accessors in favor of native `TypedArray.copyWithin` and direct flattened `attribute.array` manipulation to avoid function call overhead during 60FPS renders.

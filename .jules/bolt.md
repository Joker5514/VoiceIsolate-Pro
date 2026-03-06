## 2024-03-02 - DSP Node Iterative Slicing Overhead
**Learning:** In audio processing blocks (like `FFTNode`, `SpectralSubtractionNode`, etc.), repeatedly calling `TypedArray.prototype.slice()` inside a `while` loop to advance the input buffer causes $O(K^2)$ array allocations and massive GC overhead.
**Action:** Use an `inputOffset` pointer to track the read position within the loop, and perform a single `.slice(inputOffset)` at the end to keep the remainder for the next block. This pattern improved buffer shifting speed by ~28x in synthetic benchmarks.

## 2025-03-06 - Pre-allocate Buffers in DSP Synthesis Loop
**Learning:** Frequent instantiations of `Float32Array` within high-frequency DSP loops (like `FFTEngine.synthesize`) cause significant garbage collection overhead and degrade performance.
**Action:** Always pre-allocate `TypedArray` buffers (like `Float32Array`) as class instance properties in the constructor and reuse them within the loop instead of creating new arrays on each function call.

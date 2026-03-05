## 2024-03-02 - DSP Node Iterative Slicing Overhead
**Learning:** In audio processing blocks (like `FFTNode`, `SpectralSubtractionNode`, etc.), repeatedly calling `TypedArray.prototype.slice()` inside a `while` loop to advance the input buffer causes $O(K^2)$ array allocations and massive GC overhead.
**Action:** Use an `inputOffset` pointer to track the read position within the loop, and perform a single `.slice(inputOffset)` at the end to keep the remainder for the next block. This pattern improved buffer shifting speed by ~28x in synthetic benchmarks.

## 2024-03-03 - DSP Hot Loop O(N) Array Operations
**Learning:** Using `Array.prototype.shift()` (e.g., to manage a history/latency queue) inside a hot DSP loop like `DSPPipeline.processFrame` causes significant O(N) re-indexing overhead and increased garbage collection, which severely impacts realtime audio performance.
**Action:** Replace `push()` and `shift()` on arrays with a pre-allocated fixed-size `TypedArray` (e.g., `Float32Array(100)`) acting as a ring buffer with a wrap-around index pointer (`this.latencyIndex = (this.latencyIndex + 1) % 100`). This ensures O(1) read/write performance and zeroes out GC pressure.

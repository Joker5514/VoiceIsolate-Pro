## 2024-03-02 - DSP Node Iterative Slicing Overhead
**Learning:** In audio processing blocks (like `FFTNode`, `SpectralSubtractionNode`, etc.), repeatedly calling `TypedArray.prototype.slice()` inside a `while` loop to advance the input buffer causes $O(K^2)$ array allocations and massive GC overhead.
**Action:** Use an `inputOffset` pointer to track the read position within the loop, and perform a single `.slice(inputOffset)` at the end to keep the remainder for the next block. This pattern improved buffer shifting speed by ~28x in synthetic benchmarks.

## 2024-03-03 - DSP Hot Loop O(N) Array Operations
**Learning:** Using `Array.prototype.shift()` (e.g., to manage a history/latency queue) inside a hot DSP loop like `DSPPipeline.processFrame` causes significant O(N) re-indexing overhead and increased garbage collection, which severely impacts realtime audio performance.
**Action:** Replace `push()` and `shift()` on arrays with a pre-allocated fixed-size `TypedArray` (e.g., `Float32Array(100)`) acting as a ring buffer with a wrap-around index pointer (`this.latencyIndex = (this.latencyIndex + 1) % 100`). This ensures O(1) read/write performance and zeroes out GC pressure.

## 2024-03-05 - WorkerPool PriorityQueue O(N) Shift Overhead
**Learning:** Using `Array.prototype.shift()` to implement priority queues creates O(N) array reallocation overhead, heavily impacting the `WorkerPool` which manages thousands of tiny, rapid tasks.
**Action:** Replace `.shift()` with an amortized O(1) index offset pattern (`headIndex`), manually setting dequeued entries to `undefined` for GC, and performing bulk `.slice` cleanups when `headIndex > 256` to prevent memory leaks.

## 2026-03-06 - Array.prototype.shift() Overhead in Lookahead Queues
**Learning:** Using `Array.prototype.shift()` on queues containing object references (like STFT spectra) inside tight audio processing loops (e.g., `SpectralGateNode`) triggers significant O(N) re-indexing and garbage collection overhead. Even with small queue lengths, this degrades realtime performance.
**Action:** Replace dynamic array lookahead queues with fixed-size ring buffers initialized as `new Array(lookaheadFrames + 1)` alongside head/tail pointers, enabling true O(1) performance and virtually zeroing out GC overhead in the hot loop.

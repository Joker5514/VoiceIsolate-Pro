## 2024-03-02 - DSP Node Iterative Slicing Overhead
**Learning:** In audio processing blocks (like `FFTNode`, `SpectralSubtractionNode`, etc.), repeatedly calling `TypedArray.prototype.slice()` inside a `while` loop to advance the input buffer causes $O(K^2)$ array allocations and massive GC overhead.
**Action:** Use an `inputOffset` pointer to track the read position within the loop, and perform a single `.slice(inputOffset)` at the end to keep the remainder for the next block. This pattern improved buffer shifting speed by ~28x in synthetic benchmarks.

## 2024-04-12 - Ring Buffer Patterns
**Learning:** Overusing `Array.prototype.shift()` in high-frequency measurement loops causes O(N) overhead per element due to continuous reallocation and index shifting.
**Action:** Use fixed-size ring buffers with wrap-around pointers (e.g., `this.head = (this.head + 1) % size`) to achieve O(1) performance for continuous data tracking.

## 2024-05-18 - WorkerPool headIndex Optimization
**Learning:** The array-based priority queue in WorkerPool suffered from O(N) `shift()` operations as jobs were consumed, stalling dispatch.
**Action:** Use a `head` offset index to track the queue's front. Periodically apply a bulk `.slice()` cleanup when the head exceeds a threshold to avoid memory leaks while maintaining amortized O(1) dequeue operations.

## 2024-06-25 - SpectralGateNode Lookahead Queue Fixes
**Learning:** Constantly instantiating small delay line arrays inside lookahead queues creates significant GC spikes, resulting in audio dropouts.
**Action:** Implement pre-allocated cyclic buffers and track read/write pointers instead of allocating and releasing objects for every frame in the lookahead queue.

## 2025-03-06 - Pre-allocate Buffers in DSP Synthesis Loop
**Learning:** Frequent instantiations of `Float32Array` within high-frequency DSP loops (like `FFTEngine.synthesize`) cause significant garbage collection overhead and degrade performance.
**Action:** Always pre-allocate `TypedArray` buffers (like `Float32Array`) as class instance properties in the constructor and reuse them within the loop instead of creating new arrays on each function call.

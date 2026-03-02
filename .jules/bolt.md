## 2024-03-02 - DSP Node Iterative Slicing Overhead
**Learning:** In audio processing blocks (like `FFTNode`, `SpectralSubtractionNode`, etc.), repeatedly calling `TypedArray.prototype.slice()` inside a `while` loop to advance the input buffer causes $O(K^2)$ array allocations and massive GC overhead.
**Action:** Use an `inputOffset` pointer to track the read position within the loop, and perform a single `.slice(inputOffset)` at the end to keep the remainder for the next block. This pattern improved buffer shifting speed by ~28x in synthetic benchmarks.

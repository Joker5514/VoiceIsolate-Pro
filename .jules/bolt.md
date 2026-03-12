## 2024-05-24 - TypedArray memory allocation overhead in STFT loops
**Learning:** Frequent small allocations of `Float32Array` within high-frequency DSP loops (like the STFT `nFrames` loop) cause significant garbage collection overhead and memory churn, slowing down execution.
**Action:** Pre-allocate a single, contiguous "flat" `Float32Array` for the entire dataset upfront. Within the loop, use `.set()` for bulk copying and `.subarray()` to create zero-copy views into the pre-allocated buffer, replacing manual element-by-element assignment loops.

## 2025-03-12 - AudioBuffer getChannelData Overhead
**Learning:** Calling `AudioBuffer.prototype.getChannelData(ch)` inside hot per-sample processing loops (e.g. iterating over millions of samples for encoding or DSP) introduces significant function call overhead and can slow down encoding or processing considerably.
**Action:** Pre-fetch and cache the `Float32Array` for each channel into a local array outside the sample loop before beginning sample-level processing to significantly improve performance.

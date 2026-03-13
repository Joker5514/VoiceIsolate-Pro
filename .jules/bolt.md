## 2024-05-24 - TypedArray memory allocation overhead in STFT loops
**Learning:** Frequent small allocations of `Float32Array` within high-frequency DSP loops (like the STFT `nFrames` loop) cause significant garbage collection overhead and memory churn, slowing down execution.
**Action:** Pre-allocate a single, contiguous "flat" `Float32Array` for the entire dataset upfront. Within the loop, use `.set()` for bulk copying and `.subarray()` to create zero-copy views into the pre-allocated buffer, replacing manual element-by-element assignment loops.

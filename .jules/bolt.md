## 2024-05-24 - TypedArray memory allocation overhead in STFT loops
**Learning:** Frequent small allocations of `Float32Array` within high-frequency DSP loops (like the STFT `nFrames` loop) cause significant garbage collection overhead and memory churn, slowing down execution.
**Action:** Pre-allocate a single, contiguous "flat" `Float32Array` for the entire dataset upfront. Within the loop, use `.set()` for bulk copying and `.subarray()` to create zero-copy views into the pre-allocated buffer, replacing manual element-by-element assignment loops.

## 2024-05-25 - Math.log10 optimization for decibel conversions
**Learning:** In audio processing loops, calculating decibels from amplitude (`20 * Math.log10(Math.sqrt(power))`) incurs significant overhead due to the `Math.sqrt` operation.
**Action:** Optimize decibel conversions by calculating the squared amplitude/power and using `10 * Math.log10(power)`. This yields identical decibel results while skipping the expensive square root calculation entirely.

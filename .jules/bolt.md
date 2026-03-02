## 2024-03-01 - [True Peak Limiter Optimization]
**Learning:** Found a sliding window logic that was causing O(N*K) where K is the lookahead window size inside the True Peak Limiter node. The performance gets significantly better utilizing a linear tracker logic for the window maximum, turning this to O(N).
**Action:** When working on sliding window limits such as the ones found in True Peak Limiters, be sure to utilize state saving rather than brute-force loops across the whole window size per sample to achieve O(N) operations.

# Engineer analysis timeout — 2026-11-01

Measured on Windows x64, Node v25.6.1, synthetic sine tones. Five interleaved trials. The old path is `bf5a5da6` (extract frame features, then `analyzeAudio`, which extracted them again). The new path extracts once with a yielding 400-frame slice, clones the feature object the way a worker message does, and reuses it.

The 180000 ms analysis timeout and the 120000 ms feature timeout were not raised. On this machine a 10-minute stereo file did not hit 180 s. The reproduced failure is a second full feature pass and a worker event loop that cannot deliver a timer or a cancel message while that pass runs synchronously.

| Fixture | Old median | Old p95 | New median | New p95 | Median change |
|---|---:|---:|---:|---:|---:|
| 30 s mono, 48 kHz | 825.2 ms | 891.8 ms | 465.4 ms | 496.1 ms | 43.6% |
| 2 min stereo, 48 kHz | 3320.0 ms | 3417.7 ms | 1822.3 ms | 1884.5 ms | 45.1% |
| 5 min stereo, 48 kHz | 7903.0 ms | 8073.9 ms | 4395.0 ms | 4651.7 ms | 44.4% |
| 10 min stereo, 48 kHz | 15639.3 ms | 15650.8 ms | 8766.0 ms | 8807.5 ms | 43.9% |
| 2 min stereo, 96 kHz | 6429.5 ms | 6447.3 ms | 3392.0 ms | 3403.4 ms | 47.2% |

Frame count, SNR (6 decimal places), recommended preset, and speech-segment count matched on the first trial of each fixture. Cancellation of a 30 s cooperative pass stopped after one 400-frame slice in 46.8 ms. A 5 ms timer fired during every yielding extract (7 ticks at 30 s, 149 ticks at 10 min). The old synchronous pass recorded 0 timer ticks in the earlier single-run trace.

Heap figures from `process.memoryUsage().heapUsed` moved both up and down across trials. That is not a peak-RSS or leak measurement.

`pnpm prod:verify` passed locally on this uncommitted tree (static and Chromium browser tiers, including Engineer upload, 67 controls, landing analysis, and the privacy runtime). Network downloads, Electron packaging, and the Android package were not part of that run. A physical Android device, macOS, Linux, and a production deployment of this commit were not run.

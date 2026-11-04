# Long-file / resource limits (VIP-029)

Measured on a VM-class machine (Node 24, onnxruntime-web WASM single
thread) at commit `30845e55`, synthetic speech-like signal (source-
filter talker + HVAC bed @ 5 dB SNR — resource behaviour only, not
quality evidence). Full numbers: `scripts/quality/stress-long.cjs`
output in `output/stress-long/report.json` (git-ignored; the run's
numbers are also in the PR #888 / issue #886 comments).

## Measured processing (mono 48 kHz)

| Input | landing | engineer | maximum | enhance |
|---|---|---|---|---|
| 60 s | 5.5 s (RTF 0.09) | 16.4 s (0.27) | 20.1 s (0.33) | 5.9 s (0.10) |
| 300 s | 13.6 s (0.05) | 41.6 s (0.14) | 51.8 s (0.17) | 25.8 s (0.09) |
| 900 s | 39.0 s (0.04) | — | — | 76.6 s (0.09) |

RTF *improves* with length (model-load overhead amortizes); all chains
run faster than realtime on this class. A 15-minute file takes
~40–80 s depending on chain. Extrapolating linearly, a 60-minute file
would take ~3–6 minutes on this class — but that extrapolation is
untested, not a promise.

## Memory

Peak process RSS during the sweep: **1,172 MB** (900 s landing run),
under the 2 GB bar. RSS includes all loaded models plus several
full-length buffers (decoded input, stems, playback copies), so it is
not per-run malloc: per-row RSS values are noisy with GC timing
(300 s runs read 741 → 665 → 638 MB as the collector freed prior
buffers). The clean signals are: no run exceeded the bar, and three
repeat 300 s runs took 13.0 → 12.7 → 12.7 s (ratio 0.98) — no leak
trend, no unbounded cache growth.

## Responsiveness caveat

During the 900 s runs the harness process's event loop lagged up to
**841 ms** (landing) / 497 ms (enhance). In this harness the worker
and host share one process, so that number overstates browser UI
impact (in product the worker is isolated from the UI thread) — but it
does show ORT batch sizes can stall a shared loop for the better part
of a second on very long files. Long-file UI work should keep progress
reporting on the worker side, not the host loop.

## Cancellation and recovery (verified, not just documented)

- Cancelling a 900 s enhance run ~1 s in rejects as cancelled, and the
  worker serves the next job normally (369 ms probe) — cancellation is
  request-scoped and does not poison later jobs.
- An unknown-model error rejects cleanly and the next job succeeds.
- An empty channel resolves to empty stems (graceful, not a crash).

## Tier caps (policy, not measured processing)

From `src/core/upload-limits.js` — enforced *before* any read/decode
for file bytes, and before decode for WAV (header probe), with a
post-decode budget that throws instead of truncating:

| Tier | File-bytes cap | Decoded-PCM budget | Warn threshold |
|---|---|---|---|
| HIGH | 8 GB | 3 GB | 512 MB |
| BALANCED | 2 GB | 768 MB | 256 MB |
| CONSTRAINED | 512 MB | 192 MB | 64 MB |

In practical terms on HIGH: 3 GB of float32 PCM is ~130 minutes of
stereo (or ~260 minutes mono) at 48 kHz — the tier cap is far above
any recording the processing-time and memory numbers above make
sensible. The practical limit is time and memory on the device, not
the cap. On CONSTRAINED (192 MB decoded ≈ 8 minutes stereo), the cap
bites first: a long recording is refused with a message saying what
to do (trim, lower the sample rate, use a desktop device), never
silently truncated.

## What is not covered here

- Other machine classes (mobile, low-memory desktop): the sweep is one
  VM class. Tier policies for all three classes are unit-tested, but
  processing on other classes is device-matrix work.
- Files beyond 900 s: untested; linear extrapolation only.
- Real-speech quality at length: the corpus eval (≤ 7.2 s clips)
  covers quality; long synthetic signals cover scaling.

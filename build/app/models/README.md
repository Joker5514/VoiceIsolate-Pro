# VoiceIsolate Pro — ONNX Models

Place the following model files in this directory before running:

| File | Approx Size | Purpose |
|------|-------------|---------|
| silero_vad.onnx | ~1.8 MB | Voice Activity Detection |
| demucs_v4_htdemucs.onnx | ~80 MB | Source Separation (optional) |
| deepfilter3.onnx | ~32 MB | Deep noise filtering (optional) |

These are NOT committed to the repo due to file size.
Run `npm run download-models` or download from the project release page.

The ml-worker-fetch-cache.js module will cache loaded models in IndexedDB automatically.
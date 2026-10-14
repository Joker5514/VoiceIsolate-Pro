# VoiceIsolate Pro — ONNX Models

All ML inference runs **100% locally** in the browser via `onnxruntime-web`.
No audio data leaves the device. WebGPU execution provider is preferred; WASM is the fallback.

---

## Models in This Directory

| File | Purpose | Size | Status |
|------|---------|------|--------|
| `silero_vad.onnx` | Voice Activity Detection (gate) | ~2.2 MB | ✅ Committed |
| `demucs_v4_quantized.onnx` | Hybrid Demucs v4 source separation | ~83-149 MB | **Optional — not shipped**. Engineer Process uses BSRNN. |
| `bsrnn_vocals.onnx` | Band-split vocal mask (custom, 600 steps on synthetic mixtures) | ~3.9 MB | ✅ Committed, hash-pinned |
| `rnnoise_suppressor.onnx` | Noise-suppression mask (custom BiGRU, 600 steps on synthetic mixtures; not Mozilla RNNoise) | ~2.0 MB | ✅ Committed, hash-pinned |
| `dfn3_enc.onnx`, `dfn3_erb_dec.onnx`, `dfn3_df_dec.onnx` | DeepFilterNet3 speech enhancement (Schröter et al.), the three graphs of upstream `models/DeepFilterNet3_onnx.tar.gz`. Selected as composite `deepfilternet3` (Landing **Enhance Speech**). License: MIT OR Apache-2.0; notice in `LICENSE-DeepFilterNet.txt`. | ~8.6 MB total | ✅ Committed, hash-pinned |
| `bsrnn_vocals_complex.onnx` | 4D complex BSRNN (offline processor) | — | ⬜ Not in the repository |
| `universal-separator.onnx` | Optional AudioSep-class query universal separator | — | ⬜ Optional (not shipped). Classical USM NMF + text priors run without it. |

### Universal Source Matrix (USM)

Engineer Mode → **Universal Source Matrix** panel (under Source Analysis Workspace):

- **Separate sources** — unsupervised multi-component soft masks (classical NMF; FUSS-style variable-K).
- **Query separate** — language priors (“AC hum”, “dog barking”, “speech”) for LASS/AudioSep-style control.
- **Mute / Solo / Gain** — Live-Mix only (no ML re-run). **Refine** re-runs a one-shot query on the retained mixture.
- Drop `universal-separator.onnx` under this folder and pin `sha256` in `src/core/ModelManifest.js` (`universal_separator`) to enable the ONNX path (`preferOnnx: true` on `USMNode`).

---

## Setup Instructions

### Option A — Git LFS (recommended for CI/CD)
```bash
git lfs install
git lfs track '*.onnx'
git add .gitattributes
# Then place the .onnx files and commit normally
git add public/app/models/*.onnx
git commit -m "feat: add ONNX model binaries via LFS"
```

### Option B — Regenerate locally
The shipped spectral models (`bsrnn_vocals.onnx`, `rnnoise_suppressor.onnx`) are
trained and exported by `scripts/export_onnx_models.py`, which writes both files
into the current directory: run `python ../../../scripts/export_onnx_models.py`
from `public/app/models/`. Re-pin their sha256 in `src/core/ModelManifest.js` and
run `pnpm models:validate` and `pnpm test:quality` after any change.

`scripts/export_bsrnn_onnx.py` exports the separate 4D complex BSRNN
(`bsrnn_vocals_complex.onnx`, n_fft 2048, 44.1 kHz), not `bsrnn_vocals.onnx`.
`scripts/export_demucs_onnx.py` documents the Demucs export, which is optional
and unshipped.

### Option C — Pre-exported downloads
See `models-manifest.json` for `source` URLs of each upstream model.
Rename downloaded files to match the `filename` field in the manifest.

---

## Runtime Behavior
`ml-worker.js` reads `models-manifest.json` at startup:
- `load_priority: "eager"` → loaded immediately on init (VAD, RNNoise)
- `load_priority: "lazy"` → loaded on first Creator/Forensic mode request (Demucs, BSRNN)

If a model file is missing at runtime, `ml-worker.js` logs a warning and the
pipeline falls back to classical DSP spectral stages only — audio still processes,
just without the ML-enhanced separation quality.

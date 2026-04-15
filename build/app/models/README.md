# VoiceIsolate Pro — ONNX Models

All ML inference runs **100% locally** in the browser via `onnxruntime-web`.
No audio data leaves the device. WebGPU execution provider is preferred; WASM is the fallback.

---

## Models in This Directory

| File | Purpose | Size | Status |
|------|---------|------|--------|
| `silero_vad.onnx` | Voice Activity Detection (gate) | ~2.2 MB | ✅ Committed |
| `demucs_v4_quantized.onnx` | Hybrid Demucs v4 source separation | ~83 MB | ⚠️ Manual download required |
| `bsrnn_vocals.onnx` | Band-Split RNN vocals extraction | ~45 MB | ⚠️ Manual download required |
| `rnnoise_suppressor.onnx` | Broadband noise suppression | ~180 KB | ⚠️ Manual download required |

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

### Option B — Manual placement (local dev / Vercel deploy)
```bash
# 1. Export Demucs v4 to ONNX
pip install torch torchaudio demucs
python scripts/export_demucs_onnx.py --output public/app/models/demucs_v4_quantized.onnx

# 2. Export BSRNN
pip install torch
python scripts/export_bsrnn_onnx.py --output public/app/models/bsrnn_vocals.onnx

# 3. Export RNNoise
python scripts/export_rnnoise_onnx.py --output public/app/models/rnnoise_suppressor.onnx

# 4. Remove placeholder files
rm public/app/models/*.placeholder
```

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

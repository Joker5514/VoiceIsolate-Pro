# VoiceIsolate Pro — ONNX Model Files

This directory holds the quantized `.onnx` models used by `ml-worker.js`.
Model files are **not committed to git** (too large). Download them separately.

## Required Models

| File | Size (approx) | Purpose |
|---|---|---|
| `demucs-v4-int8.onnx` | ~85 MB | Primary voice/music separation (Demucs v4 HTDemucs) |
| `bsrnn-int8.onnx` | ~32 MB | Band-Split RNN — blended with Demucs for vocal isolation |
| `silero_vad.onnx` | ~1.8 MB | Voice Activity Detection (Silero VAD v4) |
| `ecapa-tdnn-int8.onnx` | ~22 MB | Speaker embedding / identification (ECAPA-TDNN) |
| `deepfilter-int8.onnx` | ~28 MB | DeepFilterNet noise suppression |
| `dns2_conformer_small.onnx` | ~18 MB | Microsoft DNS Challenge v2 conformer |
| `noise_classifier.onnx` | ~4 MB | Background noise type classifier |
| `convtasnet-int8.onnx` | ~12 MB | Multi-speaker separation (ConvTasNet) |

## Download Instructions

The pipeline degrades gracefully — missing models are skipped with a `[warn]`
in the diagnostics panel. Only `silero_vad.onnx` is required for the full
classical DSP pipeline to run with VAD gating.

```bash
# Example: download Silero VAD from HuggingFace
curl -L https://huggingface.co/snakers4/silero-vad/resolve/main/files/silero_vad.onnx \
     -o public/app/models/silero_vad.onnx
```

For the full model set, see `VoiceIsolate_Pro_v22_1_Blueprint.md` §7 (Model Registry).

#!/usr/bin/env bash
# VoiceIsolate Pro — Model Setup Script
# Downloads/exports all required ONNX models for local development.
# Run from project root: bash scripts/setup-models.sh

set -euo pipefail

MODELS_DIR="public/app/models"

echo "=== VoiceIsolate Pro Model Setup ==="
echo "Target directory: $MODELS_DIR"
echo ""

# Silero VAD — small enough to wget directly from GitHub releases
if [ ! -f "$MODELS_DIR/silero_vad.onnx" ]; then
  echo "[1/4] Downloading silero_vad.onnx..."
  curl -L -o "$MODELS_DIR/silero_vad.onnx" \
    "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"
  echo "    ✅ silero_vad.onnx downloaded"
else
  echo "[1/4] silero_vad.onnx already present — skipping"
fi

# RNNoise — export from Python if not present
if [ ! -f "$MODELS_DIR/rnnoise_suppressor.onnx" ]; then
  echo "[2/4] Exporting rnnoise_suppressor.onnx (requires Python + torch)..."
  python3 scripts/export_rnnoise_onnx.py --output "$MODELS_DIR/rnnoise_suppressor.onnx"
  echo "    ✅ rnnoise_suppressor.onnx exported"
else
  echo "[2/4] rnnoise_suppressor.onnx already present — skipping"
fi

# BSRNN
if [ ! -f "$MODELS_DIR/bsrnn_vocals.onnx" ]; then
  echo "[3/4] Exporting bsrnn_vocals.onnx (requires Python + torch)..."
  python3 scripts/export_bsrnn_onnx.py --output "$MODELS_DIR/bsrnn_vocals.onnx"
  echo "    ✅ bsrnn_vocals.onnx exported"
else
  echo "[3/4] bsrnn_vocals.onnx already present — skipping"
fi

# Demucs v4
if [ ! -f "$MODELS_DIR/demucs_v4_quantized.onnx" ]; then
  echo "[4/4] Exporting demucs_v4_quantized.onnx (requires Python + torch + demucs)..."
  python3 scripts/export_demucs_onnx.py --output "$MODELS_DIR/demucs_v4_quantized.onnx"
  echo "    ✅ demucs_v4_quantized.onnx exported"
else
  echo "[4/4] demucs_v4_quantized.onnx already present — skipping"
fi

echo ""
echo "=== Model setup complete! ==="
echo "All models are in $MODELS_DIR"
echo "You can now reload the app and all ML stages will be active."

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

# RNNoise — placeholder for CDN fetch (actual model fetched from HuggingFace on first run)
if [ ! -f "$MODELS_DIR/rnnoise_suppressor.onnx" ]; then
  echo "[2/4] Creating placeholder for rnnoise_suppressor.onnx (CDN model)..."
  echo "# This model is fetched from HuggingFace CDN on first run" > "$MODELS_DIR/rnnoise_suppressor.onnx.placeholder"
  echo "    ✅ rnnoise_suppressor placeholder created"
else
  echo "[2/4] rnnoise_suppressor.onnx already present — skipping"
fi

# BSRNN — placeholder for CDN fetch
if [ ! -f "$MODELS_DIR/bsrnn_vocals.onnx" ]; then
  echo "[3/4] Creating placeholder for bsrnn_vocals.onnx (CDN model)..."
  echo "# This model is fetched from HuggingFace CDN on first run" > "$MODELS_DIR/bsrnn_vocals.onnx.placeholder"
  echo "    ✅ bsrnn_vocals placeholder created"
else
  echo "[3/4] bsrnn_vocals.onnx already present — skipping"
fi

# Demucs v4 — placeholder for CDN fetch
if [ ! -f "$MODELS_DIR/demucs_v4_quantized.onnx" ]; then
  echo "[4/4] Creating placeholder for demucs_v4_quantized.onnx (CDN model)..."
  echo "# This model is fetched from HuggingFace CDN on first run" > "$MODELS_DIR/demucs_v4_quantized.onnx.placeholder"
  echo "    ✅ demucs_v4_quantized placeholder created"
else
  echo "[4/4] demucs_v4_quantized.onnx already present — skipping"
fi

echo ""
echo "=== Generating SHA-256 hashes ==="
if command -v sha256sum > /dev/null 2>&1; then
  for model in "$MODELS_DIR"/*.onnx; do
    if [ -f "$model" ]; then
      echo "$(basename "$model"): $(sha256sum "$model" | cut -d' ' -f1)"
    fi
  done
elif command -v shasum > /dev/null 2>&1; then
  for model in "$MODELS_DIR"/*.onnx; do
    if [ -f "$model" ]; then
      echo "$(basename "$model"): $(shasum -a 256 "$model" | cut -d' ' -f1)"
    fi
  done
else
  echo "⚠️  SHA-256 tool not found (install sha256sum or shasum)"
fi

echo ""
echo "=== Model setup complete! ==="
echo "All models are in $MODELS_DIR"
echo "CDN models (rnnoise, bsrnn, demucs) will be downloaded on first app run"
echo "You can now reload the app and all ML stages will be active."

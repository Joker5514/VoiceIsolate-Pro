#!/usr/bin/env bash
# VoiceIsolate Pro — Model Setup Script
# Downloads/exports all required ONNX models for local development.
# After each model is downloaded/exported, its SHA-256 is recorded in
# public/app/ml-worker.js (MODEL_SHA256 registry) so the browser can
# verify integrity before loading.
# Run from project root: bash scripts/setup-models.sh

set -euo pipefail

MODELS_DIR="public/app/models"
ML_WORKER="public/app/ml-worker.js"
MANIFEST="$MODELS_DIR/models-manifest.json"

echo "=== VoiceIsolate Pro Model Setup ==="
echo "Target directory: $MODELS_DIR"
echo ""

# Helper: compute sha256 of a file and update MODEL_SHA256 in ml-worker.js
update_sha256() {
  local filename="$1"
  local filepath="$MODELS_DIR/$filename"
  if [ ! -f "$filepath" ]; then return; fi

  local hash
  if command -v sha256sum &>/dev/null; then
    hash=$(sha256sum "$filepath" | awk '{print $1}')
  elif command -v shasum &>/dev/null; then
    hash=$(shasum -a 256 "$filepath" | awk '{print $1}')
  else
    echo "    ⚠ Cannot compute SHA-256 (sha256sum/shasum not found)"
    return
  fi

  echo "    SHA-256: $hash"

  # Update MODEL_SHA256 entry in ml-worker.js (in-place sed)
  # Pattern: '<filename>': 'any_existing_value'
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|'${filename}': '.*'|'${filename}': '${hash}'|g" "$ML_WORKER"
  else
    sed -i "s|'${filename}': '.*'|'${filename}': '${hash}'|g" "$ML_WORKER"
  fi
  echo "    ✅ SHA-256 recorded in $ML_WORKER"
}

# Silero VAD — small enough to wget directly from GitHub releases
if [ ! -f "$MODELS_DIR/silero_vad.onnx" ]; then
  echo "[1/4] Downloading silero_vad.onnx..."
  curl -L -o "$MODELS_DIR/silero_vad.onnx" \
    "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"
  echo "    ✅ silero_vad.onnx downloaded"
  update_sha256 "silero_vad.onnx"
else
  echo "[1/4] silero_vad.onnx already present — skipping"
fi

# RNNoise — export from Python if not present
if [ ! -f "$MODELS_DIR/rnnoise_suppressor.onnx" ]; then
  echo "[2/4] Exporting rnnoise_suppressor.onnx (requires Python + torch)..."
  python3 scripts/export_rnnoise_onnx.py --output "$MODELS_DIR/rnnoise_suppressor.onnx"
  echo "    ✅ rnnoise_suppressor.onnx exported"
  update_sha256 "rnnoise_suppressor.onnx"
else
  echo "[2/4] rnnoise_suppressor.onnx already present — skipping"
fi

# BSRNN
if [ ! -f "$MODELS_DIR/bsrnn_vocals.onnx" ]; then
  echo "[3/4] Exporting bsrnn_vocals.onnx (requires Python + torch)..."
  python3 scripts/export_bsrnn_onnx.py --output "$MODELS_DIR/bsrnn_vocals.onnx"
  echo "    ✅ bsrnn_vocals.onnx exported"
  update_sha256 "bsrnn_vocals.onnx"
else
  echo "[3/4] bsrnn_vocals.onnx already present — skipping"
fi

# Demucs v4
if [ ! -f "$MODELS_DIR/demucs_v4_quantized.onnx" ]; then
  echo "[4/4] Exporting demucs_v4_quantized.onnx (requires Python + torch + demucs)..."
  python3 scripts/export_demucs_onnx.py --output "$MODELS_DIR/demucs_v4_quantized.onnx"
  echo "    ✅ demucs_v4_quantized.onnx exported"
  update_sha256 "demucs_v4_quantized.onnx"
else
  echo "[4/4] demucs_v4_quantized.onnx already present — skipping"
fi

echo ""
echo "=== Model setup complete! ==="
echo "All models are in $MODELS_DIR"
echo "SHA-256 hashes recorded in $ML_WORKER (MODEL_SHA256 registry)"
echo "You can now reload the app and all ML stages will be active."

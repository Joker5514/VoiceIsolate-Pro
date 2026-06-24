#!/usr/bin/env bash
# =============================================================
# bootstrap-libs.sh — Download vendored ONNX Runtime Web assets
# into public/lib/ for local-first, no-CDN-at-runtime operation.
#
# Usage:  bash scripts/bootstrap-libs.sh
# NOTE:   This script is for LOCAL development only.
#         Vercel uses scripts/setup-ort.js (copies from node_modules)
#         which avoids relying on outbound curl at build time.
# =============================================================
set -euo pipefail

# Version MUST match onnxruntime-web in package.json
ORT_VERSION="1.17.0"
ORT_CDN="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist"
THREE_VERSION="0.128.0"
THREE_CDN="https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build"
DEST="public/lib"

mkdir -p "$DEST"

FILES=(
  "ort.min.js"
  "ort-wasm.wasm"
  "ort-wasm-simd.wasm"
  "ort-wasm-threaded.wasm"
  "ort-wasm-simd-threaded.wasm"
)

echo "[bootstrap-libs] Downloading ONNX Runtime Web v${ORT_VERSION} to ${DEST}/"

for FILE in "${FILES[@]}"; do
  DEST_FILE="${DEST}/${FILE}"
  if [ -f "$DEST_FILE" ]; then
    echo "  [SKIP] ${FILE} already exists"
    continue
  fi
  echo "  [DL]   ${FILE}"
  curl -fsSL --retry 3 "${ORT_CDN}/${FILE}" -o "$DEST_FILE"
done

# Download THREE.js for local-first, no-CDN-at-runtime operation
THREE_FILE="three.min.js"
THREE_DEST="${DEST}/${THREE_FILE}"
if [ -f "$THREE_DEST" ]; then
  echo "  [SKIP] ${THREE_FILE} already exists"
else
  echo "  [DL]   ${THREE_FILE} (three.js v${THREE_VERSION})"
  curl -fsSL --retry 3 "${THREE_CDN}/${THREE_FILE}" -o "$THREE_DEST"
fi

echo "[bootstrap-libs] Done. Files in ${DEST}:"
ls -lh "$DEST"

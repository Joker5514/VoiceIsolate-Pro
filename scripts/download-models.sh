#!/usr/bin/env bash
# =============================================================================
# download-models.sh — VoiceIsolate Pro
# Downloads real quantized ONNX model binaries into /public/app/models/
# Called automatically via "prebuild" hook in package.json.
# Run manually: bash scripts/download-models.sh
# =============================================================================
set -euo pipefail

# ── Resolve absolute paths ────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS_DIR="${SCRIPT_DIR}/../public/app/models"
HF_BASE="https://huggingface.co/datasets/voiceisolate/models/resolve/main"
MIN_BYTES=10240    # Files under 10 KB are treated as placeholder stubs

# ── Terminal colors ────────────────────────────────────────────────────────
GRN='\033[0;32m'; CYN='\033[0;36m'; RED='\033[0;31m'; YLW='\033[1;33m'; NC='\033[0m'

echo -e "${CYN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYN}   VoiceIsolate Pro — ONNX Model Downloader  ${NC}"
echo -e "${CYN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

mkdir -p "$MODELS_DIR"
echo -e "📁  Target: ${MODELS_DIR}\n"

# ── Model registry  (local_filename|remote_filename) ──────────────────────
declare -a MODELS=(
  "silero-vad.onnx|silero-vad.onnx"
  "demucs-v4-quantized.onnx|demucs-v4-quantized.onnx"
  "bsrnn-vocals.onnx|bsrnn-vocals.onnx"
  "rnnoise-suppressor.onnx|rnnoise-suppressor.onnx"
)

FAILED=0

for entry in "${MODELS[@]}"; do
  LOCAL="${entry%%|*}"
  REMOTE="${entry##*|}"
  DEST="${MODELS_DIR}/${LOCAL}"
  URL="${HF_BASE}/${REMOTE}"

  # Skip if a real (non-placeholder) file already exists
  if [[ -f "$DEST" ]]; then
    SZ=$(wc -c < "$DEST" 2>/dev/null || echo 0)
    if (( SZ > MIN_BYTES )); then
      SIZE_FMT=$(numfmt --to=iec-i --suffix=B "$SZ" 2>/dev/null || echo "${SZ}B")
      echo -e "  ${GRN}✅ Present${NC}      ${LOCAL}  (${SIZE_FMT})"
      continue
    fi
    echo -e "  ${YLW}⚠️  Placeholder${NC}  ${LOCAL}  (${SZ} bytes) — downloading real model..."
  else
    echo -e "  ${CYN}⬇️  Downloading${NC}  ${LOCAL}"
  fi

  # Download with curl — fail hard on HTTP errors, follow redirects
  if curl \
      --fail \
      --location \
      --progress-bar \
      --output "$DEST" \
      "$URL"; then
    DL_SIZE=$(wc -c < "$DEST" 2>/dev/null || echo 0)
    DL_FMT=$(numfmt --to=iec-i --suffix=B "$DL_SIZE" 2>/dev/null || echo "${DL_SIZE}B")
    echo -e "  ${GRN}✅ Saved${NC}        ${LOCAL}  (${DL_FMT})"
  else
    echo -e "  ${RED}❌ FAILED${NC}       ${LOCAL}  — could not fetch ${URL}"
    FAILED=$(( FAILED + 1 ))
  fi

done

echo ""
echo -e "${CYN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [[ "$FAILED" -gt 0 ]]; then
  echo -e "${RED}  ❌ ${FAILED} model(s) failed. ML inference will be broken at runtime.${NC}"
  echo -e "${CYN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  exit 1
else
  echo -e "${GRN}  ✅ All models ready.${NC}"
  echo -e "${CYN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  exit 0
fi

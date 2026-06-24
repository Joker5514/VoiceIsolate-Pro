#!/usr/bin/env bash
# =============================================================================
# download-models.sh — VoiceIsolate Pro
#
# Downloads ONNX model binaries into public/app/models/ from Vercel Blob
# storage (configured via vercel.json rewrites).
#
# Vercel runtime: NOT invoked during deployment. Vercel serves models via the
# /app/models/* rewrites in vercel.json directly.
#
# Local dev: run `pnpm models:download` to pre-populate public/app/models/
# with the binaries so the dev server can serve them without going through
# the Vercel rewrite.
#
# Configuration: BLOB_BASE_URL must point at the public Vercel Blob origin
# that hosts the .onnx files (set after running scripts/upload_models_to_vercel_blob.py).
# =============================================================================
set -euo pipefail

# ── Resolve absolute paths ────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS_DIR="${SCRIPT_DIR}/../public/app/models"

# Vercel Blob base URL — override via env var until permanent value is wired
# into vercel.json. Public Blob URLs look like:
#   https://<random>.public.blob.vercel-storage.com
BLOB_BASE_URL="${BLOB_BASE_URL:-}"
MIN_BYTES=10240    # Files under 10 KB are treated as placeholder stubs

# ── Terminal colors ────────────────────────────────────────────────────────
GRN='\033[0;32m'; CYN='\033[0;36m'; RED='\033[0;31m'; YLW='\033[1;33m'; NC='\033[0m'

echo -e "${CYN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYN}   VoiceIsolate Pro — ONNX Model Downloader  ${NC}"
echo -e "${CYN}   Source: Vercel Blob storage              ${NC}"
echo -e "${CYN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [[ -z "$BLOB_BASE_URL" ]]; then
  echo -e "${YLW}⚠️  BLOB_BASE_URL is not set.${NC}"
  echo -e "    Skipping download. To enable:"
  echo -e "      1. Run: VERCEL_TOKEN=xxx python scripts/upload_models_to_vercel_blob.py --file <path> --name <name>"
  echo -e "      2. Set BLOB_BASE_URL to the returned public origin"
  echo -e "      3. Re-run: pnpm models:download"
  echo -e "    Or rely on the vercel.json rewrites at runtime — see MODELS.md."
  exit 0
fi

mkdir -p "$MODELS_DIR"
echo -e "📁  Target: ${MODELS_DIR}"
echo -e "🌐  Source: ${BLOB_BASE_URL}\n"

# ── Model registry  (filename only — same name used at the Blob origin) ───
declare -a MODELS=(
  "silero_vad.onnx"
  "rnnoise_suppressor.onnx"
  "demucs_v4_quantized.onnx"
  "bsrnn_vocals.onnx"
)

FAILED=0

for FILENAME in "${MODELS[@]}"; do
  DEST="${MODELS_DIR}/${FILENAME}"
  URL="${BLOB_BASE_URL%/}/${FILENAME}"

  # Skip if a real (non-placeholder) file already exists
  if [[ -f "$DEST" ]]; then
    SZ=$(wc -c < "$DEST" 2>/dev/null || echo 0)
    if (( SZ > MIN_BYTES )); then
      SIZE_FMT=$(numfmt --to=iec-i --suffix=B "$SZ" 2>/dev/null || echo "${SZ}B")
      echo -e "  ${GRN}✅ Present${NC}      ${FILENAME}  (${SIZE_FMT})"
      continue
    fi
    echo -e "  ${YLW}⚠️  Placeholder${NC}  ${FILENAME}  (${SZ} bytes) — downloading real model..."
  else
    echo -e "  ${CYN}⬇️  Downloading${NC}  ${FILENAME}"
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
    echo -e "  ${GRN}✅ Saved${NC}        ${FILENAME}  (${DL_FMT})"
  else
    echo -e "  ${RED}❌ FAILED${NC}       ${FILENAME}  — could not fetch ${URL}"
    FAILED=$(( FAILED + 1 ))
  fi

done

echo ""
echo -e "${CYN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [[ "$FAILED" -gt 0 ]]; then
  echo -e "${RED}  ❌ ${FAILED} model(s) failed. Check that they exist at ${BLOB_BASE_URL}.${NC}"
  echo -e "${CYN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  exit 1
else
  echo -e "${GRN}  ✅ All models ready.${NC}"
  echo -e "${CYN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  exit 0
fi

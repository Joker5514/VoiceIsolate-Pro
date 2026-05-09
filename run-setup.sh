#!/usr/bin/env bash
# ========================================
#  VoiceIsolate-Pro Setup Runner (Linux / macOS / Termux)
#  Equivalent of run-setup.bat for Unix-like systems.
#
#  Models are hosted on Vercel Blob storage. See MODELS.md for the
#  upload → rewrite flow.
# ========================================
set -euo pipefail

# ── Locate repo ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$SCRIPT_DIR"

if [ ! -d "$REPO/.git" ]; then
  echo "ERROR: No .git directory found at $REPO."
  echo "Please cd into your repo folder and run this script from there:"
  echo "  bash run-setup.sh"
  exit 1
fi

cd "$REPO"
echo "========================================"
echo " VoiceIsolate-Pro Setup Runner"
echo " Repo: $REPO"
echo "========================================"
echo

# ── Step 1: Pull latest ───────────────────────────────────────────────────────
echo "[1/5] Pulling latest from GitHub..."
git pull
echo

# ── Step 2: Install Python dependencies for export + Vercel Blob upload ──────
echo "[2/5] Installing Python dependencies..."
python3 -m pip install -q -r scripts/requirements_export.txt
echo

# ── Step 3: Export ONNX models (may take ~10 min) ─────────────────────────────
echo "[3/5] Exporting ONNX models (this may take ~10 minutes)..."
python3 scripts/export_rnnoise_onnx.py
python3 scripts/export_demucs_onnx.py
python3 scripts/export_bsrnn_onnx.py
echo

# ── Step 4: Upload to Vercel Blob ─────────────────────────────────────────────
if [ -z "${VERCEL_TOKEN:-}" ]; then
  echo "[4/5] Skipping upload — VERCEL_TOKEN is not set."
  echo "      Generate one at https://vercel.com/account/tokens, then run:"
  echo "        VERCEL_TOKEN=xxx python3 scripts/upload_models_to_vercel_blob.py \\"
  echo "            --file ./models_output/<filename> --name <filename>"
else
  echo "[4/5] Uploading to Vercel Blob..."
  for FN in rnnoise_suppressor.onnx demucs_v4_quantized.onnx bsrnn_vocals.onnx; do
    if [ -f "./models_output/$FN" ]; then
      python3 scripts/upload_models_to_vercel_blob.py --file "./models_output/$FN" --name "$FN"
    fi
  done
fi
echo

# ── Step 5: Validate model URLs ───────────────────────────────────────────────
echo "[5/5] Validating model URLs..."
node scripts/validate-onnx-models.js || true
echo

# ── Trigger CI deploy ──────────────────────────────────────────────────────────
echo "Triggering CI deploy..."
git add -A
git commit --allow-empty -m "chore: trigger CI after model upload"
git push
echo

echo "========================================"
echo " ALL DONE - Check GitHub Actions now!"
echo "========================================"

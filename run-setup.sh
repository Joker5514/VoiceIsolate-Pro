#!/usr/bin/env bash
# ========================================
#  VoiceIsolate-Pro Setup Runner (Linux / macOS / Termux)
#  Equivalent of run-setup.bat for Unix-like systems.
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

# ── Step 2: Install Python dependency ────────────────────────────────────────
echo "[2/5] Installing huggingface_hub..."
python3 -m pip install huggingface_hub -q
echo

# ── Step 3: Export ONNX models (may take ~10 min) ─────────────────────────────
echo "[3/5] Exporting ONNX models (this may take ~10 minutes)..."
python3 scripts/export_rnnoise_onnx.py
python3 scripts/export_demucs_onnx.py
python3 scripts/export_bsrnn_onnx.py
echo

# ── Step 4: Upload to HuggingFace ─────────────────────────────────────────────
echo "[4/5] Uploading to HuggingFace..."
python3 scripts/upload_models_to_huggingface.py
echo

# ── Step 5: Validate CDN URLs ─────────────────────────────────────────────────
echo "[5/5] Validating CDN URLs..."
node scripts/validate-onnx-models.js
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

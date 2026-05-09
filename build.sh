#!/usr/bin/env bash
# build.sh — VoiceIsolate Pro v6: Compile DSP WASM module
# Run from repo root: bash build.sh
#
# Prerequisites:
#   C++  path: brew install emscripten  (or emsdk install latest)
#   Rust path: curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

set -euo pipefail

WASM_OUT="public/wasm"
mkdir -p "$WASM_OUT"

echo "╔══════════════════════════════════════════╗"
echo "║  VoiceIsolate Pro v6 — WASM Build        ║"
echo "╚══════════════════════════════════════════╝"

# ──────────────────────────────────────────────────────────────────────────────
# PATH A: C++ → WASM via Emscripten
# ──────────────────────────────────────────────────────────────────────────────
build_cpp() {
  echo ""
  echo "[1/2] Building C++ DSP module with Emscripten..."
  emcc wasm/dsp-processor.cpp \
    -O3 \
    -s WASM=1 \
    -s AUDIO_WORKLET=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MAXIMUM_MEMORY=256mb \
    -s EXPORTED_RUNTIME_METHODS='["cwrap","ccall","HEAPF32","HEAP32"]' \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="DspModule" \
    -s ENVIRONMENT='worker' \
    -s SINGLE_FILE=0 \
    -s ASSERTIONS=0 \
    -flto \
    --bind \
    -o "$WASM_OUT/dsp_processor.js"
  echo "[1/2] ✓ C++ build complete → $WASM_OUT/dsp_processor.js + .wasm"
}

# ──────────────────────────────────────────────────────────────────────────────
# PATH B: Rust → WASM via wasm-pack
# ──────────────────────────────────────────────────────────────────────────────
build_rust() {
  echo ""
  echo "[2/2] Building Rust DSP module with wasm-pack..."

  # Ensure wasm-processor.rs is inside a proper Rust crate
  if [ ! -f wasm/Cargo.toml ]; then
    cat > wasm/Cargo.toml << 'EOF'
[package]
name = "dsp-processor"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
path = "dsp-processor.rs"

[dependencies]
wasm-bindgen = "0.2"
js-sys        = "0.3"

[profile.release]
opt-level = 3
lto       = true
codegen-units = 1
panic = "abort"
EOF
    echo "  Generated wasm/Cargo.toml"
  fi

  wasm-pack build wasm/ \
    --target web \
    --release \
    --out-dir "../$WASM_OUT/rust"

  echo "[2/2] ✓ Rust build complete → $WASM_OUT/rust/"
}

# ──────────────────────────────────────────────────────────────────────────────
# Select build path
# ──────────────────────────────────────────────────────────────────────────────
if command -v emcc &>/dev/null; then
  build_cpp
elif command -v wasm-pack &>/dev/null; then
  build_rust
else
  echo "ERROR: Neither emcc (Emscripten) nor wasm-pack (Rust) found."
  echo "Install one of:"
  echo "  Emscripten: https://emscripten.org/docs/getting_started/"
  echo "  wasm-pack:  https://rustwasm.github.io/wasm-pack/installer/"
  exit 1
fi

echo ""
echo "══════════════════════════════════════════"
echo " Build artifacts: $WASM_OUT/"
echo "══════════════════════════════════════════"
ls -lh "$WASM_OUT/"

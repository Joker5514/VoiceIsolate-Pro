# public/lib — Vendored Runtime Assets

This directory holds **locally-vendored** copies of ONNX Runtime Web and its
WebAssembly backends. These files are **intentionally excluded from Git** (they
are binary blobs up to ~10 MB each and would bloat the repository).

## Required Files

| File | Purpose | Size |
|------|---------|------|
| `ort.min.js` | ONNX Runtime Web — main JS bundle | ~700 KB |
| `ort-wasm.wasm` | WASM backend (CPU fallback) | ~8 MB |
| `ort-wasm-simd.wasm` | WASM SIMD backend (faster CPU) | ~8 MB |
| `ort-wasm-threaded.wasm` | Multi-threaded WASM backend | ~8 MB |
| `ort-wasm-simd-threaded.wasm` | SIMD + threads (fastest CPU) | ~8 MB |

## Setup (CI / Local Dev)

Run the bootstrap script from the repo root:

```bash
bash scripts/bootstrap-libs.sh
```

This downloads all required files from the official ONNX Runtime Web CDN
(`cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/`) into this directory.

## Why Local?

The architecture constraint requires **100% local processing** with no runtime
external fetches. All `importScripts()` and `WebAssembly.instantiate()` calls
in the workers must resolve to same-origin URLs to satisfy the
`Cross-Origin-Embedder-Policy: require-corp` header required for
`SharedArrayBuffer` (used by the ring buffer live-mode pipeline).

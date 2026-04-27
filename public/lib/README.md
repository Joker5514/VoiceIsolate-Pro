# `/public/lib/` — Local Vendor Bundles

This directory holds **self-hosted vendor libraries** required by VoiceIsolate Pro.
All files here are loaded via `<script src="/lib/...">` or `importScripts('/lib/...')`
and are subject to the production CSP: `connect-src 'self' blob:`.

**Nothing in this directory may be loaded from a CDN in production.**

---

## Files

### ✅ `three.min.js` (603 KB) — committed
Three.js r128. Powers the 3D spectrogram canvas in Engineer Mode.
No action required.

### ❌ `ort.min.js` (~5.1 MB) — **MUST BE ADDED MANUALLY**

ONNX Runtime Web v1.17.3. Required for:
- Demucs v4.1 source separation
- BSRNN vocal extraction
- Silero VAD speech detection
- All `ml-worker.js` inference paths

**Why it's not committed:**
Files >5 MB are slow to commit via the GitHub web UI / API. Use the CLI:

```bash
# Download
curl -L https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.min.js \
     -o public/lib/ort.min.js

# Verify checksum (expected: see https://www.npmjs.com/package/onnxruntime-web)
sha256sum public/lib/ort.min.js

# Commit
git add public/lib/ort.min.js
git commit -m "feat: add ort.min.js local bundle (ONNX Runtime Web v1.17.3)"
git push
```

**Until this file is committed**, `ort-loader.js` will emit a console warning
and attempt a CDN load as a last resort. The production CSP will block that CDN
request, so ML inference will be unavailable in production until the file is added.

---

## WASM Sibling Files (optional but recommended)

ONNX Runtime Web also needs its WASM backend files for the WASM execution
provider fallback (when WebGPU is unavailable). Commit these alongside `ort.min.js`:

```bash
curl -L https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort-wasm.wasm \
     -o public/lib/ort-wasm.wasm
curl -L https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort-wasm-simd.wasm \
     -o public/lib/ort-wasm-simd.wasm
curl -L https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort-wasm-threaded.wasm \
     -o public/lib/ort-wasm-threaded.wasm
```

Then point ORT at the local WASM path in `ml-worker.js`:
```js
ort.env.wasm.wasmPaths = '/lib/';
```

---

## Size Budget

| File | Size | Status |
|---|---|---|
| `three.min.js` | 603 KB | ✅ Committed |
| `ort.min.js` | ~5.1 MB | ❌ Needs manual commit |
| `ort-wasm.wasm` | ~5.8 MB | ⚠️ Optional but recommended |
| `ort-wasm-simd.wasm` | ~6.1 MB | ⚠️ Optional but recommended |
| `ort-wasm-threaded.wasm` | ~6.2 MB | ⚠️ Optional but recommended |

All files are well under GitHub's 100 MB per-file limit.

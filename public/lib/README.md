# `/public/lib/` — Local Vendor Bundles

Self-hosted vendor libraries loaded via `<script src="/lib/...">` or
`importScripts('/lib/...')`. Subject to the production CSP
(`connect-src 'self' blob:`); **nothing here may be loaded from a CDN
in production**.

## Contents

| File | Size | Source | Vendoring |
|---|---|---|---|
| `three.min.js` | 603 KB | Three.js r128 (3D spectrogram, Engineer Mode) | committed manually |
| `ort.min.js` + `ort.js` (+ maps) | ~4.3 MB | ONNX Runtime Web (`onnxruntime-web` npm) | auto-vendored |
| `ort-wasm-simd-threaded*.wasm` | ~76 MB total | ONNX Runtime Web WASM backends | auto-vendored |
| `ort-loader.js` | 2 KB | Custom loader wrapper | committed manually |

## Auto-vendoring

The ORT files are mirrored from `node_modules/onnxruntime-web/dist/` by
`scripts/setup-ort.js`. The script runs:

- **Locally:** on `pnpm install` (postinstall hook).
- **On Vercel:** via `buildCommand` in `vercel.json`.

To bump ORT, edit the `onnxruntime-web` version in `package.json`, run
`pnpm install`, then `node scripts/setup-ort.js`. The script removes any
ORT artifacts that are no longer present in the new dist (it owns
`ort-wasm*.wasm`, `ort.js`, `ort.min.js`, plus `.map` siblings).

## Runtime configuration

`ml-worker.js` points ORT at this directory:

```js
ort.env.wasm.wasmPaths = '/lib/';
```

ORT then auto-selects the appropriate `.wasm` variant based on browser
capabilities (SIMD, threading, WebGPU JSEP, JSPI/Asyncify).

# ONNX Model Delivery Strategy

VoiceIsolate Pro processes user audio locally in the browser. ONNX model files
are read-only application assets and are not user data, but their delivery still
has to preserve the local-processing and CSP boundaries.

## Current Delivery Path

```text
Browser
  -> same-origin /app/models/*.onnx URL
  -> Vercel rewrite to the configured Blob object
  -> browser cache / service worker cache where available
```

There are no browser-facing fallback providers. The model loader only accepts
same-origin `/app/models/*.onnx` paths, and `src/core/ModelManifest.js` is the
canonical source for model filenames, sizes, and SHA-256 hashes.

## Why Models Are Not Committed

- Binary ONNX weights are large.
- The repository should stay cloneable without large binary artifacts.
- Model weights are immutable application assets.
- The browser verifies model hashes when a manifest hash is available.

## Runtime Responsibilities

- `src/core/ModelManifest.js` defines canonical model URLs and expected hashes.
- `src/workers/MLWorker.js` fetches model bytes, verifies hashes, and initializes
  ONNX Runtime Web.
- `public/app/model-cdn-loader.js` only accepts same-origin model URLs for the
  legacy Engineer Mode shell.
- `vercel.json` rewrites `/app/models/:filename` and `/models/:filename` to the
  configured Vercel Blob object route.

## Privacy Boundary

- User audio is never transmitted to model storage.
- Inference runs locally through ONNX Runtime Web.
- WebGPU is attempted when supported and falls back to WASM.
- The AudioWorklet render thread never waits on model loading or inference.

## Adding Or Replacing A Model

1. Upload the `.onnx` object to the configured Vercel Blob store.
2. Add or update the matching entry in `src/core/ModelManifest.js`.
3. Include the expected SHA-256 when the model is required for production.
4. Keep the browser URL under `/app/models/*.onnx`.
5. Run `pnpm run validate`, `pnpm run worklets:verify`, and the model-loading
   tests before shipping.

## AudioWorklet Delivery

Playback worklet scripts are committed to the repository and served from
same-origin `/src/workers/*.js` URLs after the Vercel build copies `src/` into
`public/src/`. The legacy `public/app/dsp-processor.js` route is still shipped
with no-cache headers for maintenance compatibility. See
[`WORKLETS.md`](WORKLETS.md) for the cross-platform matrix and CI checks.

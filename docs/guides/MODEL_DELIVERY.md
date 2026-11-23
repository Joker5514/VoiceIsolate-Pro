# ONNX Model Delivery Strategy

VoiceIsolate Pro processes user audio locally in the browser. ONNX model files
are read-only application assets and are not user data, but their delivery still
has to preserve the local-processing and CSP boundaries.

## Current Delivery Path

```text
Browser
  -> same-origin /app/models/*.onnx or /models/*.onnx URL
  -> static files committed under public/app/models/ and public/models/
  -> browser cache / service worker cache where available
```

There are no browser-facing fallback providers. Isolation-model loaders accept
same-origin `/app/models/*.onnx` paths (`src/core/ModelManifest.js`). The opt-in
diarizer loads same-origin `/models/*.onnx` paths
(`src/core/DiarizationModelManifest.js`). Those two manifests are the canonical
sources for filenames, sizes, and SHA-256 hashes.

## Canonical Registry And Generated Projections

`src/core/ModelManifest.js` is the only hand-maintained model definition. Run
`pnpm models:manifests` after changing it (or `pnpm worklets:hash`, which also
regenerates the projections). The deterministic outputs are:

- `public/app/models-manifest.json` — legacy Engineer/CDN compatibility keys;
- `public/app/models/models-manifest.json` — full packaging inventory;
- `public/app/model-registry.generated.js` — classic-script/worker compatibility
  projection used by the legacy Engineer shell.

Do not edit those outputs by hand. `pnpm models:manifests -- --check` and the
static production gate fail on drift. Android and Windows required-file lists
derive from the same canonical shipped entries. Historical training/provenance
notes preserved from the old manifests are in `docs/MODEL_PROVENANCE.md`; they
are publisher statements, not independently re-audited guarantees.

The currently shipped isolation ONNX files are committed under
`public/app/models/`. The three diarization models are committed under
`public/models/`. Optional/unshipped research weights are not downloaded,
bundled, or redistributed by the generator.

## Hugging Face model-card status

The production VoiceIsolate model delivery path is the same-origin static
route above. `scripts/upload-to-huggingface.py` names
`Joker5514/voice-isolate-models` as an **optional publishing target**, but the
current release manifest has no Hugging Face source, immutable revision, or
runtime fallback URL. The repository/model card was not accessible during the
2026-08-22 documentation audit, so it is not a verified shipped-model source.
The Hugging Face links in [`public/models/README.md`](../../public/models/README.md)
are third-party diarization references and must not be represented as the
product's model card.

Before publishing or changing a VoiceIsolate model card, record all of the
following in the owned model repository and then mirror the immutable revision
here: model name/version, license, input/output tensor schema, sample rate,
quantization, platform compatibility, limitations, SHA-256, and the exact
`ModelManifest` entry. Until a maintainer publishes and pins an accessible
revision, `ModelManifest.js` and the committed files under `public/` are the
canonical shipped-model reference.

## Runtime Responsibilities

- `src/core/ModelManifest.js` defines canonical isolation-model URLs and hashes.
- `src/core/DiarizationModelManifest.js` defines the three shipped diarization
  models (`/models/*.onnx` URLs, sizes, and SHA-256). The Vercel build
  validator hash-checks them so a truncated file fails the build. Opt-in
  session load also verifies those pins before creating an ORT session.
- `public/app/models-manifest.json` is a **generated packaging registry** — its
  `models` section is rebuilt from `ModelManifest.js` by
  `node scripts/sync-model-manifests.mjs` (verify with `--check`, enforced by
  `tests/model-manifest-sync.test.js`). Do not hand-edit the `models` section;
  the `worklets` section remains owned by `pnpm worklets:hash`.
- `public/app/models/models-manifest.json` is a hand-maintained **model-card
  document** (I/O tensors, training notes, licenses) kept filename-consistent
  with the canonical registry by the same test.
- `src/workers/MLWorker.js` fetches model bytes, verifies hashes, and initializes
  ONNX Runtime Web.
- `public/app/model-cdn-loader.js` only accepts same-origin model URLs for the
  legacy Engineer Mode shell and verifies exact size/SHA-256 before returning
  fetched or cached bytes.
- Legacy fetch-cache/worker consumers use the generated compatibility projection;
  pinned models fail closed on missing/unavailable verification or mismatch.
  HEAD presence is labelled unverified, never “ML active”.
- `vercel.json` must not rewrite `/app/models/:filename` or `/models/:filename`
  to Vercel Blob. Those paths are served as committed static files so a blocked
  Hobby Blob store cannot 403 required models. The static `model-delivery`
  step of `pnpm prod:verify` is offline: it hash-checks isolation models from
  `ModelManifest.js` and diarization models from `DiarizationModelManifest.js`.
  Live URL delivery is the `model-delivery-remote` step
  (`pnpm models:validate:urls -- --remote`, also run by
  `pnpm prod:verify -- --network`). Optional/unshipped entries (demucs,
  ecapa_tdnn, research models) never block the gate and are never claimed as
  passed.

## Privacy Boundary

- User audio is never transmitted to model storage.
- Inference runs locally through ONNX Runtime Web.
- WebGPU is attempted when supported and falls back to WASM.
- The AudioWorklet render thread never waits on model loading or inference.

## Adding Or Replacing A Model

1. Commit the `.onnx` object under `public/app/models/` (isolation) or
   `public/models/` (diarization). Do not add a Vercel Blob rewrite for it.
2. Add or update the matching entry in `src/core/ModelManifest.js` for
   isolation models, or `src/core/DiarizationModelManifest.js` for the three
   diarization files (keep isolation-only projections scoped to isolation
   entries).
3. Include the expected SHA-256 when the model is required for production.
4. Keep isolation-model browser URLs under `/app/models/*.onnx` and
   diarization URLs under `/models/*.onnx`.
5. Run `pnpm models:manifests`, `pnpm models:validate`,
   `pnpm models:validate:urls`, `pnpm worklets:verify`, and the model-loading
   tests before shipping.
6. For an explicit live-delivery check, run
   `pnpm models:validate:urls -- --remote` (or `pnpm prod:verify -- --network`).
   This downloads required bytes and verifies exact size/SHA-256; HEAD or
   Content-Length alone is never reported as integrity. The default/static gate
   is offline and does not claim remote delivery passed.

## AudioWorklet Delivery

Playback worklet scripts are committed to the repository and served from
same-origin `/src/workers/*.js` URLs after the Vercel build copies `src/` into
`public/src/`. The legacy `public/app/dsp-processor.js` route is still shipped
with no-cache headers for maintenance compatibility. See
[`WORKLETS.md`](WORKLETS.md) for the cross-platform matrix and CI checks.

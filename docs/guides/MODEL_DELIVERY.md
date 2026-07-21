# ONNX Model Delivery Strategy

VoiceIsolate Pro processes all audio **100% locally in the browser**. No audio data
ever leaves the device. However, the ML models themselves (`.onnx` files, up to
several hundred MB) cannot be committed to Git and must be fetched on first use.

## Why models are not in the repo

- Binary ONNX files are typically 50–400 MB each.
- Git / GitHub LFS is not suitable for large binary assets served to end users.
- The models are **read-only weights** — not user data. Fetching them is equivalent
  to a browser downloading a font or wasm binary.

## Delivery pipeline (`model-cdn-loader.js`)

```
 Browser first load
       │
       ▼
 SW Cache (Cache API) ──hit──▶ return ArrayBuffer immediately (zero network)
       │ miss
       ▼
 Vercel Blob  (/app/models/ rewrite — served from same origin, satisfies CSP)
       │ fail
       ▼
 Cloudflare R2  (CORS-enabled, connect-src whitelisted in vercel.json)
       │ fail
       ▼
 HuggingFace Hub  (last resort fallback)
       │
       ▼
 Stored in SW Cache (vip-models-v1) for all future sessions
```

After first download, the model is served from the **SW Cache** — no network
request is made for subsequent sessions.

## Compliance with local-processing constraint

- **Audio processing**: always 100% local (AudioWorklet + ONNX Runtime Web).
- **Model weights**: fetched once, then cached permanently in the browser.
- **User audio data**: never transmitted anywhere.

## Model files location

Model files are hosted on Vercel Blob Storage and mirrored on Cloudflare R2.
The `models-manifest.json` file at `public/app/models-manifest.json` lists all
models, their sizes, checksums, and provider URLs.

## AudioWorklet delivery

Processor scripts (gate, de-esser, legacy dsp-processor) follow the same
same-origin packaging path as ONNX models but are committed to the repo and
pinned by SHA-256 in `models-manifest.json` → `worklets`. See
[`docs/WORKLETS.md`](WORKLETS.md) for the full cross-platform matrix and CI
checks.

## Adding a new model

1. Upload the `.onnx` file to Vercel Blob (`vercel blob upload`).
2. Mirror to R2 and HuggingFace Hub.
3. Add an entry to `models-manifest.json` with all three provider URLs.
4. Set `eager: true` if the model should preload on app boot.

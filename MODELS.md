# VoiceIsolate Pro – Model Hosting Architecture

> **This document is the canonical reference for how ONNX models are stored,
> delivered, and cached. Read this before touching `model-loader.js`,
> `vercel.json` rewrites, or any upload script.**

---

## The Core Constraint

VoiceIsolate Pro uses `SharedArrayBuffer` to pass audio data between the main
thread and the `AudioWorklet` in real-time. `SharedArrayBuffer` requires the
page to be **cross-origin isolated**, which means every response the page
touches must carry:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

A `fetch()` to an external origin (e.g. `huggingface.co`) under `require-corp`
will be **blocked by the browser** unless that external server responds with
`Cross-Origin-Resource-Policy: cross-origin`. HuggingFace's CDN does not
consistently send that header. Even when it does, it introduces an external
dependency that violates the 100% local processing guarantee.

**Therefore: models must be served from the same origin as the app.**

---

## Architecture: Vercel Blob + Same-Origin Rewrite

```
 Browser                  Vercel Edge              Vercel Blob Storage
 ──────                   ───────────              ───────────────────
 fetch('/app/models/      rewrite rule in          Public Blob URL
   demucs_v4.onnx')  ──► vercel.json proxies  ──► returns .onnx bytes
        │                 the request                     │
        │◄────────────────────────────────────────────────┘
        │  Response arrives as same-origin (the rewrite is transparent)
        │
  Cache API stores
  /app/models/demucs_v4.onnx
        │
  sw.js intercepts all
  future fetches to that
  path → returns cached
  bytes, ZERO network
```

From the browser's perspective the fetch is always to `/app/models/*.onnx` —
a same-origin URL. COEP is satisfied. `SharedArrayBuffer` stays alive.

Small models can be committed directly under `public/app/models/` and Vercel
will serve them as static files. Models too large for git (Demucs ~83 MB,
BSRNN ~45 MB) live in Vercel Blob and are reached via a rewrite.

---

## Adding or Updating a Model

### Step 1 — Export the model

Run your export notebook/script locally to produce a `.onnx` file.
Quantize it if possible (reduces size 4×, negligible quality loss for audio
separation at 16-32 bit quantization).

### Step 2 — Upload to Vercel Blob

```bash
# Install dependencies
pip install requests

# Authenticate — create a token at https://vercel.com/account/tokens
export VERCEL_TOKEN=your_token_here
# Optional for team projects:
export VERCEL_TEAM_ID=team_xxx

# Run the upload helper
python scripts/upload_models_to_vercel_blob.py \
    --file ./demucs_v4_quantized.onnx \
    --name demucs_v4_quantized.onnx
```

The script will print the public Blob URL:

```
Uploaded: https://abc123.public.blob.vercel-storage.com/demucs_v4_quantized.onnx
```

### Step 3 — Add the rewrite to `vercel.json`

In the `rewrites` array, **before** the `/app/((?!sw\.js).*)` catch-all:

```json
{
  "source": "/app/models/demucs_v4_quantized.onnx",
  "destination": "https://abc123.public.blob.vercel-storage.com/demucs_v4_quantized.onnx"
}
```

### Step 4 — Verify the model is registered in `model-loader.js`

In `MODEL_REGISTRY`, ensure an entry exists with **no `src` field**:

```js
{
  id:       'demucs_v4',
  filename: 'demucs_v4_quantized.onnx',
  priority: 'lazy',   // or 'eager' if needed at boot
  sizeMB:   83,
},
```

### Step 5 — Deploy

`git commit` the updated `vercel.json` and push. Vercel rebuilds and the
rewrite goes live. The browser's first fetch of `/app/models/demucs_v4_quantized.onnx`
is transparently proxied to the Blob origin, and the response is cached for
all subsequent visits.

---

## What NOT To Do

| Wrong                                                           | Right                                                                  |
|-----------------------------------------------------------------|------------------------------------------------------------------------|
| Add `src: 'https://huggingface.co/...'` to `MODEL_REGISTRY`     | No `src` field — fetch is always same-origin `/app/models/*`           |
| Add `huggingface.co` to CSP `connect-src`                       | Only `'self'`, Vercel scripts, and Vercel Blob hosts in `connect-src`  |
| Set `CORP: cross-origin` on the page itself                     | Page is `same-origin`; `/app/(.*)` may be `cross-origin` for workers   |
| Host models on a different subdomain                            | Same origin only — subdomains break COEP for SAB                       |
| Use `fetch(url, { mode: 'cors' })` for `/app/models/*`          | Plain `fetch(url)` — same-origin needs no CORS mode                    |
| Run a `prebuild` hook that downloads from HuggingFace           | No prebuild download. Vercel serves models directly via rewrites.      |

---

## Current Model Inventory

| ID            | Filename                       | Priority | Size      | Storage             | Purpose                       |
|---------------|--------------------------------|----------|-----------|---------------------|-------------------------------|
| `silero_vad`  | `silero_vad.onnx`              | eager    | 2.2 MB    | Repo (committed)    | Voice activity detection      |
| `rnnoise`     | `rnnoise_suppressor.onnx`      | eager    | 0.18 MB   | Vercel Blob (TBD)   | Noise suppression             |
| `demucs_v4`   | `demucs_v4_quantized.onnx`     | lazy     | ~83 MB    | Vercel Blob (TBD)   | Stem separation               |
| `bsrnn_vocals`| `bsrnn_vocals.onnx`            | lazy     | ~45 MB    | Vercel Blob (TBD)   | Vocal band separation         |

---

## Why Not Git LFS?

Vercel builds do support Git LFS, but LFS bandwidth on GitHub Free is capped at
1 GB/month. A single cold deploy pulling 130 MB of models exhausts that in
~8 deploys. Vercel Blob has no such limit and is served from the same CDN edge
network as the app itself, giving better latency with zero Git overhead.

---

## Local Development

If you want to skip the Vercel Blob round trip while developing locally,
either:

1. Place real `.onnx` files directly in `public/app/models/` — they'll be
   served by the dev server (`pnpm dev`), and Cache API will populate
   normally.

2. Or run `BLOB_BASE_URL=https://abc123.public.blob.vercel-storage.com pnpm models:download`
   to mirror the Blob bucket into `public/app/models/` once.

The browser code path is identical either way: it always fetches
`/app/models/<filename>`.

# VoiceIsolate Pro Technical Guide

Version: 25.0.2
Updated: August 21, 2026

This document describes the production browser runtime served from `public/`.
It intentionally supersedes older blueprint copies that described live
microphone ingestion, server-side audio processing, or cloud inference.

## Runtime Source Of Truth

Vercel serves the static `public/` directory. During the Vercel build,
`scripts/vercel-build.js` validates the repository and copies `src/` to
`public/src/` so browser modules can load from same-origin URLs.

Important served assets:

| Asset | Purpose |
|---|---|
| `/index.html` | Current landing/app shell |
| `/landing.js` | Main production browser entry |
| `/app/index.html` | Legacy Engineer Mode maintenance shell |
| `/app/app.js` | Legacy Engineer Mode UI and offline DSP controls |
| `/app/slider-map.js` | Slider registry source of truth; currently 67 sliders |
| `/src/workers/MLWorker.js` | Local ONNX Runtime worker |
| `/src/workers/GateProcessor.js` | Playback-only AudioWorklet gate |
| `/src/workers/DeEsserProcessor.js` | Playback-only AudioWorklet de-esser |
| `/app/dsp-processor.js` | Legacy shipped DSP worklet, not loaded by current Live-Mix playback |
| `/lib/ort.min.js` and `/lib/*.wasm` | Same-origin ONNX Runtime Web assets |
| `/app/models/*.onnx` | Same-origin model route backed by Vercel Blob rewrites |

## Privacy Boundary

VoiceIsolate Pro processes user audio locally in the browser. The production
runtime is upload/file based and does not include live microphone ingestion.
User audio must not be sent to application servers, telemetry services, model
endpoints, or third-party inference APIs.

Allowed network behavior is limited to application assets, model weights,
authentication/licensing services used by the shell, and browser platform
dependencies declared in the CSP. Model weights are read-only assets; they are
not user data.

## Audio Architecture

The current architecture separates two concerns:

1. Stem-Split: file-based local separation using ONNX Runtime Web in
   `src/workers/MLWorker.js`.
2. Live-Mix: playback control and monitoring through lightweight AudioWorklets
   loaded by `src/pipeline/PlaybackMixer.js`.

The active Live-Mix worklets are playback processors only:

- `GateProcessor.js`
- `DeEsserProcessor.js`

They must not load models, fetch assets, block, or allocate large buffers from
the render callback.

## Spectral Processing Rule

For active spectral separation, compatible ML mask stages run through a fused
single-STFT path:

```text
one forward STFT
all compatible spectral masks applied to the shared spectral representation
one inverse STFT
```

Independent analysis modules such as source analysis or cleanup may own their
own analysis path, but they must not be chained into a reconstruct-and-reanalyze
production path that resets phase.

## Model Loading

`src/core/ModelManifest.js` defines the canonical model URLs. The ML worker:

- Loads ONNX Runtime from `/lib/ort.min.js`.
- Attempts WebGPU when supported and usable.
- Falls back to WASM when WebGPU is unavailable or fails.
- Verifies model hashes where the manifest provides a SHA-256.
- Keeps inference off the AudioWorklet render thread.

Model files are fetched from same-origin `/app/models/*.onnx` URLs. Vercel may
rewrite those URLs to its Blob storage backend, but the browser-facing route and
CSP remain same-origin.

## Deployment Requirements

Vercel production uses:

- `outputDirectory: public`
- `buildCommand: node scripts/vercel-build.js`
- `installCommand: bash scripts/vercel-install.sh`

Required headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

Asset MIME expectations:

```text
JavaScript worklets/workers: text/javascript or application/javascript
.wasm: application/wasm
.onnx: application/octet-stream
```

Non-versioned worklet scripts use no-cache headers so stale CDN copies cannot
silently persist across releases.

## Latency Notes

The current Live-Mix playback worklets are low-latency control processors, but
full ML separation is file/offline oriented. A spectral configuration with a
4096 sample window and 1024 sample hop at 48 kHz has an algorithmic frame
latency of approximately:

```text
(4096 - 1024) / 48000 = 64 ms
```

That configuration cannot honestly be described as sub-10-ms live isolation.
Sub-10-ms behavior only applies to lightweight playback control paths when the
browser device, render quantum, and hardware stack cooperate.

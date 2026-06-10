# VoiceIsolate Pro

**Studio-grade voice isolation, 100% in your browser.**
Upload a recording, let on-device AI split it into a clean-voice stem and a
background-noise stem, then mix the result in real time with zero-latency
sliders. No cloud processing. No uploads. Your audio never leaves the device.

---

## How It Works — Stem-Split & Live-Mix

VoiceIsolate Pro uses a two-phase architecture instead of fragile live-stream
processing:

### Phase 1 — Offline Batch Inference
1. **Upload** any audio or video file.
2. **Ingestion** decodes it and resamples to a canonical 48 000 Hz
   (`src/pipeline/FileIngestion.js`).
3. **AI separation** runs in a Web Worker using ONNX Runtime Web
   (WebGPU when available, WASM fallback). Models like **MDX-Net** (vocal
   separation) and **DeepFilterNet** (noise suppression) process the full file
   once, using overlap-add reconstruction (`src/workers/MLWorker.js`).
4. The output is a pair of stems: **Clean Voice** and **Background Noise**.

### Phase 2 — Real-Time Playback Mixing
The stems are loaded into Web Audio `AudioBufferSourceNode`s routed through
independent `GainNode`s and EQ filters (`src/pipeline/PlaybackMixer.js`).
Moving the **Noise Reduction**, **Volume**, or **EQ** sliders adjusts those
nodes instantly during playback — the ML models are never re-run, so every
control responds with zero latency and zero glitches.

```
Upload ─► Decode/Resample ─► ONNX Inference ─► Clean stem ─► CleanGain ─┐
          (48 kHz)            (one pass)       Noise stem ─► NoiseGain ─┼─► EQ ─► Output
                                                                        ┘
                                       Sliders adjust gains/EQ live ▲
```

## Features

- 🎙️ **AI voice isolation** — MDX-Net vocal separation + DeepFilterNet noise
  suppression, executed entirely on-device
- 🎚️ **Latency-free mixing** — noise reduction, volume, and EQ sliders act on
  the Web Audio graph in real time during playback
- 🔒 **Privacy-first** — zero cloud processing, zero audio upload, models are
  SHA-256 integrity-checked and cached locally (IndexedDB)
- 📦 **Batch-friendly** — process files offline, then audition and export
- 🌐 **Cross-platform** — Web (Vercel), Android & iOS via Capacitor

## Quick Start

```bash
pnpm install     # installs deps and vendors ONNX Runtime / Three.js locally
pnpm dev         # http://localhost:3000
pnpm test        # Jest suites
pnpm lint        # ESLint
pnpm validate    # structural integrity checks
```

Requirements: **Node.js ≥ 22**, **pnpm ≥ 9**.

No `.env` is needed for local audio processing. Payment/licensing features
require the variables documented in [`.env.example`](.env.example).

## Repository Layout

```
src/                    New 4-layer architecture (all new work goes here)
├── core/               Layer 1 — pure primitives (audio-config, BufferPool, ModelManifest)
├── workers/            Layer 2 — MLWorker (ONNX inference, model cache + integrity)
├── pipeline/           Layer 3 — FileIngestion, PlaybackMixer
└── presentation/       Layer 4 — SliderUI (DOM bindings, rAF-coalesced)

server/                 Express security middleware (securityHeaders.js)
public/                 Static site + legacy Engineer Mode app (maintenance freeze)
api-routes/             Serverless API (Stripe monetization, licensing, sync)
tests/                  Jest suites
scripts/                Build, validation, and model tooling
android/ ios/           Capacitor mobile projects
```

## Architecture Rules

The full contributor contract — layer boundaries, security headers, model
integrity, and the list of forbidden legacy patterns (live-microphone
ingestion, client-side auth, CDN-loaded libraries) — lives in
[`CLAUDE.md`](CLAUDE.md). Read it before contributing; CI and
`scripts/validate.js` enforce it.

## Security

- Strict security headers (`COOP`/`COEP`, CSP, `nosniff`, `microphone=()`)
  via `server/securityHeaders.js` in development and `vercel.json` in
  production
- All secrets via environment variables — see `.env.example`
- ONNX models verified against pinned SHA-256 hashes before execution

## License

UNLICENSED — © Randy Jordan. All rights reserved.

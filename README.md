# VoiceIsolate Pro

<p align="center">
  <strong>Studio-grade voice isolation, 100% in your browser.</strong><br>
  Upload a recording, let on-device AI split it into clean-voice and background-noise stems,
  then mix the result in real time with zero-latency sliders.
</p>

<p align="center">
  <a href="https://voice-isolate-pro.vercel.app">Live Demo</a> ·
  No cloud processing · No audio upload · Your data never leaves the device
</p>

---

## Features

| Feature | Description |
|---------|-------------|
| **AI voice isolation** | Demucs vocal-ratio mask + BiGRU noise suppression via ONNX Runtime Web (WebGPU / WASM) |
| **Speaker diarization** | Log-mel timbral fingerprinting clusters voices by timbre |
| **Real-time progress UI** | Four-step ProcessLoader (decode → resample → load model → separate) with live % |
| **Latency-free mixing** | 67 calibrated sliders (NR, EQ, gate, de-esser, per-speaker volume) on the Web Audio graph |
| **Live visualizations** | Canvas 2D waveform + spectrum on Landing; spectrogram, 3D topo, particle swarm on Engineer Mode |
| **Privacy-first** | Zero cloud processing; models SHA-256 verified and cached in IndexedDB |
| **Export** | WAV or MP3 off the main thread via `AudioEncoderWorker` |
| **Cross-platform** | Web (Vercel), Android & iOS via Capacitor |

## How It Works

VoiceIsolate Pro uses a deliberate **two-phase** model:

### Phase 1 — Offline Batch Inference

```
Upload → Decode/Resample (48 kHz) → Demucs → RNNoise → Spectral Cleanup → Diarization
                                              (one pass per file)
                                    ┌─────────┴─────────┐
                                    ▼                   ▼
                              Clean stem          Noise stem
```

Stereo channels run in parallel inside `MLWorker.js`. Model bytes are cached in IndexedDB and verified on every load.

### Phase 2 — Real-Time Playback Mixing

Stems load into Web Audio `AudioBufferSourceNode`s with independent `GainNode`s, EQ, gate, and de-esser. Sliders adjust the graph instantly — ML models are never re-run.

## Quick Start

### Requirements

- **Node.js** ≥ 22
- **pnpm** ≥ 10

### Install & run

```bash
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro
pnpm install          # vendors ONNX Runtime + Three.js locally
pnpm dev              # http://localhost:3000  (auto-syncs src/ → public/src/)
```

### Other commands

```bash
pnpm test             # Jest — 2100+ tests
pnpm lint             # ESLint
pnpm validate         # Structural integrity checks (CI gate)
pnpm build            # Production static build
pnpm build:mobile     # Capacitor sync for Android/iOS
```

No `.env` is needed for local audio processing. Payment and licensing features require the variables in [`.env.example`](.env.example).

## Pages

| Route | Purpose |
|-------|---------|
| `/` | **Landing** — Stem-Split & Live-Mix with on-device ML (`public/index.html`) |
| `/app/` | **Engineer Mode** — 32-stage classical DSP stack with premium visualizations (`public/app/`) |

Both surfaces share the canonical `src/pipeline/StemSeparation.js` path for offline ML (Demucs → RNNoise chain).

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vanilla JS (ES modules), Canvas 2D, Three.js (Engineer premium tabs) |
| ML | ONNX Runtime Web 1.25, WebGPU + WASM (up to 8 threads) |
| Audio | Web Audio API, AudioWorklets (gate + de-esser on playback stems) |
| Server | Express 5 (dev), Vercel serverless (prod, pnpm via `scripts/vercel-install.sh`) |
| Payments | Stripe (optional, server-side only) |
| Mobile | Capacitor 8 (Android / iOS) |
| CI | GitHub Actions — Jest, ESLint, Semgrep, njsscan |

## Repository Layout

```
src/                       Canonical 4-layer architecture
├── core/                  Pure primitives, ModelManifest, BufferPool
├── workers/               MLWorker (offline), Diarization, SpectralCleanup, Encoders
├── pipeline/              FileIngestion, PlaybackMixer, StemSeparation, Orchestrators
└── presentation/          SliderUI, LandingVisualizer, ExportControls

public/
├── index.html + landing.js    Landing page (ProcessLoader, PlaybackMixer)
├── app/                       Engineer Mode shell (67 sliders via SLIDER_REGISTRY)
└── lib/                       Vendored ort.min.js, three.module.js

server/                    Express + securityHeaders.js
api-routes/                Stripe monetization, licensing, sync
tests/                     80+ Jest suites
scripts/                   Build, validation, model tooling, Vercel install
```

See [`CLAUDE.md`](CLAUDE.md) for the full contributor contract and [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow.

## Security

- Strict headers (`COOP`/`COEP`, CSP, `nosniff`, `X-Frame-Options`, `microphone=()`) via `server/securityHeaders.js` and `vercel.json`
- All secrets via environment variables — see `.env.example`
- ONNX models verified against pinned SHA-256 hashes before every session

## License

UNLICENSED — © Randy Jordan. All rights reserved.
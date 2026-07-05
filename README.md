# VoiceIsolate Pro

<p align="center">
  <strong>Studio-grade voice isolation, 100% in your browser.</strong><br>
  Upload a recording, let on-device AI split it into clean-voice and background-noise stems,
  then mix the result in real time with zero-latency sliders.
</p>

<p align="center">
  <a href="https://v0-voice-isolate-pro.vercel.app">Live Demo</a> ·
  No cloud processing · No audio upload · Your data never leaves the device
</p>

---

## Features

| Feature | Description |
|---------|-------------|
| **AI voice isolation** | Band-Split RNN vocal separation + BiGRU noise suppression via ONNX Runtime Web (WebGPU / WASM) |
| **Speaker diarization** | Log-mel timbral fingerprinting clusters voices by timbre |
| **Latency-free mixing** | NR, per-speaker volume, EQ, noise gate, and de-esser sliders act on the Web Audio graph in real time |
| **Live visualizations** | Canvas 2D waveform overview + spectrum analyzer on Landing; scrolling spectrogram, frequency rail, 3D topo, particle swarm on Engineer Mode |
| **Privacy-first** | Zero cloud processing; models SHA-256 verified and cached in IndexedDB |
| **Export** | WAV or MP3 off the main thread via `AudioEncoderWorker` |
| **Cross-platform** | Web (Vercel), Desktop (Electron MVP), Android via Capacitor (iOS out of scope v1.0) |

## How It Works

VoiceIsolate Pro uses a deliberate **two-phase** model:

### Phase 1 — Offline Batch Inference

```
Upload → Decode/Resample (48 kHz) → VAD → ONNX Inference → Spectral Cleanup → Diarization
                                              (one pass)
                                    ┌─────────┴─────────┐
                                    ▼                   ▼
                              Clean stem          Noise stem
```

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
pnpm build:mobile     # Capacitor sync for Android
pnpm electron:dev     # Desktop shell (requires pnpm dev in another terminal)
pnpm build:electron   # Signed desktop installer (electron-builder)
```

No `.env` is needed for local audio processing. Payment and licensing features require the variables in [`.env.example`](.env.example).

### Desktop (Electron)

```bash
pnpm dev              # Terminal 1
pnpm electron:dev     # Terminal 2 — secure preload, filesystem model cache
```

See [`docs/electron-desktop.md`](docs/electron-desktop.md) and [`docs/VoiceIsolate-Pro_Master_Blueprint_v2.1.md`](docs/VoiceIsolate-Pro_Master_Blueprint_v2.1.md).

## Pages

| Route | Purpose |
|-------|---------|
| `/` | **Landing** — Stem-Split & Live-Mix with on-device ML (`public/index.html`) |
| `/app/` | **Engineer Mode** — 32-stage classical DSP stack with premium visualizations (`public/app/`) |

Both pages share the canonical `src/` pipeline for ML handoff via `EngineerModeBridge.js`.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vanilla JS (ES modules), Canvas 2D, Three.js (Engineer premium tabs) |
| ML | ONNX Runtime Web 1.25, WebGPU + WASM |
| Audio | Web Audio API, AudioWorklets |
| Server | Express 5 (dev), Vercel serverless (prod) |
| Payments | Stripe (optional, server-side only) |
| Mobile | Capacitor 8 (Android / iOS) |
| CI | GitHub Actions — Jest, ESLint, Semgrep, njsscan |

## Repository Layout

```
src/                       Canonical 4-layer architecture
├── core/                  Pure primitives, ModelManifest, BufferPool
├── workers/               MLWorker, Diarization, SpectralCleanup, Encoders
├── pipeline/              FileIngestion, PlaybackMixer, Orchestrators
└── presentation/          SliderUI, LandingVisualizer, ExportControls

public/
├── index.html + landing.js    Landing page
├── app/                       Engineer Mode shell
└── lib/                       Vendored ort.min.js, three.module.js

server/                    Express + securityHeaders.js
api-routes/                Stripe monetization, licensing, sync
tests/                     80 Jest suites
scripts/                   Build, validation, model tooling
```

See [`CLAUDE.md`](CLAUDE.md) for the full contributor contract and [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow.

## Security

- Strict headers (`COOP`/`COEP`, CSP, `nosniff`, `X-Frame-Options`, `microphone=()`) via `server/securityHeaders.js` and `vercel.json`
- All secrets via environment variables — see `.env.example`
- ONNX models verified against pinned SHA-256 hashes before every session

## License

UNLICENSED — © Randy Jordan. All rights reserved.
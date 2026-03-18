# VoiceIsolate Pro

[![CI](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml)
<!-- codespaces badge marker --> [![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Joker5514/VoiceIsolate-Pro)
![Version](https://img.shields.io/badge/version-19.0.0-blue)
![License](https://img.shields.io/badge/license-UNLICENSED-red)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green)

> **Studio-grade voice isolation and audio enhancement — 100% local, zero cloud inference.**

VoiceIsolate Pro is a browser-based audio processing platform powered by a **32-stage Octa-Pass DSP pipeline** that combines hybrid ML and classical spectral processing. Built on the **Threads from Space v8** architecture, every byte of audio stays on your device — no uploads, no telemetry, no exceptions.

---

## Current Version: v19.0.0

**Engineer Mode v19** is the current stable release, featuring:
- 52-slider real-time control interface
- 3D spectrogram canvas (WebGL-accelerated)
- Full 32-stage Octa-Pass pipeline in Creator and Forensic modes
- Live mode under 10ms latency via AudioWorklet + SharedArrayBuffer
- WASM + WebGPU dual execution path via ONNX Runtime Web

---

## Features

- **32-stage Octa-Pass DSP** — 8 parallel passes, 4 stages each, for maximum quality
- **Hybrid ML + Classical Spectral** — Demucs v4.1, BSRNN, and classical filters working in tandem
- **100% Local Processing** — audio never leaves your device; no server uploads, no cloud inference
- **Three Execution Modes** — Live (<10ms), Creator (full quality), and Forensic (SHA-256 audit trail)
- **Engineer Mode v19** — 52-slider real-time control interface with 3D spectrogram
- **WebGPU-Accelerated** — falls back to WASM automatically via ONNX Runtime Web
- **Single-Pass Spectral Architecture** — one STFT → in-place ops → one iSTFT, eliminating phase smearing
- **ESM-native** — fully ES Module codebase (`"type": "module"`)

---

## Quick Start

### Local Development

```bash
# Clone the repo
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro

# Install dependencies
npm install

# Start dev server (port 3000, CORS enabled)
npm run dev

# Or open directly in browser
open public/app/index.html
```

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Serve `public/` on port 3000 with CORS |
| `npm run build` | Copy `public/` into `build/` directory |
| `npm run lint` | Run ESLint on core pipeline files |
| `npm run lint:fix` | Auto-fix ESLint issues |
| `npm test` | Run Jest test suite |
| `npm run test:watch` | Run Jest in watch mode |
| `npm run validate` | Run custom validation script |

### Deploy to Vercel

Push to `main` — Vercel auto-deploys on every commit via `vercel.json`. No additional configuration needed.

---

## Open in GitHub Codespaces

Get a full cloud-based editor with live preview in one click:

1. Click the **Open in GitHub Codespaces** badge above (or [click here](https://codespaces.new/Joker5514/VoiceIsolate-Pro))
2. Dependencies install automatically via `npm install`
3. Run `npm run dev` to start the preview server on port 3000
4. The preview URL appears automatically in the **Ports** panel

---

## Architecture

```
Audio Input
  → [INGEST]         4 stages  — format normalization, sample-rate conversion
  → [ANALYSIS]       4 stages  — FFT, VAD (Silero v5), speaker embedding (ECAPA-TDNN)
  → [ML SEPARATION]  4 stages  — Demucs v4.1 + BSRNN ensemble
  → [SPECTRAL]       4 stages  — single-pass STFT, in-place spectral ops, iSTFT
  → [ROOM]           4 stages  — reverb estimation and removal
  → [TIME-DOMAIN]    4 stages  — transient shaping, de-essing
  → [NEURAL]         4 stages  — HiFi-GAN v2 vocoder reconstruction
  → [MASTER]         4 stages  — loudness normalization (EBU R128), limiter
  → Output (WAV / Stream)
```

### Critical Design Principle

> **Single-pass spectral architecture**: Exactly **one** Forward STFT → all spectral operations performed in-place → exactly **one** Inverse STFT (iSTFT). This eliminates phase smearing caused by multiple spectral round-trips. This constraint is enforced at the architecture level.

### Threading Model (Threads from Space v8)

- **Main Thread** — UI, ONNX Runtime Web inference, model I/O coordination
- **AudioWorklet Thread** — real-time DSP, STFT execution, SharedArrayBuffer bridge
- **DSP Worker** (`dsp-worker.js`) — heavy offline pipeline stages, non-real-time processing
- **ML Worker** (`ml-worker.js`) — model loading, batched inference scheduling

---

## Execution Modes

| Mode | Latency | Pipeline | Context | Use Case |
|------|---------|----------|---------|----------|
| **Live** | <10ms | AudioWorklet + SharedArrayBuffer, reduced stages | `AudioContext` | Real-time streaming / monitoring |
| **Creator** | Offline | Full 32-stage pipeline | `OfflineAudioContext` | Maximum quality export |
| **Forensic** | Offline | Conservative pipeline + SHA-256 per stage | `OfflineAudioContext` | Evidentiary / legal use |

---

## ML Models (ONNX Runtime Web)

| Model | Role | Quantization | Approx. Size |
|-------|------|-------------|--------------|
| **Demucs v4.1** | Source separation (Transformer + U-Net hybrid) | INT8 | ~150MB |
| **BSRNN** | Band-Split RNN ensemble partner | INT8 | ~80MB |
| **ECAPA-TDNN** | Speaker embeddings (256-dim) | FP16 | ~25MB |
| **Silero VAD v5** | Voice activity detection | INT8 | ~2MB |
| **HiFi-GAN v2** | Neural vocoder reconstruction | FP16 | ~55MB |
| **Conformer** | Spectral enhancement / final polish | INT8 | ~40MB |

All models are loaded and executed **100% locally** via ONNX Runtime Web.  
**Execution provider priority: WebGPU → WASM (automatic fallback)**. Zero cloud inference.

---

## Project Structure

```
VoiceIsolate-Pro/
├── public/
│   ├── index.html              # Landing page / app entry
│   └── app/
│       ├── index.html          # Engineer Mode v19 — 52-slider UI
│       ├── style.css           # Dark industrial theme
│       ├── app.js              # DSP pipeline + Web Audio API routing
│       ├── dsp-worker.js       # Offline DSP worker thread
│       └── ml-worker.js        # ML inference worker thread
├── src/                        # TypeScript source (compiled to public/)
├── scripts/
│   └── validate.js             # Pipeline validation script
├── tests/                      # Jest test suite
├── build/                      # Production build output (generated)
├── wasm/                       # WASM binaries (FFT, auxiliary DSP)
├── demos/                      # Demo audio samples
├── v19-demo/                   # v19 standalone demo build
├── .github/                    # CI/CD workflows
├── .devcontainer/              # GitHub Codespaces config
├── Dockerfile                  # Container config
├── compose.yaml                # Docker Compose (production)
├── compose.debug.yaml          # Docker Compose (debug)
├── render.yaml                 # Render.com deployment config
├── vercel.json                 # Vercel deployment config
├── package.json                # v19.0.0 — ESM, scripts, deps
├── eslint.config.js            # ESLint flat config (ESLint v9)
└── tsconfig.json               # TypeScript config
```

---

## Dependencies

### Runtime
| Package | Version | Purpose |
|---------|---------|---------|
| `@vercel/analytics` | ^2.0.1 | Edge analytics (privacy-respecting) |

### Development
| Package | Version | Purpose |
|---------|---------|---------|
| `eslint` | ^9.0.0 | Linting (flat config) |
| `@eslint/js` | ^9.0.0 | ESLint JS rules |
| `globals` | ^16.0.0 | Global variable definitions |
| `jest` | ^29.7.0 | Unit testing |
| `jest-environment-jsdom` | ^30.2.0 | Browser-like test environment |

**Node.js requirement: `>=18.0.0`**

---

## Version History

| Version | Key Innovation |
|---------|----------------|
| v4 | Auto noise profiling, spectral subtraction |
| v5 | Threads from Space concept, 12-stage pipeline |
| v7 | Modular node graph, thread-per-stage |
| v11 | ERB spectral gate, Band-Split RNN |
| v13 | Neural vocoder, phase-coherent reconstruction |
| v15 | Real Web Audio API chains |
| v16 | BSRNN ensemble, 40+ slider wiring |
| v17 | OfflineAudioContext graph, A/B comparison |
| v18 | Conformer refiner, forensic audit chain |
| **v19** | **52-slider Engineer Mode, 3D spectrogram, ESM-native, v19.0.0 stable** |

---

## Privacy & Security

- **100% local processing** — audio never leaves your device
- **Zero telemetry** on audio data
- **AES-256 encryption** at rest (optional, Forensic mode)
- **CSP headers** block all network calls during audio processing
- **No cloud inference** — all ML models execute in-browser via ONNX Runtime Web

---

## Browser Requirements

| Feature | Minimum |
|---------|---------|
| Web Audio API | Chrome 66+, Firefox 76+, Safari 14.1+ |
| AudioWorklet | Chrome 66+, Firefox 76+, Safari 14.1+ |
| SharedArrayBuffer | Chrome 92+ (requires COOP/COEP headers) |
| WebGPU (optional) | Chrome 113+, Edge 113+ |
| WASM (fallback) | All modern browsers |

---

**VoiceIsolate Pro v19.0.0** · Threads from Space v8 · Privacy-First · Updated March 2026

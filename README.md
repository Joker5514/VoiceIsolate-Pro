# VoiceIsolate Pro

[![CI](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Joker5514/VoiceIsolate-Pro)
![Version](https://img.shields.io/badge/version-19.0.0-blue)
![License](https://img.shields.io/badge/license-All%20Rights%20Reserved-red)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green)
![Platform](https://img.shields.io/badge/platform-browser-lightgrey)
![Privacy](https://img.shields.io/badge/privacy-100%25%20local-brightgreen)

> **Studio-grade voice isolation and audio enhancement — 100% local, zero cloud inference.**

VoiceIsolate Pro is a browser-based audio processing platform powered by a **32-stage Octa-Pass DSP pipeline** that combines hybrid ML and classical spectral processing. Built on the **Threads from Space v8** architecture, every byte of audio stays on your device — no uploads, no telemetry, no exceptions.

---

## Current Version: v19.0.0 — Engineer Mode

**Engineer Mode v19** is the current stable release, featuring:

- **52-slider** real-time control interface with tooltip descriptions
- **3D spectrogram canvas** (WebGL-accelerated via Three.js r128)
- **Full 32-stage Octa-Pass pipeline** in Creator and Forensic modes
- **Live mode** under 10 ms latency via AudioWorklet + SharedArrayBuffer
- **WASM + WebGPU** dual execution via ONNX Runtime Web 1.18
- **7 built-in presets**: Podcast, Film, Interview, Forensic, Music, Broadcast, Restoration
- **Forensic audit trail**: SHA-256 hash per pipeline stage with downloadable log

---

## Features

| Feature | Detail |
|---------|--------|
| **32-stage Octa-Pass DSP** | 8 passes × 4 stages: Ingest → Analysis → Filter → Spectral NR → EQ → Spectral Processing → Dynamics → Master |
| **Hybrid ML + Classical** | Demucs v4.1, BSRNN, DeepFilterNet3 working alongside Wiener filtering and spectral subtraction |
| **100% Local Processing** | Audio never leaves your device. No server uploads. No cloud inference. |
| **Three Execution Modes** | Live (<10 ms), Creator (full quality), Forensic (SHA-256 audit trail) |
| **Single-Pass Spectral** | One STFT → in-place ops → one iSTFT eliminates phase smearing |
| **WebGPU Acceleration** | GPU-accelerated ONNX inference, auto-falls back to WASM |
| **AudioWorklet Engine** | Dedicated DSP thread with SharedArrayBuffer parameter bridge |
| **Privacy-First** | COOP/COEP security headers, CSP blocks external network during processing |
| **ESM-Native** | Full ES Module codebase (`"type": "module"`) |
| **14-file Jest Suite** | Unit tests for DSP algorithms, presets, transport, and file handling |

---

## Quick Start

### Local Development

```bash
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro
npm install
npm run dev          # Serves public/ on http://localhost:3000 with CORS
```

### Docker

```bash
# Production
docker compose up --build

# Debug mode (with volume mounts)
docker compose -f compose.debug.yaml up --build
```

### GitHub Codespaces

Click the **Open in GitHub Codespaces** badge above — dependencies install and the dev server starts automatically. The preview URL appears in the **Ports** panel.

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Serve `public/` on port 3000 with CORS |
| `npm run build` | Copy `public/` into `build/` directory |
| `npm run lint` | Run ESLint on core pipeline files |
| `npm run lint:fix` | Auto-fix ESLint issues |
| `npm test` | Run Jest test suite (14 test files) |
| `npm run test:watch` | Run Jest in watch mode |
| `npm run validate` | Run custom pipeline validation script |

---

## Architecture

### 32-Stage Octa-Pass Pipeline

```
Audio Input (WAV / MP3 / OGG / M4A / FLAC / Video)
  │
  ├─ Pass 1 · INGEST (4 stages)
  │    Input Decode → Channel Analysis → DC Offset Removal → Peak Normalization
  │
  ├─ Pass 2 · ANALYSIS (4 stages)
  │    Noise Floor Profiling → VAD (Silero v5) → Spectral Fingerprint → STFT Engine Init
  │
  ├─ Pass 3 · FILTER (4 stages)
  │    High-Pass Filter → Low-Pass Filter → Voice Band Isolation → Adaptive Noise Gate
  │
  ├─ Pass 4 · SPECTRAL NR (4 stages)
  │    Spectral Subtraction → Wiener Filter → Background Suppression → Dereverberation
  │
  ├─ Pass 5 · EQ (4 stages)
  │    Low Shelf (Sub/Bass) → Low-Mid Band → Mid Band (Presence/Clarity) → High Shelf (Air/Brilliance)
  │
  ├─ Pass 6 · SPECTRAL PROCESSING (4 stages)
  │    De-Essing → Spectral Tilt → Formant Shift → Phase Correction
  │
  ├─ Pass 7 · DYNAMICS (4 stages)
  │    Harmonic Reconstruction → Compression → Brickwall Limiter → Crosstalk Cancellation
  │
  └─ Pass 8 · MASTER (4 stages)
       Dry/Wet Blend → TPDF Dither → Output Normalization → Final Render & Export
```

### Critical Design Principle

> **Single-pass spectral architecture**: Exactly **one** forward STFT → all spectral operations in-place → exactly **one** iSTFT. This eliminates phase smearing caused by multiple spectral round-trips. Enforced at the architecture level.

### Threading Model (Threads from Space v8)

```
┌─ Main Thread ─────────────────────────────┐
│  UI rendering, file decode, ONNX coord    │
└───────────────┬───────────────────────────┘
                │ AudioContext / postMessage
┌───────────────▼───────────────────────────┐
│  AudioWorklet Thread (dsp-worker.js)      │
│  Real-time DSP <10 ms                     │
│  HP/LP biquad · Gate · Comp · Limiter     │
│  SharedArrayBuffer param bridge           │
└───────────────┬───────────────────────────┘
                │ Worker postMessage
┌───────────────▼───────────────────────────┐
│  ML Worker (ml-worker.js)                 │
│  ONNX Runtime Web (WebGPU → WASM)         │
│  DeepFilterNet3 · Demucs v4 · Silero VAD  │
└───────────────────────────────────────────┘
```

---

## Execution Modes

| Mode | Latency | Pipeline | Context | Use Case |
|------|---------|----------|---------|----------|
| **Live** | <10 ms | AudioWorklet — HP/LP/Gate/Comp/Limiter | `AudioContext` | Real-time monitoring/streaming |
| **Creator** | Offline | Full 32-stage Octa-Pass | `OfflineAudioContext` | Maximum quality export |
| **Forensic** | Offline | Conservative + SHA-256 hash per stage | `OfflineAudioContext` | Evidentiary/legal audio |

---

## ML Models (ONNX Runtime Web)

| Model | Role | Exec Provider | Size |
|-------|------|---------------|------|
| **Silero VAD v5** | Voice activity detection (10 ms frames) | WASM / WebGPU | ~2 MB |
| **DeepFilterNet3** | Low-latency speech enhancement (enc + erb_dec + df_dec) | WASM / WebGPU | ~35 MB |
| **Demucs v4.1** | Source separation — Transformer + U-Net hybrid | WebGPU recommended | ~150 MB |
| **BSRNN** | Band-Split RNN ensemble vocal separation | WASM / WebGPU | ~80 MB |
| **ECAPA-TDNN** | 256-dim speaker embeddings | WASM / WebGPU | ~25 MB |
| **HiFi-GAN v2** | Neural vocoder reconstruction | WASM / WebGPU | ~55 MB |
| **Conformer** | Spectral enhancement / final polish | WASM / WebGPU | ~40 MB |

**Execution priority: WebGPU → WASM (automatic fallback).** All models run 100% locally.

---

## 52-Slider Parameter Reference

| Group | Sliders | Key Controls |
|-------|---------|-------------|
| **Gate** (6) | Threshold, Range, Attack, Release, Hold, Lookahead | Controls noise gate open/close behavior |
| **Noise Reduction** (5) | Amount, Sensitivity, Spectral Subtract, Floor, Smoothing | Drives Wiener + spectral subtraction pipeline |
| **EQ** (10) | Sub 40 Hz → Brilliance 16 kHz | 10-band parametric covering full vocal spectrum |
| **Dynamics** (8) | Comp Threshold/Ratio/Attack/Release/Knee/Makeup, Limiter Ceiling/Release | Feed-forward compressor + brickwall limiter |
| **Spectral** (8) | HP/LP Freq+Q, De-Ess Freq+Amount, Spectral Tilt, Formant Shift | Spectral shaping and voice character control |
| **Advanced** (6) | Dereverb Amount/Decay, Harmonic Recovery/Order, Stereo Width, Phase Correction | Room treatment and harmonic reconstruction |
| **Separation** (5) | Voice Isolation, Background Suppress, Voice Focus Lo/Hi, Crosstalk Cancel | ML-driven source separation controls |
| **Output** (4) | Output Gain, Dry/Wet Mix, Dither, Output Width | Final master section |

Sliders marked **RT** update in real-time during playback via AudioWorklet parameter messaging.

---

## Presets

| Preset | NR | Voice Isolation | Use Case |
|--------|----|-----------------|---------|
| **Podcast** | 60% | 80% | Balanced vocal clarity with moderate compression |
| **Film** | 40% | 60% | Preserve dynamics, minimal processing artefacts |
| **Interview** | 55% | 75% | Two-person recordings, crosstalk cancellation |
| **Forensic** | 30% | 90% | Maximum fidelity, SHA-256 audit trail enabled |
| **Music** | 25% | 50% | Gentle processing, wide stereo, minimal coloration |
| **Broadcast** | 65% | 85% | Aggressive NR, loudness normalized, tight comp |
| **Restoration** | 45% | 65% | Archival/degraded recordings, harmonic recovery |

---

## Project Structure

```
VoiceIsolate-Pro/
├── public/                     # Served root
│   ├── index.html              # Landing page
│   ├── icon.jpg                # App icon
│   └── app/
│       ├── index.html          # Engineer Mode v19 — 52-slider UI
│       ├── app.js              # Main orchestrator (1662 lines)
│       ├── dsp-worker.js       # AudioWorklet processor (<10 ms DSP)
│       ├── ml-worker.js        # ONNX Runtime inference worker
│       ├── style.css           # Dark industrial theme
│       └── models/
│           └── silero_vad.onnx # Bundled VAD model (2.3 MB)
├── src/                        # TypeScript/JS source modules
│   ├── dsp-processor.js        # AudioWorklet DSP helper
│   ├── main.js                 # Entry point
│   ├── visualizer.js           # 3D spectrogram (Three.js)
│   ├── worker-pool.js          # Multi-worker orchestration
│   └── shared/
│       └── param-buffer.js     # SharedArrayBuffer param bridge
├── tests/                      # Jest test suite (14 files)
├── scripts/
│   └── validate.js             # Pipeline validation
├── wasm/                       # WebAssembly binaries
├── demos/                      # Demo audio samples
├── build/                      # Production build output
├── .devcontainer/
│   └── devcontainer.json       # GitHub Codespaces / VS Code Dev Container
├── .github/
│   └── workflows/
│       └── deploy.yml          # CI/CD — Lint, Test, Vercel deploy
├── Dockerfile                  # Alpine Node.js production container
├── compose.yaml                # Docker Compose (production)
├── compose.debug.yaml          # Docker Compose (debug, volume mounts)
├── vercel.json                 # Vercel config — COOP/COEP/CSP headers
├── render.yaml                 # Render.com deployment config
├── package.json                # v19.0.0 — ESM, scripts, deps
├── eslint.config.js            # ESLint v9 flat config
├── tsconfig.json               # TypeScript config
├── LICENSE                     # All Rights Reserved
└── TECHNICAL.md                # Full DSP + architecture technical reference
```

---

## Dependencies

### Runtime

| Package | Version | Purpose |
|---------|---------|---------|
| `@vercel/analytics` | ^2.0.1 | Edge analytics (privacy-respecting, no audio data) |

### Development

| Package | Version | Purpose |
|---------|---------|---------|
| `eslint` | ^9.0.0 | Linting (ESLint v9 flat config) |
| `@eslint/js` | ^9.0.0 | ESLint JavaScript rule set |
| `globals` | ^16.0.0 | Global variable definitions for browser/node/worker |
| `jest` | ^29.7.0 | Unit testing framework |
| `jest-environment-jsdom` | ^30.2.0 | Browser-like DOM environment for tests |

**Node.js: `>=18.0.0`** (Node 22 recommended for dev container)

### CDN Libraries (loaded at runtime)

| Library | Version | Purpose |
|---------|---------|---------|
| `onnxruntime-web` | 1.18.0 | ONNX model execution (WebGPU/WASM) |
| `three.js` | r128 | WebGL 3D spectrogram visualization |

---

## Browser Requirements

| Feature | Minimum Version |
|---------|----------------|
| Web Audio API | Chrome 66+, Firefox 76+, Safari 14.1+ |
| AudioWorklet | Chrome 66+, Firefox 76+, Safari 14.1+ |
| SharedArrayBuffer | Chrome 92+ (requires COOP/COEP headers) |
| WebGPU (optional) | Chrome 113+, Edge 113+ |
| WASM (fallback) | All modern browsers |

---

## Privacy & Security

- **100% local processing** — audio never leaves your device
- **Zero audio telemetry** — only anonymous edge analytics via Vercel
- **COOP/COEP headers** — required for SharedArrayBuffer, enforced by `vercel.json`
- **CSP policy** — blocks all external network requests during processing
- **Forensic mode** — SHA-256 hash per processing stage, downloadable audit log
- **No vendor lock-in** — all ML models run locally via ONNX Runtime Web

---

## Deployment

### Vercel (Recommended)

Push to `main` — CI runs lint + tests, then Vercel auto-deploys. Required headers (COOP/COEP/CSP) are set in `vercel.json`.

### Docker

```bash
docker compose up --build        # Production on port 3000
docker compose -f compose.debug.yaml up  # Debug with live reload
```

### Render.com

`render.yaml` is pre-configured. Connect your repository and deploy directly.

---

## Version History

| Version | Key Innovation |
|---------|----------------|
| v4 | Auto noise profiling, spectral subtraction |
| v5 | Threads from Space concept, 12-stage pipeline |
| v7 | Modular node graph, thread-per-stage architecture |
| v11 | ERB spectral gate, Band-Split RNN integration |
| v13 | Neural vocoder, phase-coherent reconstruction |
| v15 | Real Web Audio API chains |
| v16 | BSRNN ensemble, 40+ slider wiring |
| v17 | OfflineAudioContext graph, A/B comparison |
| v18 | Conformer refiner, forensic audit chain |
| **v19** | **52-slider Engineer Mode, 3D spectrogram, ESM-native, ONNX Runtime Web 1.18** |

---

## License

Copyright © 2024–2026 VoiceIsolate Pro. All Rights Reserved.
See [LICENSE](./LICENSE) for full terms.

---

**VoiceIsolate Pro v19.0.0** · Threads from Space v8 · Privacy-First · Updated March 2026

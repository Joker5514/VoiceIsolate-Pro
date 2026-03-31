# VoiceIsolate Pro

[![CI & Deploy](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml)
![Version](https://img.shields.io/badge/version-22.1.0-blue)
![License](https://img.shields.io/badge/license-All%20Rights%20Reserved-red)
![Platform](https://img.shields.io/badge/platform-browser%20%7C%20android%20%7C%20ios-lightgrey)
![Privacy](https://img.shields.io/badge/privacy-100%25%20local-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green)

> Studio-grade voice isolation and audio enhancement — 100% local, zero cloud inference. Built on a 32-stage DSP pipeline with hybrid ML and classical spectral processing.

---

## Table of Contents

- [Overview](#overview)
- [What's New in v22.1.0](#whats-new-in-v2210)
- [Features](#features)
- [Quick Start](#quick-start)
- [Available Scripts](#available-scripts)
- [Architecture](#architecture)
- [ML Models](#ml-models)
- [Presets](#presets)
- [Monetization](#monetization)
- [Deployment](#deployment)
- [Mobile (Android & iOS)](#mobile-android--ios)
- [Browser Support](#browser-support)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

VoiceIsolate Pro is a cross-platform audio processing engine that combines a **32-stage DSP pipeline** with on-device ML inference. Every byte of audio stays on your device — no uploads, no telemetry, no exceptions.

Key design principles:

- **Single-pass spectral processing** — no multiple STFT/iSTFT round-trips to prevent phase smearing
- **Privacy-first** — zero external API calls during audio processing
- **52 interactive parameters** across 7 professionally tuned presets
- **Hybrid ML + classical DSP** — ONNX-based models working alongside Wiener filtering and spectral subtraction

---

## What's New in v22.1.0

- **Resume Playback** — Pause and resume from exactly where you left off.
- **A/B Toggle** — Instantly compare original vs. processed audio via the transport bar, with full spectrogram sync.
- **Retuned Presets** — All 7 presets have been professionally retuned for improved out-of-the-box results.
- **Spectrogram Sync** — Transport toggle, spectrogram view, and source toggle are bidirectionally synchronized.
- **CI/CD Hardening** — Deploy workflow now triggers on pull requests; CSP updated to remove `wasm-unsafe-eval` and add `cdnjs.cloudflare.com`.

### Previous: v22.0.0 — Monetization & AI Engine v2

- **Freemium Monetization** — Free, Pro, Studio, and Enterprise tiers with Stripe and RevenueCat integration.
- **Offline License Validation** — Secure JWT-based license validation with feature gating.
- **AI Engine v2** — Voice fingerprinting, adaptive spectral masking, noise profile library, and multi-speaker detection.
- **Batch Processing** — Concurrent multi-file processing queue with ZIP export (Studio/Enterprise).
- **Cloud Sync** — Cross-device synchronization of presets and profiles (Studio/Enterprise).

---

## Features

| Feature | Detail |
|---|---|
| **32-Stage DSP Pipeline** | Noise Gate → Noise Reduction → Parametric EQ → Dynamics → Spectral Processing → Advanced Processing → Voice Separation → Output |
| **52 Interactive Parameters** | Real-time adjustment across all pipeline stages |
| **7 Tuned Presets** | Podcast, Film, Interview, Forensic, Music, Broadcast, Custom |
| **A/B Toggle** | Original vs. processed comparison with transport and spectrogram sync |
| **Resume Playback** | Pause and resume from exact position with full state preservation |
| **AI Engine v2** | Silero VAD, DeepFilterNet3, Demucs v4 — all running locally via ONNX Runtime Web |
| **Batch Processing** | Multi-file queue with progress tracking and ZIP export |
| **Cloud Sync** | Cross-device preset and profile synchronization (Studio/Enterprise) |
| **Mobile Native** | Android and iOS apps via Capacitor with RevenueCat IAP |
| **100% Local Processing** | Audio never leaves your device |

---

## Quick Start

### Requirements

- Node.js >= 18.0.0
- npm >= 8

### Local Development

```bash
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro
npm install
npm run dev        # Serves on http://localhost:3000
```

### Docker

```bash
docker compose up
# Application available at http://localhost:3000
```

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server on port 3000 |
| `npm start` | Start production server |
| `npm run serve` | Serve `public/` statically with CORS |
| `npm run build` | Copy `public/` into `build/` |
| `npm run lint` | Run ESLint on core pipeline files |
| `npm run lint:fix` | Run ESLint with auto-fix |
| `npm test` | Run Jest test suite |
| `npm run test:watch` | Run Jest in watch mode |
| `npm run test:coverage` | Run Jest with coverage reporting |
| `npm run validate` | Run structural pipeline validation |
| `npm run build:mobile` | Build and sync Capacitor |

---

## Architecture

### DSP Pipeline (32 Stages)

The pipeline processes audio in a single pass through eight processing groups:

```
Input → Noise Gate → Noise Reduction → Parametric EQ (10-band)
      → Dynamics (Compressor + Limiter) → Spectral Processing
      → Advanced Processing → Voice Separation → Output Stage
```

| Group | Stages | Parameters |
|---|---|---|
| Noise Gate | 6 | Threshold, Range, Attack, Release, Hold, Lookahead |
| Noise Reduction | 5 | Reduction Amount, Sensitivity, Spectral Subtraction, Noise Floor, Smoothing |
| Parametric EQ | 10 bands | 40 Hz – 16 kHz (Sub through Brilliance) |
| Dynamics | 8 | Compressor (6) + Limiter (2) |
| Spectral Processing | 8 | HPF, LPF, De-Esser, Spectral Tilt, Formant Shift |
| Advanced Processing | 6 | De-Reverb, Harmonic Recovery, Stereo Width, Phase Correction |
| Voice Separation | 5 | Voice Isolation, Background Suppression, Voice Focus Band, Crosstalk Cancel |
| Output Stage | 4 | Output Gain, Dry/Wet Mix, Dither, Output Width |

### Key Source Files

| File | Purpose |
|---|---|
| `public/app/app.js` | Main DSP engine and 52-slider UI system |
| `public/app/dsp-core.js` | Core DSP algorithms (spectral subtraction, Wiener filtering) |
| `public/app/dsp-processor.js` | Advanced DSP (dynamics, EQ, filtering) |
| `public/app/dsp-worker.js` | AudioWorklet processor for real-time off-thread DSP |
| `public/app/ml-worker.js` | ONNX Runtime inference worker |
| `public/app/pipeline-orchestrator.js` | Pipeline coordination, file I/O, export handling |
| `public/app/pipeline-state.js` | Slider state, preset management, persistence |
| `server.js` | Express server with COOP/COEP isolation headers |
| `api/monetization.js` | Stripe checkout, webhooks, license generation |
| `api/sync.js` | Cloud sync endpoints |

---

## ML Models

All inference runs locally in the browser via [ONNX Runtime Web](https://onnxruntime.ai/).

| Model | Purpose |
|---|---|
| **Silero VAD** | Voice activity detection |
| **DeepFilterNet3** | Advanced noise suppression (`enc.onnx`, `erb_dec.onnx`, `df_dec.onnx`) |
| **Demucs v4** | Vocal stem separation |

Model files are loaded from `public/app/models/`. WebGPU acceleration is supported when available.

---

## Presets

| Preset | Target Use Case | LUFS Target |
|---|---|---|
| **Podcast** | Tight gate, strong NR, presence boost | -16 LUFS |
| **Film** | Natural dialogue, gentle processing | Wideband |
| **Interview** | Multi-speaker clarity, crosstalk cancellation | Balanced |
| **Forensic** | Maximum detail, minimal processing, phase correction | Flat |
| **Music** | Vocal extraction, harmonic preservation | Wideband |
| **Broadcast** | Aggressive loudness, clean output | -14 LUFS |
| **Custom** | User-defined with full save/load | User-defined |

All presets cover all 52 parameters. Custom presets can be saved and restored.

---

## Monetization

| Tier | Price | Limits | Features |
|---|---|---|---|
| **Free** | $0 | 3 files/month, ≤50 MB | Basic DSP, watermarked exports |
| **Pro** | $9.99/mo | 50 files/month, ≤500 MB | Full 32-stage pipeline, all ML models, no watermark |
| **Studio** | $24.99/mo | Unlimited, ≤2 GB | Pro + Batch processing, Cloud Sync, API access |
| **Enterprise** | Custom | Unlimited | White-label, custom models, SLA |

**Implementation:**
- `license-manager.js` — Offline JWT license validation and feature gating
- `paywall.js` — Tier enforcement and pricing UI
- `api/monetization.js` — Stripe Checkout sessions, webhook handling
- `revenuecat.js` — Native in-app purchases for iOS and Android

---

## Deployment

### Vercel (Recommended)

Configure via `vercel.json`. Static output from `public/` with security headers pre-configured (COOP, COEP, CORP, CSP).

### Render

Configure via `render.yaml`. Static site deployment with full security header support.

### Docker

```bash
# Build and run
docker compose up

# Or build manually
docker build -t voiceisolatepro .
docker run -p 3000:3000 voiceisolatepro
```

### Security Headers

All deployment targets configure the required isolation headers for `SharedArrayBuffer` and WASM:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: same-origin`
- `X-Frame-Options: DENY`
- Strict `Content-Security-Policy`

---

## Mobile (Android & iOS)

Mobile apps are built using [Capacitor](https://capacitorjs.com/) v7.2.0.

### Setup

```bash
npm run build

# Android
npx cap add android
npx cap sync android
npx cap open android    # Opens Android Studio

# iOS (macOS only)
npx cap add ios
npx cap sync ios
npx cap open ios        # Opens Xcode
```

### Requirements

| Platform | Minimum Version |
|---|---|
| Android | API 24 (Android 7.0) |
| iOS | 14.1 |

### Android Builds

```bash
npm run android:build    # Debug APK
npm run android:release  # Release APK
```

---

## Browser Support

| Browser | Minimum Version | Notes |
|---|---|---|
| Chrome | 90+ | Full support including WebGPU |
| Firefox | 76+ | Full support |
| Safari | 14.1+ | AudioWorklet support required |
| Edge | 90+ | Full support |

`SharedArrayBuffer` requires a secure context (HTTPS or localhost) with COOP/COEP headers set.

---

## Testing

The project includes 20 test suites covering DSP math, pipeline structure, preset completeness, server configuration, and mobile UI.

```bash
npm test                 # Run all tests
npm run test:coverage    # Run with coverage report
npm run test:watch       # Watch mode
npm run validate         # Structural pipeline validation (must have exactly 32 stages)
npm run lint             # ESLint
```

**Test suites cover:** DSP algorithms, slider definitions, preset completeness (all 52 parameters across all 7 presets), STAGES array integrity, ONNX worker, server security headers, HTML structure, deployment config, Android Capacitor config, and mobile UI.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full developer guide including:

- Single-pass spectral processing requirements
- How to add new sliders or presets
- How to add ML models
- Code style guide
- PR checklist (`lint`, `test`, `validate`)

---

## License

Copyright © 2024–2026 VoiceIsolate Pro. All Rights Reserved.
See [LICENSE](./LICENSE) for full terms.

---

**VoiceIsolate Pro v22.1.0** · Privacy-First · Updated March 2026

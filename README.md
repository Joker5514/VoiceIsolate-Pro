# VoiceIsolate Pro

[![CI & Deploy](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml)

> **Version**: 22.1.0 | **License**: All Rights Reserved | **Platform**: Browser · Android · iOS | **Privacy**: 100% Local | **Node**: >=18.0.0

Studio-grade voice isolation and audio enhancement — **100% local, zero cloud inference**. Built on a 32-stage DSP pipeline with hybrid ML and classical spectral processing.

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
- [Mobile](#mobile-android--ios)
- [Browser Support](#browser-support)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

VoiceIsolate Pro is a cross-platform audio processing engine combining a 32-stage DSP pipeline with on-device ML inference.

- 100% privacy-first — zero external API calls during audio processing
- 52 interactive parameters across 7 presets
- Hybrid ML + classical DSP pipeline
- WebGPU-accelerated ONNX inference
- Native mobile via Capacitor v7.2.0

---

## What's New in v22.1.0

- **Resume Playback** — picks up where you left off
- **A/B Toggle** with spectrogram sync
- **Retuned Presets** — all 7 presets recalibrated
- **Spectrogram Sync** — bidirectional
- **CI/CD Hardening** — updated CSP (cdnjs.cloudflare.com added)

### Previous: v22.0.0
- Freemium Monetization
- Offline License Validation
- AI Engine v2
- Batch Processing
- Cloud Sync

---

## Features

- **32-Stage DSP Pipeline** (Noise Gate, Wiener Filter, Spectral Subtraction, EQ, Dynamics, Voice Separation)
- **52 Interactive Parameters**
- **7 Tuned Presets**: Podcast, Film, Interview, Forensic, Music, Broadcast, Custom
- **A/B Toggle** with spectrogram sync
- **Resume Playback**
- **AI Engine v2**: Silero VAD + DeepFilterNet3 + Demucs v4 (via ONNX Runtime Web, WebGPU supported)
- **Batch Processing**
- **Cloud Sync**
- **Mobile Native** (Android API 24+, iOS 14.1+)
- **100% Local Processing** — no data leaves your device

---

## Quick Start

**Requirements**: Node.js >=18.0.0, npm >=8

```bash
# Clone
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro

# Install
npm install

# Run locally
npm run dev
# → http://localhost:3000
```

**Docker**:
```bash
docker compose up
```

---

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server (localhost:3000) |
| `npm start` | Production start |
| `npm run serve` | Serve built files |
| `npm run build` | Production build |
| `npm run lint` | Lint codebase |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm test` | Run test suite |
| `npm run test:watch` | Watch mode tests |
| `npm run test:coverage` | Coverage report |
| `npm run validate` | Full validation |
| `npm run build:mobile` | Build for Android/iOS |

---

## Architecture

### DSP Pipeline (32 Stages)

| Stage Group | Stages |
|-------------|--------|
| Noise Gate | 6 stages |
| Noise Reduction | 5 stages |
| Parametric EQ | 10 bands |
| Dynamics | 8 stages |
| Spectral Processing | 8 stages |
| Advanced Processing | 6 stages |
| Voice Separation | 5 stages |
| Output Stage | 4 stages |

### Key Source Files

| File | Purpose |
|------|---------|
| `public/app/app.js` | Main DSP engine |
| `public/app/dsp-core.js` | Core DSP algorithms |
| `public/app/dsp-processor.js` | Advanced DSP |
| `public/app/dsp-worker.js` | AudioWorklet processor |
| `public/app/ml-worker.js` | ONNX Runtime inference |
| `public/app/pipeline-orchestrator.js` | Pipeline coordination |
| `public/app/pipeline-state.js` | Slider state, presets |
| `server.js` | Express server with security headers |
| `api/monetization.js` | Stripe, webhooks, license |
| `api/sync.js` | Cloud sync endpoints |

---

## ML Models

All models run via **ONNX Runtime Web** with WebGPU acceleration where available.

| Model | Purpose |
|-------|---------|
| Silero VAD | Voice activity detection |
| DeepFilterNet3 | Deep noise suppression |
| Demucs v4 | Source separation / vocal extraction |

---

## Presets

| Preset | Target |
|--------|--------|
| Podcast | -16 LUFS, voice clarity |
| Film | Natural dialogue |
| Interview | Multi-speaker |
| Forensic | Maximum detail preservation |
| Music | Vocal extraction |
| Broadcast | -14 LUFS |
| Custom | User-defined |

---

## Monetization

| Tier | Price | Files/Month | Max Size |
|------|-------|-------------|----------|
| Free | $0 | 3 | ≤50 MB |
| Pro | $9.99/mo | 50 | ≤500 MB |
| Studio | $24.99/mo | Unlimited | ≤2 GB |
| Enterprise | Custom | Unlimited | Custom |

---

## Deployment

### Vercel (Recommended)
Deploy directly from GitHub. `vercel.json` is pre-configured.

### Render
`render.yaml` is included for one-click Render deployment.

### Docker
```bash
docker compose up        # development
docker compose -f compose.yaml up  # production
```

**Security headers applied**: COOP, COEP, CORP, CSP, X-Frame-Options, X-Content-Type-Options

---

## Mobile (Android & iOS)

Built with **Capacitor v7.2.0**.

| Platform | Minimum Version |
|----------|----------------|
| Android | API 24+ (Android 7.0) |
| iOS | 14.1+ |

```bash
npm run build:mobile
npx cap sync
npx cap open android   # or ios
```

---

## Browser Support

| Browser | Minimum Version |
|---------|----------------|
| Chrome | 90+ |
| Firefox | 76+ |
| Safari | 14.1+ |
| Edge | 90+ |

---

## Testing

20 test suites covering:
- DSP math and algorithm correctness
- Pipeline structure and state
- Preset validation
- Server configuration and headers
- Mobile UI components

```bash
npm test                  # run all tests
npm run test:coverage     # with coverage report
```

---

## Roadmap

The following features are actively in development. See the linked issues for full technical specs and acceptance criteria.

| Issue | Feature | Status |
|-------|---------|--------|
| [#251](https://github.com/Joker5514/VoiceIsolate-Pro/issues/251) | Voice Fingerprinting — speaker ID, biometric voice profiles, real-time diarization | 🔵 Planned |
| [#252](https://github.com/Joker5514/VoiceIsolate-Pro/issues/252) | Real-Time Spectrogram — 60fps WebGL, speaker color overlay, zoom/pan/freeze | 🔵 Planned |
| [#253](https://github.com/Joker5514/VoiceIsolate-Pro/issues/253) | Advanced DSP — adaptive noise floor, Wiener filter, DNS model, VAD, harmonic enhancer | 🔵 Planned |
| [#254](https://github.com/Joker5514/VoiceIsolate-Pro/issues/254) | Modern UI Overhaul — dark theme, glassmorphism, audio-reactive lights, speaker auras | 🔵 Planned |

---

## Contributing

See [CONTRIBUTING.md](https://github.com/Joker5514/VoiceIsolate-Pro/blob/main/CONTRIBUTING.md) for the full developer guide.

---

## License

Copyright © 2024–2026 VoiceIsolate Pro. All Rights Reserved.

---

*Repository: https://github.com/Joker5514/VoiceIsolate-Pro*
*Last updated: April 2026*
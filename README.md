# VoiceIsolate Pro

[![CI](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/ci.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/ci.yml)
[![Android Build](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/android-build.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/android-build.yml)
[![Deploy](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml)
![Version](https://img.shields.io/badge/version-21.0.0-blue)
![License](https://img.shields.io/badge/license-All%20Rights%20Reserved-red)
![Platform](https://img.shields.io/badge/platform-browser%20%7C%20android%20%7C%20ios-lightgrey)
![Privacy](https://img.shields.io/badge/privacy-100%25%20local-brightgreen)

> **Studio-grade voice isolation and audio enhancement — 100% local, zero cloud inference. Now available on Mobile.**

VoiceIsolate Pro is a cross-platform audio processing engine powered by a **36-stage Deca-Pass DSP pipeline** that combines hybrid ML and classical spectral processing. Built on the **Threads from Space v10** architecture, every byte of audio stays on your device — no uploads, no telemetry, no exceptions.

---

## Current Version: v21.0.0 — Mobile & AI Intelligence Upgrade

**Version 21** brings massive architectural upgrades, featuring:

- **Native Mobile App Support**: Full Android (APK) and iOS builds via Capacitor.js
- **AI Intelligence Module**: Smart audio analysis, MCRA noise floor estimation, and scene classification
- **Auto-Tune Parameters**: Intelligent slider adjustments based on real-time audio feature extraction
- **36-Stage Deca-Pass Pipeline**: Expanded DSP architecture for maximum fidelity
- **52-slider** real-time control interface with touch-optimized mobile UI
- **3D spectrogram canvas** (WebGL-accelerated via Three.js r128)
- **Forensic audit trail**: SHA-256 hash per pipeline stage with downloadable log
- **Comprehensive CI/CD**: Automated testing (345 passing tests), linting, and multi-platform builds

---

## Features

| Feature | Detail |
|---------|--------|
| **36-stage Deca-Pass DSP** | 10 passes × 4 stages: Ingest → Analysis → Filter → Spectral NR → EQ → Spectral Processing → Dynamics → Master → Export |
| **AI Intelligence** | MCRA noise floor tracking, audio scene classification (Podcast, Interview, Music, etc.), and automatic parameter tuning |
| **Mobile Native** | Runs as a native app on Android and iOS using Capacitor, with safe-area insets and touch-optimized controls |
| **Hybrid ML + Classical** | Demucs v4.1, BSRNN, DeepFilterNet3 working alongside Wiener filtering and spectral subtraction |
| **100% Local Processing** | Audio never leaves your device. No server uploads. No cloud inference. |
| **Three Execution Modes** | Live (<10 ms), Creator (full quality), Forensic (SHA-256 audit trail) |
| **Single-Pass Spectral** | One STFT → in-place ops → one iSTFT eliminates phase smearing |
| **WebGPU Acceleration** | GPU-accelerated ONNX inference, auto-falls back to WASM |
| **Privacy-First** | COOP/COEP security headers, CSP blocks external network during processing |

---

## Quick Start

### Local Web Development

```bash
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro
npm install
npm run dev          # Serves public/ on http://localhost:3000 with CORS
```

### Mobile App Development (Capacitor)

```bash
npm install
npm run build

# Android
npx cap add android
npx cap sync android
npx cap open android   # Opens Android Studio

# iOS (macOS only)
npx cap add ios
npx cap sync ios
npx cap open ios       # Opens Xcode
```

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Serve `public/` on port 3000 with CORS |
| `npm run build` | Copy `public/` into `build/` directory |
| `npm run lint` | Run ESLint on core pipeline files |
| `npm test` | Run Jest test suite (345 tests across 15 files) |
| `npm run validate` | Run custom pipeline validation script |

---

## Architecture

### 36-Stage Deca-Pass Pipeline

```
Audio Input (WAV / MP3 / OGG / M4A / FLAC / Video)
  │
  ├─ Pass 1 · INGEST
  ├─ Pass 2 · ANALYSIS (AI Intelligence & Scene Classification)
  ├─ Pass 3 · FILTER
  ├─ Pass 4 · SPECTRAL NR (MCRA Noise Floor + Wiener)
  ├─ Pass 5 · EQ
  ├─ Pass 6 · SPECTRAL PROCESSING
  ├─ Pass 7 · DYNAMICS
  ├─ Pass 8 · MASTER
  ├─ Pass 9 · FORENSIC (SHA-256 Hashing)
  └─ Pass 10 · EXPORT
```

### Threading Model (Threads from Space v10)

```
┌─ Main Thread ─────────────────────────────┐
│  UI rendering, AI Intelligence, Auto-Tune │
└───────────────┬───────────────────────────┘
                │ AudioContext / postMessage
┌───────────────▼───────────────────────────┐
│  AudioWorklet Thread (dsp-worker.js)      │
│  Real-time DSP <10 ms                     │
│  SharedArrayBuffer param bridge           │
└───────────────┬───────────────────────────┘
                │ Worker postMessage
┌───────────────▼───────────────────────────┐
│  ML Worker (ml-worker.js)                 │
│  ONNX Runtime Web (WebGPU → WASM)         │
└───────────────────────────────────────────┘
```

---

## AI Intelligence Module

Introduced in v21, the AI Intelligence module (`ai-intelligence.js`) provides smart analysis capabilities on top of the core DSP pipeline:

- **MCRA Noise Floor Estimator**: Minimum Controlled Recursive Averaging for robust speech enhancement in non-stationary noise.
- **Audio Scene Classifier**: Extracts spectral features (Centroid, Flux, ZCR, RMS) to classify audio into scenes (Podcast, Interview, Music, Broadcast, Forensic, Film).
- **Auto-Tune**: Suggests optimal parameter adjustments based on the classified scene and dynamic range.
- **Voice Quality Metrics**: Estimates MOS (Mean Opinion Score), clarity, and naturalness.

---

## Mobile App Builds (CI/CD)

VoiceIsolate Pro v21 includes automated GitHub Actions workflows for building mobile apps:

- **Android APK Build**: Automatically builds Debug and Release APKs on push to `main` or tags. Artifacts are available in the Actions tab.
- **iOS Build**: Automatically builds the iOS app using macOS runners on version tags.
- **Vercel Deploy**: Automatically deploys the web version to Vercel with proper security headers.

---

## License

Copyright © 2024–2026 VoiceIsolate Pro. All Rights Reserved.
See [LICENSE](./LICENSE) for full terms.

---

**VoiceIsolate Pro v21.0.0** · Threads from Space v10 · Privacy-First · Updated March 2026

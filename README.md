# VoiceIsolate Pro

<p align="center">
  <a href="https://voice-isolate-pro.vercel.app"><strong>Live Demo</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/README.md">Documentation</a>
  &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <strong>Studio-grade voice isolation — 100% on-device.</strong><br>
  Upload audio, separate voice from background with local AI, then mix in real time with zero-latency sliders.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node 22+">
  <img src="https://img.shields.io/badge/pnpm-10-000000?logo=pnpm&logoColor=f69220" alt="pnpm 10">
  <img src="https://img.shields.io/badge/tests-2150%2B-passing-2ea043" alt="Tests">
  <img src="https://img.shields.io/badge/privacy-no%20cloud%20audio-blue" alt="Privacy">
</p>

---

## Overview

| | |
|---|---|
| **Problem** | Clean voice tracks from noisy recordings without sending audio to a server |
| **Approach** | Offline ONNX inference once per file → real-time Web Audio mixing (no re-inference on slider moves) |
| **Platforms** | Web (Vercel), Desktop (Electron), Android (Capacitor) |

## Features

| Feature | Description |
|---------|-------------|
| **AI voice isolation** | Demucs vocal mask + BiGRU noise suppression (ONNX Runtime Web, WebGPU / WASM) |
| **Speaker diarization** | Log-mel timbral fingerprinting clusters voices by timbre |
| **Real-time mixing** | 67 calibrated sliders on the Web Audio graph — gate, EQ, de-esser, per-speaker volume |
| **Privacy-first** | No cloud audio processing; models SHA-256 verified and cached locally |
| **Export** | WAV or MP3 via `AudioEncoderWorker` off the main thread |
| **Cross-platform** | Web · Desktop · Android (iOS out of scope v1.0) |

## How it works

```
PHASE 1 — Offline (once per file)
  Upload → Decode @ 48 kHz → MLWorker (ONNX) → Clean + Noise stems

PHASE 2 — Live mix (continuous, zero ML)
  Stems → AudioBufferSources → Gains / EQ / Gate / De-esser → Output
```

## Quick start

**Requirements:** Node.js ≥ 22 · pnpm ≥ 10

```bash
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro
pnpm install
pnpm dev          # http://localhost:3000
```

### Commands

| Command | Purpose |
|---------|---------|
| `pnpm test` | Jest suite (2150+ tests) |
| `pnpm validate` | Structural integrity gate (CI) |
| `pnpm lint` | ESLint |
| `pnpm build` | Production static build → `build/` |
| `pnpm worklets:verify` | AudioWorklet packaging check |
| `pnpm android:build:win` | Windows Android debug APK |
| `pnpm build:electron:dir` | Desktop unpacked (Windows) |

No `.env` is required for local audio processing. Optional payment/licensing vars are in [`.env.example`](.env.example).

### Local install artifacts (Windows)

| Platform | Command | Output |
|----------|---------|--------|
| Android debug APK | `pnpm android:build:win` | `dist/android/VoiceIsolate-Pro-debug.apk` |
| Desktop unpacked | `pnpm build:electron:dir` | `dist/electron/win-unpacked/VoiceIsolate Pro.exe` |

**Android (Windows):** Android SDK at `%LOCALAPPDATA%\Android\Sdk`, JDK 21 (`VIP_JAVA_HOME` or `%USERPROFILE%\.jdks\temurin-21`). Install APK: `adb install -r dist\android\VoiceIsolate-Pro-debug.apk`

**Desktop:** `pnpm setup:electron` once, then `pnpm build:electron:dir`. See [docs/electron-desktop.md](docs/electron-desktop.md).

## Surfaces

| Route | Surface |
|-------|---------|
| `/` | **Landing** — Stem-Split & Live-Mix (`public/index.html`) |
| `/app/` | **Engineer Mode** — 32-stage DSP + premium visualizations |

## Repository layout

```
src/                 Canonical 4-layer architecture (core → workers → pipeline → presentation)
public/              Static shell, Engineer Mode, vendored libs
server/              Express dev server + security headers
api-routes/          Optional Stripe / sync APIs
scripts/             Build, validation, model & worklet tooling
tests/               Jest suites
docs/                Product & engineering documentation
deploy/              Docker, Render, Caddy (optional targets)
electron/            Desktop shell (Blueprint v2.1)
android/             Capacitor Android project
```

## Documentation

Full index: **[docs/README.md](docs/README.md)**

| Topic | Link |
|-------|------|
| Contributor contract | [CLAUDE.md](CLAUDE.md) |
| AudioWorklets | [docs/WORKLETS.md](docs/WORKLETS.md) |
| Model delivery | [docs/MODEL_DELIVERY.md](docs/MODEL_DELIVERY.md) |
| Desktop | [docs/electron-desktop.md](docs/electron-desktop.md) |
| Blueprint v2.1 | [docs/VoiceIsolate-Pro_Master_Blueprint_v2.1.md](docs/VoiceIsolate-Pro_Master_Blueprint_v2.1.md) |

## Security

- Strict headers (COOP/COEP, CSP, `nosniff`, `microphone=()`) via `server/securityHeaders.js` and `vercel.json`
- Secrets via environment variables only — see `.env.example`
- ONNX models verified against pinned SHA-256 before every session

## License

UNLICENSED — © Randy Jordan. All rights reserved.
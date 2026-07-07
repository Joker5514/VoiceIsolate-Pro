# VoiceIsolate Pro

<p align="center">
  <a href="https://voice-isolate-pro.vercel.app"><strong>🚀 Live Demo</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/README.md">Documentation</a>
  &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <strong>Best-in-class voice isolation &amp; audio enhancement — 100% on-device, zero cloud.</strong><br>
  32-stage Octa-Pass DSP · Hybrid ML (Demucs v4 + BSRNN + ECAPA-TDNN) · WebGPU-Accelerated · Privacy-First
</p>

<p align="center">
  <img src="https://img.shields.io/badge/architecture-Threads%20from%20Space%20v8-blueviolet" alt="Architecture">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node 22+">
  <img src="https://img.shields.io/badge/pnpm-10-000000?logo=pnpm&logoColor=f69220" alt="pnpm 10">
  <img src="https://img.shields.io/badge/privacy-no%20cloud%20audio-blue" alt="Privacy">
  <img src="https://img.shields.io/badge/license-Proprietary-red" alt="License">
</p>

---

## Overview

| | |
|---|---|
| **Problem** | Extract studio-quality voice from any noisy recording without uploading audio to a server |
| **Approach** | 32-stage Octa-Pass DSP pipeline: classical spectral processing → deep ML source separation → room isolation → neural reconstruction → export |
| **Architecture** | Threads from Space v8 — Dispatcher-Worker model, SharedArrayBuffer ring buffers, single Forward STFT + single iSTFT constraint |
| **Execution** | Live mode `<10 ms` via AudioWorklet · Creator/Forensic mode via OfflineAudioContext |
| **Platforms** | Web (Vercel) · Desktop (Electron) · Android (Capacitor) |

---

## Pipeline: 32-Stage Octa-Pass DSP

Audio flows through **one Forward STFT** at the start of the spectral phase, in-place operations, and **one iSTFT** at the end — preventing phase smearing.

| Pass | Stages | Purpose |
|------|--------|---------|
| **Pass 1** — Classical DSP Annihilation | 1–8 | DC removal, continuous noise profiling, 32-band ERB spectral gate, hum annihilation, Wiener-MMSE, click removal, spectral subtraction, residual gate |
| **Pass 2** — Deep ML Source Separation | 9–14 | Demucs v4 hybrid U-Net, Band-Split RNN, ensemble mask fusion, ECAPA-TDNN voiceprint isolation, speaker diarization, VAD hard gate |
| **Pass 3** — Room Isolation & Reconstruction | 15–18 | WPE dereverberation, harmonic reconstruction, Griffin-Lim phase reconstruction, HiFi-GAN neural vocoder |
| **Pass 4** — Enhancement & Export | 19–24 | Broadcast EQ, de-esser, voice-gated HF boost, multi-band dynamics, ITU-R BS.1770 loudness normalize, WAV/MP3/FLAC/OGG encode |
| **Passes 5–8** *(Engineer Mode)* | 25–32 | Extended per-stage controls available in Engineer Mode v19 — 52-slider UI with 3D spectrogram |

---

## Key Features

| Feature | Spec |
|---------|------|
| **Noise floor** | −96 dB (offline) · −70 dB (real-time) |
| **Real-time latency** | `<10 ms` AudioWorklet + SharedArrayBuffer ring buffer |
| **ML models** | Demucs v4, BSRNN, ECAPA-TDNN 192-dim, HiFi-GAN v1, Silero VAD — all via ONNX Runtime Web |
| **GPU execution** | WebGPU (preferred) → WebGL2 → WASM fallback |
| **Speaker isolation** | ECAPA-TDNN voiceprint enrollment, cosine-similarity gating per frame |
| **Room adaptation** | 8 acoustic profiles (Auto, Bedroom, Bathroom, Kitchen, Hallway, Garage, Outdoor, Car) |
| **Batch processing** | Up to 11,000 files via async thread pool with priority queue |
| **Format support** | MP3, WAV, M4A, FLAC, OGG, MP4, MOV, WEBM, MKV |
| **Privacy** | 100% local processing · zero telemetry · AES-256 export encryption · no cloud API calls |
| **Export presets** | Crystal Voice · Podcast Pro · Film Dialogue · Forensic · Voice Message · Interview |

---

## Architecture: Threads from Space v8

```
┌─────────────────────────────────────────────────────────┐
│  UI LAYER (Main Thread)                                  │
│  HTML Canvas/WebGL · 52-slider Engineer Mode v19 UI      │
│  3D Spectrogram · AB Waveform Comparison                 │
└────────────────────┬────────────────────────────────────┘
                     │ postMessage / SharedArrayBuffer
┌────────────────────▼────────────────────────────────────┐
│  DISPATCHER (Web Worker)                                 │
│  Job scheduling · Pipeline orchestration · Priority queue│
└──┬─────────────────┬──────────────────┬─────────────────┘
   │                 │                  │
┌──▼──────┐  ┌───────▼──────┐  ┌────────▼──────────┐
│ DSP     │  │  ML Workers  │  │  AudioWorklet     │
│ Workers │  │  ONNX / WebGPU│  │  Live mode <10 ms │
│ Pass 1  │  │  Pass 2      │  │  Ring buffer SAB  │
└──┬──────┘  └───────┬──────┘  └────────┬──────────┘
   └─────────────────┴──────────────────┘
              GPU ACCELERATION LAYER
        WebGPU compute shaders (preferred)
        WebGL2 fallback · WASM-FFT fallback
        Single STFT → in-place ops → single iSTFT
```

### Critical Constraints
- **Single-Pass Spectral Architecture** — exactly ONE Forward STFT, in-place spectral operations, exactly ONE iSTFT. No exceptions.
- **100% Local Processing** — no fetch to external servers (except loading local `.onnx` models). No telemetry.
- **ML via ONNX Runtime Web** — WebGPU EP preferred, WASM EP fallback.
- **Dual execution modes** — Live (`AudioWorklet + SharedArrayBuffer`, `<10 ms`) and Creator/Forensic (`OfflineAudioContext`).

---

## ML Model Stack

| Model | Task | Size (INT8) | Inference |
|-------|------|-------------|----------|
| Demucs v4 (htdemucs) | Voice / source separation | ~37 MB | ~85 ms/3s GPU |
| Band-Split RNN | Band-specific separation | ~12 MB | ~62 ms/3s GPU |
| ECAPA-TDNN 192-dim | Speaker embedding / voiceprint | ~8 MB | ~50 ms/3s GPU |
| HiFi-GAN v1 | Neural vocoder (mel → waveform) | ~14 MB | ~120 ms/3s GPU |
| Silero VAD | Voice activity detection | ~1 MB | ~5 ms/frame CPU |

All models: loaded lazily on first use · cached in IndexedDB · INT8 quantized · SHA-256 verified.

---

## Quick Start

**Requirements:** Node.js ≥ 22 · pnpm ≥ 10

```bash
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro
pnpm install
pnpm dev          # http://localhost:3000
```

No `.env` required for local audio processing. Optional payment/licensing vars in [`.env.example`](.env.example).

### Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Dev server at `localhost:3000` |
| `pnpm build` | Production build → `build/` |
| `pnpm test` | Jest suite (2150+ tests) |
| `pnpm validate` | Structural integrity gate (CI) |
| `pnpm lint` | ESLint |
| `pnpm worklets:verify` | AudioWorklet packaging check |
| `pnpm android:build:win` | Windows Android debug APK |
| `pnpm build:electron:dir` | Desktop unpacked (Windows) |

---

## Surfaces

| Route | Surface |
|-------|---------|
| `/` | **Landing** — Stem-Split & Live-Mix (`public/index.html`) |
| `/app/` | **Engineer Mode v19** — 52-slider UI, 32-stage DSP, 3D spectrogram canvas |

---

## Repository Layout

```
src/                 Core 4-layer architecture (core → workers → pipeline → presentation)
public/              Static shell, Engineer Mode v19 UI, vendored libs
  public/app/        index.html · style.css · app.js (DSP pipeline + Web Audio routing)
server/              Express dev server + COOP/COEP/CSP security headers
api/                 Vercel serverless API routes
scripts/             Build, validation, model & worklet tooling
tests/               Jest suites
docs/                Product & engineering documentation
deploy/              Docker, Render, Caddy configs
electron/            Desktop shell
android/             Capacitor Android project
```

---

## Documentation

| Topic | Link |
|-------|------|
| Full docs index | [docs/README.md](docs/README.md) |
| Contributor contract | [CLAUDE.md](CLAUDE.md) |
| AudioWorklets | [docs/WORKLETS.md](docs/WORKLETS.md) |
| Model delivery | [docs/MODEL_DELIVERY.md](docs/MODEL_DELIVERY.md) |
| Desktop | [docs/electron-desktop.md](docs/electron-desktop.md) |
| Master Blueprint | [docs/VoiceIsolate-Pro_Master_Blueprint_v2.1.md](docs/VoiceIsolate-Pro_Master_Blueprint_v2.1.md) |

---

## Export Presets

| Preset | Use Case | Noise Floor | Loudness |
|--------|----------|-------------|----------|
| Crystal Voice | Voiceover / audiobook | −96 dB | −16 LUFS, −1 dBTP |
| Podcast Pro | Podcasts / interviews | −80 dB | −16 LUFS, −1 dBTP |
| Film Dialogue | Movie/TV post-production | −60 dB | −23 LUFS, −2 dBTP |
| Forensic | Legal / investigation | Minimal NR | Original level |
| Voice Message | Chat / social | −70 dB | −14 LUFS, −1 dBTP |
| Interview | News / documentary | −75 dB | −16 LUFS, −1 dBTP |

---

## Security & Privacy

- **Zero cloud audio** — all DSP and ML inference execute in the browser sandbox
- Strict headers: COOP / COEP / CSP / `nosniff` via `server/securityHeaders.js` and `vercel.json`
- ONNX models verified against pinned SHA-256 before every session
- AES-256 encryption available for exported files (optional, user-controlled key)
- DOD 5220.22-M compliant secure delete of temporary buffers
- GDPR / CCPA / HIPAA-ready architecture

---

## License

UNLICENSED — © 2026 Randy Jordan / Conqueror Studios. All rights reserved.

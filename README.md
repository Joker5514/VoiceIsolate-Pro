# VoiceIsolate Pro

<p align="center">
  <a href="https://voice-isolate-pro.vercel.app"><strong>Live Demo</strong></a>
  &nbsp;·&nbsp;
  <a href="https://voice-isolate-pro.vercel.app/download/"><strong>Download</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Joker5514/VoiceIsolate-Pro/releases"><strong>Android APK</strong></a>
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
  <img src="https://img.shields.io/badge/version-v24.0.0-red" alt="v24">
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
| **Problem** | Extract studio-quality voice from noisy recordings without sending audio to a server |
| **Workflow** | Upload a file → decode locally → ML stem separation + DSP enhancement → playback & export |
| **Architecture** | Threads from Space v8 — Dispatcher-Worker model, SharedArrayBuffer ring buffers, single Forward STFT + single iSTFT constraint |
| **Execution** | Offline/batch inference on upload · real-time slider playback via AudioWorklet · Forensic export via OfflineAudioContext |
| **Platforms** | Web (Vercel) · Desktop (Electron) · Android (Capacitor) |

> **Upload-only:** live microphone capture is intentionally disabled. Drop or browse for audio/video files on both surfaces — nothing is streamed to the cloud.

---

## Surfaces

| Route | Surface | What it does |
|-------|---------|--------------|
| [`/`](https://voice-isolate-pro.vercel.app/) | **Landing — Stem-Split** | Fast ML stem separation (vocals / accompaniment / noise). Upload → auto-process → preview stems. |
| [`/app/`](https://voice-isolate-pro.vercel.app/app/) | **Engineer Mode v24** | Full 67-slider DSP suite, scene presets, 3D spectrogram, A/B transport, forensic audit log, WhisperHunter AI. |
| [`/download/`](https://voice-isolate-pro.vercel.app/download/) | **Downloads** | Android APK (GitHub Releases), web links, desktop build notes. |

**Upload controls (both pages):** Browse Files (`<label for="fileInput">`), click the drop zone, drag-and-drop, or **Upload Audio or Video** in the Engineer hero. Shared wiring lives in `src/presentation/UploadWiring.js`.

### Playback worklets & engine status (Engineer)

| Component | Role |
|-----------|------|
| `vip-gate` | Real-time noise gate (`src/workers/GateProcessor.js`) |
| `vip-deesser` | Real-time de-esser (`src/workers/DeEsserProcessor.js`) |
| Cockpit pills | **CTX · WORKLET · GATE · DEESS · SAB · ML · ORT · NET** — driven by `vip-boot.js` + `PlaybackMixer` |

Verify packaging: `pnpm worklets:verify`.

---

## Pipeline: 32-Stage Octa-Pass DSP

Audio flows through **one Forward STFT** at the start of the spectral phase, in-place operations, and **one iSTFT** at the end — preventing phase smearing.

| Pass | Stages | Purpose |
|------|--------|---------|
| **Pass 1** — Classical DSP Annihilation | 1–8 | DC removal, continuous noise profiling, 32-band ERB spectral gate, hum annihilation, Wiener-MMSE, click removal, spectral subtraction, residual gate |
| **Pass 2** — Deep ML Source Separation | 9–14 | Demucs v4 hybrid U-Net, Band-Split RNN, ensemble mask fusion, ECAPA-TDNN voiceprint isolation, speaker diarization, VAD hard gate |
| **Pass 3** — Room Isolation & Reconstruction | 15–18 | WPE dereverberation, harmonic reconstruction, Griffin-Lim phase reconstruction, HiFi-GAN neural vocoder |
| **Pass 4** — Enhancement & Export | 19–24 | Broadcast EQ, de-esser, voice-gated HF boost, multi-band dynamics, ITU-R BS.1770 loudness normalize, WAV/MP3/FLAC/OGG encode |
| **Passes 5–8** *(Engineer Mode)* | 25–32 | Extended per-stage controls — 67-slider UI with 3D spectrogram & Whisper Hunter forensic pass |

---

## Key Features

| Feature | Spec |
|---------|------|
| **Noise floor** | −96 dB (offline) · −70 dB (real-time playback) |
| **Real-time latency** | `<10 ms` AudioWorklet + SharedArrayBuffer ring buffer (playback/mixing) |
| **ML models** | Demucs v4, BSRNN, ECAPA-TDNN 192-dim, HiFi-GAN v1, Silero VAD — all via ONNX Runtime Web |
| **GPU execution** | WebGPU (preferred) → WebGL2 → WASM fallback |
| **Speaker isolation** | ECAPA-TDNN voiceprint enrollment, cosine-similarity gating per frame |
| **Room adaptation** | 8 acoustic profiles (Auto, Bedroom, Bathroom, Kitchen, Hallway, Garage, Outdoor, Car) |
| **Batch processing** | Up to 11,000 files via async thread pool with priority queue |
| **Format support** | MP3, WAV, M4A, FLAC, OGG, OPUS, MP4, MOV, WEBM, MKV, AVI, WMV, TS |
| **Privacy** | 100% local processing · zero telemetry · AES-256 export encryption · no cloud API calls |
| **Export presets** | Crystal Voice · Podcast Pro · Film Dialogue · Forensic · Voice Message · Interview |

---

## Architecture: Stem-Split & Live-Mix

The app uses a **two-phase model** (see [`CLAUDE.md`](CLAUDE.md)):

1. **Phase 1 — Offline inference** (once per uploaded file): `FileIngestion` → `MLWorker` (ONNX) → stem cache.
2. **Phase 2 — Live-Mix playback** (continuous, zero ML): cached stems → `PlaybackMixer` / AudioWorklet graph → real-time slider response.

```
┌─────────────────────────────────────────────────────────┐
│  UI LAYER (Main Thread)                                  │
│  Landing upload zone · Engineer 67-slider UI · transport │
│  3D Spectrogram · A/B Waveform Comparison                │
└────────────────────┬────────────────────────────────────┘
                     │ postMessage / SharedArrayBuffer
┌────────────────────▼────────────────────────────────────┐
│  DISPATCHER (Web Worker)                                 │
│  Job scheduling · Pipeline orchestration · Priority queue│
└──┬─────────────────┬──────────────────┬─────────────────┘
   │                 │                  │
┌──▼──────┐  ┌───────▼──────┐  ┌────────▼──────────┐
│ DSP     │  │  ML Workers  │  │  AudioWorklet     │
│ Workers │  │  ONNX / WebGPU│  │  Live-Mix <10 ms  │
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
- **No live microphone ingestion** — `getUserMedia` and the legacy live-mic pipeline are removed by design.

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

Open:
- **Landing:** http://localhost:3000/
- **Engineer Mode:** http://localhost:3000/app/

No `.env` required for local audio processing. Optional payment/licensing vars in [`.env.example`](.env.example).

### Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Dev server at `localhost:3000` (COOP/COEP for SharedArrayBuffer) |
| `pnpm build` | Production build → `build/` |
| `pnpm test` | Jest suite (2150+ tests) |
| `pnpm validate` | Structural integrity gate (CI) |
| `pnpm lint` | ESLint |
| `pnpm worklets:verify` | AudioWorklet packaging check |
| `pnpm android:build:win` | Windows Android debug APK → `dist/android/` |
| `pnpm android:build` | Android debug APK (Unix/macOS) |
| `pnpm worklets:verify` | AudioWorklet packaging integrity |
| `pnpm build:electron:dir` | Desktop unpacked (Windows) |

### Android download

| Channel | URL |
|---------|-----|
| **Web download page** | https://voice-isolate-pro.vercel.app/download/ |
| **GitHub Releases (APK)** | https://github.com/Joker5514/VoiceIsolate-Pro/releases |
| **Latest APK asset** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk |
| **Pinned v24.0.0** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-android-debug.apk |

The download page always links to the **real GitHub Release binary** (~303 MB, `application/vnd.android.package-archive`).  
Same-origin `/download/*.apk` redirects to GitHub so it never serves SPA HTML.

Build locally (Windows):

```bash
pnpm android:build:win
# → dist/android/VoiceIsolate-Pro-debug.apk
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Sideload: enable **Install unknown apps** for your browser/file manager, then open the APK.  
Details: [download/README.md](download/README.md).

### Upload troubleshooting

| Symptom | Fix |
|---------|-----|
| Browse does nothing (Chrome/Edge) | Hard-refresh (`Ctrl+Shift+R`). File inputs must stay in the viewport — off-screen `left:-9999px` inputs are blocked by Chromium 120+. |
| Decode fails on mobile `.m4a` | `mobile-upload-fix.js` + `m4a-decode-fix.js` patch decode paths; try WAV/MP3 if the container is unsupported. |
| Models not loading | Serve over HTTP (`pnpm dev`), not `file://`. Requires COOP/COEP headers (included in `server.js` / `vercel.json`). |

---

## Repository Layout

```
src/                 Core 4-layer architecture (core → workers → pipeline → presentation)
  presentation/      UploadWiring.js, transport controls, slider UI
public/              Static shells
  index.html         Landing — Stem-Split
  landing.js         Landing upload + ML ingest pipeline
  app/               Engineer Mode v24 (app.js, style.css, worklets, models)
server/              Express dev server + COOP/COEP/CSP security headers
api/                 Vercel serverless API routes
scripts/             Build, validation, model & worklet tooling
tests/               Jest suites (upload wiring, decode, DSP, presets)
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
| Architecture v26 | [docs/VoiceIsolate_Pro_Architecture_v26.md](docs/VoiceIsolate_Pro_Architecture_v26.md) |
| Technical whitepaper | [docs/VoiceIsolate_Pro_Technical_Whitepaper.md](docs/VoiceIsolate_Pro_Technical_Whitepaper.md) |
| Contributor contract | [CLAUDE.md](CLAUDE.md) |
| AudioWorklets | [docs/WORKLETS.md](docs/WORKLETS.md) |
| Android / desktop downloads | [download/README.md](download/README.md) |
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
- Microphone permission denied via Permissions-Policy (`microphone=()`)
- ONNX models verified against pinned SHA-256 before every session
- AES-256 encryption available for exported files (optional, user-controlled key)
- DOD 5220.22-M compliant secure delete of temporary buffers
- GDPR / CCPA / HIPAA-ready architecture

---

## Recent changes (v24)

- **Upload-only workflow** — live mic capture removed; browse, drop-zone, and hero upload CTAs wired through `UploadWiring.js`
- **Chromium picker fix** — file inputs kept in-viewport; Browse uses native `<label for="fileInput">`
- **WhisperHunter AI** — restored on all workflow tiers; single-pass to avoid UI freezes
- **Playback worklets** — gate + de-esser with resume/retry load; cockpit pills CTX–NET hardened
- **UI freeze fix** — async STFT/iSTFT with rAF yields on long files
- **Research mode** — local session JSON export + parameter schema (Engineer)
- **Android download** — `/download/` page + GitHub Releases APK channel
- **Page cleanup** — streamlined landing + Engineer shells, hardened worklet precache

---

## License

UNLICENSED — © 2026 Randy Jordan / Conqueror Studios. All rights reserved.
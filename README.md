# VoiceIsolate Pro

<p align="center">
  <a href="https://voice-isolate-pro.vercel.app"><strong>Live Demo</strong></a>
  &nbsp;·&nbsp;
  <a href="https://voice-isolate-pro.vercel.app/download/"><strong>Download</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk"><strong>Android APK</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-24.0.0-win-x64.exe"><strong>Windows</strong></a>
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
| [`/download/`](https://voice-isolate-pro.vercel.app/download/) | **Downloads** | Android APK + Windows installer (GitHub Releases), web app links. |

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
| **Full-audio analysis** | Local classical DSP (+ ML hints when models load): speech/noise/music/hum/whisper regions, confidence, explainable recommendations |
| **Source workspace** | Timeline lanes, source chips, independent layer audition (solo/mute/gain), original/layer/processed compare |
| **Whisper / faint speech** | WhisperLogic + WhisperHunter — detect low-level speech-like zones and process carefully (no word hallucination; no cloud ASR) |
| **Live-Mix (preview)** | Real-time gate/de-esser/EQ/comp via AudioWorklet + PlaybackMixer — sliders never re-run ML |
| **Offline process** | Higher-quality ML stem separation + single-pass spectral chain (one STFT → ops → one iSTFT) |
| **ML models (shipped)** | Demucs v4 quant, BSRNN vocals, RNNoise suppressor, Silero VAD — ONNX Runtime Web |
| **GPU execution** | WebGPU preferred → WASM fallback |
| **Speaker diarization** | Classical + optional worker path on clean stem; mute/solo/volume per speaker |
| **Format support** | MP3, WAV, M4A, FLAC, OGG, OPUS, MP4, MOV, WEBM, MKV, AVI, WMV, TS |
| **Privacy** | 100% local processing · no telemetry · audio never uploaded |
| **Engineer presets** | Voice Clarity · Podcast Clean · Whisper Boost · Phone/Radio · Room Echo · Hum Removal · Forensic · Aggressive Isolate · Surveillance |

---

## Architecture: Stem-Split & Live-Mix

The app uses a **two-phase model** (see [`CLAUDE.md`](CLAUDE.md)), plus optional full-audio analysis before process:

1. **Analyze (optional):** `FullAnalysisWorker` / classical `FeatureExtractor` → segments, whisper regions, recommendations, visual layers, audition metadata.
2. **Phase 1 — Offline inference** (once per file): `FileIngestion` → `MLWorker` (ONNX) → clean/noise stems + spectral cleanup.
3. **Phase 2 — Live-Mix playback** (continuous, zero ML): stems → `PlaybackMixer` + `vip-gate` / `vip-deesser` worklets → real-time sliders.

```
UI Thread
  upload / transport / controls
  analysis workspace (lanes, chips, explanation)
  source audition · export
       │
Capability / Init
  DSP registry · worklet · worker · model · calibration
       │
  ┌────┴────────────────────────────┐
  │ LIVE (preview)                  │ OFFLINE
  │ PlaybackMixer + AudioWorklet    │ FullAnalysisWorker
  │ gate/deess/EQ AudioParams only  │ FeatureExtractor · WhisperLogic
  │                                 │ RecommendationEngine
  │                                 │ MLWorker (WebGPU/WASM)
  │                                 │ one STFT → ops → one iSTFT
  └─────────────────────────────────┘
```

### Live vs offline

| Path | Role | Latency / quality |
|------|------|-------------------|
| **Live-Mix** | Preview processed stems; tweak gate/EQ/comp in real time | Low latency; no re-inference |
| **Offline analysis** | Understand the whole file before processing | Full-file features + recommendations |
| **Offline process** | ML isolation + spectral chain for final quality | Higher fidelity than preview-only |

### Critical Constraints
- **Single-Pass Spectral Architecture** — exactly ONE Forward STFT, in-place spectral operations, exactly ONE iSTFT per offline spectral branch.
- **100% Local Processing** — no fetch of user audio to servers; models load same-origin from `/app/models/`.
- **ML via ONNX Runtime Web** — WebGPU EP preferred, WASM EP fallback.
- **No live microphone ingestion** — upload-only workflow (`getUserMedia` forbidden).
- **Honest layers** — audition quality badges (`high` / `medium` / `low`); no fake perfect stems.

### Engineer analysis flow

```
Load App → Validate capabilities → Upload/Decode
→ Analyze Full Audio → Detect sources / whisper regions
→ Build recommendations + visual lanes + audition layers
→ Solo / mute / loop inspect → Apply Recommendations
→ (optional) Analyze + Process → Offline render → Export
```

---

## ML Model Stack (actually shipped)

| Model | Path | Task | Approx size |
|-------|------|------|-------------|
| Demucs v4 quantized | `public/app/models/demucs_v4_quantized.onnx` | Vocal / source separation | ~149 MB |
| Demucs v4 fp32 | `demucs_v4_fp32.onnx` (optional heavy) | Separation | ~370 MB |
| Band-Split RNN | `bsrnn_vocals.onnx` | Vocal mask | ~3.7 MB |
| RNNoise suppressor | `rnnoise_suppressor.onnx` | Noise suppression mask | ~2 MB |
| Silero VAD | `silero_vad.onnx` / `_int8` | Voice activity | ~2.3 MB |

Loaded lazily · SHA-256 verified via `src/core/ModelManifest.js` · cached in IndexedDB where supported.

**Fallback:** if a model is missing or integrity fails, classical DSP analysis/processing continues with lower confidence and UI notices — never silent fake ML.

---

## Capability matrix

| Capability | Web (COOP/COEP) | Electron | Android WebView |
|------------|-----------------|----------|-----------------|
| Live-Mix playback | Yes | Yes | Yes |
| AudioWorklet gate/deess | Yes | Yes | Best-effort (bypass if fail) |
| SharedArrayBuffer | Yes when cross-origin isolated | Yes | Often limited → message-port fallback |
| WebGPU ORT | If available | If available | Device-dependent → WASM |
| Full analysis worker | Yes | Yes | Yes (memory-aware) |
| Export WAV | Download | Native save dialog | Download / share via OS |

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

### Downloads (GitHub Releases — correct asset URLs)

| Channel | URL |
|---------|-----|
| **Web download page** | https://voice-isolate-pro.vercel.app/download/ |
| **All releases** | https://github.com/Joker5514/VoiceIsolate-Pro/releases |
| **Latest Android APK** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk |
| **Pinned Android v24.0.0** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-android-debug.apk |
| **Latest Windows installer** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-24.0.0-win-x64.exe |
| **Pinned Windows v24.0.0** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe |

| Asset | Name | Approx. size | Updated |
|-------|------|----------------|---------|
| Android complete offline APK | `VoiceIsolate-Pro-android-debug.apk` | ~238 MB | 2026-07-21 |
| Windows NSIS installer | `VoiceIsolate-Pro-24.0.0-win-x64.exe` | ~178 MB | 2026-07-21 |

Current GitHub Release tag: **[v24.0.0](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v24.0.0)**  
(includes production analysis workspace + processing-stall fixes).

The download page always points at **real GitHub Release binaries** (never SPA HTML).  
Same-origin `/download/*.apk` and `/download/*.exe` redirect to Releases (`vercel.json`).

Build locally (Windows):

```bash
pnpm android:build:win
# → dist/android/VoiceIsolate-Pro-android-debug.apk

pnpm build:electron
# → dist/electron/VoiceIsolate-Pro-24.0.0-win-x64.exe
```

Sideload APK: enable **Install unknown apps**, then open the file.  
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
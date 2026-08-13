# VoiceIsolate Pro

<p align="center">
  <a href="https://voice-isolate-pro.vercel.app"><strong>Live Demo</strong></a>
  &nbsp;·&nbsp;
  <a href="https://voice-isolate-pro.vercel.app/download/"><strong>Download</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk"><strong>Android APK</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.1-win-x64.exe"><strong>Windows</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/README.md">Documentation</a>
  &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <strong>Best-in-class voice isolation &amp; audio enhancement — 100% on-device, zero cloud.</strong><br>
  32-stage Octa-Pass DSP · Hybrid ML (Demucs v4 + BSRNN + local target voiceprint) · WebGPU-Accelerated · Privacy-First
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-v25.0.1-red" alt="v25.0.1">
  <img src="https://img.shields.io/badge/architecture-Threads%20from%20Space%20v8-blueviolet" alt="Architecture">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node 22+">
  <img src="https://img.shields.io/badge/pnpm-11-000000?logo=pnpm&logoColor=f69220" alt="pnpm 11">
  <img src="https://img.shields.io/badge/privacy-no%20cloud%20audio-blue" alt="Privacy">
  <img src="https://img.shields.io/badge/license-Proprietary-red" alt="License">
</p>

---

## Overview

| | |
|---|---|
| **Problem** | Extract studio-quality voice from noisy recordings without sending audio to a server |
| **Workflow** | Upload (no decode freeze) → Analyze maps noise/voice → joint WhisperHunter isolation → Live-Mix preview & export |
| **Architecture** | Threads from Space v8 — Dispatcher-Worker model, SharedArrayBuffer ring buffers, single Forward STFT + single iSTFT constraint |
| **Execution** | Deferred decode on Analyze/Process · offline ML isolation · real-time Live-Mix via AudioWorklet · Forensic export via OfflineAudioContext |
| **Platforms** | Web (Vercel) · Desktop (Electron) · Android (Capacitor) — **one Engineer Console shell** (`public/app/`) on all three |
| **Engineer UI** | 3-col studio console · Process auto-chains analysis · click-safe / −1 dBTP cues · Focus enrollment collapsible |

> **Upload-only:** live microphone capture is intentionally disabled. Drop or browse for audio/video files on both surfaces — nothing is streamed to the cloud.

---

## Surfaces

| Route | Surface | What it does |
|-------|---------|--------------|
| [`/`](https://voice-isolate-pro.vercel.app/) | **Landing — Stem-Split** | Fast ML stem separation → Live-Mix sliders → per-speaker mute/solo → **Focus on one voice** enrollment → export. |
| [`/app/`](https://voice-isolate-pro.vercel.app/app/) | **Engineer Console** | Studio-rack UI (3-column session · stage · control rack): 67 sliders in module cards, spectrogram center stage, **DSP Integrity** + **Output Safety**, auto analysis/diarization after Process, collapsible **Focus on one voice**, Simple view toggle. Creator / Studio / Forensic tiers. Same shell on **Web, Android (Capacitor), Desktop (Electron)** via `pnpm build` → `build/` → cap sync / electron-builder. |
| [`/download/`](https://voice-isolate-pro.vercel.app/download/) | **Downloads** | Android APK + Windows installer (GitHub Releases), web app links. |

**Upload controls (both pages):** Browse Files (`<label for="fileInput">`), click the drop zone, drag-and-drop, or **Upload Audio or Video** in the Engineer hero. Shared wiring lives in `src/presentation/UploadWiring.js`.

### Playback worklets & engine status (Engineer)

| Component | Role |
|-----------|------|
| `vip-gate` | Real-time noise gate (`src/workers/GateProcessor.js`) |
| `vip-deesser` | Real-time de-esser (`src/workers/DeEsserProcessor.js`) |
| Cockpit pills | **CTX · WORKLET · GATE · DEESS · SAB · ML · ORT · NET** — driven by `vip-boot.js` + `PlaybackMixer` |
| Studio console | `engineer-console.css` / `engineer-console.js` — layout only; **all slider/canvas IDs preserved** |
| DSP Integrity UI | Phase · smoothed params · COLA · single-STFT cues |
| Output Safety UI | Peak / true-peak vs −1 dBTP ceiling (Clean / Near / Risk) |

Verify packaging: `pnpm worklets:verify`.  
Cross-platform assets: `pnpm build` (copies `public/` + `src/` → `build/`) then `pnpm android:prepare` / `pnpm build:electron`.

---

## Pipeline: 32-Stage Octa-Pass DSP

Audio flows through **one Forward STFT** at the start of the spectral phase, in-place operations, and **one iSTFT** at the end — preventing phase smearing.

| Pass | Stages | Purpose |
|------|--------|---------|
| **Pass 1** — Classical DSP Annihilation | 1–8 | DC removal, continuous noise profiling, 32-band ERB spectral gate, hum annihilation, Wiener-MMSE, click removal, spectral subtraction, residual gate |
| **Pass 2** — Deep ML Source Separation | 9–14 | Demucs v4 hybrid U-Net, Band-Split RNN, ensemble mask fusion, **local mel voiceprint** target isolation (ECAPA-TDNN planned), speaker diarization, VAD hard gate |
| **Pass 3** — Room Isolation & Reconstruction | 15–18 | WPE dereverberation, harmonic reconstruction, Griffin-Lim phase reconstruction, HiFi-GAN neural vocoder |
| **Pass 4** — Enhancement & Export | 19–24 | Broadcast EQ, de-esser, voice-gated HF boost, multi-band dynamics, ITU-R BS.1770 loudness normalize, WAV/MP3/FLAC/OGG encode |
| **Passes 5–8** *(Engineer Mode)* | 25–32 | Extended per-stage controls — 67-slider UI with 3D spectrogram & Whisper Hunter forensic pass |

---

## Key Features

| Feature | Spec |
|---------|------|
| **Full-audio analysis** | Local classical DSP (+ ML hints when models load): speech/noise/music/hum/whisper/impulse regions, confidence, explainable recommendations |
| **Analyzer ↔ WhisperHunter** | Joint protect/suppress map — isolate voices & whispers while removing music, horns, barks, crowd, hum |
| **Deferred decode** | Upload accepts the file instantly; PCM decode starts on Analyze / Process / Play (no upload freeze) |
| **Source workspace** | Timeline lanes, source chips, independent layer audition (solo/mute/gain), original/layer/processed compare |
| **Whisper / faint speech** | WhisperLogic + WhisperHunter — detect low-level speech-like zones and process carefully (no word hallucination; no cloud ASR) |
| **Live-Mix (preview)** | Real-time gate/de-esser/EQ/comp via AudioWorklet + PlaybackMixer — sliders never re-run ML |
| **Offline process** | Higher-quality ML stem separation + single-pass spectral chain (one STFT → ops → one iSTFT) |
| **ML models (shipped)** | Demucs v4 quant, BSRNN vocals, RNNoise suppressor, Silero VAD — ONNX Runtime Web |
| **GPU execution** | WebGPU preferred → WASM fallback |
| **Speaker diarization** | Classical + optional worker path on clean stem; mute/solo/volume per speaker |
| **Target voice focus** | Step-by-step local enrollment (mel voiceprint) on **Landing + Engineer** (+ Android/Electron same shell); soft gain isolate; diarization fusion when available; no re-ML |
| **Format support** | MP3, WAV, M4A, FLAC, OGG, OPUS, MP4, MOV, WEBM, MKV, AVI, WMV, TS |
| **Privacy** | 100% local processing · no telemetry · audio never uploaded |
| **Engineer presets** | Voice Clarity · Podcast Clean · Whisper Boost · Phone/Radio · Room Echo · Hum Removal · Forensic · Aggressive Isolate · Surveillance |
| **Slider discipline (v25)** | Non-linear calibration for Voice Iso / BG Suppress / Crosstalk; coupling + soft artifact clamps on **effective DSP values only** (UI ranges never snapped) |
| **Per-slider lock** | Padlock on every row; locks survive reload (`localStorage`); presets/reset skip locked controls; **Reset Unlocked Only** |
| **Unified metrics** | Single `updateAudioMetrics()` writer for Voice % · Noise % · SNR dB across header, pipeline strip, and neon pulse |
| **Collapsible sections** | Native `<details>`/`<summary>` for Upload, Processing, slider families, waveform/spectrum |
| **Stage-aware overlay** | Processing spinner variants: uploading → decoding → analyzing → separating → isolating → reconstructing → exporting |

---

## Architecture: Stem-Split & Live-Mix

The app uses a **two-phase model** (see [`CLAUDE.md`](CLAUDE.md)), plus optional full-audio analysis before process:

1. **Upload:** accept File only (metadata + optional video picture). No PCM decode — UI stays responsive.
2. **Analyze:** `ensureDecoded()` then `FullAnalysisWorker` / classical `FeatureExtractor` → segments, whisper regions, recommendations. `AnalyzerWhisperBridge` builds a joint protect/suppress map with WhisperHunter env profiling.
3. **Phase 1 — Offline inference** (once per file): `MLWorker` (ONNX) + single-pass spectral cleanup.
4. **Phase 2 — Live-Mix playback** (continuous, zero ML): stems → `PlaybackMixer` + `vip-gate` / `vip-deesser` worklets → real-time sliders.

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
Load App → Validate capabilities → Upload (no decode)
→ Analyze Full Audio (decode here) → Detect sources / whisper / noise / impulses
→ Analyzer ↔ WhisperHunter joint map (protect voice, suppress interference)
→ Solo / mute / loop inspect → Apply Recommendations
→ Analyze + WhisperHunter  or  Process → Offline render → Export
```

### Freeze resistance

- Cooperative `scheduler.yield` / rAF yields during STFT and long DSP
- Mid-channel stereo process path (halves spectral cost)
- Worklets load lazy on first Live-Mix need — never block upload
- No auto-pipeline on file drop (user starts Analyze / Process)

### Release notes PDF

Latest product snapshot: [`docs/releases/VoiceIsolate_Pro_v25_Current_State.pdf`](docs/releases/VoiceIsolate_Pro_v25_Current_State.pdf)  
(Prior archive: [`docs/releases/VoiceIsolate_Pro_v24_Latest.pdf`](docs/releases/VoiceIsolate_Pro_v24_Latest.pdf))

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

**Requirements:** Node.js ≥ 22 · pnpm ≥ 11

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
| `pnpm test` | Jest suite (2400+ tests) |
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
| **Pinned Android v25.0.1** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.1/VoiceIsolate-Pro-android-debug.apk |
| **Latest Windows installer** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.1-win-x64.exe |
| **Prior Windows v24.0.0** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe |

| Asset | Name | Approx. size | Notes |
|-------|------|----------------|---------|
| Android complete offline APK | `VoiceIsolate-Pro-android-debug.apk` | ~250 MB | **v25.0.1** on `latest` |
| Windows NSIS installer | `VoiceIsolate-Pro-25.0.1-win-x64.exe` | ~267 MB | **v25.0.1** on `latest` |

In-repo version (Web / Android `versionName` / Electron artifact): **25.0.1** (`versionCode` / iOS build **250001**).  
Published GitHub Release **`latest` = [v25.0.1](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.1)**.

The download page always points at **real GitHub Release binaries** (never SPA HTML).  
Same-origin `/download/*.apk` and `/download/*.exe` redirect to Releases (`vercel.json`).

Build locally (Windows):

```bash
pnpm android:build:win
# → dist/android/VoiceIsolate-Pro-android-debug.apk  (versionName 25.0.1)

pnpm build:electron
# → dist/electron/VoiceIsolate-Pro-25.0.1-win-x64.exe
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
  app/               Engineer Mode v25 (app.js, style.css, worklets, models)
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
| Architecture v26 | [docs/architecture/VoiceIsolate_Pro_Architecture_v26.md](docs/architecture/VoiceIsolate_Pro_Architecture_v26.md) |
| Technical whitepaper | [docs/architecture/VoiceIsolate_Pro_Technical_Whitepaper.md](docs/architecture/VoiceIsolate_Pro_Technical_Whitepaper.md) |
| Master Blueprint | [docs/architecture/VoiceIsolate-Pro_Master_Blueprint_v2.1.md](docs/architecture/VoiceIsolate-Pro_Master_Blueprint_v2.1.md) |
| Contributor contract | [CLAUDE.md](CLAUDE.md) |
| Analysis workspace | [docs/guides/ANALYSIS_WORKSPACE.md](docs/guides/ANALYSIS_WORKSPACE.md) |
| AudioWorklets | [docs/guides/WORKLETS.md](docs/guides/WORKLETS.md) |
| Android app | [docs/guides/ANDROID.md](docs/guides/ANDROID.md) |
| Downloads (APK / Windows) | [docs/DOWNLOADS.md](docs/DOWNLOADS.md) |
| Model delivery | [docs/guides/MODEL_DELIVERY.md](docs/guides/MODEL_DELIVERY.md) |
| Desktop | [docs/guides/electron-desktop.md](docs/guides/electron-desktop.md) |
| Archive (historical) | [docs/archive/README.md](docs/archive/README.md) |

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

## Recent changes (v25.0.1)

- **Version sync** — `package.json`, Android (`25.0.1` / `250001`), iOS, Capacitor UA, API health, SAM runtime package
- **Download links** — Windows primary URL points at published **v24.0.0** asset (25.x installer names 404 until a new release)
- **SAM-Audio** — production Desktop worker path + hub/FFmpeg bootstrap
- **SAM 3 vision** — local sidecar scaffold (feature-flagged OFF) on web shell
- **Audio / UI polish** — soft gate, spectral OLA, unified Creator/Studio/Forensic tiers

### Prior (v25.0.0 / v24)

- Slider discipline · per-slider locks · unified metrics · collapsible Engineer panels
- Upload-only workflow · Chromium picker fix · WhisperHunter single-pass · gate/de-esser worklets · STFT yields

---

## License

UNLICENSED — © 2026 Randy Jordan / Conqueror Studios. All rights reserved.
---

## SAM-Audio (Prompted Isolation)

**Decision: local worker only (Option B).** There is no verified browser ONNX export of Meta SAM-Audio in this repo.

| Path | Behavior |
|------|----------|
| Default | BSRNN / RNNoise / classical USM query priors — 100% on-device |
| Optional | Localhost SAM-Audio worker (services/sam-audio/) for Creator/Forensic |
| Live mode | SAM never runs inside AudioWorklet |
| Android | No on-device SAM claim; shared ONNX/USM only |
| Desktop | Electron may start/stop the loopback worker via secure IPC |

See [docs/guides/SAM_AUDIO.md](docs/guides/SAM_AUDIO.md) and [docs/guides/PLATFORM_CAPABILITY_MATRIX.md](docs/guides/PLATFORM_CAPABILITY_MATRIX.md).


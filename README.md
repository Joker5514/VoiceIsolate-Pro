# VoiceIsolate Pro

[![CI](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/ci.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/ci.yml)
[![Android Build](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/android-build.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/android-build.yml)
[![Deploy](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml)
![Version](https://img.shields.io/badge/version-22.1.0-blue)
![License](https://img.shields.io/badge/license-All%20Rights%20Reserved-red)
![Platform](https://img.shields.io/badge/platform-browser%20%7C%20android%20%7C%20ios-lightgrey)
![Privacy](https://img.shields.io/badge/privacy-100%25%20local-brightgreen)

> **Studio-grade voice isolation and audio enhancement — 100% local, zero cloud inference.**
> **v22.1** — Powered by real STFT spectral processing, adaptive Wiener filtering, and a 35-stage deca-pass DSP pipeline. Fully browser-native. Zero cloud egress.

---

## Overview

VoiceIsolate Pro is a production-grade, privacy-first audio processing platform that isolates voices from any audio or video source — music, crowd noise, HVAC, reverb, hum — using real spectral math, not toy filters. Built on the **Threads from Space v11** architecture: a multi-threaded, GPU-acceleratable DSP engine running entirely in the browser via Web Audio API, AudioWorklet, and ONNX Runtime Web.

**Live:** Auto-deployed to Vercel on push to `main`.

---

## What's New in v22.1.0

- **Resume Playback** — Pause and resume from exactly where you left off. No restart needed.
- **A/B Toggle** — Instantly switch between original and processed audio in the transport bar, synced with the spectrogram view.
- **Improved Presets** — All 9 presets professionally retuned for better out-of-the-box results.
- **Spectrogram Sync** — A/B toggle, spectrogram, and source selector are bidirectionally synced.
- **File Upload Fixes** — Resolved strict MIME type validation bugs blocking MP3, MKV, and other common formats.
- **UI Streamlined** — Removed the "How It Works" card from the main interface to clean up the mobile layout.
- **CI/CD Hardened** — Deploy workflow now triggers on pull requests; CSP tightened (removed `wasm-unsafe-eval`, added `cdnjs.cloudflare.com`).
- **Monetization System** — Freemium tiers (Free / Pro / Studio / Enterprise) with offline JWT licensing, Stripe, and RevenueCat IAP.
- **AI Engine v2** — Voice fingerprinting, gradient-descent auto-tune, per-speaker noise profile library, multi-speaker detection.
- **Batch Processing** — Concurrent multi-file queue with ZIP export (Studio+ tier).
- **Cloud Sync** — Cross-device preset and profile sync via REST API (Studio+ tier).
- **Privacy-First Analytics** — Local-only usage tracking by default; server reporting is strictly opt-in and never includes audio data.

---

## Architecture

```
Threads from Space v11 — Browser-Native DSP Engine

┌─ Main Thread ──────────────────────────────────────────┐
│  UI · Transport · Sliders · 3D Spectrogram (Three.js)  │
└────────────┬───────────────────────────────────────────┘
             │ SharedArrayBuffer / MessageChannel
┌────────────┴───────────────────────────────────────────┐
│  AudioWorklet (RT)    │  DSP Workers (CPU-0..N)        │
│  Ring buffer I/O      │  STFT · Wiener · ERB Gate      │
│  Lock-free exchange   │  Deverb · Harmonic · Tilt      │
├───────────────────────┼────────────────────────────────┤
│  ML Workers (GPU-0..N)│  Batch Orchestrator            │
│  ONNX Runtime Web     │  Priority queue · Progress     │
│  Demucs · BSRoFormer  │  1–1000+ files concurrent      │
└───────────────────────┴────────────────────────────────┘
```

### Key Source Files

| File | Purpose |
|------|---------|
| `public/app/index.html` | App shell — 52-slider engineer panel, 6-panel diagnostics, 3D spectrogram |
| `public/app/app.js` | Main application — pipeline wiring, transport, visualizations, presets (2121 lines) |
| `public/app/dsp-core.js` | Pure DSP math — STFT/iSTFT, biquad filters, adaptive Wiener, ERB gate, harmonic v2, deverb (1373 lines) |
| `public/app/dsp-worker.js` | Web Worker wrapper for DSPCore offload (504 lines) |
| `public/app/dsp-processor.js` | AudioWorklet processor for real-time streaming < 10ms (1013 lines) |
| `public/app/ml-worker.js` | ONNX Runtime Web inference — Demucs, BSRoFormer, ECAPA-TDNN, Silero VAD (697 lines) |
| `public/app/pipeline-orchestrator.js` | DAG-based pipeline execution, stage dependencies, error propagation |
| `public/app/pipeline-state.js` | Centralized reactive state for all pipeline parameters |
| `public/app/ring-buffer.js` | Lock-free SharedArrayBuffer ring buffer for AudioWorklet ↔ Worker exchange |
| `public/app/ai-engine-v2.js` | Voice fingerprinting, gradient-descent auto-tune, multi-speaker detection |
| `public/app/batch-orchestrator.js` | Multi-file batch processing with priority queue and ZIP export |
| `public/app/license-manager.js` | Offline JWT license validation and tier enforcement |
| `public/app/paywall.js` | Feature gating and Stripe/RevenueCat integration |
| `public/app/cloud-sync.js` | Cross-device preset and profile synchronization via REST API |
| `vercel.json` | COOP/COEP/CSP headers required for SharedArrayBuffer |

---

## 35-Stage Deca-Pass Pipeline

Single forward STFT → all spectral ops in-place → single inverse STFT. No phase smearing.

| Pass | Stages | Operations |
|------|--------|------------|
| **1. Ingest** | S01–S04 | Decode, buffer alloc, DC removal, peak norm |
| **2. Analysis** | S05–S09 | VAD, noise gate, click removal, hum removal, de-ess |
| **3. Spectral NR** | S10–S12 | Adaptive Wiener (Martin 2001), residual MMSE Wiener, 32-band ERB gate |
| **4. Voice Isolation** | S13–S14 | Voice-band spectral emphasis, crosstalk cancellation |
| **5. Anti-Garble** | S15–S16 | Temporal smoothing, spectral tilt compensation |
| **6. Room** | S17 | Dereverberation (spectral tail subtraction) |
| **7. Harmonics** | S18 | Harmonic reconstruction v2 (SBR, formant protection, breathiness) |
| **8. EQ + Dynamics** | S19–S25 | HP/LP, 10-band parametric EQ, compressor, limiter (OfflineAudioContext) |
| **9. Mastering** | S26–S29 | Dry/wet mix, peak normalization |
| **10. Finalize** | S30–S32 | Quality metrics, waveform update, export ready |

---

## DSP Capabilities

- **Adaptive Wiener Filter** — Martin 2001 minimum statistics noise estimation with VAD-gated profiling, per-bin Speech Presence Probability weighting
- **32-Band ERB Spectral Gate** — Psychoacoustic Equivalent Rectangular Bandwidth bands, per-band SNR-adaptive thresholds
- **Temporal Smoothing** — Cross-frame gain smoothing eliminates musical noise and garbled artifacts
- **Dereverberation** — Late reflection estimation via exponential decay model, spectral subtraction
- **Harmonic Enhancement v2** — Spectral Band Replication above 8kHz, formant F1/F2 detection and protection, breathiness control via spectral flatness
- **Cascaded Notch Hum Removal** — 60Hz + 5 harmonics at Q=35
- **Click/Pop Removal** — Transient detection with AR-prediction interpolation
- **De-Essing** — Band-isolated sibilance compression
- **10-Band Parametric EQ** — Sub through brilliance with voice-optimized Q curves
- **Full Dynamics** — Compressor, makeup gain, brick-wall limiter, output gain

---

## ML Models (Lazy-Loaded via ONNX Runtime Web)

| Model | Task | Size (ONNX INT8) | Tier |
|-------|------|-------------------|------|
| Silero VAD v5 | Voice activity detection | ~350 KB | Pro+ |
| DeepFilterNet3 | Speech denoising + dereverberation | ~35 MB | Studio+ |
| Demucs v4.1 | Primary source separation | ~150 MB | Studio+ |
| BS-RoFormer | Ensemble separation | ~30 MB | Studio+ |
| ECAPA-TDNN | Speaker embeddings (256-dim) | ~2–3 MB | Pro+ |
| HiFi-GAN v2 | Neural vocoder | ~4 MB | Studio+ |
| Conformer-S | Residual artifact cleanup | ~8 MB | Forensic+ |

The classical DSP pipeline (passes 1–10 above) operates independently without ML for lightweight deployments. All models are optional and lazily downloaded on first use.

---

## UI Features

- **52 Sliders** across 8 tabbed panels (Gate, Noise Reduction, EQ, Dynamics, Spectral, Advanced, Separation, Output)
- **9 Presets** — Podcast, Film, Interview, Forensic, Music, Broadcast, Restoration, Whisper, Crystal Voice + custom save/load
- **6-Panel Diagnostic Dashboard** — A/B waveform comparison, oscilloscope (wave/mirror/XY), spectrogram with noise/ERB/ML overlays, LUFS meter, ML saliency heatmap, speaker PCA cluster
- **3D Spectrogram** — Three.js rendered, drag-to-orbit, scroll-to-zoom, click-band-to-mute
- **Full Transport** — Play/pause/stop, seek bar, speed control (0.25x–2x), A/B original/processed toggle
- **Video Support** — MP4/MOV/WEBM with synced processed audio playback
- **Live Recording** — Direct microphone capture with real-time visualization

---

## Presets

| Preset | Use Case | Key Settings |
|--------|----------|-------------|
| Podcast | Spoken word content | NR 60%, voice focus, presence boost, –16 LUFS |
| Film | Dialogue preservation | Light NR, room tone kept, natural dynamics |
| Interview | Multi-speaker | Crosstalk cancel, balanced NR, mono focus |
| Forensic | Evidence-grade | Minimal destructive processing, max clarity boost |
| Music | Vocal extraction | Light NR, wide stereo, harmonic preservation |
| Broadcast | Radio/TV compliance | Aggressive NR, tight dynamics, EBU R128 |
| Restoration | Damaged audio | Deep NR, harmonic recovery, deverb |
| Whisper | Low-level speech | High sensitivity, presence/clarity boost |
| Crystal Voice | Maximum clarity | Full pipeline engagement, all enhancements |

---

## Monetization Tiers

| Tier | Price | Features |
|------|-------|----------|
| **Free** | $0 | Classical DSP pipeline, 5-min processing limit, watermarked exports |
| **Pro** | $12/mo | Full 35-stage pipeline, ML models (VAD, ECAPA-TDNN), unlimited duration, no watermark |
| **Studio** | $29/mo | Pro + batch processing (up to 1000 files), Cloud Sync, ZIP export, API access |
| **Enterprise** | $199/mo | White-label, custom models, SLA, dedicated support |

Licensing uses offline JWT validation — no network call required to gate features. Mobile purchases handled via RevenueCat (iOS/Android).

---

## Privacy & Security

- **100% Local Processing** — All audio stays in the browser. Zero network requests during processing.
- **Zero Audio Telemetry** — No audio data, content, or fingerprints are ever transmitted. Usage analytics are local-only by default; server reporting requires explicit opt-in.
- **COOP/COEP Headers** — Required for SharedArrayBuffer, configured in `vercel.json`.
- **Strict CSP** — Allows only self, `cdnjs.cloudflare.com` (Three.js), and blob/data URIs. No `wasm-unsafe-eval`.
- **Offline JWT Licensing** — License validation works without an internet connection.

---

## Browser Support

| Platform | Support |
|----------|---------|
| Chrome 90+ | Full (WebGPU where available) |
| Firefox 88+ | Full (WebGL2 fallback) |
| Safari 15.4+ | Full (WASM fallback) |
| Edge 90+ | Full |
| iOS / Android | Native app via Capacitor; responsive web layout also supported |

---

## Getting Started

```bash
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro
npm install
npm run dev        # serves public/ on localhost:3000
```

For mobile builds:

```bash
npm run android:build   # Android APK via Gradle + Capacitor
npm run ios:build       # iOS via Capacitor (requires macOS + Xcode)
```

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Serve `public/` on port 3000 with CORS headers |
| `npm run build` | Copy `public/` into `build/` for alternate deployment |
| `npm run lint` | Run ESLint on core pipeline files |
| `npm test` | Run Jest unit test suite |
| `npm run validate` | Run structural pipeline validation script |
| `npm run android:build` | Build Android APK |
| `npm run ios:build` | Build iOS app (macOS + Xcode required) |

---

## Deployment

Auto-deploys to Vercel on push to `main` via GitHub integration. Output directory: `public/` (Vercel) or `build/` (alternate).

---

## Version History

| Version | Architecture | Stages | Key Innovation |
|---------|-------------|--------|----------------|
| v4 | Single-context FFT | 6 | Auto noise profiling, spectral subtraction |
| v6 | 16-stage neural DSP | 16 | WASM/WebGPU integration, AudioWorklet |
| v11 | 20-stage triple-pass | 20 | ERB spectral gate, Band-Split RNN |
| v13 | 24-stage quad-pass | 24 | Neural vocoder, plugin API |
| v16 | 28-stage hexa-pass | 28 | BSRNN ensemble, smart logic, 40+ sliders |
| v18 | 32-stage octa-pass | 32 | Conformer refiner, forensic audit chain |
| v20 | Modular vanilla JS | 32 | Threads from Space v10, modular build |
| v22.0 | 35-stage deca-pass | 35 | Real STFT pipeline, adaptive Wiener, anti-garble, harmonic v2 |
| **v22.1** | **35-stage deca-pass** | **35** | **Monetization, AI Engine v2, batch processing, Cloud Sync, privacy analytics** |

---

## License

All Rights Reserved. See [LICENSE](LICENSE) for details.

---

**VoiceIsolate Pro v22.1.0** · Threads from Space v11 · Privacy-First · Updated April 2026

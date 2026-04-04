# VoiceIsolate Pro

[![CI](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/ci.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/ci.yml)
[![Android Build](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/android-build.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/android-build.yml)
[![Deploy](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml)
![Version](https://img.shields.io/badge/version-22.0.0-blue)
![License](https://img.shields.io/badge/license-All%20Rights%20Reserved-red)
![Platform](https://img.shields.io/badge/platform-browser%20%7C%20android%20%7C%20ios-lightgrey)
![Privacy](https://img.shields.io/badge/privacy-100%25%20local-brightgreen)

> **Studio-grade voice isolation and audio enhancement — 100% local, zero cloud inference. Now with Monetization, AI Engine v2, and Cloud Sync.**
> **v22.0** — Studio-grade voice isolation powered by real STFT spectral processing, adaptive Wiener filtering, and a 35-stage deca-pass DSP pipeline. 100% browser-native. Zero cloud egress.

---

## Overview

VoiceIsolate Pro is a production-grade audio processing platform that isolates voices from any audio or video source — music, crowd noise, HVAC, reverb, hum — using real spectral math, not toy filters. Built on the **Threads from Space v11** architecture: a multi-threaded, GPU-acceleratable DSP engine running entirely in the browser via Web Audio API, AudioWorklet, and ONNX Runtime Web.

**Live:** Deployed via Vercel auto-deploy on push to `main`.

---

- **Resume Playback**: Pause and resume from exactly where you left off — no restart needed.
- **Original/Processed Toggle**: Visual toggle switch in the transport bar to instantly switch between original and processed audio, synced with the spectrogram view.
- **Improved Presets**: All 9 presets (Podcast, Film, Interview, Forensic, Music, Broadcast, Restoration, Whisper, Crystal Voice) have been professionally retuned for better results out of the box.
- **Spectrogram Sync**: A/B toggle in transport, spectrogram, and source toggle are all bidirectionally synced.
- **File Uploads Fixed**: Solved strict MIME type validation bugs that previously prevented common audio/video types (like MP3s and MKVs) from uploading correctly.
- **Engineer Mode Refined**: Removed the clunky "How It Works" card from the main app interface to streamline the mobile UI and save space.
- **CI/CD Fixes**: Deploy workflow now triggers on pull requests, CSP hardened (removed `wasm-unsafe-eval`, added `cdnjs.cloudflare.com`).
## Current Version: v22.0.0 — Monetization & AI Engine v2 Upgrade

**Version 22** introduces a comprehensive monetization architecture and major AI upgrades:

- **Freemium Monetization System**: Free, Pro ($12/mo), Studio ($29/mo), and Enterprise tiers.
- **Paywall & Licensing**: Secure offline JWT license validation, feature gating, and Stripe/RevenueCat integration.
- **AI Engine v2**: Voice fingerprinting, advanced auto-tune via gradient descent, noise profile library, and multi-speaker detection.
- **Batch Processing**: Process multiple files concurrently with ZIP export (Studio/Enterprise feature).
- **Cloud Sync**: Sync presets, noise profiles, and history across devices (Studio/Enterprise feature).
- **Privacy-First Analytics**: Local-only usage tracking by default. Server reporting is strictly opt-in and never includes audio data or content.
## Architecture

```
Threads from Space v11 — Browser-Native DSP Engine

┌─ Main Thread ──────────────────────────────────────────┐
│  UI · Transport · Sliders · 3D Spectrogram (Three.js)  │
└────────────┬───────────────────────────────────────────-┘
             │ SharedArrayBuffer / MessageChannel
┌────────────┴───────────────────────────────────────────┐
│  AudioWorklet (RT)    │  DSP Workers (CPU-0..N)        │
│  Ring buffer I/O      │  STFT · Wiener · ERB Gate      │
│  Lock-free exchange   │  Deverb · Harmonic · Tilt      │
├───────────────────────┼────────────────────────────────┤
│  ML Workers (GPU-0..N)│  Batch Orchestrator            │
│  ONNX Runtime Web     │  Priority queue · Progress     │
│  Demucs · BSRoFormer  │  1-1000+ files concurrent      │
└───────────────────────┴────────────────────────────────┘
```

### Key Source Files

| File | Purpose |
|------|---------|
| `index.html` | Root app shell — 52-slider engineer panel, 6-panel diagnostics, 3D spectrogram |
| `app.js` | Main application — 35-stage pipeline, transport, visualizations, presets |
| `dsp-core.js` | Pure DSP math — STFT/iSTFT, biquad filters, adaptive Wiener, ERB gate, VAD, harmonic v2, deverb, temporal smoothing, noise classifier |
| `dsp-worker.js` | Web Worker wrapper for DSPCore offload |
| `ml-worker.js` | ONNX Runtime Web inference (Demucs, BSRoFormer, ECAPA-TDNN, Silero VAD) |
| `pipeline-orchestrator.js` | DAG-based pipeline execution, stage dependencies, error propagation |
| `pipeline-state.js` | Shared state management across pipeline stages |
| `ring-buffer.js` | Lock-free SharedArrayBuffer ring buffer for AudioWorklet ↔ Worker exchange |
| `batch-orchestrator.js` | Multi-file batch processing with priority queue |
| `voice-isolate-processor.js` | AudioWorklet processor for real-time path |
| `style.css` | Dark engineer UI theme |
| `vercel.json` | COOP/COEP/CSP headers for SharedArrayBuffer support |

---

## 35-Stage Deca-Pass Pipeline

| Feature | Detail |
|---------|--------|
| **36-stage Deca-Pass DSP** | 10 passes × 4 stages: Ingest → Analysis → Filter → Spectral NR → EQ → Spectral Processing → Dynamics → Master → Export |
| **AI Engine v2** | Voice fingerprinting, noise profile library, adaptive spectral masking, and PESQ-inspired quality estimation |
| **Monetization Tiers** | Flexible pricing with feature gates, usage quotas, and trial support |
| **Batch Processing** | Concurrent processing queue with progress tracking and ZIP export |
| **Cloud Sync** | Cross-device synchronization of presets and profiles via REST API |
| **Mobile Native** | Runs as a native app on Android and iOS using Capacitor, with RevenueCat IAP support |
| **Hybrid ML + Classical** | Demucs v4.1, BSRNN, DeepFilterNet3 working alongside Wiener filtering and spectral subtraction |
| **100% Local Processing** | Audio never leaves your device. No server uploads. No cloud inference. |
The core processing engine. Single forward STFT → all spectral ops in-place → single inverse STFT. No phase smearing.

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
- **Temporal Smoothing** — Cross-frame gain smoothing eliminates musical noise / garbled artifacts
- **Dereverberation** — Late reflection estimation via exponential decay model, spectral subtraction
- **Harmonic Enhancement v2** — Spectral Band Replication above 8kHz, formant F1/F2 detection and protection, breathiness control via spectral flatness
- **Cascaded Notch Hum Removal** — 60Hz + 5 harmonics at Q=35
- **Click/Pop Removal** — Transient detection with AR-prediction interpolation
- **De-Essing** — Band-isolated sibilance compression
- **10-Band Parametric EQ** — Sub through brilliance with voice-optimized Q curves
- **Full Dynamics** — Compressor, makeup gain, brick-wall limiter, output gain

---

## ML Models (Roadmap / Lazy-Loaded)

| Model | Task | Size (ONNX INT8) | Status |
|-------|------|-------------------|--------|
| Demucs v4.1 | Primary source separation | ~150 MB | Planned (Studio tier) |
| BS-RoFormer | Ensemble separation | ~30 MB | Planned (Studio tier) |
| ECAPA-TDNN | Speaker embeddings (192-dim) | ~2-3 MB | Planned (Pro tier) |
| Silero VAD v5 | Voice activity detection | ~350 KB | Planned (Pro tier) |
| HiFi-GAN v2 | Neural vocoder | ~4 MB | Planned (Studio tier) |
| Conformer-S | Residual artifact cleanup | ~8 MB | Planned (Forensic tier) |

Classical DSP pipeline operates independently without ML for lightweight deployments.

---

## UI Features

- **52 Sliders** across 8 tabbed panels (Gate, Noise, EQ, Dynamics, Spectral, Advanced, Separation, Output)
- **9 Presets** — Podcast, Film, Interview, Forensic, Music, Broadcast, Restoration, Whisper, Crystal Voice + custom save
- **6-Panel Diagnostic Dashboard** — A/B waveform, oscilloscope (wave/mirror/XY), spectrogram with noise/ERB/ML overlays, LUFS meter, ML saliency heatmap, speaker PCA cluster
- **3D Spectrogram** — Three.js rendered, drag-to-orbit, scroll-to-zoom, click-band-to-mute
- **2D Real-Time Spectrogram** — Scrolling frequency analysis
- **Full Transport** — Play/pause/stop, seek, speed control (0.25x–2x), A/B toggle
- **Video Support** — MP4/MOV/WEBM with synced processed audio playback
- **Recording** — Direct microphone capture with real-time visualization

---

## Presets

| Preset | Use Case | Key Settings |
|--------|----------|-------------|
| Podcast | Spoken word content | NR 60%, voice focus, presence boost, -16 LUFS |
| Film | Dialogue preservation | Light NR, room tone kept, natural dynamics |
| Interview | Multi-speaker | Crosstalk cancel, balanced NR, mono focus |
| Forensic | Evidence-grade | Minimal destructive processing, max clarity boost |
| Music | Vocal extraction | Light NR, wide stereo, harmonic preservation |
| Broadcast | Radio/TV compliance | Aggressive NR, tight dynamics, EBU R128 |
| Restoration | Damaged audio | Deep NR, harmonic recovery, deverb |
| Whisper | Low-level speech | High sensitivity, presence/clarity boost |
| Crystal Voice | Maximum clarity | Full pipeline engagement, all enhancements |

---

## Privacy & Security

- **100% Local Processing** — All audio stays in the browser. Zero network requests during processing.
- **Zero Audio Telemetry** — No audio data, content, or fingerprints are ever transmitted. Usage analytics (e.g., session counts) are local-only by default; server reporting requires explicit opt-in.
- **COOP/COEP Headers** — Required for SharedArrayBuffer, configured in `vercel.json`.
- **Strict CSP** — Only allows self, cdnjs.cloudflare.com (Three.js), and blob/data URIs.

### Tiers

- **Free**: Basic noise reduction, 5-min limit, watermarked exports.
- **Pro ($12/mo)**: Full 36-stage pipeline, ML models, unlimited duration, no watermark.
- **Studio ($29/mo)**: Pro features + Batch processing, Cloud Sync, API access.
- **Enterprise ($199/mo)**: White-label, custom models, SLA.

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Serve `public/` on port 3000 with CORS |
| `npm run build` | Copy `public/` into `build/` directory |
| `npm run lint` | Run ESLint on core pipeline files |
| `npm test` | Run Jest test suite |
| `npm run validate` | Run custom pipeline validation script |
## Deployment

Auto-deploys to Vercel on push to `main` via GitHub integration.

```bash
# Local development
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro
npm install
npm start          # serves on localhost:3000
```

Output directory: `public/` (Vercel) / `build/` (alternate).

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
| **v22** | **35-stage deca-pass** | **35** | **Real STFT pipeline, adaptive Wiener, anti-garble, harmonic v2** |

---

## Monetization Tiers (Planned)

| Tier | Price | Features |
|------|-------|---------|
| Free | $0 | Classical DSP pipeline, one-tap clean, WAV export |
| Creator Pro | $9/mo | + Demucs separation, voiceprint, batch (10 files) |
| Studio | $29/mo | + Ensemble fusion, HiFi-GAN vocoder, batch (1000 files) |
| Forensic | $79/mo | + Chain-of-custody, Conformer-S, unlimited batch |

---

## Browser Support

| Platform | Support |
|----------|---------|
| Chrome 90+ | ✅ Full (WebGPU where available) |
| Firefox 88+ | ✅ Full (WebGL2 fallback) |
| Safari 15.4+ | ✅ Full (WASM fallback) |
| Edge 90+ | ✅ Full |
| Mobile (iOS/Android) | ✅ Responsive layout |

---

**VoiceIsolate Pro v22.0.0** · Threads from Space v10 · Privacy-First · Updated March 2026
## License

[MIT](LICENSE)

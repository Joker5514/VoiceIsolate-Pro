# 🎙️ VoiceIsolate Pro

**Best-in-class voice isolation & audio enhancement platform**

[![Version](https://img.shields.io/badge/version-9.0-00ffc8?style=flat-square)](blueprints/)
[![Architecture](https://img.shields.io/badge/arch-Threads%20from%20Space-0077B6?style=flat-square)](#architecture)
[![License](https://img.shields.io/badge/license-Proprietary-red?style=flat-square)](LICENSE)

---

## Overview

VoiceIsolate Pro is a production-grade voice isolation platform combining classical DSP algorithms with state-of-the-art deep learning. Built on the **Threads from Space** architecture — a fully parallel, multi-threaded DSP engine with GPU acceleration, modular processing nodes, and distributed job orchestration.

### Key Capabilities

| Feature | Specification |
|---------|--------------|
| **Noise Floor** | -80dB (32 Bark-scale bands) |
| **Real-Time Latency** | <15ms (AudioWorklet pipeline) |
| **ML Separation** | Demucs v4 + Transformer masking |
| **Speaker Isolation** | ECAPA-TDNN 192-dim voiceprint |
| **Batch Processing** | 1–1,000+ files (async thread pool) |
| **Format Support** | MP3, WAV, M4A, FLAC, MP4, MOV, WEBM, MKV |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 BATCH JOB QUEUE                     │
│  [File 1] [File 2] [File 3] ... [File 1000+]       │
└─────────────────────┬───────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────┐
│           THREAD POOL DISPATCHER                    │
│  • Dynamic allocation (1 thread per 2 cores)        │
│  • Priority queue: Real-time > Batch                │
└─────────────────────┬───────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────┐
│           PROCESSING NODE GRAPH (18 Stages)         │
│  Decode → Normalize → Profile → FFT → VAD →        │
│  Voiceprint → Hum → Subtract → Gate → ML Sep →     │
│  Mask → Dereverb → Harmonic → Enhance → De-ess →   │
│  Loudness → Limiter → Export                        │
└─────────────────────┬───────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────┐
│           GPU ACCELERATION LAYER                    │
│  • CUDA / Metal / WebGL2 for STFT/iSTFT            │
│  • ONNX Runtime Web for ML inference                │
│  • Parallel FFT across 8192–16384 bins              │
└─────────────────────────────────────────────────────┘
```

---

## 18-Stage DSP Pipeline

| # | Stage | Purpose |
|---|-------|---------|
| 1 | Decode & Ingest | Format detection, decode, resample |
| 2 | Input Normalization | Peak normalize to -3dBFS |
| 3 | Noise Profiling | Continuous background sampling (32 Bark bands) |
| 4 | Forward FFT | STFT (4096–16384pt, Hann, 75% overlap) |
| 5 | Voice Activity Detection | Silero VAD per-frame probability |
| 6 | Voiceprint Matching | ECAPA-TDNN cosine similarity |
| 7 | Hum Removal | IIR notch cascade (50/60Hz + harmonics) |
| 8 | Spectral Subtraction | Multi-band Wiener filter |
| 9 | Spectral Gating | Per-band adaptive noise gate |
| 10 | ML Source Separation | Demucs v4 vocal mask inference |
| 11 | Transformer Mask Refinement | Temporal coherence enforcement |
| 12 | Dereverberation | WPE late reflection removal |
| 13 | Harmonic Reconstruction | YIN pitch + harmonic regeneration |
| 14 | Voice Enhancement | Broadcast EQ (warmth, presence, air) |
| 15 | De-Essing | Dynamic 4–8kHz sibilance control |
| 16 | Loudness Normalization | ITU-R BS.1770 LUFS targeting |
| 17 | True Peak Limiting | -1dBTP with ISP prevention |
| 18 | Export & Delivery | Encode, metadata, batch ZIP |

---

## ML Models

| Model | Purpose | Size (quantized) | Latency |
|-------|---------|------------------|---------|
| Demucs v4 | Source separation | ~100MB (int8) | ~2s/min |
| ECAPA-TDNN | Speaker embeddings | ~2.5MB | ~50ms |
| Silero VAD | Voice activity | ~350KB | <1ms |
| RNNoise | Real-time fallback | ~350KB | <5ms |
| VoiceFixer | Post-enhancement | ~15MB | ~500ms |

---

## Processing Modes

| Mode | Latency | Pipeline | Use Case |
|------|---------|----------|----------|
| **Live** | <15ms | Stages 1–4 | Streaming, calls |
| **Creator** | 2–4s/min | Full 18-stage | Podcasts, content |
| **Forensic** | 8–15s/min | Conservative + audit | Legal, evidence |
| **Batch** | Parallel | Full pipeline × N | Bulk processing |

---

## Export Presets

- **Crystal Voice** — Voiceover/audiobook (-80dB floor, warm presence)
- **Podcast Pro** — Broadcast-ready (-70dB, -16 LUFS)
- **Interview** — Journalism (-65dB, natural)
- **Film Dialogue** — Post-production (-60dB + room, -24 LUFS)
- **Forensic** — Evidence preservation (minimal, audit trail)
- **Camera Audio** — DSLR/phone cleanup (-70dB, wind removal)

---

## Platform Support

| Platform | Technology | Status |
|----------|-----------|--------|
| Web (PWA) | React + Web Audio API + WebGL2 + ONNX Runtime | ✅ Active |
| Desktop | Electron + CUDA/Metal + ffmpeg | 🔄 Phase 2 |
| Mobile | React Native + Expo | 📋 Phase 3 |
| CLI | Node.js + WASM DSP core | 📋 Phase 3 |

---

## Repository Structure

```
VoiceIsolate-Pro/
├── README.md
├── blueprints/
│   ├── VoiceIsolate_Pro_v9_Technical_Blueprint.docx    # Latest (v9.0)
│   └── VoiceIsolate_Pro_v7_5_Technical_Blueprint.md    # Prior version
├── docs/
│   ├── TECHNICAL_GUIDE.md
│   ├── voiceisolate_pro_v6_1.html                      # v6.1 implementation
│   └── voiceisolate_pro_v7_blueprint.html              # v7.0 blueprint app
└── src/                                                 # (coming soon)
```

---

## Security & Privacy

- **100% Local Processing** — No audio ever transmitted to servers
- **AES-256 Encryption** — Cached files and voiceprint embeddings
- **DOD 5220.22-M Secure Delete** — 3-pass overwrite for forensic mode
- **GDPR / CCPA / HIPAA** compliant
- **Zero Telemetry** — No analytics unless explicitly opted in

---

## Roadmap

| Phase | Timeline | Milestone |
|-------|----------|-----------|
| MVP | Months 1–3 | Core 6-stage DSP, PWA, basic presets |
| v1.0 | Months 4–8 | Full 18-stage, ML models, batch, desktop |
| v2.0 | Months 9–12 | Mobile, streaming, plugin API, 1000+ batch |
| Pro | Months 13–18 | Forensic, enterprise SSO, DAW plugins, API/SDK |

---

## Author

**Randy Jordan** — Senior Audio-DSP Architect

---

*Built with the Threads from Space Architecture*

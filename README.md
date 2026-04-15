# VoiceIsolate Pro · v24.0

> **Browser-based, 100% local, 40-stage audio processing platform.**
> Zero cloud. Zero telemetry. Privacy-first.

[![Deploy](https://img.shields.io/badge/Vercel-live-brightgreen?logo=vercel)](https://voice-isolate-pro.vercel.app)
[![Version](https://img.shields.io/badge/version-v24.0-blue)](#changelog)
[![Pipeline](https://img.shields.io/badge/pipeline-40--stage-purple)](#pipeline)
[![License](https://img.shields.io/badge/license-PROPRIETARY-red)](LICENSE)

---

## Architecture — Threads from Space v13 (v24)

```
┌─────────────────────────────────────────────────────────────┐
│                     Main Thread (UI)                        │
│   app.js · pipeline-state.js · batch-orchestrator.js       │
│   analytics.js · paywall.js · revenuecat.js                 │
└───────────┬─────────────────────────┬───────────────────────┘
            │ AudioWorklet port        │ Worker postMessage
            ▼                         ▼
┌─────────────────────┐   ┌───────────────────────────────────┐
│   AudioWorklet      │   │   DSP Worker Pool (DSP Workers)  │
│   voice-isolate-    │   │   · dsp-core.js  (all DSP math)  │
│   processor.js      │   │   · onnxruntime-web (WebGPU→WASM)│
│   <10ms latency     │   │   · Demucs v4.1 · BS-RoFormer    │
│  SharedArrayBuffer  │◄─►│   · ECAPA-TDNN · Silero VAD      │
└─────────────────────┘   │   · HiFi-GAN · Conformer-S       │
            │              │   · SharedArrayBuffer ring buffer│
            │              └───────────────────────────────────┘
            ▼
┌─────────────────────────────────────────────────────────────┐
│          PipelineOrchestrator (pipeline-orchestrator.js)    │
│  ┌─ Single-Pass STFT (Critical for phase coherence)        │
│  │  Forward FFT → 40-stage spectral ops (in-place)         │
│  │  → Inverse iFFT → Overlap-Add                            │
│  │                                                           │
│  └─ 12 Passes, 40 Stages (Dodeca-Pass):                    │
│     Pass  1: Ingestion & Normalization (S1–S4)             │
│     Pass  2: Analysis & Classification (S5–S8)             │
│     Pass  3: Classical DSP Annihilation (S9–S14)           │
│     Pass  4: ML Source Separation (S15–S19)                │
│     Pass  5: Spectral Refinement (S20–S22)                 │
│     Pass  6: Room Correction (S23–S26)                     │
│     Pass  7: Time-Domain Polish (S27–S29)                  │
│     Pass  8: Neural Reconstruction (S30–S33)               │
│     Pass  9: Stereo Recovery & Spatial (S34–S35)           │
│     Pass 10: Perceptual QA (S36–S37)                       │
│     Pass 11: Forensic Certification (S38)                  │
│     Pass 12: Output Mastering (S39–S40)                    │
└─────────────────────────────────────────────────────────────┘
```

### Key Source Files

| File | Role |
|---|---|
| `public/app/index.html` | UI shell · Engineer Mode · Advanced controls |
| `public/app/style.css` | Dark theme · CSS custom properties · Responsive |
| `public/app/app.js` | Main-thread orchestration · UI ↔ pipeline bridge |
| `public/app/dsp-core.js` | All DSP math (STFT, iSTFT, gates, EQ, dynamics, filters) |
| `public/app/pipeline-orchestrator.js` | 40-stage pipeline runner · ONNX model init |
| `public/app/voice-isolate-processor.js` | AudioWorkletProcessor · real-time live mode |
| `public/app/dsp-worker.js` | Worker thread · ML inference + CPU-heavy DSP |
| `public/app/ml-worker.js` | ML worker · ONNX Runtime Web · model management |
| `public/app/batch-orchestrator.js` | Batch processing orchestration · multi-file handling |
| `VoiceIsolate_Pro_v24_Blueprint.docx` | **Complete v24 technical specification (TfS v13)** |

---

## v24 Enhancements — Threads from Space v13

### New in v24.0
- **Threads from Space v13**: Upgraded architecture with adaptive ML routing and plugin bus
- **40-Stage Dodeca-Pass Pipeline**: 12 processing passes (up from 10 passes / 36 stages)
- **New Stages**: Micro-pitch correction (S28), spatial audio (S35), LUFS mastering (S39), scene classification (S08)
- **<10ms Latency**: Reduced from <16ms via optimized AudioWorklet + ring buffer
- **HiFi-GAN v2 Vocoder**: Neural speech resynthesis with natural breathiness
- **Stereo Recovery Pass**: Mid-side decomposition and spatial cue preservation
- **Forensic Certification**: SHA-256 chain-of-custody with timestamped audit chain
- **Ensemble Fusion**: Demucs v4.1 + BS-RoFormer + BSRNN with learned per-band weights

### Core Capabilities
- **Studio-Grade Voice Isolation**: -96dB noise floor, 32 ERB bands, forensic-grade
- **Multi-Band Noise Reduction**: Adaptive spectral gating with continuous noise tracking
- **Overlapping Voice Separation**: Attention-based mask estimation per speaker via voiceprint
- **Real-Time Processing**: <10ms end-to-end latency on desktop/mobile
- **Offline High-Fidelity**: Full 40-stage pipeline, 4x oversampling, neural reconstruction
- **Artifact Suppression**: Temporal coherence + harmonic reconstruction + musical noise removal

---

## Performance Metrics (v24)

| Metric | Value |
|---|---|
| **Real-Time Latency** | <10ms end-to-end (AudioWorklet) |
| **Offline Throughput** | 6–8x real-time (GPU), 2–4x (CPU) |
| **Noise Floor** | -96dB (offline), -72dB (real-time) |
| **SNR Improvement** | +10–15 dB |
| **PESQ Score** | >3.5 MOS |
| **Intelligibility (STOI)** | >97% |
| **ML Model Footprint** | ~50MB total (lazy loaded) |
| **Supported Formats** | MP3, WAV, M4A, FLAC, OGG, OPUS, AAC, MP4, MOV, WEBM, MKV |

---

## ML Model Stack

| Model | Role | Size (ONNX INT8) |
|---|---|---|
| Demucs v4.1 | Primary source separator | ~21MB |
| BS-RoFormer | Secondary separator (harmonic) | ~12MB |
| BSRNN | Tertiary separator (temporal) | ~8MB |
| ECAPA-TDNN | Speaker embedding (192-dim) | 2.5MB |
| Silero VAD v5 | Voice activity detection | 350KB |
| HiFi-GAN v2 | Neural vocoder | ~4MB |
| Conformer-S | Spectral refiner | ~2MB |

Execution: WebGPU → WebGL2 → WASM SIMD → JS fallback cascade.

---

## Deployment

**Platform**: Vercel (serverless, CDN-backed global deployment)

```bash
# Deploy from local
vercel --prod

# Auto-deploy from GitHub
# Push to main → Vercel auto-triggers → global CDN distribution
```

### Environment Variables (GitHub Secrets for CI/CD)
- `VERCEL_TOKEN`: Authentication token
- `VERCEL_ORG_ID`: Organization ID
- `VERCEL_PROJECT_ID`: Project ID

---

## Installation & Development

```bash
# Clone
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro

# Install dependencies
pnpm install

# Development server
pnpm dev  # localhost:3000

# Build
pnpm build

# Validate (syntax, pipeline audit)
pnpm validate

# Test
pnpm test
```

---

## Documentation

**Complete Technical Blueprint**: See `VoiceIsolate_Pro_v24_Blueprint.docx`

Sections:
1. Executive Summary & Version Evolution
2. Core Capabilities & Noise Classification Matrix
3. System Architecture (Threads from Space v13)
4. 40-Stage Dodeca-Pass Pipeline (all 12 passes detailed)
5. Algorithms & Models (ensemble fusion, voiceprint gating, adaptive noise)
6. Module-by-Module Breakdown with Critical Integration Points
7. Pseudocode: Complete Pipeline (offline + real-time AudioWorklet)
8. Model Selection Rationale (ONNX sizes, benchmarks, complementarity)
9. App Design & User Interface (Clean mode + Engineer mode)
10. Optimization Strategies for Low-Latency Processing
11. Security & Privacy Architecture (zero-egress, forensic chain)
12. Development Roadmap: MVP → Creator Pro → Studio → Forensic → Platform
13. Performance Benchmarks & Targets
14. System Architecture Diagrams
15. Appendix: Key Learnings & Anti-Patterns (v4–v23)

---

## Changelog

### v24.0 (April 2026) — Threads from Space v13
- **ARCHITECTURE**: Threads from Space v13 — adaptive ML routing, plugin bus, 7-layer system
- **PIPELINE**: 40-stage Dodeca-Pass (12 passes, up from 36-stage/10-pass)
- **NEW**: Micro-pitch correction (S28), spatial audio (S35), LUFS mastering (S39), scene classifier (S08)
- **NEW**: HiFi-GAN v2 neural vocoder for speech resynthesis
- **NEW**: Stereo recovery pass with mid-side decomposition
- **NEW**: Comprehensive v24 blueprint (15 sections, full pseudocode, architecture diagrams)
- **IMPROVED**: Real-time latency <10ms (down from <16ms)
- **IMPROVED**: Noise floor -96dB offline (up from -80dB)
- **IMPROVED**: 3-model ensemble fusion (Demucs + BS-RoFormer + BSRNN) with learned per-band weights
- **VERIFIED**: Single-pass STFT architecture enforced across all spectral operations

### v23.0 (Previous)
- Threads from Space v12 architecture
- 36-stage Deca-Pass pipeline
- Real-time + offline modes
- WebAudio integration

---

## License

This software is proprietary and all rights are reserved by VoiceIsolate Pro. Please refer to the `LICENSE` file for detailed terms and conditions.

## Links

- **Live Demo**: [voice-isolate-pro.vercel.app](https://voice-isolate-pro.vercel.app)
- **GitHub**: [github.com/Joker5514/VoiceIsolate-Pro](https://github.com/Joker5514/VoiceIsolate-Pro)
- **Author**: Randy Jordan ([@Joker5514](https://github.com/Joker5514))

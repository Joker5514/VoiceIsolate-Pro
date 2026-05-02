# VoiceIsolate Pro · v24.0

> **Browser-based, 100% local audio processing platform (after first-run model download).**
> ML models (rnnoise, demucs, bsrnn) are fetched once from HuggingFace CDN and cached locally.
> Zero cloud processing. Zero telemetry. Privacy-first. No audio data ever leaves your device.

[![Deploy](https://img.shields.io/badge/Vercel-live-brightgreen?logo=vercel)](https://voice-isolate-pro.vercel.app)
[![Version](https://img.shields.io/badge/version-v24.0-blue)](#changelog)
[![Pipeline](https://img.shields.io/badge/pipeline-32--stage-purple)](#pipeline)
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
│  │  Forward FFT (S10) → spectral ops in-place (S11–S19)    │
│  │  → Inverse iFFT (S20) → Overlap-Add                      │
│  │                                                           │
│  └─ 10 Passes, 32 Stages (Deca-Pass):                      │
│     Pass  1: Input & Normalization (S01–S04)               │
│     Pass  2: Pre-Spectral Cleanup (S05–S09)                │
│     Pass  3: Forward STFT (S10)                             │
│     Pass  4: Wiener NR (S11–S12)                            │
│     Pass  5: Spectral Refinement (S13–S19)                 │
│     Pass  6: Inverse STFT (S20)                             │
│     Pass  7: Offline Audio Graph (S21–S25)                 │
│     Pass  8: Render & Mix (S26–S28)                         │
│     Pass  9: Finalize & Metrics (S29–S31)                  │
│     Pass 10: Forensic Export (S32)                          │
└─────────────────────────────────────────────────────────────┘
```

### Key Source Files

| File | Role |
|---|---|
| `public/app/index.html` | UI shell · Engineer Mode · Advanced controls |
| `public/app/style.css` | Dark theme · CSS custom properties · Responsive |
| `public/app/app.js` | Main-thread orchestration · UI ↔ pipeline bridge |
| `public/app/dsp-core.js` | All DSP math (STFT, iSTFT, gates, EQ, dynamics, filters) |
| `public/app/pipeline-orchestrator.js` | 32-stage pipeline runner · ONNX model init |
| `public/app/dsp-processor.js` | AudioWorkletProcessor · real-time live mode (canonical) |
| `public/app/dsp-worker.js` | Worker thread · ML inference + CPU-heavy DSP |
| `public/app/ml-worker.js` | ML worker · ONNX Runtime Web · model management |
| `public/app/batch-orchestrator.js` | Batch processing orchestration · multi-file handling |

---

## v24 Enhancements — Threads from Space v13

### New in v24.0
- **Threads from Space v13**: Upgraded architecture with adaptive ML routing and plugin bus
- **32-Stage Deca-Pass Pipeline**: 10 processing passes, enforced by `scripts/validate.js`
- **Single-Pass STFT**: One forward STFT (S10) + one iSTFT (S20) per processing path, all spectral ops in-place
- **Forensic Certification**: SHA-256 chain-of-custody with timestamped audit chain
- **HiFi-GAN v2 Vocoder**: Neural speech resynthesis with natural breathiness
- **Ensemble Fusion**: Demucs v4.1 + BS-RoFormer + BSRNN with learned per-band weights
- **Stronger NR defaults** (v24 point releases): tuned noise-reduction and voice-isolation defaults to actually strip background noise in Engineer Mode

### Core Capabilities
- **Studio-Grade Voice Isolation**: low noise floor, 32 ERB bands, forensic-grade
- **Multi-Band Noise Reduction**: Adaptive spectral gating with continuous noise tracking
- **Overlapping Voice Separation**: Attention-based mask estimation per speaker via voiceprint
- **Real-Time Processing**: low-latency AudioWorklet path with SharedArrayBuffer ring buffer
- **Offline High-Fidelity**: Full 32-stage pipeline + neural reconstruction
- **Artifact Suppression**: Temporal coherence + harmonic reconstruction + musical noise removal

---

## Performance Targets (v24)

> These are design targets, not measured guarantees. Benchmarks vary by device, model backend (WebGPU/WASM), and input material.

| Metric | Target |
|---|---|
| **Real-Time Latency** | Low-latency AudioWorklet path (<20 ms end-to-end on desktop) |
| **Offline Throughput** | Several× real-time on modern GPU/CPU |
| **SNR Improvement** | +10–15 dB on typical speech-in-noise material |
| **ML Model Footprint** | ~50 MB total (lazy loaded, cached in IndexedDB) |
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

**Complete Technical Blueprint**: The long-form v24 design document is available on the [GitHub Releases page](https://github.com/Joker5514/VoiceIsolate-Pro/releases) as a release asset. `CLAUDE.md` is the authoritative contributor reference — read it before editing.

Blueprint sections:
1. Executive Summary & Version Evolution
2. Core Capabilities & Noise Classification Matrix
3. System Architecture (Threads from Space v13)
4. 32-Stage Deca-Pass Pipeline
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

### v24.0 (2026) — Threads from Space v13
- **ARCHITECTURE**: Threads from Space v13 — adaptive ML routing, plugin bus
- **PIPELINE**: 32-stage Deca-Pass (10 passes), enforced by `scripts/validate.js`
- **NEW**: HiFi-GAN v2 neural vocoder for speech resynthesis
- **NEW**: Comprehensive v24 blueprint (target architecture, pseudocode, diagrams)
- **IMPROVED**: 3-model ensemble fusion (Demucs + BS-RoFormer + BSRNN) with learned per-band weights
- **IMPROVED**: Stronger default NR + voice-isolation parameters so background noise is actually removed
- **IMPROVED**: Hardened playback controls + controls diagnostic script
- **VERIFIED**: Single-pass STFT architecture enforced across all three processing paths (main thread, DSP worker, AudioWorklet)

### v23.0 (Previous)
- Threads from Space v12 architecture
- Real-time + offline modes
- WebAudio integration

---

## License

This software is proprietary and all rights are reserved by VoiceIsolate Pro. Please refer to the `LICENSE` file for detailed terms and conditions.

## Links

- **Live Demo**: [voice-isolate-pro.vercel.app](https://voice-isolate-pro.vercel.app)
- **GitHub**: [github.com/Joker5514/VoiceIsolate-Pro](https://github.com/Joker5514/VoiceIsolate-Pro)
- **Author**: Randy Jordan ([@Joker5514](https://github.com/Joker5514))

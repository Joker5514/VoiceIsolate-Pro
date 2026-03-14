# VoiceIsolate Pro

[![CI](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Joker5514/VoiceIsolate-Pro)

> **Studio-grade voice isolation and audio enhancement — 100% local, zero cloud inference.**

VoiceIsolate Pro is a browser-based audio processing platform powered by a **32-stage Octa-Pass DSP pipeline** that combines hybrid ML and classical spectral processing. Built on the **Threads from Space v8** architecture, every byte of audio stays on your device.

---

## Features

- **32-stage Octa-Pass DSP** — 8 parallel passes, 4 stages each, for maximum quality
- **Hybrid ML + Classical Spectral** — Demucs v4.1, BSRNN, and classical filters working in tandem
- **100% Local Processing** — no server uploads, no telemetry, no cloud inference
- **Three Execution Modes** — Live (<10ms), Creator (full quality), and Forensic (SHA-256 audit trail)
- **Engineer Mode v19** — 52-slider real-time control interface with 3D spectrogram
- **WebGPU-accelerated** — falls back to WASM automatically

---

## Quick Start

### Local Development

```bash
# Serve with CORS support
npx serve public -l 3000 --cors

# Or open directly in browser
open public/app/index.html
```

### Deploy to Vercel

Push to `main` — Vercel auto-deploys on every commit. No configuration needed.

---

## Open in GitHub Codespaces

Get a full cloud-based editor with live preview in one click:

1. Click the **Open in GitHub Codespaces** badge above (or [click here](https://codespaces.new/Joker5514/VoiceIsolate-Pro))
2. Dependencies install automatically via `npm install`
3. Run `npm run dev` to start the preview server on port 3000
4. The preview URL appears automatically in the **Ports** panel

---

## Architecture

```
Audio Input
  → [INGEST]        4 stages  — format normalization, sample-rate conversion
  → [ANALYSIS]      4 stages  — FFT, VAD, speaker embedding
  → [ML SEPARATION] 4 stages  — Demucs v4.1 + BSRNN ensemble
  → [SPECTRAL]      4 stages  — single-pass STFT spectral ops
  → [ROOM]          4 stages  — reverb estimation and removal
  → [TIME-DOMAIN]   4 stages  — transient shaping, de-essing
  → [NEURAL]        4 stages  — HiFi-GAN v2 vocoder reconstruction
  → [MASTER]        4 stages  — loudness normalization, limiter
  → Output
```

### Critical Design Principle

> **Single-pass spectral architecture**: One STFT → all spectral operations in-place → one iSTFT. Eliminates phase smearing caused by multiple spectral round-trips.

---

## Execution Modes

| Mode | Latency | Pipeline | Use Case |
|------|---------|----------|----------|
| **Live** | <10ms | AudioWorklet + SharedArrayBuffer, reduced stages | Real-time streaming |
| **Creator** | Offline | Full 32-stage OfflineAudioContext | Maximum quality export |
| **Forensic** | Offline | Conservative + SHA-256 audit trail at every stage | Evidentiary / legal |

---

## ML Models (ONNX Runtime Web)

| Model | Role | Size |
|-------|------|------|
| Demucs v4.1 | Source separation (Transformer + U-Net) | ~150MB INT8 |
| BSRNN | Band-Split RNN ensemble partner | ~80MB |
| ECAPA-TDNN | Speaker embeddings (256-dim) | ~25MB |
| Silero VAD v5 | Voice activity detection | ~2MB |
| HiFi-GAN v2 | Neural vocoder reconstruction | ~55MB |
| Conformer | Spectral enhancement / final polish | ~40MB |

All models run locally via ONNX Runtime Web — **WebGPU primary, WASM fallback. Zero cloud inference.**

---

## Project Structure

```
public/
├── index.html          # Landing page
├── app/                # Engineer Mode v19
│   ├── index.html      # 52-slider processing interface
│   ├── style.css       # Dark industrial theme
│   └── app.js          # DSP pipeline + real-time audio chain
├── blueprint/          # v18 Technical Blueprint
│   └── index.html      # Full architecture documentation site
└── docs/               # Additional documentation
    ├── TECHNICAL_GUIDE.md
    └── v7.5-blueprint.md
```

---

## Version History

| Version | Key Innovation |
|---------|----------------|
| v4 | Auto noise profiling, spectral subtraction |
| v5 | Threads from Space concept, 12-stage pipeline |
| v7 | Modular node graph, thread-per-stage |
| v11 | ERB spectral gate, Band-Split RNN |
| v13 | Neural vocoder, phase-coherent reconstruction |
| v15 | Real Web Audio API chains |
| v16 | BSRNN ensemble, 40+ slider wiring |
| v17 | OfflineAudioContext graph, A/B comparison |
| v18 | Conformer refiner, forensic audit chain |
| **v19** | **52-slider Engineer Mode, 3D spectrogram** |

---

## Privacy

- 100% local processing — audio never leaves your device
- Zero telemetry
- AES-256 encryption at rest (optional)
- CSP header blocks all network calls during processing

---

**Threads from Space v8** — Privacy-First — March 2026

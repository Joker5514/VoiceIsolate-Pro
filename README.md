# VoiceIsolate Pro

[![CI](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml)

**Studio-grade voice isolation. 32-stage Octa-Pass DSP pipeline. Hybrid ML + classical spectral processing. 100% local processing.**

Built on the **Threads from Space v8** architecture.

---

## Quick Start

```bash
# Local development
npx serve public -l 3000 --cors

# Or just open public/app/index.html in a browser
```

**Live**: Deploy via Vercel — auto-deploys on push to `main`.

## Architecture

```
Audio Input → [INGEST] → [ANALYSIS] → [ML SEPARATION] → [SPECTRAL] → [ROOM] → [TIME-DOMAIN] → [NEURAL] → [MASTER] → Output
                4 stages   4 stages     4 stages          4 stages     4 stages   4 stages        4 stages    4 stages
```

**32 stages across 8 passes**, orchestrated by the Threads from Space thread pool.

### Critical Design Principle

> **Single-pass spectral architecture**: One STFT → all spectral operations in-place → one iSTFT. Eliminates phase smearing from multiple spectral round-trips.

## Project Structure

```
public/
├── index.html              # Landing page
├── app/                    # Engineer Mode v19 (the actual app)
│   ├── index.html          # 52-slider processing interface
│   ├── style.css           # Dark industrial theme
│   └── app.js              # DSP pipeline + real-time audio chain
├── blueprint/              # v18 Technical Blueprint
│   └── index.html          # Full architecture documentation site
└── docs/                   # Additional documentation
    ├── TECHNICAL_GUIDE.md
    └── v7.5-blueprint.md
```

## ML Models (ONNX Runtime Web)

| Model | Role | Size |
|-------|------|------|
| Demucs v4.1 | Source separation (Transformer + U-Net) | ~150MB INT8 |
| BSRNN | Band-Split RNN ensemble partner | ~80MB |
| ECAPA-TDNN | Speaker embeddings (256-dim) | ~25MB |
| Silero VAD v5 | Voice activity detection | ~2MB |
| HiFi-GAN v2 | Neural vocoder reconstruction | ~55MB |
| Conformer | Spectral enhancement / final polish | ~40MB |

All models run locally via ONNX Runtime Web (WebGPU primary, WASM fallback). **Zero cloud inference.**

## Execution Modes

- **Live** (<10ms): AudioWorklet + SharedArrayBuffer, reduced pipeline
- **Creator**: Full 32-stage, OfflineAudioContext, maximum quality
- **Forensic**: Conservative + SHA-256 audit trail at every stage

## Deployment

### Vercel (Recommended)
1. Connect this repo in Vercel dashboard
2. Set output directory to `public`
3. Auto-deploys on push to `main`

### GitHub Actions
Add these secrets to your repo:
- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

### Manual
```bash
npm i -g vercel
vercel login
vercel deploy --prod
```

## Copilot Agent

GitHub Copilot is configured via `.github/copilot-instructions.md` with:
- Architecture constraints (single-pass spectral, thread safety)
- Pipeline stage definitions
- Slider system documentation
- Code quality rules

## Tiers

| Tier | Price | Features |
|------|-------|----------|
| Free | $0 | 5 min/file, watermarked, One-Tap mode |
| Creator Pro | $12/mo | Unlimited, presets, batch 100 |
| Studio | $29/mo | Engineer panel, API, desktop |
| Forensic | $79/mo | Audit chain, chain-of-custody |

## Version History

| Version | Key Innovation |
|---------|---------------|
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

## Privacy

- 100% local processing
- Zero telemetry
- No audio data ever leaves the device
- AES-256 encryption at rest (optional)
- CSP blocks network during processing

---

**Threads from Space v8** — Privacy-First — March 2026

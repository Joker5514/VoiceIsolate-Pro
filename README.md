# VoiceIsolate Pro · v25.0

> **Browser-based, 100% local audio processing platform.**
> Zero cloud audio processing. Zero telemetry. Privacy-first.
>
> ML models are downloaded once from the same-origin model CDN and cached
> permanently in your browser's Cache API. After that initial download,
> all processing is 100% local — no audio data ever leaves your browser.

[![Deploy](https://img.shields.io/badge/Vercel-live-brightgreen?logo=vercel)](https://voice-isolate-pro.vercel.app)
[![Version](https://img.shields.io/badge/version-v25.0-blue)](#changelog)
[![Pipeline](https://img.shields.io/badge/pipeline-32--stage-purple)](#pipeline)
[![License](https://img.shields.io/badge/license-PROPRIETARY-red)](LICENSE)

---

## Architecture — Threads from Space v13

```
┌──────────────────────────────────────────────────────────────┐
│                     Main Thread (UI)                         │
│   app.js · pipeline-state.js · pipeline-orchestrator.js     │
└───────────┬──────────────────────────┬───────────────────────┘
            │ AudioWorklet port         │ Worker postMessage
            ▼                          ▼
┌─────────────────────┐   ┌────────────────────────────────────┐
│   AudioWorklet      │   │   ML Worker (ml-worker.js)         │
│   voice-isolate-    │   │   · onnxruntime-web (WebGPU→WASM)  │
│   processor.js      │   │   · Demucs v4.1 · BS-RoFormer      │
│   <10ms latency     │   │   · ECAPA-TDNN · Silero VAD        │
│  SharedArrayBuffer  │◄─►│   · HiFi-GAN · Conformer-S        │
└─────────────────────┘   └────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────┐
│          DSP Core — Single-Pass STFT (dsp-core.js)           │
│  ┌─ EXACTLY ONE Forward FFT (S10)                            │
│  │  → all spectral ops in-place (S11–S19)                   │
│  └─ EXACTLY ONE Inverse iFFT (S20) → Overlap-Add            │
│                                                              │
│  32 Stages total across 10 passes (Deca-Pass):              │
│  S01–S04: Input & Normalization                              │
│  S05–S09: Pre-Spectral Cleanup + VAD                        │
│  S10:     Forward STFT                                       │
│  S11–S19: In-Place Spectral Enhancement                      │
│  S20:     Inverse STFT                                       │
│  S21–S32: Post-Spectral Dynamics, ML, Output                │
└──────────────────────────────────────────────────────────────┘
```

---

## Canonical Source Files

> All runtime code lives in `public/app/`. Do not edit root-level duplicates — they do not exist.

| File | Role |
|---|---|
| `public/app/index.html` | App shell · Engineer Mode v19 · 52-slider UI |
| `public/app/app.js` | Main-thread orchestration · 52-slider wiring |
| `public/app/voice-isolate-processor.js` | Live AudioWorkletProcessor · STFT · SAB bridge · ring buffer |
| `public/app/dsp-processor.js` | Creator / Forensic offline processor |
| `public/app/dsp-worker.js` | DSP worker thread |
| `public/app/ml-worker.js` | ONNX inference worker (WebGPU → WASM fallback) |
| `public/app/dsp-core.js` | Single-pass STFT spectral library |
| `public/app/pipeline-orchestrator.js` | Pipeline orchestration |
| `public/app/pipeline-state.js` | State management |
| `public/app/ring-buffer.js` | Ring buffer utility |
| `public/app/visuals.js` | 3D spectrogram + meters |
| `public/app/style.css` | Dark theme |

---

## ML Model Stack

All models run locally via `onnxruntime-web`. WebGPU is the preferred execution provider; WASM is the fallback. No cloud inference.

| Model | Role | Latency | Mode |
|---|---|---|---|
| Silero VAD | Voice activity detection | ~5 ms | Live + Offline |
| Demucs v4.1 | Voice/music source separation | ~800 ms | Offline |
| BS-RoFormer | Speech enhancement mask | ~300 ms | Offline |
| ECAPA-TDNN | Speaker verification / voiceprint | ~50 ms | Offline |
| HiFi-GAN | Waveform vocoder / reconstruction | ~200 ms | Offline |
| Conformer-S | Noise-robust feature extraction | ~100 ms | Offline |

Models are downloaded once on first use and cached permanently in the browser Cache API (`vip-models-v1`). Repeat visits make zero network calls for model data.

---

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| **Web (Desktop)** | ✅ Production Ready | Chrome, Edge, Firefox, Safari (macOS) |
| **Web (Mobile)** | ✅ Production Ready | Chrome, Safari (iOS 15+) |
| **Android Native** | ⚠️ Not Ready | SharedArrayBuffer in WebView requires COOP/COEP header injection via AndroidManifest. Release signing, bundled model routing, `RECORD_AUDIO` permission, and WASM-only mobile fallback are unresolved. |
| **iOS Native** | ⚠️ Not Ready | iOS 15 AudioWorklet constraints may limit live mode. |

---

## Processing Modes

| Mode | Engine | Latency | Use case |
|---|---|---|---|
| **Live** | AudioWorklet + SharedArrayBuffer | <10 ms | Broadcast, video call, real-time monitoring |
| **Creator / Offline** | Web Workers + OfflineAudioContext | ~50–100 ms / chunk | Podcast, film post, batch export |
| **Forensic** | Full stack + audit log + SHA-256 chain | Higher quality | Legal, evidence, transcription |

---

## Control Surface

52 sliders across 8 tabs — all wired, preset-covered, and persisted to `localStorage`.

| Tab | Sliders |
|---|---|
| Gate | Threshold, Range, Attack, Release, Hold, Lookahead |
| Noise | Amount, Sensitivity, Spectral Sub, Floor, Smoothing |
| EQ | Sub, Bass, Warmth, Body, Low Mid, Mid, Presence, Clarity, Air, Brilliance |
| Dynamics | Compressor (6) + Limiter (2) |
| Spectral | HPF, LPF, De-esser, Spectral Tilt, Formant Shift |
| Advanced | Dereverb, Harmonic Recovery, Stereo Width, Phase Correction |
| Separation | Voice Iso, BG Suppress, Voice Focus Lo/Hi, Crosstalk Cancel |
| Output | Gain, Dry/Wet, Dither, Width |

---

## Installation & Development

```bash
# Clone
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro

# Install dependencies
pnpm install

# Development server
pnpm dev        # localhost:3000

# Build
pnpm build

# Test (1,834 unit tests across 52 suites)
pnpm test

# Browser smoke test (Playwright)
pnpm test:live
```

---

## Deployment

Platform: **Vercel**. Output directory: `public/`. Auto-deploy on push to `main`.

CI gates: `smoke-test` job must pass before `deploy-preview` or `deploy-production` run.

Critical headers (required for SharedArrayBuffer / live mode):
```json
"Cross-Origin-Opener-Policy": "same-origin"
"Cross-Origin-Embedder-Policy": "require-corp"
```

See `vercel.json` for the full header config including the worklet route.

---

## Documentation

| Document | Path |
|---|---|
| **Architecture Blueprint** (v25 canonical) | [`docs/v25/VoiceIsolate_Pro_v25_Production_Architecture_Blueprint.md`](docs/v25/VoiceIsolate_Pro_v25_Production_Architecture_Blueprint.md) |
| **Product Specification** | [`docs/v25/VoiceIsolate_Pro_v25_Product_Specification.md`](docs/v25/VoiceIsolate_Pro_v25_Product_Specification.md) |
| **Engineering Dossier** (implementation truth) | [`docs/v25/VoiceIsolate_Pro_v25_Engineering_Release_Dossier.md`](docs/v25/VoiceIsolate_Pro_v25_Engineering_Release_Dossier.md) |
| **AI Agent Directive** | [`AGENTS.md`](AGENTS.md) |
| **Claude Coding Agent Context** | [`CLAUDE.md`](CLAUDE.md) |

> ⚠️ Do not source architecture decisions from older blueprint files (v5–v24). The `docs/v25/` documents are the only canonical versions.

---

## Changelog

### v25.0 (2026-05) — Repo Cleanup + Canonical Docs
- **CLEANUP**: Removed 15 stale root-level files (old blueprints, one-off scripts, redundant docs)
- **DOCS**: Added canonical `docs/v25/` blueprint, product spec, and engineering dossier
- **DOCS**: Added `AGENTS.md` root-level AI source-of-truth directive
- **README**: Updated to reflect v25 state, removed references to deleted files

### v24.0.1 (2026-05) — Worklet Audit
- **FIXED**: Critical `SyntaxError` in `index.html` causing silent diarization init failure
- **UPGRADED**: Three.js r128 → 0.184.0 (ESM, locally committed, CSP-safe)
- **FIXED**: Ring buffer bugs in `voice-isolate-processor.js` (PR #428 — `inputProcessed` pointer, `drainHead` pointer, `hopsSinceInit` guard, full state reset on `initRingBuffers`)
- **CI**: Playwright browser smoke test + deploy gates added (PR #429)

### v24.0 (2026) — Threads from Space v13
- 32-stage Deca-Pass pipeline enforced by `scripts/validate.js`
- Single-pass STFT architecture locked across all processing paths
- Forensic SHA-256 chain-of-custody
- RNNoise ONNX committed (76 KB, eager-loaded)

---

## License

Proprietary — all rights reserved by Conqueror Studios / Randy Jordan. See `LICENSE`.

## Links

- **Live App**: [voice-isolate-pro.vercel.app](https://voice-isolate-pro.vercel.app)
- **GitHub**: [github.com/Joker5514/VoiceIsolate-Pro](https://github.com/Joker5514/VoiceIsolate-Pro)
- **Author**: Randy Jordan ([@Joker5514](https://github.com/Joker5514)) · Conqueror Studios

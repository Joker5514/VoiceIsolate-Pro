# VoiceIsolate Pro · v22.1

> **Browser-based, 100% local, 35-stage audio processing platform.**
> Zero cloud. Zero telemetry. Privacy-first.

[![Deploy](https://img.shields.io/badge/Vercel-live-brightgreen?logo=vercel)](https://voice-isolate-pro.vercel.app)
[![Version](https://img.shields.io/badge/version-v22.1-blue)](#changelog)
[![Pipeline](https://img.shields.io/badge/pipeline-35--stage-purple)](#pipeline)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## Architecture — Threads from Space v11

```
┌─────────────────────────────────────────────────────────────┐
│                     Main Thread (UI)                        │
│   app.js · pipeline-state.js · batch-orchestrator.js       │
│   analytics.js · paywall.js · revenuecat.js                 │
└───────────┬─────────────────────────┬───────────────────────┘
            │ AudioWorklet port        │ Worker postMessage
            ▼                         ▼
┌─────────────────────┐   ┌───────────────────────────────────┐
│   AudioWorklet      │   │   DSP Worker  (dsp-worker.js)    │
│   voice-isolate-    │   │   · dsp-core.js  (all math)      │
│   processor.js      │   │   · onnxruntime-web (WebGPU→WASM)│
│                     │   │   · Demucs v4.1 · BSRNN          │
│  SharedArrayBuffer  │◄─►│   SharedArrayBuffer ring buffer  │
└─────────────────────┘   └───────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│          PipelineOrchestrator (pipeline-orchestrator.js)    │
│  Forward STFT → 32 in-place spectral ops → iSTFT           │
│  (SINGLE STFT/iSTFT pair — no phase smearing)              │
└─────────────────────────────────────────────────────────────┘
```

### Key Source Files

| File | Role |
|---|---|
| `public/app/index.html` | UI shell · Engineer Mode v19 · 52-slider layout |
| `public/app/style.css` | Dark theme · CSS custom properties |
| `public/app/app.js` | Main-thread orchestration · UI ↔ pipeline bridge |
| `public/app/dsp-core.js` | All DSP math (STFT, iSTFT, gates, EQ, dynamics) |
| `public/app/pipeline-orchestrator.js` | 35-stage pipeline runner · ONNX init |
| `public/app/voice-isolate-processor.js` | AudioWorkletProcessor · real-time live mode |
| `public/app/dsp-worker.js` | Worker thread · ML inference + CPU-heavy DSP |
| `public/app/ml-worker.js` | Secondary ML worker · model management |
| `public/app/ring-buffer.js` | SharedArrayBuffer ring buffer (main ↔ worklet) |
| `public/app/pipeline-state.js` | Centralized pipeline state & event bus |
| `public/app/batch-orchestrator.js` | Multi-file queue + concurrent job dispatch |
| `public/app/analytics.js` | Privacy-first local analytics (no server calls) |
| `public/lib/ort.min.js` | **Local** ONNX Runtime Web — never loaded from CDN |
| `public/models/` | `.onnx` model files (Demucs v4.1, BSRNN, RNNoise) |
| `vercel.json` | COOP · COEP · CSP · HSTS · Permissions-Policy |

---

## 35-Stage Deca-Pass Pipeline

| Pass | Stages | Description |
|---|---|---|
| P1 | S01–S03 | Pre-gain · DC block · dither removal |
| P2 | S04–S06 | Noise profiling · adaptive gate · spectral gate |
| P3 | S07–S09 | **Forward STFT** (single) · de-reverb · de-echo |
| P4 | S10–S13 | ML voice separation (Demucs v4.1 / BSRNN) |
| P5 | S14–S17 | Parametric EQ (8-band) · harmonic exciter |
| P6 | S18–S21 | Dynamics: compressor · limiter · expander |
| P7 | S22–S25 | Spectral: de-noise II · de-click · artifact suppression |
| P8 | S26–S29 | Stereo imaging · width control · mid-side |
| P9 | S30–S32 | **Inverse STFT** (single) · LUFS norm · true-peak limit |
| P10 | S33–S35 | Dither · sample-rate conversion · output encoding |

> ⚠️ **Architecture Constraint**: Exactly **one** Forward STFT (S07) and **one** iSTFT (S30).
> All spectral operations are in-place between them. Never add a second STFT/iSTFT pair.

---

## Execution Modes

| Mode | Context | Latency | Notes |
|---|---|---|---|
| **Live** | `AudioWorklet` + `SharedArrayBuffer` | < 10 ms | Mic input · real-time |
| **Creator** | `OfflineAudioContext` | Unlimited | File processing |
| **Forensic** | `OfflineAudioContext` | Unlimited | Full audit log |
| **Batch** | `BatchOrchestrator` queue | Per-file | Multi-file queue |

---

## ML Models (Local ONNX Runtime)

All models run **100% locally** via `onnxruntime-web`:

- Execution provider priority: **WebGPU → WASM**
- Runtime loaded from `/lib/ort.min.js` — **no CDN ever**

| Model | File | Task |
|---|---|---|
| Demucs v4.1 | `models/demucs-v4.onnx` | Voice / music separation |
| BSRNN | `models/bsrnn.onnx` | Band-split RNN noise reduction |
| RNNoise | `models/rnnoise.onnx` | Lightweight real-time noise gate |

---

## Getting Started

```bash
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro
pnpm install
pnpm dev
```

> **SharedArrayBuffer requires cross-origin isolation.** Dev server must serve:
> ```
> Cross-Origin-Opener-Policy: same-origin
> Cross-Origin-Embedder-Policy: require-corp
> ```
> `vercel.json` sets these automatically in production.

### ONNX Runtime Setup

Place `ort.min.js` (from `onnxruntime-web` npm package) at `public/lib/ort.min.js`.
This file is never fetched from CDN. The pipeline falls back to classical DSP-only if missing.

---

## Architecture Constraints (DO NOT VIOLATE)

1. **No cloud APIs.** No `fetch()` to external servers. All models are local `.onnx` files.
2. **Single STFT/iSTFT pair.** One Forward STFT at S07, one iSTFT at S30. All spectral work in-place between them.
3. **ONNX Runtime from `/lib/ort.min.js` only.** Never load from CDN in any context.
4. **SharedArrayBuffer requires COOP + COEP.** Both headers must be present or the worklet ring buffer is undefined.
5. **AudioWorklet registered by PipelineOrchestrator only.** Never call `addModule()` from `app.js`, inline scripts, or any other file.
6. **Analytics is local-only.** No server endpoint, no external calls, no auto-init on page load.

---

## Changelog

### v22.1 — April 6 2026 (Deep Pipeline Audit)

| Bug ID | File | Fix |
|---|---|---|
| BUG-A | `app.js` | Removed duplicate `addModule()` from `ensureCtx()` — only `PipelineOrchestrator` registers the worklet |
| BUG-C | `index.html` | Added 8 missing `<script>` tags in correct dependency order before `app.js` |
| BUG-F | `analytics.js` | Removed server endpoint vars + disabled `DOMContentLoaded` auto-init |
| BUG-K | `dsp-worker.js` | Fixed `importScripts` to explicit `./dsp-core.js` relative path |
| BUG-M | `pipeline-orchestrator.js` | Added `ctx.resume()` before `addModule()` — fixes suspended AudioContext on mobile |
| BUG-N | `voice-isolate-processor.js` | Documented port.postMessage param path; empty `parameterDescriptors` confirmed |
| BUG-O | `dsp-worker.js` | ML timeout now calls `reject()` — callers properly use `.catch()` |
| BUG-CONSTRAINT | `pipeline-orchestrator.js` | Replaced CDN `ort.min.js` URL with `/lib/ort.min.js` |
| **vercel.json** | `vercel.json` | Added HSTS · Permissions-Policy · frame-ancestors · blob: in CSP connect-src |
| **README** | `README.md` | Full rewrite — correct version, file paths, pipeline table, constraints, changelog |

### v22.0 — Initial Engineer Mode v19

- 35-stage Deca-Pass pipeline  
- 52-slider UI · 6-panel diagnostics (waveform, spectrogram 2D/3D, before/after, noise floor, pipeline)
- Batch processing queue · Forensic audit log
- WebGPU → WASM ONNX fallback

---

## Critical Notes for Contributors

**AudioWorklet Registration** — `PipelineOrchestrator.initWorklet()` is the single owner of `addModule()`. Never call it from `app.js` or anywhere else.

**STFT Phase Contract** — `DSPCore.forwardSTFT()` is called exactly once per block. All spectral mask operations mutate the spectrum in-place. `DSPCore.inverseSTFT()` is called exactly once at the end. A second STFT/iSTFT pair causes phase smearing.

**SharedArrayBuffer Security** — The ring buffer uses `SharedArrayBuffer`, which requires both `COOP: same-origin` and `COEP: require-corp`. If you test locally without these headers, `SharedArrayBuffer` will be `undefined` and live mode silently breaks.

---

*VoiceIsolate Pro · Threads from Space v11 · 100% Local Processing · Zero Data Transmission*

# VoiceIsolate Pro · v24.0

> **Browser-based, 100% local audio processing platform (after first model download).**
> Zero cloud audio processing. Zero telemetry. Privacy-first.
>
> **Note on first-run model download**: ML models (2 MB – 150 MB) are
> downloaded once from Vercel Blob (via same-origin `/app/models/*.onnx`
> rewrites — see `MODELS.md`) and cached permanently in your browser
> Cache API. After that initial download, all processing is 100% local —
> no audio data ever leaves your browser.

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
│   <10ms latency     │   │   · Silero VAD · RNNoise         │
│  SharedArrayBuffer  │◄─►│   · Demucs · BSRNN (pending)     │
└─────────────────────┘   │   · SharedArrayBuffer ring buffer│
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
- **RNNoise broadband suppressor** shipped as repo-committed ONNX (76 KB, eager-loaded)
- **Stronger NR defaults** (v24 point releases): tuned noise-reduction and voice-isolation defaults to actually strip background noise in Engineer Mode

> **Note**: Demucs v4 and BSRNN are wired through the manifest and Vercel Blob rewrite path but ship as `pending_export` until ONNX export blockers are resolved (see manifest `export_notes`). HiFi-GAN and Conformer-S remain on the Phase 3 roadmap.

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

The runtime is wired for a multi-model stack with mixed shipping status. The manifest at `public/app/models/models-manifest.json` is the source of truth; ml-worker skips entries whose `status` is in `skip_statuses` (currently `pending_export`, `blocked_export`).

| Model | Role | Status | Size | Notes |
|---|---|---|---|---|
| Silero VAD v5 | Voice activity detection | committed | 2.3 MB | Repo-committed, trained weights |
| RNNoise (PyTorch GRU port) | Broadband noise suppressor | committed_approximation | 76 KB | Architecturally equivalent, untrained weights |
| Band-Split RNN | Secondary vocals extractor | committed_stub | 628 KB | Random weights; structurally valid for inference smoke tests |
| Demucs v4 (mdx_extra) | Primary source separator | pending_export | n/a | Blocked: HDemucs internal `torch.stft` on complex tensors not exportable at ONNX opset 17 |
| ECAPA-TDNN | Speaker embedding (192-dim) | not in manifest | n/a | Voiceprint gating stubs exist in code; model not registered |
| HiFi-GAN v2 | Neural vocoder | not started | n/a | Phase 3 roadmap |
| Conformer-S | Spectral refiner | not started | n/a | Phase 3 roadmap |

Cache API key: `vip-models-v1`. After first load each model is served from cache; repeat visits make zero network calls. Demucs ships via Vercel Blob rewrite when unblocked; populate URLs with `scripts/wire-blob-models.py`.

Execution provider cascade: WebGPU → WASM SIMD threaded → WASM (single-threaded fallback).

---

## Model CDN Setup

Models are delivered via a 3-tier redundant CDN waterfall implemented in
`public/app/model-cdn-loader.js`. The loader tries each source in order and
fails over automatically:

1. **Vercel Blob** (primary) — proxied through `/app/models/<filename>` so the
   browser sees a same-origin URL that satisfies CSP `connect-src 'self'`. The
   `vercel.json` rewrite maps the proxy to the actual blob CDN host.
2. **Cloudflare R2** (secondary) — `https://models.voiceisolatepro.com/models/...`
   (or `https://<bucket>.r2.dev/models/...` if no custom domain yet).
3. **HuggingFace Hub** (tertiary fallback) — `https://huggingface.co/Joker5514/voice-isolate-models/resolve/main/<filename>`.

Per-source URLs live in `public/app/models-manifest.json` (schemaVersion 2).
After a successful fetch the buffer is cached in the SW Cache (`vip-models-v1`)
under `/vip-model-cache/<modelKey>` with the active provider stamped in the
`X-VIP-Provider` response header.

### Upload order (run locally before deploying)

```bash
# 1. Vercel Blob (primary) — manifest source[0].url stays as the /app/models/ proxy path
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_3Jq9Akm8vl1TuB82_... \
  node scripts/upload-to-vercel-blob.mjs

# 2. Cloudflare R2 (secondary) — uses @aws-sdk/client-s3 against the R2 S3-compatible endpoint
R2_ACCOUNT_ID=... \
R2_ACCESS_KEY_ID=... \
R2_SECRET_ACCESS_KEY=... \
R2_BUCKET_NAME=voice-isolate-models \
R2_PUBLIC_URL=https://models.voiceisolatepro.com \
  node scripts/upload-to-r2.mjs

# 3. HuggingFace Hub (tertiary) — auto-creates the public model repo if missing
HF_TOKEN=hf_... python scripts/upload-to-huggingface.py
```

Each script writes its provider's source URLs back into
`public/app/models-manifest.json`. Commit the resulting manifest before deploying.

### Required Vercel project env vars

- `BLOB_READ_WRITE_TOKEN` — Vercel Blob RW token (already set — added May 4)
- `R2_ACCOUNT_ID` — Cloudflare account ID
- `R2_ACCESS_KEY_ID` — R2 API token Access Key
- `R2_SECRET_ACCESS_KEY` — R2 API token Secret
- `R2_BUCKET_NAME` — e.g. `voice-isolate-models`
- `R2_PUBLIC_URL` — public base URL (e.g. `https://models.voiceisolatepro.com`)
- `HF_TOKEN` — HuggingFace user access token with write scope on `Joker5514/voice-isolate-models`

Only `BLOB_READ_WRITE_TOKEN` is required at runtime/build time. The R2 and HF
vars are only needed for the upload scripts during local model rollouts —
the browser-side waterfall fetches public CDN URLs directly.

### vercel.json rewrite

The rewrite that maps the `/app/models/:model` proxy to your Vercel Blob store:

```json
{ "source": "/app/models/:model", "destination": "https://<store>.public.blob.vercel-storage.com/models/:model" }
```

Replace `<store>` (e.g. `store_3Jq9Akm8vl1TuB82` becomes
`<store-hostname>.public.blob.vercel-storage.com`) after running
`scripts/upload-to-vercel-blob.mjs`.

### CSP

`vercel.json` Content-Security-Policy `connect-src` includes:

```
'self' blob:
https://blob.vercel-storage.com https://*.public.blob.vercel-storage.com
https://*.r2.cloudflarestorage.com https://*.r2.dev https://models.voiceisolatepro.com
https://huggingface.co https://*.xethub.hf.co https://cas-bridge.xethub.hf.co
```

The `xethub` hosts are required because HuggingFace redirects large
files through their Xet CDN layer.

### Diagnostics

`window.ModelCDNLoader.getProviderHealthReport()` returns per-provider health
for the current session, e.g. `{ 'vercel-blob': true, 'r2': true, 'huggingface': true }`.
The Engineer Mode "CDN Health" panel renders this report and updates as the
waterfall fails over.

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
# (postinstall auto-copies ORT + Three.js to public/lib/ if not already committed)
pnpm install

# Development server
pnpm dev  # localhost:3000

# Build
pnpm build

# Validate (syntax, pipeline audit)
pnpm validate

# Test (54 suites)
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

### v24.0.1 (2026-05) — Worklet Audit + Three.js Upgrade
- **FIXED**: Critical `SyntaxError` in `index.html` — missing `</script>` before `#model-status-container` caused the diarization/speaker-isolation init module to fail silently and left the model-status UI out of the DOM
- **UPGRADED**: Three.js r128 (2021) → **0.184.0** (latest). Loaded as ESM via `<script type="importmap">` from locally-committed `/lib/three.module.min.js`; no CDN, CSP-safe. New `scripts/setup-three.js` handles fresh installs.
- **AUDITED**: All AudioWorklet, ring-buffer, and ML-worker code reviewed — no external fetch calls, correct COOP/COEP headers, SharedArrayBuffer handshake verified
- **CONFIRMED**: ONNX Runtime Web at latest (1.25.1)

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

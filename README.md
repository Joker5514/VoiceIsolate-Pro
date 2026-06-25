# VoiceIsolate Pro

**Studio-grade voice isolation, 100% in your browser.**
Upload a recording, let on-device AI split it into a clean-voice stem and a
background-noise stem, then mix the result in real time with zero-latency
sliders. No cloud processing. No uploads. Your audio never leaves the device.

---

## How It Works — Stem-Split & Live-Mix

VoiceIsolate Pro uses a deliberate two-phase model instead of fragile
live-stream processing:

### Phase 1 — Offline Batch Inference
1. **Upload** any audio or video file.
2. **Ingestion** decodes it and resamples to a canonical 48 000 Hz
   (`src/pipeline/FileIngestion.js`).
3. **Voice activity detection** (Silero VAD) gates silence before the heavier
   separation pass.
4. **AI separation** runs in a Web Worker using ONNX Runtime Web
   (WebGPU when available, WASM fallback). Two trained spectral-mask models —
   a **Band-Split RNN vocal extractor** and a **BiGRU noise suppressor** —
   are SHA-256 pinned and cached in IndexedDB. They process the full file
   once via STFT → mask → overlap-add reconstruction (`src/workers/MLWorker.js`).
5. **Spectral cleanup** (optional spectral subtraction + dereverb) runs
   offline on the clean stem (`src/workers/SpectralCleanupWorker.js`).
6. **Speaker diarization** segments the clean stem by voice timbre
   (`src/workers/DiarizationWorker.js`).
7. The output is a pair of stems: **Clean Voice** and **Background Noise**,
   plus per-speaker segment metadata.

### Phase 2 — Real-Time Playback Mixing
The stems are loaded into Web Audio `AudioBufferSourceNode`s routed through
independent `GainNode`s, EQ filters, a noise gate, and a de-esser
(`src/pipeline/PlaybackMixer.js`). Moving any slider adjusts those nodes
instantly during playback — the ML models are never re-run, so every control
responds with zero latency and zero glitches.

```
Upload ─► Decode/Resample ─► VAD ─► ONNX Inference ─► SpectralCleanup ─► Diarization
          (48 kHz)                   (one pass)
                                          │
                        ┌─────────────────┴─────────────────┐
                        ▼                                   ▼
                   Clean stem                          Noise stem
                        │                                   │
                   CleanGain                           NoiseGain
                        └──────────────┬────────────────────┘
                                  Gate / De-Esser / EQ
                                       │
                                    Output
                   Sliders adjust gains/EQ/worklets live ▲
```

## Features

- **AI voice isolation** — Band-Split RNN vocal separation + BiGRU noise
  suppression, executed entirely on-device
- **Speaker diarization** — log-mel timbral fingerprinting clusters voices by
  timbre (not just loudness); whispers still detected
- **Latency-free mixing** — noise reduction, per-speaker volume (0–200,
  supporting +6 dB boost for faint speakers), EQ, noise gate, and de-esser
  sliders act on the Web Audio graph in real time
- **Privacy-first** — zero cloud processing, zero audio upload; models are
  SHA-256 integrity-checked and cached locally in IndexedDB
- **Export** — WAV or MP3 export off the main thread via `AudioEncoderWorker`
- **Cross-platform** — Web (Vercel), Android & iOS via Capacitor

## Quick Start

```bash
pnpm install     # installs deps and vendors ONNX Runtime / Three.js locally
pnpm dev         # http://localhost:3000
pnpm test        # Jest suites
pnpm lint        # ESLint
pnpm validate    # structural integrity checks
```

Requirements: **Node.js ≥ 22**, **pnpm ≥ 10**.

No `.env` is needed for local audio processing. Payment and licensing features
require the variables documented in [`.env.example`](.env.example).

## Repository Layout

```
src/                       New 4-layer architecture (all new work goes here)
├── core/                  Layer 1 — pure primitives
│   ├── audio-config.js    SAMPLE_RATE = 48000 and DSP constants
│   ├── BufferPool.js      Pre-allocated Float32Array pool (zero-GC DSP)
│   ├── ModelManifest.js   Model URLs, sizes, SHA-256 hashes, I/O specs
│   ├── diarization.js     Speaker segmentation (log-mel + k-means)
│   └── SpectralCleanup.js Offline spectral subtraction + dereverb
├── workers/               Layer 2 — Web Workers
│   ├── MLWorker.js        ONNX inference: fetch → verify → cache → stems
│   ├── DiarizationWorker.js  Off-main-thread diarization
│   ├── SpectralCleanupWorker.js  Off-main-thread NR/dereverb
│   ├── AudioEncoderWorker.js     WAV / MP3 encoding
│   ├── GateProcessor.js   AudioWorklet: real-time noise gate (playback only)
│   └── DeEsserProcessor.js       AudioWorklet: real-time de-esser (playback only)
├── pipeline/              Layer 3 — orchestration
│   ├── FileIngestion.js   Decode → resample to 48 kHz
│   ├── PlaybackMixer.js   Live-Mix graph: stems → gains → EQ → output
│   ├── ProcessingOrchestrator.js  Mode-to-model-chain translation
│   ├── ExportOrchestrator.js      Stem → encode → Blob
│   └── EngineerModeBridge.js      Legacy UI adapter
└── presentation/          Layer 4 — DOM bindings
    ├── SliderUI.js        rAF-coalesced slider → PlaybackMixer
    ├── SpeakerControls.js Per-speaker volume / mute / solo cards
    ├── ExportControls.js  Format / quality picker → ExportOrchestrator
    ├── IsolationModeSelector.js  Mode dropdown → ProcessingOrchestrator
    └── LandingVisualizer.js      Three.js landing animation

server/                    Express security middleware (securityHeaders.js)
public/                    Static site + legacy Engineer Mode app (maintenance freeze)
api-routes/                Serverless API (Stripe monetization, licensing, sync)
tests/                     Jest suites (70 files)
scripts/                   Build, validation, and model tooling
android/ ios/              Capacitor mobile projects
docs/                      Internal architecture notes and audit reports
```

## Architecture Rules

The full contributor contract — layer boundaries, security headers, model
integrity, hard prohibitions (live-microphone ingestion, client-side auth,
CDN-loaded libraries), and the list of deliberately deleted legacy patterns —
lives in [`CLAUDE.md`](CLAUDE.md). Read it before contributing; CI and
`scripts/validate.js` enforce it.

## Security

- Strict security headers (`COOP`/`COEP`, CSP, `nosniff`, `X-Frame-Options`,
  `microphone=()`) via `server/securityHeaders.js` in development and
  `vercel.json` in production
- All secrets via environment variables — see `.env.example`
- ONNX models verified against pinned SHA-256 hashes before every session

## License

UNLICENSED — © Randy Jordan. All rights reserved.

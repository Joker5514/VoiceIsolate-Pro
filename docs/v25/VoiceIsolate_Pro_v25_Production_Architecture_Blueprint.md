---
title: "VoiceIsolate Pro v25.0 — Production Architecture Blueprint"
version: "v25.0"
product: "VoiceIsolate Pro"
status: "Canonical"
updated: "2026-05-12"
owner: "Conqueror Studios / Randy Jordan"
format: "Markdown"
---

# VoiceIsolate Pro v25.0 — Production Architecture Blueprint
**Threads from Space v13**
**Single-Pass Spectral Core · Browser-First Local AI Audio Platform**

> ⚠️ **THIS IS THE CANONICAL ARCHITECTURE DOCUMENT.**
> All AI agents, coding assistants, and contributors must treat this file as the primary source of truth for system design decisions. Do not derive architecture from older versioned files (v5–v24). The engineering dossier at `docs/v25/VoiceIsolate_Pro_v25_Engineering_Release_Dossier.md` is the implementation-level companion.

---

## Version metadata

- **Product:** VoiceIsolate Pro
- **Version:** v25.0 — convergence of the v24 formal architecture and the audited production repo state as of May 2026
- **Lineage:** v24 = Threads from Space v12, 36-stage Deca-Pass blueprint. Current shipped implementation = 32-stage audited chain. Both views are documented here.
- **Deployment status:** Web (Vercel) — production-ready. Android/Play Store — blocked (see Known Limitations).
- **Canonical processing rule:** Exactly ONE forward STFT → all spectral operations in-place → exactly ONE inverse STFT. No exceptions.

---

## Architectural principles

- **100% local processing.** All DSP and ML execution runs locally in the browser. ONNX Runtime, WASM assets, and model files are served from local project paths. No cloud APIs, no external fetch for processing data.
- **Single-pass spectral integrity.** One forward STFT, in-place spectral edits only, one inverse STFT. This prevents phase drift, echo, transient smear, and cumulative bin damage.
- **Mode separation.** Live mode = AudioWorklet-safe, bounded, VAD-only inference. Offline/Creator/Forensic = workers + full ML stack for higher quality.
- **Progressive control.** UX is three-tier: One-Tap → Quick Presets → Engineer Panel (52 sliders + diagnostics).
- **Headers are part of correctness.** COOP, COEP, and explicit worklet-script headers in `vercel.json` are operational requirements for SharedArrayBuffer, not optional infra details.

---

## System architecture

### Concurrency model

```
┌─────────────────────────────────────────┐
│       Audio Worklet Thread (Real-Time)  │
│  - VAD decision (from ML Worker)        │
│  - Biquad EQ, gates, limiters           │
│  - Live output @ 48 kHz, <10 ms latency │
└─────────────┬───────────────────────────┘
              │ SharedArrayBuffer ring
         ┌────┴──────────┐
         │               │
┌────────▼────────┐   ┌──▼──────────────┐
│  DSP Worker     │   │  ML Worker      │
│  (Ring Buffer)  │   │  (ONNX Runtime) │
│  - FFT/iFFT     │   │  - Demucs v4.1  │
│  - Spectral ops │   │  - BS-RoFormer  │
│  - Filters      │   │  - ECAPA-TDNN   │
│                 │   │  - Silero VAD   │
└─────────────────┘   │  - HiFi-GAN     │
                      └─────────────────┘
```

### Runtime modes

| Mode | Engine | ML | Latency | Use case |
|---|---|---|---|---|
| Live | AudioWorklet + SAB bridge | Silero VAD only | <10 ms | Broadcast, video call |
| Offline / Creator | Web Workers + OfflineAudioContext | Full stack | ~50 ms / 100 ms audio | Podcast, film, forensic |

---

## Canonical file inventory

| Path | Role | Status |
|---|---|---|
| `public/app/index.html` | App entry point (Engineer Mode v19 shell) | ✅ Canonical |
| `public/app/app.js` | Main-thread orchestration + 52-slider wiring | ✅ Canonical |
| `public/app/voice-isolate-processor.js` | Live AudioWorkletProcessor, STFT, SAB bridge, ring buffer | ✅ Canonical |
| `public/app/dsp-processor.js` | Creator/Forensic mode processor | ✅ Canonical |
| `public/app/dsp-worker.js` | DSP worker thread | ✅ Canonical |
| `public/app/ml-worker.js` | ONNX inference worker (WebGPU → WASM fallback) | ✅ Canonical |
| `public/app/dsp-core.js` | Single-pass STFT spectral library | ✅ Canonical |
| `public/app/pipeline-orchestrator.js` | Pipeline orchestration layer | ✅ Canonical |
| `public/app/pipeline-state.js` | Pipeline state manager | ✅ Canonical |
| `public/app/ring-buffer.js` | Ring buffer utility | ✅ Canonical |
| `public/app/style.css` | Dark theme | ✅ Canonical |
| `public/app/visuals.js` | 3D spectrogram + meters | ✅ Canonical |

> All files in `public/app/` are the canonical runtime surface. Root-level duplicates were cleaned in PRs #424–#428. If you find a root-level `app.js`, `dsp-core.js`, `style.css`, or `voice-isolate-processor.js` — it is stale and should not be edited.

---

## Pipeline definition

### Formal blueprint (36-stage target)

| Phase | Stages | Description |
|---|---|---|
| Input Preparation | S01–S04 | Decode, channel analysis, DC removal, peak normalize |
| Profiling & Detection | S05–S07 | Noise floor profiling, spectral fingerprint, Silero VAD |
| Spectral Front-End | S08–S11 | HPF, LPF, voice band isolation, **Single Forward STFT** |
| Spectral Enhancement | S12–S26 | Wiener, adaptive gate, EQ bands (S15–S24), de-essing, spectral tilt |
| ML Enhancement (offline) | S27–S29 | Demucs v4.1, BS-RoFormer, HiFi-GAN |
| Temporal & Dynamic | S30–S33 | Dereverb, harmonic reconstruction, compression, brickwall limiter |
| Output & Finalization | S34–S36 | Dry/wet blend, **Single Inverse STFT**, gain + dither + export |

### Current audited production implementation (32-stage)

| Phase | Stages | Status |
|---|---|---|
| Ingestion + pre-processing | S01–S09 | ✅ In `dsp-core.js` |
| **Single Forward STFT** | **S10** | ✅ — constraint honored |
| In-place spectral processing | S11–S19 | ✅ All ops mutate `mag[]` directly |
| **Single Inverse STFT** | **S20** | ✅ — constraint honored |
| Post-spectral dynamics + output | S21–S32 | ✅ OfflineAudioContext chain |

---

## Control surface

52 sliders across 8 categories — all confirmed wired, DOM-built, event-bound, preset-covered, and persisted to `localStorage`.

| Tab | Sliders | Count |
|---|---|---|
| Gate | gateThresh, gateRange, gateAttack, gateRelease, gateHold, gateLookahead | 6 |
| Noise | nrAmount, nrSensitivity, nrSpectralSub, nrFloor, nrSmoothing | 5 |
| EQ | eqSub, eqBass, eqWarmth, eqBody, eqLowMid, eqMid, eqPresence, eqClarity, eqAir, eqBrill | 10 |
| Dynamics | compThresh, compRatio, compAttack, compRelease, compKnee, compMakeup, limThresh, limRelease | 8 |
| Spectral | hpFreq, hpQ, lpFreq, lpQ, deEssFreq, deEssAmt, specTilt, formantShift | 8 |
| Advanced | derevAmt, derevDecay, harmRecov, harmOrder, stereoWidth, phaseCorr | 6 |
| Separation | voiceIso, bgSuppress, voiceFocusLo, voiceFocusHi, crosstalkCancel | 5 |
| Output | outGain, dryWet, ditherAmt, outWidth | 4 |
| **Total** | | **52** |

---

## ML model stack

| Model | Role | Latency | Mode |
|---|---|---|---|
| Demucs v4.1 | Voice/music source separation | ~800 ms | Offline |
| BS-RoFormer | Speech enhancement mask | ~300 ms | Offline |
| ECAPA-TDNN | Speaker verification / voiceprint | ~50 ms | Offline |
| Silero VAD | Voice activity detection | ~5 ms | Live + Offline |
| HiFi-GAN | Waveform vocoder / reconstruction | ~200 ms | Offline |
| Conformer-S | Noise-robust feature extraction | ~100 ms | Offline |

All models execute locally via `onnxruntime-web`. WebGPU execution provider is preferred; WASM is the fallback. No cloud inference.

---

## Deployment

- Platform: Vercel. `outputDirectory: "public"`. COOP/COEP headers applied globally.
- Worklet route `/app/voice-isolate-processor.js` has explicit `Content-Type: application/javascript`, `Cache-Control: no-cache`, and re-asserted COOP/COEP headers.
- CI gate: `smoke-test` job blocks `deploy-preview` and `deploy-production`.
- Smoke test baseline: `runMs: 331`, `nanCount: 0`, `peak: 0.891`, `rms: 0.0198`, partial CoV < 8%.
- Test suite: 52 suites / 1,834 unit tests — all passing.

---

## Known limitations

- **Android:** SharedArrayBuffer in Android WebView requires COOP/COEP header injection via AndroidManifest — not yet configured. Release signing, bundled model routing, `RECORD_AUDIO` permission, and WASM-only mobile fallback are all unresolved.
- **iOS:** iOS 15 AudioWorklet constraints may limit live mode.
- **Large files:** Memory spikes on very large audio files not yet addressed.
- **Demucs on speech-heavy music:** May confuse speech with drum content.

---

## Roadmap

- Advanced metering, batch CLI, multitrack editing, Conformer-S full integration, higher offline throughput
- Android native packaging (after SAB/WebView + signing blockers resolved)
- Enterprise licensing, VST3/AU plugin format, Kubernetes deploy
- White-label and source licensing options

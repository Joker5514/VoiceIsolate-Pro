# VoiceIsolate Pro — Unified Architecture Summary v26

**Date:** 2026-07-16  
**Status:** Authoritative synthesis of GitHub code + Master Blueprint v2.1 + CLAUDE.md + audits  
**Supersedes gaps between:** redesign proposals (Google Drive inputs archived in blueprint), live-SAB experiments, and Stem-Split & Live-Mix shipping architecture  

---

## 1. Executive model

VoiceIsolate Pro is a **100% local**, browser-first voice isolation platform.

| Principle | Rule |
|-----------|------|
| Privacy | No audio or derivatives leave the device. Network only for same-origin `.onnx` / static assets. |
| Separation before mix | Offline ML produces stems; real-time UI only mixes/EQ. |
| Single STFT / single iSTFT | Exactly one forward + one inverse transform **per processing path** (no repeated phase damage). |
| Dual execution modes | **Creator/Forensic** (offline OfflineAudioContext / workers) vs **Live-Mix** (real-time AudioParams + playback worklets). |
| No live microphone | Upload-only. Permissions-Policy denies `microphone=()`. |

---

## 2. Current architecture (code reality)

### 2.1 Two-phase pipeline (shipping)

```
PHASE 1 — OFFLINE (once per file)
  File → FileIngestion (decode/resample 48 kHz)
       → MLWorker (ONNX WebGPU→WASM, SHA-256, IndexedDB)
       → clean + noise stems (Float32Array[])

PHASE 2 — LIVE-MIX (continuous, zero ML)
  stems → PlaybackMixer (Gain / EQ / compressor / gate / de-esser)
       → sliders touch AudioParams only (rAF-coalesced)
```

| Surface | Entry | Ingestion | Isolation | Playback |
|---------|-------|-----------|-----------|----------|
| Landing `/` | `landing.js` | `FileIngestion` | `MLWorker` process | `PlaybackMixer` + `SliderUI` |
| Engineer `/app/` | `app.js` | `decodeBlobToAudioBuffer` | `StemSeparation` + DSP fallback | `EngineerModeBridge` → `PlaybackMixer` |
| Desktop | Electron | native open + same web path | same | same |
| Android | Capacitor WebView | same web path + mobile-upload-fix | same | same |

### 2.2 Layer map (`src/`)

| Layer | Path | Role |
|-------|------|------|
| 4 Presentation | `src/presentation/` | DOM, sliders, worklet pills, upload wiring |
| 3 Pipeline | `src/pipeline/` | Ingestion, stem sep, mixer, export, timing |
| 2 Workers | `src/workers/` | MLWorker, diarization, spectral cleanup, gate/de-esser AudioWorklets |
| 1 Core | `src/core/` | Manifest, ring constants, pure DSP math |

Legacy shell: `public/app/*` (Engineer UI, dsp-core, visuals) bridges into `src/` via ES imports.

### 2.3 Active AudioWorklets

| Processor | File | Role |
|-----------|------|------|
| `vip-gate` | `src/workers/GateProcessor.js` | Playback noise gate |
| `vip-deesser` | `src/workers/DeEsserProcessor.js` | Playback de-esser |
| `dsp-processor` | `public/app/dsp-processor.js` | **Legacy-shipped** STFT/SAB path — not loaded for mic; retained for packaging/research |

### 2.4 ONNX Runtime Web

- Vendored: `public/lib/ort.min.js` + WASM SIMD threaded artifacts.
- Worker: `src/workers/MLWorker.js` — WebGPU primary, WASM fallback.
- Models: `src/core/ModelManifest.js` (hash-pinned); default chain `bsrnn_vocals`.
- Inference **never** inside AudioWorklet `process()`.

### 2.5 Single-pass spectral (Creator path)

Engineer offline fallback (`app.js` `_spectralStageAsync`):

1. One `DSP.forwardSTFT`
2. In-place magnitude ops (NR, voice focus, WhisperHunter, extreme path)
3. One `DSP.inverseSTFT`

ML spectral-mask models run STFT→mask→iSTFT **inside MLWorker** as their own single-pass path on transferred PCM.

---

## 3. Target architecture (blueprint v2.1 + research)

| Capability | Target | Status |
|------------|--------|--------|
| Offline stem split + live mix | Product default | ✅ Shipping |
| WebGPU-first ORT + WASM fallback | Required | ✅ Shipping |
| Playback gate/de-esser worklets | Real-time quality | ✅ Shipping |
| Ring-buffer constants (HOP % 128 == 0) | Blueprint §III | ✅ Codified in `ring-buffer-constants.js` |
| Live monitoring spectral SAB path | Optional advanced | 🟡 Processor shipped; **not** wired to mic (forbidden) |
| Creator multi-model chains | Demucs / BSRNN / RNNoise | ✅ User-selectable |
| Research mode (config + I/O export) | Academic readiness | 🆕 v26 modules |
| Benchmark harness | Latency metrics | 🆕 v26 modules |
| Typed parameter schema (67 sliders) | UX + papers | 🆕 v26 modules |
| Consumer simplified mode | Landing surface | ✅ Landing; schema-documented |

**Live mode latency target (blueprint):** <80–100 ms end-to-end for monitoring paths — met for Live-Mix (AudioParam only). Spectral SAB live path remains research/optional and **must not** reintroduce `getUserMedia`.

---

## 4. Critical gaps (prioritized)

| # | Gap | Severity | Mitigation in v26 |
|---|-----|----------|-------------------|
| G1 | Engineer UI still large legacy `app.js` | Medium | Bridge + typed schema; incremental migration |
| G2 | `dsp-processor` not product-wired | Low | Document as research/packaged legacy |
| G3 | No first-class research export | High for academia | `ResearchSession` + UI panel |
| G4 | Provider/model status not always visible | Medium | `OrtStatus` + UI hooks |
| G5 | Benchmarks informal (`PipelineTiming`) | Medium | `BenchmarkHarness` |
| G6 | Live spectral path vs CLAUDE mic ban | Policy | Keep offline-only; no mic |

---

## 5. Execution mode contracts

### Creator / Forensic (offline)

- Decode full file → optional ML → optional single-pass DSP → stems or processed buffer.
- FFT 2048–4096; forensic may use higher resolution; multi-pass **analysis** allowed only when it does not re-STFT the same path (ML once; forensic Whisper refines time-domain / single spectral stage).

### Live-Mix (real-time)

- No ML. Sliders → `PlaybackMixer` AudioParams + gate/de-esser worklets.
- Latency ≈ audio hardware + quantum (sub-10 ms parameter response).

### Research

- Log full config (models, FFT, hops, presets, provider).
- Export JSON session + optional WAV pair + stage timings.
- Deterministic flags where applicable (no stochastic RNG in DSP core).

---

## 6. Multiplicative mask equation (blueprint)

\[
X_{out}(t,f) = X(t,f)\cdot\max(M_{hum}M_{noise}M_{speech}M_{speaker}M_{dereverb}M_{res},\,M_{floor})
\]

Typical \(M_{floor} = -30\,\mathrm{dB}\) (`MASK_FLOOR_DB` in core).

---

## 7. Security & privacy surface

- COOP/COEP for cross-origin isolation / SAB readiness.
- CSP: no CDN scripts; ORT local only.
- Auth/paywall may contact APIs for **license display only** — never for audio.
- Firebase exception documented in `docs/adr/001-firebase-exception.md` (auth state only).

---

## 8. Implementation map (v26 deliverables)

| Deliverable | Path |
|-------------|------|
| This document | `docs/architecture/VoiceIsolate_Pro_Architecture_v26.md` |
| Technical whitepaper | `docs/architecture/VoiceIsolate_Pro_Technical_Whitepaper.md` |
| Parameter schema | `src/core/ParameterSchema.js` |
| Research session | `src/core/ResearchSession.js` |
| Benchmark harness | `src/pipeline/BenchmarkHarness.js` |
| ORT status helper | `src/core/OrtStatus.js` |
| Research UI | `public/app/research-mode.js` |
| Engine cockpit pills | `public/app/vip-boot.js` (CTX/WORKLET/GATE/DEESS/SAB/ML/ORT/NET) |
| Playback worklet load | `src/pipeline/PlaybackMixer.js` (`ensureWorkletModule`) |

### 8.1 Cockpit pill contracts

| Pill | Ready means |
|------|-------------|
| **CTX** | `AudioContext` created (after user gesture) |
| **WORKLET** | Gate + de-esser modules settled (loaded or bypassed) |
| **GATE** | `vip-gate` node spliced (or bypassed) |
| **DEESS** | `vip-deesser` node spliced (or bypassed) |
| **SAB** | `SharedArrayBuffer` + cross-origin isolation |
| **ML** | ONNX Runtime present for local worker inference |
| **ORT** | Worker reported WebGPU or WASM provider |
| **NET** | `navigator.onLine` (models still local; net only for asset host) |

---

## 9. Non-goals (explicit)

- Cloud inference or telemetry of audio.
- Restoring live-microphone ingestion.
- Reintroducing deleted `pipeline-orchestrator.js` live-mic monolith.
- Multiple STFT/iSTFT cycles on the same signal path for “more quality”.

---

*End of Architecture v26.*

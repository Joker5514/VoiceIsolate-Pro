# VoiceIsolate Pro — Legacy Architecture & Build History

> **Status:** Production (v24.0) — Threads from Space v12 — Deca-Pass DSP Pipeline  
> **Author:** Randy Jordan · Conqueror Studios  
> **Last Updated:** July 2026  
> **Repo:** [Joker5514/VoiceIsolate-Pro](https://github.com/Joker5514/VoiceIsolate-Pro)

---

## What This File Is

This is the canonical historical record of VoiceIsolate Pro's architecture, design decisions, PR history, bug fixes, and the evolution from v5 → v14 → v24. It serves as an onboarding reference for future agents (Claude, Copilot, Gemini, etc.) and a permanent audit trail for Randy Jordan / Conqueror Studios.

---

## Architecture Overview — Threads from Space v12

VoiceIsolate Pro is a **100% browser-native, zero-cloud** audio processing platform. All ML inference and DSP runs locally in the browser using Web Audio API, ONNX Runtime Web, and WebAssembly. No audio data ever leaves the user's device.

### Three-Tier Concurrency Model

```
┌─────────────────────────────────────────────────────────┐
│  AUDIO WORKLET THREAD  (real-time, <10ms)               │
│  voice-isolate-processor.js                             │
│  · Biquad EQ, gates, limiters                           │
│  · Single-pass STFT (Hann, 4096pt, 50% overlap)         │
│  · Reads VAD decision from ML Worker via SAB            │
│  · Writes spectral frames to SharedArrayBuffer          │
├─────────────────────────────────────────────────────────┤
│  DSP WORKER POOL  (4 parallel Workers, offline only)    │
│  dsp-core.js / dsp-worker.js                            │
│  · STFT → 36-stage spectral ops → iSTFT                 │
│  · Wiener, spectral subtraction, EQ, dynamics           │
│  · 4× speedup via parallel frame processing             │
├─────────────────────────────────────────────────────────┤
│  ML WORKER  (ONNX Runtime, WebGPU → WASM fallback)      │
│  ml-worker.js                                           │
│  · Demucs v4.1 · BS-RoFormer · ECAPA-TDNN              │
│  · Silero VAD · HiFi-GAN                                │
│  · Communicates via SharedArrayBuffer + Atomics.wait    │
└─────────────────────────────────────────────────────────┘
         ↑↓ SharedArrayBuffer Ring Buffer (48 KB)
         ↑↓ postMessage (control plane only)
```

### Single-Pass STFT Constraint (Canonical Rule)

> **Exactly ONE forward FFT → all spectral operations in-place → exactly ONE inverse FFT.**

This prevents phase drift, echo artifacts, transient smearing, and cumulative saturation. Every spectral operation (EQ bins, Wiener filter, spectral subtraction, noise gate) is applied as a multiplicative mask in frequency-domain between the single forward and inverse STFT. This is the single most important architectural invariant of the entire codebase — never add a second STFT/iSTFT cycle.

### SharedArrayBuffer Security (COOP/COEP)

`vercel.json` enforces:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

These headers activate `crossOriginIsolated: true` in the browser, which is required for `SharedArrayBuffer` and `Atomics` to work. Both `app/dsp-processor.js` and `app/voice-isolate-processor.js` have explicit no-cache + Content-Type rules in `vercel.json`.

---

## 36-Stage Deca-Pass Pipeline

| Stage | Name | Description |
|---|---|---|
| 1 | Input Decode | WAV, MP3, OGG, M4A, video streams |
| 2 | Channel Analysis | Mono / stereo / surround |
| 3 | DC Offset Removal | Single-pass HPF @ 0.5 Hz, order 2 |
| 4 | Peak Normalization | −3 dBFS headroom |
| 5 | Noise Floor Profiling | Median of first 500ms + silent sections |
| 6 | Spectral Fingerprint | PSD per band |
| 7 | Voice Activity Detection | Silero VAD, 30ms frame |
| 8 | High-Pass Filter | Butterworth, user-tuned, Q=0.707 |
| 9 | Low-Pass Filter | Butterworth, user-tuned, Q=0.707 |
| 10 | Voice Band Isolation | Tunable 120–6000 Hz focus window |
| **11** | **Single-Pass FFT** | **STFT, Hann window, 50% overlap, 2048pt** |
| 12 | Spectral Subtraction | SNR-aware, adaptive α |
| 13 | Adaptive Noise Gate | Per-frequency-bin |
| 14 | Wiener Filter | Bayesian posterior, MMSE |
| 15–24 | 9-Band EQ | Sub/Bass/Warmth/Body/Low-Mid/Mid/Presence/Clarity/Air/Brilliance |
| 25 | De-Essing | 7 kHz, dynamic, 100% depth |
| 26 | Spectral Tilt | −6 to +6 dB/octave |
| 27 | Demucs v4.1 | Offline only — voice/music/drums separation |
| 28 | BS-RoFormer | Offline only — speech restoration |
| 29 | HiFi-GAN | Offline only — vocoder reconstruction |
| 30 | Dereverberation | Spectral tail subtraction, 0.3–3.0s decay |
| 31 | Harmonic Reconstruction | Soft saturation, 2nd–8th harmonics |
| 32 | Dynamics Compression | Tunable ratio/knee/attack/release |
| 33 | Brickwall Limiter | −1 dBFS ceiling, 10ms release |
| 34 | Dry/Wet Blend | 0–100% processed |
| **35** | **Single-Pass iFFT** | **Inverse STFT, overlap-add reconstruction** |
| 36 | Final Export | Gain, dither, bit-depth reduction |

---

## File Inventory (public/app — canonical)

| File | Size | Role |
|---|---|---|
| `voice-isolate-processor.js` | 20.1 KB | Live AudioWorkletProcessor — STFT, SAB bridge, ring buffer |
| `dsp-processor.js` | 28.9 KB | Creator/Forensic mode offline processor |
| `dsp-worker.js` | 6.5 KB | DSP worker thread |
| `ml-worker.js` | 35.2 KB | ONNX inference worker (WebGPU → WASM) |
| `dsp-core.js` | 63.5 KB | Single-pass STFT spectral library |
| `pipeline-orchestrator.js` | 32.8 KB | Main pipeline orchestration |
| `pipeline-state.js` | 19.2 KB | Pipeline state management |
| `ring-buffer.js` | 3.4 KB | Ring buffer utility |
| `app.js` | 154 KB | Main thread orchestration, 52-slider wiring |
| `index.html` | 40.7 KB | Engineer Mode v19 UI |
| `style.css` | 35.1 KB | Dark theme |
| `visuals.js` | 19.3 KB | 3D spectrogram, meters |

---

## ML Models

| Model | Role | Latency | License |
|---|---|---|---|
| Demucs v4.1 (Meta) | Voice/music/drums separation | ~800ms | Apache 2.0 |
| BS-RoFormer | Speech enhancement / spectral masking | ~300ms | MIT |
| ECAPA-TDNN | Speaker verification / voiceprint | ~50ms | Apache 2.0 |
| Silero VAD | Voice activity detection | ~5ms | CC-BY-NC 4.0 ⚠️ |
| HiFi-GAN (Meta) | Waveform vocoder synthesis | ~200ms | MIT |

> ⚠️ **Silero VAD** is CC-BY-NC 4.0 — non-commercial only. For Creator Pro / Studio tiers in production, replace with a commercial-licensed ONNX VAD model or custom fine-tune. Forensic tier uses Silero under fair-use research exemption.

Models are served from `public/app/models/` — never from a CDN or external server.

---

## PR History & Merged Fixes

### Phase 1 — Initial Build (Feb–Mar 2026)
Multi-AI collaboration: Claude (DSP core), Gemini (ML workers), Grok (nodes/UI). Initial 3-file prototype → Engineer Mode v14 with 26-stage simulated pipeline and 40+ sliders.

### Phase 2 — Production Architecture (Apr 2026)
| PR | What It Fixed | Status |
|---|---|---|
| #322 | `app-init.js` boot wiring, SABs, worklet, worker, 52 sliders | ✅ Merged |
| #424 | Removed dead code — analytics.js, server stubs, write-only voiceprint state in ml-worker | ✅ Merged |
| #425 | Fixed Speaker Isolation card sliders — bindings were never attached (silent no-ops) | ✅ Merged |
| #426 | Fixed garbled audio in offline pipeline — 7 root causes: brick-wall masks, double Wiener stacking, runaway dereverb, shimmer from `harmonicEnhanceV2` | ✅ Merged |
| #427 | Jules formatting cleanup — readable utility functions, CONSTANTS object in app.js, zero functional changes | ✅ Merged |
| #428 | Live worklet ring buffer bugs — 3 critical pointer fixes + regression tests | ✅ Merged |
| #429 | Playwright live smoke test — CI gate now blocks deploys if end-to-end pipeline fails | ✅ Merged |

### Bug Detail — PR #428 (Critical Live Mode Fixes)

**Bug 1 — `process()` loop condition broken (silence/stutter):**
```js
// BROKEN — mixed outputHead/outputTail comparison
while (this.inputHead - (this.outputHead > 0 ? 0 : this.outputTail) >= this.HOPSIZE)

// FIXED — dedicated inputProcessed counter
this.inputProcessed = 0; // constructor
while (this.inputHead - this.inputProcessed >= this.HOPSIZE) {
  // ...STFT frame...
  this.inputProcessed += this.HOPSIZE;
}
```

**Bug 3 — drain read index off by 896 samples:**
```js
// BROKEN — tied to outputTail which advances by HOPSIZE (1024), not RENDER (128)
const idx = (this.outputTail - RENDER + i + oLen) % oLen;

// FIXED — dedicated drainHead pointer
this.drainHead = 0; // constructor
const idx = (this.drainHead + i) % oLen;
this.drainHead = (this.drainHead + RENDER) % oLen;
```

**Issue 5 — `hopsSinceInit` guard stalls ring:**
```js
// FIXED — advance drainHead even during muted init window
if (this.hopsSinceInit * this.HOPSIZE < this.FFTSIZE) {
  outBuf.fill(0);
  this.drainHead = (this.drainHead + RENDER) % oLen; // still advance
  return true;
}
```

---

## Authentication System

Client-side only, SHA-256 hashed via Web Crypto. Sessions in `sessionStorage` (not localStorage). Zero network calls.

| Username | Tier | Role |
|---|---|---|
| `joker5514` | ENTERPRISE | admin |
| `testfree` | FREE | user |
| `testpro` | PRO | user |
| `teststudio` | STUDIO | user |
| `testent` | ENTERPRISE | user |

### Tier Feature Caps

| Feature | FREE | PRO | STUDIO | ENTERPRISE |
|---|---|---|---|---|
| Pipeline stages | 8 | 14 | 18 | 18 |
| Max file size | 50 MB | 500 MB | 2 GB | Unlimited |
| Monthly file limit | 3 | 50 | Unlimited | Unlimited |
| Batch limit | 1 | 5 | 50 | 1,000 |
| Engineer panel | ❌ | ✅ | ✅ | ✅ |
| Live mode | ❌ | ✅ | ✅ | ✅ |
| Forensic mode | ❌ | ❌ | ❌ | ✅ |
| Voiceprint | ❌ | ✅ | ✅ | ✅ |
| API access | ❌ | ❌ | ✅ | ✅ |
| Audit log | ❌ | ❌ | ❌ | ✅ |
| Slider count | 12 | 36 | 52 | 52 |

---

## CI / Deployment

- **Platform:** Vercel with GitHub integration — push to `main` auto-deploys
- **CI Gates (deploy.yml):** ESLint → Semgrep → njsscan → `pnpm test` (1,834 unit tests) → `pnpm test:live` (Playwright headless Chromium smoke test)
- **Live smoke test assertions:** zero NaN/Inf samples · peak in [0, 1.001] · RMS > 0.01 · per-partial CoV < 60% (garble detector)
- **Last passing smoke test result:** `runMs: 331` · `nanCount: 0` · `peak: 0.891` · `rms: 0.0198` · max CoV 7.4%

---

## Known Limitations & Open Items (as of July 2026)

| Issue | Impact | Status |
|---|---|---|
| Silero VAD latency 100ms in edge cases | Real-time edge | Open — fix in v1.0 with faster model |
| HiFi-GAN occasional crackling (0.1% frames) | Rare artifact | Open — overlap smoothing fix planned |
| Demucs confused on speech-heavy music | Vocal/drums bleed | Open — retrain with speech-music mixed dataset |
| iOS 15 AudioWorklet support | No live mode on old iOS | Open — graceful fallback |
| Memory spikes on >1 GB files | OOM on low-RAM devices | Open — streaming decoder |
| Android: SAB + COOP/COEP in Capacitor WebView | Breaks live mode on Android | Blocker for Play Store — custom WebView config needed |
| Android: No signed release APK/AAB | Can't submit to Play Store | Blocked pending keystore + signing workflow |
| WebGPU on Android | Not yet supported in Android System WebView | WASM-only fallback needed for mobile |

---

## Version Evolution

| Version | Codename | Key Milestone |
|---|---|---|
| v5 | — | Initial WASM prototype, basic spectral subtraction |
| v10 | — | Aggressive noise reduction blueprint |
| v13 | — | Full DSP pipeline spec, ECAPA-TDNN integration spec |
| v14 | — | Engineer Mode v14 — 26-stage simulated pipeline, 40+ sliders, Web Audio API demo |
| v19 | — | Engineer Mode v19 — 52 sliders, 3D spectrogram canvas |
| v24 | Deca-Pass | 36-stage production pipeline, Threads from Space v12, PR #428 live mode fully fixed, CI smoke test gated |

---

## Roadmap

| Phase | Target | Scope |
|---|---|---|
| v1.0 | Q3 2026 | Real-time AudioWorklet live mode, batch CLI, advanced metering, WebGPU FFT |
| Pro Edition | Q4 2026 | VST3/AU plugin, REST API, Kubernetes, white-label licensing |
| v1.1 | Q1 2027 | Custom model fine-tuning, multi-speaker diarization UI, Android PWA fix |

---

## Agent Onboarding Notes

If you are an AI agent (Claude, Copilot, Gemini, etc.) reading this file:

1. **The canonical app files are under `public/app/`** — never edit root-level copies (they are dead and not served by Vercel)
2. **Never add a second STFT/iSTFT cycle** — single-pass constraint is absolute
3. **All ML inference is local** — never add `fetch()` calls to external model servers
4. **COOP/COEP headers are required** — touch `vercel.json` headers section only with extreme care
5. **Run `pnpm test && pnpm test:live` before any PR** — the Playwright smoke test is the quality gate
6. **SharedArrayBuffer layout** — `inputCtrl[0-3]` = Int32 control flags, `inputData` starts at byte offset 16
7. **Ring buffer arithmetic** — `drainHead` advances by `RENDER` (128) each quantum; `inputProcessed` advances by `HOPSIZE` (1024) each STFT hop. These are separate pointers — never conflate them.

---

*This file is maintained by Randy Jordan / Conqueror Studios. Update after each significant PR batch or architectural change.*

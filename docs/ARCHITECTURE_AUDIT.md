# VoiceIsolate Pro v24.0 — Architecture Audit

**Date:** 2026-06-03  
**Auditor:** Automated (Claude Code)  
**Branch:** `claude/voiceisolate-pro-modernization-h00XA`

---

## 1. Component Graph

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          BROWSER MAIN THREAD                            │
│                                                                         │
│  ┌──────────┐   ┌──────────────────┐   ┌────────────────────────────┐  │
│  │ vip-boot │──►│ VoiceIsolatePro  │◄──│ PipelineOrchestrator       │  │
│  │  .js     │   │ (app.js)         │   │ (pipeline-orchestrator.js) │  │
│  └──────────┘   │                  │   │                            │  │
│                 │ SLIDERS (52)      │   │ ▸ owns AudioWorklet init   │  │
│                 │ PRESETS (8)       │   │ ▸ owns ML Worker spawn     │  │
│                 │ runPipeline()     │   │ ▸ SAB ring allocation      │  │
│                 │ play/stop/seek    │   │ ▸ slider→worklet routing   │  │
│                 └────────┬─────────┘   └──────────┬─────────────────┘  │
│                          │                         │                    │
│  ┌───────────────────────▼──────────────────┐     │                    │
│  │ PipelineState (pipeline-state.js)         │     │                    │
│  │ ▸ 52-param pub/sub event bus              │     │                    │
│  │ ▸ undo/redo history                       │     │                    │
│  │ ▸ batch update mode                       │     │                    │
│  └───────────────────────────────────────────┘     │                    │
│                                                     │ AudioContext       │
└─────────────────────────────────────────────────────┼────────────────────┘
                                                      │
               ┌──────────────────────────────────────▼──────────────────┐
               │                 WEB AUDIO GRAPH                         │
               │                                                         │
               │  MediaStreamSource / BufferSource                       │
               │          │                                              │
               │          ▼                                              │
               │  ┌─────────────────┐    SharedArrayBuffer               │
               │  │ dsp-processor   │◄─────────────────────────────┐    │
               │  │ AudioWorklet    │  inputSAB (mag+pha+pcm)       │    │
               │  │                 │─────────────────────────────►│    │
               │  │ FFT→spectral→   │  outputSAB (mask)             │    │
               │  │ iFFT + OLA      │                               │    │
               │  └────────┬────────┘                               │    │
               │           │                                        │    │
               │     GainNode → AnalyserNode → Destination          │    │
               └───────────────────────────────────────────────────────┘
                                                                    │
                                                              ┌─────▼──────┐
                                                              │ ml-worker  │
                                                              │ (ONNX RT)  │
                                                              │            │
                                                              │ VAD        │
                                                              │ RNNoise    │
                                                              │ BSRNN      │
                                                              │ Demucs v4  │
                                                              └────────────┘
```

---

## 2. Dependency Graph

```
app.js
  └── slider-map.js         (STAGES×32, SLIDER_REGISTRY×52 — pure data)
  └── model-status-ui.js    (download progress overlay)

pipeline-orchestrator.js   (classic script, no imports)
  └── [loads] dsp-processor.js    → AudioWorklet (addModule)
  └── [spawns] ml-worker.js       → Web Worker
  └── [uses] ring-buffer.js       → SharedRingBuffer class (window global)
  └── [uses] isolation-controls.js → speaker card UI

dsp-processor.js            (AudioWorklet — no imports, self-contained)
  └── Inline Cooley-Tukey FFT
  └── Periodic Hann window

ml-worker.js                (classic Worker — uses importScripts)
  └── importScripts('/lib/ort.min.js')   on demand
  └── importScripts('./ring-buffer.js')  SAB consumer

dsp-core.js                 (pure DSP math, no DOM)
  ├── AdaptiveNoiseFloor
  ├── forwardSTFT / inverseSTFT
  ├── wienerFilter / wienerMMSE
  ├── spectralGate
  └── [imported by] dsp-worker.js

dsp-worker.js               (classic Worker)
  └── importScripts('./dsp-core.js')

offline-processor.js        (self-contained offline path)
  └── Inline FFT/iFFT (follows single-STFT rule)

fft-bridge.js               (Creator / Forensic mode STFT bridge)
  └── [uses] dsp-core.js functions

model-cdn-loader.js ← model-loader.js ← ml-worker.js
  └── Vercel Blob CDN + local file fallback

sw-register.js              (registers /sw.js, scope /)
sw.js (public root)         (minimal stub: skipWaiting + claim)
public/app/sw.js            (full: COOP/COEP injection + model cache)
```

---

## 3. Startup Sequence

```
1. Browser loads public/app/index.html
2. <script> vip-boot.js evaluates (classic, synchronous)
   a. runDiagnostics() — checks SAB, AudioContext, Worklet
   b. If fatal: show banner, halt
3. <script type="module"> app.js evaluates
   a. Imports slider-map.js (synchronous)
   b. Defines VoiceIsolatePro class
   c. window.VoiceIsolatePro = VoiceIsolatePro
   d. Auto-bootstrap: new VoiceIsolatePro(); app.init()
      - cacheDom()
      - _renderSliders() — creates 52 slider DOM nodes
      - bindEvents()
      - initBootSplash() — animated progress bar
      - initModelStatusPanel()
      - Registers one-shot 'click'/'keydown' for ensureCtx()
4. <script> pipeline-orchestrator.js evaluates (classic)
   a. Defines PipelineOrchestrator class
   b. Auto-bootstrap: new PipelineOrchestrator()
   c. window._vipOrch = orchestrator
   d. Pre-warms ML Worker immediately (no gesture needed)
      - new Worker('/app/ml-worker.js')
      - ml-worker: importScripts('/lib/ort.min.js')
      - ml-worker: load VAD + RNNoise ONNX sessions
5. User gesture (click/keydown)
   a. ensureCtx() → new AudioContext()
   b. orch.init() → _doInit()
      - _createAudioContext()
      - _loadWorklet() → audioWorklet.addModule('/app/dsp-processor.js')
      - _allocateRings() → SharedRingBuffer(inputSAB), SharedRingBuffer(maskSAB)
      - _initMLWorker() → (already running, returns cached promise)
      - _bindSliders()
   c. SABs forwarded to both worklet and ML worker
6. File loaded / mic started
   a. handleFile() → ctx.decodeAudioData()
   b. onAudioLoaded() → renderStaticVisuals()
7. runPipeline()
   a. 32-stage Deca-Pass (S01–S32)
   b. S10: forwardSTFT; S11–S19: spectral ops; S20: inverseSTFT
   c. SHA-256 forensic hash at S32
```

---

## 4. Worker Lifecycle

### ML Worker

| Event | Handler |
|-------|---------|
| Created | `PipelineOrchestrator._doInitMLWorker()` |
| `onmessage: ready` | `mlReady=true`, share with `window._vipApp` |
| `onmessage: log` | Forward to `console[level]` |
| `onmessage: diarization` | Update app diarization state |
| `onerror` | Auto-restart (max 3 attempts, exponential backoff 1s/2s/4s) |
| Watchdog | `setInterval` every 2s: detect stalled pending requests |
| Terminate | Not implemented (browser unload = implicit terminate) |

### DSP Worker (offline)

| Event | Handler |
|-------|---------|
| `process` | Run STFT → spectral ops → iSTFT; transfer buffer back |
| `loadModel` | Load ONNX session with 30s timeout |
| `reset` | Clear per-file state |

### AudioWorklet (dsp-processor)

| Event | Handler |
|-------|---------|
| Registered | `pipeline-orchestrator.js` only |
| `initRings` message | Attach SharedArrayBuffer views |
| `process()` | 128-sample quanta → ring buffer → FFT → mask apply → OLA |
| `ready` ack | Sets `orchestrator.workletReady = true` |

---

## 5. DSP Lifecycle

```
Input PCM (AudioBuffer)
  │
  ▼
[S01–S04] Input decode, DC offset removal, peak normalization
  │
  ▼
[S05–S09] VAD gate, noise gate, click removal, hum removal, de-essing
  │
  ▼
[S10] forwardSTFT — Blackman-Harris window, 4096-pt FFT, hop=1024
  │     Returns { mag: Float32Array[2049], phase: Float32Array[2049] }
  │
  ▼
[S11–S12] Wiener NR — adaptive noise floor tracking (Martin 2001)
            MMSE Wiener + residual pass
  │
  ▼
[S13–S19] ERB spectral gate, voice-band emphasis, crosstalk cancel,
            temporal smoothing, spectral tilt, dereverb, harmonic recovery
  │
  ▼
[S20] inverseSTFT — Hann synthesis window, overlap-add (75% overlap)
  │
  ▼
[S21–S25] OfflineAudioContext: HP/LP biquads, 10-band EQ, compression, limiter
  │
  ▼
[S26–S28] Render, cleanup, dry/wet mix
  │
  ▼
[S29–S31] Peak normalization, quality metrics, waveform update
  │
  ▼
[S32] Export ready — SHA-256 forensic hash → forensicLog
```

---

## 6. State Ownership Map

| State | Owner | Consumers |
|-------|-------|-----------|
| SLIDERS (52 defs) | `app.js` const | tests, validate.js, SLIDER_REGISTRY |
| STAGES (32 labels) | `slider-map.js` | app.js, pipeline-orchestrator.js, tests |
| SLIDER_REGISTRY | `slider-map.js` | app.js (worklet dispatch) |
| PRESETS (8) | `app.js` const | applyPreset(), tests |
| `window.VIP_PARAMS` | `app.js` | worklet (via SharedArrayBuffer), sliders |
| `window._vipApp` | `vip-boot.js` | all modules |
| `window._vipOrch` | `pipeline-orchestrator.js` | app.js, visuals.js |
| AudioContext | `pipeline-orchestrator.js` | app.js (shared back) |
| AudioWorkletNode | `pipeline-orchestrator.js` | exclusive |
| ML Worker | `pipeline-orchestrator.js` | exclusive |
| SharedArrayBuffer rings | `pipeline-orchestrator.js` | worklet + ml-worker |
| inputBuffer/origBuffer | `app.js` | runPipeline(), play(), visuals |
| forensicLog | `app.js` | addAuditEntry(), downloadAuditLog() |
| appState (new) | `state-manager.js` | UI components (subscribe-based) |

---

## 7. Known Issues and Risks

| ID | Severity | Issue | Location | Status |
|----|----------|-------|----------|--------|
| A01 | HIGH | COEP was `credentialless` — fails SharedArrayBuffer in some browsers | vercel.json | **FIXED** |
| A02 | MED | Video Object URL not revoked on file clear | app.js:1030 | **FIXED** |
| A03 | MED | `_mlCall` had no timeout — listener leak on stalled worker | app.js | **FIXED** |
| A04 | MED | ML worker crash had no recovery handler | pipeline-orchestrator.js | **FIXED** |
| A05 | MED | paywall.js inline `onclick` bypasses CSP nonce | paywall.js:473 | **FIXED** |
| A06 | LOW | `innerHTML` with model manifest data (XSS via malicious manifest) | ml-worker-fetch-cache.js | **FIXED** |
| A07 | LOW | RAF loops run when tab is hidden (CPU waste) | visuals.js, neon-pulse-visualizer.js | **FIXED** |
| A08 | LOW | SAB constants duplicated across 4 files | app.js, dsp-processor.js, ml-worker.js, ring-buffer.js | MITIGATED (shared-memory-schema.js added) |
| A09 | LOW | app.js is 2067 lines — high cognitive load | app.js | MITIGATED (new modules created) |
| A10 | INFO | `vip-slider-patch.js` not loaded via index.html | index.html | DOCUMENTED |
| A11 | INFO | `ci.yml` uses Node 20 while `deploy.yml` uses Node 24 | .github/workflows/ | NOTED |

---

## 8. Architecture Invariants (CI-Enforced)

| Rule | Enforcement |
|------|-------------|
| Single forward/inverse STFT per path | `scripts/validate.js` + `tests/architectural-invariants.test.js` |
| AudioWorklet owned by `pipeline-orchestrator.js` only | Both |
| ML Worker spawned by `pipeline-orchestrator.js` only | Both |
| ONNX Runtime from `/lib/ort.min.js` (never CDN) | Both |
| No external audio calls | `tests/architectural-invariants.test.js` §5 |
| COOP=`same-origin` + COEP=`require-corp` everywhere | Both |
| Exactly 52 sliders | `scripts/validate.js` + `tests/sliders.test.js` |
| Exactly 32 STAGES | `scripts/validate.js` |

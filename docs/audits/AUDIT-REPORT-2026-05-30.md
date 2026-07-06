# VoiceIsolate-Pro — Comprehensive Production Audit Report
**Date**: May 30, 2026  
**Auditor**: Senior Software Engineer / DSP Engineer / Browser Audio Specialist / QA Lead  
**Repository**: [Joker5514/VoiceIsolate-Pro](https://github.com/Joker5514/VoiceIsolate-Pro)

---

## EXECUTIVE SUMMARY

This audit identified **18 CRITICAL issues** preventing production deployment across Vercel, Android, and iOS platforms. The repository implements a sophisticated "Threads from Space" architecture with AudioWorklet → ML Worker → ONNX runtime, but suffers from:

- **Startup failures**: SAB ring buffer initialization never occurs (worklet receives wrong message type)
- **AudioWorklet failures**: Halfsize mismatch (1025 vs 2049 bins), SAB null references causing passthrough-only mode
- **Worker initialization failures**: Path resolution issues, double-context creation race conditions
- **SharedArrayBuffer failures**: Protocol mismatch between orchestrator and worklet, wrong buffer layouts
- **ONNX runtime failures**: Missing integrity automation, silent fallback degradation
- **Vercel deployment incompatibilities**: Service worker cache gaps, CSP inline scripts
- **Capacitor mobile incompatibilities**: Android WebView nested worker failures, iOS AudioWorklet constraints
- **Race conditions**: Double AudioContext init, ML worker pre-warm vs gesture-init conflicts
- **Memory leaks**: ORT WASM proxy workers not cleaned up, SAB views not released
- **Performance bottlenecks**: Nested Float32Array allocations in hot path, missing SIMD guards

**STATUS**: Repository is NOT production-ready. All critical paths are broken or fragile.

---

## PHASE 1: REPOSITORY MAPPING

### Architecture Overview

```
┌─────────────────────── index.html ───────────────────────┐
│  Dynamic ES Module Loading (import())                     │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 1. dsp-core.js (STFT/iSTFT/Wiener/Spectral)       │  │
│  │ 2. ring-buffer.js (SharedRingBuffer/RingBuffer)   │  │
│  │ 3. visuals.js + premium-visuals.js (Three.js)     │  │
│  │ 4. pipeline-orchestrator.js (PipelineOrchestrator)│  │
│  │ 5. app.js (VoiceIsolatePro class)                 │  │
│  │ 6. vip-boot.js (Bootstrap shim)                   │  │
│  │ 7. vip-fixes.js + vip-enhancements.js             │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘

┌─────────────────── Live Audio Path ─────────────────────┐
│                                                           │
│  MediaStream (mic) ──→ AudioWorkletNode                  │
│         ↓                      ↓                          │
│    sourceNode              dsp-processor.js               │
│         ↓                 (FFT → Spectral)                │
│    workletNode                 ↓                          │
│         ↓              inputSAB (mag+pha)                 │
│    analyserNode                ↓                          │
│         ↓                ml-worker.js                     │
│    gainNode               (ONNX inference)                │
│         ↓                      ↓                          │
│    destination            outputSAB (mask)                │
│                                ↓                          │
│                        worklet applies mask               │
│                                ↓                          │
│                          synthesis (iSTFT)                │
│                                ↓                          │
│                            output ring                    │
└───────────────────────────────────────────────────────────┘

┌────────────────── Offline Audio Path ───────────────────┐
│                                                           │
│  File upload → AudioBuffer                                │
│         ↓                                                 │
│  app.js:runPipeline()                                     │
│         ↓                                                 │
│  pipeline-orchestrator.js:run()                           │
│         ↓                                                 │
│  OfflineAudioContext (Web Audio chain)                    │
│         ↓                                                 │
│  DSPCore.forwardSTFT()  →  spectral ops                   │
│         ↓                                                 │
│  ml-worker (infer/bsrnnComplex)                           │
│         ↓                                                 │
│  DSPCore.inverseSTFT()                                    │
│         ↓                                                 │
│  Final AudioBuffer                                        │
└───────────────────────────────────────────────────────────┘
```

### Dependency Graph

```
app.js
  ├── slider-map.js (SLIDER_REGISTRY, STAGES)
  ├── model-status-ui.js (ModelStatusUI)
  ├── pipeline-orchestrator.js (window._vipOrch)
  └── vip-boot.js (bootstrap shim)

pipeline-orchestrator.js
  ├── ring-buffer.js (SharedRingBuffer, RingBuffer)
  ├── loadDspProcessorWorklet() → dsp-processor.js (AudioWorklet)
  ├── new Worker('/app/ml-worker.js')
  └── ort (loaded by ml-worker via importScripts)

dsp-processor.js (AudioWorkletProcessor)
  ├── fftInPlace() (in-file Cooley-Tukey radix-2)
  ├── makeHannWindow() (periodic form N not N-1)
  └── inputSAB/outputSAB (message port protocol)

ml-worker.js
  ├── /lib/ort.min.js (importScripts)
  ├── inputSAB → magnitudes + pcm
  ├── outputSAB → mask
  └── pollOnce() (50 Hz SAB polling loop)

dsp-core.js
  ├── AdaptiveNoiseFloor (Martin 2001 min-stats)
  ├── forwardSTFT / inverseSTFT (Hann OLA)
  ├── wienerMMSE (spectral subtraction)
  └── spectralGate (32-band ERB)
```

---

## PHASE 2: STARTUP TRACE

### Expected Startup Flow

```
1. index.html loads
2. Dynamic import('./dsp-core.js') → window.DSPCore
3. Dynamic import('./ring-buffer.js') → window.SharedRingBuffer
4. Dynamic import('./pipeline-orchestrator.js') → PipelineOrchestrator class
5. Dynamic import('./app.js') → VoiceIsolatePro class
6. Dynamic import('./vip-boot.js'):
   - new VoiceIsolatePro() → window._vipApp
   - window._vipApp.init()
7. dsp-bootstrap.js:
   - window._vipOrch = new PipelineOrchestrator()
   - _vipOrch._initMLWorker() (pre-warm before gesture)
8. User clicks/types (gesture) → ensureCtx()
9. AudioContext created
10. _vipOrch.init()
    - _createAudioContext()
    - _loadWorklet() → audioWorklet.addModule()
    - _allocateRings() → SharedRingBuffer x2
    - _initMLWorker() → postMessage('init')
11. workletNode created
12. SABs transferred to worklet via port.postMessage
13. SABs transferred to ml-worker
14. pollTimer starts (50 Hz)
15. User starts mic → connectSource()
16. Audio flows
```

### CRITICAL FAILURE POINTS

#### **Issue #1: SAB Ring Initialization Never Occurs (CRITICAL)**

**Location**: `pipeline-orchestrator.js:_allocateRings()` line ~850

**Root Cause**: Message type mismatch between orchestrator and worklet.

**Code**:
```javascript
// pipeline-orchestrator.js
this.workletNode.port.postMessage({
  type: 'initRings',          // ❌ WRONG
  inputRing: this._inputRingSAB,
  maskRing: this._maskRingSAB
});
```

```javascript
// dsp-processor.js
_onMessage(msg) {
  if (!msg) return;
  switch (msg.type) {
    case 'initSAB': {         // ✅ EXPECTS THIS
      this._inputSAB = msg.inputSAB;
      this._outputSAB = msg.outputSAB;
      // ...
    }
    // ❌ NO 'initRings' HANDLER
  }
}
```

**Impact**: Worklet NEVER receives SAB references → `this._inputSAB = null` → `this._inputView = null` → `_processFrame()` skips SAB write → ml-worker polls stale zero flags → no mask ever applied → **audio is DSP passthrough only, no ML inference**.

**Fix**: Change `type: 'initRings'` to `type: 'initSAB'`.

---

#### **Issue #2: Halfsize Mismatch Causes Buffer Overread (CRITICAL)**

**Location**: `pipeline-orchestrator.js:constructor()` line ~180

**Root Cause**: Orchestrator uses `_halfN = 1025` but worklet/ml-worker use `HALF_BINS = 2049`.

**Code**:
```javascript
// pipeline-orchestrator.js
this._halfN = 1025;  // ❌ WRONG (2048/2+1)
// Should be 4096/2+1 = 2049
```

```javascript
// dsp-processor.js
const FFT_SIZE = 4096;
const HALF_BINS = FFT_SIZE / 2 + 1;  // = 2049 ✅
```

**Impact**:
- `inputRing = new SharedRingBuffer(this._halfN, 32)` allocates SAB for `1025 × 32 = 32800 floats`
- `ml-worker` reads `currentHalfN*2 = 4098 floats` from inputView → **buffer overread → undefined data → corrupted magnitude/phase → NaN propagation → silent audio**

**Fix**: Change `this._halfN = 1025` to `this._halfN = 2049` or read from `FFT_SIZE` constant.

---

#### **Issue #3: Double AudioContext Creation Race (HIGH)**

**Location**: `app.js:ensureCtx()` line ~580 + `pipeline-orchestrator.js:_createAudioContext()` line ~450

**Root Cause**: Both modules independently create AudioContext without proper synchronization.

**Sequence**:
1. User clicks file upload button
2. `app.js:handleFile()` calls `ensureCtx()`
3. `app.js` creates `new AudioContext()`
4. `app.js` sets `this._workletReady = true` (WITHOUT loading worklet)
5. Later, user clicks mic button
6. `dsp-bootstrap.js` calls `_vipOrch.init()`
7. `pipeline-orchestrator.js:_createAudioContext()` checks `app.ctx`
8. Found → reuses it → skips `_loadWorklet()` because `_workletModulesLoaded = false`
9. `workletNode = new AudioWorkletNode(ctx, 'dsp-processor')` **throws DOMException** because module never loaded

**Impact**: Mic mode fails with `DOMException: AudioWorkletNode cannot be created: the node name 'dsp-processor' is not defined`.

**Fix**: Implement single-source-of-truth for AudioContext init via orchestrator only. App should proxy `ensureCtx()` to orchestrator.

---


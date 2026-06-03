# VoiceIsolate Pro v24.0 — Memory Audit

**Date:** 2026-06-03  
**Auditor:** Automated (Claude Code)  
**Branch:** `claude/voiceisolate-pro-modernization-h00XA`

---

## Summary

| Category | Issues Found | Fixed | Notes |
|----------|-------------|-------|-------|
| Object URL leaks | 2 | 2 | Video file blobs not revoked |
| Event listener leaks | 1 | 1 | `_mlCall` handler with no timeout |
| Interval leaks | 0 | — | All `setInterval` calls have cleanup |
| RAF leaks | 0 | — | All RAF loops have `cancelAnimationFrame` |
| Worker leaks | 0 | — | No termination needed (page unload) |
| AudioContext leaks | 0 | — | Shared instance, no re-creation |

---

## Detailed Findings

### MEM-01 — Video Object URL not revoked (FIXED)

**File:** `public/app/app.js`  
**Lines:** `handleFile()`, `decodeViaVideoElement()`  

**Before:**
```javascript
// handleFile — video fallback path
this.dom.videoPlayer.src = URL.createObjectURL(file);   // ← never revoked

// decodeViaVideoElement
const url = URL.createObjectURL(file);   // ← never revoked
```

**After:**
- `handleFile`: URL stored in `this._videoObjectURL`; any previous URL is revoked before assigning the new one  
- `_clearFile()`: Revokes `this._videoObjectURL` and sets it to `null`  
- `decodeViaVideoElement`: Revokes URL in success callback, error callback, and timeout callback  

**Impact:** Prevented persistent blob handle accumulation on repeated file loads.

---

### MEM-02 — `_mlCall` event listener leak (FIXED)

**File:** `public/app/app.js`  
**Method:** `_mlCall(payload, transfer = [])`  

**Before:**
```javascript
worker.addEventListener('message', handler);
// handler only removed on response — never on worker crash/timeout
```

**After:**
```javascript
const timer = setTimeout(() => {
  settled = true;
  worker.removeEventListener('message', handler);
  reject(new Error(`_mlCall timeout after ${timeoutMs}ms`));
}, timeoutMs);
// handler removed on both success and timeout
```

**Impact:** Prevents listener accumulation on long-running or stuck sessions.

---

### MEM-03 — RAF loops running in hidden tabs (FIXED)

**Files:** `public/app/visuals.js`, `public/app/neon-pulse-visualizer.js`  

**Before:** RAF loops continued running when the browser tab was hidden, consuming CPU cycles for invisible pixel updates.

**After:** Both visualization loops check `document.hidden` at the top of the loop body and exit early (without re-scheduling RAF) when the tab is hidden. A `visibilitychange` event listener in `visuals.js` resumes the loop when the tab becomes visible again.

**Impact:** Reduces CPU usage by up to 100% for the visualization subsystem when the tab is in the background.

---

## Existing Good Patterns

The following patterns were already implemented correctly:

| Pattern | Location | Notes |
|---------|----------|-------|
| `URL.revokeObjectURL` after 60s | `app.js:downloadWav`, `app.js:downloadAuditLog` | Download URLs cleaned up |
| `clearInterval` on progress | `app.js:initBootSplash` | Boot splash interval always cleared |
| `cancelAnimationFrame` | `visuals.js:stop()`, `neon-pulse-visualizer.js` | RAF loops have explicit stop |
| Worker error handler | `pipeline-orchestrator.js` | `onerror` now added with restart |
| `Blob URL.revokeObjectURL` | `pipeline-orchestrator.js:loadDspProcessorWorklet` | CDN Blob URLs revoked after addModule |
| `try { disconnect() }` | `app.js:teardownChain()` | AudioNodes disconnected on cleanup |
| `removeEventListener` in destroy | `visuals.js:destroy()` | Worklet message listener properly removed |

---

## Memory Pressure Guidelines

### SharedArrayBuffer

The following SABs are allocated **once per session** and persist for the lifetime of the page:

| SAB | Size | Purpose |
|-----|------|---------|
| `inputRing` SAB | ~36 KB | PCM/mag/phase input to ML worker |
| `maskRing` SAB | ~8 KB | Gain mask from ML worker to worklet |
| `sharedParams` SAB | 1 KB | Slider parameter lane |

Total SAB overhead: ~45 KB — negligible.

### ONNX Model Sessions

| Model | Size in Memory | Lifecycle |
|-------|---------------|----------|
| Silero VAD | ~2.2 MB | Loaded at worker init, held for session |
| RNNoise | ~1.8 MB | Loaded at worker init, held for session |
| BSRNN Vocals | ~4.3 MB | Loaded on demand |
| Demucs v4 | ~87 MB | Loaded on demand, WebGPU texture + WASM |

**Warning:** Loading Demucs v4 on mobile devices with <4 GB RAM may cause OOM crashes. The orchestrator intentionally defers Demucs loading until the first explicit separation request (see `allowedModels` filtering in `_doInitMLWorker`).

### AudioBuffer

Processed files are held as `AudioBuffer` objects:
- `this.origBuffer` — original decoded audio
- `this.outputBuffer` / `this.procBuffer` — processed output

For stereo 44.1 kHz audio, a 5-minute file consumes ~26 MB. Two copies (orig + proc) = ~52 MB. Call `_clearFile()` to release.

---

## Recommendations

1. **Add explicit `destroy()` to `VoiceIsolatePro`** — closes AudioContext, clears all buffers, removes document-level listeners added in `bindEvents()`. Currently destruction relies on page unload.
2. **Pool `Float32Array` allocations in hot DSP loops** — `dsp-core.js` allocates per-frame arrays in several spectral operations. Pre-allocate and reuse to reduce GC pressure.
3. **Monitor ONNX memory usage** — WebGPU tensor allocations are not tracked by `performance.memory`. Consider adding model unload when the user hasn't processed audio for >5 minutes on mobile.

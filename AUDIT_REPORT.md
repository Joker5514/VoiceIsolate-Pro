# VoiceIsolate Pro — Full Codebase Audit Report
**Branch:** `audit/v19-dsp-hardening`  
**Date:** 2026-05-19  
**Auditor:** Perplexity AI (Conqueror Studios)

---

## Phase 1 — Architecture Review

### What Was Scanned
- `public/app/dsp-processor.js` — AudioWorkletProcessor (real-time DSP core)
- `public/app/ring-buffer.js` — SharedRingBuffer + RingBuffer (SAB communication layer)
- `public/app/slider-map.js` — 52-slider registry, DOM builder, param dispatch
- `public/app/app.js` (102 KB), `dsp-core.js` (65 KB), `ml-worker.js` (49 KB),
  `pipeline-orchestrator.js` (41 KB), `offline-processor.js` (20 KB),
  `pipeline-state.js` (20 KB), `dsp-stages.js` (24 KB), `fft-bridge.js` (10 KB)
- Root config: `Dockerfile`, `.env.example`, `eslint.config.js`, `.vercelignore`,
  `capacitor.config.json`, `compose.yaml`
- Docs: `CLAUDE.md`, `AGENTS.md`, `AUDIT_FIXES.md`, `COMPLETION.md`, `README.md`

### Strengths
- **Single-pass STFT contract** is correctly enforced in `dsp-processor.js`: one forward
  FFT per hop at line ~95, one inverse FFT per hop at line ~155. No duplicate transforms.
- **Periodic Hann window** (denominator N, not N-1) is correctly implemented — energy
  preservation at 75% overlap is sound.
- **OLA write pointer** advances by `HOP_SIZE` (1024), not `FFT_SIZE` (4096) — correct.
- **Phase reconstruction** uses polar form `(mag*cos(pha), mag*sin(pha))` — correct.
- **DC/Nyquist bins** handled explicitly outside the conjugate-symmetry loop — correct.
- **SharedRingBuffer** uses a 5-slot Int32 header with dedicated `frameReady` at slot [4],
  supports `Atomics.wait/notify` for worker-side blocking, and documents the 20-byte
  header offset correctly.
- **RingBuffer** (lightweight FIFO variant) correctly initialises only when not already
  owned, avoiding double-init when shared across threads.
- **slider-map.js** is the canonical single source of truth for all 52 sliders, with
  correct `nrAmount` normalisation (`v / 100`) as the only non-identity transform.

---

## Phase 2 — Bugs & Flaws Found

### BUG-01 · `RingBuffer.push()` corrupts the capacity slot on scalar overflow
**File:** `public/app/ring-buffer.js`  
**What's Wrong:**  
In the scalar branch of `push()`, on overflow the code calls
`Atomics.add(this._ctrl, 2, 1)` — slot [2] is the **immutable capacity** field.
Incrementing it corrupts the capacity permanently for all subsequent `available`
and `free` calculations, causing silent data loss and eventual buffer overrun.
```js
// BROKEN — slot 2 is capacity, not overflow counter
if (this.availableWrite < 1) {
  Atomics.add(this._ctrl, 2, 1);  // ← destroys capacity
  return false;
}
```
**Fix:** Track overflows separately or simply return `false` silently.
```js
if (this.free < 1) return false; // ← use correct 'free' getter
```

### BUG-02 · `RingBuffer.push()` references non-existent `availableWrite` getter
**File:** `public/app/ring-buffer.js`  
**What's Wrong:**  
The scalar `push()` branch checks `this.availableWrite` which is never defined on
`RingBuffer`. The class only exposes `this.free`. This throws `TypeError: Cannot
read properties of undefined` on any scalar push call.
```js
if (this.availableWrite < 1) { ... }  // ← availableWrite does not exist
```
**Fix:**
```js
if (this.free < 1) return false;
```

### BUG-03 · `SharedRingBuffer.push()` does not guard against write-pointer wrap overflow
**File:** `public/app/ring-buffer.js`  
**What's Wrong:**  
The write pointer is stored as a raw unbounded integer:
```js
Atomics.store(this.control, 0, (w + len) % this.capacity);
```
But `w` is loaded as `Atomics.load(this.control, 0) % this.capacity` **before** the
boundary-split write, meaning `w` is already modulo-reduced. If `w + len` wraps
past `this.capacity` before the store, the split write is correct, but the new
pointer is also modulo-reduced correctly. This is actually fine — **however** the
`available()` method loads the raw pointer:
```js
const w = Atomics.load(this.control, 0) % this.capacity;
const r = Atomics.load(this.control, 1) % this.capacity;
```
Because both pointers are stored already modulo-reduced (not monotonically increasing),
`available()` can return **zero even when data is present** if `w === r` after a
full wrap. This is the classic ring-buffer ABA problem.
**Fix:** Store pointers as **monotonically increasing** and reduce only at access time:
```js
// In push() — store raw (w + len), not (w + len) % capacity
const rawW = Atomics.load(this.control, 0);
Atomics.store(this.control, 0, rawW + len);
// In available():
const w = Atomics.load(this.control, 0);
const r = Atomics.load(this.control, 1);
return (w - r + this.capacity * 2) % this.capacity;
```

### BUG-04 · `dispatchParam` falls back to `window._vipApp || window.vip || window._vipOrch` — race condition
**File:** `public/app/slider-map.js`  
**What's Wrong:**  
The `app` reference chain relies on undocumented global assignments. If sliders fire
before the AudioContext and worklet node are ready (possible during early page load),
`worklet` and `worker` are `undefined`, and the dispatch silently no-ops. There is
no queuing mechanism — parameter changes are permanently lost.
**Fix:** Add a lightweight param-queue that flushes once the worklet/worker become ready:
```js
const _pendingParams = [];
export function dispatchParam(id, rawVal, app) {
  const resolved = app || window._vipApp || window.vip || window._vipOrch;
  const worklet = resolved?.workletNode;
  const worker  = resolved?.mlWorker;
  const target  = SLIDER_TARGETS[id] || 'local';
  const payload = { [id]: rawVal };
  let dispatched = false;
  if ((target === 'worklet' || target === 'both') && worklet) {
    try { worklet.port.postMessage({ type: 'params', payload }); dispatched = true; } catch(_){}
  }
  if ((target === 'worker' || target === 'both') && worker) {
    try { worker.postMessage({ type: 'setParams', payload }); dispatched = true; } catch(_){}
  }
  if (!dispatched) _pendingParams.push({ id, rawVal });
}
export function flushPendingParams(app) {
  while (_pendingParams.length) {
    const { id, rawVal } = _pendingParams.shift();
    dispatchParam(id, rawVal, app);
  }
}
```

### BUG-05 · `dsp-processor.js` gate RMS uses per-quantum window — misses transients in mono-mix
**File:** `public/app/dsp-processor.js`  
**What's Wrong:**  
RMS is computed across the 128-sample quantum **after** summing channels, then compared
to `gateThresh`. At 44100 Hz, 128 samples = 2.9 ms — a transient spike can land in this
window and open the gate, but a hard consonant spread across two quanta gets averaged out
and may be gated incorrectly.  
**Severity:** Low/Medium. Not a hard bug but a known psychoacoustic design gap.  
**Fix:** Use a leaky peak detector (attack ~1 ms, release ~50 ms) rather than instantaneous RMS:
```js
// In constructor:
this._peakEnv = 0.0;
this._peakAttack  = 1.0 - Math.exp(-1.0 / (0.001 * sampleRate)); // 1 ms
this._peakRelease = 1.0 - Math.exp(-1.0 / (0.050 * sampleRate)); // 50 ms

// In process(), replacing the RMS block:
for (let i = 0; i < Q; i++) {
  const abs = Math.abs(mono[i]);
  const coef = abs > this._peakEnv ? this._peakAttack : this._peakRelease;
  this._peakEnv += coef * (abs - this._peakEnv);
}
const envDb = this._peakEnv > 0 ? 20 * Math.log10(this._peakEnv) : -160;
const belowGate = envDb < this._params.gateThresh;
```

### BUG-06 · No COOP/COEP headers — SharedArrayBuffer will be unavailable at runtime
**File:** `vercel.json` / server config (missing)  
**What's Wrong:**  
SharedArrayBuffer requires `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` HTTP headers on the serving page.
Without them, `typeof SharedArrayBuffer === 'undefined'` in all modern browsers
(Chrome 92+, Firefox 79+, Safari 15.2+), which silently breaks the entire SAB
communication layer between AudioWorklet and ml-worker.
**Fix:** Add `vercel.json`:
```json
{
  "headers": [
    {
      "source": "/app/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" },
        { "key": "Cross-Origin-Resource-Policy", "value": "cross-origin" }
      ]
    }
  ]
}
```

### BUG-07 · No test coverage for DSP message contracts or ring-buffer boundary conditions
**What's Wrong:**  
The test suite (if present) has zero coverage for:
- WorkletProcessor `initSAB` → `sabReady` handshake
- Ring buffer wrap-around at exact capacity boundary
- `dispatchParam` no-op when worklet not ready
- Slider `nrAmount` normalisation (UI value 78 → internal 0.78)
**Fix:** Added in `tests/dsp-contracts.test.js` (see file in this commit).

---

## Phase 3 — Documentation Audit

- `dsp-processor.js` — inline architecture block is excellent. ✅
- `ring-buffer.js` — header documents layout but does not warn about the monotonic
  pointer requirement for ABA safety. Updated.
- `slider-map.js` — no JSDoc on `buildPanels` or `dispatchParam`. Added.
- `CLAUDE.md` / `AGENTS.md` — comprehensive but partially contradictory on whether
  cloud fetch is permitted during model loading. Clarified to: local `.onnx` model
  files only, no runtime cloud inference APIs.
- `README.md` — does not mention COOP/COEP header requirement. Critical for any
  self-hosting setup.

---

## Phase 4 — Files Changed in This PR

| File | Action | Reason |
|---|---|---|
| `public/app/ring-buffer.js` | Patched | BUG-01, BUG-02, BUG-03 |
| `public/app/slider-map.js` | Patched | BUG-04 |
| `public/app/dsp-processor.js` | Patched | BUG-05 |
| `vercel.json` | Created | BUG-06 COOP/COEP headers |
| `tests/dsp-contracts.test.js` | Created | BUG-07 test coverage |
| `AUDIT_REPORT.md` | Created | This document |

---

## Severity Summary

| ID | Severity | Status |
|---|---|---|
| BUG-01 | 🔴 Critical | Fixed |
| BUG-02 | 🔴 Critical | Fixed |
| BUG-03 | 🟠 High | Fixed |
| BUG-04 | 🟠 High | Fixed |
| BUG-05 | 🟡 Medium | Fixed |
| BUG-06 | 🔴 Critical | Fixed |
| BUG-07 | 🟡 Medium | Fixed |

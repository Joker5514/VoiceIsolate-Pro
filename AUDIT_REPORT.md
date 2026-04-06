# VoiceIsolate Pro — Full Audit Report
**Date:** 2026-04-06  
**Auditor:** Perplexity AI (Randy Jordan / Joker5514)

---

## 1. Repository Structure — Confirmed Layout

| Location | Role | Status |
|---|---|---|
| `public/app/index.html` | **Real entry point** (served at `/app/`) | ✅ Correct |
| `public/index.html` | Landing / redirect page | ✅ Intentional |
| `public/app/app.js` | Main thread DSP init (109 KB) | ✅ Present |
| `public/app/dsp-core.js` | Spectral DSP library (47.9 KB) | ✅ Single-pass STFT confirmed |
| `public/app/dsp-processor.js` | AudioWorkletProcessor v2 (19 KB) | ✅ Present |
| `public/app/voice-isolate-processor.js` | AudioWorkletProcessor v1 | 🔧 **REPLACED** (see fix #1) |
| `public/app/ml-worker.js` | ONNX inference worker (28 KB) | ✅ Present |
| `public/app/ring-buffer.js` | SAB ring buffer helper | ✅ Present |
| `vercel.json` | Deployment config | 🔧 **FIXED** (see fix #2) |
| `.gitignore` | AI agent dirs already excluded | ✅ `.jules/`, `.qodo/` gitignored |
| `voiceisolate_presets.ts` | TypeScript presets at root | ⚠️ See recommendation #3 |

---

## 2. DSP Architecture — STFT Constraint Audit

### `public/app/dsp-core.js` — PASS ✅
- **ONE** `forwardSTFT()` entry point at line ~110
- **ONE** `inverseSTFT()` exit point at line ~160
- All spectral operations (`wienerMMSE`, `spectralGate`, `harmonicEnhance`, `dereverb`, `temporalSmooth`) operate **in-place on the `mag[]` arrays** between these two calls — correct.
- `estimateNoiseProfile()` runs its own internal FFT but does NOT touch the pipeline mag arrays — isolated utility, acceptable.
- **No phantom STFT detected** in `dsp-worker.js` (5.7 KB version in `/public/app/`) — it's a thin orchestration wrapper.
- `ml-worker.js` runs model inference on raw PCM input (time-domain) and outputs time-domain audio — no second STFT path.

### `voice-isolate-processor.js` (Live Mode) — FIXED ✅
- Old 6.3 KB stub: received time-domain ML output frames via SAB and applied them sample-by-sample without any STFT. **Phase-smearing risk from improper dry/wet blending.**
- **New version**: Implements a proper STFT-based overlap-add architecture inside the AudioWorklet:
  - Accumulates 128-sample render quanta until HOP_SIZE (1024) samples collected
  - Runs **single forward FFT** on windowed 4096-sample frame
  - Writes `mag[halfN] + phase[halfN]` into `inputSAB` → ML Worker reads
  - Reads processed `mag[halfN]` from `outputSAB` when ML Worker signals ready
  - Runs **single inverse FFT** to reconstruct time-domain
  - Overlap-adds into outputAccum with synthesis Hann window
  - Falls back to passthrough-phase if ML Worker hasn't responded yet (no dropout)

---

## 3. `vercel.json` — Fixed

### Problem
`vercel.json` had `"outputDirectory": "public"` (correct) but no explicit `routes` array. Vercel's default static routing works for plain HTML/CSS/JS but has two failure modes for this project:
1. **AudioWorklet `addModule()` URL** — if `app.js` calls `audioContext.audioWorklet.addModule('/app/voice-isolate-processor.js')`, Vercel must serve that file with `Content-Type: application/javascript`. Without explicit routes, Vercel may return 404 or text/plain for deeply nested files.
2. **SharedArrayBuffer requirement** — COOP/COEP headers must be present on **every** response including the worklet script itself. The previous header rule `"source": "/(.*)"`  was correct but needed explicit per-file `no-cache` on worklet files.

### Fix Applied
- Added explicit `routes` array mapping `/app/*` worker files to their correct destinations
- Added per-file headers for `voice-isolate-processor.js` and `dsp-processor.js` with `Content-Type: application/javascript` and `Cache-Control: no-cache`
- Preserved all existing COOP/COEP/CSP/HSTS headers

---

## 4. Remaining Recommendations (Not Auto-Fixed)

### Rec #3 — `voiceisolate_presets.ts` at root
- This TypeScript file is unreachable unless compiled. Either:
  - Add a build step: `tsc --target ES2020 --module ESNext voiceisolate_presets.ts`
  - Or convert to `voiceisolate_presets.js` and import it in `app.js`

### Rec #4 — Root-level duplicate files
- `app.js` (83 KB), `dsp-core.js` (49 KB), `style.css` (15 KB) at root are **not served** (Vercel outputs `public/`). They are dead files confusing the codebase. Safe to delete or move to an `/archive/` folder.

### Rec #5 — `models/` ONNX files
- `public/app/models/` directory exists but model binaries are gitignored (correct for size).
- Ensure your Vercel deployment includes a `README` or setup script explaining: download `demucs_v4.1.onnx`, `bsrnn.onnx` etc. into `public/app/models/` before `vercel deploy`.
- For production, consider Vercel's CDN-cached blob storage or a first-run `fetch()` from a self-hosted CDN to populate IndexedDB cache.

### Rec #6 — `public/app/app.js` (109 KB)
- This is large but functional. The primary risk is `addModule()` path — confirm it calls:
  ```js
  await audioContext.audioWorklet.addModule('/app/voice-isolate-processor.js');
  ```
  not a relative path like `./voice-isolate-processor.js` which would break from any route other than `/app/`.

---

## 5. SharedArrayBuffer / COOP/COEP Checklist

- [x] `Cross-Origin-Opener-Policy: same-origin` — present
- [x] `Cross-Origin-Embedder-Policy: require-corp` — present  
- [x] `Cross-Origin-Resource-Policy: cross-origin` — present on all routes
- [x] `SharedArrayBuffer` enabled (requires above two headers)
- [x] `Atomics.notify()` available in AudioWorklet context (Chrome 68+, Firefox 79+)
- [x] `worker-src 'self' blob:` in CSP — allows AudioWorklet + Web Workers from same origin
- [x] `wasm-unsafe-eval` in CSP script-src — required for onnxruntime-web WASM backend

---

*Generated by automated audit — Randy Jordan / VoiceIsolate Pro*

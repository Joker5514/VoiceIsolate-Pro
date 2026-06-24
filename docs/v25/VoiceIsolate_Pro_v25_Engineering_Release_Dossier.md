---
title: "VoiceIsolate Pro v25 — Engineering Release Dossier and Source-of-Truth Handoff"
version: "v25.0"
product: "VoiceIsolate Pro"
status: "Canonical"
updated: "2026-05-12"
owner: "Conqueror Studios / Randy Jordan"
format: "Markdown"
---

# VoiceIsolate Pro v25 — Engineering Release Dossier

> **This is the engineering source-of-truth handoff.** Any AI agent, coding assistant, or contributor starting work on this repo must read this document first. It supersedes all previous session notes, older blueprint versions (v5–v24), and any undocumented tribal knowledge.

---

## Canonical runtime surface

**Everything lives in `public/app/`.** This is what Vercel serves. Root-level duplicates were cleaned in PRs #424–#428.

| File | Role |
|---|---|
| `public/app/index.html` | App entry point |
| `public/app/app.js` | Main-thread orchestration + 52-slider wiring |
| `public/app/voice-isolate-processor.js` | Live AudioWorkletProcessor — STFT, SAB bridge, ring buffer |
| `public/app/dsp-processor.js` | Creator/Forensic offline processor |
| `public/app/dsp-worker.js` | DSP worker thread |
| `public/app/ml-worker.js` | ONNX inference worker (WebGPU → WASM) |
| `public/app/dsp-core.js` | Single-pass STFT spectral library |
| `public/app/pipeline-orchestrator.js` | Pipeline orchestration |
| `public/app/pipeline-state.js` | Pipeline state management |
| `public/app/ring-buffer.js` | Ring buffer utility |
| `public/app/style.css` | Dark theme |
| `public/app/visuals.js` | 3D spectrogram + meters |

---

## Non-negotiable invariants

Breaking any of these is a regression, not a feature.

1. **Single-pass STFT only.** One forward STFT, one inverse STFT. All spectral work happens in-place between them.
2. **In-place spectral processing.** No time/frequency bounce cycles. All ops mutate `mag[]` directly.
3. **Local execution only.** No cloud processing, no external fetch for audio data. ONNX/WASM served locally.
4. **Live vs offline split.** AudioWorklet = real-time-safe, bounded. Heavy inference = workers only.
5. **Headers are functional.** COOP, COEP, `Content-Type: application/javascript`, `Cache-Control: no-cache` on the worklet route — these directly determine if live mode works.

---

## Verified PR history (fixes that must not regress)

| PR | What it fixed |
|---|---|
| #424 | Removed dead analytics.js server stubs and write-only voiceprint state in ml-worker |
| #425 | Fixed Speaker Isolation card sliders (were silent no-ops — bindings never attached) |
| #426 | Fixed 7 garbled-audio sources in offline pipeline (brick-wall masks, double Wiener stacking, runaway dereverb, shimmer from harmonicEnhanceV2) |
| #427 | Jules formatting cleanup — readable utilities + CONSTANTS object in app.js |
| #428 | Live worklet ring buffer bugs — inputProcessed pointer, drainHead drain fix, hopsSinceInit guard, state reset on initRingBuffers |
| #429 | Playwright browser smoke test + CI gate (smoke-test blocks deploy-preview and deploy-production) |

---

## Live worklet — critical fixes (PR #428)

These four behaviors were fixed and regression-tested. Do not revert them.

### Fix 1 — inputProcessed pointer
```js
// BROKEN (was): mixed outputHead/outputTail in while-loop condition
while (this.inputHead - (this.outputHead === 0 ? 0 : this.outputTail) >= this.HOP_SIZE)

// CORRECT: dedicated inputProcessed counter
this.inputProcessed = 0; // in constructor
while (this.inputHead - this.inputProcessed >= this.HOP_SIZE) {
  // ... STFT frame logic ...
  this.inputProcessed += this.HOP_SIZE;
}
```

### Fix 2 — drainHead pointer
```js
// BROKEN (was): drain index tied to hop scheduling, 896 samples behind
const idx = (this.outputTail - RENDER + i + oLen) % oLen;

// CORRECT: dedicated drain pointer
this.drainHead = 0; // in constructor
const idx = (this.drainHead + i) % oLen;
this.drainHead = (this.drainHead + RENDER) % oLen; // after drain loop
```

### Fix 3 — hopsSinceInit latency guard
```js
// CORRECT: guard in sample units so ring advances during muted init window
if (this.hopsSinceInit * this.HOP_SIZE < this.FFT_SIZE) {
  outBuf.fill(0);
  return true;
}
```

### Fix 4 — initRingBuffers full state reset
```js
// All of these must be reset when initRingBuffers fires:
this.inputAccum    = new Float32Array(this.FFT_SIZE * 4);
this.outputAccum   = new Float32Array(this.FFT_SIZE * 4);
this.outputWindowSum = new Float32Array(this.FFT_SIZE * 4);
this.inputHead     = 0;
this.inputProcessed = 0;
this.outputHead    = 0;
this.drainHead     = 0;
this.hopsSinceInit = 0;
this.gateEnv       = 0;
this.holdCounter   = 0;
```

---

## Deployment config (vercel.json)

The worklet route must have ALL of these headers or live mode will break:

```json
{
  "source": "/app/voice-isolate-processor.js",
  "headers": [
    { "key": "Cross-Origin-Opener-Policy",   "value": "same-origin" },
    { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" },
    { "key": "Content-Type",  "value": "application/javascript" },
    { "key": "Cache-Control", "value": "no-cache" }
  ]
}
```

---

## Test and CI state

| Suite | Count | Status |
|---|---|---|
| Unit tests | 52 suites / 1,834 tests | ✅ All passing |
| Ring buffer regressions (PR #428) | 4 assertions | ✅ Locked |
| Playwright browser smoke test | 4 assertions | ✅ `runMs:331 nanCount:0 peak:0.891 rms:0.0198` |
| CI deploy gate | `smoke-test → deploy-preview + deploy-production` | ✅ Active |

---

## Platform readiness

| Platform | Status | Blockers |
|---|---|---|
| Web / Vercel | ✅ Ship now | None |
| Android / Play Store | 🚧 Not ready | SAB/WebView headers, release signing, model bundling, RECORD_AUDIO permission, WASM-only mobile fallback |
| iOS | 🚧 Not ready | iOS 15 AudioWorklet constraints unverified |

---

## Engineering rules for future changes

- **Never add a second STFT pass.** Any change that adds a second `fft(real, imag, false)` or second `fft(real, imag, true)` in the spectral path breaks the single-pass guarantee.
- **Never move heavy inference into the worklet.** The worklet thread must remain real-time-safe and bounded.
- **Never introduce cloud processing.** The local-only promise is backed by the codebase. A PR that adds external audio processing must be rejected.
- **Never treat headers as optional.** `vercel.json` header changes that weaken COOP/COEP or remove no-cache from the worklet route are functional regressions.
- **Always target `public/app/` for patches.** Not root-level files.

---

## Recommended next milestones

1. **Web hardening:** documentation cleanup, export/report polish, additional regression coverage on live mode and presets
2. **Android:** SAB/WebView strategy, release signing pipeline, packaged model resolution, permission manifesting, mobile WASM-only fallback
3. **Long-term:** advanced metering, batch CLI, DAW plugin formats, enterprise licensing, higher-throughput offline acceleration

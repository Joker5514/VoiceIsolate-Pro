# Model Chaining UI — Architecture Reference

> **Applies to:** `public/app/app.js` · `public/app/debug-audit.js` · `public/app/debug-menu.js`
> **Version:** v25.0.2+

---

## Overview

VoiceIsolate Pro runs all ML inference locally via ONNX Runtime (WebAssembly).
The **model chain** is the ordered list of model IDs that are loaded, warmed up,
and executed for a given processing run.

The default chain is a single fast model:

```js
// public/app/app.js
const DEFAULT_ML_CHAIN = Object.freeze(['bsrnn_vocals']);
```

A heavier chain (e.g. `['demucs_v4_fp32', 'bsrnn_vocals']`) can be requested
programmatically via the `modelIds` parameter but is never the default —
the Engineer path always uses the single-pass BS-RNN chain to keep latency
predictable.

---

## Model IDs

| ID | Role | Notes |
|----|------|-------|
| `bsrnn_vocals` | Primary vocal stem separation | Default chain; fast WASM path |
| `demucs_v4_fp32` | High-quality 4-stem separation | Opt-in; larger, slower |
| `rnnoise_suppressor` | Noise suppression post-process | Applied after stem split |
| `silero_vad` | Voice-activity detection | Used by analysis pipeline |

---

## Warmup

Models are compiled and cached ahead of the first `Process` click via
`_warmupMLModels()`. The method is deduplicated (`_mlWarmupPromise`) so only
one compile happens per session even if triggered from multiple code paths.

```
Upload accepted
  → _warmupMLModels(['bsrnn_vocals'])   (off hot path, deduped)
       ↓
     warmupModels(modelIds)             (in ml-worker / batch-processor)
       ↓
     ONNX session compiled + cached
```

Warmup is **skipped** on mobile Engineer mode (`_isMobileEngineer()`) and for
files above the large-file threshold, to avoid blocking the main thread on
low-power devices.

---

## Processing Flow

```
runPipeline()
  → pause transport if playing
  → MLWorker isolation (DEFAULT_ML_CHAIN)    ← model chain applied here
      OR DSP fallback (no ONNX)
  → stems → Live-Mix load
  → playback enabled with A/B toggle
```

The model chain is **not configurable through the UI** — the Engineer console
exposes DSP parameter sliders (EQ, noise reduction, limiter) that act on the
Live-Mix stage _after_ isolation, never on the model selection itself.

---

## Debug Audit

The runtime state of the model chain can be inspected from the browser console:

```js
const results = await window.VIP_runAudit();
console.log(results);   // → { models, chain, warmupDone, ... }
```

`window.VIP_runAudit` is defined in `public/app/debug-audit.js` and exposed via
the Debug Menu (`` ` `` key). The Debug Menu's **RUN AUDIT** button calls it
through a typeof guard:

```js
// public/app/debug-menu.js
if (typeof window.VIP_runAudit === 'function') {
  window.VIP_runAudit();
} else {
  showToast('VIP_runAudit not available');
}
```

`debug-audit.js` must be imported _alongside_ `debug-menu.js` in the module
boot block of `public/app/index.html` — see
[`tests/debug-audit-wiring.test.js`](../tests/debug-audit-wiring.test.js) for
the regression guard.

---

## Invariants (never break)

1. `DEFAULT_ML_CHAIN` is `Object.freeze(['bsrnn_vocals'])` — do not append
   models to the default chain without a perf review.
2. `_warmupMLModels` is deduped via `_mlWarmupPromise` — do not call
   `warmupModels` directly from UI event handlers.
3. The chain is applied in `MLWorker`, not on the main thread — model IDs
   must be serialisable strings.
4. Engineer path: always `DEFAULT_ML_CHAIN`; never `['demucs_v4_fp32', ...]`
   on the default code path (see comment at app.js line 5557).

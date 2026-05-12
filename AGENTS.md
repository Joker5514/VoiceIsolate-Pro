# AGENTS.md — AI Source-of-Truth Directive

> **ALL AI AGENTS, CODING ASSISTANTS, AND AUTOMATED TOOLS MUST READ THIS FILE BEFORE TAKING ANY ACTION IN THIS REPOSITORY.**
> This file is the authoritative context anchor for VoiceIsolate Pro. It supersedes older blueprints, chat history, and any stale documentation.

---

## Project identity

- **Product:** VoiceIsolate Pro
- **Owner:** Randy Jordan / Conqueror Studios
- **Version:** v25.0 (as of May 2026)
- **Architecture codename:** Threads from Space v13
- **Repo:** https://github.com/Joker5514/VoiceIsolate-Pro

---

## Canonical documentation (always read these first)

| Document | Path | Purpose |
|---|---|---|
| Architecture Blueprint | `docs/v25/VoiceIsolate_Pro_v25_Production_Architecture_Blueprint.md` | System design, pipeline, models, deployment |
| Product Specification | `docs/v25/VoiceIsolate_Pro_v25_Product_Specification.md` | Features, tiers, UX, commercial roadmap |
| Engineering Dossier | `docs/v25/VoiceIsolate_Pro_v25_Engineering_Release_Dossier.md` | Implementation truth, bug fix record, invariants, rules |
| Claude-specific context | `CLAUDE.md` | Extended context for Claude coding agent sessions |

> Do NOT source architecture decisions from older files (v5–v24 PDFs/blueprints in the repo root or `docs/`). The v25 docs above are the only canonical versions.

---

## Canonical runtime surface

**The app lives entirely in `public/app/`.** This is what Vercel deploys.

| File | Role |
|---|---|
| `public/app/voice-isolate-processor.js` | Live AudioWorkletProcessor — primary real-time engine |
| `public/app/dsp-processor.js` | Offline / Creator / Forensic processor |
| `public/app/dsp-worker.js` | DSP worker thread |
| `public/app/ml-worker.js` | ONNX inference worker (WebGPU → WASM) |
| `public/app/dsp-core.js` | Single-pass STFT spectral library |
| `public/app/pipeline-orchestrator.js` | Pipeline orchestration |
| `public/app/pipeline-state.js` | State management |
| `public/app/ring-buffer.js` | Ring buffer utility |
| `public/app/app.js` | Main thread + 52-slider wiring |
| `public/app/index.html` | App shell |
| `public/app/style.css` | Dark theme |
| `public/app/visuals.js` | 3D spectrogram + meters |

**Do NOT edit root-level copies** of any of the above. They do not exist (were cleaned in PRs #424–#428). If you find one, it is stale — delete it, do not patch it.

---

## Non-negotiable invariants

Any PR that violates these must be rejected or reverted, no exceptions.

1. **Single-pass STFT:** Exactly ONE `fft(real, imag, false)` (forward) and ONE `fft(real, imag, true)` (inverse) in the spectral path per processing cycle. No cascaded transforms.
2. **In-place spectral ops:** All frequency-domain edits mutate `mag[]` directly. No second time/frequency bounce.
3. **100% local processing:** No cloud APIs, no external audio processing fetch calls. ONNX Runtime and models are served from `/app/` paths.
4. **Live vs offline split:** AudioWorklet = real-time-safe + bounded. Heavy ML inference = `ml-worker.js` only.
5. **Headers are functional:** COOP (`same-origin`), COEP (`require-corp`), `Content-Type: application/javascript`, and `Cache-Control: no-cache` on `/app/voice-isolate-processor.js` are required for SharedArrayBuffer to work. Do not weaken these.

---

## Critical fixes — must not regress (PR #428)

Four ring-buffer bugs were fixed in `public/app/voice-isolate-processor.js`. Regression tests are in `tests/voice-isolate-processor.test.js`.

- `inputProcessed` pointer replaces broken `outputHead/outputTail` loop condition
- `drainHead` pointer replaces `outputTail - RENDER` drain index (was 896 samples off)
- `hopsSinceInit` guard advances `drainHead` during muted startup window (prevents ring stall)
- `initRingBuffers` message resets ALL overlap-add and gate state (not just FFT buffers)

---

## CI gates

- `pnpm test` — 1,834 unit tests must pass
- `pnpm test:live` — Playwright browser smoke test (`nanCount:0 peak:0.891 rms:0.0198 partialCoV<0.08`)
- Both gates block `deploy-preview` and `deploy-production` in `.github/workflows/deploy.yml`

---

## What AI agents should NOT do

- ❌ Do not add a second STFT or iSTFT pass anywhere in the pipeline
- ❌ Do not move Demucs, BS-RoFormer, or HiFi-GAN inference into the AudioWorklet
- ❌ Do not introduce `fetch()` calls to external audio processing APIs
- ❌ Do not patch root-level `app.js`, `dsp-core.js`, `style.css`, or `voice-isolate-processor.js` — those should not exist
- ❌ Do not weaken COOP/COEP headers in `vercel.json`
- ❌ Do not use v5–v24 blueprint PDFs as the source of truth for architecture decisions
- ❌ Do not create new PRs based on out-of-date session context — always check `AGENTS.md` and `docs/v25/` first

---

## Preferred agent workflow

1. Read `AGENTS.md` (this file)
2. Read `docs/v25/VoiceIsolate_Pro_v25_Engineering_Release_Dossier.md`
3. Check for open PRs before starting new work
4. Target `public/app/` for all code patches
5. Run `pnpm test && pnpm test:live` before opening any PR
6. Write regression tests for any bug fix
7. Never break the single-pass STFT invariant

---

*Last updated: 2026-05-12 by Perplexity AI on behalf of Randy Jordan / Conqueror Studios*

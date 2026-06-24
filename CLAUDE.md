# VoiceIsolate Pro — AI Contributor Source of Truth

> **READ THIS FILE BEFORE MAKING ANY CHANGE.**
> This document defines the permanent architecture of VoiceIsolate Pro.
> It exists to prevent regressions — especially regressions introduced by AI
> assistants reverting deliberate architectural decisions. If a change you are
> about to make conflicts with this document, the change is wrong. Do not
> "helpfully" restore deleted legacy patterns.

---

## 1. The Architecture: "Stem-Split & Live-Mix"

VoiceIsolate Pro is a **browser-based, 100% local** audio processing platform.
It does **NOT** process a live microphone signal. It uses a two-phase model:

```
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 1 — OFFLINE / BATCH INFERENCE (runs once per uploaded file)      │
│                                                                        │
│  File upload ──► FileIngestion ──► MLWorker (ONNX, WebGPU/WASM)        │
│                  decode + resample   overlap-add inference             │
│                  to 48 000 Hz        │                                 │
│                                      ▼                                 │
│                        ┌──────────────────────────┐                    │
│                        │  STEMS (Float32Arrays)   │                    │
│                        │  • Clean Voice stem      │                    │
│                        │  • Background/Noise stem │                    │
│                        └──────────────────────────┘                    │
├────────────────────────────────────────────────────────────────────────┤
│ PHASE 2 — REAL-TIME "LIVE-MIX" PLAYBACK (runs continuously, zero ML)   │
│                                                                        │
│  Clean stem ──► AudioBufferSourceNode ──► CleanGain ─┐                 │
│                                                      ├─► EQ ─► Master  │
│  Noise stem ──► AudioBufferSourceNode ──► NoiseGain ─┘     ─► Output   │
│                                                                        │
│  UI sliders manipulate GainNodes / BiquadFilterNodes ONLY.             │
│  Sliders NEVER re-trigger ML inference.                                │
└────────────────────────────────────────────────────────────────────────┘
```

**Why:** the old live-microphone pipeline required fragile SharedArrayBuffer
ring buffers and suffered audible clipping from V8 garbage collection. The
Stem-Split & Live-Mix model gives latency-free slider response (it is just a
`GainNode.gain.setTargetAtTime()` call) while keeping the heavy ML work in a
one-shot offline pass.

### 1.1 Hard prohibitions (never reintroduce)

| ✗ Forbidden | Why |
|---|---|
| `navigator.mediaDevices.getUserMedia` or any live-mic ingestion | Live-mic processing was removed by design. The Permissions-Policy header denies the microphone (`microphone=()`). |
| Re-running ML inference from a slider/UI event | Sliders are wired to Web Audio nodes only. Inference happens once, at ingestion. |
| SharedArrayBuffer ring-buffer audio transport for new code | Eliminated with the live pipeline. New code passes stems as transferable `Float32Array`s. |
| Client-side authentication or tier gating as a security boundary | All auth/licensing decisions are server-side (JWT). Client code may only *display* state. |
| Hardcoded secrets, seeded credentials, dev-bypass license stubs | Secrets come from environment variables only (see `.env.example`). |
| Loading ONNX Runtime, Three.js, or any library from a CDN | Vendored locally under `public/lib/`. CSP blocks third-party script origins. |
| `'unsafe-inline'` in `script-src` for new surfaces | `server/securityHeaders.js` enforces strict CSP. Only the legacy `/app/` shell has a temporary, explicitly-scoped exception. |
| Sending audio (or any derivative of audio) to a server | 100% local processing is the product's core promise. |

---

## 2. The 4-Layer ES6 Module System

All new code lives in `src/` and is split into four strict layers. **A layer
may import only from layers below it. Never upward, never sideways into
`public/app/` legacy code.**

```
Layer 4  src/presentation/   DOM only. Reads sliders, paints UI.
            │ imports ▼          May import: pipeline, core.
Layer 3  src/pipeline/       Orchestration: ingestion, playback graph.
            │ imports ▼          May import: workers (spawn), core.
Layer 2  src/workers/        Web Workers: ONNX inference, hashing, caching.
            │ imports ▼          May import: core (via message-passed data).
Layer 1  src/core/           Pure primitives. No DOM, no Web Audio, no I/O.
                                 May import: nothing outside src/core/.
```

| File | Layer | Responsibility |
|---|---|---|
| `src/core/audio-config.js` | 1 | Single source of truth for `SAMPLE_RATE = 48000` and DSP constants. |
| `src/core/BufferPool.js` | 1 | Pre-allocated `Float32Array` pool (128 / 2048 / 4096) — zero-GC DSP. |
| `src/core/ModelManifest.js` | 1 | Canonical model metadata: URLs, sizes, SHA-256 integrity hashes, I/O specs. |
| `src/core/diarization.js` | 1 | Pure speaker diarization (frame features + k-means) run once per file on the clean stem. |
| `src/core/SpectralCleanup.js` | 1 | Pure **offline** STFT post-passes run once per file on the clean stem: `reduceNoise()` (spectral subtraction + minimum-statistics noise floor) and `dereverb()` (decaying-tail subtraction). Strength is a processing parameter, **never a live slider**. |
| `src/workers/MLWorker.js` | 2 | Fetch → verify SHA-256 → cache in IndexedDB → run offline ONNX inference (overlap-add) → emit stems. |
| `src/workers/DiarizationWorker.js` | 2 | Module worker (`{ type: 'module' }`) wrapping `diarization.js` — keeps segmentation off the main thread. |
| `src/workers/SpectralCleanupWorker.js` | 2 | Module worker (`{ type: 'module' }`) wrapping `SpectralCleanup.js` — runs the offline NR/dereverb passes off the main thread. |
| `src/pipeline/FileIngestion.js` | 3 | Accept audio/video blobs, decode, resample to 48 kHz via `OfflineAudioContext`. |
| `src/pipeline/PlaybackMixer.js` | 3 | The Live-Mix graph: stem sources → speaker lane → gains → mute lanes → EQ → destination. Exports `setNoiseReduction()`, `setVoiceMuted()`, `setSpeakerMuted()` etc. |
| `src/presentation/SliderUI.js` | 4 | Slider event listeners, `requestAnimationFrame`-coalesced updates into `PlaybackMixer`. |
| `src/presentation/SpeakerControls.js` | 4 | Per-speaker cards (volume / mute / solo) bound to `PlaybackMixer`'s speaker lane. |

Rules:
- **ESM everywhere** in `src/` (`import`/`export`). Tests use CommonJS (`require`).
- `src/core/` modules must stay **pure**: importable in Node, workers, and the
  browser without side effects.
- `MLWorker.js` is a classic worker (it must `importScripts('/lib/ort.min.js')`).
  It receives the model manifest via its `init` message — it does not import
  `ModelManifest.js` directly. `ModelManifest.js` remains the single source of
  truth; the pipeline layer forwards it.
- **Deliberate capabilities — do not "revert" as regressions:**
  - `MLWorker` `process` accepts an optional `modelIds: string[]` chain that
    runs models in series for **Maximum Isolation** (e.g. vocals → denoise);
    each stage's clean output feeds the next, and the noise stem is still the
    residual against the original input. Single `modelId` remains the one-pass
    case. This is still one inference pass *per file* — not re-triggered by sliders.
  - `diarization.js` builds a per-window **log-mel timbral fingerprint**
    (loudness-invariant; see `melBands`) alongside RMS/ZCR/flatness, so speakers
    are clustered by voice timbre rather than loudness, and whispers (low RMS)
    are still detected (`SILENCE_RMS` is intentionally low).
  - `PlaybackMixer.setSpeakerVolume` accepts **0–200** (>100 = up to +6 dB
    ENHANCE) so a faint/whispered speaker can be boosted. Still AudioParam-only.
  - `src/workers/GateProcessor.js` (`registerProcessor('vip-gate')`) and
    `src/workers/DeEsserProcessor.js` (`registerProcessor('vip-deesser')`) are
    **playback-only** `AudioWorklet`s — a real-time noise gate and de-esser on
    the loaded stems, controlled by k-rate AudioParams so sliders drive them
    like any other Live-Mix control. Web Audio has no built-in gate/expander,
    and a built-in de-esser comb-filters (DynamicsCompressorNode lookahead), so
    both must be worklets. These are **not** the removed live-mic pipeline: they
    never ingest a microphone and never re-run ML. They are the only worklets
    permitted in `src/`, allowlisted by `ALLOWED_WORKLETS` in
    `scripts/validate.js`; any other `audioWorklet.addModule` target (or a
    dynamic one) and `getUserMedia` remain forbidden. Do not delete them or
    re-tighten the allowlist as a "live-pipeline" regression.

---

## 3. Security Rules (Layer 0)

- `server/securityHeaders.js` is the **only** place HTTP security headers are
  defined for the dev server. `server.js` must `app.use()` it first.
- Enforced headers: `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`, strict
  `Content-Security-Policy` (no `'unsafe-inline'` scripts outside the scoped
  legacy exception), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Permissions-Policy: microphone=()`.
- Server secrets actually read by code: `LICENSE_JWT_SECRET` (license + sync JWT
  signing, HMAC-SHA256) and the Stripe pair `STRIPE_SECRET_KEY` /
  `STRIPE_WEBHOOK_SECRET` (see `.env.example`). Stripe webhook idempotency is
  keyed off the Stripe `event.id`, not a separate secret. **Never** commit
  values; never invent fallback secrets that ship to production.
- There is **no** auth API in this repo anymore. `api-routes/auth.js`, the
  client `public/app/auth.js`, and the dev license stub
  `public/app/license-manager.js` were deliberately deleted. Do not recreate
  username/password endpoints with seeded users.
- Model integrity: every model in `ModelManifest.js` carries an expected
  SHA-256, verified by `MLWorker.js` before creating an ONNX session;
  mismatches are refused. Both shipped models are pinned. A `null` hash logs
  a loud warning and is only tolerated in development — never ship one.

---

## 4. ML Models

| Model | Task | Format | Size | Status |
|---|---|---|---|---|
| BiGRU Noise Suppressor (`rnnoise_suppressor.onnx`) | Noise-suppression mask | ONNX, fp32 | ~2 MB | **Committed, trained, hash-pinned** |
| Band-Split RNN Vocal Extractor (`bsrnn_vocals.onnx`) | Vocal-separation mask | ONNX, fp32 | ~3.7 MB | **Committed, trained, hash-pinned** |

Both are trained spectral-mask networks (provenance in
`public/app/models/models-manifest.json`) sharing one inference contract:
`float32 [batch, 2049]` STFT magnitudes in → sigmoid mask out
(fft 4096, hop 1024, Hann, 48 kHz). Larger upgrades (DeepFilterNet INT8,
MDX-Net INT8) are planned and must follow the same manifest + integrity flow.

- Delivery: fetched from `/app/models/` (same-origin), cached in IndexedDB by
  `MLWorker.js`, integrity-checked via SHA-256 from `ModelManifest.js`.
- Execution providers: WebGPU preferred, WASM (SIMD, threaded) fallback.
  ONNX Runtime is always loaded from `/lib/ort.min.js` — never a CDN.
- Output contract: inference produces a **clean stem** (masked iSTFT); the
  **noise stem** is the sample-wise residual (`input − clean`). Both are
  returned as transferable `Float32Array`s.

---

## 5. Legacy Code (`public/app/`) — Migration Status

The Engineer Mode app under `public/app/` predates this architecture. It is in
**maintenance freeze** while the UI migrates to the `src/` layers:

- `public/app/pipeline-orchestrator.js` (the real-time monolith), the live-mic
  code in `app.js`, the auth client, and the license stub are **deleted**. Do
  not restore them from git history.
- The legacy offline path (`_runFallbackPipeline` in `app.js`) still works and
  remains the shipped UI until the new presentation layer replaces it.
- Do not add features to `public/app/`. New work targets `src/`.
- Legacy data invariants still enforced by tests/`scripts/validate.js`:
  52 sliders in `app.js` `SLIDERS`, 32 `STAGES` in `slider-map.js`, presets
  covering all slider IDs, single STFT/iSTFT pass per processing path.

---

## 6. Commands

```bash
pnpm install          # deps + copy ORT/Three.js into public/lib/
pnpm dev              # Express dev server → http://localhost:3000 (serves /src too)
pnpm test             # Jest suites
pnpm lint             # ESLint flat config
pnpm validate         # scripts/validate.js structural checks (enforces this doc)
pnpm build            # copy public/ + src/ → build/
```

Requirements: Node.js ≥ 22, pnpm ≥ 9. Use **pnpm**, never npm/yarn.

---

## 7. Conventions

- Single quotes, semicolons, 2-space indent. `camelCase` vars, `UPPER_CASE`
  constants, `PascalCase` classes.
- Audio hot paths: `Float32Array` only; acquire scratch buffers from
  `BufferPool`, release them in `finally`.
- AudioParam changes: `setTargetAtTime()` (smooth), never bare `value =` jumps
  during playback.
- Async: wrap in try/catch, log with a `[VIP]` prefix, never swallow errors.
- Worker calls carry a timeout and reject on stall; UI falls back gracefully
  (passthrough stems) when ONNX Runtime is unavailable.

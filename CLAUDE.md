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
| Restoring the deleted `pipeline-orchestrator.js` live-mic monolith | Replaced by Stem-Split & Live-Mix (shipped) and the v2.1 Live-mode ring-buffer path (in progress). |
| Client-side authentication or tier gating as a security boundary | All auth/licensing decisions are server-side (JWT). Client code may only *display* state. |
| Hardcoded secrets, seeded credentials, dev-bypass license stubs | Secrets come from environment variables only (see `.env.example`). |
| Loading ONNX Runtime, Three.js, or any library from a CDN | Vendored locally under `public/lib/`. CSP blocks third-party script origins. |
| `'unsafe-inline'` in `script-src` for new surfaces | `server/securityHeaders.js` enforces strict CSP. Only the legacy `/app/` shell has a temporary, explicitly-scoped exception. |
| Sending audio to a server for **processing / inference** | 100% local processing is the product's core promise. Optional **user-initiated** Google Drive import/export (ADR-002) is file I/O only — never automatic, never during Process. |

### 1.2 Master Blueprint v2.1 — Cross-Platform Mandate

The authoritative plan is `docs/architecture/VoiceIsolate-Pro_Master_Blueprint_v2.1.md`
(stub redirect also at `docs/VoiceIsolate-Pro_Master_Blueprint_v2.1.md`). Key
constraints every contributor must enforce:

| Constraint | Rule |
|---|---|
| **Privacy** | 100% local inference. No cloud audio processing. Optional user-initiated Google Drive file I/O only ([GOOGLE_DRIVE.md](docs/guides/GOOGLE_DRIVE.md)). |
| **Single STFT / single iSTFT** | Exactly one forward STFT and one inverse iSTFT per **compatible spectral-mask chain** (fused production path). Waveform-only models (e.g. Demucs) are a separate branch and do not claim this invariant. No repeated phase damage on the fused path. |
| **Dual pipeline** | Lightweight Live path (<80–100 ms, FFT 512/1024 + RNNoise fallback) vs. heavy Creator/Forensic path (FFT 4096–8192 + full ML). |
| **Ring-buffer math** | `HOP_SIZE` **must** be an integer multiple of `QUANTUM` (128). See §8. |
| **Mask equation** | `X_out = X · max(M_hum · M_noise · M_speech · M_speaker · M_dereverb · M_res, M_floor)` with typical `M_floor = -30 dB`. |
| **Platform scope v1.0** | Web + Desktop (Electron MVP) + Android (Capacitor). **iOS explicitly out of scope** until Android is stable. |
| **Model storage** | Platform-aware: IndexedDB + Cache API (web; warn on iOS Safari ~50 MB quota), filesystem (desktop), scoped storage (Android). SHA-256 manifest before every session. |
| **HTDemucs strategy** | Full/specialist ONNX on web/desktop; quantized specialist or ExecuTorch (Vulkan/NNAPI) on Android — validate SDR vs. size before committing. |
| **Electron security** | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, preload-only IPC. See `electron/main.cjs`. |
| **UI shell parity** | **One Engineer Console** under `public/app/` (HTML + `engineer-console.js/css`) ships on Web, Capacitor Android, and Electron. `pnpm build` copies `public/` → `build/`; Android `cap sync` and electron-builder consume `build/`. Do not fork a separate mobile/desktop Engineer UI. |

**Timelines (realistic):** Electron MVP 3–4 weeks (signing + auto-update); Android hardening 5–6 weeks.

### 1.3 Engineer Console UI (layout rules)

The studio-console skin is **layout/visual only**. Contributors must:

| Rule | Detail |
|------|--------|
| **Preserve IDs** | Never rename `processBtn`, `fileInput`, `tab-*`, canvases (`spectroCanvas`, `waveCanvas`, …), `section-*`, slider hosts, or transport IDs. |
| **Preserve data bindings** | Slider parameter names / `VIP_PARAMS` / worklet params stay as-is. Rearrange DOM order only. |
| **Console modules** | `public/app/engineer-console.css` + `engineer-console.js` reparent into session · stage · rack columns and inject Integrity / Output Safety cards. |
| **Auto-analysis** | After successful `runPipeline`, idle-callback invokes `app.runFullAnalysis` (from `analysis-workspace.js`). Manual Analyze buttons remain for re-run. |
| **Focus on one voice** | Shared `src/presentation/TargetSpeakerUI.js`; section + explain accordion **collapsed by default** in Engineer Console. |
| **Android packaging** | `scripts/prepare-android-complete.mjs` + `verify-android-complete.mjs` **require** `app/engineer-console.css` and `app/engineer-console.js` in the offline bundle. |

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
| `src/core/audio-config.js` | 1 | Single source of truth for `SAMPLE_RATE = 48000` and DSP constants; re-exports ring-buffer constants. |
| `src/core/ring-buffer-constants.js` | 1 | Codified `QUANTUM`, `FFT_SIZE_LIVE`, `FFT_SIZE_CREATOR`, `HOP_SIZE`, `QUANTA_PER_HOP`, enrollment defaults. |
| `src/core/OverlapAddAccumulator.js` | 1 | `QuantumHopBridge` + `OverlapAddReconstructor` — symmetric Hann OLA per blueprint §III. |
| `src/core/DesktopBridge.js` | 1 | Thin `window.vipDesktop` adapter — native open/save IPC (no Node in renderer). |
| `src/core/BufferPool.js` | 1 | Pre-allocated `Float32Array` pool (128 / 2048 / 4096) — zero-GC DSP. |
| `src/core/ModelManifest.js` | 1 | Canonical model metadata: URLs, sizes, SHA-256 integrity hashes, I/O specs. |
| `src/core/diarization.js` | 1 | Pure speaker diarization (frame features + k-means) run once per file on the clean stem. |
| `src/core/SpectralCleanup.js` | 1 | Pure **offline** STFT post-passes run once per file on the clean stem: `reduceNoise()` (spectral subtraction + minimum-statistics noise floor) and `dereverb()` (decaying-tail subtraction). Strength is a processing parameter, **never a live slider**. |
| `src/workers/MLWorker.js` | 2 | Fetch → verify SHA-256 → cache in IndexedDB → run offline ONNX inference (overlap-add) → emit stems. |
| `src/workers/DiarizationWorker.js` | 2 | Module worker (`{ type: 'module' }`) wrapping `diarization.js` — keeps segmentation off the main thread. |
| `src/workers/SpectralCleanupWorker.js` | 2 | Module worker (`{ type: 'module' }`) wrapping `SpectralCleanup.js` — runs the offline NR/dereverb passes off the main thread. |
| `src/workers/AudioEncoderWorker.js` | 2 | Module worker that encodes stems to WAV or MP3 (lamejs) off the main thread; stateless, one request per job. |
| `src/pipeline/FileIngestion.js` | 3 | Accept audio/video blobs, decode, resample to 48 kHz; `pickAndIngestFile()` for Electron native open. |
| `src/pipeline/PlaybackMixer.js` | 3 | The Live-Mix graph: stem sources → speaker lane → gains → mute lanes → EQ → destination. Exports `setNoiseReduction()`, `setVoiceMuted()`, `setSpeakerMuted()` etc. |
| `src/pipeline/ProcessingOrchestrator.js` | 3 | Bridges `IsolationModeSelector` → `FileIngestion` → `MLWorker`; translates user-chosen mode into a model-chain array for `MLWorker`. |
| `src/pipeline/ExportOrchestrator.js` | 3 | Coordinates stem export: collects channels from `PlaybackMixer`, dispatches to `AudioEncoderWorker`, returns a downloadable `Blob`. |
| `src/pipeline/EngineerModeBridge.js` | 3 | Thin adapter so the legacy `public/app/` Engineer Mode UI can delegate ingestion/playback to the new pipeline without a full migration. |
| `src/presentation/SliderUI.js` | 4 | Slider event listeners, `requestAnimationFrame`-coalesced updates into `PlaybackMixer`. |
| `src/presentation/SpeakerControls.js` | 4 | Per-speaker cards (volume / mute / solo) bound to `PlaybackMixer`'s speaker lane. |
| `src/presentation/ExportControls.js` | 4 | Export format/quality picker; wires DOM events to `ExportOrchestrator`. |
| `src/presentation/IsolationModeSelector.js` | 4 | Isolation-mode dropdown (Voice Only / Maximum Isolation / etc.) that feeds `ProcessingOrchestrator`. |
| `src/presentation/LandingVisualizer.js` | 4 | Canvas 2D waveform overview + live spectrum analyzer; reads PlaybackMixer analyser. |

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
  - `public/app/dsp-processor.js` (`registerProcessor('dsp-processor')`) is
    **legacy-shipped** on web, Android, and desktop for Engineer Mode
    compatibility and offline precache, but it is **not** `addModule`-loaded
    (the live SharedArrayBuffer worklet path was removed). Packaging is governed
    by `scripts/worklet-manifest.json`, `scripts/verify-worklets.js`, and
    `docs/guides/WORKLETS.md`. After any worklet edit run `pnpm worklets:hash`.

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
| Demucs HT Demucs (`demucs_htdemucs.onnx`) | Vocal-ratio waveform mask (default chain) | ONNX, fp32 | ~149 MB | **Blob-hosted, hash-pinned** |
| BiGRU Noise Suppressor (`rnnoise_suppressor.onnx`) | Noise-suppression mask | ONNX, fp32 | ~2 MB | **Committed, trained, hash-pinned** |
| Band-Split RNN Vocal Extractor (`bsrnn_vocals.onnx`) | Vocal-separation mask | ONNX, fp32 | ~3.7 MB | **Committed, trained, hash-pinned** |
| Silero VAD (`silero_vad.onnx`) | Voice activity detection | ONNX, fp32 | ~2.2 MB | **Committed, hash-pinned** |
| Silero VAD INT8 (`silero_vad_int8.onnx`) | Voice activity detection (fast path) | ONNX, int8 | ~2.3 MB | **Committed, hash-pinned** |
| Diarization ONNX bundle | Speaker embedding + clustering | ONNX, fp32 | ~3 files | **Blob-hosted, hash-pinned** |

**Default isolation chain:** `['demucs', 'rnnoise']` — Demucs extracts the vocal
ratio mask (waveform strategy, 44.1 kHz internal resample), then RNNoise strips
residual background. Spectral-mask models (`bsrnn_vocals`, `rnnoise`) share one
inference contract: `float32 [batch, 2049]` STFT magnitudes in → sigmoid mask out
(fft 4096, hop 1024, Hann, 48 kHz). VAD models gate silence before diarization.
Larger upgrades (DeepFilterNet INT8, MDX-Net INT8) are planned and must follow
the same manifest + integrity flow.

**Dual worker note:** `src/workers/MLWorker.js` is the canonical offline worker
(Landing + `StemSeparation.js`). `public/app/ml-worker.js` is the legacy Engineer
real-time SAB path — do not add passthrough fallbacks there; new ML work targets
`MLWorker.js` only.

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
  **67 sliders** — `SLIDER_REGISTRY` in `slider-map.js` is the calibrated source
  of truth; `app.js` `RENDER_SLIDERS` mirrors it for DOM rendering. The inline
  `SLIDERS` block remains for preset/test parsing. 32 `STAGES` in `slider-map.js`,
  presets covering all slider IDs, single STFT/iSTFT pass per processing path.
- Deleted legacy files (do not restore): `handoff-bridge.js`, `ai-engine-v2.js`,
  `speaker-ui.js`, `speaker-mixer.js`, `isolation-controls.js`, root `engineer.html`,
  root `landing.html`. Surfaces are `public/index.html` and `public/app/` only.

### 5.1 Engineer Mode v25 — Slider Discipline & UI Polish (shipped)

Hardening pass only — **not** an architecture rewrite. Scope stays in
`public/app/slider-*.js`, `app.js`, `index.html`, `style.css`, and
`processing-overlay.js`. Never reintroduce a second STFT/iSTFT. Never touch
`voice-isolate-processor.js` ring-buffer pointer math unless explicitly tasked.

| Module | Contract |
|---|---|
| `slider-calibration.js` | Pure `calibrate(id, raw)` + `getEffectiveDspParams(raw)`. UI ranges stay as displayed; **effective** values compress upper ranges (e.g. voiceIso 0–72 identity, 72–100 ease-out cubic → max effective ≈ 86). Coupling caps extreme combos; soft clamps de-risk gargling/pumping without snapping visible sliders. |
| `slider-map.js` `SLIDER_HINTS` | Structured metadata (`purpose`, `bestFor`, `artifactRisk`, `pairedWith`, `modeDefaults`) for separation/whisper families; string hints still valid. |
| `slider-hint-ui.js` | Augments existing hint panels with expandable details — do not replace inline hints. |
| Slider lock UI | `data-locked` + SVG padlock; `toggleSliderLock(id)`; persist `vip-slider-locks` in `localStorage`; locked rows block drag, preset overwrite, and full reset (unless user chooses full reset). |
| `updateAudioMetrics()` | **One** writer for Voice %, Noise %, SNR dB to header / pipeline strip / neon pulse. Call after process complete and A/B toggle. |
| Collapsible sections | Native `<details>`/`<summary>` with non-empty summary text (a11y). |
| Processing overlay | Stage-aware `data-variant` (uploading → … → exporting). Always `hideProcessingOverlay()` in `runPipeline` `finally`. |

**Version:** product version is **`package.json` → 25.0.2**. Sync Android/iOS with
`pnpm mobile:sync-version` (writes `versionCode` / `CFBundleVersion` as
`major*10000 + minor*100 + patch` → **250002**). Electron artifact name uses
`${version}` from package.json. Published GitHub Release **`latest` = v25.0.2**.

**Native binaries (APK + Windows NSIS):** last rebuilt **2026-08-21T04:16Z** from
`main` @ `b6beea1` (#774 release: DSP controls + reliable local processing) and clobber-uploaded to v25.0.2.
After shell/UX or native WebView changes on `main`, re-run `pnpm android:build:win` +
`pnpm build:electron` and `gh release upload v25.0.2 … --clobber`.
Canonical pins: [docs/DOWNLOADS.md](docs/DOWNLOADS.md), [docs/releases/PLATFORM_SYNC.md](docs/releases/PLATFORM_SYNC.md).

**Engineer DSP sliders (desktop-first):** rows are built by
`src/presentation/DspSlider.js` (`createDspSliderRow`) from `SLIDER_REGISTRY` in
`public/app/slider-map.js`. Do not reintroduce tiny hit targets, two-column rack
grids under ~1800px, or readout-only values without a synchronized number field.
Locks must block drag/keys/number/presets/reset. Guide:
[docs/guides/DSP_SLIDERS.md](docs/guides/DSP_SLIDERS.md).

**Google Drive (optional):** Landing + Engineer expose **Open from Drive** /
**Save to Drive** via `src/core/GoogleDriveBridge.js` + Firebase Google Auth
(`drive.file` scope). Never call from MLWorker / worklets / Process. Setup:
[docs/guides/GOOGLE_DRIVE.md](docs/guides/GOOGLE_DRIVE.md). ADR:
[docs/adr/002-google-drive-file-io.md](docs/adr/002-google-drive-file-io.md).

---

## 6. Commands

```bash
pnpm install          # deps + copy ORT/Three.js into public/lib/
pnpm dev              # Express dev server → http://localhost:3000 (serves /src too)
pnpm test             # Jest suites
pnpm lint             # ESLint flat config
pnpm validate         # scripts/validate.js structural checks (enforces this doc)
pnpm build            # copy public/ + src/ → build/
pnpm electron:dev     # Electron shell → http://localhost:3000 (run pnpm dev first)
pnpm build:electron   # production desktop installer (electron-builder)
```

Requirements: Node.js ≥ 22, pnpm ≥ 11. Use **pnpm**, never npm/yarn.

```bash
pnpm mobile:sync-version   # android versionName/versionCode + iOS CFBundle* from package.json
pnpm test                  # Jest (node)
pnpm test:live             # Playwright headless Engineer pipeline smoke
```

---

## 7. Target-Speaker Enrollment (current: local mel voiceprint)

Per blueprint v2.1 §III — session-scoped speaker focus. **Shipping today uses an
on-device mel-band voiceprint**, not ECAPA-TDNN. ECAPA remains a planned upgrade
when a pinned `ecapa_tdnn` ONNX entry lands in `ModelManifest`.

| Parameter | Shipping value | Blueprint target |
|---|---|---|
| Minimum enrollment | **≥ 0.4 s** speech energy (UI typically 1–3 s) | 3 s clean speech, SNR > 10 dB |
| Embedding model | **24-D mel voiceprint** (`TargetSpeaker.extractLocalVoiceprint`) | ECAPA-TDNN 192-D |
| Similarity | Cosine; default threshold **0.42** (soft width 0.12) | default cosine 0.75 |
| Soft gain | Per-sample gain curve, **15 ms** smooth + rate limit (anti-click) | soft mask in STFT domain |
| Diarization fusion | Optional: match enrollment → cluster id, attenuate non-target segments | full multi-speaker union mask |
| Persistence | Session / in-memory embedding in UI | optional saved voice profile |

Enrollment UI: Engineer `TargetSpeakerUI` (start/end seconds → Enroll → Isolate).
Diarization clusters from Landing/Engineer can be fused when segments exist.
**Do not claim ECAPA or “full target mask fusion inside ML STFT” until those land.**

---

## 8. Ring-Buffer & Overlap-Add Constants (Non-Negotiable)

Codified in `src/core/ring-buffer-constants.js` and mirrored in `public/app/ring-buffer.js`
for AudioWorklet / legacy worker glue:

```javascript
const QUANTUM = 128;           // AudioWorklet render quantum
const FFT_SIZE_LIVE = 1024;    // Historical ring-buffer constant (legacy SAB path)
const FFT_SIZE_CREATOR = 4096; // Offline spectral / forensic sizing reference
const HOP_SIZE = 512;          // 75% overlap when FFT = 4 × HOP
const QUANTA_PER_HOP = HOP_SIZE / QUANTUM; // MUST be integer (4)
```

**Hard rules:**
1. `HOP_SIZE % QUANTUM === 0` — enforced by `validateRingBufferConstants()`.
2. `QuantumHopBridge` accumulates exactly `QUANTA_PER_HOP` quanta before each hop advance.
3. Analysis and synthesis use **symmetric periodic Hann**; reconstruction divides by the summed window² envelope (COLA).
4. **Product is upload-only** (`Permissions-Policy: microphone=()`). Real-time AudioWorklets are **playback-only** Gate + DeEsser (`/src/workers/GateProcessor.js`, `DeEsserProcessor.js`) — **not** a full spectral Live-Mode mic path and **not** a sub-10 ms isolation claim.
5. Offline isolation STFT lives in **`src/workers/MLWorker.js`** (`fused-spectral-single-stft` for DEFAULT `bsrnn_vocals`; serial multi-STFT only for mixed/waveform chains e.g. Demucs). Engineer offline spectral refine uses one STFT/iSTFT in `app.js` `_spectralStageAsync` when ML is unavailable.
6. Tests in `tests/overlap-add.test.js` must pass before merging ring-buffer changes.

Lock-free `SharedRingBuffer` / `RingBuffer` FIFO transport remains in `public/app/ring-buffer.js` for legacy glue; production ML does not require a live-mic SAB ring path.

---

## 9. Desktop (Electron) Security

Implementation: `electron/main.cjs`, `electron/preload.cjs`, `electron/ipc-channels.cjs`.

```javascript
webPreferences: {
  contextIsolation: true,   // REQUIRED
  nodeIntegration: false,   // REQUIRED
  sandbox: true,            // REQUIRED
  preload: path.join(__dirname, 'preload.cjs'),
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
}
```

- All IPC via `contextBridge` → `window.vipDesktop` only. No `require` in renderer.
- File I/O and model cache: main process with native dialogs (`vip:open-file`, `vip:save-file`, `vip:model-cache-path`).
- Stripe / payment keys: main process or server only — never exposed to renderer.
- Packaging: `pnpm build:electron` → `electron-builder` with code signing (Phase 1 deliverable).

Long-term: evaluate **Tauri 2** for unified desktop + Android (8–12 week pilot per roadmap).

---

## 10. Platform Model Storage Strategy

| Platform | Primary cache | Fallback / notes |
|---|---|---|
| **Web** | IndexedDB + SHA-256 verify | Cache API; warn users on iOS Safari ~50 MB origin quota |
| **Desktop (Electron)** | Filesystem (`app.getPath('userData')/models`) | Do not rely solely on IndexedDB |
| **Android** | App-scoped / scoped storage | On-demand model download; quantized or ExecuTorch path |

All platforms share `src/core/ModelManifest.js` as the canonical manifest.

---

## 11. Conventions

- Single quotes, semicolons, 2-space indent. `camelCase` vars, `UPPER_CASE`
  constants, `PascalCase` classes.
- Audio hot paths: `Float32Array` only; acquire scratch buffers from
  `BufferPool`, release them in `finally`.
- AudioParam changes: `setTargetAtTime()` (smooth), never bare `value =` jumps
  during playback.
- Async: wrap in try/catch, log with a `[VIP]` prefix, never swallow errors.
- Worker calls carry a timeout and reject on stall; UI falls back gracefully
  (passthrough stems) when ONNX Runtime is unavailable.

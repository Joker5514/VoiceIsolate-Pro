# CLAUDE.md — VoiceIsolate Pro

This file provides AI assistants with everything needed to navigate, understand, and contribute to VoiceIsolate Pro. Read this before making any changes.

---

## Project Overview

**VoiceIsolate Pro** (v24.0.0) is a **browser-based, 100% local audio processing platform** for professional voice isolation and audio enhancement. Key attributes:

- **Zero cloud processing**: All audio is processed on-device using Web Audio API + ONNX Runtime Web
- **Privacy-first**: No telemetry, no external API calls during audio processing
- **32-Stage Deca-Pass Pipeline**: Advanced DSP + hybrid ML (10 passes, 32 stages total)
- **Cross-platform**: Web (Vercel), native Android (API 23+), native iOS (14.1+) via Capacitor 8
- **Engineer Mode UI**: 52 sliders across 8 tabs, 6-panel diagnostics, 3D spectrogram visualization

> Canonical version lives in `package.json#version`. `server.js` reads it from `package.json` at startup; when bumping the version, update `package.json`, `README.md`, this file, `capacitor.config.json`, and the `mobile:sync-version` script together.

---

## Development Commands

```bash
# Install dependencies (auto-copies ORT + Three.js to public/lib/ if not already committed)
pnpm install

# Start local dev server (http://localhost:3000)
pnpm dev

# Build (copies public/ → build/)
pnpm build

# Lint (ESLint Flat Config, app.js + worker files)
pnpm lint
pnpm lint:fix

# Run all tests (55 Jest suites)
pnpm test
pnpm test:watch
pnpm test:coverage

# Live browser smoke test (Playwright/Puppeteer)
pnpm test:live

# Structural validation checks
pnpm validate

# Copy ONNX Runtime from node_modules to public/lib/
pnpm setup:ort

# Copy Three.js (0.184.0 ESM build) from node_modules to public/lib/
pnpm setup:three

# Sync version number to Android/iOS manifests
pnpm mobile:sync-version

# Download ONNX models (large files not committed)
pnpm models:download

# Mobile builds
pnpm android:build    # Debug APK
pnpm android:release  # Release APK
pnpm android:bundle   # AAB for Google Play
pnpm ios:sync         # Sync web build to iOS
pnpm ios:build        # Sync + open Xcode
```

**Requirements**: Node.js 24.x, pnpm >= 9.0.0 (enforced via `.npmrc` engine-strict).

---

## Repository Structure

```
VoiceIsolate-Pro/
├── public/                    # Web application (served as static site)
│   ├── index.html            # Landing page / router entry point
│   ├── app/                  # Main Engineer Mode application
│   │   ├── index.html        # UI shell (52 sliders, 6-panel diagnostics)
│   │   ├── app.js            # ~38KB — main orchestrator, presets, UI transport
│   │   ├── slider-map.js     # ~9KB — STAGES (32) + SLIDER_REGISTRY (52); pure data, no side effects
│   │   ├── style.css         # Dark industrial UI theme
│   │   ├── mobile.css        # Mobile-specific overrides
│   │   ├── style-diag-log.css # Diagnostic log panel styles
│   │   ├── processing-overlay.css  # Processing overlay styles
│   │   ├── model-status-ui.css     # Model status UI styles
│   │   ├── dsp-core.js       # ~65KB — pure DSP math (STFT, filters, spectral ops)
│   │   ├── dsp-processor.js  # ~9KB — AudioWorklet processor (real-time live mode; canonical)
│   │   ├── dsp-worker.js     # ~6.5KB — Web Worker for heavy offline DSP
│   │   ├── offline-processor.js   # ~20KB — self-contained offline processing module (Creator/Forensic mode)
│   │   ├── pipeline-orchestrator.js  # ~36KB — 32-stage Deca-Pass pipeline runner
│   │   ├── pipeline-state.js # ~20KB — centralized state management + event bus
│   │   ├── ml-worker.js      # ~48KB — ML inference worker (ONNX Runtime)
│   │   ├── ml-worker-fetch-cache.js  # ~37KB — model caching (Cache API + IndexedDB)
│   │   ├── ml-worker-models-patch.js # Model compatibility shims
│   │   ├── model-cdn-loader.js  # ~7KB — CDN/Blob URL model fetching with fallback
│   │   ├── model-loader.js   # ~4.5KB — model loader entry point (dispatches to cdn-loader)
│   │   ├── model-status-ui.js # ~8KB — download progress + model status overlay
│   │   ├── batch-orchestrator.js  # ~10KB — multi-file batch processing queue
│   │   ├── batch-processor.js     # ~15KB — concurrent dispatch logic
│   │   ├── ring-buffer.js    # ~10KB — SharedArrayBuffer ring buffer (main ↔ worklet)
│   │   ├── sw.js             # ~8KB — service worker (COOP/COEP injection, cache-first models)
│   │   ├── sw-register.js    # ~4.5KB — service worker registration + update lifecycle
│   │   ├── analytics.js      # Local-only event log (no server)
│   │   ├── license-manager.js # JWT license validation
│   │   ├── paywall.js        # ~27KB — subscription UI
│   │   ├── visuals.js        # ~20KB — Canvas 2D visualization (VU meters, waveform)
│   │   ├── revenuecat.js     # RevenueCat mobile subscriptions
│   │   ├── ai-engine-v2.js   # ~23KB — AI engine v2 (enhanced inference pipeline)
│   │   ├── ai-intelligence.js # ~16KB — AI intelligence layer (model coordination)
│   │   ├── auth.js           # ~17KB — authentication (login/session management)
│   │   ├── nim-integration.js # ~5KB — NVIDIA NIM video/canvas processing integration
│   │   ├── processing-overlay.js  # ~11KB — processing progress overlay UI
│   │   ├── controls-test.js  # Interactive controls test harness
│   │   ├── diarization-timeline.js  # ~11KB — speaker diarization timeline UI
│   │   ├── isolation-controls.js  # ~9KB — per-speaker mute/solo/isolate card UI
│   │   ├── session-persist.js # Session state persistence (IndexedDB)
│   │   ├── vip-boot.js       # ~11KB — VIP bootstrap / feature gate entry point
│   │   └── models/           # Committed ONNX model files
│   │       ├── silero_vad.onnx        # 2.2MB — VAD (fp32)
│   │       ├── silero_vad_int8.onnx   # 2.3MB — VAD (int8 quantized)
│   │       ├── rnnoise_suppressor.onnx # 1.8MB — spectral noise suppressor
│   │       ├── bsrnn_vocals.onnx      # 4.3MB — band-split RNN vocal separator
│   │       ├── demucs_v4_quantized.onnx.placeholder  # placeholder only (too large to commit)
│   │       ├── models-manifest.json   # model registry with SHA-256, shapes, delivery status
│   │       └── README.md
│   ├── lib/                   # Third-party libraries (committed vendor assets)
│   │   ├── ort.min.js        # ONNX Runtime Web minified (NEVER load from CDN)
│   │   ├── ort.js            # ONNX Runtime Web full build
│   │   ├── ort-loader.js     # ORT loader helper (WebGPU → WASM fallback)
│   │   ├── ort-wasm-simd-threaded.wasm           # WASM binary
│   │   ├── ort-wasm-simd-threaded.asyncify.wasm  # WASM binary (asyncify)
│   │   ├── ort-wasm-simd-threaded.jsep.wasm      # WASM binary (JSEP/WebGPU)
│   │   ├── ort-wasm-simd-threaded.jspi.wasm      # WASM binary (JSPI)
│   │   ├── three.module.min.js  # Three.js 0.184.0 ESM build (loaded via importmap)
│   │   ├── three.core.min.js    # Three.js core-only ESM build
│   │   └── three.min.js         # Three.js UMD full build
│   └── docs/                  # Technical documentation
├── api/                       # Backend API (Node.js/Express + Vercel serverless)
│   ├── handler.js            # Vercel serverless request handler (routes all /api/* traffic)
│   ├── index.js              # API router
│   ├── auth.js               # Authentication API (JWT issue/verify)
│   ├── client-config.js      # Client configuration endpoint
│   ├── monetization.js       # Stripe checkout, license JWT, webhooks
│   ├── sync.js               # Cloud sync stub (placeholder)
│   └── nim/                  # NVIDIA NIM integration (optional cloud inference)
│       ├── index.js          # NIM API entry point
│       └── grpc-client.js    # gRPC client for NIM inference service
├── tests/                     # Jest unit tests (55 files)
│   └── helpers/              # Test helpers (get-app-code.js)
├── scripts/                   # Build & validation scripts
│   ├── validate.js           # Structural integrity checks
│   ├── setup-ort.js          # Copy ONNX Runtime from node_modules (skipped if committed)
│   ├── setup-three.js        # Copy Three.js 0.184.0 from node_modules (skipped if committed)
│   ├── stamp-sw-version.js   # Inject cache-bust version into sw.js at build time
│   ├── sync-mobile-version.js # Sync package.json version to Android/iOS manifests
│   ├── validate-onnx-models.js # Verify committed ONNX files meet min-byte thresholds
│   ├── live-smoke.cjs        # Playwright/Puppeteer live browser smoke test
│   ├── bootstrap-libs.sh     # Vercel build entrypoint
│   ├── download-models.sh    # Download large ONNX models (Demucs, etc.)
│   └── (Python export scripts for ONNX model conversion)
├── android/                   # Capacitor 8 Android project
├── ios/                       # Capacitor 8 iOS project
├── fastlane/                  # Fastlane mobile release automation
├── docs/                      # Extended technical documentation
├── notebooks/                 # Jupyter notebooks (model experimentation)
├── server.js                  # Local Express dev server (COOP/COEP headers)
├── eslint.config.js           # ESLint Flat Config (browser + worker globals)
├── vercel.json                # Vercel deployment config (headers, routes, model rewrites)
├── capacitor.config.json      # Mobile app config (Capacitor 8)
├── package.json               # pnpm scripts and dependencies
├── compose.yaml               # Docker Compose (production)
├── compose.debug.yaml         # Docker Compose (debug)
├── Dockerfile                 # Docker image definition
├── render.yaml                # Render.com static site config
├── CONTRIBUTING.md            # Contribution guidelines
├── DEPLOYMENT_GUIDE.md        # Deployment walkthrough (Vercel, Docker, mobile)
├── DIARIZATION_WIRING.md      # Speaker diarization integration notes
├── MODELS.md                  # ONNX model inventory and acquisition guide
└── .env.example               # Required environment variables template
```

---

## Architecture: Critical Constraints

These are non-negotiable architectural rules enforced by `scripts/validate.js` and the CI pipeline. Violating them breaks the pipeline.

### 1. Single-Pass Spectral Architecture

**Within any single processing path**, there is exactly one forward STFT and one iSTFT, with all spectral operations (noise reduction, voice separation, EQ, etc.) occurring **in-place** between them. Never add a second STFT/iSTFT pair to the same path.

```
[Time Domain] → STFT (Stage 10) → [Spectral Ops Stages 11–19] → iSTFT (Stage 20) → [Time Domain]
```

There are three independent processing paths, each honoring this rule:

| Path | STFT call | iSTFT call |
|------|-----------|------------|
| Offline main thread | `app.js` → `DSP.forwardSTFT` | `app.js` → `DSP.inverseSTFT` |
| Offline worker pool | `dsp-worker.js` → `dspCore.forwardSTFT` | `dsp-worker.js` → `dspCore.inverseSTFT` |
| Real-time AudioWorklet | `dsp-processor.js` → `_forwardSTFTFrame` | `dsp-processor.js` → `_inverseSTFTFrame` |

`offline-processor.js` also implements its own inlined FFT/iFFT (self-contained module; follows the same single-pass rule). Both the canonical STFT implementations live in `public/app/dsp-core.js` (`forwardSTFT`/`inverseSTFT`) — do not fork additional copies outside offline-processor.

### 2. AudioWorklet Ownership

**Only `pipeline-orchestrator.js`** calls `audioContext.audioWorklet.addModule()`. Never register AudioWorklet modules from `app.js`, `dsp-worker.js`, or any other file.

### 3. ML Worker Ownership

**Only `pipeline-orchestrator.js`** spawns the ML worker. The ML worker must never be created from `app.js` or other orchestration files.

### 4. Third-Party Libraries — Local Only

ONNX Runtime is always loaded from `/lib/ort.min.js` (local file). It must **never** be loaded from a CDN. The CSP in `vercel.json` enforces this. `pnpm postinstall` runs `setup-ort.js` to copy it from `node_modules`; it is also committed directly to the repo so Vercel does not need to copy it at build time.

Three.js (0.184.0) is loaded from `/lib/three.module.min.js` via an `<script type="importmap">` in `index.html`. It must **never** be loaded from a CDN. The inline module `import * as THREE from 'three'; globalThis.THREE = THREE;` sets the global used by `app.js`. `pnpm setup:three` copies it from `node_modules`; it is committed to the repo.

### 5. Privacy — No External Audio Calls

Audio data must never leave the browser. There are no server-side audio processing endpoints. `analytics.js` logs locally only.

### 6. SharedArrayBuffer Requirements

SharedArrayBuffer requires COOP and COEP headers. These are set in `server.js` for development and `vercel.json` for production. The service worker (`sw.js`) also injects these headers on all responses so `crossOriginIsolated === true` without relying solely on server configuration. Never remove these headers from any path.

### 7. STAGES and SLIDER_REGISTRY Location

`STAGES` (32-entry array) and `SLIDER_REGISTRY` (52-entry flat array) are defined in **`slider-map.js`**, not in `app.js`. `app.js` imports them:

```javascript
import { SLIDER_REGISTRY, STAGES } from './slider-map.js';
```

`slider-map.js` is a **pure data module** — no Web Audio API calls, no SharedArrayBuffer references, no side effects. `scripts/validate.js` checks for the STAGES array in this file.

---

## 32-Stage Deca-Pass Pipeline

The stage labels are defined in `public/app/slider-map.js` as the `STAGES` export (S01–S32). `scripts/validate.js` asserts exactly 32 entries. Stage order:

| Pass | Stages | Purpose |
|------|--------|---------|
| Pass 1 | S01–S04 | Input decode, buffer allocation, DC offset removal, peak normalization |
| Pass 2 | S05–S09 | VAD, time-domain noise gate, click/pop removal, hum removal, de-essing |
| Pass 3 | S10 | Forward STFT (Blackman-Harris window) |
| Pass 4 | S11–S12 | Adaptive Wiener NR + residual Wiener pass |
| Pass 5 | S13–S19 | ERB spectral gate, voice-band emphasis, crosstalk cancel, temporal smoothing, spectral tilt, dereverb, harmonic reconstruction |
| Pass 6 | S20 | Inverse STFT |
| Pass 7 | S21–S25 | OfflineAudioContext setup, HP/LP filters, 10-band EQ, compression, limiter |
| Pass 8 | S26–S28 | Render, post-render cleanup, dry/wet mix |
| Pass 9 | S29–S31 | Peak normalization, quality metrics, waveform update |
| Pass 10 | S32 | Final export ready (SHA-256 forensic hash written to `_forensicLog`) |

---

## 52-Slider System

All 52 sliders are defined in `app.js` as the `SLIDERS` object. The `SLIDER_REGISTRY` flat array in `slider-map.js` maps each slider to its DSP dispatch key and target (`'worklet'` | `'worker'`). Each slider object:

```javascript
{
  id: 'gateThresh',       // Unique string — must match all preset keys and SLIDER_REGISTRY entries
  label: 'Threshold',     // UI display label
  min: -80,               // Minimum value
  max: -5,                // Maximum value
  val: -42,               // Default value
  step: 1,                // Increment
  unit: ' dB',            // Display unit (note: leading space)
  rt: true,               // Real-time capable (wired to AudioParam via worklet)
  desc: 'Signal level...' // Tooltip description
}
```

Sliders are organized into 8 tab groups in the `SLIDERS` object:

| Key    | Sliders | Purpose                                                  |
|--------|---------|----------------------------------------------------------|
| `gate` | 6       | Threshold, range, attack/release/hold, lookahead         |
| `nr`   | 5       | Spectral noise reduction amount/sensitivity/floor/smoothing |
| `eq`   | 10      | 10-band parametric EQ (Sub/Bass/Warmth/.../Brilliance)   |
| `dyn`  | 8       | Compressor + brickwall limiter                           |
| `spec` | 8       | HP/LP filters, de-esser, spectral tilt, formant shift    |
| `adv`  | 6       | Dereverb, harmonic recovery, stereo width, phase correction |
| `sep`  | 5       | Voice isolation, background suppress, focus band, crosstalk |
| `out`  | 4       | Output gain, dry/wet, dither, output width               |

Total: 6 + 5 + 10 + 8 + 8 + 6 + 5 + 4 = **52** (enforced by `scripts/validate.js` and `tests/sliders.test.js`).

**When adding a new slider**:
1. Add the object to `SLIDERS` in `app.js`
2. Add a corresponding entry to `SLIDER_REGISTRY` in `slider-map.js` (id, key, transform, target)
3. Add the ID with a default value to **every** preset in `PRESETS`
4. Update `tests/sliders.test.js` if the count or tab changes
5. Update `tests/presets.test.js` if the preset completeness check fails

---

## Preset System

8 named presets defined in `app.js` as the `PRESETS` object:
- `Voice Clarity`, `Podcast Clean`, `Forensic Extract`, `Music Vocal`, `Whisper Boost`, `Phone/Radio`, `Live Performance`, `Surveillance`

Each preset must define a value for **all 52 slider IDs**. The test `tests/presets.test.js` validates completeness. Applied via `applyPreset(presetName)`.

---

## ML Models

Models are loaded by `ml-worker.js` via `model-loader.js` → `model-cdn-loader.js` and cached in the Cache API (`vip-models-v1`) by the service worker. Large models are fetched from Vercel Blob storage (rewrites in `vercel.json` forward `/app/models/*` to the blob URL).

| Model | File | Delivery | Purpose |
|-------|------|----------|---------|
| Silero VAD (fp32) | `models/silero_vad.onnx` | committed (2.2MB) | Voice activity detection |
| Silero VAD (int8) | `models/silero_vad_int8.onnx` | committed (2.3MB) | VAD — int8 quantized variant |
| RNNoise | `models/rnnoise_suppressor.onnx` | committed (1.8MB) | Spectral noise suppressor (GRU mask) |
| BSRNN Vocals | `models/bsrnn_vocals.onnx` | committed (4.3MB) | Band-split RNN vocal separator |
| Demucs v4 | (Vercel Blob / first-use download) | placeholder only | Vocal/music source separation |
| VoiceFixer | (Vercel Blob / first-use download) | — | Voice quality restoration |
| HiFi-GAN | (Vercel Blob / first-use download) | — | Neural vocoder |

The model registry at `public/app/models/models-manifest.json` contains SHA-256 checksums, input/output tensor shapes, sample rates, and delivery metadata for all models. `scripts/validate-onnx-models.js` verifies committed files meet minimum byte thresholds.

The `ml-worker-models-patch.js` provides compatibility shims for model format variations.

---

## Service Worker

`sw.js` is registered by `sw-register.js` and handles:

1. **COOP/COEP header injection** on all responses → ensures `crossOriginIsolated === true` for SharedArrayBuffer
2. **App-shell pre-caching** on install (all static JS/CSS/HTML assets)
3. **Cache-first strategy** for ONNX model files (`vip-models-v1` cache)
4. **Network-first strategy** for `index.html` (always fresh)
5. **Zero-downtime updates** via `skipWaiting` + `clients.claim` on activate

`scripts/stamp-sw-version.js` injects a cache-bust version string into `sw.js` at Vercel build time (run as part of `vercel.json`'s `buildCommand`).

---

## Code Conventions

### JavaScript Style

- **Quotes**: Single quotes (`'string'`)
- **Semicolons**: Always required
- **Variables**: camelCase (`gateThresh`, `applySpectralNR`)
- **Constants**: UPPERCASE (`STAGES`, `SLIDERS`, `PRESETS`)
- **Classes**: PascalCase (`PipelineState`, `AdaptiveNoiseFloor`)
- **Arrow functions**: Preferred for callbacks; `function` for named methods
- **Module system**: ESM in `public/app/` files; CommonJS (`require`) in `tests/`

### ESLint Configuration

`eslint.config.js` uses ESLint 9 Flat Config. Key globals registered:
- Browser: `ort`, `THREE`, `AudioWorklet`, `AudioWorkletProcessor`
- Workers: `importScripts`, `self`
- Jest: `test`, `expect`, `describe`, `beforeEach`, `afterEach`, `jest`

Rules: `semi: warn`, `quotes: ['warn', 'single']`, `no-unused-vars: warn` (ignores `^_` prefix).

### Audio Buffer Conventions

- Always use `Float32Array` for audio data (no other typed arrays in hot paths)
- Use `setTargetAtTime()` for smooth AudioParam transitions, not `setValueAtTime()`
- In-place spectral operations (never copy the entire spectrum array)
- Ring buffer pattern (`ring-buffer.js`) for main thread ↔ AudioWorklet shared memory

### Error Handling

- Wrap async operations in try-catch; log errors to console, do not swallow them
- ML worker uses promise-based timeout (rejects if inference stalls > threshold)
- Fallback to classical DSP if ONNX Runtime unavailable
- Audio node cleanup: wrap `disconnect()` in try-catch (already-disconnected nodes throw)

---

## Testing

55 Jest test suites covering all major subsystems:

```bash
pnpm test                     # Run all suites
pnpm test -- tests/dsp.test.js  # Run single suite
pnpm test:coverage            # Generate coverage report
pnpm test:live                # Live browser smoke test (Playwright/Puppeteer)
```

Key test files and what they protect:

| Test File | What It Validates |
|-----------|------------------|
| `tests/dsp.test.js` | STFT/iSTFT roundtrip, FFT math, Wiener NR |
| `tests/dsp-core.test.js` | DSP core math functions |
| `tests/sliders.test.js` | 52 slider definitions, unique IDs, tab counts |
| `tests/slider-map.test.js` | SLIDER_REGISTRY and STAGES in slider-map.js |
| `tests/presets.test.js` | All presets cover all 52 slider IDs |
| `tests/pipeline-state.test.js` | State management, event bus |
| `tests/pipeline-orchestrator.test.js` | Pipeline runner, AudioWorklet init |
| `tests/ml-worker.test.js` | ONNX model loading, inference |
| `tests/model-registry-consistency.test.js` | models-manifest.json consistency |
| `tests/html.test.js` | DOM structure, all required `<script>` tags |
| `tests/server.test.js` | Express endpoints, health check, COOP/COEP headers |
| `tests/deployment-config.test.js` | `vercel.json` headers and routes |
| `tests/android-config.test.js` | Capacitor Android configuration |
| `tests/ios-config.test.js` | Capacitor iOS configuration |
| `tests/architectural-invariants.test.js` | Single-pass STFT, worker ownership rules |
| `tests/auth.test.js` | Authentication API |
| `tests/monetization.test.js` | Stripe/license flow |
| `tests/batch-processor.test.js` | Multi-file batch queue |
| `tests/ring-buffer.test.js` | SharedArrayBuffer ring buffer |
| `tests/diarization-timeline.test.js` | Diarization UI component |

Jest environment: `node` (not `jsdom`) — DOM tests use `jsdom` library directly.

### Structural Validation

`pnpm validate` runs `scripts/validate.js` which checks:
- Critical files exist (`public/app/index.html`, `app.js`, `slider-map.js`, `vercel.json`, etc.)
- `app.js` > 10KB (not truncated)
- Slider group IDs (`gate`, `nr`, `eq`) present in `app.js`
- Exactly 52 slider definitions
- At least 32 `STAGES` entries (in `slider-map.js`)
- Forward FFT and inverse FFT functions present in `dsp-core.js`
- AudioWorklet registered only in `pipeline-orchestrator.js`
- ML worker spawned only from `pipeline-orchestrator.js`
- SHA-256 forensic audit hash in pipeline

---

## Environment Variables

Copy `.env.example` to `.env` for local development. Only needed for subscription/payment features:

```bash
# Stripe (only needed for paywall features)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_ANNUAL=price_...
STRIPE_PRICE_STUDIO_MONTHLY=price_...
STRIPE_PRICE_STUDIO_ANNUAL=price_...

# License validation JWT (min 32 chars)
LICENSE_JWT_SECRET=your-secret-key-min-32-chars

# Server
PORT=3000
NODE_ENV=development

# Database (production only)
DATABASE_URL=postgresql://user:password@host:5432/voiceisolate
```

For basic audio processing testing, no `.env` file is required.

---

## Deployment

### Vercel (Primary)

- `vercel.json` configures headers, routes, and cache policies
- COOP + COEP headers are mandatory (required for SharedArrayBuffer)
- ONNX Runtime WASM files are served with `immutable` cache headers
- CSP restricts scripts to same-origin only (no CDN)
- `/app/models/*` requests are rewritten to Vercel Blob storage (configure `YOUR_BLOB_STORE` URL in `vercel.json`)
- Build command: `node scripts/setup-ort.js && node scripts/setup-three.js && node scripts/stamp-sw-version.js`
- Deploy: push to `main` branch triggers CI → Vercel deploy

### Render.com (Alternative)

- `render.yaml` defines static site serving from `public/`
- No build step required (assets are pre-built in `public/`)

### Docker

```bash
docker build -t voiceisolate-pro .
docker compose up            # production
docker compose -f compose.debug.yaml up  # debug mode
```

### Mobile (Capacitor 8)

```bash
# Android
pnpm android:build       # Generates debug APK via Gradle
pnpm android:bundle      # Generates AAB for Google Play

# iOS
pnpm ios:sync            # Sync web assets
# Then open ios/App/App.xcworkspace in Xcode
```

App ID: `com.voiceisolatepro.app`, version: 24.0.0. Fastlane config is in `fastlane/` for automated release builds.

---

## CI/CD Pipeline

Five workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `deploy.yml` | push/PR to `main` | Lint + test + validate + Vercel deploy |
| `eslint.yml` | push/PR | Standalone ESLint check |
| `njsscan.yml` | push/PR | Node.js security scanning (njsscan) |
| `semgrep.yml` | push/PR | Static analysis (Semgrep SAST) |
| `delete-merged-branches.yml` | PR merge | Auto-delete merged branches |

**`deploy.yml`** jobs:

1. **lint-test**: ESLint + Jest (all 55 suites) + `pnpm validate`
2. **smoke-test**: Live browser test via Playwright/Puppeteer (`pnpm test:live`)
3. **deploy-preview**: Vercel preview URL (PRs only)
4. **deploy-production**: Vercel production deploy (merge to `main` only)

Node 24 + pnpm 9.0.0 on `ubuntu-latest`. All actions use pinned commit SHAs for supply-chain security.

---

## Key Files Quick Reference

Sizes are approximate byte counts; authoritative counts come from `wc -c`.

| File | Size | Purpose |
|------|------|---------|
| `public/app/dsp-core.js` | ~65KB | Pure DSP math: STFT, filters, spectral algorithms |
| `public/app/ml-worker.js` | ~48KB | ONNX inference worker (Demucs, BSRNN, VAD) |
| `public/app/ml-worker-fetch-cache.js` | ~37KB | Model caching via Cache API + IndexedDB |
| `public/app/pipeline-orchestrator.js` | ~36KB | 32-stage Deca-Pass runner, AudioWorklet + ML worker init |
| `public/app/paywall.js` | ~27KB | Subscription/paywall UI |
| `public/app/ai-engine-v2.js` | ~23KB | AI engine v2 (enhanced inference pipeline) |
| `public/app/offline-processor.js` | ~20KB | Self-contained offline audio processor (Creator/Forensic mode) |
| `public/app/pipeline-state.js` | ~20KB | Centralized state, event bus |
| `public/app/visuals.js` | ~20KB | Canvas 2D visualization (VU meters, waveform) |
| `public/app/auth.js` | ~17KB | Authentication (login/session management) |
| `public/app/ai-intelligence.js` | ~16KB | AI intelligence layer (model coordination) |
| `public/app/batch-processor.js` | ~15KB | Multi-file batch queue |
| `public/app/app.js` | ~38KB | Main orchestrator: presets, UI transport, slider tab defs |
| `public/app/slider-map.js` | ~9KB | STAGES (32) + SLIDER_REGISTRY (52) — pure data module |
| `public/app/dsp-processor.js` | ~9KB | AudioWorklet real-time processor (canonical — only registered worklet) |
| `server.js` | ~4KB | Express dev server with required COOP/COEP headers |
| `api/handler.js` | — | Vercel serverless adapter (routes all /api/* traffic) |
| `api/monetization.js` | — | Stripe checkout, JWT license generation |
| `api/auth.js` | — | Authentication API |

---

## Common Pitfalls

1. **Don't load ONNX Runtime from CDN.** Always `/lib/ort.min.js`. Run `pnpm setup:ort` if missing.
2. **Don't load Three.js from CDN.** Always `/lib/three.module.min.js` via importmap. Run `pnpm setup:three` if missing.
3. **Don't add a second STFT/iSTFT.** All spectral work goes in stages 10–20. This includes `offline-processor.js`.
4. **Don't spawn the ML worker from `app.js`.** Only `pipeline-orchestrator.js` owns worker lifecycle.
5. **Don't remove COOP/COEP headers.** SharedArrayBuffer breaks without them (needed in `server.js`, `vercel.json`, and `sw.js`).
6. **Don't add presets without covering all 52 slider IDs.** Tests will catch this.
7. **Don't add sliders without updating every preset AND `SLIDER_REGISTRY` in `slider-map.js`.** Both `tests/presets.test.js` and `tests/slider-map.test.js` validate completeness.
8. **Use `pnpm`, not `npm` or `yarn`.** Enforced by `.npmrc` engine-strict.
9. **Tests use CommonJS** (`require`), frontend uses ESM (`import`). Don't mix them.
10. **`public/lib/` files ARE committed to the repo** — ORT WASM, `ort.min.js`, and `three.module.min.js` are all tracked by git and served directly. The setup scripts skip copying if the files are already present. Do not add `public/lib/` to `.gitignore`.
11. **`build/` is gitignored** — generated by `pnpm build`. Never commit the build output.
12. **The `<script type="importmap">` in `index.html` must appear before any `<script type="module">` tag.** Moving or reordering it breaks Three.js loading for the 3D spectrogram.
13. **`STAGES` and `SLIDER_REGISTRY` live in `slider-map.js`, not `app.js`.** Do not re-define them in `app.js`; `app.js` imports them.
14. **Some ONNX models are committed; some are Blob-hosted.** Silero VAD, RNNoise, and BSRNN are committed to `public/app/models/`. Demucs v4 is too large and uses a `.placeholder` file — it is fetched from Vercel Blob on first use and cached by the service worker.
15. **Node.js 24.x is required.** The CI and `.npmrc` enforce this. Do not test with Node 20 or earlier.

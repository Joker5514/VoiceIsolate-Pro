```
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
█  VOICEISOLATE  ██ PRO ██  v24.0.0  ██  AI CONTRIBUTOR GUIDE  █
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
◉ LIVE    ▶ PROCESS    ▐▌ PIPELINE: 32-STAGE DECA-PASS    ░░░▓▓▓███
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
```

> Read this file **before** making any changes. All architectural rules are enforced by CI and `scripts/validate.js` — violations break the pipeline.

---

## ▐ SYSTEM OVERVIEW ▌

**VoiceIsolate Pro** (v24.0.0) is a **browser-based, 100% local audio processing platform** for professional voice isolation and audio enhancement.

```
┌─────────────────────────────────────────────────────────────┐
│  ZERO CLOUD PROCESSING  │  All audio processed on-device    │
│  Web Audio API + ONNX Runtime Web (WebGPU → WASM fallback)  │
├─────────────────────────────────────────────────────────────┤
│  PRIVACY-FIRST          │  No telemetry · No audio upload   │
├─────────────────────────────────────────────────────────────┤
│  32-STAGE DECA-PASS     │  10 passes · Advanced DSP + ML    │
├─────────────────────────────────────────────────────────────┤
│  CROSS-PLATFORM         │  Web (Vercel) · Android · iOS     │
│                         │  Native via Capacitor 8           │
├─────────────────────────────────────────────────────────────┤
│  ENGINEER MODE UI       │  52 sliders · 8 tabs              │
│                         │  6-panel diagnostics · 3D spec    │
└─────────────────────────────────────────────────────────────┘
```

> Canonical version lives in `package.json#version`. When bumping, update `package.json`, `README.md`, this file, `capacitor.config.json`, and run `pnpm mobile:sync-version`.

---

## ▐ DEVELOPMENT COMMANDS ▌

```bash
# ── SETUP ──────────────────────────────────────────────────
pnpm install              # Install + auto-copy ORT & Three.js to public/lib/
pnpm setup:ort            # Copy ONNX Runtime from node_modules → public/lib/
pnpm setup:three          # Copy Three.js 0.184.0 ESM from node_modules → public/lib/
pnpm models:download      # Download large ONNX models (Demucs, etc.)

# ── DEV / BUILD ────────────────────────────────────────────
pnpm dev                  # Local dev server  →  http://localhost:3000
pnpm build                # Copies public/ → build/

# ── QUALITY ────────────────────────────────────────────────
pnpm lint                 # ESLint Flat Config (app.js + worker files)
pnpm lint:fix             # Auto-fix lint issues
pnpm test                 # Run all 59 Jest suites
pnpm test:watch           # Watch mode
pnpm test:coverage        # Coverage report
pnpm test:live            # Live browser smoke test (Playwright/Chromium)
pnpm validate             # Structural integrity checks

# ── MOBILE ─────────────────────────────────────────────────
pnpm mobile:sync-version  # Sync package.json version → Android & iOS manifests
pnpm android:build        # Debug APK
pnpm android:release      # Release APK
pnpm android:bundle       # AAB for Google Play
pnpm ios:sync             # Sync web build to iOS
pnpm ios:build            # Sync + open Xcode
```

**Requirements**: Node.js `24.x` · pnpm `>= 9.0.0` (declared in `package.json#engines` and enforced by CI/validation checks)

---

## ▐ REPOSITORY STRUCTURE ▌

```
VoiceIsolate-Pro/
├── public/                         Web application (static site)
│   ├── index.html                  Landing page / router entry point
│   ├── app/                        Engineer Mode application
│   │   ├── index.html              UI shell (52 sliders, 6-panel diagnostics)
│   │   ├── voice-isolator.html     Standalone voice isolator UI
│   │   ├── how-it-works.html       Technical explainer page
│   │   ├── neon-pulse-card.html    Neon pulse visualizer card page
│   │   │
│   │   ├── ── CORE ORCHESTRATION ──────────────────────────────────
│   │   ├── app.js                  ~38KB  Main orchestrator, presets, UI transport
│   │   ├── slider-map.js           ~9KB   STAGES(32) + SLIDER_REGISTRY(52); pure data
│   │   ├── pipeline-orchestrator.js ~36KB  32-stage Deca-Pass pipeline runner
│   │   ├── pipeline-state.js       ~20KB  Centralized state management + event bus
│   │   ├── vip-boot.js             ~11KB  VIP bootstrap / feature gate entry point
│   │   ├── vip-slider-patch.js     ~37KB  Slider patch (loaded LAST after app.js)
│   │   │
│   │   ├── ── DSP ENGINE ──────────────────────────────────────────
│   │   ├── dsp-core.js             ~65KB  Pure DSP math (STFT, filters, spectral ops)
│   │   ├── dsp-stages.js           ~23KB  32 named DSP stages as pure spectral operators
│   │   ├── dsp-processor.js        ~9KB   AudioWorklet processor (real-time; canonical)
│   │   ├── dsp-worker.js           ~6.5KB Web Worker for heavy offline DSP
│   │   ├── offline-processor.js    ~20KB  Self-contained offline processor (Creator/Forensic)
│   │   ├── fft-bridge.js           ~10KB  Offline STFT/iSTFT utility (Creator/Forensic modes)
│   │   ├── ring-buffer.js          ~10KB  SharedArrayBuffer ring buffer (main ↔ worklet)
│   │   │
│   │   ├── ── ML / MODELS ─────────────────────────────────────────
│   │   ├── ml-worker.js            ~48KB  ML inference worker (ONNX Runtime)
│   │   ├── ml-worker-fetch-cache.js ~37KB  Model caching (Cache API + IndexedDB)
│   │   ├── ml-worker-models-patch.js       Model compatibility shims
│   │   ├── model-cdn-loader.js     ~7KB   CDN/Blob URL model fetching with fallback
│   │   ├── model-loader.js         ~4.5KB Model loader entry point (→ cdn-loader)
│   │   ├── model-status-ui.js      ~8KB   Download progress + model status overlay (canonical entry; if referenced under UI / VISUALIZATION, treat it as a cross-reference only)
│   │   ├── models-manifest.json           Model registry (SHA-256, shapes, delivery)
│   │   │
│   │   ├── ── AI LAYER ────────────────────────────────────────────
│   │   ├── ai-engine-v2.js         ~23KB  AI engine v2 (enhanced inference pipeline)
│   │   ├── ai-intelligence.js      ~16KB  AI intelligence layer (model coordination)
│   │   │
│   │   ├── ── BATCH PROCESSING ────────────────────────────────────
│   │   ├── batch-orchestrator.js   ~10KB  Multi-file batch processing queue
│   │   ├── batch-processor.js      ~15KB  Concurrent dispatch logic
│   │   │
│   │   ├── ── UI / VISUALIZATION ──────────────────────────────────
│   │   ├── visuals.js              ~20KB  Canvas 2D visualization (VU meters, waveform)
│   │   ├── neon-pulse-visualizer.js ~20KB  Neon pulse audio visualizer
│   │   ├── neon-pulse-card.js      ~24KB  Neon pulse visualizer card component
│   │   ├── diarization-timeline.js ~11KB  Speaker diarization timeline UI
│   │   ├── isolation-controls.js   ~9KB   Per-speaker mute/solo/isolate card UI
│   │   ├── processing-overlay.js   ~11KB  Processing progress overlay UI
│   │   │
│   │   ├── ── AUTH / PAYMENTS ─────────────────────────────────────
│   │   ├── auth.js                 ~17KB  Authentication (login/session management)
│   │   ├── license-manager.js             JWT license validation
│   │   ├── paywall.js              ~27KB  Subscription UI
│   │   ├── revenuecat.js                  RevenueCat mobile subscriptions
│   │   │
│   │   ├── ── SERVICE WORKER ──────────────────────────────────────
│   │   ├── sw.js                   ~8KB   COOP/COEP injection, cache-first models
│   │   ├── sw-register.js          ~4.5KB Service worker registration + update lifecycle
│   │   │
│   │   ├── ── UTILITIES ───────────────────────────────────────────
│   │   ├── analytics.js                   Local-only event log (no server)
│   │   ├── session-persist.js             Session state persistence (IndexedDB)
│   │   ├── debug-audit.js          ~13KB  Full self-test & capability audit (console)
│   │   │
│   │   ├── ── STYLES ──────────────────────────────────────────────
│   │   ├── style.css                      Dark industrial UI theme
│   │   ├── mobile.css                     Mobile-specific overrides
│   │   ├── slider-theme.css               Slider component theme
│   │   ├── style-diag-log.css             Diagnostic log panel styles
│   │   ├── processing-overlay.css         Processing overlay styles
│   │   ├── model-status-ui.css            Model status UI styles
│   │   ├── neon-pulse-visualizer.css      Neon pulse visualizer styles
│   │   │
│   │   └── models/                 Committed ONNX model files
│   │       ├── silero_vad.onnx            2.2MB — VAD (fp32)
│   │       ├── silero_vad_int8.onnx       2.3MB — VAD (int8 quantized)
│   │       ├── rnnoise_suppressor.onnx    1.8MB — Spectral noise suppressor (GRU mask)
│   │       ├── bsrnn_vocals.onnx          4.3MB — Band-split RNN vocal separator
│   │       ├── demucs_v4_quantized.onnx.placeholder   placeholder (too large to commit)
│   │       ├── models-manifest.json       Model metadata/inventory manifest (array schema)
│   │       └── README.md
│   │
│   ├── lib/                        Third-party libraries (committed vendor assets)
│   │   ├── ort.min.js              ONNX Runtime Web minified  ← NEVER load from CDN
│   │   ├── ort.js                  ONNX Runtime Web full build
│   │   ├── ort-loader.js           ORT loader helper (WebGPU → WASM fallback)
│   │   ├── ort-wasm-simd-threaded.wasm
│   │   ├── ort-wasm-simd-threaded.asyncify.wasm
│   │   ├── ort-wasm-simd-threaded.jsep.wasm
│   │   ├── ort-wasm-simd-threaded.jspi.wasm
│   │   ├── three.module.min.js     Three.js 0.184.0 ESM (via importmap) ← NEVER CDN
│   │   ├── three.core.min.js       Three.js core-only ESM build
│   │   └── three.min.js            Three.js UMD full build
│   └── docs/                       Technical documentation
│
├── api/                            Backend (Node.js/Express + Vercel serverless)
│   ├── handler.js                  Vercel serverless adapter (routes all /api/*)
│   ├── index.js                    API router
│   ├── auth.js                     Authentication API (JWT issue/verify)
│   ├── client-config.js            Client configuration endpoint
│   ├── monetization.js             Stripe checkout, license JWT, webhooks
│   ├── sync.js                     Cloud sync stub (placeholder)
│   └── nim/                        NVIDIA NIM integration (optional cloud inference)
│       ├── index.js                NIM API entry point
│       └── grpc-client.js          gRPC client for NIM inference service
│
├── tests/                          Jest unit tests (59 suites)
│   └── helpers/                    Test helpers (get-app-code.js)
│
├── scripts/                        Build & validation scripts
│   ├── validate.js                 Structural integrity checks
│   ├── setup-ort.js                Copy ORT from node_modules (skipped if committed)
│   ├── setup-three.js              Copy Three.js 0.184.0 from node_modules
│   ├── stamp-sw-version.js         Inject cache-bust version into sw.js at build
│   ├── sync-mobile-version.js      Sync package.json version → Android/iOS manifests
│   ├── validate-onnx-models.js     Validate model CDN/blob URLs via HEAD + Content-Length thresholds
│   ├── live-smoke.cjs              Playwright live browser smoke test
│   ├── bootstrap-libs.sh           Vercel build entrypoint
│   └── download-models.sh          Download large ONNX models (Demucs, etc.)
│
├── android/                        Capacitor 8 Android project
├── ios/                            Capacitor 8 iOS project
├── fastlane/                       Fastlane mobile release automation
├── docs/                           Extended technical documentation
├── notebooks/                      Jupyter notebooks (model experimentation)
├── server.js                       Local Express dev server (COOP/COEP headers)
├── eslint.config.js                ESLint 9 Flat Config (browser + worker globals)
├── vercel.json                     Vercel config (headers, routes, model rewrites)
├── capacitor.config.json           Mobile app config (Capacitor 8)
├── package.json                    pnpm scripts and dependencies
├── compose.yaml                    Docker Compose (production)
├── compose.debug.yaml              Docker Compose (debug)
├── Dockerfile                      Docker image definition
├── render.yaml                     Render.com static site config
├── CONTRIBUTING.md                 Contribution guidelines
├── DEPLOYMENT_GUIDE.md             Deployment walkthrough (Vercel, Docker, mobile)
├── DIARIZATION_WIRING.md           Speaker diarization integration notes
├── MODELS.md                       ONNX model inventory and acquisition guide
└── .env.example                    Required environment variables template
```

---

## ▐ ARCHITECTURE: CRITICAL CONSTRAINTS ▌

```
╔═══════════════════════════════════════════════════════════════╗
║  ENFORCED BY: scripts/validate.js  +  CI pipeline            ║
║  Violating any rule below BREAKS the build.                   ║
╚═══════════════════════════════════════════════════════════════╝
```

### RULE 1 — Single-Pass Spectral Architecture

Within any single processing path there is **exactly one** forward STFT and **one** iSTFT. All spectral operations occur **in-place** between them. Never add a second STFT/iSTFT pair.

```
[Time Domain] → STFT (S10) → [Spectral Ops S11–S19] → iSTFT (S20) → [Time Domain]
                  ▲                                          ▲
          ONE forward pass                           ONE inverse pass
```

Three independent paths — each must follow this rule:

| Path | STFT | iSTFT |
|------|------|-------|
| Offline main thread | `app.js` → `DSP.forwardSTFT` | `app.js` → `DSP.inverseSTFT` |
| Offline worker pool | `dsp-worker.js` → `dspCore.forwardSTFT` | `dsp-worker.js` → `dspCore.inverseSTFT` |
| Real-time AudioWorklet | `dsp-processor.js` → `_forwardSTFTFrame` | `dsp-processor.js` → `_inverseSTFTFrame` |

`offline-processor.js` implements its own inlined FFT/iFFT (self-contained; same rule applies). `fft-bridge.js` provides the offline STFT/iSTFT utility for Creator and Forensic modes. Canonical implementations live in `dsp-core.js` — do not fork copies outside these files.

### RULE 2 — AudioWorklet Ownership

**Only `pipeline-orchestrator.js`** calls `audioContext.audioWorklet.addModule()`. Never register AudioWorklet modules from `app.js`, `dsp-worker.js`, or any other file.

### RULE 3 — ML Worker Ownership

**Only `pipeline-orchestrator.js`** spawns the ML worker. Never create it from `app.js` or other orchestration files.

### RULE 4 — Third-Party Libraries: Local Only

```
ONNX Runtime  →  always /lib/ort.min.js      NEVER a CDN URL
Three.js      →  always /lib/three.module.min.js via importmap  NEVER a CDN URL
```

CSP in `vercel.json` enforces this. `pnpm postinstall` runs setup scripts; files are also committed directly so Vercel skips copying them.

### RULE 5 — Privacy: No External Audio Calls

Audio data must never leave the browser. No server-side audio processing endpoints exist. `analytics.js` logs locally only.

### RULE 6 — SharedArrayBuffer Headers

COOP + COEP headers are required for `crossOriginIsolated === true`. Set in:
- `server.js` (development)
- `vercel.json` (production)
- `sw.js` (injects headers on all responses as fallback)

Never remove these headers from any path.

### RULE 7 — STAGES & SLIDER_REGISTRY Location

Both data structures live in **`slider-map.js`** only. `app.js` imports them:

```javascript
import { SLIDER_REGISTRY, STAGES } from './slider-map.js';
```

`slider-map.js` is a **pure data module** — no Web Audio API, no SharedArrayBuffer, no side effects.

---

## ▐ 32-STAGE DECA-PASS PIPELINE ▌

```
INPUT ──► [S01–S04] ──► [S05–S09] ──► [S10] ──► [S11–S19] ──► [S20] ──► [S21–S25] ──► [S26–S28] ──► [S29–S31] ──► [S32] ──► OUTPUT
         PASS 1          PASS 2       PASS 3    PASS 4+5       PASS 6      PASS 7          PASS 8        PASS 9       PASS 10
```

Stage labels are defined in `public/app/slider-map.js` as the `STAGES` export (S01–S32). `scripts/validate.js` asserts exactly 32 entries.

| Pass | Stages | Purpose |
|------|--------|---------|
| Pass 1 | S01–S04 | Input decode, buffer allocation, DC offset removal, peak normalization |
| Pass 2 | S05–S09 | VAD, time-domain noise gate, click/pop removal, hum removal, de-essing |
| Pass 3 | S10 | **Forward STFT** (Blackman-Harris window) |
| Pass 4 | S11–S12 | Adaptive Wiener NR + residual Wiener pass |
| Pass 5 | S13–S19 | ERB spectral gate, voice-band emphasis, crosstalk cancel, temporal smoothing, spectral tilt, dereverb, harmonic reconstruction |
| Pass 6 | S20 | **Inverse STFT** |
| Pass 7 | S21–S25 | OfflineAudioContext setup, HP/LP filters, 10-band EQ, compression, limiter |
| Pass 8 | S26–S28 | Render, post-render cleanup, dry/wet mix |
| Pass 9 | S29–S31 | Peak normalization, quality metrics, waveform update |
| Pass 10 | S32 | Final export ready (SHA-256 forensic hash → `_forensicLog`) |

---

## ▐ 52-SLIDER SYSTEM ▌

Sliders are defined in `app.js` as the `SLIDERS` object. `SLIDER_REGISTRY` in `slider-map.js` maps each to a DSP dispatch key and target.

```javascript
{
  id:    'gateThresh',   // Unique — must match all preset keys + SLIDER_REGISTRY entries
  label: 'Threshold',    // UI display label
  min:   -80,
  max:   -5,
  val:   -42,            // Default value
  step:  1,
  unit:  ' dB',          // Leading space is intentional
  rt:    true,           // Real-time capable (wired to AudioParam via worklet)
  desc:  'Signal level…' // Tooltip description
}
```

**8 tab groups:**

| Tab | Count | Purpose |
|-----|-------|---------|
| `gate` | 6 | Threshold, range, attack/release/hold, lookahead |
| `nr` | 5 | Spectral noise reduction amount/sensitivity/floor/smoothing |
| `eq` | 10 | 10-band parametric EQ (Sub → Brilliance) |
| `dyn` | 8 | Compressor + brickwall limiter |
| `spec` | 8 | HP/LP filters, de-esser, spectral tilt, formant shift |
| `adv` | 6 | Dereverb, harmonic recovery, stereo width, phase correction |
| `sep` | 5 | Voice isolation, background suppress, focus band, crosstalk |
| `out` | 4 | Output gain, dry/wet, dither, output width |

**Total: 6+5+10+8+8+6+5+4 = 52** (enforced by `scripts/validate.js` + `tests/sliders.test.js`)

**Adding a new slider — checklist:**
1. Add the object to `SLIDERS` in `app.js`
2. Add a corresponding entry to `SLIDER_REGISTRY` in `slider-map.js`
3. Add the ID with a default value to **every** preset in `PRESETS`
4. Update `tests/sliders.test.js` if count or tab changes
5. Update `tests/presets.test.js` if preset completeness check fails

---

## ▐ PRESET SYSTEM ▌

8 named presets in `app.js` → `PRESETS`:

```
Voice Clarity  ·  Podcast Clean  ·  Forensic Extract  ·  Music Vocal
Whisper Boost  ·  Phone/Radio    ·  Live Performance   ·  Surveillance
```

Every preset must define a value for **all 52 slider IDs**. `tests/presets.test.js` validates completeness. Applied via `applyPreset(presetName)`.

---

## ▐ ML MODELS ▌

```
                    ┌─ Cache API (vip-models-v1) ─────────────────────┐
ml-worker.js  ──►  model-loader.js  ──►  model-cdn-loader.js  ──►  sw.js
                    └─ IndexedDB (ml-worker-fetch-cache.js) ──────────┘
```

Large models are fetched from Vercel Blob storage (`/app/models/*` rewrites in `vercel.json`).

| Model | File | Delivery | Purpose |
|-------|------|----------|---------|
| Silero VAD (fp32) | `models/silero_vad.onnx` | committed 2.2MB | Voice activity detection |
| Silero VAD (int8) | `models/silero_vad_int8.onnx` | committed 2.3MB | VAD — quantized variant |
| RNNoise | `models/rnnoise_suppressor.onnx` | committed 1.8MB | Spectral noise suppressor (GRU mask) |
| BSRNN Vocals | `models/bsrnn_vocals.onnx` | committed 4.3MB | Band-split RNN vocal separator |
| Demucs v4 | `.placeholder` (Vercel Blob) | first-use download | Vocal/music source separation |
| VoiceFixer | (Vercel Blob) | first-use download | Voice quality restoration |
| HiFi-GAN | (Vercel Blob) | first-use download | Neural vocoder |

Model manifests are split by runtime purpose: `public/app/models-manifest.json` is the runtime CDN/source manifest fetched by `model-cdn-loader.js` (`/app/models-manifest.json`), while `public/app/models/models-manifest.json` is metadata/inventory (array schema). `scripts/validate-onnx-models.js` validates model URLs using HEAD requests and `Content-Length` thresholds from the selected manifest, rather than checking local committed file sizes.

---

## ▐ SERVICE WORKER ▌

Service-worker files are currently split:

1. `public/app/sw-register.js` currently registers **`/sw.js`** (root stub) with scope `/`
2. `public/sw.js` is a minimal transition stub (`skipWaiting` + `clients.claim`) to avoid 404s during migration
3. `public/app/sw.js` contains the full COOP/COEP header + cache strategies intended for app-shell/model handling

`scripts/stamp-sw-version.js` injects a cache-bust version string into `public/app/sw.js` at Vercel build time.

---

## ▐ CODE CONVENTIONS ▌

### JavaScript Style

```
Quotes      →  Single quotes  ('string')
Semicolons  →  Always required
Variables   →  camelCase      (gateThresh, applySpectralNR)
Constants   →  UPPERCASE      (STAGES, SLIDERS, PRESETS)
Classes     →  PascalCase     (PipelineState, AdaptiveNoiseFloor)
Functions   →  Arrow for callbacks; named function for methods
Modules     →  ESM in public/app/;  CommonJS (require) in tests/
```

### ESLint (eslint.config.js — ESLint 9 Flat Config)

Globals registered:
- **Browser**: `ort`, `THREE`, `AudioWorklet`, `AudioWorkletProcessor`
- **Workers**: `importScripts`, `self`
- **Jest**: `test`, `expect`, `describe`, `beforeEach`, `afterEach`, `jest`

Rules: `semi: warn` · `quotes: ['warn', 'single']` · `no-unused-vars: warn` (ignores `^_` prefix)

### Audio Buffer Conventions

- Always use `Float32Array` for audio data in hot paths
- Use `setTargetAtTime()` for smooth AudioParam transitions (not `setValueAtTime()`)
- In-place spectral operations — never copy the entire spectrum array
- Ring buffer pattern (`ring-buffer.js`) for main thread ↔ AudioWorklet shared memory

### Error Handling

- Wrap async operations in try-catch; log to console, never swallow
- ML worker uses promise-based timeout (rejects if inference stalls)
- Fallback to classical DSP if ONNX Runtime unavailable
- Audio node cleanup: wrap `disconnect()` in try-catch (already-disconnected nodes throw)

---

## ▐ TESTING ▌

**59 Jest suites** covering all major subsystems. Jest environment: `node` (not `jsdom`) — DOM tests use `jsdom` library directly.

```bash
pnpm test                          # Run all 59 suites
pnpm test -- tests/dsp.test.js     # Run single suite
pnpm test:coverage                 # Generate coverage report
pnpm test:live                     # Live browser smoke test
```

Key suites and what they protect:

| Test File | Validates |
|-----------|-----------|
| `tests/dsp.test.js` | STFT/iSTFT roundtrip, FFT math, Wiener NR |
| `tests/dsp-core.test.js` | DSP core math functions |
| `tests/dsp-stages.test.js` | 32 named stage operators |
| `tests/stft-roundtrip-sine.test.js` | STFT reconstruction accuracy |
| `tests/fft-bridge.test.js` | Offline STFT/iSTFT bridge utility |
| `tests/sliders.test.js` | 52 slider definitions, unique IDs, tab counts |
| `tests/slider-map.test.js` | SLIDER_REGISTRY and STAGES in slider-map.js |
| `tests/presets.test.js` | All presets cover all 52 slider IDs |
| `tests/pipeline-state.test.js` | State management, event bus |
| `tests/pipeline-orchestrator.test.js` | Pipeline runner, AudioWorklet init |
| `tests/ml-worker.test.js` | ONNX model loading, inference |
| `tests/ml-worker-fetch-cache.test.js` | Model caching (Cache API + IndexedDB) |
| `tests/model-registry-consistency.test.js` | models-manifest.json consistency |
| `tests/html.test.js` | DOM structure, all required `<script>` tags |
| `tests/server.test.js` | Express endpoints, health check, COOP/COEP headers |
| `tests/deployment-config.test.js` | `vercel.json` headers and routes |
| `tests/android-config.test.js` | Capacitor Android configuration |
| `tests/ios-config.test.js` | Capacitor iOS configuration |
| `tests/mobile-ui.test.js` | Mobile UI overrides |
| `tests/architectural-invariants.test.js` | Single-pass STFT, worker ownership rules |
| `tests/auth.test.js` | Authentication API |
| `tests/monetization.test.js` | Stripe/license flow |
| `tests/batch-processor.test.js` | Multi-file batch queue |
| `tests/ring-buffer.test.js` | SharedArrayBuffer ring buffer |
| `tests/diarization-timeline.test.js` | Diarization UI component |
| `tests/vip-boot.test.js` | VIP bootstrap / feature gate |
| `tests/worklet-integration.test.js` | AudioWorklet integration |
| `tests/sab-protocol-fixes.test.js` | SharedArrayBuffer protocol |

### Structural Validation

`pnpm validate` → `scripts/validate.js` checks:

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

## ▐ ENVIRONMENT VARIABLES ▌

Copy `.env.example` → `.env`. Only needed for subscription/payment features:

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

> For basic audio processing testing, no `.env` file is required.

---

## ▐ DEPLOYMENT ▌

### Vercel (Primary)

- COOP + COEP headers are **mandatory** (required for SharedArrayBuffer)
- ONNX Runtime WASM files served with `immutable` cache headers
- CSP restricts scripts to same-origin only (no CDN)
- `/app/models/*` requests rewritten to Vercel Blob storage (configure `YOUR_BLOB_STORE` URL in `vercel.json`)
- Build command: `node scripts/setup-ort.js && node scripts/setup-three.js && node scripts/stamp-sw-version.js`
- Deploy: push to `main` → CI → Vercel deploy

### Render.com (Alternative)

- `render.yaml` defines static site serving from `public/`
- No build step required (assets pre-built in `public/`)

### Docker

```bash
docker build -t voiceisolate-pro .
docker compose up                            # production
docker compose -f compose.debug.yaml up     # debug mode
```

### Mobile (Capacitor 8)

```bash
# Android
pnpm android:build    # Debug APK via Gradle
pnpm android:bundle   # AAB for Google Play

# iOS
pnpm ios:sync         # Sync web assets
# Open ios/App/App.xcworkspace in Xcode
```

App ID: `com.voiceisolatepro.app` · Version: `24.0.0` · Fastlane config: `fastlane/`

---

## ▐ CI/CD PIPELINE ▌

**6 workflows** in `.github/workflows/`:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | push/PR | Core CI (lint, test, validate) |
| `deploy.yml` | push/PR to `main` | Full lint + test + validate + Vercel deploy |
| `eslint.yml` | push/PR | Standalone ESLint check |
| `njsscan.yml` | push/PR | Node.js security scanning (njsscan) |
| `semgrep.yml` | push/PR | Static analysis (Semgrep SAST) |
| `delete-merged-branches.yml` | PR merge | Auto-delete merged branches |

**`deploy.yml`** jobs:

1. **lint-test** — ESLint + Jest (all 59 suites) + `pnpm validate`
2. **smoke-test** — Live browser test via Playwright
3. **deploy-preview** — Vercel preview URL (PRs only)
4. **deploy-production** — Vercel production deploy (merge to `main` only)

Workflow runtime/tooling is mixed: `deploy.yml` uses Node `24` + pnpm `9.0.0` with pinned action SHAs, while `ci.yml` currently uses Node `20` + `npm install` and version-tagged actions.

---

## ▐ KEY FILES QUICK REFERENCE ▌

| File | Size | Purpose |
|------|------|---------|
| `public/app/dsp-core.js` | ~65KB | Pure DSP math: STFT, filters, spectral algorithms |
| `public/app/ml-worker.js` | ~48KB | ONNX inference worker (Demucs, BSRNN, VAD) |
| `public/app/vip-slider-patch.js` | ~37KB | Slider patch loaded last (after app.js) |
| `public/app/ml-worker-fetch-cache.js` | ~37KB | Model caching via Cache API + IndexedDB |
| `public/app/pipeline-orchestrator.js` | ~36KB | 32-stage Deca-Pass runner, AudioWorklet + ML worker init |
| `public/app/app.js` | ~38KB | Main orchestrator: presets, UI transport, slider tab defs |
| `public/app/paywall.js` | ~27KB | Subscription/paywall UI |
| `public/app/neon-pulse-card.js` | ~24KB | Neon pulse visualizer card component |
| `public/app/dsp-stages.js` | ~23KB | 32 named DSP stage operators (pure spectral) |
| `public/app/ai-engine-v2.js` | ~23KB | AI engine v2 (enhanced inference pipeline) |
| `public/app/offline-processor.js` | ~20KB | Self-contained offline audio processor |
| `public/app/neon-pulse-visualizer.js` | ~20KB | Neon pulse audio visualizer |
| `public/app/pipeline-state.js` | ~20KB | Centralized state, event bus |
| `public/app/visuals.js` | ~20KB | Canvas 2D visualization (VU meters, waveform) |
| `public/app/auth.js` | ~17KB | Authentication (login/session management) |
| `public/app/ai-intelligence.js` | ~16KB | AI intelligence layer (model coordination) |
| `public/app/batch-processor.js` | ~15KB | Multi-file batch queue |
| `public/app/debug-audit.js` | ~13KB | Self-test & capability audit (`window.VIP_runAudit()`) |
| `public/app/diarization-timeline.js` | ~11KB | Speaker diarization timeline UI |
| `public/app/fft-bridge.js` | ~10KB | Offline STFT/iSTFT bridge (Creator/Forensic modes) |
| `public/app/ring-buffer.js` | ~10KB | SharedArrayBuffer ring buffer (main ↔ worklet) |
| `public/app/slider-map.js` | ~9KB | STAGES(32) + SLIDER_REGISTRY(52) — pure data module |
| `public/app/dsp-processor.js` | ~9KB | AudioWorklet real-time processor (only registered worklet) |
| `server.js` | ~4KB | Express dev server with COOP/COEP headers |
| `api/handler.js` | — | Vercel serverless adapter (routes all /api/* traffic) |
| `api/monetization.js` | — | Stripe checkout, JWT license generation |
| `api/auth.js` | — | Authentication API |

---

## ▐ COMMON PITFALLS ▌

```
╔═══════════════════════════════════════════════════════════════╗
║  STOP — read before editing. These mistakes waste hours.      ║
╚═══════════════════════════════════════════════════════════════╝
```

1. **Don't load ONNX Runtime from CDN.** Always `/lib/ort.min.js`. Run `pnpm setup:ort` if missing.
2. **Don't load Three.js from CDN.** Always `/lib/three.module.min.js` via importmap. Run `pnpm setup:three` if missing.
3. **Don't add a second STFT/iSTFT.** All spectral work goes in stages 10–20. This applies to `offline-processor.js` and any new modules.
4. **Don't spawn the ML worker from `app.js`.** Only `pipeline-orchestrator.js` owns worker lifecycle.
5. **Don't remove COOP/COEP headers.** SharedArrayBuffer breaks without them (`server.js`, `vercel.json`, `sw.js`).
6. **Don't add presets without covering all 52 slider IDs.** `tests/presets.test.js` will fail.
7. **Don't add sliders without updating every preset AND `SLIDER_REGISTRY`.** Both `tests/presets.test.js` and `tests/slider-map.test.js` validate completeness.
8. **Use `pnpm`, not `npm` or `yarn`.** Required by `package.json#packageManager` and CI workflows.
9. **Tests use CommonJS** (`require`); frontend uses ESM (`import`). Don't mix them.
10. **`public/lib/` files ARE committed.** ORT WASM, `ort.min.js`, and `three.module.min.js` are all tracked by git. Do not add `public/lib/` to `.gitignore`.
11. **`build/` is gitignored** — generated by `pnpm build`. Never commit build output.
12. **`<script type="importmap">` in `index.html` must appear before any `<script type="module">`.** Reordering breaks Three.js / 3D spectrogram.
13. **`STAGES` and `SLIDER_REGISTRY` live in `slider-map.js`, not `app.js`.** Import, don't redefine.
14. **Some ONNX models are committed; some are Blob-hosted.** Silero VAD, RNNoise, BSRNN are committed. Demucs v4 uses `.placeholder` — fetched from Vercel Blob on first use.
15. **Node.js 24.x is the project requirement.** Declared in `package.json#engines` and used by deploy workflows (note: `ci.yml` still runs Node 20 today).
16. **`vip-slider-patch.js` is not currently loaded by `public/app/index.html`** (boot uses dynamic module imports). If re-enabled, document and preserve explicit load order relative to `app.js`.
17. **`debug-audit.js` is console-only** — call `window.VIP_runAudit()` from DevTools. Do not wire it into the normal app boot path.

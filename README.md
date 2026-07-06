# VoiceIsolate Pro

<p align="center">
  <strong>Studio-grade voice isolation, 100% in your browser.</strong><br>
  Upload a recording, let on-device AI split it into clean-voice and background-noise stems,
  then mix the result in real time with zero-latency sliders.
</p>

<p align="center">
  <a href="https://voice-isolate-pro.vercel.app">Live Demo</a> ·
  No cloud processing · No audio upload · Your data never leaves the device
</p>

---

## Features

| Feature | Description |
|---------|-------------|
| **AI voice isolation** | Demucs vocal-ratio mask + BiGRU noise suppression via ONNX Runtime Web (WebGPU / WASM) |
| **Speaker diarization** | Log-mel timbral fingerprinting clusters voices by timbre |
| **Real-time progress UI** | Four-step ProcessLoader (decode → resample → load model → separate) with live % |
| **Latency-free mixing** | 67 calibrated sliders (NR, EQ, gate, de-esser, per-speaker volume) on the Web Audio graph |
| **Live visualizations** | Canvas 2D waveform + spectrum on Landing; spectrogram, 3D topo, particle swarm on Engineer Mode |
| **Privacy-first** | Zero cloud processing; models SHA-256 verified and cached in IndexedDB |
| **Export** | WAV or MP3 off the main thread via `AudioEncoderWorker` |
| **Cross-platform** | Web (Vercel), Desktop (Electron MVP), Android via Capacitor (iOS out of scope v1.0) |

## How It Works

VoiceIsolate Pro uses a deliberate **two-phase** model:

### Phase 1 — Offline Batch Inference

```
Upload → Decode/Resample (48 kHz) → Demucs → RNNoise → Spectral Cleanup → Diarization
                                              (one pass per file)
                                    ┌─────────┴─────────┐
                                    ▼                   ▼
                              Clean stem          Noise stem
```

Stereo channels run in parallel inside `MLWorker.js`. Model bytes are cached in IndexedDB and verified on every load.

### Phase 2 — Real-Time Playback Mixing

Stems load into Web Audio `AudioBufferSourceNode`s with independent `GainNode`s, EQ, gate, and de-esser. Sliders adjust the graph instantly — ML models are never re-run.

## Quick Start

### Requirements

- **Node.js** ≥ 22
- **pnpm** ≥ 10

### Install & run

```bash
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro
pnpm install          # vendors ONNX Runtime + Three.js locally
pnpm dev              # http://localhost:3000  (auto-syncs src/ → public/src/)
```

### Other commands

```bash
pnpm test             # Jest — 2100+ tests
pnpm lint             # ESLint
pnpm validate         # Structural integrity checks (CI gate)
pnpm worklets:verify  # AudioWorklet packaging (web + Android + desktop paths)
pnpm build            # Production static build (cross-platform via scripts/build.mjs)
pnpm build:mobile     # Capacitor sync for Android
pnpm electron:dev     # Desktop shell (requires pnpm dev in another terminal)
pnpm build:electron   # Unsigned desktop installer (electron-builder)
```

No `.env` is needed for local audio processing. Payment and licensing features require the variables in [`.env.example`](.env.example).

### Local test artifacts (Windows)

Build unsigned debug builds on your machine for sideload testing. Outputs land in `dist/` (gitignored).

| Platform | Command | Output |
|----------|---------|--------|
| **Android debug APK** | `pnpm android:build:win` | `dist/android/VoiceIsolate-Pro-debug.apk` (~304 MB) |
| **Desktop unpacked** | `pnpm build:electron:dir` | `dist/electron/win-unpacked/VoiceIsolate Pro.exe` |

**Android requirements (Windows)**

- [Android SDK](https://developer.android.com/studio#command-tools) at `%LOCALAPPDATA%\Android\Sdk`
- **JDK 21** — Gradle 8.11 does not support Java 25. The `android:build:win` script auto-detects a portable JDK at `%USERPROFILE%\.jdks\temurin-21`, or set `VIP_JAVA_HOME` to your JDK 21 install.

```powershell
# One-shot Android debug APK
pnpm android:build:win

# Install on a USB-connected device (USB debugging enabled)
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r "dist\android\VoiceIsolate-Pro-debug.apk"
```

- **App ID:** `com.voiceisolatepro.app`
- **Min Android:** 8.0 (API 26)
- **Signing:** debug keystore — for local testing only, not Play Store

**Desktop requirements (Windows)**

- `pnpm setup:electron` once after install
- Unsigned builds skip code-sign tooling that needs symlink privileges on Windows (`signAndEditExecutable: false`)

```powershell
pnpm build:electron:dir
# Run: dist\electron\win-unpacked\VoiceIsolate Pro.exe
```

> **Note:** Production desktop builds load `build/index.html` via `file://`. SharedArrayBuffer may require the dev server (`pnpm dev` + `pnpm electron:dev`) until a desktop model-cache adapter ships. See Blueprint §V.

### Desktop (Electron dev)

```bash
pnpm dev              # Terminal 1
pnpm electron:dev     # Terminal 2 — secure preload, filesystem model cache
```

See [`docs/electron-desktop.md`](docs/electron-desktop.md) and [`docs/VoiceIsolate-Pro_Master_Blueprint_v2.1.md`](docs/VoiceIsolate-Pro_Master_Blueprint_v2.1.md).

## Pages

| Route | Purpose |
|-------|---------|
| `/` | **Landing** — Stem-Split & Live-Mix with on-device ML (`public/index.html`) |
| `/app/` | **Engineer Mode** — 32-stage classical DSP stack with premium visualizations (`public/app/`) |

Both surfaces share the canonical `src/pipeline/StemSeparation.js` path for offline ML (Demucs → RNNoise chain).

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vanilla JS (ES modules), Canvas 2D, Three.js (Engineer premium tabs) |
| ML | ONNX Runtime Web 1.25, WebGPU + WASM (up to 8 threads) |
| Audio | Web Audio API, 3 AudioWorklets (gate + de-esser active; dsp-processor legacy-shipped) |
| Server | Express 5 (dev), Vercel serverless (prod, pnpm via `scripts/vercel-install.sh`) |
| Payments | Stripe (optional, server-side only) |
| Mobile | Capacitor 8 (Android / iOS) |
| CI | GitHub Actions — Jest, ESLint, Semgrep, njsscan |

## Repository Layout

```
src/                       Canonical 4-layer architecture
├── core/                  Pure primitives, ModelManifest, BufferPool
├── workers/               MLWorker, GateProcessor, DeEsserProcessor, Diarization, Encoders
├── pipeline/              FileIngestion, PlaybackMixer, StemSeparation, Orchestrators
└── presentation/          SliderUI, LandingVisualizer, ExportControls

public/
├── index.html + landing.js    Landing page (ProcessLoader, PlaybackMixer)
├── app/                       Engineer Mode shell (67 sliders via SLIDER_REGISTRY)
└── lib/                       Vendored ort.min.js, three.module.js

server/                    Express + securityHeaders.js
api-routes/                Stripe monetization, licensing, sync
tests/                     80+ Jest suites
scripts/                   Build, validation, model + worklet tooling, Vercel install
```

### AudioWorklets (all platforms)

Three worklet files ship in every web, Android, and desktop build. See [`docs/WORKLETS.md`](docs/WORKLETS.md).

| Worklet | Path | Runtime |
|---------|------|---------|
| Gate | `/src/workers/GateProcessor.js` | Active — playback noise gate |
| De-esser | `/src/workers/DeEsserProcessor.js` | Active — playback de-esser |
| DSP (legacy) | `/app/dsp-processor.js` | Shipped + precached; not loaded (live SAB path removed) |

```bash
pnpm worklets:hash           # after editing any *Processor.js
pnpm worklets:verify:build   # confirm build/ copies before cap sync / electron pack
```

See [`CLAUDE.md`](CLAUDE.md) for the full contributor contract and [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow.

## Legacy Rollback Points

Pinned snapshots to restore an earlier codebase without digging through history.

| Legacy | Ref | Commit | When to use |
|--------|-----|--------|-------------|
| **v2.0 (pre–Blueprint v2.1)** | [branch `legacy/v2.0`](https://github.com/Joker5514/VoiceIsolate-Pro/tree/legacy/v2.0) · [tag `legacy-v2.0`](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/legacy-v2.0) | [`ebf1783`](https://github.com/Joker5514/VoiceIsolate-Pro/commit/ebf1783) | Roll back before the Electron MVP, ring-buffer OLA, and Blueprint v2.1 desktop work (merged in [#657](https://github.com/Joker5514/VoiceIsolate-Pro/pull/657)). |
| **v-legacy (earlier web stack)** | [tag `v-legacy`](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v-legacy) | [`0cf8252`](https://github.com/Joker5514/VoiceIsolate-Pro/commit/0cf8252) | Older browser-only snapshot (pre–v24 stem-split refactor). |

```bash
git fetch origin --tags

# v2.0 — immediately before Blueprint v2.1 / Electron MVP
git checkout legacy-v2.0          # tag
git checkout legacy/v2.0        # branch (same commit)

# earlier web-era snapshot
git checkout v-legacy
```

Current development line: [`main`](https://github.com/Joker5514/VoiceIsolate-Pro/tree/main) (includes Blueprint v2.1 Deliverable 1).

## Security

- Strict headers (`COOP`/`COEP`, CSP, `nosniff`, `X-Frame-Options`, `microphone=()`) via `server/securityHeaders.js` and `vercel.json`
- All secrets via environment variables — see `.env.example`
- ONNX models verified against pinned SHA-256 hashes before every session

## License

UNLICENSED — © Randy Jordan. All rights reserved.
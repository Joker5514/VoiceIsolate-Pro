# VoiceIsolate Pro

<p align="center">
  <a href="https://voice-isolate-pro.vercel.app/"><strong>Web</strong></a>
  &nbsp;·&nbsp;
  <a href="https://voice-isolate-pro.vercel.app/app/"><strong>Engineer Console</strong></a>
  &nbsp;·&nbsp;
  <a href="https://voice-isolate-pro.vercel.app/download/"><strong>Downloads</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/README.md"><strong>Docs</strong></a>
</p>

<p align="center">
  <strong>Upload-only voice isolation and audio enhancement with local processing.</strong><br />
  Web · Capacitor Android · Electron Windows
</p>

<p align="center">
  <a href="https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml"><img src="https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml/badge.svg?branch=main" alt="CI and deploy status"></a>
  <a href="https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest"><img src="https://img.shields.io/github/v/release/Joker5514/VoiceIsolate-Pro?display_name=tag&label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node 22+">
  <img src="https://img.shields.io/badge/pnpm-11.3.0-f69220?logo=pnpm&logoColor=white" alt="pnpm 11.3.0">
  <img src="https://img.shields.io/badge/audio-processing%20local-2563eb" alt="Local audio processing">
</p>

## Current release

Repository version: **25.0.2**.  
Latest published GitHub Release: **[v25.0.2](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.2)**.

| Platform | Current public entry |
|---|---|
| Web | https://voice-isolate-pro.vercel.app/ |
| Engineer Console | https://voice-isolate-pro.vercel.app/app/ |
| Android sideload APK | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk |
| Windows x64 installer | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.2-win-x64.exe |
| Download hub | https://voice-isolate-pro.vercel.app/download/ |

Published native asset metadata observed from GitHub Release `v25.0.2`:

| Asset | Size | SHA-256 |
|---|---:|---|
| `VoiceIsolate-Pro-android-debug.apk` | 101,365,796 bytes | `5e531b938c78ae0fc25e0c40111d5ec766549684000030eac63284fd0eb59d5b` |
| `VoiceIsolate-Pro-25.0.2-win-x64.exe` | 144,628,415 bytes | `6f4c0887bb0ef64bd1de5e30cd14cfcd8dc34cf9788433c5c3881c8583b0e621` |

The Android artifact is a **debug/sideload APK**. The Windows installer may be unsigned. Current source can move ahead of published native binaries, so cross-platform same-build claims are governed by [`docs/releases/release-provenance.json`](docs/releases/release-provenance.json), not by the release description alone.

**iOS is outside the supported v1.0 platform scope** even though repository scaffolding/version metadata exists. No current iOS, macOS, or Linux artifact is published in `v25.0.2`.

## What the product does

VoiceIsolate Pro accepts uploaded audio/video files and performs local analysis, voice isolation, enhancement, playback mixing, and export. It intentionally does **not** use live microphone ingestion.

### Unified Premium Signal-First UX (Issue #820)

Single coherent product system across Browser, Android & Desktop. **Signal canvas is center.**

**Workflow:** Import/Record → Automatic Local Analysis → Select Signal → Contextual Action → Preview/Compare → Export. Raw immutable.

- **New IA:** Home, Analyze, Enhance, Compare, Export, Settings. Isolate is contextual action, not nav. Manual Separation removed from primary nav.
- **Landing:** Hero "Hear What Others Miss." 100% on-device whisper recovery. Interactive demo drag→Isolate→before/after.
- **Workspace:** Direct waveform (horizontal drag) + spectrogram (rectangle) selection with handles/timestamp/zoom/clear/selected playback. Contextual palette: Isolate, Enhance Voice, Reduce Noise, Boost Whisper, Preview.
- **Automatic analysis:** VAD, whisper candidates, noise floor, speaker detection, mask generation in worker/WebGPU/WASM/native with deterministic DSP fallback. Overlays: Speech, Whisper, Background Noise, Hum, Music/bleed, secondary speaker.
- **Comparison:** Raw / Processed / Removed (Delta) A/B switching.
- **Metrics:** Default Voice Clarity, Noise Reduction, Whisper Retention, Output dBFS; deep metrics in Advanced/Forensic inspector.
- **Profiles:** Quick, Meeting, Studio, Forensic. Whisper Boost as intelligent action.
- **Design system:** dark graphite/navy, semantic cyan/blue signal, violet selection, green validated, amber uncertain, red raw/destructive. Tokens centralized in `src/ui/tokens/`.
- **100% local:** On-device · Private · Zero Cloud badge, no telemetry, works offline.

Details: `docs/ui/unified-premium-ux-820.md` · Design ref: https://drive.google.com/drive/folders/1wtBNiRgQ73emQKcyaLFHluehmAI5t1Oa

### Legacy Stem-Split & Live-Mix (preserved compatibility)

1. **Upload** a file.
2. **Analyze / Process** explicitly; heavy ML/DSP work runs once for that file/configuration.
3. Produce clean-voice/background stems and analysis evidence.
4. **Live-Mix** the loaded stems with low-latency Web Audio controls.
5. Export locally.

Slider movement must never trigger ML inference. Process-time controls are captured when the user starts Process; Live-Mix controls affect playback only.

## Product surfaces

| Route | Surface | Purpose |
|---|---|---|
| `/` | Landing | Standard upload → isolate → Live-Mix → export workflow |
| `/app/` | Engineer Console | Full studio/forensic control surface, analysis workspace, visualization, diagnostics |
| `/download/` | Downloads | Current Android/Windows assets and Web entry points |

Web, Android, and Electron share the same Engineer Console product shell when each package is rebuilt from the same source.

## Architecture

The canonical contributor rules are in [`CLAUDE.md`](CLAUDE.md). New code follows four layers:

```text
src/core/          pure primitives/contracts
    ↓
src/workers/       workers and approved AudioWorklets
    ↓
src/pipeline/      ingestion, orchestration, playback, export
    ↓
src/presentation/  DOM/presentation adapters
```

Key constraints:

- upload-only; `getUserMedia` is forbidden
- audio processing/inference stays local
- no slider-triggered ML inference
- no third-party runtime script CDN dependencies
- one forward STFT + one iSTFT per compatible fused spectral-mask chain
- Electron keeps `contextIsolation: true`, `nodeIntegration: false`, and sandboxing
- Android release builds keep WebView debugging disabled
- shared renderer work must remain cooperative so long files do not freeze browser, Android WebView, or Electron

`public/app/` is a shipped compatibility surface. Targeted bug/security/parity fixes are allowed there; new architecture belongs in `src/`.

## ML/runtime stack

The shipping local stack is model-manifest driven and uses ONNX Runtime Web with WebGPU when available and WASM fallback where supported. Current core model families include:

- Band-Split RNN vocals isolation
- RNNoise-compatible suppression path where configured
- Silero VAD

Large optional model families may be excluded from standard native packages because of memory/size constraints. See [`docs/guides/MODEL_DELIVERY.md`](docs/guides/MODEL_DELIVERY.md) for the actual delivery contract.

## Privacy and security boundaries

Supported repository guarantees include:

- no live microphone ingestion
- no server-side audio processing/inference path
- optional Google Drive file I/O is user-initiated and is not part of Process
- strict browser security headers are configured by `server/securityHeaders.js` / `vercel.json`
- model integrity is validated against the repository's model metadata/validation path
- Electron renderer isolation is enforced by the native shell
- Android WebView debugging is tied to `BuildConfig.DEBUG`, not enabled unconditionally in release builds
- runtime egress is verified, not only grepped: `pnpm test:privacy-runtime` drives Chromium through upload → Process → export on Landing and upload → Process → auto-analysis on the Engineer Console, recording every context-level request (pages, workers, service worker), WebSocket, `sendBeacon` and `RTCPeerConnection`. It fails on any request with a body, any cross-origin request, any socket/beacon/peer connection, or any URL over 2048 characters. User-initiated Google Drive transfer is outside that run by design.

Do not infer regulatory compliance, cryptographic export features, secure-erasure guarantees, or signed binaries unless a specific implementation and verification artifact proves them.

## Development

Requirements:

- Node.js 22+ (CI uses Node 24)
- pnpm 11.3.0

```bash
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:3000/` or `/app/`.

## Quality gates

One command defines "verified" locally and in CI:

```bash
pnpm prod:verify                 # static + real-Chromium tiers
pnpm prod:verify -- --no-browser # static tier only
pnpm prod:verify -- --network    # adds the live download/release contract
xvfb-run -a pnpm prod:verify -- --desktop  # adds the Electron runtime security smoke
```

It runs repository integrity, version sync, lint, Jest, DSP isolation, static
and runtime privacy checks, model and worklet integrity, provenance, the
production build, and every browser smoke (Engineer, Landing, shell guards,
runtime privacy), then writes `output/prod-verify/report.json` tagged with the
commit SHA. Individual commands (`pnpm lint`, `pnpm test`, `pnpm test:shell-qa`,
`pnpm test:privacy-runtime`, …) remain available.

CI: `.github/workflows/ci.yml` runs the gate on every PR and `main` push.
`deploy.yml` deploys only the head SHA a successful gate run passed, and
`release-build.yml` calls the gate on a pinned SHA before building the Android
AAB, which ships with `SHA256SUMS` and `release-manifest.json`. Android and
Windows packaging are not part of the local gate and are reported as
`NOT VERIFIED` there.

## Builds

```bash
pnpm build

# Android
pnpm android:build:win
# or on Unix
pnpm android:build

# Windows
pnpm setup:electron
pnpm build:electron
```

Generated build/native artifacts are not committed to git.

## Release validation

Download/release truth is centralized in:

- [`docs/DOWNLOADS.md`](docs/DOWNLOADS.md)
- [`docs/releases/PLATFORM_SYNC.md`](docs/releases/PLATFORM_SYNC.md)
- [`docs/releases/release-provenance.json`](docs/releases/release-provenance.json)

Validate live URLs and GitHub Release assets without downloading the large binaries:

```bash
pnpm downloads:validate
```

Validate provenance claims/schema:

```bash
pnpm provenance:validate
```

Strict mode is for a fully current, independently verified release set:

```bash
pnpm provenance:validate:strict
```

## Documentation

Start at [`docs/README.md`](docs/README.md).

Current docs are intentionally separated from point-in-time material under `docs/audits/`, `docs/archive/`, old release PDFs, and [`LEGACY.md`](LEGACY.md). Historical files are evidence of their recorded state and should not be silently rewritten to match current `main`.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Architecture/security rules in [`CLAUDE.md`](CLAUDE.md) take precedence over older design or audit documents.

## License

Proprietary / `UNLICENSED` as declared in `package.json`. All rights reserved unless the repository owner states otherwise.

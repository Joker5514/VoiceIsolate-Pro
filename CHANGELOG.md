# Changelog

All notable changes to VoiceIsolate Pro are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Release provenance (`docs/releases/release-provenance.json`) and
  `ModelManifest.js` byte/hash integrity validators (`pnpm provenance:validate`,
  `pnpm models:validate`).
- Canonical process-time Engineer configuration snapshots with revision-keyed
  stem caching and worker acknowledgement.
- Automated coverage for the Engineer processing configuration, gate lookahead,
  slider tick wiring, and static Vercel routing boundary.

### Changed

- Scoped MLWorker WebGPU fallback: per-session WASM pin on graph compile/OOM,
  worker-wide disable on device loss.
- Published v25.0.2 Android APK and Windows NSIS rebuilt from `0b791c2` (#784)
  on 2026-08-24T17:20Z; existing tag was clobber-updated, not moved.
- The shared Engineer rack now defaults to the complete control set on Web,
  Android, and Electron; Simple View remains an explicit persisted preference.
- Offline Engineer spectral controls now run in the existing ML STFT frame loop;
  stereo post-stem and export-only controls have explicit consumers.
- Documented Vercel `main` production / pull-request preview behavior and the
  optional Hugging Face publishing target without presenting it as a runtime
  model source.

### Fixed

- Restored all 66 range slider paths, including live gate lookahead, Live-Mix
  voice isolation / background suppression, mobile slider layout, tick
  attachment, and AudioParam bounds.
- Made fresh and durable ML output deterministic by applying the same
  post-stem cleanup to cloned raw stem artifacts; DSP fallback now invalidates
  stale retained stem pairs before playback.
- Gave Whisper Mode reset, lock, shared-state, and session-persistence parity
  with the range controls.
- Routed the canonical `ditherAmt` snapshot through Analysis Workspace export
  as well as Save Processed and Save to Drive; dither remains encoder-only.
- Removed the stale Android microphone permission and optional hardware feature;
  the native manifest now matches the upload-only product contract.
- Restored Vercel's static-only routing boundary: `api/` and `api-routes/` are
  excluded from production, so no unreachable serverless `/api` rewrite remains.
- Corrected the CI workflow's invalid job-level secret conditions so optional
  Vercel CLI deployment steps skip cleanly when repository secrets are absent.

## [25.0.2] - 2026-08-13

### Changed

- Published Web/PWA support with Android APK and Windows Electron installer
  release assets. The assets were refreshed on 2026-08-21.

[Unreleased]: https://github.com/Joker5514/VoiceIsolate-Pro/compare/v25.0.2...HEAD
[25.0.2]: https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.2

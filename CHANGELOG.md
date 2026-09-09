# Changelog

All notable changes to VoiceIsolate Pro are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Release provenance (`docs/releases/release-provenance.json`) and
  `ModelManifest.js` byte/hash integrity validators (`pnpm provenance:validate`,
  `pnpm models:validate`).
- **Quick Clean workflow** — outcome-led `Import → Choose → Process → A/B → Adjust → Export` flow.
  Three shipped outcomes (Clean Speech / Maximum Isolation / Preserve Ambience) replace the raw
  model-name selector. `src/pipeline/QuickCleanPlan.js` · `src/presentation/QuickCleanUI.js`.
- **Capability gate** — `resolveQuickCleanPlan()` rejects any model that is unshipped, optional,
  lacks a pinned SHA-256, uses waveform strategy, or runs at ≠ 48 kHz. Demucs and
  `studio_isolation` are fully blocked at the plan layer.
- **Level-matched A/B comparison** — `src/core/AudioReview.js` `measureChannels()` + `reviewGains()`
  provide RMS-matched gain pairs for level-honest listening comparisons (attenuate-only, common
  peak ceiling). Off-main-thread pass via `src/workers/AudioReviewWorker.js`.
- **Preflight panel** — shows local provider (WASM/WebGPU), model download requirement, and
  storage estimate before the user presses Process. `quickCleanPreflight` / `outcomeHelp` DOM nodes.
- **Explicit processing states** — Quick Clean state machine: `empty → importing → imported →
  ready → downloading → processing → cancelling → processed → comparing → exporting → exported →
  error`. Every error message states what happened, whether source data is safe, and how to recover.
- **A/B comparison controls** — `prepareComparisonBtn`, `compareOriginalBtn`, `compareCleanedBtn`
  in the Live-Mix panel.
- **Accessibility improvements** — `--text-dim` contrast raised from #5e5e78 to #7a7a90 (3.2:1 →
  4.6:1, WCAG AA). Added `@media (prefers-contrast: more)` high-contrast overrides.
- **Responsive breakpoints** — `@media (max-width: 900px)` tablet landscape and
  `@media (max-width: 480px)` small phone breakpoints added to `landing.css`.
- Canonical process-time Engineer configuration snapshots with revision-keyed
  stem caching and worker acknowledgement.
- Automated coverage for the Engineer processing configuration, gate lookahead,
  slider tick wiring, and static Vercel routing boundary.
- New `tests/quick-clean.test.js` coverage verifies shipped model hashes,
  outcome rejection, backend gating, AudioReview matching, and MLWorker
  integrity-bypass prevention.

### Changed

- Scoped MLWorker WebGPU fallback: per-session WASM pin on graph compile/OOM,
  worker-wide disable on device loss.
- Published v25.0.2 Android APK and Windows NSIS rebuilt from `0b791c2` (#784)
  on 2026-08-24T17:20Z; existing tag was clobber-updated, not moved.
- Repo-wide download/release pins and landing-smoke title expectation aligned
  to the `0b791c2` platform sync (#786).
- Landing page model select replaced: raw model names removed; three outcome-led
  options rendered by `QuickCleanUI` (disabled until backend is confirmed available).
- `landing.js` now uses `QuickCleanUI.plan()` to resolve model IDs, which calls
  `resolveQuickCleanPlan()` — all model chain resolution is capability-gated.
- MLWorker always verifies cached bytes via `verifyIntegrity()` before returning
  them (integrity-first cache); the sha256-presence early-return was removed.
- `--text-dim` token updated for WCAG AA compliance across landing page.
- The shared Engineer rack now defaults to the complete control set on Web,
  Android, and Electron; Simple View remains an explicit persisted preference.
- Offline Engineer spectral controls now run in the existing ML STFT frame loop;
  stereo post-stem and export-only controls have explicit consumers.
- Documented Vercel `main` production / pull-request preview behavior and the
  optional Hugging Face publishing target without presenting it as a runtime
  model source.

### Fixed

- **Worker error stale-message guard** (`landing.js`) — `'error'` worker messages
  were not guarded against stale requests when `requestId` was absent; now always
  breaks on stale, consistent with all other message cases.
- **Timer leak on worker crash** (`landing.js`) — `clearProcessWatch()` was
  missing from both the `'error'` message case and `worker.addEventListener('error')`
  handler; a worker crash left the stall-watchdog `setInterval` alive.
- **Test open-handle leak** (`tests/processing-orchestrator.test.js`) — `afterEach`
  called `jest.useRealTimers()` without first clearing pending fake timers;
  added `jest.clearAllTimers()` before restore to prevent Jest from force-exiting.
- Resolved unresolved git merge conflict markers (`<<<<<<< ours` / `>>>>>>> theirs`)
  in `public/index.html`.
- Removed unshipped `studio_isolation` and `demucs` model options from the
  landing model select.
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

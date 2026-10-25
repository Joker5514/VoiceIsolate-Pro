# Changelog

All notable changes to VoiceIsolate Pro are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Landing hero is “Bring the voice forward.” with the Signal Glass helix on the shared Web, Android-browser, and desktop shell. The filled action is the cyan pill. Upload, stem split, and Live-Mix are unchanged.

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
- Recorded published GitHub Release v25.0.3 (2026-09-09) separately from
  repository package 25.0.2. Pinned download URLs, sizes, and SHA-256 values
  match the live v25.0.3 assets. The Windows filename remains
  `VoiceIsolate-Pro-25.0.2-win-x64.exe`.
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

- **Edge loss in the fused ML STFT** - frames now start `N - hop` before the
  file and run past its end (reflect-padded), so the first and last ~40 ms of
  the clean stem keep full window coverage and the 50%-hop path no longer
  modulates at the hop rate. `SpectralCleanup.js` had the same framing and
  also silenced up to `hop - 1` tail samples. See
  `docs/audits/DSP_EXPORT_AUDIT_2026-10-11.md`. The fixed 8 ms edge fades
  were removed afterwards (F26 in `docs/audits/REPAIR_AUDIT_2026-10-12.md`),
  so a unit mask reconstructs the whole input, edge samples included.
- **Engineer WAV export freeze** - encoding reads each channel once, runs in
  time-budgeted chunks, honours the export job's Cancel, rounds to the nearest
  16-bit code and refuses exports past the 4 GB RIFF limit.
- MLWorker rejects non-48 kHz input to spectral-mask models instead of masking
  the wrong bands.
- **Mobile freeze on import** (4x-throttled Pixel 7 profile, 5 min stereo): the
  longest Landing import task fell from 10.3 s to 0.43 s and Engineer's from
  5.3 s to 0.67 s. Import analysis (`AutoAnalysis`) now yields, runs once per
  import instead of two (Landing) or three (Engineer) times, and is aborted when
  a new file arrives; whisper detection is linear instead of frames x segments.
  Engineer no longer decodes one pick twice. Channel extraction, stem-cache key
  hashing and the diarization transfer copy run in budgeted slices.
- **Selection drag freeze (Engineer)**: waveform peaks are computed once per file
  and width and drag redraws are coalesced per frame; a `pointermove` used to
  rescan the whole file twice.
- **Memory growth across files (Landing)**: crop/loop listeners were re-wired on
  every Process, each closure pinning that run's stems, and the session store's
  history kept 50 past sessions' PCM. Retained full-length buffers after 6
  import→Process cycles fell from 41 to 19 (flat from cycle 2). Raw no longer gets
  two extra clones per import; the stem cache has a device-tier byte budget.
- Spectrogram fallback layer paints one `ImageData` instead of one `fillRect` per
  device pixel, and reuses it for identical renders.

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

## [25.0.3] - 2026-09-09

### Changed

- Published GitHub Release v25.0.3. The release kept package version 25.0.2
  and the Windows installer name `VoiceIsolate-Pro-25.0.2-win-x64.exe`.
  Release notes identify source `main` @ `038b310`. That commit is an ancestor
  of later `main`; the published APK and EXE are not current `main`.

## [25.0.2] - 2026-08-13

### Changed

- Published Web/PWA support with Android APK and Windows Electron installer
  release assets. The assets were refreshed on 2026-08-21.

[Unreleased]: https://github.com/Joker5514/VoiceIsolate-Pro/compare/v25.0.3...HEAD
[25.0.3]: https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.3
[25.0.2]: https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.2

# Corrective Audit Report

## Baseline

| Field | Recorded value |
|---|---|
| Branch | `fix/corrective-audit-release-integrity` (created from container branch `work`) |
| Starting SHA | `3385ca3df7be5f49d1f2e22d5d45f4e17bd39f7c` (matches the known reviewed SHA) |
| Ending implementation SHA | `a5502b7` (the subsequent report-only commit does not change implementation) |
| `v25.0.2` tag source | `1cb37fd495cb80eaac369e028ad2c1fcae0a63ea`; the tag ref was absent locally, but the commit object and supplied reviewed provenance were present |
| Native artifact source | `17692f98e1023ea7b18b7bd8a5c374291ccb67f8` |
| Environment | Node `v24.15.0`; pnpm `11.3.0`; UTC |

Baseline worktree was clean. No remote was configured, so `git fetch --tags origin v25.0.2` could not refresh the absent local tag ref. The known tag commit object was independently resolvable in the repository.

## Corrected verdict

**CONDITIONAL GO** for merging the corrective code and documentation changes. **NO-GO for representing v25.0.2 Web, Android, and Windows as a synchronized release.** Release promotion remains gated on immutable Web deployment provenance, native rebuilds from the intended commit, SHA-256 publication for APK/EXE, and a passing `pnpm provenance:validate --strict`.

## Findings table

| ID | Status | Severity | Evidence | Change made | Tests | Residual risk |
|---|---|---:|---|---|---|---|
| REL-01 platform provenance conflation | confirmed | P0 release integrity | `docs/DOWNLOADS.md` called native packages the “same” shell; `docs/releases/PLATFORM_SYNC.md` said “Native = web”; tag, native, and reviewed-main SHAs differ | Added machine-readable per-platform provenance, removed unsupported parity wording, and added normal/strict validation | `tests/release-provenance.test.js`; `pnpm provenance:validate` | Web source SHA and native artifact hashes remain unknown; native artifacts remain stale |
| ML-01 default chain documentation drift | confirmed | P1 | Runtime `src/core/ml-defaults.js` defaults to BSRNN; `src/core/ModelManifest.js` marks Demucs optional/unshipped; previous `CLAUDE.md` called Demucs→RNNoise default/shipped | Corrected model table and chain text; validator imports runtime defaults and manifest to guard documentation | provenance validator tests; full Jest suite | Demucs remains installable only as an explicitly provisioned optional model |
| ML-02 global WebGPU downgrade | confirmed | P1 | `src/workers/MLWorker.js` previously assigned `BACKEND = 'wasm'` after one qualifying graph compile failure | Scoped compile/OOM fallback to a session key, retained WebGPU for other graphs, classified diagnostics, and treated device loss worker-wide | `tests/ml-worker-backend.test.js`; full Jest suite | Actual GPU-driver behavior still needs the physical device matrix; no performance claim is made |
| MOD-01 build-output integrity gap | confirmed | P1 release integrity | Runtime hashes existed, but `scripts/validate-onnx-models.js` primarily checked URL/content length and did not compare copied build bytes with `ModelManifest.js` | Added canonical source/build size+SHA validator and rewrite ownership checks; wired `models:validate` to require build output | `tests/model-integrity.test.js`; `pnpm models:validate` | Remote Blob bytes were not downloaded/hashes not asserted in this environment; status is unverified, not passed |
| SAM-01 remote-host P0 | disproven | none | Loopback enforcement and existing provider tests remain present | None | `pnpm test:sam` (23 tests) | Full packaged E2E remains defense-in-depth coverage |
| ML-03 permanent worker freeze | disproven | none | Existing initialization, warmup, processing and no-progress timeouts plus error/reset handling remain in `src/pipeline/StemSeparation.js` | None | Full Jest suite | Device-specific soak remains a coverage opportunity |
| UI-01 bogus sliders / missing groups / modes / progress | disproven | none | Structural validation reports 67 sliders and 32 stages; existing UI/tests retain groups, tiers, and progress machinery | None | `pnpm validate`; full Jest suite | Browser smoke was blocked by Playwright download access |
| MAINT-01 `colaSafeHop` duplication | partially valid | P3 | Similar helpers exist across classic-worker and core boundaries | Intentionally not changed: direct ESM reuse would violate the classic-worker import contract; a shared classic script needs separate design/review | Existing DSP and full Jest suites | Small maintenance duplication remains |
| MAINT-02 `LivePipeline` / `OverlapAddAccumulator` | partially valid | P3 | Referenced by tests and architecture but not established as current production ingestion | None; retained as reference/future architecture rather than deleting speculative code | Full Jest suite | Ownership could be clarified in a future architecture-only change |

## Release provenance matrix

| Platform | Public version | Source commit | Build timestamp | Artifact | SHA-256 | Test suite | URL | Status |
|---|---|---|---|---|---|---|---|---|
| Web | 25.0.2 | unknown | unknown | Vercel deployment | n/a/unknown | unknown for deployed artifact | `https://voice-isolate-pro.vercel.app/` | unknown |
| Android | 25.0.2 | `17692f98e1023ea7b18b7bd8a5c374291ccb67f8` | 2026-08-21T10:04:08Z | `VoiceIsolate-Pro-android-debug.apk` | unknown | `pnpm test:ci` claimed by build instructions; exact retained result unknown | pinned v25.0.2 GitHub Release URL | stale |
| Windows | 25.0.2 | `17692f98e1023ea7b18b7bd8a5c374291ccb67f8` | 2026-08-21T10:04:10Z | `VoiceIsolate-Pro-25.0.2-win-x64.exe` | unknown | `pnpm test:ci` claimed by build instructions; exact retained result unknown | pinned v25.0.2 GitHub Release URL | stale |

The canonical complete record is `docs/releases/release-provenance.json`.

## Changes implemented

- Added an explicit provenance schema and release consistency validator with a strict release gate.
- Corrected the ML source of truth to shipped BSRNN default, optional BSRNN+RNNoise maximum chain, and optional/unshipped Demucs.
- Reworked WebGPU fallback from worker-global compile-failure downgrade to per-session fallback, while preserving worker-wide fallback after device loss.
- Added source and build-output model size/SHA-256 validation against the sole `ModelManifest.js` registry and verified filename-preserving Vercel rewrites.
- Added targeted regression tests and updated the prior one-shot fallback marker test.

No UI behavior, live microphone path, slider inference trigger, credentials, binaries, tags, releases, or hosted audio processing were added or changed.

## Findings intentionally not implemented

- No SAM host change: current layered loopback enforcement disproves the P0 claim.
- No redundant worker heartbeat: existing timeout/watchdog/error/reset paths already cover the alleged permanent freeze; no remaining failure was reproduced.
- No slider removal, grouping system, workflow picker, or alternate progress UI: repository searches and validation confirm those features already exist.
- No `colaSafeHop` consolidation: the canonical worker is classic (`importScripts`) while core is ESM; an unsafe direct import would break packaging.
- No deletion of `LivePipeline` or `OverlapAddAccumulator`: tests and architecture still reference them and obsolescence was not proven.
- No speculative soak/device-matrix performance claim: these require physical hardware and measured evidence.
- No native rebuild or publication: forbidden by scope and the Windows build requires the appropriate Windows/signing environment.

## Validation results

| Command | Exit | Result and scope |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | Dependencies already current; source/tooling |
| `pnpm lint` | 0 | Passed with 8 pre-existing warnings and 0 errors; source |
| `pnpm validate` | 0 | Passed; 67 sliders, 32 stages, architecture/privacy structure; source |
| `pnpm version:check` | 0 | Passed version metadata checks; metadata only, not artifact parity |
| `pnpm worklets:verify` | 0 | Passed source worklet hashes; build copies not yet present at that point |
| `pnpm check:privacy` | 0 | Passed both local-only/privacy checks; source |
| `pnpm test:ci` (first corrective run) | 1 | 2868/2869 passed; exposed stale assertion expecting the removed global fallback marker |
| `pnpm test:ci` (second corrective run) | 1 | 2868/2869 passed; model test process had started before its build-detection fix was applied |
| `rm -rf build && pnpm test:ci` | 0 | 162 suites, 2869 tests passed; source. Jest emitted existing post-teardown/open-handle warnings |
| `pnpm build` | 0 | Web build output generated; shared input for Capacitor/Electron |
| `pnpm worklets:verify:build` | 0 | All 3 worklet source/build copies verified |
| `pnpm models:validate` | 0 | Four shipped models verified in source and build by size/SHA-256; rewrite ownership checked |
| targeted Jest command for changed subsystems | 0 | 3 suites, 7 tests passed before the full run |
| `pnpm test:sam` | 0 | 3 suites, 23 tests passed; source/Electron IPC package tests |
| `pnpm test:landing` | 1 | Not executed: Playwright Chromium download returned HTTP 403 (environment limitation) |
| `pnpm test:engineer` / `pnpm test:live` | interrupted/not run | Same mandatory Playwright browser install blocker; not reported as passing |

## Remaining work

1. Record the immutable source SHA and build timestamp for the deployed Web artifact.
2. Rebuild Android and Windows from the chosen release commit, retain exact test logs, compute SHA-256 values, update provenance, and make strict validation pass.
3. Run Landing, Engineer, and Live Playwright smokes where Chromium installation is allowed.
4. Run WebGPU tests on representative Intel/AMD/NVIDIA/Apple/Android devices, including real device-loss injection.
5. If remote model delivery assurance is required for the release, download each delivered Blob object and compare its SHA-256 with `ModelManifest.js`; do not substitute HTTP content length.

## Reproducible native build commands (not performed)

```bash
pnpm install --frozen-lockfile
pnpm mobile:sync-version
pnpm version:check
pnpm build
pnpm test:ci
pnpm worklets:verify:build
pnpm models:validate
pnpm android:build:win
pnpm setup:electron
pnpm build:electron
sha256sum dist/android/VoiceIsolate-Pro-android-debug.apk \
  dist/electron/VoiceIsolate-Pro-25.0.2-win-x64.exe
```

Publication remains a separate maintainer action and was deliberately not performed.

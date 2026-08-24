# Corrective audit report — release integrity

**Date:** 2026-08-24  
**Reviewed main:** `3385ca3df7be5f49d1f2e22d5d45f4e17bd39f7c`  
**Working branch:** `fix/corrective-audit-release-integrity`  
**Lost starting SHA:** `ab2fb81aa4b429edea3fa611bb356b72977e3ac1` was not present in any local clone, reflog, or GitHub. This report covers the reconstructed and reviewed implementation on current `main`.

## Verdict

| Gate | Verdict |
|------|---------|
| Code change (provenance validator, model integrity, scoped WebGPU fallback, docs) | **CONDITIONAL GO** |
| Claiming synchronized v25.0.2 platform artifacts | **NO-GO** |

Published Android/Windows assets are stale (`17692f98e1023ea7b18b7bd8a5c374291ccb67f8`, 2026-08-21T10:04Z). Web production SHA is unknown and is **not** inferred from repository HEAD. Tag v25.0.2 was not moved. No binaries, credentials, or hosted processing paths were changed.

## Confirmed defects (fixed)

1. `CLAUDE.md` documented Demucs as the default isolation chain. Shipping default is `['bsrnn_vocals']`; optional maximum is `['bsrnn_vocals', 'rnnoise']`; Demucs is optional/unshipped.
2. Authoritative docs implied Web / Android / Windows / `main` / v25.0.2 were the same published build. Native assets lag current `main`.
3. `MLWorker` mutated process-global `BACKEND` to WASM after one WebGPU compile failure, which incorrectly changed queueing, batching, and diagnostics for other sessions.
4. No schema-driven release provenance file or validator existed.
5. `pnpm models:validate` was a URL HEAD checker against a second registry, not `ModelManifest.js` byte/hash verification.

## Documentation drift (corrected)

- `CLAUDE.md` §4 model table and default chain.
- `CLAUDE.md` native binary pin vs current `main`.
- `docs/DOWNLOADS.md` platform matrix: packaging `build/` vs published SHA.
- `docs/releases/PLATFORM_SYNC.md` sync verdict.
- New `docs/releases/release-provenance.json`.

## Missing coverage (added)

- Provenance schema tests, including mutation-style malformed records.
- Model integrity negative tests (missing, truncated, hash-mismatched, `--require-build`).
- Behavioral MLWorker WebGPU fallback tests (probe, per-session pin, device loss, queues, batch size, diagnostics).

## Performance opportunities

None claimed. No timing measurements were collected. Batch-size changes after WASM fallback are correctness (avoid WebGPU-sized batches on a WASM session), not a measured speedup.

## Speculative work (not implemented)

- Rebuilding or uploading APK/EXE.
- Moving or republishing v25.0.2.
- Inferring the live Vercel production SHA from git HEAD.
- Downloading remote Blob objects to claim remote hashes.
- Changing credentials, hosted processing, or binary assets.

## Tests that passed

| Command | Exit | Notes |
|---------|------|-------|
| `pnpm install --frozen-lockfile` | 0 | lockfile up to date |
| `pnpm lint` | 0 | 0 errors; 8 pre-existing warnings in untouched files |
| `pnpm validate` | 0 | all structural checks |
| `pnpm version:check` | 0 | 25.0.2 / 250002 aligned |
| `pnpm provenance:validate` | 0 | schema OK; 3 notices (web unknown, android stale, windows stale) |
| `pnpm worklets:verify` | 0 | 3 worklets |
| `pnpm check:privacy` | 0 | upload-only / no cloud audio |
| `pnpm test:ci` | 0 | **162 suites, 2893 tests** |
| `pnpm build` | 0 | after `rm -rf build` |
| `pnpm worklets:verify:build` | 0 | build copies in sync |
| `pnpm models:validate` | 0 | shipped: vad, vad_int8, rnnoise, bsrnn_vocals |
| `node scripts/validate-model-integrity.mjs --require-build` | 0 | source + `build/` hashes match |
| `pnpm test:sam` | 0 | 3 suites, 23 tests |
| `pnpm test:engineer` | 0 | all Engineer RT checks; Chromium available |
| `pnpm test:live` | 0 | pipeline PASS; Chromium available |

Targeted new suites (included in `test:ci`): `tests/release-provenance.test.js`, `tests/model-integrity.test.js`, `tests/ml-worker-webgpu-fallback.test.js`.

## Tests that failed during development

1. Provenance doc scanner treated “Do **not** claim … the same build” in `PLATFORM_SYNC.md` as a positive same-build claim. Fixed by sentence-level negation handling.
2. One WebGPU test read `sandbox.BACKEND` (a `let` binding, not a sandbox property). Fixed by reading via `vm.runInContext`.

Those failures are not present in the final `pnpm test:ci` run.

## Tests that failed in the final run

| Command | Exit | Notes |
|---------|------|-------|
| `pnpm test:landing` | 1 | Chromium **did install and run**. 1 check failed: page title is `VoiceIsolate Pro — Local voice isolation · Stem-Split & Live-Mix`, smoke script expects `VoiceIsolate Pro — Stem-Split & Live-Mix`. Unrelated to this PR; landing HTML was not changed. **Not recorded as passed.** |

## Tests not run because of environment limitations

None of the mandated commands were skipped. Playwright Chromium installed successfully; landing is a functional failure, not an install blocker.

`pnpm provenance:validate --strict` / `pnpm provenance:validate:strict` exits 1 by design (stale/unknown natives). That is the release gate, not a developer-suite failure.

## Review comments

No existing PR or inline review comments were found. Commit `ab2fb81` was not on any remote branch.

## Remaining release-provenance / native rebuild work

1. Independently verify the Vercel production deployment SHA (do not copy `main` HEAD).
2. Rebuild Android and Windows from current `main`.
3. Upload rebuilt assets to the **existing** v25.0.2 tag (`--clobber`). Do not move the tag.
4. Update `docs/releases/release-provenance.json` to `current` with full SHAs and hashes.
5. Re-run `pnpm provenance:validate --strict` until it exits 0.

## Exact native rebuild commands not performed

```bash
pnpm android:build:win
pnpm build:electron
gh release upload v25.0.2 \
  dist/android/VoiceIsolate-Pro-android-debug.apk \
  dist/electron/VoiceIsolate-Pro-25.0.2-win-x64.exe \
  --clobber
```

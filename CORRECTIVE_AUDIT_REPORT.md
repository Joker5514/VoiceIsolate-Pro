# Corrective audit report — release integrity

**Date:** 2026-08-24  
**Original reviewed main:** `3385ca3df7be5f49d1f2e22d5d45f4e17bd39f7c`  
**Merged code / product SHA:** `0b791c2001d89f7005ea67d7b8ecefd68c8e82d3` (#784)  
**Pin-alignment merge:** `30f40d6ca2a2526e96164791d9b9e1e92b929e21` (#786)  
Later docs-only commits on `main` do not require a native rebuild. Product SHA remains `0b791c2`.

## Verdict

| Gate | Verdict |
|------|---------|
| Code change (provenance validator, model integrity, scoped WebGPU fallback, docs) | **GO** — merged as #784 |
| Claiming synchronized v25.0.2 platform artifacts | **GO** as of 2026-08-24T17:20Z at product SHA `0b791c2` |

Web production, Android APK, and Windows NSIS were rebuilt from `0b791c2`. Tag v25.0.2 was not moved. Native assets were clobber-uploaded to that existing tag.

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

## Speculative work

Completed after the original review:

- Rebuilding and clobber-uploading APK/EXE to existing tag v25.0.2 (tag not moved).
- Recording the production Vercel SHA from GitHub Actions Deploy Production of `0b791c2`.

Still not implemented:

- Inferring the live Vercel production SHA from git HEAD without deploy evidence.
- Downloading remote Blob objects to claim remote hashes.
- Changing credentials, hosted processing, or moving tag v25.0.2.

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

## Tests that failed in the original review run

| Command | Exit | Notes |
|---------|------|-------|
| `pnpm test:landing` | 1 | Chromium ran. Page title is `VoiceIsolate Pro — Local voice isolation · Stem-Split & Live-Mix`; smoke originally expected `VoiceIsolate Pro — Stem-Split & Live-Mix`. Landing HTML was not changed in #784. **Not recorded as passed at review time.** |

## Tests not run because of environment limitations

None of the mandated commands were skipped. Playwright Chromium installed successfully; the original landing failure was a title-string mismatch, not an install blocker.

`pnpm provenance:validate --strict` **exits 0** after the 2026-08-24 native rebuild and #785 pin.

## Remaining release-provenance / native rebuild work

Completed after #784:

1. Production Vercel deploy of `0b791c2` (GitHub Actions Deploy Production run 32755579053).
2. `pnpm android:build:win` and `pnpm build:electron` from `0b791c2`.
3. `gh release upload v25.0.2 … --clobber` (tag not moved).
4. Provenance records marked `current` in #785.
5. `pnpm provenance:validate --strict` exits 0.
6. Landing smoke title aligned to the shipped `<title>` and remaining download/docs pins aligned in #786 (`30f40d6`).
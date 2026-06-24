# Audit Results

> **Up to date as of 2026-06-21** — see [`docs/AUDIT-REPORT-2026-06-21.md`](docs/AUDIT-REPORT-2026-06-21.md)
> for the current comprehensive audit. Headline: all gates green (validate ✓, 1836 tests ✓,
> lint 0 errors, both model hashes verified, architecture compliant). One material finding:
> two **moderate** transitive dependency CVEs (`qs`, `ip-address`) fixable via `pnpm.overrides`.
> The notes below are the historical record of the earlier `public/app/` cleanup pass.

## Found
- Redundant `voice-isolate-processor.js` AudioWorklet registered a second processor name beside the canonical `dsp-processor.js`.
- Single-pass STFT boundaries were implicit in several DSP paths rather than explicitly marked.
- `model-cdn-loader.js` and `ml-worker.js` still contained external-model-delivery logic and Vercel Blob fallbacks.
- `vip-fixes.js` carried several runtime patches that were not annotated in source.

## Fixed
- Removed the redundant `public/app/voice-isolate-processor.js` worklet and its service-worker / Vercel / test references.
- Kept `public/app/dsp-processor.js` as the canonical live worklet and loaded `ring-buffer.js` before orchestrator bootstrap in `index.html`.
- Added `SINGLE-PASS STFT BOUNDARY` comments at forward/inverse transform call sites in the canonical DSP paths.
- Converted model loading to same-origin `/app/models/*.onnx` references in `model-cdn-loader.js`, `ml-worker.js`, and the root model manifest.
- Verified `analytics.js` is already local-only and left it unchanged.
- Annotated patched source locations for `vip-fixes.js` and added `TODO-vip-merge.md`.
- Documented live/offline/batch ownership at the top of the orchestrator files.
- Confirmed `paywall.js` only performs checkout network activity after explicit user action and documented that constraint inline.

## Manual Follow-up
- Several repository docs outside the runtime/test surface still mention `voice-isolate-processor.js`; they should be reconciled in a docs-only cleanup pass.
- `vercel.json` still has deployment-time model routing concerns that may warrant a separate product decision if every model must be physically repo-committed rather than same-origin routed.
- The repository still has pre-existing lint warnings in `public/app/app.js` and `public/app/ml-worker.js`; the audit fixed the one blocking `no-unreachable` error encountered during baseline linting.

# STFT Remediation — 2026-08-04

Follow-up to the Enhanced DSP/STFT/SAM audit (v3) on `origin/main`.

## Changes shipped in this worktree

| Item | Detail |
|------|--------|
| **`src/core/stft-math.js`** | Shared periodic Hann, frameCount, COLA helpers, `STFT_PRESETS`, soft-mask util, Engineer geometry resolver |
| **SpectralCleanup** | Uses `periodicHann` + canonical frameCount (was symmetric N−1) |
| **UniversalSourceMatrix** | Uses `periodicHann` + stft-math framing (was symmetric N−1) |
| **Engineer `_spectralStageAsync`** | Desktop hop **FFT/4 (75%)** instead of fixed 1024 (50% on 2048) |
| **fft-bridge** | Frame count aligned with DSPCore (`floor((L−N)/H)+1`) |
| **audio-config** | Re-exports STFT presets / periodicHann |
| **scripts/check-dsp-isolation.js** | Fails on symmetric Hann in STFT owners |
| **Tests** | `tests/stft-math.test.js`, `tests/stft-cola-masks-pipeline.test.js` + invariant/speed updates |

## Tests run (green)

```
tests/stft-math.test.js
tests/stft-cola-masks-pipeline.test.js
tests/stft-roundtrip-sine.test.js
tests/fft-bridge.test.js
tests/spectral-cleanup-core.test.js
tests/architectural-invariants.test.js
tests/engineer-process-speed.test.js
tests/dsp-core.test.js
tests/universal-source-matrix.test.js
tests/overlap-add.test.js
tests/dsp-contracts.test.js
```

**Result:** 11 suites, 234 tests passed. `scripts/validate.js` and `scripts/check-dsp-isolation.js` passed.

## Follow-ups completed in same PR

1. **`src/core/stft-budget.js`** — process-level STFT owner budget + `planProcessSpectral`.
2. Budget hooks: SpectralCleanup / USM / Engineer Process (`globalThis.__vipStftBudget`).
3. **Demucs honesty** — `optional: true`, not in DEFAULT_MODELS; IsolationMode docs; models README.
4. **USM residual** — NMF path keeps `residual / other` stem labeled.
5. **Prompted Isolation** mode on IsolationModeSelector (`usmMode: 'query'`, offline-only).

## Still open (future)

1. Full Process wiring to skip Engineer spectral when USM-only prompted path is selected.
2. Optional Demucs ONNX delivery via LFS/release assets.
3. offline-processor Blackman–Harris unification with periodic Hann presets.
4. Visual SAM / span prompt UI beyond mode registration.

## SAM decision (unchanged)

- **Do not** attach SAM to WhisperHunter.
- **Do** extend USM offline `mode: 'query'` + residual stems for Prompted Isolation.

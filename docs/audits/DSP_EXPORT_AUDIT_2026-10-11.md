# DSP and export correctness audit (2026-10-11)

Supplement to [MASTER_AUDIT_2026-10-06.md](MASTER_AUDIT_2026-10-06.md). Scope:
the shipped offline STFT path, the core spectral cleanup module, and the
Engineer WAV export. Measurements are from Node 22 and the pinned Playwright
Chromium in a Linux container. Nothing here is a listening test.

## Summary

- The fused ML STFT dropped audio at both file edges. With a unit mask the
  first and last ~40 ms reconstructed at -4.6 to -5.5 dB error. It is now
  float32-exact (about -139 dB) at both 75% and 50% overlap.
- `SpectralCleanup.js` had the same edge loss and also silenced up to
  hop - 1 tail samples. Same fix.
- Engineer WAV export wrote the whole file in one main-thread task, calling
  `getChannelData()` once per sample, and truncated instead of rounding. It
  is now 3.3x faster per sample and time-budgeted and cancellable.

## Issue ledger

| # | Symptom | Evidence | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|
| 1 | Clean stem starts and ends quieter than the input; noise stem carries speech onsets | Unit-mask probe on `runFusedSpectralMaskChain`: samples 384-2048 error -4.6 dB, last 2048 error -5.5 dB (len 48 000) | Frames started at sample 0 and stopped at the last window, so edge samples had partial Hann² coverage; the half-peak OLA floor then attenuated them | Frames start `N - hop` before the file and run past its end, reflect-padded. Floor lowered to 0.25 × peak so it never clips the 50%-hop Hann² dip | `tests/mlworker-ola-edges.test.js` (10 of 16 fail on the old code) | Fixed, verified |
| 2 | 50%-hop path (mobile, files > 3 min) modulated at the hop rate | Steady-state identity error -82.6 dB, max 5.4e-4 | Hann² sum at 50% overlap dips to exactly half its peak; the 0.5 × peak floor clipped it | Same floor change | Same test, mobile UA case | Fixed, verified |
| 3 | `SpectralCleanup` silenced the tail and attenuated edges | Code: `floor((L - N) / H) + 1` frames left up to H - 1 samples uncovered | Same framing defect | Full-coverage reflect-padded framing in `forwardSTFT`, `overlapProcess` and the noise-floor pass | `tests/spectral-cleanup-core.test.js` "full-coverage framing" (fails on old code) | Fixed, verified. Module is not spawned by a production entry point today |
| 4 | Engineer "Save processed" and "Save original" froze the tab | Chromium: 670 ms per stereo minute before, 200 ms after hoisting; a 15 min file was about 10 s in one task | `getChannelData(ch)` called per sample; whole file encoded synchronously | Hoisted channel views; encoding runs through `processInChunks` with the export job's `AbortSignal` | `tests/engineer-wav-export.test.js` (chunk seams, one call per channel, abort) | Fixed, verified in unit test and `engineer-upload-smoke` real download |
| 5 | 16-bit quantisation had a 2-LSB dead zone around zero | `setInt16` truncates toward zero | No rounding before `setInt16` | `Math.round` in `app.js`, `ExportManager.encodeWav`, `AudioEncoderWorker` | `tests/engineer-wav-export.test.js` rounding case | Fixed |
| 6 | Exports over 4 GB would write a wrapped RIFF header | uint32 size fields | No size check | Engineer encoder throws a clear `RangeError` | `tests/engineer-wav-export.test.js` | Fixed in Engineer path only |
| 8 | Opening onset attenuated as reverb when dereverb is on (introduced and fixed in this PR's review) | Tone from sample 0, dereverb at full: Engineer -5.03 dB, `SpectralCleanup.dereverb` -1.77 dB over the first 40 ms | Reflected pre-roll frames seeded the reverb-tail history with the opening's mirror | Pre-roll frames are processed but never update the tail (`applyFrame(..., preRoll)`, SpectralCleanup `tail`/`ring`). Now -0.16 dB and -0.01 dB | `mlworker-ola-edges` Engineer dereverb case, `spectral-cleanup-core` pre-roll cases | Fixed, verified |
| 9 | Short clips zero-filled after one reflection | 3000-sample clip: padded index 6143 mapped to -145 → 0 | Single-bounce reflection | Periodic reflection with period 2(len-1); one-sample clips repeat their sample | Constant-clip frame test (1, 2, 3000, 4096 samples) | Fixed, verified |
| 7 | A non-48 kHz buffer sent to a spectral model would be masked in the wrong bands, silently | Masks are trained on fixed bin frequencies | Worker trusted the host's rate | `processRequest` rejects a mismatched rate with an actionable error. All current hosts resample first | `tests/mlworker-ola-edges.test.js` rate contract | Fixed (guard) |

## Verified invariants

| Invariant | How verified |
|---|---|
| Unit mask reconstructs to float precision at 75% and 50% overlap, lengths 1, 3000, 4096, 48 000, 96 777 | Unit test, max abs error < 1e-5 excluding the intentional 8 ms edge fades |
| Output length equals input length; zero-length input returns empty; zero mask returns exact silence | Unit test |
| Impulse stays at its sample index | Unit test |
| Engineer WAV header sizes, channel count, rate, interleaving across 48 000-sample chunk seams | Unit test |
| One forward and one inverse STFT per channel on the fused path | Unchanged; existing `single-stft-assert` and fused-path tests pass |

## Audio quality gate

`pnpm test:quality` passes. Re-measured against `quality-baseline.json`:
14 of 66 metrics moved, largest change 0.05 dB, all within the 0.5 dB
tolerance. Clean-speech metrics did not move. The noisy fixtures lost
0.01-0.05 dB of SI-SDR delta because edge noise is no longer attenuated by the
framing defect. The baseline was not re-pinned.

## Observed but unchanged

- The fused path applies a fixed treble taper to the mask: up to -6.9 dB at
  24 kHz above about 8.4 kHz. It is pinned by the quality gate. That removed
  content lands in the noise stem.
- The fused path fades the first and last 8 ms of the clean stem by design.
  (Removed later by F26 in `REPAIR_AUDIT_2026-10-12.md`.)
- `ExportControls` / `ExportOrchestrator` offer MP3 through `lamejs`, which is
  not a dependency, so MP3 always fails there. No production entry point
  mounts these modules. The shipped exports are WAV and video remux.
- The legacy Engineer DSP fallback (`app.js` `_spectralStageAsync` with
  `DSPCore.forwardSTFT`) has the same edge/tail framing defect. It runs only
  when ML fails. It was not changed: its noise-floor estimator scans all
  frames, so padding needs a separate measured change.
- `ExportManager.encodeWav` (Google Drive save) is still synchronous. It now
  rounds but does not yield.
- Demucs (unshipped) resamples 48 to 44.1 kHz with linear interpolation and
  no anti-alias filter.

## Commands run

| Command | Result |
|---|---|
| `pnpm lint` | 0 errors, 8 pre-existing warnings |
| `pnpm validate` | All checks passed |
| `pnpm test` | 209 suites, all passing (baseline 207 / 3571); see the PR for the final count |
| `pnpm test:quality` | PASS |
| `node scripts/live-smoke.cjs` | PASS |
| `node scripts/landing-smoke.cjs` | PASS |
| `node scripts/engineer-calibration-smoke.cjs` | PASS |
| `node scripts/engineer-upload-smoke.cjs` | PASS, real WAV download matches the playback graph within 1.8e-5 |

## Manual checks still outstanding

Listening was not possible in this environment. A/B steps:

1. Open `/app/`, load a clip that starts and ends mid-word.
2. Process with the default chain. Solo the clean stem.
3. Compare the first and last half second against the previous release.
   The onset and final syllable should be present at full level, apart from
   the 8 ms fade.
4. Save processed on a 10+ minute file. The tab should stay responsive and
   the overlay Cancel should stop the export.

# Remediation — clicks, audit gaps, Clear Local Data (2026-08-12)

## Root causes of residual clicking / popping

1. **Adaptive ML hop could equal `fftSize` (zero overlap)** on long mobile files  
   → hard frame boundaries after magnitude masks = zipper / pop.  
   **Fix:** `colaSafeHop` clamps hop to `{fft/4, fft/2}` only (COLA-safe for periodic Hann).

2. **OLA normalize divided by tiny edge norms**  
   → residual amplification at file start/end.  
   **Fix:** floor divisor at `0.5 * max(window² sum)` in MLWorker, DSPCore iSTFT, OverlapAdd.

3. **`removeClicks` existed but was never called** in Engineer Pass 1.  
   **Fix:** wired after DC offset; first-difference detector + max run cap; 8 ms edge fades.

4. **Fused ML masks had no temporal smoothing** → frame-to-frame AM.  
   **Fix:** one-pole `maskSmooth` across frames.

5. **Target-speaker gain** used a short box smoother only.  
   **Fix:** `smoothGainCurve` (15 ms + rate limit); diarization cluster fusion.

6. **PlaybackMixer speaker automation** used only `setTargetAtTime`.  
   **Fix:** 12 ms `linearRampToValueAtTime` at segment boundaries.

## Audit items addressed

| Item | Status |
|------|--------|
| Click / discontinuity artifacts | Fixed (above) |
| Target-speaker path | Mel voiceprint shipping; diarization fusion; **honest docs** (not ECAPA yet) |
| Single-STFT | Fused spectral path + `stftCounts` + CI guards; scope = compatible chains only |
| Per-speaker PlaybackMixer UI | Already present (SpeakerControls); ramps hardened |
| Clear Local Data | New `ClearLocalData.js` + Landing/Engineer buttons |
| Backend status | Landing privacy line + existing Engineer ORT pills |
| Docs honesty | CLAUDE.md §7, README Pass 2 claims |

## Tests added

- `tests/audio-click-fix.test.js`
- `tests/clear-local-data.test.js`
- `tests/target-speaker-path.test.js`
- `tests/single-stft-assert.test.js`

## Still partial / future

- ECAPA-TDNN ONNX in `ModelManifest` + worker extract
- Quantitative SI-SDR/STOI release gate corpus (harness scaffold not in this PR)
- axe-core full a11y suite (keyboard paths partially covered by existing tests)

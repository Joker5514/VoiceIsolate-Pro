# Performance and quality pass (2026-10-07)

| Field | Value |
|---|---|
| Base commit | `main` @ `09317f9` (#836) |
| Environment | Linux container, 4 cores, Node 22.22.0, pnpm 11.3.0, Chromium (Playwright), onnxruntime-web WASM. No GPU, no Android SDK, no Windows, no Firefox/Safari. |
| Prior audit | `MASTER_AUDIT_2026-10-06.md`. Its findings were re-verified, not assumed. |

Labels: **VERIFIED** (measured here), **OBSERVED** (read in code), **INFERRED** (reasoned, not measured), **NOT VERIFIED**.

---

## A. Executive assessment

- **Shipped isolation made most noisy inputs worse, and still does on some.** First objective measurement in the repo (SI-SDR). On held-out recorded speech both chains lowered SI-SDR in 4 of 6 noisy conditions (default: -4.7 dB at white noise 10 dB SNR). Two inference-calibration fixes (training-contract input scaling, mask exponent 0.5) raised SI-SDR in all 7 held-out conditions (6 noisy plus clean preservation) for both chains. The default chain is still negative on 3 of 6 noisy conditions. The networks are the limit.
- **The Engineer DSP fallback was effectively broken on long files.** 5 min of stereo took 307 s with one 31.4 s frozen main-thread task. Now 33.7 s with a 1.7 s worst task (VERIFIED, Chromium).
- **A quality gate now runs in `prod:verify`.** 66 pinned metrics (SI-SDR, speech level, fricative-band level, noise reduction) through the real `MLWorker.js` and shipped models; CI fails if any drops more than 0.5 dB.

What works: ML path throughput (5 min stereo in 13 to 16 s, RTF 0.044 to 0.055, VERIFIED), worker cleanup, silence handling, model integrity, Landing export parity (prior smoke). What is fragile: model quality, the fallback spectral stage (still main thread), CI execution on GitHub (CI-001, unchanged, NOT VERIFIED here).

---

## B. Execution architecture (production paths)

```
main thread (app.js / landing.js)                     workers
───────────────────────────────────                   ─────────────────────────────────────────────
file → decode (native) → resample (OfflineAudioCtx)
  │ mid = (L+R)/2 (chunked)                     ─────► MLWorker.js (classic, persistent)
  │                                transfer             fetch → SHA-256 → IndexedDB / Electron fs cache
  │                                                     ORT session per model, reused (WebGPU → WASM)
  │                                                     ONE STFT (4096, hop 1024/2048, real FFT)
  │                                                       frame-max normalised mags → model(s)
  │                                                       mask = Π mask_i^0.5 → smooth → HF taper
  │                                                       → EngineerSpectralControls.applyFrame
  │                                                     ONE iSTFT (WOLA) → clean; noise = in − clean
  │ ◄──────────────────────────────── transfer ─────────
  │ stereo expand, post-stem, dewhistle (chunked)
  │ PlaybackMixer (AudioBufferSource → gains/EQ/comp
  │   → vip-gate / vip-deesser AudioWorklets)  ───────► audio rendering thread
  │ export = PlaybackMixer.renderMix (OfflineAudioContext)
  │
  │ ML failed → DSP fallback:
  │   condition (DC, clicks, gate, de-ess)       ─────► /app/dsp-worker.js   (NEW, transfer in/out)
  │   _spectralStageAsync (STFT 2048/512)          main thread, budgeted yields (CHANGED)
  │   EQ / compressor / limiter                  ─────► /app/dsp-worker.js   (NEW)
  │
  └ analysis (post-Process, idle)                ─────► FullAnalysisWorker, DiarizationWorker, USMWorker
Electron: same build/ over vip://app, preload IPC for open/save/model cache.   Android: same build/ in WebView.
```

---

## C. Baseline vs final performance (Chromium, headless, 4-core container)

Stereo 48 kHz synthetic tone, `scripts/perf/perf-harness.cjs`. Timings vary about ±20% run to run on this machine; ML-path rows are medians of 3.

| Scenario | Metric | Before | After | Delta |
|---|---|---|---|---|
| Engineer DSP fallback (`--no-ml`), 60 s | total Process | 60.4 s | 8.4 s | -86% |
| | RTF | 1.007 | 0.141 | |
| | longest main-thread task | 5,997 ms | 291 ms | -95% |
| Engineer DSP fallback (`--no-ml`), 300 s | total Process | 307.4 s | 33.7 s | -89% |
| | RTF | 1.025 | 0.112 | |
| | longest main-thread task | 31,359 ms | 1,730 ms | -94% |
| Engineer ML, 300 s | `ml_isolation` stage | 13.5 / 16.2 / 16.4 s | 13.1 / 16.0 / 16.2 s | within noise |
| Engineer ML, 300 s | longest main-thread task | 180 ms | 196 to 408 ms | within noise |
| Landing ML, 300 s | total Process | 33.8 s | 31.7 s | within noise |
| Landing ML, 300 s | peak RSS (Chromium tree) | 2,905 MB | 2,933 MB | within noise |
| Engineer ML, 300 s | peak RSS | 2,337 MB | 2,374 to 2,407 MB | within noise |

Model load and cold vs warm inference were not separated in the browser runs. Node WASM single-thread BSRNN: 0.287 ms per frame (prior audit, not re-measured). WebGPU: NOT VERIFIED (no GPU).

---

## D. Audio quality matrix

### D.1 Recorded speech, held out (VERIFIED)

LibriSpeech utterance 2 plus three 20 s LibriVox excerpts (public domain), 48 kHz mono, -22 dBFS. Mean SI-SDR delta in dB (clean row: absolute SI-SDR vs input). Audio not committed.

| Condition | Default before | Default after | Maximum before | Maximum after |
|---|---|---|---|---|
| clean (preservation) | 6.80 | 11.33 | 3.77 | 8.24 |
| white 10 dB | -4.66 | -1.23 | -6.51 | -2.39 |
| white 0 dB | -0.19 | 1.80 | 2.23 | 5.69 |
| HVAC 0 dB | 2.35 | 2.59 | 0.93 | 2.61 |
| music 5 dB | -2.46 | -0.92 | -5.05 | -2.04 |
| babble 5 dB | -2.31 | -0.70 | -5.10 | -2.34 |
| 50 Hz hum 5 dB | 1.27 | 2.82 | -1.98 | 0.83 |

Calibration set (tuned on, not held out): 3 LibriSpeech utterances × {clean, white 5, HVAC 5, music 0, hum 10}. Sweep in `docs/guides/AUDIO_QUALITY.md`.

### D.2 Synthetic fixture matrix, 6 s (VERIFIED, `pnpm quality:matrix`)

| Scenario | Profile | Metric | Before | After | Delta |
|---|---|---|---|---|---|
| clean-speech | landing | SI-SDR vs input dB | 5.0 | 7.4 | 2.4 |
| clean-speech | engineer | SI-SDR vs input dB | 4.6 | 6.9 | 2.3 |
| clean-speech | maximum | SI-SDR vs input dB | 3.1 | 5.1 | 2.1 |
| white-5db | landing | SI-SDR delta dB | -2.6 | -0.6 | 2.0 |
| white-5db | engineer | SI-SDR delta dB | -2.3 | -0.3 | 2.0 |
| white-5db | maximum | SI-SDR delta dB | -0.8 | 1.2 | 2.0 |
| hvac-5db | landing | SI-SDR delta dB | -0.8 | 0.0 | 0.8 |
| hvac-5db | engineer | SI-SDR delta dB | -0.9 | 0.1 | 1.0 |
| hvac-5db | maximum | SI-SDR delta dB | -1.7 | -0.3 | 1.4 |
| hum-10db | landing | SI-SDR delta dB | -3.6 | -2.1 | 1.5 |
| hum-10db | engineer | SI-SDR delta dB | -3.9 | -2.3 | 1.7 |
| hum-10db | maximum | SI-SDR delta dB | -5.5 | -4.0 | 1.4 |
| music-0db | landing | SI-SDR delta dB | -2.4 | -1.5 | 0.9 |
| music-0db | engineer | SI-SDR delta dB | -2.4 | -1.4 | 1.0 |
| music-0db | maximum | SI-SDR delta dB | -2.9 | -1.9 | 1.0 |
| babble-0db | landing | SI-SDR delta dB | -1.9 | -1.2 | 0.7 |
| babble-0db | engineer | SI-SDR delta dB | -2.0 | -1.4 | 0.7 |
| babble-0db | maximum | SI-SDR delta dB | -2.2 | -1.7 | 0.5 |
| reverb-0.5s | landing | SI-SDR delta dB | -2.4 | -1.3 | 1.0 |
| reverb-0.5s | engineer | SI-SDR delta dB | -2.5 | -1.4 | 1.1 |
| reverb-0.5s | maximum | SI-SDR delta dB | -3.9 | -2.5 | 1.4 |
| whisper-clean | landing | SI-SDR vs input dB | 10.1 | 11.8 | 1.7 |
| whisper-clean | engineer | SI-SDR vs input dB | 9.6 | 11.1 | 1.5 |
| whisper-clean | maximum | SI-SDR vs input dB | 3.2 | 7.0 | 3.9 |
| whisper-white-10db | landing | SI-SDR delta dB | 0.0 | 1.0 | 0.9 |
| whisper-white-10db | engineer | SI-SDR delta dB | 0.2 | 1.3 | 1.1 |
| whisper-white-10db | maximum | SI-SDR delta dB | -4.1 | -1.1 | 2.9 |
| whisper-music-5db | landing | SI-SDR delta dB | 1.4 | 0.8 | **-0.5** |
| whisper-music-5db | engineer | SI-SDR delta dB | 1.8 | 1.4 | **-0.3** |
| whisper-music-5db | maximum | SI-SDR delta dB | -6.0 | -2.4 | 3.6 |
| quiet-hum | landing | SI-SDR delta dB | -3.6 | -2.1 | 1.5 |
| quiet-hum | engineer | SI-SDR delta dB | -3.9 | -2.3 | 1.7 |
| quiet-hum | maximum | SI-SDR delta dB | -5.4 | -4.0 | 1.4 |
| overlap-2spk | landing | SI-SDR delta dB | -2.7 | -1.7 | 1.0 |
| overlap-2spk | engineer | SI-SDR delta dB | -3.1 | -2.0 | 1.0 |
| overlap-2spk | maximum | SI-SDR delta dB | -1.9 | -2.0 | **-0.1** |
| clipped | landing | SI-SDR vs input dB | 6.3 | 8.7 | 2.3 |
| clipped | engineer | SI-SDR vs input dB | 5.7 | 7.8 | 2.2 |
| clipped | maximum | SI-SDR vs input dB | 2.8 | 6.1 | 3.4 |
| silence | all | peak out | 0 | 0 | none |
| noise-only (-40 dBFS) | landing | noise reduction dB | 5.5 | 5.0 | **-0.5** |
| noise-only | engineer | noise reduction dB | 7.6 | 7.3 | **-0.4** |
| noise-only | maximum | noise reduction dB | 26.9 | 17.7 | **-9.2** |

Note: after this table was taken the reverb fixture was rescaled to the dry speech level (its input had peaked near 2.9, about 4x the other fixtures), so re-running `quality:matrix` gives different reverb rows; the other rows are unaffected.

Verdict: of the 42 rows with a before/after metric (silence excluded), 36 improve and 6 regress (bold): the 3 noise-only rows are the stated tradeoff (less suppression where there is no speech), plus whisper-under-music on the default chain (-0.3 to -0.5 dB, synthetic only; recorded music 5 dB improved) and overlapping speakers on Maximum (-0.1 dB). Clean-speech high band (4-12 kHz) after: -4.7 dB default, -7.8 dB Engineer defaults, -32.8 dB Maximum.

---

## E. ML runtime table

| Model | Purpose | Provider | Init | Inference | Memory | Status |
|---|---|---|---|---|---|---|
| `bsrnn_vocals` 3.87 MB fp32 | vocal mask `[B,2049]` | WebGPU → WASM | NOT VERIFIED separately | 0.287 ms/frame WASM 1 thread (prior audit) | NOT VERIFIED | shipped default; now frame-max input, mask^0.5 |
| `rnnoise_suppressor` 2.03 MB fp32 | noise mask `[B,2049]` | WebGPU → WASM | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED | Maximum chain; input scale fixed (was out of training range) |
| `silero_vad` / `_int8` | VAD for analysis | WASM | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED | analysis only, unchanged |
| demucs, bsrnn_complex, ecapa, sam | optional | n/a | n/a | n/a | n/a | not shipped |

Sessions persist per worker lifetime (`SESSIONS`, OBSERVED). Both shipped networks are stateless per frame (prior audit, VERIFIED).

---

## F. Full-buffer pass report (Engineer)

| Pass | Path | Thread before | After |
|---|---|---|---|
| mid build, stereo expand, post-stem, dewhistle, output copies | ML | main, chunked | kept |
| STFT / masks / iSTFT | ML | MLWorker | kept (normalisation fused into the existing forward pass, no new pass) |
| DC, click repair, gate, de-ess | fallback | main, one task | **moved** to dsp-worker |
| spectral stage (STFT, NR, gate, focus, dereverb, deWhistle, iSTFT) | fallback | main, rAF-paced | kept on main; **yields budgeted**, dereverb **O(D)→O(1)** |
| HP/LP, EQ, compressor, limiter | fallback | main, one task | **moved** to dsp-worker |
| render copy, dry/wet, out gain | fallback | main, chunked | kept |

---

## G. Memory map (INFERRED, 300 s stereo 48 kHz)

One stereo Float32 copy = 300 × 48,000 × 2 × 4 B = 115.2 MB; one mono copy = 57.6 MB.

| Item | Copies | Size |
|---|---|---|
| decoded source AudioBuffer | 1 stereo | 115.2 MB |
| mid | 1 mono | 57.6 MB |
| worker: input, out, norm (OLA) | 3 mono | 172.8 MB transient |
| clean + noise stems (mono) | 2 mono | 115.2 MB |
| stereo clean expand + output AudioBuffer | 2 stereo | 230.4 MB |
| Live-Mix stem AudioBuffers | 2 stereo | 230.4 MB |
| STFT batch buffers (batch 384 × 2049 × 4 arrays) | | 12.6 MB |

Sum of the above is about 0.93 GB of PCM; measured Chromium-tree peak RSS was 2.37 to 2.41 GB (includes browser, ORT WASM heap, caches). 60-minute files: NOT VERIFIED (12× the PCM, about 11 GB by the same count, which exceeds most devices).

---

## H. Main-thread long tasks (Engineer, 300 s stereo)

| Path | Before worst | After worst | Cause before |
|---|---|---|---|
| DSP fallback | 31,359 ms | 1,730 ms | `DSPCore.dereverb` direct sum: frames × bins × decay frames (~30), one task |
| DSP fallback | (included) | | rAF-paced STFT yields: ~230 ms each when throttled, 0 Hz in hidden tabs |
| DSP fallback | ~1.5 s (prior audit) | 0 (worker) | conditioning chain |
| ML path | 180 ms | 196 to 408 ms | unchanged code; run-to-run spread |

Remaining 1.7 s on the fallback: the in-place spectral passes between budget checks (deWhistle, dereverb, Wiener, gate) on the whole spectrogram.

---

## I. Worker / worklet matrix

| Worker | Purpose | Lifetime | Transfer | Status |
|---|---|---|---|---|
| `src/workers/MLWorker.js` | inference | persistent, terminate on reset | in/out transfer | canonical |
| `/app/dsp-worker.js` | fallback condition + EQ/dynamics (new use) | per fallback pass, terminated in `finally` | in/out transfer, init handshake before transfer | live |
| `FullAnalysisWorker`, `DiarizationWorker`, `USMWorker`, `AudioEncoderWorker` | analysis / export | host-managed | | unchanged, not audited here |
| `src/workers/SpectralCleanupWorker.js` | offline NR/dereverb | none | | **unreferenced by production** (OBSERVED, grep) |
| `public/app/ml-worker.js` | legacy | | | legacy (prior audit) |
| `vip-gate`, `vip-deesser` worklets | playback | per AudioContext | | unchanged, not exercised here |

Harness: `workersLive` returned to 0 (fallback) and 1 (ML, persistent) after clear in every run (VERIFIED).

---

## J. Capability matrix

| Capability | Status | Evidence |
|---|---|---|
| clean speech preservation | PARTIAL | SI-SDR 11.3 dB recorded (was 6.8); HF -4.7 dB synthetic |
| broadband noise | PARTIAL | +1.8 dB at 0 dB SNR, -1.2 dB at 10 dB (recorded) |
| hum | PARTIAL | +2.8 dB at 5 dB (recorded); -2.1 dB synthetic 10 dB |
| whisper | PARTIAL | preserved better (+1.5 to +3.9 dB); under music -0.3 to -0.5 dB (synthetic) |
| multiple / overlapping speakers | FAIL | -1.7 to -2.0 dB; no target-speaker separation in the models |
| TV / music bleed | FAIL | negative SI-SDR delta on music in both sets |
| reverb | FAIL | -1.3 dB synthetic; no dereverb in the ML path at defaults |
| clipped audio | PARTIAL | preserved better; no declipping |
| silence | PASS | digital silence in → exact silence out |
| 30-minute file | NOT VERIFIED | |
| 60-minute file | NOT VERIFIED | |
| WebGPU | NOT VERIFIED | no GPU here |
| WASM fallback | PASS | all measurements ran on WASM |
| cancellation | PASS (prior tests) | fallback worker terminates on abort; not timed here |
| worker recovery | PARTIAL | dsp-worker load failure falls back in place (code + unit); browser-forced failure not run |
| export parity | PASS (Engineer smoke, maxDelta 3.3e-5) | `e2e-engineer-upload` |
| Electron offline | NOT VERIFIED | |
| Android | NOT VERIFIED | |

---

## K. Findings ledger

**PQ-001** · P0 · DSP fallback · `public/app/dsp-core.js:1220` (before), `:272`, `:326` (before)
- Evidence: `perf-harness --no-ml --secs 300`: 307.4 s, longest task 31,359 ms; profile: `dereverb` 6.4 s self time per 60 s, rAF-paced yields.
- Root cause: dereverb summed the decay window per bin per frame; STFT yields awaited rAF every 48 frames.
- Fix: exact recurrence (`dsp-core.js:1304`), caller budget `maybeYield` (`app.js:6228`, `:6320`), worker passes (`app.js:5529`).
- Verification: `tests/dsp-dereverb-recurrence.test.js` (matches direct sum, relative error < 1e-5); harness after: 33.7 s, 1,730 ms. Status: FIXED (remaining 1.7 s documented).

**PQ-002** · P0 · ML input · `src/workers/MLWorker.js:882`, `scripts/export_onnx_models.py:233`, `:248`
- Evidence: training divides magnitudes by the per-frame peak; inference fed raw magnitudes (frame peaks ~10 to 1000). RNNoise mask changed with input scale; normalising raised RNNoise-only SI-SDR by 1 to 3 dB on recorded speech. BSRNN unaffected (±0.1 dB).
- Fix: `inputNormalization: 'frame-max'` in `ModelManifest.js`, applied in the forward pass into a separate buffer (Engineer controls keep raw magnitudes). Status: FIXED.

**PQ-003** · P1 · mask calibration · `src/workers/MLWorker.js:988`
- Evidence: sweep and held-out tables (section D). Status: FIXED as a calibrated tradeoff; noise-only suppression lower (stated).

**PQ-004** · P1 · model capability · confirms prior ML-001
- Evidence: after calibration the default chain is still negative on white 10 dB, music 5 dB, babble 5 dB (recorded). Status: OPEN; needs a better model.

**PQ-005** · P1 · Maximum chain · `rnnoise` head
- Evidence: clean-speech 4-12 kHz band -32.8 dB after (-35.2 before); fricatives -31 dB. The Maximum chain removes consonant energy. Status: OPEN; consider dropping RNNoise from the chain or band-limiting its mask.

**PQ-006** · P2 · Engineer defaults · `src/workers/EngineerSpectralControls.js:31`, `:105`
- Evidence: `voiceFocusHi` default 4,500 Hz with `focusOutsideGain` 0.66 attenuates everything above about 4.5 kHz by about 3.6 dB on every Engineer Process; measured HF delta -7.8 dB Engineer vs -4.7 dB Landing on the same input. Status: OPEN (default change is a product decision).

**PQ-007** · P2 · dead code · `src/workers/SpectralCleanupWorker.js`
- Evidence: no production importer (grep). Status: OPEN.

**PQ-008** · P2 · test flake · `scripts/engineer-rt-smoke.cjs:131`
- Evidence: `compRatio` read 7.9978 vs tolerance 0.001 after a fixed 400 ms wait while another CPU job ran; passes alone. Code under test not touched by this pass. Status: OPEN.

Prior findings re-checked: PERF-001 CONFIRMED and FIXED (it was larger than reported: the conditioning chain was ~1.5 s; the spectral stage was ~30 s). ML-001 CONFIRMED with numbers. DSP-001 (HF taper): removing it lowered mean SI-SDR by up to 0.2 dB on the default chain and left the Maximum chain unchanged in the sweep, so it was kept. AUD-003, AUD-004 (fallback click repair / de-esser algorithms): NOT ADDRESSED (now off the main thread, unchanged numerically).

---

## L. Modified files

| File | Reason | Risk | Tests |
|---|---|---|---|
| `src/workers/MLWorker.js` | frame-max input, per-head mask exponent | changes every ML output | quality gate, full Jest suite |
| `src/core/ModelManifest.js` | calibration fields | manifest consumers | `model-integrity`, gate |
| `public/app/dsp-core.js` | dereverb recurrence; budgeted STFT yields; `conditionFallbackChannel`, `eqDynamicsChannel` | fallback numerics (pinned to old) | `dsp-dereverb-recurrence`, `dsp-worker` |
| `public/app/dsp-worker.js` | `condition` / `eqDynamics` messages with transfers | worker load failure | `dsp-worker`, offload guard |
| `public/app/app.js` | `_dspWorkerChannels`; budgeted yields | fallback path | offload guard, harness |
| `scripts/quality/*` | harness, fixtures, metrics, gate, baseline | none at runtime | gate itself |
| `scripts/prod-verify.mjs`, `package.json` | `audio-quality` step, scripts | +47 s CI | prod:verify |
| `scripts/perf/perf-harness.cjs` | `--no-ml`, engine + stage timings | none at runtime | manual |
| tests (2 updated, 3 new: `dsp-dereverb-recurrence`, `fallback-conditioning-offload`, cases in `dsp-worker`) | see M | | |
| `CLAUDE.md`, `docs/guides/AUDIO_QUALITY.md` | contracts | | |

---

## M. Tests added

| Test | Prevents |
|---|---|
| `scripts/quality/quality-gate.cjs` (prod:verify `audio-quality`) | any change to the ML path that lowers a pinned SI-SDR / speech-level / fricative-level / suppression metric by > 0.5 dB, NaN output, silence leakage, overs |
| `tests/dsp-dereverb-recurrence.test.js` | recurrence drifting from the direct sum; the O(D) cost returning |
| `tests/dsp-worker.test.js` (3 new) | worker output differing from the in-place chain; PCM cloned instead of transferred |
| `tests/fallback-conditioning-offload.test.js` | whole-file conditioning/EQ moving back onto the main thread; transferring before the worker is known to load |
| `tests/whisper-ui-freeze.test.js` (updated) | a per-yield rAF await coming back into the async STFT |

---

## N. Remaining limitations

- Shipped models are weak: negative SI-SDR delta remains for moderate white noise, music, babble, reverb, overlapping speakers.
- Fixtures in CI are synthetic. Recorded-speech evidence was gathered locally and is not reproducible in CI without a licensed corpus in the repo.
- Fallback spectral stage still runs on the main thread (1.7 s worst task at 5 min).
- WebGPU, Android, Electron packaging, Firefox, Safari, 30 and 60 minute files: NOT VERIFIED.
- GitHub Actions execution (CI-001): unchanged, NOT VERIFIED from here.
- Region-local processing, playback/export parity on the fallback path, cancellation latency: not re-measured in this pass.

## O. Roadmap

**NOW**
1. CI-001: get `production-gate` running on GitHub; `audio-quality` is inside it.
2. PQ-005: decide on the Maximum chain (drop RNNoise or limit its mask to below 4 kHz), measured with `pnpm quality:matrix`.
3. PQ-006: review the Engineer `voiceFocusHi` default.

**NEXT**
4. Replace the single-frame models (multi-frame, complex mask); gate must improve, not just hold.
5. Move `_spectralStageAsync` into dsp-worker (needs `_applyVoiceFocus` etc. ported to DSPCore).
6. Add a small licensed recorded-speech set to `tests/fixtures/quality/`.
7. Long-file bound: chunked inference with overlap for 30 and 60 minute files.

**LATER**
8. Provider selection from measured WebGPU vs WASM on real devices.
9. AUD-003 / AUD-004 fallback algorithm fixes with golden tests.

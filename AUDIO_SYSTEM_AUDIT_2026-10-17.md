# VoiceIsolate Pro — Audio System Audit, Repair & Verification (2026-10-17)

Branch `arena/f3ca7edd-voiceisolate-pro`, baseline commit `020b963` (clean tree), repair commit `edf3ab1`.
Environment: Node 22.22.3, pnpm 11.3.0 (corepack), Jest 30.3.0, ESLint 9.39.4, onnxruntime-web 1.25.1 (WASM, 1 thread in Node).

Evidence classes used below: **VERIFIED** (read and/or executed), **REPRODUCED DEFECT** (executed, numeric), **IMPLEMENTED FIX**, **VERIFIED FIX** (executed after patch), **PLAUSIBLE RISK** (reasoned from inspected code, not executed), **UNVERIFIED**, **BLOCKED**. No listening tests were performed; no perceptual claims are made. All numbers come from executed scripts (`scripts/quality/quality-gate.cjs`, the repo's real `MLWorker.js` run in Node on the shipped ONNX models, and the new Jest suite) on **synthetic** fixtures.

## 1. Overall status: PARTIALLY COMPLETE

- Two Process-time controls that were provably inert in the shipped Engineer pipeline (`nrFloor`, `breathControl`) are repaired with regression tests; default-path output is bit-identical; the full test suite and the quality gate pass.
- Three pieces of misleading control copy were corrected (`voiceIso`, `nrFloor`, `snrFloor`).
- Remaining items are documented as risks (not patched): `snrFloor`'s dBFS scale mismatch, hop-dependent time constants on long files/mobile, de-esser "dB" scale, fixed HF taper, synthetic-fixture quality figures. Browser-only behaviour (WebGPU path, AudioWorklet playback, real exports) was verified by reading, not executed.

## 2. Repo baseline (executed)

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ok |
| full Jest (`node --experimental-vm-modules node_modules/jest/bin/jest.js --testEnvironment=node`) | **before:** 232 suites, 3910 passed, 1 skipped, exit 0 (219.8 s) |
| `pnpm lint` | exit 0 — 0 errors, 86 pre-existing warnings |
| `node scripts/validate.js` | exit 0, "All checks passed" |
| `node scripts/validate-model-integrity.mjs` | exit 0 — shipped entries vad, vad_int8, rnnoise, bsrnn_vocals, dfn3_enc/erb_dec/df_dec hash-verify locally |
| `node scripts/quality/quality-gate.cjs` | PASS, exit 0 (baseline metrics in §9) |

## 3. Actual signal flow (VERIFIED by reading; line refs are the inspected ranges)

**Engineer Process (default chain `bsrnn_vocals`)**
1. Decode → 48 kHz; stereo is down-mixed to mid for one inference pass (`public/app/app.js:5105–5126`, `_runMLIsolationPipeline` :5341).
2. Process-time snapshot `buildMlProcessingConfig(getEffectiveParams(VIP_PARAMS))` (`src/core/ParameterSchema.js:246–270`); slider drags never reach the worker (`src/presentation/SliderUI.js`, `app.js:1957–1991` → `_syncBridgeParams` :2993).
3. `MLWorker.processRequest` (`src/workers/MLWorker.js:1474`): mains-hum notch before inference (:1516–1531) → `runFusedSpectralMaskChain` (:879): one Hann STFT (fft 4096 / hop 1024, `adaptiveHopSize` :328 picks hop 2048 for files > 90 s on desktop and for every file on constrained/mobile devices, `colaSafeHop` :360), BSRNN sigmoid mask with frame-max input normalisation, `mask^0.5`, temporal mask smoothing 0.55 (:998), **unconditional HF taper** above 35 % of Nyquist (≈ 8.4 kHz, up to −55 % at Nyquist, :991 / :1060), `EngineerSpectralControls.applyFrame` on the masked bins with the mixture magnitude as reference (:1065–1066), WOLA iSTFT. Noise stem = input − clean.
4. Main thread: mono→stereo expansion, phaseCorr/crosstalk, deWhistle, `outputBuffer` (:5186–5280), stems retained as copies (`StemSeparation.stemsToAudioBuffer*` copies via `copyToChannel`, `src/pipeline/StemSeparation.js:462–463`), loaded into the Live-Mix bridge (`_loadSeparationStemsToBridge` :3011). `_applyOutputSafetyLimitAsync(this.outputBuffer)` (:4823) only rewrites `outputBuffer`; the retained stems are untouched.
5. **Playback** = `PlaybackMixer` graph on the retained stems (`buildLiveChain` :7072 → `bridge.loadStemPair`): gate worklet → HP/LP → EQ → compressor → de-esser → M/S width → limiter → ceiling shaper → master → analyser.
6. **Export** = `_downloadProcessed` (:4252) → `_renderProcessedMix` (:4129) → `PlaybackMixer.renderMix` (`src/pipeline/PlaybackMixer.js:1471`) renders the *same stems* through an `OfflineAudioContext` clone of the graph with captured AudioParams, latency-compensated (`latencyFrames` :735), then WAV encode with `ditherAmt`. Drive upload uses the identical render (:4227). **Playback/export parity: VERIFIED by reading** (same stems, same graph, same params); not executed (no browser).

**Landing (Quick Clean)**: `public/landing.js` posts every channel to the same worker with no `processingConfig` (:1423); outcomes come from `src/pipeline/QuickCleanPlan.js:5–14` (Clean Speech = bsrnn; Maximum Isolation = bsrnn + rnnoise; Preserve Ambience = rnnoise, background 30 %; Enhance Speech = DeepFilterNet3). Sliders bind to `PlaybackMixer` only (`SliderUI.js`). Export = `mixer.renderMix` (:588).

**DSP fallback** (`_runFallbackPipeline` :5735 → `_spectralStageAsync` :6349) runs only when ML is unavailable; it is `public/app/` maintenance-freeze code and was audited but not patched.

## 4. Capability matrix

| Claim / capability | Status | Evidence |
|---|---|---|
| On-device inference, no audio upload, no telemetry | VERIFIED (static) | Only same-origin `fetch` of `/app/models/*` (`MLWorker.js:452–473`, `SpeakerEmbeddingWorker.js:55`), SHA-256 verified on fetched **and** cached bytes (:385–399, :457–466); Google Drive upload is user-initiated (`app.js:4210–4249`); no analytics/CDN script tags in `public/index.html`. "Offline once loaded" depends on the service worker — UNVERIFIED (not executed). |
| "BS-RNN" vocal separation | VERIFIED with caveat | Shipped `bsrnn_vocals.onnx` is a **custom band-split mask model trained 600 steps on synthetic mixtures**, not a published BSRNN checkpoint (`public/app/models/README.md:14`). UI calls it "the standard local model" (QuickCleanPlan) — truthful. |
| "RNNoise" | VERIFIED with caveat | Custom BiGRU mask at fft 4096 / hop 1024; "not Mozilla RNNoise" (README :15, `ModelManifest.js:77–107`). Legacy status labels in `public/app/ml-worker-fetch-cache.js:733–736` still say "RNNoise"/"xiph" and "~45 MB BSRNN" — stale metadata, not loaded by `app/index.html` (P3). |
| DeepFilterNet3 | VERIFIED (tests) | Three upstream graphs, hash-pinned; `tests/deepfilternet*.test.js` pin against `tests/fixtures/dfn3-libdf-output.f32`. Landing opt-in only. Measured: destroys synthetic whispers (`whisper-clean/enhance/speech-level −21.1 dB`) — the outcome description already warns "can suppress whispers". |
| Silero VAD | VERIFIED (manifest; consumers located by grep: `src/pipeline/VadAnalysis.js`, `FullAnalysisHost.js`, not read) | hash-pinned, 16 kHz (`ModelManifest.js:44–52`). |
| ECAPA speaker embedding | optional, hash pinned, **file not shipped**; worker refuses unpinned entries (`SpeakerEmbeddingWorker.js:51`). |
| Demucs | **not shipped**, optional (`ModelManifest.js:117–130`); status UI has an "Optional — not shipped" pill (`model-status-ui.js:9`). |
| Separation vs enhancement | Engineer/Landing default = **mask-based vocal separation** (clean + residual stems); "Enhance Speech" = DFN3 enhancement (no music separation). Truthful in UI. |
| Live mic / real-time isolation | none (upload-only; worklets are playback gate/de-esser) — matches CLAUDE.md §8.4. |

## 5. Control traceability (67 controls)

**37 Live-Mix (rt) controls** → `EngineerModeBridge.PARAM_MAP` (`src/pipeline/EngineerModeBridge.js:34–98`) → `PlaybackMixer` setters (AudioParams via `setTargetAtTime`): gateThresh/Range/Attack/Release/Hold/Lookahead → gate worklet; eqSub…eqBrill → 10 graphic bands; compThresh/Ratio/Attack/Release/Knee/Makeup → DynamicsCompressor + makeup; limThresh/limRelease → limiter + ceiling; hpFreq/hpQ/lpFreq/lpQ; deEssFreq/deEssAmt (UI 0–24 "dB" → worklet amount 0–1, **hard cap −12 dB**, `DeEsserProcessor.js:11–12, 228–245`); specTilt; outGain; dryWet; outWidth & stereoWidth (UI-linked peers, `app.js:1965–1971`, both → `setStereoWidth`); **voiceIso → clean-stem gain 0.70–1.30× after calibration** (`EngineerModeBridge.js:87–92`, `slider-calibration.js:327–335`, `PlaybackMixer.js:1072`); bgSuppress → noise-stem gain `1 − pct/100` (:1063), calibrated/capped (`slider-calibration.js:495–503`). All VERIFIED by reading; the Jest mixer suites (`playback-mixer-*.test.js`) passed.

**27 Process-time spectral controls** → `EngineerSpectralControls.applyFrame` (`src/workers/EngineerSpectralControls.js`). Executed sensitivity (min vs max, synthetic frames, relative difference energy; `-Inf` = bit-identical):

| id | effect in code | min↔max difference (defaults) | note |
|---|---|---|---|
| nrAmount / nrSensitivity / nrSpectralSub / nrSmoothing | NR gain `1 − nrStrength·noiseRatio·0.82`, min-tracker noise floor, one-pole gain smoothing | −9.2 / −21.1 / −17.6 / −22.6 dB | functional |
| **nrFloor** | was `Math.max(10^(dB/20), nrTerm)` | **−Inf (inert, also in the real worker at nrAmount/Sub = 100)** → **fixed** | P1, §7 |
| formantShift | magnitude-envelope warp, phase kept | 5.4 dB | functional (tested in `engineer-processing-config.test.js`) |
| derevAmt / derevDecay / reverbStrip / roomCorrection | tail predictor | −6.8 / (needs derevAmt) −15.0 / −4.9 / −12.8 dB | derevDecay only with derevAmt > 0 (by design) |
| harmRecov / harmOrder | harmonic lift from `k/order` bin | −16.9 / (needs harmRecov) −21.4 dB | dependent by design |
| voiceFocusLo / Hi | smooth band pass, outside gain ≥ 0.18 | −14.5 / −9.4 dB | **always on** (default −3.6 dB outside 100–4500 Hz, see §8) |
| whisperLift | confidence lift, 0–40 UI → 0–12 dB | 4.8 dB | functional |
| crowdNull / bassCrush / voiceTunnel / musicKill / subHarmonic / transientShaper | bounded multiplicative cuts/lifts | −20.1 / −3.8 / −9.5 / −12.9 / −24.8 / −6.4 dB | functional |
| **snrFloor** | `source < 10^(dBFS/20)` gate, only with crowd/music/lift | −Inf at defaults; with whisperLift 20: −80↔−52 = **−94 dB** (effectively inert), −80↔−20 = −31 dB | P2 unit mismatch, §8 |
| whisperMode / whisperClarity / whisperThreshold / whisperSensitivity | confidence curve; sensitivity only via lift trigger & Crowd Null | −11.6 / (mode 2) −16.5 / −13.0 / (mode 2 + lift) −33.8 dB | dependent by design (schema text says "for WhisperHunter") |
| **breathControl** | was `frameEnergy < 0.025` (STFT units ≈ −64 dBFS) | **−Inf, incl. real worker with −45 dBFS breath bed** → **fixed** | P2, §7 |

**2 post-stem** (phaseCorr, crosstalk) → `_applyMlPostStemControls` on the main thread (`app.js:5547`); **ditherAmt** → WAV encode only (`app.js:4236–4238, 4343–4346`). VERIFIED by reading.

## 6. Findings ledger

| # | Sev | Class | Finding | Evidence |
|---|---|---|---|---|
| F1 | **P1** | REPRODUCED DEFECT → VERIFIED FIX | `nrFloor` inert across its whole −120…−20 dB range in the shipped ML path. NR term ≥ 0.18 > 10^(−20/20) = 0.1, so the floor never bound. | Algebra (`EngineerSpectralControls.js:92–93, 157`); real worker: −120 vs −20 bit-identical even at nrAmount/nrSpectralSub = 100; after fix −20 vs −120 differ by −31.3 dB (rel.) at deep settings, defaults bit-identical. |
| F2 | **P2** | REPRODUCED DEFECT → VERIFIED FIX | `breathControl` effectively inert: absolute threshold 0.025 in un-normalised STFT units ≈ −64 dBFS broadband; real breath beds (−45 dBFS) never qualified. | Real worker, −20 dBFS speech with 0.6 s −45 dBFS beds: 0/50/100 % bit-identical before; after: >4.5 kHz in beds −10.8 → −12.9 → −14.7 dB, speech segments unchanged (−8.8 → −8.9 dB). |
| F3 | P2 | VERIFIED (copy) → IMPLEMENTED FIX | `voiceIso` hint claimed "Sets machine-learning voice mask strength"; it is a Live-Mix clean-stem trim (−3.1…+2.3 dB) and never touches the mask. | `slider-map.js:126–127` vs `EngineerModeBridge.js:87–92`, `slider-calibration.js:327–335`. Hint/purpose rewritten. |
| F4 | P2 | VERIFIED → PLAUSIBLE RISK (not patched) | `snrFloor` labelled dBFS but compared with raw STFT magnitudes (≈ +32 dB for broadband noise, +60 dB for a sine at fft 4096). Over −80…≈−40 it does nothing at realistic levels; only −35…−20 acts. Legacy fallback (`app.js:6571–6592`) has the same mismatch. | Probe table above; code :94, :187. Hint now states the dependency on Crowd Null/Music Kill/Whisper Lift; the scale itself was left (changing it alters Extreme presets without gate coverage). |
| F5 | P3 | VERIFIED (design) | Unconditional HF taper on the clean stem above ≈ 8.4 kHz (−1 dB ≈ 10.5 kHz, −3.5 dB ≈ 16 kHz, −7 dB at Nyquist); removed energy lands in the noise stem. Documented in tests (`mlworker-ola-edges.test.js:68, 129`, `ml-worker-dsp.test.js:135–150`). | `MLWorker.js:991, 1060`. Measured consequence included in gate (`clean-speech/landing/fricative-level −3.94 dB`, partly model). |
| F6 | P3 | VERIFIED (design) | Default Engineer snapshot always attenuates outside 100–4500 Hz by −3.6 dB (`focusOutsideGain`, `EngineerSpectralControls.js:105`) → Engineer fricative level −6.7 dB vs Landing −3.9 dB on clean synthetic speech. | Gate table §9. Hint for voiceFocusHi already says to raise it for air. |
| F7 | P3 | PLAUSIBLE RISK | Per-frame constants not hop-aware: mask smoothing 0.55 (`MLWorker.js:998`), Engineer `smoothing`/`noiseTrack` (`EngineerSpectralControls.js:95–96`) — time constants double when `adaptiveHopSize` selects hop 2048 (files > 90 s desktop; all files on constrained devices). `tailDecay` *is* hop-aware. Same slider position ⇒ different temporal behaviour by file length/device. Not patched (behavioural change outside gate coverage). |
| F8 | P3 | VERIFIED | De-esser: UI "0–24 dB" is a ratio of excess over a fixed 0.1 band-envelope threshold, capped at −12 dB; gain smoothing `0.999`/sample is sample-rate dependent (contexts request 48 kHz, `PlaybackMixer.js:280`, `app.js:1554`). Registry tip "12+ dB is heavy" overstates the top half of the range. | `DeEsserProcessor.js:11–12, 228–248`. |
| F9 | P3 | VERIFIED | Gate worklet has threshold + hold but no hysteresis (`src/workers/GateProcessor.js`, read in full); de-esser threshold fixed. Behavioural, not a correctness defect. |
| F10 | P3 | VERIFIED (measured, synthetic) | Quality on the repo's own synthetic fixtures is modest: clean-speech SI-SDR 6.4 dB (landing) / 5.9 dB (engineer); `white-5db`, `hvac-5db`, `hum-10db`, `music-0db` SI-SDR **deltas are negative** for landing/engineer (−0.4…−2.6 dB) and the gate only *requires* ≥ 0 for the pairs it pins. Synthetic talker ≠ real speech; no claim about real recordings. | `/tmp/quality-baseline.log`, identical after patch. |
| F11 | P3 | VERIFIED | Legacy DSP fallback `spectralGate(mag, nrFloor)` compares 10^(dB/20) with un-normalised fft-2048 magnitudes (≈ 54 dB off for a sine): "−68 dB" never triggers; inline copy even says "−68 dB is transparent" (`app.js:622, 6400`; `dsp-core.js:1056–1105`). Maintenance-freeze code, not patched. |
| F12 | P3 | VERIFIED | Stale model metadata labels (RNNoise/xiph, "~45 MB" BSRNN) in `public/app/ml-worker-fetch-cache.js:733–736` (not loaded by the app shell). |
| F13 | P3 | PLAUSIBLE RISK | Optional manifest entries with `sha256: null` (`bsrnn_complex`, `sam_audio`, `universal_separator`) would load with a warning only if a file were placed at their URL (`MLWorker.js:385–391`). Shipped entries are all pinned (validator exit 0). |

No P0 found. Lifecycle/race paths (`stemLoadGen`, abort signals, `_exportInFlight`, watchdog in landing) were read and look coherent; existing suites (`playback-mixer-lifecycle`, `engineer-wav-export`, `export-dither-contract`) pass — not independently stress-tested here.

## 7. DSP repairs (commit `edf3ab1`)

### 7.1 `nrFloor` — `src/workers/EngineerSpectralControls.js:222–227`
- **Before:** `gain = Math.max(nrFloorGain, 1 − nrStrength·noiseRatio·0.82)`; max cut 0.18 ⇒ floor (≤ 0.1) unreachable ⇒ control inert.
- **After:** NR term unchanged (default output bit-identical); the floor is applied to the combined per-bin gain right before the one-pole smoothing (`if (gain < nrFloorGain) gain = nrFloorGain;`). Convex smoothing preserves the floor by induction; clamp [0, 4] unchanged. Semantics now match the hint ("minimum gain any frequency can be reduced to"). At −68 dB and below it rarely engages — the hint now says so.
- **Validation:** new tests (floor respected within 1e-5 and reached within 1.5× when the open chain cuts deeper; floor only raises bins); real worker probe (defaults bit-identical; −20 vs −120 at deep settings −31.3 dB rel.); quality gate identical.

### 7.2 `breathControl` — `EngineerSpectralControls.js:116–122, 145–146, 209`
- **Before:** `hz > 4500 && frameEnergy < 0.025` (absolute, STFT units).
- **After:** slow peak tracker `speechLevel = max(frameEnergy, speechLevel·exp(−hop/sr/2))` (pre-roll frame excluded); breath frame ⇔ `frameEnergy < speechLevel·10^(−24/20)`; attenuation depth and > 4.5 kHz region unchanged. Default 0 ⇒ default output unchanged.
- **Validation:** new tests (−11 dB on >4.5 kHz in gap frames, low bins and speech frames unchanged to 1e-6, monotonic in strength, identical behaviour at −30 dB and +12 dB input level); real worker probe above.

### 7.3 Copy (`public/app/slider-map.js`) — nrFloor hint/tip, snrFloor dependency, voiceIso hint/purpose. `CLAUDE.md` §8.4 rule 5 gains a note on STFT units and the new test.

### 7.4 New test `tests/engineer-spectral-control-sensitivity.test.js` (36 tests, ~27 s): pins the 27-id list against `ML_SPECTRAL_PARAM_IDS`, every id min↔max changes the output (with enabling context for dependent ids), nrFloor contract, breathControl contract. Confirmed to **fail on the pre-patch code** (7 failures) and pass after.

## 8. Not changed, on purpose
- `snrFloor` scale (F4), hop-aware constants (F7), HF taper (F5), focus-band default (F6), de-esser scale (F8), legacy fallback (F11): each is a behavioural/tuning change outside quality-gate coverage; they are documented here instead.
- Versions `ML_PROCESSING_CONFIG_VERSION`/`VERSION` left at 1: the stem cache is in-memory only (`src/pipeline/MLStemCache.js:24`), so no persisted result can be stale.

## 9. Validation evidence

| Check | Before | After |
|---|---|---|
| Full Jest | 232 suites / 3910 passed / 1 skipped / exit 0 | **233 suites / 3946 passed / 1 skipped / exit 0 (249.5 s)** |
| New suite alone | — | 36/36 pass; 7 fail with the patch stashed |
| `pnpm lint` | exit 0 (86 warnings) | changed files lint clean (`pnpm exec eslint …` exit 0) |
| `node scripts/validate.js` | exit 0 | exit 0 |
| `node scripts/validate-model-integrity.mjs` | exit 0 | unchanged files |
| `node scripts/quality/quality-gate.cjs` | PASS | **PASS, every printed metric identical** (diff empty) |
| Real-worker default output (white-5db, Engineer defaults) | — | bit-identical pre/post (−∞ dB difference) |

Selected gate metrics (synthetic fixtures, dB): clean-speech si-sdr landing 6.38 / engineer 5.88 / maximum 5.66 / enhance −3.01; clean-speech fricative-level −3.94 / −6.68 / −12.57 / −22.35; white-5db si-sdr-delta −1.00 / −0.73 / +0.46 / −1.94; whisper-clean si-sdr 11.71 / 11.04 / 10.93 / −13.07; noise-only noise-reduction 5.00 / 7.26 / 9.75 / 42.46.

## 10. Manual listening checklist (not performed here)
1. Engineer, defaults, a real noisy interview: Process; A/B original vs processed; export WAV and null-test it against a recording of the playback render (expect parity).
2. NR tab: nrAmount 100 / Spectral Sub 100 / Whisper Mode Forensic / Clarity 0, then sweep **NR Floor** −120 → −20: hollowness should ease toward −20; below ≈ −55 no change is expected.
3. Whisper tab: a close-mic recording with audible breaths; **Breath Control** 0 → 100: breath HF should soften, sibilants in speech unchanged; try at −12 dB and +6 dB input gain to confirm level independence.
4. Landing: compare "Clean Speech" vs "Maximum Isolation" on a sibilant speaker (expect duller /s/ on Maximum — fricative −12.6 dB on fixtures) and "Enhance Speech" on whispered speech (expect loss).
5. Long file (> 3 min) vs a 60 s excerpt of the same material at the same settings: listen for different NR smearing/onsets (F7).
6. De-esser at 24 "dB": confirm the cut never exceeds ≈ 12 dB (F8).

## 11. Remaining risks
- WebGPU path, AudioWorklet playback graph, OfflineAudioContext render, video remux and Drive upload were not executed (no browser in the sandbox) — parity is verified by reading only.
- Quality numbers are synthetic-fixture measurements from the repo's own gate; they are not evidence of real-speech quality.
- `snrFloor` remains numerically mis-scaled (F4); its hint is now honest about when it engages but not about the scale.
- Long-file/mobile hop change alters temporal constants (F7).

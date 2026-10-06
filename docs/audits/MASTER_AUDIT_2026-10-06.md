# VoiceIsolate Pro: Master Production Audit (2026-10-06)

| Field | Value |
|---|---|
| Commit audited | `main` @ `49d517e` (perf: remove remaining post-Process main-thread freezes, #834) |
| Product version | 25.0.2 |
| Environment | Linux container, Node 22.22.0, pnpm 11.3.0, Chromium 1194 (Playwright), Electron 41.10.6, xvfb. No Android SDK. No Windows. No Firefox/Safari. |
| Method | Read code, ran every local gate, drove Chromium and Electron, ran the shipped ONNX models in onnxruntime-web (Node, WASM) and the DSP functions in Node with synthetic signals. |
| Prior audits | `DEEP_AUDIT_2026-08-19.md` (CONDITIONAL GO). This report supersedes it. Several of its PASS rows no longer hold (see section 3). |

Evidence labels used throughout:

- **VERIFIED**: reproduced by a command or measurement in this session.
- **OBSERVED**: read directly in code; not executed.
- **INFERRED**: reasoned from code; not executed or measured.
- **NOT VERIFIED**: could not be checked in this environment.

---

## 1. Executive summary

- **The production gate is not running.** `ci.yml` has not passed on `main` since 2026-09-09 (run 1073). The last five `main` runs (#830 to #834) each ended in about 1 s with no job log, and `deploy.yml` was skipped for all of them. Locally, `pnpm prod:verify` is red on two browser steps (`e2e-quick-clean`, `e2e-shell-qa`) that #833 introduced and CI never caught.
- **The ML core is real.** The shipped models are genuine, hash-pinned and fast (BSRNN 0.287 ms per frame on one WASM thread, about 12 s of inference for 15 minutes of mono). The fused single-STFT path is sound. Both models are per-frame and stateless, though, so isolation quality has a ceiling, and nothing in the repo measures separation quality (no SDR, SI-SDR, PESQ or STOI anywhere).
- **What the UI claims and what the signal path does diverge in four primary places** (two smaller ones, AUD-005 silent passthrough and the analysis SNR read-out, are in sections 8 and 10). (1) Engineer export writes only the clean stem and drops all 37 Live-Mix controls the user hears. (2) On the default ML path, all four waveform-region actions leave the audio unchanged while the UI reports the action (only `isolate` has an effect, and only when ML fails and the DSP fallback runs). (3) After Process, Engineer auto-calibration rewrites Process-time sliders from the *output*, so the visible settings are not the ones that produced the audio. (4) The "recommendation engine" is a 4-bucket RMS classifier whose plans never reach processing.

**Repository health score: 58 / 100** (46 of 80 points across the eight dimensions below, equally weighted, so 57.5 rounded).

| Dimension | Score | Basis |
|---|---|---|
| Build / unit tests | 9/10 | Install, lint (0 errors), 202 suites / 3548 tests, build, validators: all PASS |
| CI / release discipline | 2/10 | Gate not executing on `main` for 4 weeks; deploy skipped; browser gate red locally |
| Audio correctness | 6/10 | ML path sound; fallback DSP has measured defects; export fidelity broken on Engineer |
| Product truthfulness | 4/10 | 4 confirmed UI-vs-signal mismatches (section 9, 10) |
| Security / privacy | 8/10 | No audio egress found; Electron hardened and runtime-verified; `/app/` keeps `'unsafe-inline'` |
| Architecture / maintainability | 5/10 | 8,106-line `app.js`, 76 files in `public/app/`, dual workers, 8 unreferenced `src/` modules |
| Platform coverage | 5/10 | Web verified in Chromium only; Android and Windows builds not verifiable here |
| Accessibility | 7/10 | Strong guards exist; one live AA failure on Landing |

---

## 2. Release status

**NO-GO for a new release until P0-1 to P0-3 are closed.** The code that ships today mostly works. The problem is that nothing currently proves it, and two regressions are already on `main`.

---

## 3. Build / test baseline

All commands run at `49d517e`.

| # | Command | Result | Evidence |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | PASS | 16 s; ORT and Three.js postinstall copy skipped (already vendored) |
| 2 | `pnpm lint` | PASS (0 errors, 10 warnings) | unused vars in `app.js`, `MLWorker.js` (`classifyWebGpuFailure`, kept for tests), one double-quote string |
| 3 | `pnpm test` | PASS | 202 suites, 3548 tests, 27.96 s |
| 4 | `pnpm validate` | PASS | "All checks passed" |
| 5 | `pnpm models:validate` | PASS | local hashes match; remote Blob hashes "not claimed" |
| 6 | `pnpm worklets:verify` / `--require-build` | PASS / PASS | |
| 7 | `pnpm version:check` | PASS | |
| 8 | `pnpm check:privacy` | PASS | upload-only, no cloud audio backends, no product `getUserMedia` |
| 9 | `pnpm ci:check-patches` | PASS | |
| 10 | `pnpm provenance:validate` | PASS | non-strict |
| 11 | `pnpm build` | PASS | `build/` produced; `sam_audio.onnx` absent (optional) |
| 12 | `node scripts/prod-verify.mjs --only <10 browser steps>` | **FAIL (8/10 pass)** | see below |
| 13 | `xvfb-run -a node scripts/electron-security-smoke.cjs` | PASS | 9/9 checks |
| 14 | `pnpm android:build` | NOT VERIFIED | no Android SDK / `ANDROID_HOME` in container |
| 15 | `pnpm build:electron` (NSIS) | NOT VERIFIED | Windows-only packaging |
| 16 | `pnpm downloads:validate`, `provenance:validate:strict` | NOT VERIFIED | network tier not run |
| 17 | Firefox / Safari / iOS | NOT VERIFIED | no engines available |
| 18 | GitHub Actions `ci.yml` on `main` | **FAIL (gate did not execute; no test ran)** | runs 37394492678, 37265305093, 37219514154, 37219306095, 37206631620: job `production-gate` completes in ~1 s, log download returns 404. Last success: run 34413532273 on 2026-09-09. |
| 19 | GitHub Actions `deploy.yml` on `main` | **SKIPPED** | runs 2649 to 2651 `conclusion: skipped` (gated on `ci` success) |

Browser tier detail (step 12):

| Step | Result | Duration |
|---|---|---|
| e2e-live, e2e-engineer-rt, e2e-engineer-upload, e2e-calibration, e2e-tier-picker, e2e-ui, e2e-landing, privacy-runtime | PASS | 2.9 s to 14.4 s each |
| e2e-quick-clean | **FAIL** | `scripts/quick-clean-smoke.cjs:206` "Mobile horizontal overflow: 73px" on Landing at 390 px after a full Process |
| e2e-shell-qa | **FAIL** | 5 failures, all the same: Landing skip link `a.ps-skip-link` cyan `rgb(46,213,229)` on red `rgb(216,31,48)` = 2.83:1, needs 4.5:1, at 390/768/1024/1440/1920 |

Root cause of the shell-qa failure (VERIFIED by reading CSS): `public/landing-v3.css:55` `body.v3 a { color: var(--v3-cyan) }` (specificity 0,1,2) overrides `public/ps-shell.css:34` `.ps-skip-link { color: #fff }` (0,1,0). Introduced by #833.

The ~1 s CI failure with no log matches a run that never got a runner (account billing or spending limit, Actions disabled, or a runner-label problem). The cause is **NOT VERIFIED** from here; the repository owner must check the Actions tab.

---

## 4. Architecture map

```
                         ┌──────────────── Browser / WebView / Electron renderer ────────────────┐
 Upload (file input,     │                                                                       │
 drag-drop, Drive,       │  Landing  public/index.html → landing.js (1,778 lines)                │
 Electron native open)   │     │  FileIngestion (decode + resample to 48 kHz)                    │
        │                │     │  QuickCleanPlan → postMessage('process') ─┐                     │
        ▼                │     │                                          ▼                     │
 src/pipeline/           │     │                     src/workers/MLWorker.js (classic worker)  │
 FileIngestion.js        │     │                     ORT WebGPU → WASM; SHA-256 verify; IDB    │
 media-decode.js         │     │                     fused STFT → mask(s) → EngineerSpectral   │
                         │     │                     → iSTFT; noise = input − clean            │
                         │     ▼                                          │                     │
                         │  PlaybackMixer (Live-Mix graph + Gate/DeEsser worklets) ◄──────┘    │
                         │     │ renderMix() for export (Landing only)                          │
                         │                                                                       │
                         │  Engineer  public/app/index.html → app.js (8,106 lines) + 75 files    │
                         │     runPipeline → StemSeparation → MLWorkerHost → MLWorker (same)    │
                         │       └ on ML failure: _runFallbackPipeline (dsp-core.js, main thread)│
                         │     EngineerModeBridge → PlaybackMixer (Live-Mix)                    │
                         │     export: procBuffer (clean stem) → WAV  ← NOT the Live-Mix render  │
                         │     analysis-workspace.js → FullAnalysisHost/Worker, USM, diarization │
                         └───────────────────────────────────────────────────────────────────────┘
 Platforms: Vercel (public/ + COOP/COEP) · Capacitor 8 Android (webDir build/) · Electron 41 (vip://app)
 Server: server.js + server/securityHeaders.js (dev); api/ + api-routes/ (checkout, client-config; no audio)
 Optional local sidecar: services/sam-audio (Python, loopback-only bind, server.py:466)
```

Duplicated, abandoned or unclear-ownership systems (OBSERVED):

| Item | Evidence | Status |
|---|---|---|
| Two ML workers | `src/workers/MLWorker.js` (1,568 lines, canonical) and `public/app/ml-worker.js` (1,342 lines, "legacy SAB path") | Legacy worker should be removed or reduced to a shim |
| Unreferenced by any production entry point | `src/pipeline/LivePipeline.js`, `ProcessingOrchestrator.js`, `ProcessingPlanBridge.js`, `src/presentation/ExportControls.js`, `IsolationModeSelector.js`, `src/core/BufferPool.js`, `src/ui/components/RegionActionPalette/*`, `src/ui/components/Transport/*` | Dead in production; some are test-only |
| Patch-layer files | `vip-fixes.js` (989 lines), `mobile-upload-fix.js`, `m4a-decode-fix.js`, comment "PATCHED BY vip-fixes.js — consider merging" at `app.js` near line 2687 | Monkey-patch layering on a frozen file |
| CLAUDE.md layer table vs reality | `BufferPool.js` listed as the zero-GC pool; nothing in production imports it | Doc drift |
| Model README | `public/app/models/README.md:14-15` says BSRNN "~45 MB, manual download" and RNNoise "~180 KB, manual download"; both are committed at 3.87 MB and 2.03 MB | Stale |

Architecture verdict: the `src/` 4-layer design is sound and is the right base for Web, Android and Desktop, because all three consume one `build/`. The blocker to reliable development is the 8,106-line `app.js` plus ~75 patch and feature files under `public/app/` that share global state (`window.VIP_PARAMS`, `app.params`, `window.__vip*` hooks). Two of the confirmed defects below (section 10) come straight from that global-state coupling.

---

## 5. Audio execution trace

### 5.1 Engineer (shipping default)

| # | Stage | Code | In → Out | Thread | Cancel / errors |
|---|---|---|---|---|---|
| 1 | File pick | `app.js` file input / Drive / `DesktopBridge` | File → Blob | main | n/a |
| 2 | Decode | `ensureDecoded` → `media-decode.js`, `FileIngestion.js:178-196` | Blob → AudioBuffer, resampled to 48 kHz via OfflineAudioContext | main (native decode) | errors surface as notification |
| 3 | Snapshot | `app.js:5170` `buildMlProcessingConfig(getEffectiveParams(window.VIP_PARAMS))` | 27 spectral + 2 post-stem params → versioned config + revision | main | n/a |
| 4 | Cache checks | `app.js:5176-5189` (retained stems), `5192-5253` (durable OPFS/IDB) | skip inference when file and revision match | main | durable errors logged, fall through |
| 5 | Channel plan | `_mlChannelPlan` | stereo → mid (one inference pass) | main | n/a |
| 6 | Inference | `app.js:5283` `separateStems` → `MLWorkerHost` → `MLWorker.js:1340 processRequest` | Float32 mid → clean Float32 (transferred) | worker | `checkCancelled` per batch (`MLWorker.js:108-160`); ONNX call itself not interruptible |
| 7 | STFT | `MLWorker.js:850-1025` | fft 4096, hop 1024 or 2048 (`adaptiveHopSize` `:306`), periodic Hann, real FFT | worker | |
| 8 | Mask | `MLWorker.js:952-985` | product of sigmoid masks, one-pole temporal smoothing 0.55, fixed HF taper above 35% of Nyquist, then `EngineerSpectralControls.applyFrame` | worker | malformed tensor throws |
| 9 | iSTFT + norm | `MLWorker.js:986-1020` | WOLA divided by measured window² sum, floored at 0.5 × max, 8 ms edge fades | worker | |
| 10 | Residual | `MLWorker.js:1104` | noise = input − clean | worker | |
| 11 | Revision ack | `app.js:5317` | throws if worker did not apply the snapshot revision | main | throws → DSP fallback |
| 12 | Reconstruct | `app.js:5335-5366` | budgeted copy, mid→stereo expand, post-stem controls, dewhistle, AudioBuffer | main, cooperative | `_throwIfProcessAborted` |
| 13 | Safety limiter | `app.js:4653-4671` | in-place brickwall on outputBuffer | main, async | |
| 14 | Live-Mix | `_loadSeparationStemsToBridge` → `EngineerModeBridge` → `PlaybackMixer` | clean + noise stems → gains, EQ, comp, gate/de-ess worklets | audio thread | |
| 15 | Export | `app.js:4107-4199` `_downloadProcessed` | **procBuffer (clean stem)** → WAV | main | **Live-Mix not included (AUD-001)** |

Fallback branch (`app.js:5451`), taken whenever step 6 throws or returns passthrough: DC removal, click repair, gate and de-ess run **synchronously over the whole mid channel** (`app.js:5522-5550`), then one bounded spectral STFT (`_spectralStageAsync`, `app.js:6090`). The progress label says "Spectral isolation (DSP fallback)", but the final "Complete" state (`app.js:4690`) does not say which engine produced the result.

### 5.2 Landing

`landing.js:1306 onProcess` → immutable `QuickCleanPlan` → own worker (`ensureWorkerReady`) → `postMessage({ type: 'process', modelIds })` (no Engineer config) → `installStems` (`:1392`) → `PlaybackMixer` → export by `mixer.renderMix()` (`landing.js:569`). Passthrough from the worker is surfaced as a failure (`landing.js:1408-1413`), which is correct. A watchdog (`landing.js:1349`) kills the job after 45 s without progress **or 300 s total, even while progressing** (AUD-006).

### 5.3 Microphone

None. No `getUserMedia` in product code (VERIFIED by `pnpm check:privacy` and the Chromium egress smoke). `Permissions-Policy: microphone=()`. The directive's "real-time processing" and "microphone capture" capabilities do not exist by design (CLAUDE.md section 1.1); Live-Mix is real-time *playback* processing only.

---

## 6. DSP assessment

| Area | Finding | Label |
|---|---|---|
| Fused STFT / iSTFT | One forward, one inverse per channel; real-FFT path pinned by `tests/mlworker-real-fft.test.js`. Normalisation by the measured window² sum is correct for both 75% and 50% overlap. | OBSERVED + tests PASS |
| Hop vs time constants | Hop is 1024 under 90 s on desktop and 2048 above it, and always 2048 on mobile. The 0.55 mask smoother is per frame, so its e-fold time constant (-1/ln 0.55 = 1.67 frames) doubles from about 36 ms (hop 1024) to 71 ms (hop 2048) at 48 kHz, depending on file length and device class. Output character depends on file duration. | INFERRED |
| Fixed HF taper | `MLWorker.js:980-983` cuts the clean mask linearly above 8.4 kHz, reaching about -1.2 dB at 12 kHz, -2.5 dB at 16 kHz and -6.9 dB at 24 kHz, on every file. This is not a user control and is not in the documented mask equation. Because noise = input − clean, that voice "air" moves into the noise stem. | OBSERVED (math from code) |
| Mask floor | Documented equation uses `max(M, M_floor ≈ -30 dB)`; the fused loop applies no floor (mask may reach 0). Engineer `nrFloor` only bounds the Engineer NR gain, not the model mask. | OBSERVED |
| Fallback click repair | `dsp-core.js:683 removeClicks` flags first-difference spikes against 5× the file-mean derivative. On a synthetic, click-free 2 s fixture (a continuous 150 Hz harmonic bed plus a 200 ms band-limited 4-9 kHz sibilant-like burst with 15 ms raised-cosine ramps), it rewrote 3,739 samples inside the burst and none elsewhere, lowering the burst by 1.45 dB. A positive control with 5 injected clicks was fully repaired. It always runs on the fallback path (`app.js:5527`). | VERIFIED on synthetic signals; not measured on recorded speech |
| Fallback de-esser | `dsp-core.js:790 deEss` keys off a +12 dB *peaking* boost (not a band-pass) with a fixed 0.1 linear threshold and applies broadband gain. With amount 50 it cut a pure 200 Hz tone at 0.3 by **2.04 dB** and a 6.5 kHz tone at 0.05 by 1.43 dB: it compresses vowels harder than sibilants. | VERIFIED |
| Fallback noise gate | `dsp-core.js:621` detects on single-sample \|x\| with hold; acceptable with the 50 ms default hold, chattery with hold near 0. | INFERRED |
| Playback worklets | `GateProcessor.js`, `DeEsserProcessor.js` (high-shelf sidechain), allowlisted, k-rate params. Not exercised numerically here. | OBSERVED |
| Gain staging | Safety limiter on every processed output (`app.js:4653`); ML masks are ≤ 1 so super-unity comes only from OLA edges and post controls. | OBSERVED |

---

## 7. ML / runtime assessment

| Item | Result | Label |
|---|---|---|
| `bsrnn_vocals.onnx` | 3,870,554 bytes, SHA-256 `7edd7c51…8141` equals manifest. Graph: 6 band encoders (Gemm), 2 LSTMs, 6 band decoders, Sigmoid. Input `[batch, 2049]`. | VERIFIED |
| `rnnoise_suppressor.onnx` | 2,027,576 bytes; GRU + MatMul; same I/O. | VERIFIED |
| Temporal context | Changing frames 0-3 in a batch changed frames 4-7 by exactly 0 for **both** models, and one frame alone equals the same frame in a batch. The recurrences run across frequency bands, not time. Each mask is computed from one 85 ms magnitude frame. | VERIFIED |
| Throughput | BSRNN, onnxruntime-web WASM, 1 thread, Node: 110.2 ms per 384-frame batch = 0.287 ms per frame. 15-min mono: about 12.1 s at hop 1024, 6.1 s at hop 2048 (this 4-core container; not a device benchmark). | VERIFIED |
| Mask range | `[0.000, 1.000]` on synthetic input | VERIFIED |
| Integrity | SHA-256 verified before session creation, and cached bytes re-verified (`MLWorker.js:363`) | OBSERVED + tests |
| Fake success | Landing treats passthrough as failure. Engineer falls back to real DSP, never silent passthrough, unless `DSPCore` is missing, in which case `app.js:5477-5481` returns the **original** as output and the run finishes "DONE / Complete" with no warning. | OBSERVED |
| Quality measurement | None. No SDR, SI-SDR, PESQ, STOI or golden-audio regression anywhere in `tests/` or `scripts/`. "Isolation works" is asserted only as "non-silent, finite buffer". | VERIFIED (grep) |
| Vendored ORT | `public/lib` is 79 MB tracked in git: 4 WASM variants (13 + 14 + 23 + 25 MB) plus `ort.js` 2.5 MB and a source map. At most two variants are needed for WebGPU + WASM. This inflates the APK and EXE (the 2026-09-09 commit records an APK of 101.6 MB). | VERIFIED (sizes) / INFERRED (which variants load) |

---

## 8. AI analysis / recommendation architecture

Trace: Audio → Analysis → Evidence → Recommendation → Plan → Validation → Execution → Evaluation.

| Stage | Reality | Label |
|---|---|---|
| Analysis | `FullAnalysisHost` / `FullAnalysisWorker`, classical features + optional Silero VAD; Landing via `AnalysisCoordinator` with content-fingerprint keys and stale handling | OBSERVED, tests PASS |
| When | Both surfaces run analysis **after** Process, on the **clean output** (`landing.js:1494-1499`, `app.js:4746-4763`). It cannot inform the processing it follows. | OBSERVED |
| Recommendation | Engineer: `recommendEngineerPreset` (`MixCalibration.js:299`) buckets output RMS into whisper / quiet / normal / loud and returns a preset plus fixed overrides. Landing: display-only text in `AnalysisInsightsUI`. | OBSERVED |
| Plan → controls | `ProcessingPlanBridge.planToControlPatch` with session and fingerprint validation exists and is tested, but **no production code imports it**. | VERIFIED (grep) |
| Execution | Engineer `_autoCalibratePreset` (`app.js:3208`, called at `:4727`) writes preset values and overrides straight into sliders, including Process-time controls (e.g. `nrAmount: 75` for "quiet", `MixCalibration.js:284`) **after** the stems were rendered with the earlier values. `analysis-workspace.js:835-836` writes protect/suppress regions consumed only by the DSP fallback. | OBSERVED |
| Evaluation | None. No before/after metric tied to a recommendation. | OBSERVED |
| Confidence | Confidence values are rendered (e.g. "Hum/buzz (71%)" in the Landing smoke). The smoke fixture is a 220 Hz tone at 0.2 plus uniform noise at ±0.04 (`scripts/quick-clean-smoke.cjs:41`): tone RMS 0.141, noise RMS 0.023, so about 15.7 dB input SNR by derivation. The panel reported "Signal quality: Low · SNR -0.0 dB". The SNR read-out does not match the input. | VERIFIED (smoke output) + derived |

Verdict: the intelligence contracts (snapshot validation, stale-plan rejection) are well built but not connected. The behaviour users see is a level classifier that silently changes settings after the fact.

---

## 9. Waveform interaction

| Capability | Status | Evidence |
|---|---|---|
| Waveform render, long files | PASS | budgeted envelope scan (#834), smokes PASS |
| Zoom / pan (wheel) | PARTIAL, OBSERVED | `SignalCanvas.js`, `diarization-timeline.js`; not browser-verified here |
| Scrub / seek | PASS | transport smokes |
| Range selection, crop for export | PASS | `TransportRegionControls`, Landing region export |
| Event markers | FAIL | no marker implementation found |
| Apply isolation/enhancement to a region | **FAIL** (ML path) / PARTIAL (`isolate` on DSP fallback only) | AUD-002 |
| Undo | FAIL | no undo stack for processing or slider changes |
| Before/after preview | PASS | Landing matched A/B smoke PASS; Engineer A/B toggle |

---

## 10. Findings ledger

Severity: BLOCKER > CRITICAL > HIGH > MEDIUM > LOW.

### CI-001: Production gate has not executed on `main` for 4 weeks
- **Severity:** BLOCKER. **Area:** CI/CD. **Label:** VERIFIED.
- **Evidence:** GitHub Actions `ci.yml` runs 37394492678 (#834), 37265305093 (#833), 37219514154 (#832), 37219306095 (#831), 37206631620 (#830): job `production-gate` completes in about 1 s, and the log endpoint returns 404. Last success: run 34413532273, 2026-09-09. `deploy.yml` runs 2649-2651: `skipped`.
- **Problem:** CLAUDE.md section 6 defines `prod:verify` in CI as the only definition of "verified". It has not run for any change merged since 2026-09-09, including #832-#834 (large perf and Landing rewrites).
- **User impact:** regressions ship unseen (CI-002 and A11Y-001 already did). Web deploy through `deploy.yml` has not run; whether Vercel's Git integration deployed instead is NOT VERIFIED.
- **Root cause:** NOT VERIFIED. A job that ends in about 1 s with no log usually means no runner was assigned (billing or spending limit, Actions disabled, or a bad runner label).
- **Correction:** owner checks repository Settings → Actions and the account billing page; re-run `ci` on `49d517e`; enable branch protection requiring `production-gate`.
- **Validation:** a green `ci` run on `main` with a downloadable `prod-verify` report.

### CI-002: Landing overflows horizontally at 390 px after Process
- **Severity:** HIGH. **Area:** Web / mobile UI. **Label:** VERIFIED.
- **Evidence:** `scripts/quick-clean-smoke.cjs:206` assertion "Mobile horizontal overflow: 73px" (`node scripts/prod-verify.mjs --only e2e-quick-clean`).
- **Impact:** sideways scroll on phones, including the Android WebView, which loads the same Landing. Introduced with the v3 layout (#833). The overflowing element is not yet identified.
- **Correction:** load `/` at 390 px, process the fixture, and find the element whose right edge exceeds `innerWidth` (e.g. with `[...document.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > innerWidth)`); constrain it with `min-width: 0` or `max-width: 100%`.
- **Validation:** `pnpm test:quick-clean` PASS.

### A11Y-001: Landing skip link fails WCAG AA (2.83:1)
- **Severity:** HIGH (gate failure). **Area:** accessibility. **Label:** VERIFIED.
- **Evidence:** `public/landing-v3.css:55` `body.v3 a { color: var(--v3-cyan) }` overrides `public/ps-shell.css:34-41` `.ps-skip-link { color: #fff }`. Measured by `scripts/shell-qa-smoke.cjs` at all five widths.
- **Correction:** raise the specificity of the skip-link color, e.g. `body.v3 .ps-skip-link, body.v3 .ps-skip-link:hover { color: #fff; }`.
- **Validation:** `pnpm test:shell-qa` PASS.

### AUD-001: Engineer export drops every Live-Mix control the user hears
- **Severity:** CRITICAL. **Area:** export / audio truthfulness. **Label:** OBSERVED.
- **Evidence:** `app.js:4107-4108` `const fullBuf = this.procBuffer || this.outputBuffer;` → `app.js:4199` `downloadWav(buf, …)`. After ML success, `procBuffer` is the post-processed clean stem (`app.js:5365-5366`). The 37 `LIVE_MIX_PARAM_IDS` (`ParameterSchema.js:201-209`: gate, 10-band EQ, compressor, limiter, HP/LP, de-ess, tilt, outGain, dryWet, width, voiceIso, bgSuppress) are applied only in `PlaybackMixer`. Landing exports `mixer.renderMix()` (`landing.js:569`), and its smoke shows "Exported PCM matches Voice/Background/Output mix: maxDelta 0". Engineer has no equivalent.
- **User impact:** the exported file sounds different from playback: no EQ, compression, gate or output gain, and no background bed when the user raised Background.
- **Root cause:** Engineer export predates the Live-Mix migration.
- **Correction:** route Engineer export (WAV, MP3, video, Drive) through `EngineerModeBridge` → `PlaybackMixer.renderMix({ startSec, endSec, signal })`, with the same worklet-unavailable error path as Landing.
- **Validation:** port the Landing "Exported PCM matches mix" check to `engineer-upload-smoke.cjs` with non-default EQ, outGain and Background.

### AUD-002: Waveform region actions do not change the audio but report success
- **Severity:** HIGH. **Area:** waveform interaction / truthfulness. **Label:** OBSERVED (code path read for both engines; not executed in a browser).
- **Scope by engine:**

  | Action | ML path (default) | DSP fallback (ML failed) |
  |---|---|---|
  | `isolate` | no change: retained stems reused | regions consumed by `_spectralStageAsync` (`app.js:5557-5566`), so audio does change |
  | `enhance`, `boost-whisper`, `reduce-noise` | no change | no change: fallback also reads `window.VIP_PARAMS` (`app.js:5472`), not `app.params` |

- **Evidence:** `public/app/premium-workspace.js:384-385` calls `window.__vipEngineerProcessSelection` (`public/app/lib/signal-canvas-integration.js:125-150`):
  - `isolate`: sets `_protectRegions` and calls `runPipeline()`. Regions are read only by the DSP fallback (`app.js:5557-5560`). With ML available, `_runMLIsolationPipeline` returns the retained stems unchanged because the revision did not change (`app.js:5176-5189`).
  - `enhance`, `boost-whisper`, `reduce-noise`: write `app.params.*`. Processing snapshots `window.VIP_PARAMS` (`app.js:5170-5171`), which is a separate object (`app.js:3122-3124`), the change applies to the whole file rather than the region, and no Process is triggered.
  - All four branches dispatch `ACTION_PREVIEWED`.
- **Impact:** on the default ML path, the headline "select a sound and isolate it" feature does nothing audible. The fallback row is a reading of the code; a browser test with ML disabled should confirm it.
- **Correction:** either implement region processing (region-scoped mask gain in the worker using frame ranges, or region-restricted Live-Mix gain automation) or hide the actions. At minimum, route the parameter actions through `_setSliderUi` so the change is visible and persists.
- **Validation:** E2E test: select a region, run Isolate, and assert that the output differs from the previous output inside the region and matches it outside.

### AI-001: Post-Process auto-calibration rewrites Process-time controls from the output
- **Severity:** HIGH. **Area:** AI / state truthfulness. **Label:** OBSERVED.
- **Evidence:** `app.js:4722-4727` idle callback → `_autoCalibratePreset(this.outputBuffer)` (`app.js:3208-3249`) → `recommendEngineerPreset` (`MixCalibration.js:299`) applies a full preset plus overrides (e.g. `nrAmount: 75`) and later `autoTuneParamsAsync` suggestions via `_setSliderUi`.
- **Impact:** the sliders no longer describe the audio the user is hearing. The next Reprocess silently re-runs ML with different settings. The classifier reads the already-cleaned output, so its "level" is a property of the processing, not the source.
- **Correction:** run calibration on the input, before Process, as a proposal ("Apply suggested settings") through `planToControlPatch`. Never mutate Process-time controls after the fact. Mark sliders whose value differs from the applied revision as "pending Reprocess".
- **Validation:** unit test that a Process → idle cycle leaves Process-time slider values unchanged; E2E test that Reprocess without user edits takes the retained-stems path.

### AUD-003: Fallback click repair damages sibilants
- **Severity:** MEDIUM (fallback path only). **Label:** VERIFIED on synthetic signals; INFERRED for recorded speech.
- **Evidence:** `dsp-core.js:683-777`; always invoked at `app.js:5527`.
  - `dsp-sibilant-probe.cjs` (band-limited 4-9 kHz burst, ramped edges, continuous voiced bed, no clicks): 3,739 samples changed inside the burst, 0 outside, burst level -1.45 dB, burst RMS error 0.0535. Positive control: 5 of 5 injected clicks repaired.
  - `dsp-probe.cjs` (cruder fixture: differenced white noise with hard edges): 4,112 samples changed, -2.3 dB. The hard edges make this one a weaker test, so it is kept only as a secondary result.
  - The probes show the detector misfires on dense high-frequency content. They do not measure audibility on real speech; a recorded-speech golden test is still needed.
- **Correction:** gate the derivative test on a local (not file-global) derivative median, require the amplitude test as well, and default `clickSensitivity` to off unless the analyzer detected clicks.
- **Validation:** golden test: click-free speech-plus-noise is unchanged within 1e-6; injected clicks are repaired.

### AUD-004: Fallback de-esser is a broadband compressor
- **Severity:** MEDIUM (fallback path only). **Label:** VERIFIED.
- **Evidence:** `dsp-core.js:790-822`. Probe: 200 Hz tone -2.04 dB versus 6.5 kHz tone -1.43 dB at amount 50.
- **Correction:** band-pass sidechain (or a split-band design like `DeEsserProcessor.js`), threshold relative to band energy, and gain applied to the sibilance band only.
- **Validation:** probe asserts under 0.1 dB change on a 200 Hz tone and more than 3 dB on a loud 6.5 kHz burst.

### PERF-001: DSP fallback freezes the main thread for seconds
- **Severity:** MEDIUM. **Label:** VERIFIED (timing in Node V8).
- **Evidence:** `app.js:5522-5550`, synchronous over the whole mid channel. On 5 min mono, median of 5 warmed runs: `removeClicks` 1,180 ms, `noiseGate` 155 ms, `deEss` 149 ms, `removeDCOffset` 52 ms, about 1.5 s in one task; about 4.6 s at 15 min by linear scaling. This violates the CLAUDE.md "full-length buffers never move in one task" rule. It is reached exactly when ML failed, often on weaker devices.
- **Correction:** move the conditioning chain into `SpectralCleanupWorker` (or a new DSP worker), or wrap each pass in `processInChunks` with carried filter state.
- **Validation:** `perf-harness.cjs --surface engineer --secs 300` with ML forced off; max long task under 250 ms.

### AUD-005: Silent passthrough reported as "Complete" when DSP is unavailable
- **Severity:** MEDIUM. **Label:** OBSERVED.
- **Evidence:** `app.js:5477-5481` sets `outputBuffer = buf` (the original); `runPipeline` then reaches `setStatus('DONE')` (`app.js:4692`) with no engine indicator. `_mlIsolationSucceeded` is never surfaced to the UI.
- **Correction:** keep a `processingEngine: 'ml' | 'dsp-fallback' | 'passthrough'` result, show it in the completion state and Integrity card, and treat passthrough as an error, as Landing does.
- **Validation:** unit test with `_resolveDSP` returning null and ML failing → status ERROR.

### AUD-006: Landing aborts any job longer than 300 s, even while progressing
- **Severity:** MEDIUM. **Label:** OBSERVED; device impact INFERRED.
- **Evidence:** `landing.js:1349` returns early only if `progress < 45 s ago && elapsed < 300 s`; otherwise it terminates the worker with "The worker stopped responding".
- **Impact:** long files on low-end Android WASM can be killed while healthy, with a misleading message. Measured desktop throughput (section 7) makes this unlikely on desktop.
- **Correction:** remove the total-time cap or scale it with duration; keep the no-progress watchdog.
- **Validation:** unit test with fake timers: steady progress past 300 s is not aborted.

### ML-001: Isolation quality is unmeasured and model capability is overstated
- **Severity:** HIGH. **Label:** VERIFIED.
- **Evidence:** both models are stateless per frame (section 7); no quality metric exists in the repo; naming ("Band-Split RNN", "BiGRU noise suppressor") implies temporal modelling.
- **Correction:** add an SI-SDR / SDR regression set (e.g. 10 short licensed speech + noise mixtures under `tests/fixtures/quality/`, run through `MLWorker` in Node with onnxruntime-web, as this audit did), with thresholds pinned per model version. Describe the models accurately in the UI and docs.
- **Validation:** `pnpm test:quality` in `prod:verify`.

### DSP-001: Fixed HF taper and missing mask floor on every ML output
- **Severity:** MEDIUM. **Label:** OBSERVED.
- **Evidence:** `MLWorker.js:922`, `980-983`; no `M_floor` in `952-985` versus CLAUDE.md section 1.2 mask equation.
- **Correction:** make the taper a documented Process-time parameter, default it to a gentler slope above ~12 kHz, and apply `max(M, 10^(-30/20))` as documented, or update the documented equation.
- **Validation:** frequency-response test on white noise with mask = 1.

### DSP-002: Mask smoothing time constant depends on file length and device
- **Severity:** LOW. **Label:** INFERRED.
- **Evidence:** `MLWorker.js:306-336` (hop 1024 versus 2048) with a per-frame constant at `:929`.
- **Correction:** derive the coefficient from a fixed time constant: `exp(-hop / (τ · sr))`.

### SEC-001: Engineer surface keeps `'unsafe-inline'` scripts plus third-party script origins
- **Severity:** MEDIUM. **Area:** security. **Label:** OBSERVED.
- **Evidence:** `server/securityHeaders.js:45`; `vercel.json` (`/app/` header block): `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://www.gstatic.com https://apis.google.com https://accounts.google.com`.
- **Impact:** any HTML injection in the main working surface becomes script execution; audio in memory is reachable from it.
- **Correction:** move the remaining inline scripts in `public/app/index.html` to files, add hashes for any that must stay, and drop `'unsafe-inline'`.
- **Validation:** `tests/` CSP guard asserts no `'unsafe-inline'` for `/app/`.

### PRIV-001: No audio egress found
- **Severity:** none (positive). **Label:** VERIFIED for Chromium journeys.
- **Evidence:** `pnpm check:privacy` PASS; `privacy-runtime` Chromium egress recorder PASS; network calls in `public/app` limited to `/api/client-config` (`revenuecat.js:69`), `/api/checkout` (`paywall.js:441`), Drive (`GoogleDriveBridge.js:125`, user-initiated); `analytics.js` is localStorage-only; SAM sidecar forces loopback (`services/sam-audio/server.py:466-468`).
- **Residual:** Drive export sends audio off-device on explicit user action (ADR-002). Firebase auth scripts load from `gstatic.com` (ADR-001 exception).

### AND-001: Foreground-service permissions without a service; no background processing story
- **Severity:** MEDIUM. **Area:** Android. **Label:** OBSERVED; runtime NOT VERIFIED.
- **Evidence:** `android/app/src/main/AndroidManifest.xml:48-52` declares `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `WAKE_LOCK`, `POST_NOTIFICATIONS`; no `<service>` element; `MainActivity.java` has no wake lock or lifecycle hooks.
- **Impact:** Play Console requires a justification for each foreground-service type it sees, and an undeclared one risks review rejection. Processing stalls when the screen locks because the WebView pauses, and Landing's 45 s no-progress watchdog then fails the job on resume (INFERRED).
- **Correction:** remove the unused permissions, or implement a media-playback foreground service. Keep the screen on (`FLAG_KEEP_SCREEN_ON` through a small plugin) while a Process job runs. Pause the watchdog on `visibilitychange`.
- **Validation:** device test: start a 5-minute Process, lock for 60 s, unlock, and the job completes.

### AND-002: Media-read permission requested though uploads use the system picker
- **Severity:** LOW. **Label:** OBSERVED.
- **Evidence:** `MainActivity.java:93` `requestReadMediaPermissionIfNeeded` (deferred after first paint); uploads use a file chooser (`installUploadFileChooser`, `:230`), which needs no media permission.
- **Correction:** drop the prompt unless a gallery-browse feature needs it.

### AND-003: `minSdkVersion` disagreement
- **Severity:** LOW. **Label:** OBSERVED.
- **Evidence:** `android/variables.gradle:2` = 23, `android/app/build.gradle:24` = 26 (the app value wins).
- **Correction:** single source in `variables.gradle`.

### SIZE-001: 79 MB of vendored ONNX Runtime variants tracked and shipped
- **Severity:** MEDIUM. **Label:** VERIFIED (sizes) / INFERRED (unused variants).
- **Evidence:** `public/lib/ort-wasm-simd-threaded{,.jsep,.asyncify,.jspi}.wasm` = 13 + 25 + 23 + 14 MB; `ort.js` 2.5 MB; `ort.min.js.map` 1.4 MB; three copies of Three.js (`three.min.js`, `three.module.min.js`, `three.core.min.js`).
- **Correction:** log which variants the privacy-runtime smoke actually fetches; ship only those in `build/`; move the rest out of git (fetched at `postinstall`).

### ARCH-001: Dead or unreferenced production modules
- **Severity:** LOW. **Label:** VERIFIED (grep over `public/` and `src/`, excluding `public/src` mirror).
- **Evidence:** section 4 list.
- **Correction:** delete, or move to `src/experimental/` with a README; update the CLAUDE.md layer table.

### ARCH-002: Shared mutable global state across `app.js` and patch files
- **Severity:** MEDIUM. **Label:** OBSERVED.
- **Evidence:** `window.VIP_PARAMS` and `app.params` diverge (`app.js:3122-3124` versus `signal-canvas-integration.js:139-148`); `window.__vipEngineerProcessSelection`, `__VIP_JOBS__`, `__vipStftBudget` hooks; `vip-fixes.js` patches.
- **Impact:** directly caused AUD-002.
- **Correction:** one `EngineerState` store (extend `src/state/audioSessionStore.js`) with `setControl(id, value, { source })`; every writer goes through it.

### DOC-001: Stale and contradictory documentation
- **Severity:** LOW. **Label:** VERIFIED.
- **Evidence:** `public/app/models/README.md:14-15`; `docs/audits/README.md` lists the 2026-06-21 report as "Current"; `DEEP_AUDIT_2026-08-19.md` reports CI PASS, which no longer holds; CLAUDE.md lists `BufferPool.js` as active.

### TEST-001: Critical behaviours with no protection
- **Severity:** HIGH. **Label:** VERIFIED (absence by grep and reading).
- **Gaps:** Engineer export equals Live-Mix (AUD-001); region actions change audio (AUD-002); sliders unchanged after Process (AI-001); separation quality (ML-001); fallback DSP golden audio (AUD-003, AUD-004); engine shown at completion (AUD-005); Android lifecycle; Firefox and Safari.

---

## 11. Capability matrix

| Capability | Status | Evidence | Problem | Required work |
|---|---|---|---|---|
| File import | PASS | upload smokes; invalid-type recovery PASS | none | none |
| Microphone capture | FAIL (by design) | CLAUDE.md 1.1; `microphone=()` | product is upload-only | none unless strategy changes |
| Playback | PASS | Engineer RT + Landing smokes | none | none |
| Real-time processing | PARTIAL | Live-Mix AudioParams + gate/de-ess worklets | playback-only; no live input | as designed |
| Offline processing | PASS | ML path; smokes produce non-silent stems | fallback DSP defects | AUD-003/004, PERF-001 |
| Noise reduction | PARTIAL | `rnnoise` head, Engineer spectral NR | quality unmeasured | ML-001 |
| Speech enhancement | PARTIAL | EQ / comp in Live-Mix | not exported on Engineer | AUD-001 |
| Source isolation | PARTIAL | BSRNN per-frame masks | no temporal context; unmeasured | ML-001 |
| Waveform | PASS | render + budgeted envelope | none | none |
| Waveform selection | PARTIAL | crop and selection work | region actions are no-ops on the ML path | AUD-002 |
| DSP | PARTIAL | fused STFT sound | fallback defects; HF taper | AUD-003/004, DSP-001 |
| ML inference | PASS | real, pinned, 0.287 ms per frame | none | none |
| Analysis | PASS | worker-based, stale-safe | runs after Process only | AI-001 |
| Recommendation engine | FAIL | RMS 4-bucket classifier | not evidence-backed, mutates state silently | AI-001 |
| Processing plan | FAIL | `planToControlPatch` unreferenced | contracts unused | AI-001 |
| Export | PARTIAL | Landing PASS (maxDelta 0) | Engineer drops Live-Mix | AUD-001 |
| Web | PARTIAL | Chromium 8/10 browser gates | 2 gates red; Firefox/Safari unverified | CI-002, A11Y-001 |
| Android | NOT VERIFIED | no SDK here | manifest issues | AND-001..003 |
| Desktop | PARTIAL | Electron security smoke 9/9 PASS | NSIS packaging unverified | build on Windows |
| Privacy | PASS | static + runtime egress PASS | Drive is opt-in | none |
| Accessibility | PARTIAL | shell-qa guards | 1 AA failure | A11Y-001 |
| Test coverage | PARTIAL | 3,548 unit tests, 10 browser journeys | gaps in TEST-001 | section 15 |
| CI/CD | FAIL (not executing, not a failing test) | gate not executing since 2026-09-09 | | CI-001 |
| Production build | PASS | `pnpm build` + worklet build verify | | none |

---

## 12. UI / UX findings

| Topic | Finding | Recommendation |
|---|---|---|
| Engine transparency | Completion never says ML versus DSP fallback versus passthrough (AUD-005) | Show the engine and backend (WebGPU/WASM) in the Integrity card |
| 67 controls | 27 Process-time, 37 Live-Mix, 2 post-stem and 1 export control share one rack; nothing marks which need Reprocess | Badge Process-time controls; show "pending Reprocess" when changed since the last run |
| Auto-changed sliders | AI-001 changes settings without consent | Proposal UI with Apply / Dismiss |
| Region palette | Offers actions that do nothing (AUD-002) | Hide until implemented |
| Mobile Landing | 73 px overflow (CI-002) | Fix before release |
| Analysis panel | "SNR -0.0 dB" on a ~15.7 dB SNR fixture (section 8) | Fix the SNR estimate; hide metrics below a confidence threshold |
| Advanced mode | Diarization, USM, research mode, Whisper Hunter and the debug menu all ship in the main shell | Move USM, research and debug into an Advanced drawer; keep Process, Mix, Compare and Export primary |

---

## 13. Performance findings

| Item | Result | Label |
|---|---|---|
| ML inference | 0.287 ms per frame (1-thread WASM), so a 15-min file takes about 6 to 12 s | VERIFIED |
| Post-ML main thread | #832-#834 moved full-length copies into budgeted slices; smokes PASS | OBSERVED |
| DSP fallback | ~1.5 s single task per 5 min, median of 5 (PERF-001) | VERIFIED |
| Bundle | 79 MB ORT variants (SIZE-001) | VERIFIED |
| Landing watchdog | 300 s hard cap (AUD-006) | OBSERVED |

---

## 14. Platform findings

**Web (Chromium):** 8/10 browser journeys PASS; privacy egress PASS; two regressions (CI-002, A11Y-001). Firefox and Safari NOT VERIFIED; WebGPU paths not exercised (headless used WASM).

**Android:** NOT VERIFIED (no SDK). Static review: Capacitor 8, target and compile SDK 35, cleartext off, debugging off, `minifyEnabled true`, FileProvider not exported; issues AND-001..003. Everything audio-related is WebView code shared with Web. Native code is the 406-line `MainActivity.java` (WebView hardening, file chooser, permissions).

**Desktop (Electron 41):** runtime security VERIFIED 9/9 (sandboxed preload, `vipDesktop` exposure, IPC traversal refusal, navigation lock, external-link policy). Packaging (NSIS, signing, auto-update) NOT VERIFIED here.

---

## 15. Testing strategy

| Layer | Add |
|---|---|
| Audio quality | `test:quality`: SI-SDR / SDR on fixed mixtures through `MLWorker` in Node; per-model thresholds |
| DSP golden | fallback chain on click-free speech, tone and sibilant fixtures; assert bounded change (AUD-003/004) |
| Export parity | Engineer: exported PCM equals `PlaybackMixer.renderMix()` with non-default Live-Mix (AUD-001) |
| Region | select → action → output differs inside and is equal outside (AUD-002) |
| State | Process-time sliders unchanged across Process + idle (AI-001) |
| Engine truth | ML off + DSP off → ERROR; ML off → "DSP fallback" shown (AUD-005) |
| Cross-browser | Playwright Firefox and WebKit for upload → Process → export on Landing |
| Android | instrumented smoke on an emulator in `release-build.yml`: launch, upload fixture, Process, lock/unlock |
| Perf | `perf-harness.cjs` in nightly CI with ML forced off as well as on |

---

## 16. Dead / duplicate code candidates

`public/app/ml-worker.js` (legacy worker), `src/pipeline/LivePipeline.js`, `src/pipeline/ProcessingOrchestrator.js` (documented inactive), `src/pipeline/ProcessingPlanBridge.js` (wire it or delete it), `src/presentation/ExportControls.js`, `src/presentation/IsolationModeSelector.js`, `src/core/BufferPool.js`, `src/ui/components/RegionActionPalette/`, `src/ui/components/Transport/`, `public/app/vip-fixes.js` (merge patches into owners), `public/lib/ort.js` + `ort.min.js.map` + unused WASM variants, duplicate Three.js builds, `mockup/`, `notebooks/`, superseded audit reports (`AUDIT_BASELINE.md`, `CORRECTIVE_AUDIT_REPORT.md` at the repository root).

---

## 17. Roadmap

**P0: production blockers**
1. CI-001: restore Actions execution; require `production-gate` on `main`.
2. A11Y-001: skip-link color (one CSS rule).
3. CI-002: Landing 390 px overflow.

**P1: core product correctness**
4. AUD-001: Engineer export through `renderMix`.
5. AUD-002: hide region actions, then implement region-scoped processing.
6. AI-001: stop post-Process slider mutation; turn calibration into a pre-Process proposal through `planToControlPatch`.
7. AUD-005: surface the processing engine; passthrough is an error.
8. ML-001: quality regression suite and honest model descriptions.
9. AND-001: Android permissions and screen-lock behaviour.

**P2: performance / architecture**
10. PERF-001, AUD-003, AUD-004: fallback DSP into a worker, with the two algorithm fixes.
11. AUD-006, DSP-001, DSP-002.
12. SIZE-001: trim ORT variants.
13. ARCH-002: single control-state store; retire `vip-fixes.js`.
14. ARCH-001: delete dead modules; remove the legacy ML worker.

**P3: polish**
15. SEC-001: drop `'unsafe-inline'` on `/app/`.
16. UI items in section 12; AND-002, AND-003; DOC-001.

---

## 18. Target architecture

Keep the current two-phase model. Converge on:

```
Shell (Landing | Engineer, same components)
  └─ EngineerState store (single writer API, revisioned)
       ├─ ProcessJob(snapshot) ─► MLWorker (fused STFT, masks, Engineer controls, region gains)
       │                           └─ DSPWorker (fallback chain, same snapshot contract)
       ├─ Live-Mix: PlaybackMixer (+ worklets)  ◄─ the only playback and export renderer
       └─ Intelligence: analyze(input) → snapshot → plan → validated patch → user Apply
```

Rules this adds: export always equals `renderMix`; nothing writes Process-time controls except the user or an accepted plan; every result carries `{ engine, backend, revision }`.

## 19. Recommended repository structure

```
src/core | src/workers | src/pipeline | src/presentation | src/state   (unchanged layering)
src/experimental/          LivePipeline, SAM3 integration, USM ONNX path
public/app/                index.html, engineer-console.*, app.js shrinking to wiring only
public/lib/                only runtime-loaded ORT variant(s) + one Three.js build
tests/quality/             SI-SDR fixtures and thresholds
docs/audits/               one current report + archive/
```

## 20. Production-readiness checklist

- [ ] `ci` green on `main` (CI-001)
- [ ] `pnpm prod:verify` green locally and in CI (CI-002, A11Y-001)
- [ ] Engineer export equals Live-Mix (AUD-001)
- [ ] No UI action reports success without a signal change (AUD-002, AUD-005)
- [ ] No silent settings mutation (AI-001)
- [ ] Separation quality thresholds pinned (ML-001)
- [ ] Android: lifecycle test on a device; permissions trimmed (AND-001)
- [ ] Windows NSIS built from the release SHA; `provenance:validate:strict` PASS
- [ ] Firefox and Safari journeys run at least once per release

## 21. Exact next implementation sequence

1. Owner: fix Actions execution; re-run `ci` on `49d517e`; confirm a log appears.
2. PR: skip-link CSS + Landing overflow fix → `pnpm test:shell-qa`, `pnpm test:quick-clean` green.
3. PR: Engineer export through `EngineerModeBridge`/`PlaybackMixer.renderMix` + export-parity smoke.
4. PR: hide the region palette actions; route parameter actions through `_setSliderUi`.
5. PR: remove the `_autoCalibratePreset` call from the post-Process idle path; add a pre-Process "Suggested settings" proposal using `planToControlPatch`.
6. PR: `processingEngine` result field + completion UI; passthrough → ERROR.
7. PR: `tests/quality` SI-SDR harness (Node + onnxruntime-web, as used in this audit) wired into `prod:verify`.
8. PR: fallback DSP chain into a worker; fix `removeClicks` and `deEss` with golden tests.
9. PR: Android manifest cleanup + keep-screen-on during Process + watchdog pause on hidden.
10. PR: ORT variant trimming; dead-module removal; docs refresh.

---

## Appendix A: reproduction scripts

The probes are checked in under `scripts/audit/2026-10-06/`, with the expected outputs listed in its `README.md`. Every input is generated inside the script (fixed LCG seed 1 for noise), so the results are deterministic apart from timings.

| Evidence | Command | Expected |
|---|---|---|
| AUD-003 (primary) | `node scripts/audit/2026-10-06/dsp-sibilant-probe.cjs --check` | 3739 samples changed in the burst, 0 elsewhere; -1.45 dB; 5/5 control clicks repaired |
| AUD-003 (secondary), AUD-004 | `node scripts/audit/2026-10-06/dsp-probe.cjs --check` | 4112 of 96000 samples modified; sibilant RMS 0.1207 -> 0.0931; de-ess -2.04 dB at 200 Hz, -1.43 dB at 6.5 kHz |
| PERF-001 | `node scripts/audit/2026-10-06/dsp-timing.cjs` | median of 5 per pass (machine-dependent) |
| Section 7 hash, range, throughput | `node scripts/audit/2026-10-06/ort-bench.mjs` | sha256 `7edd7c51...8141`; mask range [0.000, 1.000]; 0.285-0.287 ms/frame on the audit container |
| Section 7 temporal context | `node scripts/audit/2026-10-06/ort-temporal-context.mjs` | both deltas `0.00e+0` for both models |
| Browser tier | `node scripts/prod-verify.mjs --only e2e-live,e2e-engineer-rt,e2e-engineer-upload,e2e-calibration,e2e-tier-picker,e2e-ui,e2e-landing,e2e-quick-clean,e2e-shell-qa,privacy-runtime` | 8 PASS, 2 FAIL (section 3) |
| Electron | `xvfb-run -a node scripts/electron-security-smoke.cjs` | 9/9 PASS |

# Engineer controls inventory (VIP-021)

Complete inventory of every visible Engineer control, the processing parameter or action it changes, and the pipeline/worker entry point that consumes it. Written 2026-11-04 from the slider registry plus verified wiring. Slider rows below were generated from `SLIDER_REGISTRY` at that time; `tests/engineer-controls-inventory.test.js` fails if any registry id or any interactive `index.html` id is missing from this document, so the inventory cannot silently drift when controls are added.

## Canonical sources

- `public/app/slider-map.js` — `SLIDER_REGISTRY`, the single source of truth for slider id, label, range, step, default, unit, group, target, and hints. `public/app/app.js` overlays the same registry (`SLIDER_REG_BY_ID`) and keeps a legacy inline `SLIDERS` block whose ranges are overlaid from the registry, so the two cannot drift.
- `src/core/ParameterSchema.js` — canonical bounds, defaults, execution path, `LIVE_MIX_PARAM_IDS` (37 real-time ids), and `buildMlProcessingConfig()` for the Process-time snapshot.
- `docs/guides/DSP_SLIDERS.md` — semantic guide to the slider rack (what each band does, platform behavior). This document is the inventory and entry-point map; that document is the meaning guide. Architecture itself lives in `CLAUDE.md` and is authoritative there; this document does not restate it, it only maps each control to the entry point that consumes it.
- `public/app/index.html` — the Engineer UI shell. The landing page (`public/index.html`) is a separate surface and is covered only in the short section at the end.

## How a slider change reaches audio

Every slider row (range + number + reset + lock, built by `createDspSliderRow` in `src/presentation/DspSlider.js`) funnels through one path:

1. `_setSliderUi(id, value)` → `_setSliderUiInner` clamps and step-snaps the value (`normalizeSliderValue` in `src/presentation/DspSlider.js`: out-of-range values clamp to `[min, max]`, values snap to `step`, non-numeric input falls back to the registry default), writes `window.VIP_PARAMS[id]` and `this.params[id]`, updates the row UI, then calls `onSlider(id, value)`.

2. `onSlider` rAF-batches rapid drags, then `_applySliderImmediate`: real-time ids go to the Live-Mix bridge (`EngineerModeBridge.applyParam` → `PlaybackMixer` → AudioParams / `vip-gate` / `vip-deesser` worklets), with `_applySliderToWorklet` (calibrated transform → worklet AudioParam + port message) as fallback. No ML re-run happens on drag — separation→isolation ids (`voiceIso`, `bgSuppress`) only rebalance already-separated stems.

3. Process-time ids do nothing audible on drag. Their values ride the next `Process`/`Reprocess` through `getEffectiveParams` → `buildMlProcessingConfig()` → `MLWorker` / `EngineerSpectralControls` inside the single STFT/iSTFT frame loop; the config revision participates in the stem cache key. Export-only `ditherAmt` never touches preview PCM; it applies only inside the 16-bit WAV encoder.

## Locks, presets, and stale-state prevention

- Each slider row has a lock button (`_sliderLocks`). Locks block drag, keys, number entry, presets, reset, and auto-calibrate: every one of those paths funnels through `_setSliderUiInner`, which refuses a locked id unless forced. The palette parameter actions report locked ids in their notice instead of silently skipping them. Per-row reset restores the registry default for that id only.
- `resetSlidersBtn` resets all sliders (prompts unlocked-only vs all); `resetUnlockedBtn` resets unlocked sliders only.
- User-touched sliders are tracked (`_userTouchedSliders`) and preserved where auto-calibration would otherwise overwrite them; slider values persist to the session (`_scheduleSessionPersist`).
- `whisperMode` is special-cased in `_setSliderUiInner`: it goes through `_setWhisperMode`, not the generic row path, and selects a compound state (OSF, gate Q, mask floor, post gain, pass count — see `WHISPER_MODE_STATES` in `app.js`: Off/Light/Heavy/Forensic = 1/2/3/4 passes).

## Validation at the boundary

- Ranges/steps/defaults: `normalizeSliderValue` (clamp + step snap + numeric fallback), applied at mount, at every programmatic set, and at number-input commit. `ParameterSchema.valueForConfig` clamps again at snapshot time, so a value can never reach DSP outside its schema range.
- Focus-band combination: `protectSpeechWindow` (`public/app/slider-calibration.js`) enforces a protected speech window on `voiceFocusLo`/`voiceFocusHi` — a reversed or too-narrow band is expanded around its midpoint toward the speech corridor instead of mutating the UI values. The effective (clamped) pair is what processing uses.
- EnhanceGuard: selecting the Enhance Speech outcome on a low-SNR fixture falls back to Clean Speech (`bsrnn_vocals`) unless the user explicitly overrides; the fallback is reported, never silent. Verified in the browser by the quick-clean smoke.
- Disabled states are state-driven, not decorative: `Process`/`Reprocess` stay disabled until a file is loaded; `Save Original`/`Save Processed`/`Save to Drive`/`Audit Log`/`Save Integrity` stay disabled until the corresponding output or log exists; the analysis Cancel button is hidden until an analysis runs; `modelSelect` on the landing page disables while a backend is unavailable or a job is in flight.

## Execution state, progress, and cancellation

- Processing state is shown by the processing overlay (`public/app/processing-overlay.js`): stage name, elapsed time, ORT/model pill, and a Cancel button that takes focus when processing starts. `Process`/`Reprocess`/`Analyze + Process` all funnel into `runPipeline()`; analysis actions funnel into `runCoordinatedAutoAnalysis`.
- Cancellation: the overlay Cancel button (`procCancelBtn`) and the mobile Stop button both set `abortFlag` and call `JobController.cancelCurrent` / `cancelActiveJobs`. Chunked processing (`processInChunks`) yields on elapsed work and aborts between chunks; analysis cancellation aborts the analysis `AbortController`. The quick-clean smoke verifies cancellation restores an actionable state (source unchanged, retry works) and that retry completes the maximum-isolation chain.
- Effective parameters are observable after the fact: the comparison status line reports level matching, and provenance `recordOperation` calls record the applied parameters (e.g. region actions record `applied` ids/values) in the audit log, which `Audit Log` downloads.

## Sliders (67)

`RT` = real-time Live-Mix (audible immediately, no re-run). `PROC` = process-time (audible at next `Process`). Ranges, steps, and defaults are the registry values at generation time.

### Gate (6)

| Control | Range | Step | Default | Unit | When | Entry point |
|---|---|---|---|---|---|---|
| `gateThresh` (Gate Threshold) | -120–0 | 5 | -42 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `gateRange` (Gate Range) | -120–0 | 5 | -60 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `gateAttack` (Gate Attack) | 0–200 | 5 | 5 | ms | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `gateRelease` (Gate Release) | 10–2000 | 50 | 200 | ms | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `gateHold` (Gate Hold) | 0–500 | 25 | 20 | ms | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `gateLookahead` (Lookahead) | 0–20 | 1 | 2 | ms | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |

### Noise reduction (5)

| Control | Range | Step | Default | Unit | When | Entry point |
|---|---|---|---|---|---|---|
| `nrAmount` (NR Amount) | 0–100 | 5 | 52 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `nrSensitivity` (NR Sensitivity) | 0–100 | 5 | 48 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `nrSpectralSub` (Spectral Sub) | 0–100 | 5 | 35 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `nrFloor` (NR Floor) | -120–-20 | 5 | -68 | dB | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `nrSmoothing` (NR Smoothing) | 0–100 | 5 | 32 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |

### EQ (10)

| Control | Range | Step | Default | Unit | When | Entry point |
|---|---|---|---|---|---|---|
| `eqSub` (Sub (< 60 Hz)) | -24–24 | 0.5 | 0 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `eqBass` (Bass (60–200 Hz)) | -24–24 | 0.5 | 0 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `eqWarmth` (Warmth (200–500 Hz)) | -24–24 | 0.5 | 0 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `eqBody` (Body (500 Hz–1 kHz)) | -24–24 | 0.5 | 0 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `eqLowMid` (Low Mid (1–2 kHz)) | -24–24 | 0.5 | 0 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `eqMid` (Mid (2–4 kHz)) | -24–24 | 0.5 | 0 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `eqPresence` (Presence (4–6 kHz)) | -24–24 | 0.5 | 0 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `eqClarity` (Clarity (6–10 kHz)) | -24–24 | 0.5 | 0 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `eqAir` (Air (10–16 kHz)) | -24–24 | 0.5 | 0 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `eqBrill` (Brilliance (> 16 kHz)) | -24–24 | 0.5 | 0 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |

### Dynamics (8)

| Control | Range | Step | Default | Unit | When | Entry point |
|---|---|---|---|---|---|---|
| `compThresh` (Comp Threshold) | -60–0 | 1 | -24 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `compRatio` (Comp Ratio) | 1–20 | 0.5 | 4 | :1 | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `compAttack` (Comp Attack) | 0.1–200 | 5 | 10 | ms | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `compRelease` (Comp Release) | 10–2000 | 50 | 150 | ms | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `compKnee` (Comp Knee) | 0–24 | 1 | 6 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `compMakeup` (Makeup Gain) | -12–24 | 0.5 | 0 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `limThresh` (Limiter Threshold) | -24–0 | 1 | -1 | dBFS | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `limRelease` (Limiter Release) | 1–500 | 10 | 50 | ms | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |

### Spectral (8)

| Control | Range | Step | Default | Unit | When | Entry point |
|---|---|---|---|---|---|---|
| `hpFreq` (HP Freq) | 10–1000 | 10 | 80 | Hz | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `hpQ` (HP Q) | 0.5–10 | 0.5 | 0.707 |  | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `lpFreq` (LP Freq) | 1000–20000 | 500 | 14000 | Hz | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `lpQ` (LP Q) | 0.5–10 | 0.5 | 0.707 |  | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `deEssFreq` (De-ess Freq) | 2000–16000 | 500 | 6500 | Hz | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `deEssAmt` (De-ess Amount) | 0–24 | 1 | 5 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `specTilt` (Spectral Tilt) | -12–12 | 0.5 | 0 | dB/oct | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `formantShift` (Formant Shift) | -12–12 | 1 | 0 | st | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |

### Advanced (6)

| Control | Range | Step | Default | Unit | When | Entry point |
|---|---|---|---|---|---|---|
| `derevAmt` (Dereverb Amount) | 0–100 | 5 | 0 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `derevDecay` (Rev Decay Est.) | 0–100 | 5 | 30 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `harmRecov` (Harmonic Recovery) | 0–100 | 5 | 0 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `harmOrder` (Harmonic Order) | 1–8 | 1 | 3 |  | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `stereoWidth` (Stereo Width) | 0–200 | 10 | 100 | % | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `phaseCorr` (Mono Correlation) | 0–100 | 5 | 0 | % | PROC | Process-time: app clean-stem post stage at `Process` (stereo sources) |

### Separation (5)

| Control | Range | Step | Default | Unit | When | Entry point |
|---|---|---|---|---|---|---|
| `voiceIso` (Voice Isolation) | 0–100 | 5 | 72 | % | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `bgSuppress` (BG Suppress) | 0–100 | 5 | 38 | % | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `voiceFocusLo` (Voice Focus Lo) | 50–1000 | 25 | 100 | Hz | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `voiceFocusHi` (Voice Focus Hi) | 1000–16000 | 500 | 4500 | Hz | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `crosstalkCancel` (Crosstalk Cancel) | 0–100 | 5 | 0 | % | PROC | Process-time: app clean-stem post stage at `Process` (stereo sources) |

### Output (4)

| Control | Range | Step | Default | Unit | When | Entry point |
|---|---|---|---|---|---|---|
| `outGain` (Output Gain) | -24–12 | 0.5 | 0 | dB | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `dryWet` (Dry / Wet) | 0–100 | 5 | 100 | % | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |
| `ditherAmt` (Dither) | 0–3 | 1 | 0 |  | PROC | Export only: 16-bit WAV encoder (`Save Processed`, `Save to Drive`, analysis export) |
| `outWidth` (Output Width) | 0–200 | 10 | 100 | % | RT | Live-Mix: `EngineerModeBridge.applyParam` / worklet AudioParam (calibrated transform); no ML re-run |

### Extreme / Whisper (15)

| Control | Range | Step | Default | Unit | When | Entry point |
|---|---|---|---|---|---|---|
| `whisperLift` (Whisper Lift Gain) | 0–40 | 1 | 0 | dB | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `crowdNull` (Crowd Null Depth) | 0–100 | 1 | 0 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `bassCrush` (Bass Crush (Sub/Kick)) | 0–100 | 1 | 0 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `reverbStrip` (Reverb Strip (RT60)) | 0–2000 | 10 | 0 | ms | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `voiceTunnel` (Voice Tunnel (Formant)) | 0–100 | 1 | 0 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `musicKill` (Music Kill (Comb)) | 0–100 | 1 | 0 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `snrFloor` (SNR Rescue Floor) | -80–-20 | 1 | -52 | dBFS | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `whisperMode` (Whisper Mode) | 0–3 | 1 | 0 |  | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `whisperClarity` (Whisper Clarity) | 0–100 | 1 | 65 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `whisperSensitivity` (Whisper Sensitivity) | 0–100 | 1 | 55 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `whisperThreshold` (Whisper Threshold) | 0–100 | 1 | 50 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `transientShaper` (Transient Shaper) | -100–100 | 5 | 0 |  | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `breathControl` (Breath Control) | 0–100 | 1 | 0 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `roomCorrection` (Room Correction) | 0–100 | 1 | 0 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |
| `subHarmonic` (Sub Harmonic) | 0–100 | 1 | 0 | % | PROC | Process-time: `buildMlProcessingConfig()` snapshot → `MLWorker` / `EngineerSpectralControls` at `Process` |

## Non-slider controls

### Import and file

| Control | Parameter / action | Entry point |
|---|---|---|
| `fileInput` (hidden file input) | File chosen for import | `change` → `acceptUpload(file)` → decode → `vip:fileImported` event |
| `fileBtn` (Browse Files) | Opens the file picker | `openFilePicker()` |
| `openDriveUploadBtn` / `openDriveBtn` | Opens an audio/video file from Google Drive (downloads a local copy; processing stays local) | Drive picker → local copy → same import path |
| `clearFile` | Clears the current file | `_clearFile()`; confirms first if a buffer exists (unsaved processed audio would be lost) |
| `clearLocalDataBtn` | Clears local stored data | Local-data clear path in `app.js` |
| `importModeSelect` | Import mode for the file library | `FileLibraryUI` import-mode handling |
| `importProjectPackInput` (hidden) | File input backing pack import | `FileLibraryUI` pack import |

### Process actions

| Control | Parameter / action | Entry point |
|---|---|---|
| `processBtn`, `reprocessBtn`, `mobileProcessBtn`, `mobileReprocessBtn` | Run / re-run the full pipeline on current settings | `runPipeline()` |
| `procCancelBtn` (processing overlay) | Cancel the running job | `processing-overlay.requestCancel()` → `JobController.cancelCurrent('user')` + `abortFlag` + `cancelActiveJobs()` |
| `mobileStopBtn` | Stop from the mobile bar | `abortFlag = true` + `cancelActiveJobs()` |
| `heroCtaProcess` (landing hero) | Process from the landing hero | `runPipeline()` when enabled |
| `heroCtaUpload` (landing hero) | Upload from the landing hero | File picker path |
| `btn-whisper-hunter` | Run WhisperHunter isolation on the loaded buffer | `WHISPER_HUNTER.run(buffer, app)`; warns if no file is loaded or a run is already active, disables itself while running |

### Presets and slider management

| Control | Parameter / action | Entry point |
|---|---|---|
| `presetSel` | Apply a named preset (all unlocked sliders) | `applyPreset(name)` (calibrated presets via `getCalibratedPresets()`) |
| `openPresetModalBtn` / `closePresetModal` / `customPresetName` / `saveCustomPresetBtn` | Save the current slider state as a custom preset | Modal save in `app.js` → `src/core/CustomPresets.js`: snapshot of all 67 slider values (clamped, defaults filled), stored in `localStorage` under `vip.customPresets.v1`, merged into the runtime `PRESETS` map at boot, and added to `presetSel`. A name already used by a built-in preset is refused with a warning; re-saving under an existing custom name overwrites it. (Before the VIP-021 fix this button performed no save at all.) |
| `resetSlidersBtn` | Reset all sliders | Reset path in `app.js` (prompts unlocked-only vs all) |
| `resetUnlockedBtn` | Reset unlocked sliders only | Reset path restricted to unlocked ids |
| Per-row lock button (dynamic, one per slider row) | Lock / unlock one slider against preset and reset changes | `_sliderLocks`; presets and resets skip locked ids unless forced; palette actions report locked ids |
| Whisper-mode group (dynamic, 4 buttons in the Extreme tab) | `whisperMode` 0–3 (Off / Light / Heavy / Forensic) | `_setWhisperMode` via the `_setSliderUiInner` special case; selects a compound state (OSF, gate Q, mask floor, post gain, pass count) |

### Analysis workspace

| Control | Parameter / action | Entry point |
|---|---|---|
| `btnAnalyzeFull` | Analyze the full loaded audio | `runAnalysis()` → `runCoordinatedAutoAnalysis` (canonical analysis contract) |
| `btnApplyRecommendations` | Apply the analysis recommendation to sliders/preset | `applyRecommendations()` |
| `btnAnalyzeProcessAuto` | Analyze, then process automatically | `analyzeAndProcess()` |
| `btnAnalyzeWhisperCollab` | Analyze, build a protect/suppress map, then run WhisperHunter isolation | `analyzeAndWhisperCollab()` |
| `btnCancelAnalysis` (hidden until analysis runs) | Cancel the running analysis | Analysis `AbortController` abort path |
| `btnExportAnalysisWav` | Export the analysis result as WAV | Analysis export via the 16-bit WAV encoder (dither applies at this boundary too) |
| `audModeOriginal` / `audModeLayer` / `audModeProcessed` | Audition source mode | Analysis audition mode switch |
| `audPlay` / `audStop` / `audResetMix` | Audition playback and mix reset | Analysis audition transport |
| USM controls (`btnUsmSeparate`, `btnUsmQuery`, `btnUsmApplyMix`, `usmNumSources`, `usmQueryInput`) | None as manual controls — intentionally hidden | Backend-only: sources are discovered automatically after Analyze; see scope notes |

### Transport, A/B, and comparison

| Control | Parameter / action | Entry point |
|---|---|---|
| `tpPlay` / `tpPause` / `tpStop` | Playback transport | `togglePlayback()` / `pause()` / `stop()` |
| `tpRew` / `tpFwd` | Seek −10 s / +10 s | `seekDelta(∓10)` |
| `tpSeek` (range) | Seek position | Seek handler on the transport range input |
| `tpSpeed` / `tpSpeedDown` / `tpSpeedUp` | Playback rate | Transport speed handling |
| `tpLoop` / `tpCropIn` / `tpCropOut` / `tpCropClear` | Loop and crop region for playback | Transport loop/crop state |
| `tpAB` | A/B compare original vs processed (same timeline, instant switch) | `toggleAB()` |
| `playOrig` / `playProc` / `abToggle` | Hidden aliases | Forward to `tpAB` + `tpPlay` (see scope notes) |
| Engineer profile buttons (`data-profile`: meeting, studio, forensic, quick) | Apply a profile: session store profile + named preset | `__vipApplyProfile` → session store `PROFILE_CHANGED` + `applyPreset` (e.g. quick → Voice Clarity) |
| Compare buttons (`data-compare`) | Comparison mode (original / processed / removed) | Comparison-mode switch via the Live-Mix bridge |

### Signal workspace (waveform / spectrogram)

| Control | Parameter / action | Entry point |
|---|---|---|
| Waveform / spectrogram canvases (drag) | Select a time region (and, on the spectrogram, a time–frequency rectangle) | Pointer drag → `setSelection()` → session store `selectRegion()` → context palette shown at the selection center |
| Region palette buttons (`data-action`: isolate, enhance, reduce-noise, boost-whisper, preview) | Region actions for the current selection | `__vipEngineerProcessSelection` → `EngineerActionContract` plan → `_setSliderUi` / preview (rows below) |
| Region palette: Isolate | Protect the selected region during processing | `__vipEngineerProcessSelection({action: 'isolate'})` → `EngineerActionContract` plan → protect region (+ DSP fallback re-run, or ML-stem note when stems are file-wide) |
| Region palette: Enhance Voice | Apply Enhance Voice parameters for the selection | Same path with plan `{whisperLift: 6, voiceTunnel: 60}` → `_setSliderUi` for each id |
| Region palette: Reduce Noise | Apply noise-reduction parameters for the selection | Same path with plan `{nrAmount: 70, bgSuppress: 60}` |
| Region palette: Boost Whisper | Apply whisper-boost parameters for the selection | Same path with plan `{whisperLift: 12, voiceTunnel: 60}` |
| Region palette: Preview | Play the selected region, auto-pausing at its end | Same path → `playSelection()` (seeks, plays, stops at the region end) |
| `btnZoomToSelection` / `btnClearSelection` / `btnSelectedPlayback` | Zoom the canvas to the selection / clear it / play it | Premium workspace selection tools |
| Engineer nav (`data-nav`) | Switch Engineer sections | Premium workspace nav handling |
| `fullscreenSpectroBtn` | Fullscreen spectrogram view | Visuals bootstrap fullscreen handling |
| `vizIsoConfirmBtn` / `vizIsoConfirmCancel` | Confirm / cancel a visual frequency-band isolation | `_applyPendingIsolation()` / clear pending isolation + `vip:isolationBandClear` |

### Target speaker (dynamically mounted into `#targetSpeakerPanel`)

| Control | Parameter / action | Entry point |
|---|---|---|
| Start / end inputs + quick chips (First 2 s, First 3 s, Around playhead, Clip duration) | Enrollment window for the target voice | `TargetSpeakerUI` window selection |
| Enroll this voice | Enroll the window as the target voiceprint | ECAPA-TDNN embedding when the optional model is installed, otherwise the on-device mel voiceprint fallback (both local, no network) |
| Isolate target speaker | Soft-gain isolation of the enrolled voice on the processed stem | Target-speaker soft gain; no ML re-run |
| Clear enrollment | Drop the enrollment | Target-speaker clear path |

### Forensic, export, and library

| Control | Parameter / action | Entry point |
|---|---|---|
| `forensicToggle` | Show / hide the forensic panel | Forensic panel toggle in `app.js` |
| `saveOrigBtn` | Download the original as WAV | Original-buffer WAV download |
| `saveProcBtn` | Download processed audio (or video with processed audio when the source is a video) | Processed WAV/video export via the 16-bit encoder; `ditherAmt` applies here |
| `saveProvenanceBtn` | Download the SHA-256 provenance sidecar (`.viprovenance.json`) | `ForensicInspectorUI` sidecar download; disabled until an export exists; integrity metadata only, not a signature or legal certification |
| `auditLogBtn` | Download the processing audit log | `downloadAuditLog()`; disabled until log entries exist |
| `saveDriveBtn` | Upload the processed export to Google Drive | `GoogleDriveBridge` + Firebase Google Auth (`drive.file` scope); export only, never called from MLWorker / worklets / Process |
| `projectSelect` / `newProjectBtn` / `libraryRefreshBtn` | Project switching, creation, and library refresh | `FileLibraryUI` project/library handling |
| `exportProjectPackBtn` / `importProjectPackBtn` | Export / import a `.vippack` for desktop/Android handoff | `FileLibraryUI` pack handling |

### View-only controls (no processing parameter)

| Control | What it changes |
|---|---|
| Slider group tabs (`tab-gate`, `tab-nr`, `tab-eq`, `tab-dyn`, `tab-spec`, `tab-adv`, `tab-sep`, `tab-out`, `tab-extreme`) | Which slider panel is shown |
| Visualization tabs and buttons (`btn-spectrogram`, `btn-waveform`, `btn-abcompare`, `btn-lufs`, `btn-clusters`, `btn-aura`, `btn-topo`, `btn-swarm`, `btn-liquid`, `btnVizTabPrev`, `btnVizTabNext`, `btnVizMinimize`, `btnVizGallery`) | Which visualization is shown |
| `sliderSearch` / `sliderSearchClear` / `sliderFilterAll` / `sliderFilterEssentials` / `sliderFilterChanged` / `sliderFilterLocked` | Which slider rows are shown (search/filter, not values) |
| `uiScaleDn` / `uiScaleUp` / `uiScaleSave` | UI scale |
| `statsToggle` | Stats strip visibility |
| `heroSceneSelect` | Landing hero studio scene preset (visual) |
| `vip-startup-close` | Closes the startup overlay |


## Scope notes and intentionally excluded surfaces

- Hidden aliases (wired, never shown, forward to a canonical control): `exportBtn` → `saveProcBtn` click; `playOrig`/`playProc` → set A/B mode then play; `abToggle` → `tpAB` click. They exist for external/legacy callers and are kept `hidden` + `aria-hidden` + `tabindex="-1"`.

- USM (open-domain source) manual controls (`btnUsmSeparate`, `btnUsmQuery`, `btnUsmApplyMix`, `usmNumSources`, `usmQueryInput`) are deliberately hidden by `analysis-workspace.js` ("USM is backend-only"): sources are discovered automatically after Analyze and auditioned through layers, not through a separate process button. The UI copy in the USM section says so.

- Not inventoried here (separate surfaces, not Engineer processing controls): the debug menu (`debug-menu.js`), research mode (`research-mode.js`: `vipResearchEnable`, `vipResearchDeterministic`, `vipResearchExport`, `vipSchemaExport`), batch orchestration internals, and paywall/RevenueCat modals (commercial decisions, VIP-026/027).

- Landing page (`public/index.html`) is a separate surface from the Engineer UI. Its processing controls are: `modelSelect` (outcome: Clean Speech / Maximum Isolation / Preserve Ambience / Enhance Speech → `landing.js` outcome chain with `guardEnhanceOutcome` and backend gating), the hero upload/process calls-to-action (same picker and `runPipeline` entry points as the Engineer page), and the quick-clean status/preflight readouts. Landing behavior is covered by the landing and quick-clean browser smokes.

# Engineer Mode Control & Action Inventory (`VIP-021`)

This document inventories every user-facing control in Engineer Mode (`public/app/index.html`, `public/app/premium-workspace.js`, `public/app/lib/signal-canvas-integration.js`, `public/app/lib/analysis-workspace.js`, `src/ui/components/RegionActionPalette/RegionActionPalette.js`, and `public/app/app.js`) and maps each to its concrete runtime handler, parameter contract, boundary validation, and cancellation behavior.

---

## 1. Signal Canvas & Region Action Controls

| Control / Selector | Handler / Module | Runtime Target & Scope | Boundary / Invalid-Input Validation |
|---|---|---|---|
| `#engineerWaveCanvas` (drag) | `premium-workspace.js` (`wireSelection`) | Updates `state.selection` (mapped through `state.zoom`), syncs `audioSessionStore.selectRegion`, opens `#regionActionPalette`. | Clamped to `[0, 1]` via `viewFracToNorm`; selections `< 0.5%` clear selection. |
| `#engineerSpecCanvas` (rect drag) | `premium-workspace.js` (`wireSelection`, `drawSpectrogram`) | Renders deterministic 256-pt Hann STFT magnitude grid (`computeSpectrogramGrid`) over `state.zoom`; rectangle drag updates `state.selection`. | Clamped to `[0, 1]` via `viewFracToNorm`; empty buffer renders crisp placeholder. |
| `[data-action="isolate"]` | `signal-canvas-integration.js` (`__vipEngineerProcessSelection`) | Stores `_protectRegions = [{ start, end, confidence: 0.9 }]` and triggers `app.runPipeline()` (or notifies if ML stems are already active). | `validateSelectionBounds(startSec, endSec, durationSec)` rejects zero-duration, `NaN`, or `< 10 ms` selections. |
| `[data-action="enhance"]` (`enhance_voice`) | `EngineerActionContract.js` -> `__vipEngineerProcessSelection` | Sets `whisperLift = 6`, `voiceTunnel = 60` via `_setSliderUi` (respecting user locks) + `_syncBridgeParams`. | Schema-clamped via `ParameterSchema.clampParam`; locked sliders preserved and reported in toast. |
| `[data-action="reduce-noise"]` (`reduce_noise`) | `EngineerActionContract.js` -> `__vipEngineerProcessSelection` | Sets `bgSuppress = 60` (immediate Live-Mix stem attenuation) and `nrAmount = 70` (process-time spectral NR). | Schema-clamped; locked sliders preserved and reported; toast distinguishes Live-Mix vs Reprocess scope. |
| `[data-action="boost-whisper"]` (`boost_whisper`) | `EngineerActionContract.js` -> `__vipEngineerProcessSelection` | Sets `whisperLift = 12`, `voiceTunnel = 60` via `_setSliderUi` (respecting user locks). | Schema-clamped; locked sliders preserved and reported. |
| `[data-action="preview"]` & `#btnSelectedPlayback` | `signal-canvas-integration.js` (`__vipPlaySelection`) | Decodes if deferred, seeks transport to `bounds.startNorm`, plays bounded region, and auto-pauses/reseeks at `bounds.endSec`. | Validated via `validateSelectionBounds`; timer cleared on `pause()`, `stop()`, `cancelActiveJobs()`, or `#btnClearSelection`. |
| `#btnZoomToSelection` | `premium-workspace.js` (`wireInspectorActions`) | Zooms Signal Canvas (`state.zoom`) to `state.selection`; toggles `Reset zoom` (`aria-pressed="true"`) when zoomed. | Requires valid selection (`>= 0.5%`); notifies user if no selection exists. |
| `#btnClearSelection` / `Escape` | `premium-workspace.js` (`wireInspectorActions`) | Clears `state.selection`, stops active selection preview timer, and resets `state.zoom = { start: 0, end: 1 }`. | Always safe even with no audio loaded. |
| `RegionActionPalette` `export_selection` | `RegionActionPalette.js` | Explicitly disabled (`disabled`, `aria-disabled="true"`) unless `options.allowExportSelection === true`. | Explains via `title` to set Transport Crop In/Out and use Save Processed. |

---

## 2. Profiles, Comparison, Transport & Pipeline Execution

| Control / Selector | Handler / Module | Runtime Target & Scope | Cancellation / State Sync |
|---|---|---|---|
| `[data-profile="quick\|meeting\|studio\|forensic"]` | `premium-workspace.js` -> `__vipApplyProfile` | Maps to calibrated `PRESETS` (`Voice Clarity`, `Room Echo Reduction`, `Podcast Clean`, `Forensic Extract`), respecting locked sliders, and logs operation in provenance. | Synchronous preset update + Live-Mix sync. |
| `[data-hero-tier="creator\|studio\|forensic"]` | `app.js` / `engineer-shell.js` | Switches workspace tier (`document.body.dataset.psMode`), progressive disclosure, and Forensic deterministic export policy (`VIP-040`). | Updates `aria-pressed` across tier pills. |
| `[data-compare="raw\|processed\|removed"]` | `premium-workspace.js` -> `__vipSetComparisonMode` | Routes directly through `EngineerModeBridge.setComparisonMode('original' \| 'processed' \| 'removed')` on the shared `PlaybackMixer` timeline. | If `removed` is requested before Process creates a residual stem, notifies user without corrupting clean-stem state. |
| `#processBtn`, `#reprocessBtn`, `#heroCtaProcess`, `#mobileProcessBtn`, `#mobileReprocessBtn` | `app.js` (`runPipeline`) | Executes ML isolation (`BSRNN` -> `DFN3` -> `VAD`) + 32-stage DSP / Live-Mix stem installation; records `EngineerProvenanceCoordinator` snapshot & operation. | Guarded by `this.isProcessing`; enables `#procCancelBtn` / `#mobileStopBtn`. |
| `#procCancelBtn`, `#mobileStopBtn`, `Escape` (while processing) | `app.js` (`cancelActiveJobs`) | Sets `abortFlag = true`, aborts decode `AbortController`, cancels `JobController`, cancels `MLWorker` stem separation, clears selection preview timer, and records `status: 'cancelled'` in provenance. | Restores buttons and removes `vip-processing-lock`. |
| `#tpPlay`, `#tpPause`, `#tpStop`, `#tpRew`, `#tpFwd`, `#tpSeek`, `#tpSpeed*`, `#tpLoop`, `#tpCropIn`, `#tpCropOut`, `#tpCropClear`, `#tpAB` | `app.js` (`togglePlayback`, `pause`, `stop`, `seekTo`, `seekDelta`, `toggleAB`) | Drives `EngineerModeBridge` / `PlaybackMixer` (or fallback Web Audio chain) with crop-region bounds and playback rate clamping. | `pause()` and `stop()` clear any active selection preview timer. |

---

## 3. Analysis, Separation, Save & Forensic Provenance Controls

| Control / Selector | Handler / Module | Runtime Target & Scope |
|---|---|---|
| `#btnAnalyzeFull`, `#btnCancelAnalysis` | `analysis-workspace.js` (`runFullAnalysis`) | Runs canonical `AnalysisCoordinator` + `AutoAnalysis` with `AbortController` support (`#btnCancelAnalysis` aborts cleanly). |
| `#btnApplyRecommendations`, `#btnAnalyzeProcessAuto`, `#btnAnalyzeWhisperCollab` | `analysis-workspace.js` | Applies calibrated slider recommendations (respecting slider locks) and optionally triggers `app.runPipeline()`. |
| `#audModeOriginal`, `#audModeLayer`, `#audModeProcessed`, `#audPlay`, `#audStop`, `#audResetMix` | `analysis-workspace.js` | Auditions isolated analysis layers or full mix via `LayerAuditionEngine`. |
| `#saveOrigBtn`, `#saveProcBtn`, `#btnExportAnalysisWav`, `#saveDriveBtn` | `app.js` / `analysis-workspace.js` | Exports lossless WAV / MP4 (with deterministic Forensic `ditherSeed` when `psMode === 'forensic'`), then generates & registers `.viprovenance.json` in `EngineerProvenanceCoordinator`. |
| `#saveProvenanceBtn`, `#auditLogBtn`, `#forensicToggle`, `#forensicInspectorMount` | `app.js` / `ForensicInspectorUI.js` | Opens `#section-forensic`, displays live source/output SHA-256 + model chain + effective `ParameterSchema` snapshot + operation history, downloads `.viprovenance.json`, and verifies external sidecars (`verified`, `mismatch`, `malformed_metadata`, `missing_sidecar`, `unsupported_schema`) with explicit non-certification disclaimer. |

---

## 4. 67-Control DSP & Live-Mix Parameter Contract

All 67 controls in `src/core/ParameterSchema.js` (`PARAMETER_SCHEMA`) and `public/app/slider-map.js` (`SLIDER_REGISTRY`) are enforced by `tests/sliders.test.js` and `app.getEffectiveParameterReport()`:

- **Live-Mix Real-Time Controls (`LIVE_MIX_PARAM_IDS`, 20 controls):** `outGain`, `bgSuppress`, `voiceGain`, `eqSub`, `eqLow`, `eqLowMid`, `eqMid`, `eqHighMid`, `eqPresence`, `eqBrilliance`, `eqAir`, `compThresh`, `compRatio`, `compAttack`, `compRelease`, `compKnee`, `compMakeup`, `limCeil`, `limRelease`, `outWidth` — update `PlaybackMixer` Web Audio nodes during playback with zero worker round-trip, and render identically in `PlaybackMixer.renderOffline()` during export.
- **ML Worker & Deca-Pass Offline Controls (46 controls):** Routed via `buildMlProcessingConfig` (to `MLWorker`) and `getEffectiveDspParams` (to `dsp-worker.js` / 32-stage Deca-Pass chain) on `Process` / `Reprocess`.
- **Export-Boundary Control (1 control):** `ditherAmt` (`0` = Off, `1` = TPDF, `2` = Shaped, `3` = Pow-R) — applied strictly at PCM quantization boundary (`encodeWavBuffer` / `ExportManager.encodeWav`), never in preview Float32 buffers, and seeded deterministically from source SHA-256 in Forensic mode (`VIP-040`).

# Engineer Mode DSP sliders

Canonical guide for the **Engineer Console** control rack on Web, Desktop (Electron), and Android (same `public/app` shell).

## Architecture

| Piece | Role |
|-------|------|
| `public/app/slider-map.js` | Pure **parameter registry** (`SLIDER_REGISTRY` SSOT): id, label, min/max/step/default, unit, group, target, hints, **aliases** |
| `src/core/ParameterSchema.js` | Canonical bounds, defaults, execution path, and `buildMlProcessingConfig()` snapshot |
| `src/core/PresetCalibration.js` | Canonical Engineer presets (SSOT); `app.js` loads via `getCalibratedPresets()` |
| `src/presentation/DspSlider.js` | Reusable **accessible row factory** (`createDspSliderRow`) — range + number + reset + lock |
| `public/app/app.js` | Mounts rows into panel groups; snapshots Process-time config; applies stereo post-stem controls and export-boundary dither |
| `src/pipeline/EngineerModeBridge.js` / `PlaybackMixer.js` | Validated Live-Mix routing into AudioParams and active playback worklets |
| `src/pipeline/StemSeparation.js` / `src/workers/MLWorker.js` / `src/workers/EngineerSpectralControls.js` | Revision-keyed Process-time configuration carried into the existing one-STFT / one-iSTFT spectral frame loop |
| `public/app/workflow-tier.js` | Creator/Studio/Forensic — **full ~67-slider rack** on all tiers; Essentials chip focuses gate/nr/out |
| `public/app/slider-theme.css` | Dark studio styling, 40×40 hit targets, drag isolation |
| `public/app/engineer-console.css` | Desktop rack scroll, **single-column** panels, bottom padding |

No cloud, no remote analytics. Slider events update local `VIP_PARAMS` / PlaybackMixer / workers only. **No re-run of ML on drag.**

## Execution contract

The registry contains 67 Engineer controls: **66 native range sliders** and the
Whisper mode choice. Each range row shows its label, live value, unit, native
range/step, reset action, lock action, and accessible keyboard target.

| Class | Config keys | Consumer | When it takes effect | Platforms |
|---|---|---|---|---|
| Live-Mix | 37 controls: gate, EQ, dynamics, output, `voiceIso`, `bgSuppress`, and related controls | `EngineerModeBridge` → `PlaybackMixer` → AudioParam / `vip-gate` / `vip-deesser` | Immediately; smoothed or AudioParam-ramped as required | Web, Android, Desktop |
| Process-time spectral | 27 controls: detailed NR, formant, dereverb, harmonics, focus, and Whisper Hunter shaping | `buildMlProcessingConfig()` → `MLWorker` → `EngineerSpectralControls` | Next **Process**; config revision participates in the stem cache key | Web, Android, Desktop |
| Stereo post-stem | `phaseCorr` (Mono Correlation), `crosstalkCancel` | `app.js` clean-stem post stage | Next **Process** on stereo source; shown unavailable for mono | Web, Android, Desktop |
| Export-only | `ditherAmt` | 16-bit WAV encoder in Save Processed, Save to Drive, and Analysis Workspace export | Export only; does not modify preview PCM | Web, Android, Desktop |

The Process-time helper operates inside the same frame loop as the ML spectral
mask. It must not create a second STFT, iSTFT, worklet, or native bridge path.

### Platform and safety behavior

- The exact same `public/app/` control rack ships in Web, Capacitor Android, and
  Electron. Platform packaging must never fork a visual-only Engineer UI.
- Full Rack is the default on every platform. Simple View is a persisted user
  preference, not an automatic capability guard.
- Android may use a lower-memory runtime backend; it does not silently hide
  controls. The UI continues to show the timing class and any model fallback.
- Gate lookahead ranges from 0–20 ms and intentionally adds the equivalent
  Live-Mix playback delay. It is not an offline-only parameter.
- `phaseCorr` (shown as **Mono Correlation**) and `crosstalkCancel` require
  distinct stereo channels. Mono input reports an unavailable runtime state
  instead of a fake effect. Mono Correlation is a midpoint blend, not a
  time-offset estimator or alignment tool.
- Whisper Lift's 0–40 dB display maps continuously to a bounded 0–12 dB
  internal post-mask gain. It is Process-time only and should be raised
  cautiously to avoid artifact amplification.

### Workflow tiers

All three tiers mount the complete rack. Creator defaults the filter chip to **Essentials** (gate / NR / output) so the first path stays simple; **All** reveals every control. Studio/Forensic default to **All**.

## Keyboard

| Key | Behavior |
|-----|----------|
| Tab / Shift+Tab | Move between range, number, reset, lock, hint |
| ← → ↑ ↓ | One registry `step` (native range) |
| Page Up / Page Down | ~10% of range (or at least one step) |
| Home / End | Min / max |
| Enter (in number field) | Commit precise value |
| Double-click track | Reset to registry default (unlocked only) |
| Escape | Close open hint / info popover |

## Lock behavior

- Each row has a **Lock / Unlock** `<button>` with labels like “Lock Noise Reduction”.
- Locked controls ignore: drag, keyboard adjust, number entry, preset overwrite, auto-calibrate, **Reset unlocked**, and **Reset group**.
- Lock state persists in `localStorage` key `vip-slider-locks`.
- Visual state: `data-locked="true"`, padlock icon swap, cyan lock accent — not color alone.

## Search and filters

- Search matches **label, id, tip/hint, group, aliases** (e.g. denoise, SNR, de-reverb, voice).
- Chips: **All** · **Essentials** · **Changed** · **Locked**.
- **Clear** empties the query; status line is `aria-live="polite"`.
- Matching groups auto-open; empty groups get `filter-empty` while a filter is active.

## Reset actions

| Control | Behavior |
|---------|----------|
| Per-row **↺** | Default for that param (skipped if locked), including Whisper Mode → Off |
| **Reset group** | Unlocked params in that `<details>` section |
| **Reset Unlocked Only** | All unlocked params |
| **Reset Controls** | Confirm dialog: unlocked-only, or full including locks |

## Layout / accessibility requirements

- Rack column scrolls independently; **≥96px bottom padding** so the last control clears chrome.
- Default **one slider per row** in the rack (~300–360px). Two columns only ≥1800px viewport.
- Practical hit targets: lock/reset **40×40** CSS px; enlarged range thumb/track hit strip.
- No transparent overlays over the rack; canvases stay in the center column.
- Strong `:focus-visible` rings on dark UI; honor `prefers-reduced-motion` and `forced-colors` where practical.

## Tests

```bash
pnpm test -- tests/dsp-slider.test.js tests/desktop-dsp-slider-a11y.test.js
pnpm test -- tests/engineer-lock-ui.test.js tests/slider-map.test.js
pnpm test -- tests/slider-schema-parity.test.js tests/slider-math-contracts.test.js
pnpm test -- tests/engineer-processing-config.test.js tests/gate-lookahead.test.js tests/slider-ticks-wiring.test.js
pnpm test -- tests/preset-validation.test.js tests/presets.test.js
```

## Manual QA checklist

- [ ] Windows / macOS / Linux: Engineer Mode open at 1366×768 and 1920×1080
- [ ] Browser zoom 80%, 100%, 125%, 150%, 200% — labels/values not force-horizontal-scrolled
- [ ] Tab through every control in one group; adjust with arrows and Page keys
- [ ] Lock a param, apply a preset — locked value stays
- [ ] Search “denoise” and “de-reverb”; Clear restores All
- [ ] Scroll to last control in Extreme group — thumb fully grabbable
- [ ] Electron desktop shell: same as Chromium web Engineer
- [ ] Android WebView: all 66 range inputs render, drag/tap/keyboard paths update the same canonical value
- [ ] Web / Electron / Android: switch to Simple View and reload; only the explicit persisted setting may filter the rack
- [ ] Process a stereo source after changing a Process-time control; verify the config revision is acknowledged by `MLWorker` and the result changes after the next Process
- [ ] Change gate lookahead during Live-Mix; verify audible output is delayed by the selected 0–20 ms without a click
- [ ] Export 16-bit WAV with each dither mode; verify preview PCM did not change before export
- [ ] Touch laptop: drag thumb without selecting page text
- [ ] Screen reader: announces label + value text (e.g. “NR Amount, 50 percent”)

## Related

- [DOWNLOADS.md](../DOWNLOADS.md) — installers ship the same shell
- [electron-desktop.md](electron-desktop.md)
- CLAUDE.md — single-pass STFT, no ML on Live-Mix sliders

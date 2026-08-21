# Engineer Mode DSP sliders (desktop-first)

Canonical guide for the **Engineer Console** control rack on Web, Desktop (Electron), and Android (same `public/app` shell).

## Architecture

| Piece | Role |
|-------|------|
| `public/app/slider-map.js` | Pure **parameter registry** (`SLIDER_REGISTRY` SSOT): id, label, min/max/step/default, unit, group, target, hints, **aliases** |
| `src/core/ParameterSchema.js` | Research/tooltip schema — bounds kept in parity with the registry (CI) |
| `src/core/PresetCalibration.js` | Canonical Engineer presets (SSOT); `app.js` loads via `getCalibratedPresets()` |
| `src/presentation/DspSlider.js` | Reusable **accessible row factory** (`createDspSliderRow`) — range + number + reset + lock |
| `public/app/app.js` | Mounts rows into panel groups, Live-Mix/worklet wiring, locks, presets, search/filter |
| `public/app/workflow-tier.js` | Creator/Studio/Forensic — **full ~67-slider rack** on all tiers; Essentials chip focuses gate/nr/out |
| `public/app/slider-theme.css` | Dark studio styling, 40×40 hit targets, drag isolation |
| `public/app/engineer-console.css` | Desktop rack scroll, **single-column** panels, bottom padding |

No cloud, no remote analytics. Slider events update local `VIP_PARAMS` / PlaybackMixer / workers only. **No re-run of ML on drag.**

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
| Per-row **↺** | Default for that param (skipped if locked) |
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
- [ ] Touch laptop: drag thumb without selecting page text
- [ ] Screen reader: announces label + value text (e.g. “NR Amount, 50 percent”)

## Related

- [DOWNLOADS.md](../DOWNLOADS.md) — installers ship the same shell
- [electron-desktop.md](electron-desktop.md)
- CLAUDE.md — single-pass STFT, no ML on Live-Mix sliders

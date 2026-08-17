# Desktop Engineer Mode slider UX audit — 2026-08-17

## Scope

Desktop (Electron) + shared Engineer shell (`public/app`). UI / interaction / a11y only. DSP math and ONNX inference untouched.

## Root causes found

| # | Root cause | Impact | Fix |
|---|------------|--------|-----|
| 1 | **Two-column slider grid** in a ~300–360px rack (`engineer-console.css`) | Labels truncated, thumbs unusable, horizontal cramp | Default **single-column** flex stack; 2-col only ≥1800px |
| 2 | **Tiny hit targets** (lock ~22–24px, thumb ~14px) | Hard to grab/click on mouse and touch laptops | **40×40** lock/reset; thumb 20–24px; tall track hit strip |
| 3 | **Readout-only value** (`span.sr-val`) | No precise professional entry | Editable `input type="number"` synced with range |
| 4 | **Weak search** (label substring only) | Could not find denoise/SNR/de-reverb by alias | Alias map + `data-searchText` + filter chips |
| 5 | **Missing filter modes** | Hard to audit locked/changed set | All / Changed / Locked + Clear + live status |
| 6 | **Insufficient rack bottom padding** | Last controls under chrome / hard to drag | `padding-bottom` + `scroll-padding-bottom` ≥96px |
| 7 | **Lock aria-label used raw id** | Poor screen-reader wording | “Lock/Unlock {Label}” |
| 8 | **No per-row reset / group reset UX** | Slow DAW-style workflow | Reset button, dbl-click default, Reset group toolbars |
| 9 | **Incomplete aria-valuetext** | SR only heard bare numbers | “{Label}, {value} {spoken unit}” |
| 10 | **Drag text-selection / event bleed risk** | Unstable drag feel | `user-select: none`, `touch-action: none`, `body.is-slider-dragging` |

## Non-issues confirmed

- Registry already centralizes min/max/step/default (`SLIDER_REGISTRY`, 67 params).
- Locks already blocked presets and `_setSliderUi` when not forced.
- Live-Mix updates already rAF-coalesced (no worklet flood on drag).
- Waveform/spectrogram live in center column, not over rack — after isolation, rack `z-index`/`pointer-events` hardened for controls.

## Changes delivered

- `src/presentation/DspSlider.js` — shared accessible row component (vanilla; no React in this repo)
- `public/app/app.js` — mount via factory; filter; group reset; lock/value sync
- `public/app/slider-map.js` — `SLIDER_ALIASES` attached to registry
- `public/app/index.html` — search/filter chrome + group reset buttons
- `public/app/slider-theme.css` / `engineer-console.css` — layout + a11y styling
- Tests: `tests/dsp-slider.test.js`, `tests/desktop-dsp-slider-a11y.test.js`
- Guide: `docs/guides/DSP_SLIDERS.md`

## Residual risk / follow-ups

- Full Playwright sweep of all 67 rows in Electron still manual (checklist in DSP_SLIDERS.md).
- Workflow tier “simple” still defers closed accordion mounts (by design for mobile boot); desktop should keep primary groups open.
- Optional later: true TypeScript React `DspSlider.tsx` only if the shell migrates off vanilla DOM.

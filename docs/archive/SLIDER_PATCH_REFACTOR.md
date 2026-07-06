# vip-slider-patch.js Refactor Plan

## Current State

`public/app/vip-slider-patch.js` is 37KB and is loaded **after** `app.js` in
`index.html`. Despite its name, it is not a simple patch — it contains:

| Responsibility | Target file after refactor |
|---|---|
| 52 slider definitions (SLIDERS object) | `public/app/slider-map.js` |
| `buildRow()` / `buildPanels()` DOM construction | `public/app/slider-map.js` |
| `dispatchParam()` → worklet/worker routing | `public/app/slider-map.js` |
| Tab switching + keyboard nav | `public/app/app.js` init section |
| Preset wiring + `syncSlidersFromVipParams()` | `public/app/app.js` |
| Canvas ResizeObserver | `public/app/visuals.js` |
| Toast helper (`window.VIP_toast`) | `public/app/app.js` or `utils.js` |
| UI scale controls | `public/app/app.js` |
| A/B toggle, overlay toggles, batch drop | `public/app/app.js` |
| Startup error banner check | `public/app/vip-boot.js` |
| 20-point debug audit (`VIP_runAudit`) | `public/app/debug-audit.js` |

## Why This Matters

- A 37KB "patch" file at the same size as primary modules signals architectural
  debt — each multi-AI session appended new logic rather than editing canonical files.
- `vip-slider-patch.js` currently rebuilds the entire slider UI on DOMContentLoaded,
  which means two competing initializations exist (the one in `app.js` and this one).
- This creates a race condition: `app.js` DOMContentLoaded vs `vip-slider-patch.js`
  `setTimeout(init, 120)` — the 120ms delay is a code smell.

## Migration Steps

1. **Move SLIDERS + buildPanels + dispatchParam** into `slider-map.js` as named exports.
2. **Remove duplicate slider init from `app.js`** — let `slider-map.js` be the single
   source of truth for slider construction.
3. **Move tab/preset/canvas init** into `app.js` `init()` function, called synchronously
   after DOM ready (no setTimeout hack needed).
4. **Move `VIP_runAudit`** into `debug-audit.js` (it already exists there — deduplicate).
5. **Delete `vip-slider-patch.js`** after all logic is migrated and tested.

## Acceptance Criteria

- [ ] All 52 sliders render correctly without `vip-slider-patch.js` loaded
- [ ] `VIP_runAudit()` reports ≥18/20 pass
- [ ] No 120ms setTimeout initialization delay
- [ ] `app.js` drops below 60KB
- [ ] `vip-slider-patch.js` is removed from `index.html` and deleted

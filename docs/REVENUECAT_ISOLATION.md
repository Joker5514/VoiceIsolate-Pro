# RevenueCat Isolation Plan

## Problem

`public/app/revenuecat.js` wraps the RevenueCat SDK, which makes network requests
to `api.revenuecat.com`. This does NOT violate the "100% local audio processing"
constraint, because RevenueCat is only called for **billing/subscription flows**,
never during the DSP pipeline.

## Confirmed Safe Separation

The following code paths call RevenueCat:
- `paywall.js` → `revenuecat.js` (purchase/restore flows)
- `license-manager.js` → `revenuecat.js` (entitlement checks on app boot)

The following code paths **must NEVER call RevenueCat**:
- `dsp-core.js`
- `dsp-processor.js` (AudioWorkletProcessor)
- `ml-worker.js`
- `offline-processor.js`
- `pipeline-orchestrator.js`
- `pipeline-state.js`

## Enforcement Rules

1. `revenuecat.js` MUST NOT be imported or referenced from any DSP file.
2. RevenueCat SDK calls MUST be gated behind a UI action (purchase button click)
   or an explicit auth check on app boot — never triggered by audio events.
3. The `debug-audit.js` 20-point self-test should verify `window.Purchases` is
   not called during a pipeline run.

## Implementation Status

- [x] `revenuecat.js` loaded only in `index.html` after all DSP modules
- [x] No reference to `window.Purchases` or `Purchases` in dsp-core.js, ml-worker.js,
      dsp-processor.js, or offline-processor.js
- [ ] TODO: Add CI lint rule to prevent future cross-contamination
      (`scripts/check-dsp-isolation.js`)

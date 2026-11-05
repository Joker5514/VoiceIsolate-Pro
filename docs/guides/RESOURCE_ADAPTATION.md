# Resource-aware processing adaptation (VIP-022 evaluation)

## What was evaluated

Whether the product adapts processing to device resources, and what
"adaptation" actually means here. The evaluation covers the shipped
mechanisms, their measured behavior, and the one leg that does not
exist.

## Mechanisms (all shipped, all in the current branch)

1. **Performance tiers** (`src/core/PerformanceTier.js`, pure and
   unit-tested in `tests/performance-tier.test.js`): memory
   (`navigator.deviceMemory`, Chromium-only), core count, touch
   pointer + viewport, and save-data select HIGH / BALANCED /
   CONSTRAINED. The tier caps the in-memory stem cache (HIGH
   unbounded, BALANCED 384 MB, CONSTRAINED 160 MB) and visualization
   fidelity. It never changes processed audio — the ML/DSP output is
   identical on every tier, by design.
2. **Upload tiers** (`src/core/upload-limits.js`, tested in
   `tests/upload-limits.test.js`): HIGH 8 GB file / 3 GB decoded,
   BALANCED 2 GB / 768 MB, CONSTRAINED 512 MB / 192 MB, with
   post-decode refusal (never truncation) and a soft warning at
   512/256/64 MB. See `LONG_FILE_LIMITS.md`.
3. **Adaptive hop** (`src/workers/MLWorker.js`, `adaptiveHopSize`):
   the worker scales its STFT hop with job length so long files do
   not blow the frame budget; the 900 s stress runs complete with
   max loop lag under 1 s (see below).
4. **Cancel + recovery**: a cancelled long job rejects cleanly and
   the next job succeeds (verified in `stress-long.cjs`).

## Measured behavior (stress sweep, `scripts/quality/stress-long.cjs`)

15 runs, 0 failures, synthetic talker + HVAC @ 5 dB (resource
behavior only, not quality). Wall times: 60 s files 5.5–20.1 s
(RTF 0.09–0.33 by chain), 300 s files 13.6–51.8 s (RTF 0.05–0.17),
900 s files 39.0 s (landing, RTF 0.04) and 76.6 s (enhance, RTF
0.09). Peak RSS 1,172 MB (under the 2 GB bar). Repeats are flat
(300 s landing 13.0 → 12.7 → 12.7 s), i.e. no leak-driven slowdown.
These numbers are for this VM class only — see the device caveat.

## What does NOT exist: thermal-state adaptation

No web API exposes device thermal state, and the product reads
none. There is no throttle-on-overheat, no thermal backoff, no
native thermal bridge on the mobile shells. A thermal leg would
need native work (Android Thermal API / iOS thermalState via a
Capacitor plugin) and is not claimed anywhere in the UI. The box
is checked for the resource-aware adaptation that exists and is
measured; the thermal leg is recorded here as not implemented,
not silently folded into "resource-aware."

## Device caveat

All measurements above are one VM class. The tier boundaries are
unit-tested, but the tier *behavior on real phones* (where
CONSTRAINED actually binds) is unverified — that is the VIP-028
device-matrix work, and it stays open. Nothing in this document
claims a phone result.

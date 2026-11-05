# Supported-device test matrix (VIP-028 box 1 — defined, not tested)

This document DEFINES the matrix. It does not claim any device below has
been tested: every row is status "defined" until a run recorded in the
format at the bottom exists. Testing the rows is VIP-028 boxes 2–4,
which need physical devices and are still open.

## How tiers are assigned (never assumed from a model name)

The runtime tier comes from `selectPerformanceTier`
(`src/core/PerformanceTier.js`): device memory, CPU cores, save-data
mode, and viewport/touch shape — measured on the device, not looked
up from a model table. The models below are REPRESENTATIVE examples
of devices that typically land in each tier; a row's tier is confirmed
only by running the app on that device and reading the tier it
selects. A model that lands in a different tier than listed is a
matrix correction, not a failure.

| Tier | Profile (measured) | Representative devices (examples, not tested) |
|---|---|---|
| CONSTRAINED | ≤ 2 GB RAM, or ≤ 2 cores, or save-data on | Galaxy A03s-class (3 GB), Moto G Play-class — low-RAM Android |
| BALANCED | ≤ 4 GB RAM, or ≤ 4 cores, or touch-first small viewport | Galaxy A14/A34-class, Pixel 7a-class — mid Android |
| HIGH | everything above | Galaxy S24 Ultra-class, flagship Android, any modern desktop |

Upload/file caps ride the same tiers (`src/core/upload-limits.js`):
CONSTRAINED 512 MB file / 192 MB decoded / 64 MB warn, BALANCED
2 GB / 768 MB / 256 MB, HIGH 8 GB / 3 GB / 512 MB.

## Environments in the matrix

| Environment | Tier | Status |
|---|---|---|
| Chromium on this VM (Linux, x64) | HIGH (measured class) | TESTED — browser tier 11/11, stress sweep, corpus eval |
| Electron dev shell (xvfb, unpackaged, build/ static root) | HIGH | TESTED — security + CSP runtime smokes |
| Electron packaged Windows NSIS (the release desktop artifact) | HIGH | DEFINED — needs a Windows build; not producible here |
| Android low-tier device (CONSTRAINED profile) | CONSTRAINED | DEFINED — no device available here |
| Android mid-tier device (BALANCED profile) | BALANCED | DEFINED — no device available here |
| Android high-tier device (HIGH profile; S24 Ultra is the obvious candidate) | HIGH | DEFINED — needs the owner's device; not tested |
| Firefox / Safari (desktop + mobile web) | varies | DEFINED — never verified; unsupported until a run exists |
| Android WebView / Capacitor shell on each Android tier above | tier's own | DEFINED — the shipped Android path; needs devices |

## What a device run must cover (VIP-028 box 2)

Upload, analysis, Stem-Split, Live-Mix, Engineer controls,
cancellation, export, background/foreground transitions, and memory
pressure — on the device, with the device's own tier active. A run
that only loads the landing page is not a matrix run.

## Record format (VIP-028 box 3 — required for every run)

Device model, OS/browser version, app build, commit SHA, test files,
observed behavior, and defects. One record per (device × build).
Records live with the run's evidence (report file or issue comment
linking the commit); a verbal "it worked" is not a record.

## Known constraints (VIP-028 box 4 — starter list, grows with runs)

- No device below the CONSTRAINED profile has ever been exercised;
  behavior under 2 GB RAM / 2 cores is untested, not "supported".
- Firefox/Safari are untested: any capability claim about them is
  unverified until a matrix run exists.
- Thermal-state adaptation does not exist (no web API exposes it —
  see RESOURCE_ADAPTATION.md); sustained-load behavior on phones is
  therefore an open test area, not a handled case.
- The Electron packaged build is unverified (see above); desktop
  claims rest on the dev shell + Chromium, not the release artifact.

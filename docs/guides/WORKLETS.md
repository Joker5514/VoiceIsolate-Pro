# AudioWorklet Packaging

VoiceIsolate Pro ships **three** AudioWorklet processor files on every platform (web, Android, desktop). Two are **active** at runtime; one is **legacy-shipped** for compatibility.

## Registry

Canonical list: [`scripts/worklet-manifest.json`](../../scripts/worklet-manifest.json)

| ID | File | Processor | Role | Loaded at runtime |
|----|------|-----------|------|-----------------|
| `vip-gate` | `src/workers/GateProcessor.js` | `vip-gate` | **Active, 0–20 ms lookahead** | `PlaybackMixer._loadGate()` |
| `vip-deesser` | `src/workers/DeEsserProcessor.js` | `vip-deesser` | **Active** | `PlaybackMixer._loadDeEsser()` |
| `dsp-processor` | `public/app/dsp-processor.js` | `dsp-processor` | **Legacy-shipped** | Not `addModule`-loaded (live SAB pipeline removed; see CLAUDE.md §1.1) |

Active worklets run on **playback stems only** — never on a live microphone and never re-running ML.

`src/workers/EngineerSpectralControls.js` is deliberately **not** an
AudioWorklet. `MLWorker` imports it during offline Process work, where it applies
the Engineer spectral configuration inside the already-existing STFT frame loop.
It is copied and precached with the worker assets on Web, Android, and Desktop.
`src/workers/MainsHumFilter.js` follows the same rule: MLWorker imports it to
notch stationary 50/60 Hz hum out of each input channel once per Process,
before the model chain. It has no control and is not an AudioWorklet.
`src/workers/DeepFilterNet.js` is the same kind of helper: MLWorker imports it
to run the DeepFilterNet3 composite model (feature extraction, deep filter and
its own 960-point STFT/iSTFT) once per Process when that model is selected.
`src/workers/SpeakerEmbeddingWorker.js` (with its helper `SpeakerFeatures.js`)
is a plain classic Web Worker for the optional ECAPA target-speaker embedding.
It runs only on an explicit Enroll / Isolate click, never from a slider.

## Delivery path

```
src/workers/GateProcessor.js
src/workers/DeEsserProcessor.js          ──► pnpm build ──► build/src/workers/*.js
src/workers/EngineerSpectralControls.js  ──►              ──► build/src/workers/*.js
src/workers/MainsHumFilter.js            ──►              ──► build/src/workers/*.js
src/workers/DeepFilterNet.js             ──►              ──► build/src/workers/*.js
src/workers/SpeakerEmbeddingWorker.js    ──►              ──► build/src/workers/*.js
public/app/dsp-processor.js              ──►              ──► build/app/dsp-processor.js
                                                    │
                    ┌───────────────────────────────┼───────────────────────────────┐
                    ▼                               ▼                               ▼
              Vercel / dev                   Capacitor (Android)              Electron desktop
         /src/workers/*.js              assets/public/src/workers/         build/** in installer
         /app/dsp-processor.js          assets/public/app/dsp-processor.js
```

- **Web:** Express dev server and Vercel serve `public/` + synced `public/src/`. COOP/COEP headers on `/src/workers/*.js` and `/app/dsp-processor.js` (`vercel.json`).
- **Android:** `capacitor.config.json` sets `webDir: "build"`. Run `pnpm build && npx cap sync android` before APK/AAB builds.
- **Desktop:** `electron-builder.yml` packs `build/**/*`. Run `pnpm build` before `pnpm build:electron:dir`.

## Offline precache

The service-worker precache is generated, not hand-kept: `scripts/sw-precache.cjs`
lists the served code files (landing, `/app`, `/src`, `/lib` JS/CSS/HTML/fonts
and images) of at most 1 MiB each and stamps them with a content-hash
generation into `app/sw.js` during `pnpm build` and the Vercel build. Larger
files (for example `/lib/ort.js`), models and ORT `.wasm` are not precached;
they reach the runtime cache only after a successful online fetch.
`pnpm worklets:verify` checks that the three worklet URLs are in it.
No shipping page registers the worker yet (`registerSW()` has no caller);
`node scripts/sw-offline-check.cjs` drives its offline and upgrade behaviour in
Chromium.

## Integrity

SHA-256 pins live in `public/app/models-manifest.json` under `worklets`. Hashes are
computed on **LF-normalized** file bytes so Windows CRLF working copies match Linux
CI and git blobs. Regenerate after any worklet edit:

```bash
pnpm worklets:hash      # recompute + update models-manifest.json
pnpm worklets:verify    # source + manifest + precache checks
pnpm worklets:verify:build   # also requires build/ copies in sync
```

`pnpm validate` calls `scripts/verify-worklets.js`. `pnpm android:build:win` verifies
Android assets after `cap sync`. For release CI, add to `release-build.yml` after cap sync:

```bash
node scripts/verify-worklets.js --require-build --require-android
```

## Commands

| Command | Purpose |
|---------|---------|
| `pnpm worklets:hash` | Recompute SHA-256 and update `models-manifest.json` |
| `pnpm worklets:verify` | Verify source paths, hashes, SW precache |
| `pnpm worklets:verify:build` | Above + require synced `build/` copies |
| `pnpm test -- tests/worklet-packaging.test.js` | Jest packaging assertions |

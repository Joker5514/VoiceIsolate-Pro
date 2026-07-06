# AudioWorklet Packaging

VoiceIsolate Pro ships **three** AudioWorklet processor files on every platform (web, Android, desktop). Two are **active** at runtime; one is **legacy-shipped** for compatibility.

## Registry

Canonical list: [`scripts/worklet-manifest.json`](../scripts/worklet-manifest.json)

| ID | File | Processor | Role | Loaded at runtime |
|----|------|-----------|------|-----------------|
| `vip-gate` | `src/workers/GateProcessor.js` | `vip-gate` | **Active** | `PlaybackMixer._loadGate()` |
| `vip-deesser` | `src/workers/DeEsserProcessor.js` | `vip-deesser` | **Active** | `PlaybackMixer._loadDeEsser()` |
| `dsp-processor` | `public/app/dsp-processor.js` | `dsp-processor` | **Legacy-shipped** | Not `addModule`-loaded (live SAB pipeline removed; see CLAUDE.md §1.1) |

Active worklets run on **playback stems only** — never on a live microphone and never re-running ML.

## Delivery path

```
src/workers/GateProcessor.js
src/workers/DeEsserProcessor.js          ──► pnpm build ──► build/src/workers/*.js
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

`public/app/sw.js` `APP_SHELL` precaches all three worklet URLs so the service worker can serve them without a network round-trip after install.

## Integrity

SHA-256 pins live in `public/app/models-manifest.json` under `worklets`. Hashes are
computed on **LF-normalized** file bytes so Windows CRLF working copies match Linux
CI and git blobs. Regenerate after any worklet edit:

```bash
pnpm worklets:hash      # recompute + update models-manifest.json
pnpm worklets:verify    # source + manifest + APP_SHELL checks
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
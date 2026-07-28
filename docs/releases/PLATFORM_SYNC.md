# Platform sync status

Tracks when Android (Capacitor) and Desktop (Electron) web shells were rebuilt against `main`.

| Field | Value |
|-------|--------|
| **Git SHA** | `9466892` |
| **Package version** | `25.0.0` / build `250000` |
| **Synced at (UTC)** | 2026-07-28 |
| **Includes** | PR #725 (USM backend, lock accent, process pause, A/B) · PR #726 (collapsible expand, separation→isolation Live-Mix) |

## What was run

1. `node scripts/sync-src.js` — `src/` → `public/src/` (dev imports)
2. `node scripts/build.mjs` — `public/` + `src/` → `build/`
3. `node scripts/prepare-android-complete.mjs` — offline Android package under `build/`
4. `npx cap sync android` — `build/` → `android/app/src/main/assets/public`
5. `pnpm android:build:win` — debug APK → `dist/android/VoiceIsolate-Pro-android-debug.apk` (~96 MB)
6. `pnpm build:electron:dir` — unpacked desktop → `dist/electron/win-unpacked/VoiceIsolate Pro.exe`

## Git policy (do not commit)

| Path | Why ignored |
|------|-------------|
| `build/` | Generated static shell |
| `public/src/` | Mirror of `src/` for static serving |
| `android/app/src/main/assets/public` | Capacitor copy of `build/` |
| `dist/android/*.apk`, `dist/electron/*` | Binaries → GitHub Releases only |

Canonical source remains **`public/app/`** + **`src/`** on `main`. Always rebuild platforms after pulling Engineer Mode changes:

```bash
pnpm android:build:win
pnpm build:electron:dir   # or build:electron for installer
```

## Verify markers after sync

```bash
# Expect hits for loadStemPair / _loadSeparationStemsToBridge
rg -n "loadStemPair|_loadSeparationStemsToBridge" build/app/app.js build/src/pipeline/EngineerModeBridge.js
rg -n "loadStemPair" android/app/src/main/assets/public/src/pipeline/EngineerModeBridge.js
```

Worklets: `pnpm worklets:verify:build` with Android assets present.

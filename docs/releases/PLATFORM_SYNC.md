# Platform sync status

Tracks when Android (Capacitor) and Desktop (Electron) web shells were rebuilt against `main`.

| Field | Value |
|-------|--------|
| **Git SHA (docs pass)** | `06422d4` + audit sync branch |
| **Package version** | `25.0.1` / build `250001` |
| **Synced at (UTC)** | 2026-08-07 |
| **Published GitHub binaries** | **v24.0.0** only (`latest` tag) |
| **Includes on main** | SAM-Audio production path · SAM3 vision scaffold (#742) · audio DSP polish (#740) · perf/persistence stack |

## Version sources of truth

| Surface | Source | Expected |
|---------|--------|----------|
| npm / Electron artifact | `package.json#version` | `25.0.1` |
| Android | `android/app/build.gradle` via `pnpm mobile:sync-version` | `25.0.1` / `250001` |
| iOS | `ios/App/App/Info.plist` via `pnpm mobile:sync-version` | `25.0.1` / `250001` |
| Capacitor UA | `capacitor.config.json` | `VoiceIsolatePro/25.0.1` |
| API health | `api-routes/index.js` | `25.0.1` |
| SAM runtime package | `packages/vip-sam-runtime` | `25.0.1` |
| Download page / docs | `public/download/index.html`, `docs/DOWNLOADS.md` | working URLs only |

## What to run after pulling Engineer Mode changes

```bash
pnpm install
pnpm mobile:sync-version
pnpm build                 # public/ + src/ → build/ (+ SAM markers)
pnpm android:build:win     # optional APK
pnpm build:electron:dir    # optional desktop smoke
pnpm test:ci
pnpm check:cloud-audio
```

## Git policy (do not commit)

| Path | Why ignored |
|------|-------------|
| `build/` | Generated static shell |
| `public/src/` | Mirror of `src/` for static serving |
| `android/app/src/main/assets/public` | Capacitor copy of `build/` |
| `dist/android/*.apk`, `dist/electron/*` | Binaries → GitHub Releases only |

Canonical source remains **`public/app/`** + **`src/`** on `main`.

## Verify download links after docs edits

```bash
# Android (version-stable name) — expect 200
curl -sI "https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk" | head -1

# Windows published asset — expect 200
curl -sI "https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-24.0.0-win-x64.exe" | head -1

# Must stay 404 until v25 release exists
curl -sI "https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.1-win-x64.exe" | head -1
```

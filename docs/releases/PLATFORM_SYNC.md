# Platform sync status

| Field | Value |
|-------|--------|
| **Git SHA (release cut)** | `c5aecfc` (docs follow-up after tag) |
| **Package version** | `25.0.1` / build `250001` |
| **Published GitHub binaries** | **[v25.0.1](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.1)** (Latest) |
| **Synced at (UTC)** | 2026-08-07 |
| **Artifacts** | APK ~250 MB · Windows NSIS ~267 MB |

## Version sources of truth

| Surface | Source | Expected |
|---------|--------|----------|
| npm / Electron artifact | `package.json#version` | `25.0.1` |
| Android | `android/app/build.gradle` | `25.0.1` / `250001` |
| iOS | `ios/App/App/Info.plist` | `25.0.1` / `250001` |
| Capacitor UA | `capacitor.config.json` | `VoiceIsolatePro/25.0.1` |
| API health | `api-routes/index.js` | `25.0.1` |
| Download page | `public/download/index.html` | latest → 25.0.1 assets |

## Rebuild after pulling

```bash
pnpm install
pnpm mobile:sync-version
pnpm build
pnpm android:build:win
pnpm build:electron
pnpm test:ci
pnpm check:cloud-audio
```

## Verify download links

```bash
curl -sI "https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk"
curl -sI "https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.1-win-x64.exe"
```

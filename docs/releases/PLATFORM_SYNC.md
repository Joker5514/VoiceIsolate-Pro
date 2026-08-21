# Platform sync status

| Field | Value |
|-------|--------|
| **Git SHA (native rebuild)** | `main` @ `b6beea1` (#774) |
| **Package version** | `25.0.2` / build `250002` |
| **Published GitHub binaries** | **[v25.0.2](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.2)** (Latest) |
| **Synced at (UTC)** | 2026-08-21T04:16Z |
| **Artifacts** | APK ~96.8 MB (debug offline) · Windows NSIS ~137.9 MB |
| **Notes** | Native @ `b6beea1` (#774). Web also has #776 Google Drive import/export — rebuild natives after #776 merges for full parity. |

## Version sources of truth

| Surface | Source | Expected |
|---------|--------|----------|
| npm / Electron artifact | `package.json#version` | `25.0.2` |
| Android | `android/app/build.gradle` | `25.0.2` / `250002` |
| iOS | `ios/App/App/Info.plist` | `25.0.2` / `250002` |
| Capacitor UA | `capacitor.config.json` | `VoiceIsolatePro/25.0.2` |
| API health | `api-routes/index.js` | `25.0.2` |
| Download page | `public/download/index.html` | latest → 25.0.2 assets |

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
curl -sI "https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.2-win-x64.exe"
```

# Platform sync status

| Field | Value |
|-------|--------|
| **Git SHA (native rebuild)** | `main` @ `17692f9` (#776 + #774) |
| **Package version** | `25.0.2` / build `250002` |
| **Published GitHub binaries** | **[v25.0.2](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.2)** (Latest) |
| **Synced at (UTC)** | 2026-08-21T10:04Z |
| **Artifacts** | APK ~96.9 MB (debug offline) · Windows NSIS ~138 MB |
| **Reviewed main** | `3385ca3df7be5f49d1f2e22d5d45f4e17bd39f7c` |
| **v25.0.2 tag source** | `1cb37fd495cb80eaac369e028ad2c1fcae0a63ea` |
| **Status** | Native artifacts are stale relative to reviewed main; deployed Web source is unknown |
| **Provenance** | [`release-provenance.json`](release-provenance.json) |

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
pnpm version:check
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

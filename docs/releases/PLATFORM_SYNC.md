# Platform sync status

| Field | Value |
|-------|--------|
| **Reviewed `main` SHA** | `3385ca3df7be5f49d1f2e22d5d45f4e17bd39f7c` |
| **Git SHA (last native rebuild)** | `17692f98e1023ea7b18b7bd8a5c374291ccb67f8` (#776 + #774) |
| **Package version** | `25.0.2` / build `250002` |
| **Published GitHub binaries** | **[v25.0.2](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.2)** (Latest) |
| **Native assets updated (UTC)** | 2026-08-21T10:04Z |
| **Artifacts** | APK 101,620,559 bytes · Windows NSIS 144,646,374 bytes |
| **Sync verdict** | **Not synchronized.** Published Android/Windows artifacts are stale vs current `main`. Web production SHA is unknown (not inferred from HEAD). |

Machine-readable record: [release-provenance.json](release-provenance.json).

Do **not** claim that Web, Android, Windows, `main`, and v25.0.2 contain the same build. The tag must not be moved. Rebuild natives from current `main` before any synchronized-release claim.

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

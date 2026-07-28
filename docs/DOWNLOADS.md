# Downloads — VoiceIsolate Pro

**In-repo version:** **25.0.0** (Android `versionName` / Electron artifact / API version)  
**Build number:** **250000** (`versionCode` / iOS `CFBundleVersion`)

Published GitHub Release assets are cut separately. Until a **v25.0.0** release is uploaded, the **latest** tag may still serve prior **v24.0.0** binaries.

## Current code target

| Platform | Artifact name | Notes |
|----------|---------------|--------|
| **Android** | `VoiceIsolate-Pro-android-debug.apk` | `versionName "25.0.0"`, `versionCode 250000` |
| **Windows** | `VoiceIsolate-Pro-25.0.0-win-x64.exe` | electron-builder `${version}` |

### Prior published tag (v24.0.0)

| Platform | URL |
|----------|-----|
| Android | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-android-debug.apk |
| Windows | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe |

## Build & publish (maintainers)

```bash
# Android
pnpm android:build:win   # or pnpm android:build on Unix
# → dist/android/VoiceIsolate-Pro-android-debug.apk

# Desktop
pnpm build:electron
# → dist/electron/VoiceIsolate-Pro-25.0.0-win-x64.exe

# After cutting a GitHub release tag v25.0.0:
gh release upload v25.0.0 dist/android/VoiceIsolate-Pro-android-debug.apk --clobber
gh release upload v25.0.0 dist/electron/VoiceIsolate-Pro-25.0.0-win-x64.exe --clobber
```

Sync versions after editing `package.json#version`:

```bash
pnpm mobile:sync-version
```

## Product snapshot PDF

See [docs/releases/VoiceIsolate_Pro_v25_Current_State.pdf](releases/VoiceIsolate_Pro_v25_Current_State.pdf).

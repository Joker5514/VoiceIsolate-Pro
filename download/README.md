# Android / desktop download artifacts

Large installers are **not committed to git**. End-user binaries are published through [GitHub Releases](https://github.com/Joker5514/VoiceIsolate-Pro/releases), and the web download hub is https://voice-isolate-pro.vercel.app/download/.

**Repository version:** `25.0.2` · native build number `250002`  
**Latest published release:** [`v25.0.3`](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.3)  
**Release published:** `2026-09-09T23:31:43Z`  
**Reviewed source:** `f5b271892de7bb8aca85b351062dd81f9191f756`

Desktop browsers, Android browsers, Capacitor Android, and Electron Windows share one upload-only shell. The published assets below are valid downloads and predate reviewed `main`. See [`docs/releases/release-provenance.json`](../docs/releases/release-provenance.json) before making any cross-platform same-build claim.

## Android APK

| Channel | URL |
|---|---|
| Latest | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk |
| Pinned `v25.0.3` | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.3/VoiceIsolate-Pro-android-debug.apk |
| Historical releases | https://github.com/Joker5514/VoiceIsolate-Pro/releases |

Published asset:

- File: `VoiceIsolate-Pro-android-debug.apk`
- Type: Android sideload/debug APK
- Size: `101650376` bytes
- SHA-256: `70317aaa84c3f2ca286115a878fd79978de80e8df0a2cc9538201bf9bf7dc626`
- GitHub asset updated: `2026-09-09T23:31:41Z`

Build locally:

```bash
pnpm android:build:win     # Windows host → dist/android/VoiceIsolate-Pro-android-debug.apk
pnpm android:build         # Unix host → debug APK under android/app/build/outputs/apk/debug/
pnpm android:bundle        # release AAB under android/app/build/outputs/bundle/release/
```

WebView debugging is controlled by `BuildConfig.DEBUG`; release builds must keep it disabled.

## Windows x64

| Channel | URL |
|---|---|
| Latest | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.2-win-x64.exe |
| Pinned `v25.0.3` | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.3/VoiceIsolate-Pro-25.0.2-win-x64.exe |
| Historical releases | https://github.com/Joker5514/VoiceIsolate-Pro/releases |

Published asset:

- File: `VoiceIsolate-Pro-25.0.2-win-x64.exe`
- Type: Windows x64 NSIS installer
- Size: `144667075` bytes
- SHA-256: `926cab42ff8453f812de52bd66368553f708c2747556ed191dabaca66f2ce4c8`
- GitHub asset updated: `2026-09-09T23:31:43Z`

Build locally:

```bash
pnpm setup:electron
pnpm build:electron        # dist/electron/VoiceIsolate-Pro-25.0.2-win-x64.exe
pnpm build:electron:dir    # dist/electron/win-unpacked/
```

A published Windows binary may be unsigned even though the build system contains signing hooks; verify the signature separately before claiming a signed release.

## Validation

```bash
pnpm downloads:validate
```

This validates the current GitHub release, public web routes, direct download routes, repo documentation, redirects, and provenance metadata without downloading the large binaries.

See also:

- [`docs/DOWNLOADS.md`](../docs/DOWNLOADS.md)
- [`docs/guides/ANDROID.md`](../docs/guides/ANDROID.md)
- [`docs/guides/electron-desktop.md`](../docs/guides/electron-desktop.md)

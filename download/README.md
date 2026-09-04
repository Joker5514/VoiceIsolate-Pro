# Android / desktop download artifacts

Large installers are **not committed to git**. End-user binaries are published through [GitHub Releases](https://github.com/Joker5514/VoiceIsolate-Pro/releases), and the web download hub is https://voice-isolate-pro.vercel.app/download/.

**Repository version:** `25.0.2` · native build number `250002`  
**Latest published release:** `v25.0.2`  
**Release metadata last updated:** `2026-08-25T21:22:40Z`

The current release assets are valid downloads, but they predate current `main`. See [`docs/releases/release-provenance.json`](../docs/releases/release-provenance.json) before making any cross-platform same-build claim.

## Android APK

| Channel | URL |
|---|---|
| Latest | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk |
| Pinned `v25.0.2` | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.2/VoiceIsolate-Pro-android-debug.apk |
| Historical releases | https://github.com/Joker5514/VoiceIsolate-Pro/releases |

Published asset:

- File: `VoiceIsolate-Pro-android-debug.apk`
- Type: Android sideload/debug APK
- Size: `101365796` bytes
- SHA-256: `5e531b938c78ae0fc25e0c40111d5ec766549684000030eac63284fd0eb59d5b`
- GitHub asset updated: `2026-08-25T21:22:40Z`

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
| Pinned `v25.0.2` | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.2/VoiceIsolate-Pro-25.0.2-win-x64.exe |
| Historical releases | https://github.com/Joker5514/VoiceIsolate-Pro/releases |

Published asset:

- File: `VoiceIsolate-Pro-25.0.2-win-x64.exe`
- Type: Windows x64 NSIS installer
- Size: `144628415` bytes
- SHA-256: `6f4c0887bb0ef64bd1de5e30cd14cfcd8dc34cf9788433c5c3881c8583b0e621`
- GitHub asset updated: `2026-08-24T17:20:22Z`

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

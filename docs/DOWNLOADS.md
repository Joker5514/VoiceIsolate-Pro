# Downloads — VoiceIsolate Pro

Canonical installers are hosted on **GitHub Releases** (not inside the git tree).

**Web download page:** https://voice-isolate-pro.vercel.app/download/  
**All releases:** https://github.com/Joker5514/VoiceIsolate-Pro/releases  
**Current tag:** [v24.0.0](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v24.0.0)

## Latest assets

| Platform | Asset | Approx. size | Latest URL |
|----------|--------|--------------|------------|
| **Android** | `VoiceIsolate-Pro-android-debug.apk` | ~238 MB | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk |
| **Windows** | `VoiceIsolate-Pro-24.0.0-win-x64.exe` | ~178 MB | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-24.0.0-win-x64.exe |

### Pinned v24.0.0

| Platform | URL |
|----------|-----|
| Android | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-android-debug.apk |
| Windows | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe |

## What each package includes

| Package | Contents |
|---------|----------|
| Android APK | Landing + Engineer Mode, ORT WASM, BS-RNN + RNNoise + Silero VAD, worklets. **Offline after install.** Sideload debug build (not Play Store signed). |
| Windows EXE | NSIS installer; same offline model set (Demucs not bundled). |

## Build & publish (maintainers)

```bash
# Android (Windows host)
pnpm android:build:win
# → dist/android/VoiceIsolate-Pro-android-debug.apk
gh release upload v24.0.0 dist/android/VoiceIsolate-Pro-android-debug.apk --clobber

# Windows desktop
pnpm setup:electron
pnpm build:electron
# → dist/electron/VoiceIsolate-Pro-24.0.0-win-x64.exe
gh release upload v24.0.0 dist/electron/VoiceIsolate-Pro-24.0.0-win-x64.exe --clobber
```

See also: [guides/ANDROID.md](guides/ANDROID.md), [guides/electron-desktop.md](guides/electron-desktop.md), [../download/README.md](../download/README.md).

## Vercel redirects

Same-origin paths `/download/*.apk` and `/download/*.exe` redirect to GitHub Releases (`vercel.json`) so the web host never serves SPA HTML for binary URLs.

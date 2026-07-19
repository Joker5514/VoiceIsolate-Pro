# Android / desktop download artifacts

This folder documents **where installers and APKs live**. Large binaries are **not** committed to git.

## Android APK

| Build | Command | Output |
|-------|---------|--------|
| Debug (Windows) | `pnpm android:build:win` | `android/app/build/outputs/apk/debug/app-debug.apk` and `dist/android/VoiceIsolate-Pro-debug.apk` |
| Debug (Unix) | `pnpm android:build` | same under `android/app/build/outputs/apk/debug/` |
| Release AAB | `pnpm android:bundle` (or CI `release-build.yml`) | `android/app/build/outputs/bundle/release/` |

### Public download

1. **GitHub Releases** (canonical binary host):  
   https://github.com/Joker5514/VoiceIsolate-Pro/releases  
   Latest APK asset: `VoiceIsolate-Pro-android-debug.apk`  
   Direct: `https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk`
2. **Web page:** https://voice-isolate-pro.vercel.app/download/  
   Primary buttons open the GitHub release asset (real APK, ~303 MB).  
   Same-origin `/download/*.apk` is **redirected** to GitHub Releases so it never returns SPA HTML.
3. Do **not** rely on committing APKs under `public/download/` — Vercel SPA rewrites previously turned missing `.apk` paths into `index.html`.

### Publish a release (maintainers)

```bash
# After a successful android:build:win
pnpm android:build:win
cp dist/android/VoiceIsolate-Pro-debug.apk public/download/VoiceIsolate-Pro-android-debug.apk
gh release create v24.0.0 public/download/VoiceIsolate-Pro-android-debug.apk \
  --title "VoiceIsolate Pro v24.0.0" \
  --notes "Android debug APK + web app"
```

Do **not** commit `*.apk` files (see `.gitignore`).

## Desktop (Windows) — offline installer

```bash
pnpm setup:electron
pnpm build:electron        # NSIS → dist/electron/*.exe  (downloadable)
pnpm build:electron:dir    # portable win-unpacked/
```

| Goal | Command / asset |
|------|-----------------|
| End-user download | GitHub Release: `VoiceIsolate-Pro-*-win-x64.exe` |
| Local smoke test | `dist/electron/win-unpacked/VoiceIsolate Pro.exe` |
| Web download page | https://voice-isolate-pro.vercel.app/download/ |

Packaged app is **100% offline** for voice isolation: UI, ORT wasm, and default
ONNX models (BS-RNN + denoise + VAD) are bundled. See [docs/electron-desktop.md](../docs/electron-desktop.md).

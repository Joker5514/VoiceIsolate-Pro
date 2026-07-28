# Android / desktop download artifacts

This folder documents **where installers and APKs live**. Large binaries are **not** committed to git.

Canonical host for end users: **GitHub Releases**  
https://github.com/Joker5514/VoiceIsolate-Pro/releases

Web download page: https://voice-isolate-pro.vercel.app/download/

**In-repo version:** **25.0.0** · build **250000**

---

## Android APK

| Build | Command | Output |
|-------|---------|--------|
| Debug (Windows) | `pnpm android:build:win` | `dist/android/VoiceIsolate-Pro-android-debug.apk` (also `VoiceIsolate-Pro-debug.apk`) |
| Debug (Unix) | `pnpm android:build` | `android/app/build/outputs/apk/debug/app-debug.apk` |
| Release AAB | `pnpm android:bundle` | `android/app/build/outputs/bundle/release/` |

### Public download links

| Channel | URL |
|---------|-----|
| **Latest APK** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk |
| **Pinned v24.0.0** (prior) | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-android-debug.apk |
| **All releases** | https://github.com/Joker5514/VoiceIsolate-Pro/releases |

Asset name: `VoiceIsolate-Pro-android-debug.apk` · complete offline app (Landing + Engineer Mode + models).  
Gradle: `versionName "25.0.0"`, `versionCode 250000`.

Same-origin `/download/*.apk` is **redirected** to GitHub Releases (`vercel.json`) so Vercel never serves SPA HTML for APK URLs.

### Publish Android (maintainers)

```bash
pnpm android:build:win
# → dist/android/VoiceIsolate-Pro-android-debug.apk
gh release upload v25.0.0 dist/android/VoiceIsolate-Pro-android-debug.apk --clobber
```

Do **not** commit `*.apk` under `public/download/` (see `.gitignore`).

---

## Desktop (Windows) — offline installer

| Goal | Asset / command |
|------|-----------------|
| **Latest installer** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.0-win-x64.exe |
| **Pinned v24.0.0** (prior) | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe |
| Local build | `pnpm build:electron` → `dist/electron/VoiceIsolate-Pro-25.0.0-win-x64.exe` |
| Portable smoke test | `pnpm build:electron:dir` → `dist/electron/win-unpacked/VoiceIsolate Pro.exe` |

Asset name: `VoiceIsolate-Pro-25.0.0-win-x64.exe` · 100% offline (UI + ORT + BS-RNN/denoise/VAD; Demucs optional/not bundled).

### Publish desktop (maintainers)

```bash
pnpm setup:electron
pnpm build:electron
gh release upload v25.0.0 dist/electron/VoiceIsolate-Pro-25.0.0-win-x64.exe --clobber
```

See [docs/guides/electron-desktop.md](../docs/guides/electron-desktop.md) and [docs/DOWNLOADS.md](../docs/DOWNLOADS.md).

# Android / desktop download artifacts

This folder documents **where installers and APKs live**. Large binaries are **not** committed to git.

Canonical host for end users: **GitHub Releases**  
https://github.com/Joker5514/VoiceIsolate-Pro/releases

Web download page: https://voice-isolate-pro.vercel.app/download/

**In-repo version:** **25.0.2** · build **250002**  
**Published GitHub Release (latest):** **v25.0.2**  
**Last native rebuild:** **2026-08-17** (`main` @ `a17ce35` — cancel jobs, Engineer freeze fixes, mobile landing)

Local rebuild (artifacts under `dist/`, not committed):

```bash
pnpm run build
pnpm android:build:win          # → dist/android/VoiceIsolate-Pro-android-debug.apk
pnpm build:electron:dir         # → dist/electron/win-unpacked/
pnpm build:electron             # → dist/electron/VoiceIsolate-Pro-25.0.2-win-x64.exe
```

---

## Android APK

| Build | Command | Output |
|-------|---------|--------|
| Debug (Windows) | `pnpm android:build:win` | `dist/android/VoiceIsolate-Pro-android-debug.apk` |
| Debug (Unix) | `pnpm android:build` | `android/app/build/outputs/apk/debug/app-debug.apk` |
| Release AAB | `pnpm android:bundle` | `android/app/build/outputs/bundle/release/` |

### Public download links

| Channel | URL |
|---------|-----|
| **Latest APK** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk |
| **Pinned v25.0.2** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.2/VoiceIsolate-Pro-android-debug.apk |
| **Prior v24.0.0** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-android-debug.apk |
| **All releases** | https://github.com/Joker5514/VoiceIsolate-Pro/releases |

Asset name: `VoiceIsolate-Pro-android-debug.apk` · complete offline app.  
Gradle: `versionName "25.0.2"`, `versionCode 250002`.

### Publish Android (maintainers)

```bash
pnpm android:build:win
gh release upload v25.0.2 dist/android/VoiceIsolate-Pro-android-debug.apk --clobber
```

---

## Desktop (Windows) — offline installer

| Goal | Asset / command |
|------|-----------------|
| **Latest installer** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.2-win-x64.exe |
| **Pinned v25.0.2** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.2/VoiceIsolate-Pro-25.0.2-win-x64.exe |
| **Prior v24.0.0** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe |
| Local build | `pnpm build:electron` → `dist/electron/VoiceIsolate-Pro-25.0.2-win-x64.exe` |
| Portable smoke | `pnpm build:electron:dir` → `dist/electron/win-unpacked/` |

### Publish desktop (maintainers)

```bash
pnpm setup:electron
pnpm build:electron
gh release upload v25.0.2 dist/electron/VoiceIsolate-Pro-25.0.2-win-x64.exe --clobber
```

See [docs/guides/electron-desktop.md](../docs/guides/electron-desktop.md) and [docs/DOWNLOADS.md](../docs/DOWNLOADS.md).

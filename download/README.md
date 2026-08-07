# Android / desktop download artifacts

This folder documents **where installers and APKs live**. Large binaries are **not** committed to git.

Canonical host for end users: **GitHub Releases**  
https://github.com/Joker5514/VoiceIsolate-Pro/releases

Web download page: https://voice-isolate-pro.vercel.app/download/

**In-repo version:** **25.0.1** · build **250001**  
**Published release on GitHub:** **v24.0.0** only (until maintainers cut v25.0.1)

Local rebuild (artifacts under `dist/`, not committed):

```bash
pnpm run build
pnpm android:build:win          # → dist/android/VoiceIsolate-Pro-android-debug.apk
pnpm build:electron:dir         # → dist/electron/win-unpacked/
# optional full installer:
pnpm build:electron             # → dist/electron/VoiceIsolate-Pro-25.0.1-win-x64.exe
```

---

## Android APK

| Build | Command | Output |
|-------|---------|--------|
| Debug (Windows) | `pnpm android:build:win` | `dist/android/VoiceIsolate-Pro-android-debug.apk` (also `VoiceIsolate-Pro-debug.apk`) |
| Debug (Unix) | `pnpm android:build` | `android/app/build/outputs/apk/debug/app-debug.apk` |
| Release AAB | `pnpm android:bundle` | `android/app/build/outputs/bundle/release/` |

### Public download links

| Channel | URL | Status |
|---------|-----|--------|
| **Latest APK** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk | **200** (published v24 binary today) |
| **Pinned v24.0.0** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-android-debug.apk | **200** |
| **All releases** | https://github.com/Joker5514/VoiceIsolate-Pro/releases | |

Asset name: `VoiceIsolate-Pro-android-debug.apk` · complete offline app (Landing + Engineer Mode + models).  
Gradle (in-repo): `versionName "25.0.1"`, `versionCode 250001`.

Same-origin `/download/*.apk` is **redirected** to GitHub Releases (`vercel.json`) so Vercel never serves SPA HTML for APK URLs.

### Publish Android (maintainers)

```bash
pnpm android:build:win
# → dist/android/VoiceIsolate-Pro-android-debug.apk
gh release upload v25.0.1 dist/android/VoiceIsolate-Pro-android-debug.apk --clobber
```

Do **not** commit `*.apk` under `public/download/` (see `.gitignore`).

---

## Desktop (Windows) — offline installer

| Goal | Asset / command | Status |
|------|-----------------|--------|
| **Working latest installer** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-24.0.0-win-x64.exe | **200** |
| **Pinned v24.0.0** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe | **200** |
| ~~25.0.0 latest name~~ | `…/VoiceIsolate-Pro-25.0.0-win-x64.exe` | **404** (not published) |
| Local build (code 25.0.1) | `pnpm build:electron` → `dist/electron/VoiceIsolate-Pro-25.0.1-win-x64.exe` | after build |
| Portable smoke test | `pnpm build:electron:dir` → `dist/electron/win-unpacked/VoiceIsolate Pro.exe` | after build |

Published asset name: `VoiceIsolate-Pro-24.0.0-win-x64.exe` · 100% offline (UI + ORT + BS-RNN/denoise/VAD; Demucs optional/not bundled).

### Publish desktop (maintainers)

```bash
pnpm setup:electron
pnpm build:electron
gh release create v25.0.1 dist/electron/VoiceIsolate-Pro-25.0.1-win-x64.exe \
  dist/android/VoiceIsolate-Pro-android-debug.apk \
  --title "VoiceIsolate Pro v25.0.1"
# then point download page + vercel primary Windows filename at 25.0.1
```

See [docs/guides/electron-desktop.md](../docs/guides/electron-desktop.md) and [docs/DOWNLOADS.md](../docs/DOWNLOADS.md).

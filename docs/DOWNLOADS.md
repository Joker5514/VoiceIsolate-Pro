# Downloads — VoiceIsolate Pro

**In-repo version:** **25.0.2** (`package.json`)  
**Android:** `versionName "25.0.2"` · `versionCode` **250002**  
**iOS:** `CFBundleShortVersionString` **25.0.2** · `CFBundleVersion` **250002**  
**Published GitHub Release (latest):** **[v25.0.2](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.2)**  
**Release published:** **2026-08-13T06:28:53Z** · APK and Windows EXE assets last updated **2026-08-21T10:04Z**.
Setup: [guides/GOOGLE_DRIVE.md](guides/GOOGLE_DRIVE.md).

## Public URLs (verified)

| Platform | Working URL | HTTP |
|----------|-------------|------|
| **Web download hub** | https://voice-isolate-pro.vercel.app/download/ | 200 |
| **Web Landing** | https://voice-isolate-pro.vercel.app/ | 200 |
| **Web Engineer** | https://voice-isolate-pro.vercel.app/app/ | 200 |
| **Android APK (latest)** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk | 200 at audit |
| **Windows installer (latest)** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.2-win-x64.exe | 200 at audit |
| **Android pinned v25.0.2** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.2/VoiceIsolate-Pro-android-debug.apk | 200 at audit |
| **Windows pinned v25.0.2** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.2/VoiceIsolate-Pro-25.0.2-win-x64.exe | 200 at audit |
| **Android prior v24.0.0** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-android-debug.apk | 200 |
| **Windows prior v24.0.0** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe | 200 |
| **All releases** | https://github.com/Joker5514/VoiceIsolate-Pro/releases | 200 |

Site redirects under `vercel.json` map `/download/*.apk` and `/download/*.exe` to GitHub Releases.

## Platform matrix

| Platform | Artifact | What’s included |
|----------|----------|-----------------|
| **Web** | Vercel → `public/` | Landing Live-Mix + **Engineer Console**; optional Google Drive open/save; SAM3 vision (flag OFF); SAM-Audio optional. Deployed production SHA is **not** inferred from repository HEAD. |
| **Android** | `VoiceIsolate-Pro-android-debug.apk` (101,620,559 bytes) | Capacitor WebView wrapping a `build/` shell. **Published** asset updated **2026-08-21T10:04:08Z** from `17692f9`, which is behind current `main`. |
| **Windows** | `VoiceIsolate-Pro-25.0.2-win-x64.exe` (144,646,374 bytes) | Electron loads a `build/` shell (+ Drive OAuth popups). **Published** asset updated **2026-08-21T10:04:10Z** from `17692f9`, which is behind current `main`. |
| **macOS / Linux** | Build targets only | Electron config can produce `.dmg` / `.AppImage`; no v25.0.2 GitHub Release assets are published |

Packaging rule: Web, Android, and Desktop **consume** `pnpm build` → `build/` when each surface is rebuilt from the same commit. That is not a claim that the currently published Web host, GitHub APK, GitHub EXE, `main`, and tag v25.0.2 are the same build. Provenance: [releases/release-provenance.json](releases/release-provenance.json).

Engineer Console files that must ship offline: `app/engineer-console.css`, `app/engineer-console.js` (asserted by Android prepare/verify scripts).

`build/`, `android/.../assets/public`, and `dist/*` binaries are **gitignored** — regenerate after pulling.

## Build & publish (maintainers)

```bash
pnpm install
pnpm build
pnpm mobile:sync-version
pnpm test:ci
pnpm check:cloud-audio

# Android
pnpm android:build:win     # → dist/android/VoiceIsolate-Pro-android-debug.apk

# Desktop
pnpm setup:electron
pnpm build:electron        # → dist/electron/VoiceIsolate-Pro-25.0.2-win-x64.exe

# Publish / refresh assets on existing tag (clobber)
gh release upload v25.0.2 \
  dist/android/VoiceIsolate-Pro-android-debug.apk \
  dist/electron/VoiceIsolate-Pro-25.0.2-win-x64.exe \
  --clobber
```

## SAM stack (all three platforms)

| Component | Web | Android | Desktop |
|-----------|-----|---------|---------|
| **SAM-Audio** | optional loopback / ONNX | optional `sam_audio.onnx` | real worker via Electron IPC |
| **SAM 3** (vision) | JS bundled; flag OFF | same in WebView | same + extraResources |
| Default isolation | BSRNN / RNNoise / USM | same | same |

Enable SAM 3: `VIP_SAM3_ENABLED=1` or `localStorage.setItem('vip-sam3-enabled','1')`.  
Docs: [SAM3_TECHNICAL_DOCUMENTATION.md](SAM3_TECHNICAL_DOCUMENTATION.md) · [SAM_AUDIO.md](guides/SAM_AUDIO.md)

## Product snapshot PDF

See [docs/releases/VoiceIsolate_Pro_v25_Current_State.pdf](releases/VoiceIsolate_Pro_v25_Current_State.pdf).

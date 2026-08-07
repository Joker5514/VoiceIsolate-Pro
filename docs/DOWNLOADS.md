# Downloads — VoiceIsolate Pro

**In-repo version:** **25.0.1** (`package.json`)  
**Android:** `versionName "25.0.1"` · `versionCode` **250001**  
**iOS:** `CFBundleShortVersionString` **25.0.1** · `CFBundleVersion` **250001**  
**Published GitHub Release (only):** **[v24.0.0](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v24.0.0)** (2026-07-18 / assets 2026-07-21)

> **Verified 2026-08-07:** Windows `…/latest/download/VoiceIsolate-Pro-25.0.0-win-x64.exe` **404s**.  
> Working Windows asset name on `latest` is **`VoiceIsolate-Pro-24.0.0-win-x64.exe`**.  
> Android APK name is version-stable (`VoiceIsolate-Pro-android-debug.apk`) and **200 OK**.

## Public URLs (must not 404)

| Platform | Working URL | HTTP (2026-08-07) |
|----------|-------------|-------------------|
| **Web download hub** | https://voice-isolate-pro.vercel.app/download/ | 200 |
| **Web Landing** | https://voice-isolate-pro.vercel.app/ | 200 |
| **Web Engineer** | https://voice-isolate-pro.vercel.app/app/ | 200 |
| **Android APK (latest)** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk | 200 |
| **Windows installer (latest / published)** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-24.0.0-win-x64.exe | 200 |
| **Android pinned v24.0.0** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-android-debug.apk | 200 |
| **Windows pinned v24.0.0** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe | 200 |
| **All releases** | https://github.com/Joker5514/VoiceIsolate-Pro/releases | 200 |

### Broken (do not use until a new release is uploaded)

| URL | Status |
|-----|--------|
| `…/latest/download/VoiceIsolate-Pro-25.0.0-win-x64.exe` | **404** |
| `…/latest/download/VoiceIsolate-Pro-25.0.1-win-x64.exe` | **404** |

Site redirects under `vercel.json` map legacy `/download/VoiceIsolate-Pro-25.*.exe` paths to the **published v24 Windows asset** so bookmarks keep working until `v25.0.1` is cut.

## Platform matrix (code on `main`)

| Platform | Artifact when you build today | What’s included |
|----------|-------------------------------|-----------------|
| **Web** | Vercel → `public/` | Live-Mix + Engineer; SAM3 vision modules (flag OFF); SAM-Audio optional |
| **Android** | `VoiceIsolate-Pro-android-debug.apk` | Capacitor shell from `build/` — same web + SAM3 JS |
| **Windows** | `VoiceIsolate-Pro-25.0.1-win-x64.exe` (electron-builder `${version}`) | Electron + `build/**` + SAM-Audio worker package |

`build/`, `android/.../assets/public`, and `dist/*` binaries are **gitignored** — regenerate after pulling.

## Build & publish (maintainers)

```bash
pnpm install
pnpm build                 # includes ensure-sam-in-build via package script
pnpm mobile:sync-version   # android + iOS from package.json
pnpm test:ci
pnpm check:cloud-audio

# Android
pnpm android:build:win     # → dist/android/VoiceIsolate-Pro-android-debug.apk

# Desktop
pnpm setup:electron
pnpm build:electron        # → dist/electron/VoiceIsolate-Pro-25.0.1-win-x64.exe

# Cut + upload (creates new latest)
gh release create v25.0.1 \
  dist/android/VoiceIsolate-Pro-android-debug.apk \
  dist/electron/VoiceIsolate-Pro-25.0.1-win-x64.exe \
  --title "VoiceIsolate Pro v25.0.1" \
  --notes "Web/Android/Desktop shell sync to 25.0.1 (SAM-Audio, SAM3 flag-off, DSP polish)."

# Then update download page + vercel.json primary Windows filename to 25.0.1
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

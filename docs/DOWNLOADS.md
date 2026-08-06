# Downloads — VoiceIsolate Pro

**In-repo version:** **25.0.1** (`package.json`)  
**Android / Electron product lines** may still publish under **25.0.0** artifact names until the next release cut.

**Platform web-shell sync:** after pulling `main`, regenerate local packages:

```bash
pnpm build                 # public/ + src/ → build/ (includes sam3_integration)
pnpm sam:ensure-build      # SAM-Audio + SAM3 markers into build/
# Android / Electron then pack from build/
```

`build/`, `android/.../assets/public`, and `dist/*` binaries are **gitignored** — regenerate after pulling.

Published GitHub Release assets are cut separately. Prefer **`/releases/latest/download/…`** for current files; pinned v24 links remain for rollback.

## Current code target

| Platform | Artifact | What’s included |
|----------|----------|-----------------|
| **Web** | https://voice-isolate-pro.vercel.app/ · `/app/` | Live-Mix + Engineer; SAM3 vision modules under `/src/sam3_integration/` (flag OFF); SAM-Audio optional loopback |
| **Android** | `VoiceIsolate-Pro-android-debug.apk` | Capacitor shell from `build/` — same web + SAM3 JS; no cloud vision |
| **Windows** | `VoiceIsolate-Pro-25.0.0-win-x64.exe` (name may lag version) | Electron + `build/**` + SAM-Audio worker package + SAM3 modules |

### Published release URLs

| Platform | Latest (preferred) | Pinned prior |
|----------|--------------------|--------------|
| **Android APK** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-android-debug.apk |
| **Windows installer** | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.0-win-x64.exe | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe |
| **All releases** | https://github.com/Joker5514/VoiceIsolate-Pro/releases | |

> If `latest` still points at an older tag, use the pinned v24 URLs or wait for a new GitHub Release that packs post-SAM3 `build/`.

### Download page (site)

https://voice-isolate-pro.vercel.app/download/

## SAM stack in downloads (all three platforms)

| Component | Web | Android | Desktop |
|-----------|-----|---------|---------|
| **SAM-Audio** (audio separation) | optional loopback worker / ONNX | optional `sam_audio.onnx` | real worker via Electron IPC |
| **SAM 3** (vision sidecar) | JS bundled; flag OFF | same in WebView | same + extraResources |
| Default isolation | BSRNN / RNNoise / USM | same | same |

Enable SAM 3 (vision) after install: `VIP_SAM3_ENABLED=1` or browser `localStorage.setItem('vip-sam3-enabled','1')`.  
Docs: [SAM3_TECHNICAL_DOCUMENTATION.md](SAM3_TECHNICAL_DOCUMENTATION.md) · [SAM_AUDIO.md](guides/SAM_AUDIO.md)

## Build & publish (maintainers)

```bash
# Web shell + SAM markers
pnpm install
pnpm build
pnpm sam:ensure-build
pnpm test:sam3

# Android
pnpm android:build:win   # or pnpm android:build on Unix
# → dist/android/VoiceIsolate-Pro-android-debug.apk

# Desktop
pnpm build:electron
# → dist/electron/VoiceIsolate-Pro-<version>-win-x64.exe

# Upload to a release tag (example)
gh release upload v25.0.1 dist/android/VoiceIsolate-Pro-android-debug.apk --clobber
gh release upload v25.0.1 dist/electron/VoiceIsolate-Pro-25.0.1-win-x64.exe --clobber
```

Sync versions after editing `package.json#version`:

```bash
pnpm mobile:sync-version
```

## Product snapshot PDF

See [docs/releases/VoiceIsolate_Pro_v25_Current_State.pdf](releases/VoiceIsolate_Pro_v25_Current_State.pdf).

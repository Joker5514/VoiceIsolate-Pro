# Platform sync status

| Field | Value |
|-------|--------|
| **Reviewed product SHA** | `0b791c2001d89f7005ea67d7b8ecefd68c8e82d3` (#784) |
| **Git SHA (last native rebuild)** | `0b791c2001d89f7005ea67d7b8ecefd68c8e82d3` |
| **Later docs-only on main** | #785, #786 — do not require a native rebuild |
| **Package version** | `25.0.2` / build `250002` |
| **Published GitHub binaries** | **[v25.0.2](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.2)** (Latest) |
| **Native assets updated (UTC)** | 2026-08-24T17:20Z |
| **Artifacts** | APK 101,347,500 bytes · Windows NSIS 144,628,415 bytes |
| **Sync verdict** | **Synchronized** at `0b791c2`. Web production deploy, Android APK, and Windows NSIS were all built from that SHA. Tag v25.0.2 was not moved. |

Machine-readable record: [release-provenance.json](release-provenance.json).

## Version sources of truth

| Surface | Source | Expected |
|---------|--------|----------|
| npm / Electron artifact | `package.json#version` | `25.0.2` |
| Android | `android/app/build.gradle` | `25.0.2` / `250002` |
| iOS | `ios/App/App/Info.plist` | `25.0.2` / `250002` |
| Capacitor UA | `capacitor.config.json` | `VoiceIsolatePro/25.0.2` |
| API health | `api-routes/index.js` | `25.0.2` |
| Download page | `public/download/index.html` | latest → 25.0.2 assets |

## Rebuild after pulling

```bash
pnpm install
pnpm mobile:sync-version
pnpm version:check
pnpm build
pnpm android:build:win
pnpm build:electron
pnpm test:ci
pnpm check:cloud-audio
```

## Verify download links

```bash
curl -sI "https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk"
curl -sI "https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.2-win-x64.exe"
```

# Platform release status

This document describes what is **published**, what is **current in source**, and what is **proven**. It intentionally avoids inferring native build identity from a tag, release description, or repository HEAD.

| Field | Current value |
|---|---|
| Reviewed source | `f5b271892de7bb8aca85b351062dd81f9191f756` (2026-10-20) |
| Package version | `25.0.2` / native build number `250002` |
| Latest GitHub release | [`v25.0.3`](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.3) (published 2026-09-09) |
| Release-note source | `038b3104e659be4c3914bd5ecd763e6141b98f16` (ancestor of reviewed source; not an embedded binary manifest) |
| Android asset | `VoiceIsolate-Pro-android-debug.apk` · 101,650,376 bytes · SHA-256 `70317aaa84c3f2ca286115a878fd79978de80e8df0a2cc9538201bf9bf7dc626` · updated `2026-09-09T23:31:41Z` |
| Windows asset | `VoiceIsolate-Pro-25.0.2-win-x64.exe` · 144,667,075 bytes · SHA-256 `926cab42ff8453f812de52bd66368553f708c2747556ed191dabaca66f2ce4c8` · updated `2026-09-09T23:31:43Z` |
| Pinned Android URL | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.3/VoiceIsolate-Pro-android-debug.apk |
| Pinned Windows URL | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.3/VoiceIsolate-Pro-25.0.2-win-x64.exe |
| Sync verdict | **Not synchronized.** The v25.0.3 APK and EXE are older than reviewed `main`. The production web deployment SHA is not proven. Do not describe Web, Android, Windows, `main`, and the release tag as the same build. |

Machine-readable evidence: [`release-provenance.json`](release-provenance.json).

## Version sources of truth

| Surface | Source | Expected |
|---|---|---|
| Package / Electron artifact name | `package.json#version` | `25.0.2` |
| Android version | `android/app/build.gradle` | `25.0.2` / `250002` |
| Capacitor user agent | `capacitor.config.json` | `VoiceIsolatePro/25.0.2` |
| iOS metadata | `ios/App/App/Info.plist` | `25.0.2` / `250002` |
| Download page | `public/download/index.html` | published `v25.0.3` assets; page still shows repository `v25.0.2` |
| Release evidence | GitHub Release API + `release-provenance.json` | asset name, size, digest, URL |

The iOS project is kept version-aligned for repository consistency, but **iOS is outside the supported v1.0 platform scope** and no current iOS release artifact is published.

## What "synchronized" means

Web, Android, and Windows may be called synchronized only when all of these are true:

1. Each platform was built/deployed from the same full Git SHA.
2. The exact artifacts/deployment are recorded in `release-provenance.json`.
3. Native SHA-256 digests and byte sizes match the published release assets.
4. The Web deployment has immutable deployment evidence for that same SHA.
5. `pnpm provenance:validate:strict` passes.

A release description that says packages "match" is not sufficient evidence by itself.

## Shared shell

Desktop browsers, Android browsers, Capacitor Android, and Electron Windows load one upload-only product shell from source: Landing at `/` and the Engineer Console at `public/app/`. Android Chrome uses the website. The APK and the EXE are separate packages. They match the website only when each one was built from the commit that website is serving. That commit match is not proven here.

## What the v25.0.3 release notes list

These items are named in the v25.0.3 release notes. They are on reviewed `main` because `038b3104e659be4c3914bd5ecd763e6141b98f16` is an ancestor of that commit. Later `main` commits are not in the published APK or EXE.

| Fix | Platform |
|---|---|
| `MLWorker.cacheRequest` 30s timeout — prevents indefinite freeze | Electron (primary), all |
| `ProcessingOrchestrator.initialize()` timer leak on early abort | All |
| `PlaybackMixer` `AudioContext` try/catch — crash guard before user gesture | Android WebView, iOS Safari |
| `_cancelledId` token — cancel unblocks `_processChain` immediately | All |
| Integrity-first model cache (always re-verify cached bytes) | All |
| Quick Clean capability gate (blocks unshipped/unpinned models) | All |
| Responsive breakpoints 900px / 480px | Web, Android WebView |

## Rebuild steps (next release)

```bash
pnpm install --frozen-lockfile
pnpm version:check
pnpm lint
pnpm test:ci
pnpm validate
pnpm build
pnpm android:build:win
pnpm build:electron
```

## Verify current downloads

```bash
pnpm downloads:validate
```

For manual inspection only:

```bash
curl -sI "https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk"
curl -sI "https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.2-win-x64.exe"
```

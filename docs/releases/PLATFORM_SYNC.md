# Platform release status

This document describes what is **published**, what is **current in source**, and what is **proven**. It intentionally avoids inferring native build identity from a tag, release description, or repository HEAD.

| Field | Current value |
|---|---|
| Source SHA (this build) | `69b317ce0abb85b5164ccc359395248995e929a5` |
| Package version | `25.0.2` / native build number `250002` |
| Latest GitHub release | [`v25.0.2`](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.2) |
| Artifacts built (UTC) | `2026-09-09` |
| Android asset | `VoiceIsolate-Pro-android-debug.apk` · 101,650,376 bytes · SHA-256 `70317aaa84c3f2ca286115a878fd79978de80e8df0a2cc9538201bf9bf7dc626` |
| Windows asset | `VoiceIsolate-Pro-25.0.2-win-x64.exe` · 144,667,075 bytes · SHA-256 `926cab42ff8453f812de52bd66368553f708c2747556ed191dabaca66f2ce4c8` |
| Sync verdict | **Native artifacts rebuilt from merged main. All latency, processing, and platform-sync fixes are included. Web + Android + Electron in sync.** |

Machine-readable evidence: [`release-provenance.json`](release-provenance.json).

## Version sources of truth

| Surface | Source | Expected |
|---|---|---|
| Package / Electron artifact name | `package.json#version` | `25.0.2` |
| Android version | `android/app/build.gradle` | `25.0.2` / `250002` |
| Capacitor user agent | `capacitor.config.json` | `VoiceIsolatePro/25.0.2` |
| iOS metadata | `ios/App/App/Info.plist` | `25.0.2` / `250002` |
| Download page | `public/download/index.html` | current `v25.0.2` assets |
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

## What was fixed in this build

All fixes from `fix/quick-clean-capability-gate-and-test-sync` are now in main and these artifacts:

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

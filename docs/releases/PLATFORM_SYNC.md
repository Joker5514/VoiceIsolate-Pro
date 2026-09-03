# Platform release status

This document describes what is **published**, what is **current in source**, and what is **proven**. It intentionally avoids inferring native build identity from a tag, release description, or repository HEAD.

| Field | Current value |
|---|---|
| Reviewed `main` SHA before PR #808 | `d8514bad2f665b65b6489e200524d8800f5c800d` |
| Package version | `25.0.2` / native build number `250002` |
| Latest GitHub release | [`v25.0.2`](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.2) |
| Release metadata updated | `2026-08-25T21:22:40Z` |
| Android asset | `VoiceIsolate-Pro-android-debug.apk` · 101,365,796 bytes · SHA-256 `5e531b938c78ae0fc25e0c40111d5ec766549684000030eac63284fd0eb59d5b` |
| Windows asset | `VoiceIsolate-Pro-25.0.2-win-x64.exe` · 144,628,415 bytes · SHA-256 `6f4c0887bb0ef64bd1de5e30cd14cfcd8dc34cf9788433c5c3881c8583b0e621` |
| Sync verdict | **Published native assets are valid release snapshots, but they are not synchronized with current `main`.** Their source SHAs are not independently proven by immutable build metadata in the refreshed provenance record. |

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

## Current rebuild requirement

PR #808 changes shared web presentation/runtime behavior and Android security configuration. After it merges, new Android and Windows artifacts are required before claiming native packages contain those fixes.

```bash
pnpm install --frozen-lockfile
pnpm version:check
pnpm lint
pnpm test:ci
pnpm validate
pnpm build
pnpm downloads:validate

pnpm android:build:win
pnpm setup:electron
pnpm build:electron
```

Then publish the rebuilt artifacts, refresh the provenance record from the actual release metadata, and run strict provenance validation.

## Verify current downloads

```bash
pnpm downloads:validate
```

For manual inspection only:

```bash
curl -sI "https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk"
curl -sI "https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.2-win-x64.exe"
```

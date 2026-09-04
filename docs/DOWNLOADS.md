# Downloads — VoiceIsolate Pro

This is the canonical human-readable download record for the current product line.
Machine-readable release evidence lives in [`releases/release-provenance.json`](releases/release-provenance.json).

## Current product and release

- **Repository package version:** `25.0.2`
- **Published GitHub release:** [`v25.0.2`](https://github.com/Joker5514/VoiceIsolate-Pro/releases/tag/v25.0.2)
- **Release published:** `2026-08-13T06:28:53Z`
- **Release metadata last updated:** `2026-08-25T21:22:40Z`
- **Published platforms:** Web, Android sideload APK, Windows x64 installer
- **iOS:** project scaffolding/version metadata exists, but iOS is explicitly outside the v1.0 supported release scope and has no current published artifact.
- **macOS / Linux:** Electron build targets may exist, but no `v25.0.2` GitHub Release artifacts are published.

> The published Android and Windows binaries are release snapshots. They predate current `main` and the source SHA of those binaries is not independently proven by immutable build metadata in the current provenance record. Do not describe Web, Android, Windows, `main`, and the release tag as the same build unless strict provenance validation proves it.

## Current public URLs

| Surface | URL |
|---|---|
| Web Landing | https://voice-isolate-pro.vercel.app/ |
| Engineer Console | https://voice-isolate-pro.vercel.app/app/ |
| Download hub | https://voice-isolate-pro.vercel.app/download/ |
| Android latest | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk |
| Android pinned `v25.0.2` | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.2/VoiceIsolate-Pro-android-debug.apk |
| Windows latest | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.2-win-x64.exe |
| Windows pinned `v25.0.2` | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.2/VoiceIsolate-Pro-25.0.2-win-x64.exe |
| All releases / historical builds | https://github.com/Joker5514/VoiceIsolate-Pro/releases |

Historical release links belong on the GitHub Releases page and in historical release notes, not in the current primary download flow.

## Published native assets — observed from GitHub Release API

| Platform | Asset | Size | SHA-256 | Last updated |
|---|---|---:|---|---|
| Android | `VoiceIsolate-Pro-android-debug.apk` | 101,365,796 bytes | `5e531b938c78ae0fc25e0c40111d5ec766549684000030eac63284fd0eb59d5b` | `2026-08-25T21:22:40Z` |
| Windows x64 | `VoiceIsolate-Pro-25.0.2-win-x64.exe` | 144,628,415 bytes | `6f4c0887bb0ef64bd1de5e30cd14cfcd8dc34cf9788433c5c3881c8583b0e621` | `2026-08-24T17:20:22Z` |

The Android artifact is a **debug/sideload APK**, not a Play Store production artifact. `MainActivity` enables WebView debugging only when `BuildConfig.DEBUG` is true; release builds keep it disabled.

The Windows installer may be unsigned and can trigger Microsoft SmartScreen. Code-signing hooks exist in the Electron build configuration, but a signing hook is not proof that a particular published binary is signed.

## Offline behavior

Core voice isolation is local and can run without an internet connection after required application/model assets are installed or packaged. Optional network features—such as Google Drive import/export, update checks, and release downloads—require connectivity. Audio is not sent to a server for processing or inference.

## Validate downloads

Run the repository validator before release or after changing download/release documentation:

```bash
pnpm downloads:validate
```

The validator checks:

1. GitHub `releases/latest` resolves to `v25.0.2`.
2. The expected Android and Windows assets exist and report non-zero sizes and SHA-256 digests.
3. Canonical docs and the public download page use the current asset names and URLs.
4. `release-provenance.json` matches observed release asset metadata.
5. The public Landing, Engineer, and download routes respond.
6. Vercel download redirects and GitHub direct-download routes resolve without downloading the binaries.

Static Jest guardrails also live in `tests/download-links.test.js`.

## Packaging and rebuild rule

Web, Android, and Electron consume the shared web shell produced by `pnpm build`, but they only contain the same source when each package is actually rebuilt from the same verified commit.

```bash
pnpm install --frozen-lockfile
pnpm version:check
pnpm lint
pnpm test:ci
pnpm validate
pnpm build
pnpm downloads:validate

# Android sideload/debug artifact
pnpm android:build:win

# Windows x64 installer
pnpm setup:electron
pnpm build:electron
```

Large generated binaries under `dist/`, native copied web assets, and `build/` are not committed to git.

## Publishing

Do not overwrite existing release assets until the exact source commit has passed the full release gates and provenance has been regenerated from the produced binaries.

A typical refresh is:

```bash
gh release upload v25.0.2 \
  dist/android/VoiceIsolate-Pro-android-debug.apk \
  dist/electron/VoiceIsolate-Pro-25.0.2-win-x64.exe \
  --clobber
```

After upload, refresh `docs/releases/release-provenance.json` from observed GitHub Release metadata and run `pnpm downloads:validate` again.

## Related docs

- [Android guide](guides/ANDROID.md)
- [Electron desktop guide](guides/electron-desktop.md)
- [Platform release status](releases/PLATFORM_SYNC.md)
- [Google Drive optional file I/O](guides/GOOGLE_DRIVE.md)
- [Documentation index](README.md)

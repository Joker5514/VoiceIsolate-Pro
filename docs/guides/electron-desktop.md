# VoiceIsolate Pro — Electron desktop

The Electron desktop path reuses the same renderer produced by `pnpm build`: Landing + the shared Engineer Console under `public/app/`. Desktop-specific behavior is limited to the native shell, filesystem/cache integration, dialogs, update plumbing, and approved preload IPC.

## Security model

| Setting | Required value |
|---|---|
| `contextIsolation` | `true` |
| `nodeIntegration` | `false` |
| `sandbox` | `true` |
| Renderer preload | `electron/preload.cjs` with a narrow `contextBridge` API |
| Insecure content | disabled |

Renderer code must never regain arbitrary Node access.

## Preload API

`window.vipDesktop` exposes the allowlisted desktop bridge. Current responsibilities include:

- platform/app version discovery
- native open/save dialogs
- filesystem-backed model cache reads/writes
- update check/download/install status
- optional desktop-specific worker/service integration where explicitly implemented

See `electron/preload.cjs`, `src/core/DesktopBridge.js`, `src/core/DesktopModelCache.js`, and `src/core/ModelCacheBridge.js` for the actual contract.

## Current Windows download

- Latest: https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.2-win-x64.exe
- Pinned `v25.0.2`: https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.2/VoiceIsolate-Pro-25.0.2-win-x64.exe
- All releases: https://github.com/Joker5514/VoiceIsolate-Pro/releases
- Download hub: https://voice-isolate-pro.vercel.app/download/

Published `v25.0.2` Windows asset:

- File: `VoiceIsolate-Pro-25.0.2-win-x64.exe`
- Size: `144628415` bytes
- SHA-256: `6f4c0887bb0ef64bd1de5e30cd14cfcd8dc34cf9788433c5c3881c8583b0e621`
- GitHub asset updated: `2026-08-24T17:20:22Z`

The published installer is a release snapshot and predates current `main`. Its source SHA is not independently proven by immutable build metadata in the refreshed provenance record.

## Development

```bash
pnpm install --frozen-lockfile
pnpm setup:electron

# Terminal 1
pnpm dev

# Terminal 2
pnpm electron:dev
```

Set `VIP_ELECTRON_DEVTOOLS=1` during development when DevTools are intentionally needed.

## Production build

```bash
pnpm setup:electron
pnpm build:electron        # Windows NSIS installer
pnpm build:electron:dir    # unpacked smoke-test directory
```

Output is under `dist/electron/` and is not committed to git.

| Artifact | Typical path |
|---|---|
| Windows installer | `dist/electron/VoiceIsolate-Pro-25.0.2-win-x64.exe` |
| Unpacked executable | `dist/electron/win-unpacked/VoiceIsolate Pro.exe` |

After any shared Landing/Engineer/runtime change, rebuild the desktop package before claiming the published installer contains the fix.

## Offline behavior

Core isolation can run locally after the packaged renderer, runtime, and required models are available. Optional network features—including Google Drive file I/O, update checks/downloads, and release navigation—require connectivity.

| Capability | Desktop behavior |
|---|---|
| UI / workers / ORT assets | packaged from `build/` |
| Core models | packaged/seeded according to the Electron build configuration |
| Model cache | filesystem-first under the app data directory with shared fallback abstractions |
| File open/save | native dialog via preload bridge |
| Audio processing | local; user audio is not sent to a server for inference |
| Auto-update | optional GitHub Releases channel; not required to process audio |

Large optional model families may be excluded from the standard installer when package size or memory constraints make them unsuitable.

## Persistence

Desktop shares the same logical FileLibrary/project-pack concepts as the browser/Android renderer while using desktop-capable storage adapters where available.

- Source/project library: renderer FileLibrary abstraction
- Model cache: filesystem-first through `window.vipDesktop`, with supported fallback storage
- Startup: lazy hydration; avoid copying/decoding large media on boot
- Cross-platform handoff: `.vippack`

## Auto-update

Packaged builds can use `electron-updater` with GitHub Releases. Renderer actions are exposed through the preload allowlist rather than direct Node access.

Set `VIP_SKIP_AUTO_UPDATE=1` to disable startup update checks. Development mode must not behave like a production updater.

## Code signing

The repository contains signing/notarization hooks. **Configuration is not proof that a particular published artifact is signed.** Verify the actual binary before making a signed-release claim.

| Platform | Typical credentials/config |
|---|---|
| Windows Authenticode | `CSC_LINK` / `WIN_CSC_LINK`, `CSC_KEY_PASSWORD` |
| macOS signing | certificate credentials + `APPLE_TEAM_ID` |
| Apple notarization | `APPLE_ID`, app-specific password, team ID |

Local Windows builds commonly disable automatic certificate discovery and may be unsigned. An unsigned installer can trigger Microsoft SmartScreen.

No macOS or Linux binaries are currently published in GitHub Release `v25.0.2`.

## Live/processing architecture

Desktop does not get a separate audio product architecture. It consumes the same upload-only Stem-Split & Live-Mix system and Engineer Console contracts described in `CLAUDE.md`. Process-time ML remains explicit; sliders must not trigger ML inference.

## Validation before publishing

```bash
pnpm version:check
pnpm lint
pnpm test:ci
pnpm validate
pnpm build
pnpm downloads:validate
pnpm build:electron
```

After upload, refresh `docs/releases/release-provenance.json` from the actual GitHub Release asset metadata and run:

```bash
pnpm provenance:validate
pnpm downloads:validate
```

Only use `pnpm provenance:validate:strict` when every supported published surface has verified current provenance.

## Related docs

- [`../DOWNLOADS.md`](../DOWNLOADS.md)
- [`../releases/PLATFORM_SYNC.md`](../releases/PLATFORM_SYNC.md)
- [`../releases/release-provenance.json`](../releases/release-provenance.json)
- [`GOOGLE_DRIVE.md`](GOOGLE_DRIVE.md)

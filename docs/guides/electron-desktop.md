# VoiceIsolate Pro — Electron Desktop MVP

Master Blueprint v2.1 §IV / §VIII. Desktop path reuses the **same web renderer** as Vercel/Android: Landing + **Engineer Console** (`public/app/engineer-console.*`) from `build/` after `pnpm build`.

## Security Model

| Setting | Value | Rationale |
|---------|-------|-----------|
| `contextIsolation` | `true` | Renderer cannot access Node/Electron internals |
| `nodeIntegration` | `false` | No `require()` in renderer |
| `sandbox` | `true` | Process isolation |
| `preload` | `electron/preload.cjs` | Whitelisted IPC via `contextBridge` only |

Renderer API surface: `window.vipDesktop` (see `electron/preload.cjs`).

## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `vip:platform` | invoke | `win32` / `darwin` / `linux` |
| `vip:app-version` | invoke | Semver from `package.json` |
| `vip:open-file` | invoke | Native open dialog → `ArrayBuffer` |
| `vip:save-file` | invoke | Native save dialog |
| `vip:model-cache-path` | invoke | Filesystem model cache directory |
| `vip:read-model-cache` | invoke | Read cached ONNX by relative path |
| `vip:write-model-cache` | invoke | Write ONNX blob to filesystem cache |
| `vip:update-check` | invoke | Check GitHub Releases for updates |
| `vip:update-download` | invoke | Download available update |
| `vip:update-install` | invoke | Quit and install downloaded update |
| `vip:update-status` | event | Auto-update progress (main → renderer) |

## Persistence (synced with browser / Android)

Desktop uses the same renderer FileLibrary stack as the web app:

| Feature | Behavior |
|---------|----------|
| Source library | OPFS when available; IndexedDB blob fallback |
| Model cache | Filesystem-first via ipDesktop + IDB v3 key-value |
| Boot restore | Lazy hydrate — no giant File copy on startup |
| Project packs | Export/import .vippack for Android/web handoff |

Rebuild after web/Engineer Console changes: `pnpm build && pnpm build:electron:dir` (or `pnpm build:electron`) so NSIS packages the updated `build/app/engineer-console.*` assets.

## Development

```bash
# First-time only — downloads the Electron platform binary if missing
pnpm setup:electron

# Terminal 1 — web dev server (COOP/COEP for SharedArrayBuffer)
pnpm dev

# Terminal 2 — Electron shell loading localhost:3000
pnpm electron:dev
```

Optional: `VIP_ELECTRON_DEVTOOLS=1 pnpm electron:dev` opens DevTools.

## Production Build (downloadable + 100% offline)

```bash
pnpm setup:electron        # once — download Electron binary
pnpm build:electron        # NSIS installer (Windows)
pnpm build:electron:dir    # portable unpacked folder (no installer)
```

Output: `dist/electron/`.

| Artifact | Path | Use |
|----------|------|-----|
| Windows installer | `dist/electron/VoiceIsolate-Pro-*-win-x64.exe` | Download + install for end users |
| Portable | `dist/electron/win-unpacked/VoiceIsolate Pro.exe` | Smoke test / USB portable |

### Offline guarantees (packaged app)

| Capability | How |
|------------|-----|
| UI + workers + ORT wasm | Shipped under `build/` inside the app |
| Default isolation models | `bsrnn_vocals`, `rnnoise`, Silero VAD bundled in `build/app/models/` |
| Model load without network | Custom **`vip://`** protocol (not `file://`) + first-launch seed into `{userData}/models/` |
| COOP / COEP | Set on every `vip://` response → SharedArrayBuffer worklets work offline |
| Auto-update | Optional; skipped when offline; never required to isolate audio |

Huge optional weights (`demucs_v4_fp32.onnx`) are **excluded** from the installer to keep size reasonable. Default chain is BS-RNN only (~4 MB).

Publish installer to GitHub Releases; the web download page links there:

| Channel | URL |
|---------|-----|
| Web download page | https://voice-isolate-pro.vercel.app/download/ |
| Latest Windows installer | https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.2-win-x64.exe |
| Pinned v25.0.2 | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.2/VoiceIsolate-Pro-25.0.2-win-x64.exe |
| Prior v24.0.0 | https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe |
| Approx. size | ~138 MB (BS-RNN + denoise + VAD offline; Demucs not in installer) |
| Last release upload | 2026-08-21T10:04Z (v25.0.2 — `17692f9` #776 Drive + #774) |

## Model Cache (Desktop)

Unlike web (IndexedDB), desktop uses filesystem storage under:

```
{userData}/models/
```

On first launch the main process copies bundled offline ONNX files into this
cache so MLWorker never needs a network fetch.

`src/core/DesktopModelCache.js` implements filesystem-first caching with IndexedDB
fallback. `src/core/ModelCacheBridge.js` proxies MLWorker cache I/O to the main
thread (workers cannot call `vipDesktop` directly). All MLWorker hosts use
`src/pipeline/MLWorkerHost.js` which attaches the bridge automatically.

## File I/O Integration (Done)

| Layer | Module | Desktop path |
|-------|--------|--------------|
| Core | `src/core/DesktopBridge.js` | `pickAudioFile()`, `saveExportBlob()` |
| Pipeline | `src/pipeline/FileIngestion.js` | `pickAndIngestFile()` |
| Presentation | `src/presentation/ExportControls.js` | `_deliverBlob()` → native save |
| Landing | `public/landing.js` | Upload zone uses native picker when `isDesktopShell()` |

## Auto-Update (GitHub Releases)

Packaged builds check for updates on launch (`electron-updater` + `publish: github`
in `electron/electron-builder.yml`). Renderer API:

```js
await window.vipDesktop.checkForUpdates();
const off = window.vipDesktop.onUpdateStatus((s) => console.log(s.state));
await window.vipDesktop.downloadUpdate();
await window.vipDesktop.installUpdate();
```

Set `VIP_SKIP_AUTO_UPDATE=1` to disable the startup check. Dev mode (`VIP_ELECTRON_DEV=1`)
never checks for updates.

## Code Signing

| Platform | Env vars | Notes |
|----------|----------|-------|
| Windows Authenticode | `CSC_LINK` or `WIN_CSC_LINK`, `CSC_KEY_PASSWORD` | `signAndEditExecutable: true` in builder config |
| macOS | `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_TEAM_ID` | `hardenedRuntime` + `electron/entitlements.mac.plist` |
| Apple notarization | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | `electron/notarize.cjs` afterSign hook |

Local unsigned Windows builds use `pnpm build:electron` which sets
`CSC_IDENTITY_AUTO_DISCOVERY=false`.

## Live-Mode Pipeline

`src/pipeline/LivePipeline.js` integrates `QuantumHopBridge` for hop-aligned FFT
windows in live mode (Blueprint v2.1 §III). It accepts AudioWorklet quanta via
`pushQuantum()` or drains a ring buffer via `drainRingBuffer()`.

## Phase 1 Desktop MVP — Complete

- [x] Wire `FileIngestion` to `vipDesktop.openFile()` in desktop shell
- [x] Wire `ExportOrchestrator` / `ExportControls` to `vipDesktop.saveFile()`
- [x] Desktop model loader adapter (filesystem-first, IndexedDB fallback)
- [x] Code signing (Windows Authenticode, Apple notarization)
- [x] `electron-updater` auto-update channel (GitHub Releases)
- [x] Live-mode pipeline integration with `QuantumHopBridge`
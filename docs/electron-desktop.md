# VoiceIsolate Pro — Electron Desktop MVP

Master Blueprint v2.1 §IV / §VIII. Short-term desktop path reusing 85–95% of the web renderer.

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

## Production Build

```bash
pnpm build:electron        # NSIS (Win) / DMG (macOS) / AppImage (Linux)
pnpm build:electron:dir    # unpacked dir for local smoke test
```

Output: `dist/electron/`.

## Model Cache (Desktop)

Unlike web (IndexedDB), desktop uses filesystem storage under:

```
{userData}/models/
```

The renderer should prefer `vipDesktop.readModelCache()` / `writeModelCache()` over IndexedDB when `window.vipDesktop` is present.

## File I/O Integration (Done)

| Layer | Module | Desktop path |
|-------|--------|--------------|
| Core | `src/core/DesktopBridge.js` | `pickAudioFile()`, `saveExportBlob()` |
| Pipeline | `src/pipeline/FileIngestion.js` | `pickAndIngestFile()` |
| Presentation | `src/presentation/ExportControls.js` | `_deliverBlob()` → native save |
| Landing | `public/landing.js` | Upload zone uses native picker when `isDesktopShell()` |

## Phase 1 Remaining Work

- [x] Wire `FileIngestion` to `vipDesktop.openFile()` in desktop shell
- [x] Wire `ExportOrchestrator` / `ExportControls` to `vipDesktop.saveFile()`
- [ ] Desktop model loader adapter (filesystem-first, IndexedDB fallback)
- [ ] Code signing (Windows Authenticode, Apple notarization)
- [ ] `electron-updater` auto-update channel (GitHub Releases)
- [ ] Live-mode pipeline integration with `QuantumHopBridge`
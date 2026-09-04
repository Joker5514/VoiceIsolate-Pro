# Contributing to VoiceIsolate Pro

Read [`CLAUDE.md`](CLAUDE.md) before changing code. It is the implementation source of truth for architecture, privacy, platform scope, and layering rules.

## Toolchain

- **Node.js:** 22+; CI currently runs Node 24
- **pnpm:** `11.3.0` (declared by `packageManager` and used by CI)
- **Package lock:** `pnpm-lock.yaml` only; do not add `package-lock.json` or a Yarn lockfile

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm sync:src
pnpm dev
```

## Development workflow

1. Branch from current `main`.
2. Keep changes focused and preserve the architecture in `CLAUDE.md`.
3. Search the repository before claiming a capability/file is missing.
4. Add regression coverage for a real bug fix.
5. Run the relevant quality gates before opening or merging a PR.

Baseline gate:

```bash
pnpm ci:check-patches
pnpm version:check
pnpm worklets:verify
pnpm lint
pnpm test:ci
pnpm validate
pnpm check:privacy
pnpm downloads:validate
```

For shared UI/runtime changes, also run the browser/Engineer smoke tests and rebuild affected native packages before claiming a published native artifact contains the change.

## Architecture summary

| Layer | Path | Responsibility |
|---|---|---|
| 1 Core | `src/core/` | Pure DSP/data primitives and contracts |
| 2 Workers | `src/workers/` | Web Workers and approved AudioWorklets |
| 3 Pipeline | `src/pipeline/` | Ingest, analysis/process orchestration, playback, export |
| 4 Presentation | `src/presentation/` | DOM/presentation adapters |

A layer may depend only on layers below it. New feature/business logic belongs in `src/`, not in the legacy `public/app/` implementation surface.

## Non-negotiable product rules

Do not:

- add live microphone ingestion (`getUserMedia` is forbidden)
- send user audio to a server for processing/inference
- re-run ML inference from slider events
- load runtime libraries from third-party CDNs
- hardcode secrets or dev-bypass credentials
- weaken Electron isolation (`contextIsolation`, sandbox, no Node integration)
- enable Android WebView debugging for release builds
- weaken CI to hide failures or reintroduce Jest `--forceExit` in the main suite
- commit generated installers, APKs, `build/`, dependency directories, or foreign lockfiles

`public/app/` remains a shipped compatibility surface; targeted bug/security/parity fixes are allowed, but new architecture belongs in the four-layer `src/` system.

## Shared product surfaces

| Route | Source | Purpose |
|---|---|---|
| `/` | `public/index.html` + shared `src` presentation/pipeline modules | Landing / standard workflow |
| `/app/` | `public/app/index.html` + shared Engineer bridge/modules | Engineer Console |
| `/download/` | `public/download/index.html` | Current release downloads |

Web, Android, and Electron consume the same product shell when rebuilt from the same source. Do not claim published native packages are synchronized with current Web/`main` unless `docs/releases/release-provenance.json` proves it.

## Upload behavior

The product is upload-only. Browse controls, drop zones, and native file pickers must remain compatible with audio/video file selection. Avoid positioning file inputs far off-screen; browser file-picker behavior can reject synthetic clicks on hidden/off-viewport inputs.

## Worklets and models

- Worklet packaging is governed by `scripts/worklet-manifest.json` and `pnpm worklets:verify`.
- Runtime/model integrity is governed by the model manifest and validation scripts.
- Do not commit large optional model binaries simply to make a local build pass.
- Keep local-processing/privacy guarantees intact when changing model delivery.

## UI changes

Preserve public IDs/data bindings used by tests and adapters. The shared design-system semantic tokens live in `public/app/ds-tokens.css`; surface-specific styles may extend presentation but must not redefine process/live/status semantics inconsistently.

For UI changes, include desktop and mobile smoke coverage where practical and respect reduced-motion/coarse-pointer behavior.

## Release/download changes

Current release truth is documented in:

- [`docs/DOWNLOADS.md`](docs/DOWNLOADS.md)
- [`docs/releases/PLATFORM_SYNC.md`](docs/releases/PLATFORM_SYNC.md)
- [`docs/releases/release-provenance.json`](docs/releases/release-provenance.json)

When changing release assets or download URLs:

```bash
pnpm downloads:validate
pnpm provenance:validate
```

Use strict provenance validation only when every supported published surface has current, independently verified provenance:

```bash
pnpm provenance:validate:strict
```

Do not edit dated audits or historical release PDFs merely to make them look current; add newer evidence instead.

## Documentation map

See [`docs/README.md`](docs/README.md). Current implementation docs are separate from `docs/audits/`, `docs/archive/`, old release PDFs, and `LEGACY.md`.

## Debug logging

Append `?debug=1` or set `localStorage.vip_debug = '1'` for gated `[VIP]` diagnostics where supported.

## Security reports

Do not publish secrets or sensitive security details in a public issue. Use the repository's documented maintainer/security contact path for private reports.

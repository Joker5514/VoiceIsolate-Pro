# Contributing to VoiceIsolate Pro

Thank you for your interest in contributing. This project enforces a strict
four-layer architecture — read [`CLAUDE.md`](CLAUDE.md) before opening a PR.

## Prerequisites

- **Node.js** ≥ 22
- **pnpm** ≥ 10 (npm/yarn lockfiles are not used)

```bash
pnpm install
pnpm sync:src    # copies src/ → public/src/ for local /src/ imports
pnpm dev         # http://localhost:3000
```

## Development workflow

1. Create a feature branch from `main`.
2. Make focused changes — one concern per commit.
3. Run the full validation gate before pushing:

```bash
pnpm validate           # structural integrity (required)
pnpm worklets:verify    # AudioWorklet packaging
pnpm lint               # ESLint
pnpm test               # Jest (2150+ tests)
```

4. Open a PR with a clear summary, test results, and screenshots for UI changes.

## Architecture rules (summary)

| Layer | Path | Responsibility |
|-------|------|----------------|
| 1 Core | `src/core/` | Pure DSP primitives, constants, manifests |
| 2 Workers | `src/workers/` | Web Workers & AudioWorklets |
| 3 Pipeline | `src/pipeline/` | Orchestration (ingest → infer → mix → export) |
| 4 Presentation | `src/presentation/` | DOM bindings only |

**Do not:**
- Add live-microphone ingestion
- Load libraries from CDNs
- Put business logic in `public/app/` (Engineer Mode is maintenance-frozen)
- Commit large ONNX models (use Vercel Blob — see `docs/guides/MODEL_DELIVERY.md`)

## Documentation map

| Topic | Doc |
|-------|-----|
| Full index | [`docs/README.md`](docs/README.md) |
| Architecture | [`docs/architecture/`](docs/architecture/) |
| How-tos (Android, worklets, desktop, analysis) | [`docs/guides/`](docs/guides/) |
| Downloads | [`docs/DOWNLOADS.md`](docs/DOWNLOADS.md) |
| Historical only | [`docs/archive/`](docs/archive/) |

## Pages

| URL | File | Notes |
|-----|------|-------|
| `/` | `public/index.html` | Landing — Stem-Split (ML separation, upload-only) |
| `/app/` | `public/app/index.html` | Engineer Mode v24 — 67-slider DSP + visualization suite |

Upload wiring is shared via `src/presentation/UploadWiring.js` (imported by `public/landing.js` and `public/app/app.js`). Browse buttons use `<label for="fileInput">`; do not position file inputs off-screen (`left:-9999px`) — Chromium 120+ blocks the native picker.

## Debug logging

Append `?debug=1` to the URL or set `localStorage.vip_debug = '1'` to enable
gated `[VIP]` console output in pipeline modules.

## Questions

Open a GitHub issue with the **bug** or **feature** template. For security
concerns, do not file public issues — contact the maintainer directly.
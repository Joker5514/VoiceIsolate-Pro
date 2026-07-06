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
- Commit large ONNX models (use Vercel Blob — see `docs/MODEL_DELIVERY.md`)

## Pages

| URL | File | Notes |
|-----|------|-------|
| `/` | `public/index.html` | Landing — Stem-Split & Live-Mix (canonical `src/`) |
| `/app/` | `public/app/index.html` | Engineer Mode — classical DSP + visualization suite |

## Debug logging

Append `?debug=1` to the URL or set `localStorage.vip_debug = '1'` to enable
gated `[VIP]` console output in pipeline modules.

## Questions

Open a GitHub issue with the **bug** or **feature** template. For security
concerns, do not file public issues — contact the maintainer directly.
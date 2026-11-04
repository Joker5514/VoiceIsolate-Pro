# Verification state (VIP-037 refresh, 2026-11-04)

This document is the refresh that VIP-037 asks for. It does NOT
rewrite the published-release record: `releases/PLATFORM_SYNC.md`
and `DOWNLOADS.md` describe the published `v25.0.3` artifacts
(2026-09-09), which have not changed, and their "not synchronized"
verdict stands. What follows is the **current verification state**
— what has been measured, on which branch, and what is still
unverified — so nobody mistakes PR-branch evidence for a release.

## Published vs verified (do not conflate)

| Surface | Published release | PR #888 branch verification (2026-11-04) |
|---|---|---|
| Web | `voice-isolate-pro.vercel.app` serving an older build | Fresh `build/` verified + provenance sidecar at commit `937e9626`; browser tier 11/11 in Chromium |
| Android | `v25.0.3` APK (2026-09-09, predates current source) | No APK built here (no Android SDK in this environment) |
| Windows | `v25.0.2` EXE on the `v25.0.3` tag | No EXE built here (no packaging in this environment) |
| iOS | Outside v1.0 scope, no artifact | Unchanged |
| CI | Blocked (account billing lock, VIP-001) | Local equivalents run instead; CI still blocked |

## Platform matrix (current)

The full matrix lives in `PLATFORM_CAPABILITY_MATRIX.md` (updated
this round with the ECAPA row). Summary: one shared shell
(`public/app/` + `src/`) across web, Capacitor Android, and
Electron Windows; no live-mic ingestion on any platform by
design; all processing on-device; cloud audio/vision inference
forbidden. Firefox/WebKit were not run in this environment
(Chromium only); Android browsers use the website; the APK and
EXE match the website only when built from the same commit, which
is not proven for the published artifacts.

## Model availability (current)

| Model | Status | Evidence |
|---|---|---|
| `bsrnn_vocals` (landing/engineer/maximum chains) | Shipped, SHA-verified on load | `ModelManifest.js`, corpus eval |
| `rnnoise` (maximum chain) | Shipped | Corpus eval (fricative regression noted) |
| `deepfilternet3` (enhance chain) | Shipped, product-gated by EnhanceGuard | Corpus eval (dominates single-speaker, near-mutes overlap) |
| `ecapa_tdnn` (speaker embedding) | **Optional, not shipped in the repo** (git-ignored); fetch via `pnpm models:fetch-ecapa`, SHA-verified | Fetched + measured this round (same 0.669 vs cross median 0.085); absent → `unavailable`, mel fallback |
| SCNet / BS-RoFormer / AudioSep / CLAP | Not available; research only | `DEFERRED_MODELS.md` (no artifact, no license clearance, no adapter) |

## Privacy behavior (current evidence)

- No audio egress: `privacy-runtime` smoke (recording proxy in
  real Chromium) proves the app only GET/HEADs own-origin static
  assets.
- CSP: strict on the landing path, scoped legacy exception for
  `/app`, `/blueprint`, `/docs`; verified by the `csp-runtime`
  smoke (inline blocked, blob worker allowed, third-party
  connect refused). Vercel production CSP is deliberately
  extended (Firebase/Blob/Drive/RevenueCat) and statically pinned,
  not served locally.
- Embeddings are voice biometrics: on-device only, enrollment
  explicit/user-initiated (`SPEAKER_FUSION.md`).

## Limits (where they live)

- Long files / tiers: `LONG_FILE_LIMITS.md` (HIGH 8 GB / 3 GB
  decoded, BALANCED 2 GB / 768 MB, CONSTRAINED 512 MB / 192 MB;
  refusal, never truncation).
- Quality bars: `CORPUS_THRESHOLDS.md` (written before the eval;
  no chain meets all bars, none selected).
- Diarization: energy clusterer, not speaker ID (50% false-split;
  `SPEAKER_FUSION.md` for the fusion plan).
- Overlap: no chain meets the bars; nothing integrated
  (`OVERLAP_SEPARATION.md`).

## Troubleshooting (known issues, current)

- **PR head field lags the branch ref** (hours): trust the
  git/ref endpoint, never re-push to "fix" it.
- **`e2e-quick-clean` flaky**: failed once on its final
  full-page screenshot with no product change; passes on rerun.
  Treat as environment-flaky, not fixed.
- **`mlworker-deepfilternet` 5 s timeout under parallel load**:
  passes standalone (~3.2 s). Timeout not raised; disclosed.
- **ECAPA 404 in console** (`/app/models/ecapa_tdnn.onnx`):
  by design — the model is optional and git-ignored; the app
  falls back to mel.
- **Actions jobs finish in ~2 s with 0 steps**: account billing
  lock (VIP-001), not a code defect. Owner resolves billing.
- **A sidecar verifies only its own artifact**: regenerating a
  sidecar after tampering would verify too — keep sidecars in CI
  artifacts / release attachments, not only beside the build
  (`RELEASE_PROVENANCE.md`).

## Release instructions (where they live)

- Owner actions (billing, signing secrets, store steps):
  `releases/RELEASE_RUNBOOK.md`.
- Published-vs-source truth: `releases/PLATFORM_SYNC.md` +
  `releases/release-provenance.json` (strict validator:
  `pnpm provenance:validate:strict`).
- Per-artifact provenance: `RELEASE_PROVENANCE.md` + the
  `scripts/provenance/` generator/verifier.
- A release may be called synchronized only when the five
  conditions in `PLATFORM_SYNC.md` hold (same SHA, recorded
  artifacts, matching digests, web deployment evidence, strict
  validation passing). Nothing in this round changes that gate.

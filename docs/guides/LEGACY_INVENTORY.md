# Legacy inventory (VIP-035)

Rule from the issue, kept literally: **remove only after usage
mapping, migration coverage, and regression tests.** This document
is the usage mapping. Nothing in it is removed by this round except
the harness dedup in `diarization-eval.cjs` (VIP-036), which had
its own regression proof (byte-identical rerun report).

## Dual implementations (both live — do not delete either blindly)

| Area | Implementation A | Implementation B | Evidence / status |
|---|---|---|---|
| Separation worker | `src/workers/MLWorker.js` (current; used by the corpus/stress harnesses and the Engineer path) | `public/app/ml-worker.js` (legacy realtime/SAB worker; owns `runDiarization`) | Both imported by live paths. The diarization eval deliberately runs the LEGACY worker's `runDiarization` because that is what ships. Unifying diarization onto one worker is a migration project, not a deletion. |
| Diarization core | `public/app/ml-worker.js` `runDiarization` (3 features, forced k) | `src/core/diarization.js` (`diarizeChannel`, imported by `src/pipeline/SpeakerDetection.js` and `src/workers/DiarizationWorker.js`) | Two diarization implementations with different callers. Which one the UI surfaces must be pinned before either is touched. |
| Speaker embedding | `src/workers/SpeakerEmbeddingWorker.js` (ECAPA, optional) | `src/core/TargetSpeaker.js` `extractLocalVoiceprint` (mel fallback, always available) | By design (fallback ladder, `SPEAKER_FUSION.md`), not duplication to remove. |
| Export provenance | `src/core/Provenance.js` (per-file sidecars) | `scripts/provenance/*` (per-artifact sidecars) | Different layers (`RELEASE_PROVENANCE.md`), not duplicates. |

## Unwired / candidate components

| Component | Usage evidence | Recommendation |
|---|---|---|
| `src/ui/components/RegionActionPalette/RegionActionPalette.js` | No runtime import from app code; referenced only in comments and in `tests/premium-store-contract.test.js` (path → store mapping). The Engineer palette in the shipped shell is DOM-based (`premium-workspace.js`). | Keep. Removal needs a product decision (is the component UI the future?) + the contract test updated in the same commit. Recorded here so the decision is visible. |
| `src/ui/components/*` (other components) | Only design tokens are imported at runtime (`ui/tokens/design-tokens.js` from `audioSessionStore.js`, `ProcessingController.js`, `premium-workspace.js`). | Same treatment as above: the component tree is scaffolding for a UI that has not shipped. Inventory, don't bulk-delete. |
| Legacy CSP exception | `server/securityHeaders.js` `allowLegacyInline` for `/app`, `/blueprint`, `/docs` | Scoped and tested (`csp-runtime` smoke). Removal needs the legacy inline usages eliminated first; the smoke test pins the current behavior. |

## The unused-export scan that must NOT drive deletions

A mechanical scan of `src/` exports vs mentions in `src/` +
`public/app/` + `tests/` reported 134 "unused" names. Spot-checking
the top hits showed the scan is misleading: every sampled name is
used inside its own module (module-internal constants like
`ABSOLUTE_MAX_FILE_BYTES`, `MAX_PRESET_NAME`), or imported by
scripts/tests the scan's mention rule mishandled, or used via
`export *` chains. **Do not bulk-remove on this scan.** A removal
candidate needs a repo-wide grep (including `scripts/`,
`server/`, `electron/`) plus its test references, one item at a
time.

## Dependencies

`package.json` / `pnpm-lock.yaml` are byte-identical between `main`
and this branch (verified in the Phase 0 baseline). No dependency
was added by this round's work. A dependency-pruning pass needs a
real import-graph tool (e.g. depcheck-style analysis) and is out
of scope for this inventory; the lockfile is the binding that
`RELEASE_PROVENANCE.md` records, so pruning must re-verify it.

## What removal requires (checklist per item)

1. Repo-wide usage grep + test references listed.
2. Migration coverage: the replacement path exists and is wired.
3. Regression tests: full jest green + the affected browser smoke
   passing before and after.
4. The removal and its evidence land in the same commit message.

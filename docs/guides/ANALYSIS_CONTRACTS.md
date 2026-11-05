# VIP-032 — Analysis contracts and paths

One map of every analysis entry point in VoiceIsolate-Pro, which
canonical contract they all produce, and the paths that are
intentionally retained rather than removed. This document is the
deliverable for VIP-032 boxes 1, 2, and 4; the routing regression test
(`tests/vip032-analysis-routing.test.js`) pins the map to the code.

## The canonical contract (authority: CLAUDE.md §2.2)

Per the repo's house rule (AGENTS.md), the contract itself lives in
exactly one place: **CLAUDE.md §2.2, "Intelligence boundary contracts"**,
enforced at runtime by `validateAnalysisSnapshot()` in
`src/core/IntelligenceContracts.js`. In brief: the result type is
`AnalysisSnapshot` (identity, input, version pins, per-capability
status, measurements, detected sources, evidence regions with
per-region certainty and a `responsible` analyzer pin, warnings,
unsupported analyses, freshness); the coordinator cache identity is
`contentFingerprint` + `analysisVersion` + `analyzerVersions` +
`modelVersions` + `configuration` + `runtime`; cancellation and failure
are outcomes (`CANCELLED` / `STALE` / `FAILED`, plus the host's
`CancellationError`), never fabricated snapshots. A producer that cannot
build a contract-valid snapshot fails loudly; the Analysis workspace
logs adaptation failures as warnings and keeps the raw analysis for
rendering — it never stores a malformed snapshot. The field-level
definition is the validator itself; this guide does not restate it.

## Entry points and routing

There are two engines. They differ in depth and cost, not in result
contract — both end at a validated `AnalysisSnapshot`.

### Engine A — AutoAnalysis (quick, shared)

- **Producer:** `runAutoAnalysis()` in `src/core/audio/analysis/AutoAnalysis.js`.
- **Only caller:** `AnalysisCoordinator` (`getSharedAutoAnalysisCoordinator()`).
  No production code calls `runAutoAnalysis()` directly — the routing test
  enforces this allowlist.
- **Adapter:** `adaptAutoAnalysisToSnapshot()` → validates.
- **Coordinator guarantees:** in-flight dedupe, fingerprint-keyed cache
  (max 8 entries), per-caller abort, stale suppression, validation on
  every result (fresh and cached paths both validate).
- **Projection:** `snapshotToOverlayModel()` — the Engineer overlay model
  (`result.snapshot` is the validated snapshot).
- **Consumers:** Engineer auto-analysis on import
  (`premium-workspace.js` → `runCoordinatedAutoAnalysis()`), Landing
  Quick Clean / Engineer Signal Canvas (same coordinated call — concurrent
  Landing + Engineer calls for the same audio share one pass; covered by
  `tests/vip032-unified-analysis-snapshot.test.js`).

### Engine B — FullAnalysis (deep, per-workspace)

- **Producer:** `analyzeAudioCooperative()` in `src/core/FullAnalysis.js`.
- **Only callers:** `FullAnalysisHost` (main-thread cooperative path) and
  `FullAnalysisWorker` (off-main-thread path). No other production caller.
- **Host:** `src/pipeline/FullAnalysisHost.js` — worker offload for clips
  ≥ 10 s (feature extraction only), cooperative cancel, generation-based
  staleness, progress reporting. VAD hints come from `VadAnalysis`
  (`buildVadHints`); the WhisperHunter environment fuse
  (`AnalyzerWhisperBridge` / `collaborateWithHunter`) runs on the raw
  result *before* adaptation.
- **Adapter:** `adaptFullAnalysisToSnapshot()` → validates.
- **Consumers:**
  - Analysis workspace (`public/app/lib/analysis-workspace.js`): host →
    Hunter fuse → adapter → `app._lastAnalysisSnapshot` and
    `analysis.snapshot`. The workspace keeps the raw FullAnalysis result
    alongside the snapshot for audition/timeline rendering (see retained
    paths below). Its own source-generation and abort guards make a
    superseded analysis return `null` instead of a stale snapshot.
  - Landing insights (`src/presentation/AnalysisInsightsUI.js`, used by
    `public/landing.js` after stems): wraps the host + adapter in its own
    `AnalysisCoordinator`, so Landing's deep analysis gets the same
    dedupe/cache/cancel/validation as the quick path.
- **Internal data, not a separate contract:** speaker segments
  (`speakerSegments` in the FullAnalysis output), VAD hints, and Hunter
  classifications are inputs to the adapter, not results consumed
  elsewhere. Diarization rendering reads the FullAnalysis result through
  the workspace, not a third result type.

### What consumes snapshots (not producers)

- Engineer overlay (`snapshotToOverlayModel`), region palette actions,
  and EnhanceGuard (`analysisResult.snapshot || analysisResult` — the
  snapshot form is required before `applyEnhanceGuard()`).
- Forensic provenance (`recordOperation` notes evidence-region count and
  snapshot freshness).
- Stem-Split and Live-Mix do **not** run analysis: they consume the
  snapshot only through EnhanceGuard gating of model choice. There is no
  Stem-Split/Live-Mix analysis path to unify.

## Duplicate audit (VIP-032 box 4)

Searched all production sources for direct analysis producers:

- `runAutoAnalysis(` — one production caller: the coordinator. No bypass.
- `analyzeAudioCooperative(` — two production callers: the host and its
  worker. No bypass.
- `new FullAnalysisHost` — Analysis workspace + AnalysisInsightsUI, both
  adapting to the canonical snapshot. No raw-result consumer outside the
  workspace's own rendering.
- `validateAnalysisSnapshot` — called by both adapters and by the
  coordinator on every result. No production path emits an unvalidated
  snapshot.

**Nothing was removed in this round because no duplicate path exists to
remove.** The unification VIP-032 asks for is already the architecture;
this document and the routing test are what was missing (the map, the
contract statement, and the regression pin).

## Intentionally retained paths (not duplicates)

1. **Two engines, one contract.** AutoAnalysis (quick/shared) and
   FullAnalysis (deep/per-source) are different cost/depth trade-offs
   feeding the same validated snapshot type. Merging them would either
   slow every import or weaken deep analysis.
2. **FullAnalysisHost is not routed through the shared coordinator in
   the Analysis workspace.** The workspace needs per-source generation
   guards, progress reporting, and job tracking that the shared quick
   cache does not provide; its result is still a validated snapshot.
   (Landing's insights UI *does* wrap the host in a coordinator.)
3. **Raw FullAnalysis result retained beside the snapshot in the
   workspace.** Audition layers and the timeline render from the raw
   result's detailed fields; cross-surface exchange (provenance, overlay,
   EnhanceGuard) uses the snapshot. If the two ever disagree, the
   snapshot is the contract and the raw result is workspace-local.
4. **Adapters are the compatibility layer, not legacy cruft.**
   `adaptAutoAnalysisToSnapshot` and `adaptFullAnalysisToSnapshot`
   exist so two engines with different native outputs can both satisfy
   one contract. They validate on exit; a future engine adds a third
   adapter, not a third result type.

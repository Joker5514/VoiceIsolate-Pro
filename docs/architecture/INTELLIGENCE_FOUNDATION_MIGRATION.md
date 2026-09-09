# Intelligence foundation migration (PR 1)

## Baseline and scope

The working checkout baseline is `5b40ead78c4e72afad4ea7954227e6044b28647d`.
The environment could not fetch GitHub (`CONNECT tunnel failed, response 403`),
so this SHA is **not represented as a freshly verified `origin/main` SHA**. This
is an explicit merge blocker: compare the branch with live `origin/main` before
merging. PR 1 intentionally makes no workspace route, styling, packaging,
release, billing, or deployment change.

## Architecture and inventory

The repository enforces `core → workers → pipeline → presentation` in
`CLAUDE.md` sections 1–2. Canonical parameter ranges and Live-Mix versus
process-time grouping are in `src/core/ParameterSchema.js`; the legacy control
registry remains `public/app/slider-map.js`. The current explicit analysis path
is `src/pipeline/FullAnalysisHost.js` → `src/workers/FullAnalysisWorker.js` →
`src/core/FullAnalysis.js`. The canonical offline inference worker is
`src/workers/MLWorker.js`; `public/app/ml-worker.js` remains compatibility-only.
The sole model registry is `src/core/ModelManifest.js`, with local ONNX assets in
`public/app/models/` and integrity verification in `src/workers/MLWorker.js`.

The shipped, pinned models declared by that registry are BSRNN vocals, RNNoise,
Silero VAD, and quantized Silero VAD. Optional manifest entries are not treated
as ready. WebGPU and local WASM are the declared advanced runtimes; compatible
classical DSP remains the fallback. No model metadata or loading path is
duplicated by this increment.

The working UI exposes 67 registered controls through
`public/app/slider-map.js`; immutable process snapshots are validated by
`src/core/ParameterSchema.js`. The offline spectral frame loop is in
`src/workers/MLWorker.js`, and the legacy deterministic fallback is in
`public/app/app.js`. This increment neither adds a spectral transform nor
changes either path.

## Findings and migration decisions

`src/core/RecommendationEngine.js` currently emits preset-oriented data and can
name optional Demucs in a model chain even when it is unshipped. That legacy
contract is retained for compatibility but is not used by the new bounded
contract. `src/core/IntelligenceRecommendation.js` only selects known
`ParameterSchema` controls, only from supported evidence, and never chooses a
model or executes DSP. Unsupported goals, absent evidence, and stale analysis
produce no executable plan rather than placeholder metrics or sources.

`src/core/IntelligenceContracts.js` is the canonical validation boundary for
AnalysisSnapshot, EvidenceRegion, Recommendation, ProcessingPlan, and
EvaluationReport. Quick, Studio, and Forensic will consume the same validated
objects. Workspace navigation must not trigger analysis; all three views will
call one session-owned `AnalysisCoordinator` and select/filter its snapshot.

`src/pipeline/AnalysisCoordinator.js` supplies deterministic compatibility
keys, in-flight request deduplication, bounded metadata/result caching,
invalidation, cancellation forwarding, and generation-based stale-result
suppression. Cache identity includes content fingerprint, analysis/analyzer and
model versions, configuration, and runtime. It stores no audio. A future
durable adapter may persist only validated metadata after a separate privacy
review; this PR uses a bounded in-memory cache.

`src/pipeline/ProcessingPlanBridge.js` maps validated operations back to the
existing control state. Accepting a plan therefore changes the established
process-time control snapshot; it does not establish a recommendation-only DSP
path. Presentation integration is deferred to PRs 2 and 3.

## Control migration map

| Goal | Evidence required | Existing controls populated | Engine path |
| --- | --- | --- | --- |
| Isolate spoken voice | speech, music bleed, or background noise | `voiceIso`, `bgSuppress` | existing control snapshot |
| Reduce background noise | background/stationary noise or hum | `nrAmount`, `nrFloor` | existing process-time spectral phase |
| Improve dialogue clarity | speech, low clarity, or bandwidth limit | `eqPresence`, `deEssAmt` | existing controls/worklet path |

User overrides win, values are clamped through `ParameterSchema`, and current
unmentioned controls are preserved by the bridge.

## Verification and baseline

Before edits, `pnpm test -- --runInBand` was started against the checkout.
Production bundle, browser startup, fixture analysis/process duration, peak
memory, render-loop work, and desktop/tablet/mobile screenshots could not be
honestly measured within the non-browser baseline run and are recorded as **not
measured**, not zero. PR 1 has no visual change, so baseline screenshots are not
used as evidence of completion. Browser workflow and performance acceptance
remain mandatory before merge/deployment.

Tests added cover validators, plan immutability, deterministic selection,
evidence traceability, overrides, stale/unsupported/no-material-problem states,
deduplication, cache hits, invalidation, and existing-control mapping. Existing
privacy, model-integrity, structural validation, lint, and full Jest suites are
the required regression checks.

## Deferred and unavailable

UI bindings, Quick workflow, Forensic region UI, durable cache, EvaluationReport
measurement production, audit history, and visual/accessibility regression work
belong to later PRs. Demucs, ECAPA, transcription, speaker identity, and any
other unshipped detector remain unsupported. This increment adds no microphone,
network inference, telemetry, CDN dependency, audio upload, or slider-triggered
inference.

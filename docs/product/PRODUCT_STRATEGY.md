# VoiceIsolate Pro — Product Strategy and MVP Plan

**Status:** Recommended product direction  
**Audience:** Product, design, engineering, security, and go-to-market  
**Decision horizon:** MVP through the first scalable commercial release

This document turns the existing VoiceIsolate Pro implementation into a focused
product proposition. It does not replace the engineering contract in
[`CLAUDE.md`](../../CLAUDE.md) or the architecture blueprint. Where this plan and
those documents differ, `CLAUDE.md` remains authoritative.

## 1. Improved version of the idea

### Product statement

**VoiceIsolate Pro is a privacy-first desktop-quality voice cleanup studio that
turns noisy audio or video into clear, export-ready speech without uploading the
recording.** A user drops a file, chooses the voice outcome they want, previews
the separated voice and background in real time, and exports a clean mix or
stems. Advanced users can open the same project in an Engineer Console for
forensic inspection and precise DSP control.

### Primary customer and job

Start with one beachhead: **independent creators and audio professionals who
regularly rescue spoken-word recordings**—podcasters, video editors,
journalists, and field recordists. Their core job is not “operate 67 controls”;
it is “make this difficult recording understandable and publishable, privately,
in a few minutes.”

### Product promise

1. **Private by design:** audio inference stays on the device.
2. **Fast path to a useful result:** Import → Clean → Compare → Export.
3. **Trustworthy control:** hear the original and processed result at matched
   loudness, inspect likely artifacts, and undo any choice.
4. **Depth on demand:** a simple default workspace, with the existing Engineer
   Console available rather than removed or forked.
5. **One product across platforms:** the shared web application is packaged for
   web, Android, and Electron; platform shells add capabilities, not divergent
   interfaces.

### Core workflow

1. **Import:** Drop or browse for one audio/video file. Show format, duration,
   estimated memory, and whether the device can run the best available model.
2. **Choose an outcome:** `Clean speech` (default), `Maximum isolation`, or
   `Preserve ambience`. Explain speed and artifact trade-offs in one sentence.
3. **Process:** Decode and run local inference once, with stage progress, an
   honest time estimate, cancellation, and a lower-quality fallback when the
   preferred model cannot run.
4. **Review:** Start with a level-matched A/B control, then expose Voice and
   Background mix controls. Highlight clipping, silence, and suspected artifact
   regions without pretending to know transcript content.
5. **Refine:** Offer three high-value macros—Voice clarity, Background, and Room
   reduction. “Advanced controls” opens the full Engineer Console using the same
   project and stems.
6. **Export:** Export clean mix by default; optionally export separate stems.
   Confirm format, quality, file size estimate, destination, and privacy state.

### Positioning

The competitive wedge is the combination of **local-only processing, immediate
post-separation Live-Mix, reproducible offline projects, and an expert escape
hatch**. Do not compete by claiming the largest number of stages or controls.
Compete on verifiable privacy, recovery quality on difficult speech, predictable
performance, and the shortest path from damaged recording to usable deliverable.

## 2. Key problems identified

### Product clarity

- **The idea is only a name.** It does not specify a customer, painful job,
  desired output, purchasing trigger, or why the product wins.
- **Feature quantity obscures value.** Terms such as “Octa-Pass,” numerous model
  names, and 67 controls can signal power to experts but increase uncertainty
  for the primary workflow.
- **Two surfaces can feel like two products.** Landing and Engineer experiences
  need an explicit relationship: Quick Clean is the default workspace;
  Engineer is a progressive-disclosure workspace over the same project.
- **Quality claims need evidence.** “Best-in-class” is not credible without a
  named evaluation corpus, blind listening methodology, performance envelope,
  and published failure modes.
- **Scope is broad.** Web, desktop, Android, advanced analysis, speaker focus,
  cloud-drive I/O, multiple models, and broad export support create too many MVP
  dependencies.

### User experience

- The first decision should be an outcome, not a model or a large control rack.
- Users need a reliable A/B comparison. Louder output can be perceived as
  “better,” so comparisons must be level-matched.
- Processing confidence is weakened without time estimates, cancellation,
  device capability feedback, and a clear explanation of fallbacks.
- “Analyze” and “Process” can appear redundant. Analysis should either improve
  the chosen outcome automatically or be an advanced, optional inspection step.
- Export is the completion event and should not be buried among engineering
  controls.

### Architecture and operations

- Large local models, decoded PCM, stems, analysis data, and export buffers can
  exceed browser memory or storage quotas, particularly on mobile.
- WebGPU/ONNX/browser behavior varies; every model chain needs a deterministic
  WASM or classical fallback and an explicit quality label.
- A shared UI reduces duplication but platform capability differences can leak
  into confusing disabled controls without a centralized capability policy.
- Model and application releases can drift. Compatibility, integrity,
  provenance, cache migration, and rollback must be treated as one release unit.
- A 67-control contract creates a wide regression surface. Controls require
  schema-based ownership, ranges, defaults, timing classification, and automated
  consumer tests.

### Security and commercial readiness

- “Local processing” is both a promise and a security boundary. Analytics,
  crash reporting, Drive integration, licensing, and future assistants must
  never gain access to audio bytes by accident.
- Browser storage contains sensitive derived media. Users need retention
  controls, a clear-data action, and documented deletion semantics.
- In-memory license and webhook state is not production-grade across serverless
  instances. Durable entitlement storage and durable Stripe event idempotency
  are launch requirements for paid plans.
- A ChatGPT app is not an MVP distribution shortcut: sending recordings to a
  remote app would conflict with the local-processing promise. A future app may
  provide education, setup, or project metadata actions only after a separate
  privacy and platform-policy review.

## 3. Recommended improvements

### Required before calling the product commercially ready

| Area | Improvement | Why it is required |
|---|---|---|
| Positioning | Choose spoken-word rescue as the initial segment and use one outcome-led value proposition | Makes acquisition, onboarding, and evaluation coherent |
| Navigation | Make Quick Clean the default and Engineer an advanced view of the same project | Preserves expert power without imposing complexity |
| Workflow | Implement Import → outcome → Process → level-matched A/B → Export as the dominant path | Optimizes time-to-value |
| Capability | Run a preflight for memory, model availability, execution provider, and estimated runtime | Avoids late failures and misleading progress |
| Reliability | Preserve explicit Process semantics, cancellation, immutable config snapshots, and cache revisioning | Prevents accidental expensive recomputation |
| Quality | Establish a versioned evaluation corpus and listening rubric; publish measured results rather than superlatives | Makes claims defensible |
| Privacy | Enforce a no-audio-egress test, local-data inventory, retention controls, and auditable Drive boundaries | Protects the core promise |
| Billing | Replace process-local license and webhook state with durable storage and atomic idempotency before paid launch | Prevents entitlement loss and duplicate fulfillment |
| Accessibility | Keyboard-complete transport, visible focus, semantic progress, screen-reader labels, reduced motion, and non-color-only safety states | Necessary product quality, not polish |
| Operations | Couple app/model manifests, compatibility versions, integrity hashes, staged rollout, and rollback | Reduces broken releases |

### Optional after product-market evidence

- Batch queues and watch folders for production teams.
- Reusable project packs with non-destructive settings and derived-stem cache.
- Team presets and review links that share settings/metadata but not source audio.
- Local transcript generation, only if it can preserve the no-audio-egress
  boundary and its accuracy is represented honestly.
- Additional specialist models selected by measured improvement on target
  recordings, not by model novelty.
- macOS/Linux release artifacts after Windows and Android reliability targets
  are consistently met.
- A metadata-only ChatGPT companion, marketplace submission, or assistant after
  policy review; it must not become a hidden cloud processing path.

### Deliberately avoid

- Restoring microphone capture or presenting the product as live call cleanup.
- Auto-running inference when a slider moves.
- Forking platform-specific copies of the Engineer interface.
- Downloading executable scripts from third-party CDNs.
- Advertising unshipped models or planned stages as current functionality.
- Gating local DSP solely in client code and treating it as secure licensing.

## 4. Simplest strong MVP

### MVP customer promise

“Drop one spoken-word recording and export a clearer version locally, with a
trustworthy before/after preview.”

### Include

- One file at a time; audio plus the most reliable video container inputs.
- One shipped default voice-isolation model with one deterministic fallback.
- Three outcome presets: Clean speech, Maximum isolation, Preserve ambience.
- Explicit Process, accurate stage progress, cancel, and retry.
- Original/Processed level-matched A/B.
- Voice and Background Live-Mix controls plus output safety indication.
- WAV export first; one compressed export format only if already stable.
- Local model integrity verification and cache management.
- Clear Local Data, privacy explanation, and offline/no-audio-egress validation.
- Quick Clean and Engineer views backed by one project state and shared shell.
- Web and Windows Electron as launch targets; retain Android builds but do not
  let Android edge cases delay validation of the primary desktop workflow.

### Defer

- Batch processing, team collaboration, Drive I/O, vision segmentation,
  multi-speaker focus, a large preset catalog, additional platforms, and new
  heavyweight models.
- The full analysis workspace in the default flow. Keep it accessible to
  advanced users, but do not require it before processing.
- Subscription complexity until repeat usage is proven. Start with a free
  evaluation and a simple paid Pro entitlement rather than multiple ambiguous
  tiers.

### MVP interaction budget

- A new user can reach Process in **two decisions after file selection**.
- The primary screen has **one primary action** at each stage.
- A successful first export requires **no Engineer control changes**.
- Every unavailable feature explains whether the cause is file, device, model,
  platform, or plan.

## 5. Recommended technical approach

### System shape

Retain the current Stem-Split & Live-Mix architecture and four-layer module
boundary:

1. **Core:** pure audio configuration, DSP primitives, model metadata, project
   schema, and validation.
2. **Workers:** decoding/inference/analysis/encoding work that must not block the
   renderer. Worker messages use versioned, validated envelopes.
3. **Pipeline:** ingestion, capability preflight, immutable Process job,
   cancellation, stem cache, playback mixer, and export orchestration.
4. **Presentation:** Quick Clean and Engineer projections of the same pipeline
   state. No inference or entitlement decisions originate here.

The Process job should be a finite state machine:

`idle → preflight → decoding → separating → post-processing → ready`

with terminal `failed` and `cancelled` states. Each transition carries a job ID,
stage progress, recoverability, and a stable error code. Late worker messages
from cancelled or replaced jobs are ignored.

### Project and cache model

Use a versioned local project record containing source fingerprint and metadata,
processing-config revision, model-manifest revision, user mix settings, analysis
summary, and references to derived artifacts. Never store object URLs as durable
references. Cache keys should include source hash + processing revision + model
revision + platform-relevant algorithm version.

Adopt explicit storage budgets:

- Estimate decoded and derived memory before Process.
- Stream or chunk long inputs instead of retaining redundant full-file copies.
- Keep raw model stems immutable; apply Live-Mix non-destructively.
- Use LRU eviction for derived artifacts, never silent source deletion.
- Provide per-project deletion and Clear Local Data with confirmation and a
  post-condition check.

### Performance

- Keep inference and encoding off the renderer; cooperatively yield during any
  unavoidable renderer-side post-processing.
- Prefer transferable buffers and typed-array views; define buffer ownership to
  prevent accidental copies or use-after-transfer.
- Load the default model lazily after capability preflight, verify it before
  session creation, and warm only the execution path the user selected.
- Report real measured progress where possible; label heuristic progress as an
  estimate.
- Set device-tier envelopes for maximum duration/resolution and offer a safe
  downmix or chunked mode before allocation failure.

### Security and privacy

- Maintain strict CSP, cross-origin isolation, denied microphone permissions,
  local vendoring, model hash verification, and Electron sandbox boundaries.
- Implement automated egress tests that fail when audio/video blobs, PCM,
  features capable of reconstructing speech, or stems reach `fetch`, XHR,
  WebSocket, beacon, analytics, or crash-reporting paths.
- Treat filenames, waveform thumbnails, voiceprints, transcripts, and project
  metadata as sensitive even when they are not raw audio.
- Scope Drive access to explicit user actions, show the destination, and never
  run Drive transfer during Process.
- Keep entitlement verification server-side. Use a durable database with unique
  constraints for Stripe event IDs, entitlement history, activation limits, and
  revocation; do not log license tokens or personal audio metadata.
- Threat-model Electron IPC with an allowlist, schema validation, path
  canonicalization, file size limits, and no renderer Node access.

### Maintainability and release engineering

- Generate controls from one schema where practical: identifier, layer owner,
  timing (`live`, `process`, `post-stem`, `export`), unit, range, default,
  accessibility label, and consumer.
- Version worker protocols and project schema; support migrations or fail with a
  clear recovery path.
- Release application, model manifest, worklet hashes, and platform bundles with
  provenance. Use canary rollout and keep a known-good model manifest available
  for rollback.
- Keep analytics privacy-preserving and event-based: import started, preflight
  result category, process completed/failed, A/B used, export completed. Never
  include filenames, audio-derived content, or fine-grained fingerprints.

## 6. Alternative approaches with trade-offs

| Approach | Advantages | Disadvantages | Recommendation |
|---|---|---|---|
| Browser-first local app | Instant trial, no installation, strong privacy story | Memory/storage variance, WebGPU inconsistency, browser codec limitations | Keep as acquisition and evaluation surface |
| Desktop-first Electron product | Predictable filesystem, larger models, offline projects, better long-file reliability | Installer friction, signing/update burden, larger distribution | Best initial paid professional experience |
| Native desktop DSP application | Maximum performance and hardware control | Expensive rewrite, duplicated UI/logic, slower iteration | Reconsider only after Electron limits are measured |
| Android-first | Valuable for field recordings and broad reach | Thermal/memory pressure, background limits, fragmented WebViews | Maintain, but do not make it the MVP critical path |
| Cloud inference | Uniform hardware, easiest model upgrades, scalable batch workflows | Breaks the core privacy promise, recurring compute/storage cost, upload latency and compliance burden | Reject for core processing |
| Hybrid opt-in cloud “HQ mode” | Could support very large models and weak devices | Dilutes positioning and creates complex consent/security/compliance | Consider only as a separately branded, explicit future service |
| Plugin-first (VST/AU/NLE) | Fits professional workflows and supports premium pricing | New native architecture, host compatibility matrix, live latency expectations | Strong expansion after standalone workflow proves demand |
| ChatGPT companion | Discovery, education, preset guidance | Cannot safely perform core local file processing; platform dependency | Metadata/help companion only, post-MVP |

## 7. Implementation roadmap

### Phase 0 — Evidence and scope (1–2 weeks)

- Interview 12–15 target users across podcast, video, journalism, and field
  recording; identify the most frequent failure recordings and export needs.
- Inventory implemented versus claimed features and remove or qualify unsupported
  marketing statements.
- Freeze the MVP target platforms, file limits, default model, fallback, and
  export formats.
- Build a consented, rights-cleared evaluation set covering steady noise, music,
  reverb, crosstalk, whispers, clipping, and multiple accents.

**Exit:** one target segment, top three outcomes, a signed MVP scope, and a
baseline quality/performance report.

### Phase 1 — Golden path (2–4 weeks)

- Make Quick Clean the outcome-led default while retaining an Advanced/Engineer
  entry point.
- Add a centralized capability preflight and actionable failure taxonomy.
- Unify project state across Quick Clean and Engineer views.
- Deliver explicit Process/cancel/retry, reliable stage progress, and
  level-matched A/B.
- Make export the unmistakable completion action.

**Exit:** five representative users can import, process, compare, and export
without assistance.

### Phase 2 — Trust, privacy, and reliability (2–3 weeks)

- Add storage budgets, cache eviction visibility, per-project deletion, and
  verified Clear Local Data behavior.
- Expand no-audio-egress, worker protocol, cancellation, model integrity, and
  corrupted-cache tests.
- Complete keyboard/screen-reader/reduced-motion review of the golden path.
- Establish crash-safe project recovery and app/model rollback procedures.

**Exit:** privacy invariants and supported device envelopes pass in CI and on the
platform test matrix.

### Phase 3 — Commercial readiness (2–4 weeks)

- Replace in-memory billing state with durable transactional storage and webhook
  idempotency.
- Introduce one understandable Pro plan, entitlement recovery, receipts, refund
  handling, and support diagnostics that exclude sensitive media.
- Publish benchmark methodology, supported limits, privacy documentation, and
  model notices.
- Add release canarying, signed artifact provenance, and operational alerts.

**Exit:** a paid user can purchase, activate on supported devices, recover an
entitlement, and retain access through service restarts without weakening local
processing.

### Phase 4 — Growth experiments (after retention signal)

- Test batch queue, project packs, team presets, and NLE/plugin demand in that
  order.
- Add specialist models only when they beat the baseline on the target corpus
  within memory and latency budgets.
- Expand platform artifacts after support and crash-free targets are stable.

## 8. Risks and assumptions

| Risk or assumption | Impact | Mitigation / validation |
|---|---|---|
| Users value privacy enough to choose local processing | Positioning may not convert | Landing-page test plus interviews; compare privacy-led and quality-led messages |
| Default model quality is sufficient for spoken-word rescue | Core promise may fail | Blind tests on a versioned corpus; publish failure modes; one safe fallback |
| Browser hardware variance is manageable | Failed jobs and support burden | Preflight, supported envelope, WASM fallback, desktop recommendation for long files |
| “Maximum isolation” may damage speech | Trust loss | Artifact-aware preset bounds, level-matched A/B, preserve-ambience alternative, non-destructive stems |
| Local storage is assumed to be permanent | Project loss | Explain retention, persist only with user intent, exportable project packs later |
| Broad codec claims vary by platform | Import failures | Capability-derived format messaging, sample-file matrix, desktop decode fallback where safe |
| Model downloads are large or unavailable offline | Poor first run | Size disclosure, resumable cache, integrity check, bundled desktop baseline, graceful fallback |
| Billing service outage blocks a local tool | Paid-user frustration | Signed time-limited offline entitlement lease, grace period, recovery flow, no client-only trust |
| Drive/analytics expand the data boundary | Privacy breach | Data-flow inventory, deny-by-default adapters, egress tests, explicit consent and scopes |
| Expert controls outpace test coverage | Regressions/artifacts | Schema ownership, contract tests, perceptual fixtures, preset snapshots |
| A shared shell can become lowest-common-denominator UI | Platform experience suffers | Capability adapters and platform affordances without forking the core interface |

## 9. Testing and success criteria

### Product success metrics

Measure locally and aggregate only coarse, consented events where analytics are
enabled.

| Funnel / quality | Initial success criterion |
|---|---|
| Activation | ≥70% of users who import a supported file reach a completed preview |
| Time to value | Median active interaction time from import to A/B preview ≤3 minutes, excluding device-dependent processing wait |
| Completion | ≥55% of completed previews produce an export |
| Usability | ≥80% of moderated first-time users finish the golden path without assistance |
| Reliability | ≥99% successful Process completion inside the published supported envelope |
| Crash-free use | ≥99.5% crash-free sessions on each launch platform |
| Quality | Processed output preferred over original in ≥75% of blind target-corpus comparisons; speech-damage rejection <10% |
| Performance | UI long tasks >200 ms are absent during steady playback; transport response p95 <100 ms |
| Privacy | Zero audio/PCM/stem/voiceprint egress in automated and proxy-observed tests |
| Retention | ≥25% of activated target users return within 30 days before investing in team features |

Targets are hypotheses, not marketing claims. Re-baseline them after the first
100 qualified users and segment by device class and recording condition.

### Required test layers

1. **Pure DSP and state tests:** numerical stability, silence/NaN/denormal cases,
   parameter bounds, deterministic cache keys, project migrations.
2. **Worker contract tests:** version mismatch, transfer ownership, progress
   monotonicity, cancellation races, stale job messages, corrupt models, OOM and
   provider fallback.
3. **Golden audio fixtures:** silence, impulse, sine, clipped speech, stereo
   imbalance, short files, long files, malformed containers, and representative
   rights-cleared speech/noise mixtures. Track objective metrics and listening
   results; never use one metric as a proxy for human quality.
4. **UI end-to-end tests:** keyboard-only import through export, A/B level match,
   Process disabled states, cancel/retry, device preflight, storage deletion, and
   Quick Clean ↔ Engineer state parity.
5. **Cross-platform matrix:** current supported Chromium, Electron release build,
   representative low/mid/high Android devices, WebGPU and WASM paths, offline
   first run after models are cached.
6. **Security tests:** CSP/header assertions, dependency and secret scanning,
   Electron IPC abuse cases, path traversal, hostile media metadata, zip/project
   bombs if project import is added, JWT expiry/tamper/revocation, Stripe replay,
   and no-audio-egress interception.
7. **Performance budgets:** peak memory by file duration/channel count, model
   startup, real-time playback underruns, processing factor, export duration,
   cache footprint, and thermal behavior on mobile.
8. **Accessibility:** automated checks plus manual screen-reader, focus order,
   zoom, contrast, reduced motion, and non-pointer transport operation.

### Release gates

- No critical/high security finding open.
- Privacy invariant and model/worklet integrity checks pass.
- No regression against the golden audio corpus beyond an agreed tolerance.
- Supported-envelope process success and crash-free targets are met.
- Billing durability and replay tests pass before enabling paid checkout.
- Marketing statements match shipped models, platforms, and measured results.

## 10. Final recommendation

Proceed, but **narrow the product before expanding the technology**. The current
local Stem-Split & Live-Mix foundation is differentiated and should remain. The
highest-leverage work is not another model, platform, visual banner, or control;
it is a coherent Quick Clean journey, measurable output quality, predictable
device behavior, and proof that the privacy promise survives every integration.

Ship the first commercial version as a browser evaluation plus a dependable
Windows desktop product for spoken-word rescue. Keep Android and the full
Engineer Console in the shared codebase, but treat them as secondary until the
golden path meets its reliability and usability gates. Use one simple paid Pro
entitlement only after durable billing is ready. Defer collaboration, new model
families, plugins, and any ChatGPT companion until repeat use demonstrates which
expansion customers will pay for.

The decisive advantage should be: **the fastest trustworthy path to clean
speech, with the recording staying on the user’s device and expert depth always
available when needed.**

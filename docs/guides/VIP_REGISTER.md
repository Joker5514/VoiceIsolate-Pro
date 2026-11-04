# VIP register — Issue #886 status

Status of every VIP in Issue #886 as of the 2026-11-04 rounds (PR #888
branch; per-round evidence is in the PR #888 and issue #886 comments).
The issue checklist is the source of truth for box counts; this file
records the status class per VIP so completed, partial, blocked, and
unverified work are not conflated (Phase 0 box 5).

**Legend:** complete = all boxes checked with evidence. partial = some
boxes checked, work remains. blocked = cannot proceed without an
owner-side input (named). unverified = not yet run in the claimed
environment.

## Phase 0 — baseline

| VIP / item | Status | Note |
|---|---|---|
| Phase 0 (6 boxes) | complete | PR #885 merged (head `6cf5248b`, merge `277bff42`); ledger reviewed; baseline commands run at `277bff42` — see `PHASE0_BASELINE.md` |
| VIP-001 (CI billing lock) | blocked | Owner must resolve GitHub account billing, then re-run workflows; no code fix exists |

## Phase 1 — Engineer and Forensic workflows

| VIP | Status | Note |
|---|---|---|
| VIP-019 (7 boxes) | complete | Model/capability inventory from the execution registry |
| VIP-020 (7 boxes) | complete | Forensic inspector + provenance UX |
| VIP-021 (8 boxes) | complete | Inventory doc, entry-point map, dead Save Custom preset fixed, validation, execution state, cancellation safety, interaction tests, touch/keyboard/mobile/a11y (touch-select smoke) |
| VIP-032 (5 boxes) | complete | Entry-point map, canonical contract (CLAUDE.md §2.2), routing verified, no duplicate paths found, routing regression test — see `ANALYSIS_CONTRACTS.md` |

## Phase 2 — real-world audio quality evidence

| VIP | Status | Note |
|---|---|---|
| VIP-006 (6 boxes) | complete | 36 licensed clips, 8 classes, dataset 2026-11-03.v1, checksum + license gate |
| VIP-004 (6 boxes) | partial, blocked in part | Baseline corpus eval DONE (144 runs, 36 clips × 4 chains; report in PR #888 / issue #886 comments for commit 27fdc37a+1); listening comparisons still need a human listener (owner) — 32 blinded pairs + rubric prepared |
| VIP-034 (5 boxes) | partial | Thresholds doc written BEFORE the eval; benchmark report done and repeatable (rerun reproduced identical means); box 2 still open in part (device classes beyond this VM class belong to device-matrix work; long-file leg DONE via VIP-029); nothing promoted — no chain meets all bars |
| VIP-029 (5 boxes) | complete | Stress sweep DONE (60/300/900 s, 15 runs, 0 failures; cancel + error recovery verified; tier guards unit-tested). Caveat: processing sweep is one VM class; tier policies for all three classes are unit-tested, other-class processing is device-matrix work |
| VIP-024 (4 boxes) | complete | Browser CSP verified in real Chromium on the current head (11/11 browser steps PASS incl. new csp-runtime smoke: strict landing CSP, scoped legacy /app exception, inline blocked, blob worker allowed, third-party connect refused; privacy-runtime confirms no egress). Caveat: Chromium only here; Vercel production CSP (extended origins) is statically pinned, not served locally; Firefox/WebKit not run in this VM |
| VIP-015 (5 boxes) | partial | ECAPA probe DONE (same-source 0.669 vs cross median 0.085; mel useless at 0.904 vs 0.867); fusion spec written; fallback verified (ECAPA absent → 'unavailable', mel still works). OPEN: labeled multi-speaker eval (boxes 3–4 need speaker labels that do not exist in the corpus) |
| VIP-031 (4 boxes) | partial | Diarization baseline DONE (36 clips; 50% false-split on known single-speaker; synthetic DER 0.42–0.68; silence perfect). OPEN: uncertainty visibility (box 4 — energy-confidence is not identity certainty; no weak-evidence indicator in UI) |
| VIP-016 (5 boxes) | partial | Overlap research + baseline + trade-offs DONE; integration correctly withheld (no chain meets Phase 2 acceptance on overlap). OPEN: runnable prototype behind a flag (box 2) |
| VIP-038 (5 boxes) | partial | Generator + fail-closed verifier DONE; web build sidecar generated + verified (commit 937e9626, vip-app-e14e27c53124); signed/attestable documented (nothing signed by the project). OPEN: Android/desktop artifact sidecars (no such builds producible here) + deployed-artifact instances |
| VIP-013/014/017/018 (deferred models) | research only | DEFERRED_MODELS.md: SCNet name ambiguity (three models; MSST variant is the plausible one), BS-RoFormer license/size analysis (viperx ambiguous, KimberleyJSN MIT-declared, 350–700 MB), AudioSep (QueryNet+ResUNet, 32 kHz, needs product decision), CLAP (routing only, not separation). NO benchmark run for any — no artifact, license clearance, export, or adapter — boxes stay open |
| VIP-022 (1 box) | complete | RESOURCE_ADAPTATION.md + performance-tier.test.js: tier boundaries pinned (HIGH/BALANCED/CONSTRAINED), upload tiers, adaptive hop, cancel/recovery, stress numbers. Thermal-state sensing NOT implemented (no web API) — recorded, not claimed |
| VIP-035 (1 box) | complete | LEGACY_INVENTORY.md: dual workers, dual diarization, unwired RegionActionPalette component, legacy CSP exception, unused-export scan warning (134 naive hits, all sampled ones false positives — no bulk removal) |
| VIP-036 (1 box) | complete | Focused cleanup: diarization-eval.cjs deduped onto corpus-eval's shared readWav/upsampleLinear (byte-identical rerun report proves no behavior change); no speculative removals |
| VIP-037 (1 box) | complete | VERIFICATION_STATE.md refresh (published vs PR-branch, platform matrix + ECAPA row, model availability, privacy, limits, troubleshooting, release instructions) + docs/README index of all new guides + DSP_SLIDERS cross-link. Published-release docs untouched (their verdict stands) |
| VIP-016 box 2 | complete (prototype only) | target-extract-proto.cjs: flagged (--enable-target-extract required, exit 2 without it), harness-only, touches no product paths. Pseudo enrollment mean SI-SDR Δ −0.85 dB, oracle −0.62 dB — both beat shipped chains on overlap but BOTH miss the ≥ 0 dB gate (1.0 s windows cannot separate fully-overlapping speech; every window contains the target). NOT integrated, correctly |
| VIP-025 lines 143–144 | complete | REAL CSP hole found + fixed: encoded traversal vip://app/app/..%2findex.html served landing content with the legacy unsafe-inline exception (scope decided on raw URL spelling, file resolved after decoding). Fix: normalizeScopePath in vip-csp.cjs (decode + resolve . / .. over / and \); regression tests + new electron-csp-runtime smoke (7 checks in real Electron: strict landing, legacy shell, strict traversal, preload, worker, worklet). Boxes 142/145 stay open: packaged Windows NSIS build not producible here |
| Cross-cutting 190/191/192/195/199 | complete (with stated scope) |
| VIP-008 box 1 | complete | RELEASE_RUNBOOK.md §2 already documented all four signing secrets + keystore creation + Gradle/local build wiring; pinned by tests/android-signing-docs.test.js (workflow secrets ⊆ doc, Gradle vars ⊆ doc, no credential values). Boxes 2–5 stay open: they need the actual keystore, secrets, artifacts, and device runs |
| VIP-028 box 1 | complete | docs/guides/DEVICE_TEST_MATRIX.md defines tiers (measured, never assumed from model names), representative low/mid/high devices, desktop/browser environments, run scope, record format, and starter constraints — every row marked defined-not-tested. Boxes 2–4 stay open: they need the physical runs | 190: engineer-controls-execution.test.js — every registry id reaches ML snapshot or Live-Mix PARAM_MAP; ML ids carry caller values into the config. 191: provenance.test.js (digest/hash verification, explicit nulls) + release-provenance + forensic UX tests + RELEASE_PROVENANCE limits doc. 192: whisper evaluated on real recordings (4 clips: enhance preservation 31.55 dB, fricative −0.24 dB; landing 13.20/−2.36; maximum fricative −8.87 — RNNoise effect). 195: stress + tier caps + cancel/refusal verified (VM class; device behavior is VIP-028). 199: register + verification state match the PR-branch implementation; published docs still describe v25.0.3 and say so |

## Phase 3 — speaker intelligence

| VIP | Status | Note |
|---|---|---|
| VIP-015 ECAPA fusion (5 boxes) | unverified | Speaker-eval script exists; ECAPA model optional/not installed; evaluation on labeled multi-speaker recordings not run |
| VIP-031 speaker detection (4 boxes) | unverified | Baseline on the real corpus not established; diarization-error measurement needs labeled ground truth |
| VIP-016 overlap separation (5 boxes) | unverified | Research + flagged prototype not started |
| Deferred 013/014/017/018/022 (5 boxes) | unverified | Each evaluates a model against the Phase 2 benchmark, which does not exist yet |

## Phase 4 — platform, privacy, performance, release

| VIP | Status | Note |
|---|---|---|
| VIP-024 browser CSP (4 boxes) | partial | Static CSP + privacy-runtime smoke pass; production CSP in real supported browsers needs the browser tier on the current branch |
| VIP-025 Electron CSP (4 boxes) | partial | Static Electron CSP tests pass; packaged-runtime verification needs an Electron build (not run here) |
| VIP-008 Android signing (5 boxes) | blocked | Owner checklist exists in the #885 ledger; signing needs owner keystore/secrets — nothing created or committed here |
| VIP-028 physical devices (4 boxes) | blocked | Needs supported-device matrix runs; no devices attached in this environment |
| VIP-029 long files / resources (5 boxes) | unverified | Stress/regression tests and documented limits not yet produced |
| VIP-038 release provenance (5 boxes) | partial | Provenance schema + sidecar + `provenance:validate` exist; per-artifact generation needs actual web/Android/desktop builds |

## Phase 5 — commercial readiness and cleanup

| VIP | Status | Note |
|---|---|---|
| VIP-026 Stripe (1 box) | blocked | Box itself requires healthy CI first; then test-mode validation with owner credentials |
| VIP-027 auth decision (1 box) | blocked | Needs an explicit owner product decision |
| VIP-033 export formats (1 box) | blocked | Needs an owner decision on which formats are required |
| VIP-035 legacy cleanup (1 box) | unverified | Inventory not yet produced (known candidate: unwired `src/ui` RegionActionPalette variant noted in the #885 ledger) |
| VIP-036 focused cleanup (1 box) | unverified | After functional work, by design |
| VIP-037 documentation (1 box) | partial | Guides added this round (controls, analysis contracts, baseline, this register); full user/developer doc + platform matrix refresh still open |

## Cross-cutting definition of done (11 boxes)

All unverified as a set: each depends on its phase's work plus healthy
CI (box: CI, security checks, static verification, release checks
pass — currently blocked by VIP-001) and on artifacts being traceable
to exact source commits (needs VIP-038 builds).

## Next in order

1. Labeled speaker data (owner/external): unlocks VIP-015 boxes 3–4
   (identification accuracy, false attribution, calibrated
   thresholds) and VIP-031 box 4 (calibrated uncertainty UI).
2. Overlap-separation candidate model + flagged prototype (VIP-016
   box 2) — integrate only on Phase 2 acceptance.
3. Android/desktop builds for VIP-038 boxes 1/4 (needs SDKs/packaging
   outside this VM) + VIP-025 packaged-runtime verification.
4. Owner inputs, in dependency order: CI billing → Stripe test-mode →
   signing secrets → device matrix → listening evaluation (32 blinded
   pairs + rubric ready) → auth/export decisions.

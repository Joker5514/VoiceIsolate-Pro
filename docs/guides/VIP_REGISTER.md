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
| VIP-034 (5 boxes) | partial | Thresholds doc written BEFORE the eval; benchmark report done and repeatable (rerun reproduced identical means); box 2 still open (device classes beyond this VM class + long files belong to VIP-029/device work); nothing promoted — no chain meets all bars |

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

1. VIP-029 long-file/resource stress tests (node-runnable, no devices;
   also completes VIP-034 box 2's long-file leg).
2. VIP-024 browser-tier CSP evidence on the current branch head.
3. Phase 3 deferred evaluations against the corpus harness (VIP-015 /
   031 / 016 need labeled ground truth + the harness protocol).
4. Owner inputs, in dependency order: CI billing → Stripe test-mode →
   signing secrets → device matrix → listening evaluation (32 blinded
   pairs + rubric ready) → auth/export decisions.

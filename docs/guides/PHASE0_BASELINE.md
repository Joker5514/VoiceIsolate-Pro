# Phase 0 — Baseline for Issue #886 (PR #885)

The baseline state that PR #888 builds on. Verified 2026-11-04 against
GitHub API records and a clean worktree of the merge commit. This is the
deliverable for Phase 0 boxes 2–5 (box 1, the merge fact itself, was
already checked on the issue).

## PR #885 — final state

- **State:** merged. **Head:** `6cf5248b2af21aa5fa8c9206d996c86b9acb37b7`.
  **Merge commit:** `277bff42378e4af1da9f606fdaca49a1de4ba169`
  (2026-11-03T05:22:19Z). **Base at open:** `2514d2c8`.
- **Size:** 12 commits, 41 files, +4405/−136.
- **Title claim:** hermetic release gate, security hardening, whisper
  protection, speaker wiring, forensic provenance
  (VIP-002/003/005/007/009/010/011/012/024/025/040 + VIP-006 framework).
- **Execution ledger:** `EXECUTION_LEDGER_2026-11-02.md` (committed by the
  PR). Its per-VIP mapping, verified against the merged files:

| VIP | What landed | Evidence in the PR | Residual gap (ledger's own words) |
|---|---|---|---|
| VIP-001 | Billing lock confirmed (external) | Annotation: "The job was not started because your account is locked due to a billing issue"; 0 successes in last 40 `ci.yml` runs since ≥2026-10-29 | Owner must resolve billing, then re-run |
| VIP-002 | Audit floors | `package.json`, `pnpm-workspace.yaml`, lockfile: body-parser 2.4.0, qs ≥6.16.1, ip-address ≥10.7.4 | Live Stripe test-mode payment needs owner credentials |
| VIP-003 | Hermetic model-delivery | `validate-onnx-models.js` honors optional/shipped; `prod-verify.mjs` network tier | Remote-delivery liveness stays in the network tier |
| VIP-012 | Manifest sync | `sync-model-manifests.mjs` + regenerated manifests + `MODEL_DELIVERY.md` map | Doc manifest hand-maintained by design, drift-guarded by test |
| VIP-009 | Upload limits | `src/core/upload-limits.js` + `FileIngestion.js` wiring; never truncates | Physical Android/desktop memory validation unverified (no devices) |
| VIP-024 | CSP origins removed | `server/securityHeaders.js`, `vercel.json`, `deployment-config.test.js` | Runtime confirmation needs the browser tier |
| VIP-025 | Electron CSP | `electron/vip-csp.cjs` (strict + scoped legacy exception for `/app,/blueprint,/docs`) + `electron-vip-csp.test.js` | Runtime enforcement unverified (no Electron binary in sandbox) |
| VIP-005 | EnhanceGuard | `src/core/EnhanceGuard.js` + landing wiring; fake 85% whisper-retention default removed | Babble is not detected as a class (guard says so honestly); listening tests need the corpus |
| VIP-007 | Speaker hook | `AutoAnalysis.js` `runSpeakerHook` adapter; Landing + premium-workspace inject existing `SpeakerDetection.detectSpeakers` | ONNX diarization models optional; k-means fallback is baseline quality |
| VIP-011 | SHA-256 identity | `src/core/sha256.js`, `SourceHashWorker.js`, `SourceHash.js` | Forensic UI display panel = VIP-020 |
| VIP-010 | Provenance schema | `src/core/Provenance.js` (schema v1, canonical-JSON manifest digest, tamper detection) | Engineer-export sidecar wiring + Forensic UI panel = VIP-020 |
| VIP-040 | Seeded dither | mulberry32 TPDF via `ditherSeed`, recorded in sidecar `export.options` | None (standard TPDF ±1 LSB, documented) |
| VIP-006 | Framework only | `scripts/quality/corpus/README.md` (schema v1, license policy) + `load-corpus.mjs` (checksum + license gate) | **≥30 licensed real clips NOT provisioned in this PR** — later provisioned under #886 (36 clips, dataset 2026-11-03.v1, 8 classes) |
| VIP-008 | Owner checklist only | §3 of the ledger; no secrets created or committed | Owner provides signing identity |
| Deferred | 013/014/016/017/018/022/026/027/028/029/033/035/036/037 | Per mission §4 | Per roadmap |
| 019/020/021/032/038 | Started-blocked/scoped | Provenance + hash building blocks; palette-vs-handler ID question resolved | Browser QA unavailable in sandbox at the time; continued under #886/#888 |

## PR #885 review state

- **Inline review comments:** 0. **No human review comments exist.**
- **Bot comments (6, all non-substantive):** Vercel preview success;
  Codex review **failed to run** (status `failed`, no findings listed —
  the `has_unresolved_findings` flag is an artifact of the failed run);
  Kilo out of credits; Qodo paused (subscription inactive); CodeRabbit
  skipped (repo has fewer than 10 stars). A second Codex comment confirms
  usage limits were reached.
- **Conclusion for box 3:** there are no unresolved review findings to
  carry forward — only unavailable reviewers and the CI failure below.

## PR #885 CI state (same signature as PR #888)

Check runs on head `6cf5248b`: `production-gate` failure, `Scan`
failure, `Run eslint scanning` failure, `njsscan` failure, `Delete
Merged Branch` failure, `Kilo Code Review` action_required, CodeRabbit
skipped, cubic neutral, Macroscope skipped, Vercel success. The four
workflow failures match the repo-wide pattern established for #888
(jobs completing in ~2 s with 0 steps and no runner), whose root cause
the ledger documents as the VIP-001 billing lock. **These are not code
failures and cannot be fixed from the repository.**

## Changes that did not land in #885

- Corpus provisioning (landed later under #886; see VIP-006 above).
- Android release signing (owner-side; still open as VIP-008).
- Runtime confirmations that need CI/devices: privacy-runtime browser
  tier, Electron packaged runtime, physical-device validation.

## Baseline commands at 277bff42 (this round)

Clean worktree of the merge commit (no PR #888 changes), 2026-11-04.
`pnpm` was missing from this VM's PATH, so it was installed locally
(v11.3.0, matching the repo's `packageManager` pin, via npm into
`~/workspace/.local-npm`) and a real `pnpm install --frozen-lockfile`
was run in the worktree (4.4 s, postinstall setup-ort/setup-three OK).
An earlier attempt with pnpm 10 failed only because that version tried
to self-switch to the pinned 11.3.0 and hit an `EPERM` chown in its own
tools dir — a local tooling quirk, not a repo issue. A first full-jest
run in the worktree is discarded: it executed while the worktree's
`node_modules` symlink was being replaced, so its 3 failures are not
trusted evidence; the rerun below is the baseline.

| Command | Result |
|---|---|
| `eslint` (repo lint scope) | 0 errors, 86 warnings |
| `node scripts/validate.js` | PASS |
| `node scripts/check-version-sync.cjs` | PASS — Web, Electron, Android aligned at 25.0.2 (250002) |
| `node scripts/build.mjs` | PASS — `vip-app-4f346d36b372`, 284 precached |
| `prod:verify --no-browser` (in-process static steps) | All PASS: ci-patches, validate, duplicate-keys, version, dsp-isolation, privacy-static, no-cloud-audio, models, worklets, provenance, build, build-sam, worklets-build |
| `prod:verify --no-browser` (full rerun with pnpm 11.3.0 on PATH) | Verdict **PASS** — all 17 static steps pass (including the four that previously failed only on `pnpm ENOENT`). Browser/network/desktop/platform tiers remain NOT RUN / NOT VERIFIED in `--no-browser` mode, by design |
| `node scripts/monetization-e2e.mjs` (direct) | 12/12 PASS (offline fake Stripe API) |
| `node scripts/quality/quality-gate.cjs` (direct) | PASS — with documented improvement gaps on synthetic fixtures (e.g. enhance SI-SDR delta still negative on hum/whisper-white fixtures); synthetic fixtures do not prove quality (issue rule 4) |
| Full jest at `277bff42` | 254/254 suites, 4542 passed, 1 skipped, 0 failed (clean rerun after a real `pnpm install`; an earlier run's 3 failures occurred while the worktree's `node_modules` symlink was being replaced and are discarded as untrusted) |
| Browser / network / desktop / platform tiers | NOT RUN / NOT VERIFIED in `--no-browser` mode (browser tier needs Chromium; platform tiers need signing secrets / Windows packaging) |

## Separation of failure classes (box 5)

- **External/account (owner-side, not code):** GitHub Actions billing
  lock (VIP-001) — all workflow jobs fail before any step runs, on #885
  and #888 alike; Android signing secrets (VIP-008); bot-reviewer
  credit/subscription limits.
- **Environment (this VM, not code):** `pnpm` binary absent from PATH;
  Playwright's downloader ignores the egress proxy (Chromium installed
  by hand); full-page screenshots crash the software renderer.
- **Code/test (none found on main in this run):** lint 0 errors,
  validate/version/build/static all pass; jest result pending as noted.
  PR #888's own regressions were found against this baseline and fixed
  on the branch (18 tests in cycle 1, region-palette duration in the
  browser round, touch-action in the VIP-021 box-8 round).

# Execution Ledger — Evidence-Driven Implementation Pass (2026-11-02)

Companion to the immutable planning baseline `IMPLEMENTATION_READINESS_AUDIT_2026-11-02.md`.
Branch: `arena/df224b21-voiceisolate-pro` (base `2514d2c` = `origin/main`). All work as
focused commits on this branch; nothing merged to `main` (CI is down — see VIP-001).

---

## 1. Task ledger

| Task ID | Initial status | Root cause (evidence) | Changes | Tests (exit codes) | Remaining limitations | PR | Next step |
|---|---|---|---|---|---|---|---|
| VIP-001 | Confirmed (external blocker) | GitHub account billing lock: `gh run view` annotation *"The job was not started because your account is locked due to a billing issue"*; 0 successes in last 40 `ci.yml` runs (since ≥2026-10-29) | none (code cannot fix billing). Recovery procedure in §2 | n/a (external) | Owner must resolve billing; then re-run failed workflows | (none) | Owner action §2; then re-run `ci.yml` on the branch tip |
| VIP-002 | Confirmed | `pnpm audit --prod`: body-parser <2.4.0 (HIGH GHSA-27r3-jxmh-p828), qs ≤6.16.0, ip-address ≤10.7.3; override floors one patch behind; authoritative overrides live in `pnpm-workspace.yaml` (pnpm ≥10 ignores the `package.json` copy) | `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` — floors to body-parser 2.4.0 / qs ≥6.16.1 / ip-address ≥10.7.4; resolved body-parser@2.4.0, qs@6.17.1, ip-address@10.7.5 | `pnpm audit --prod` → "No known vulnerabilities found" (exit 0); 206 API/Stripe/webhook tests (7 suites, exit 0); `pnpm test:monetization:e2e` 12/12 (exit 0) | live Stripe test-mode payment still requires owner credentials (PR #859 note) | (in batch PR) | merge when CI restored |
| VIP-003 | Confirmed | `prod:verify:static` FAILED at `model-delivery`: `validate-onnx-models.js` HEAD-checks remote Vercel Blob URLs and hard-failed on the **optional/unshipped** demucs blob; read a second registry | `scripts/prod-verify.mjs` (step → `network` tier), `scripts/validate-onnx-models.js` (honors optional/shipped; optional = skip "not claimed as passed"; exported `classifyResult`; `require.main` guard), `tests/model-manifest-sync.test.js` | `node scripts/validate-onnx-models.js` exit 0 offline (7 required OK, 2 optional skipped); targeted jest 14/14; tier assertions pin hermeticity | network-tier remote-delivery check unverified here (sandbox egress) — stays in `--network` | (in batch PR) | CI network tier confirms remote liveness |
| VIP-012 | Confirmed drift | `public/app/models-manifest.json` had 4 hand entries vs 7 shipped files vs 13 canonical manifest entries; demucs sizeBytes differed across 3 registries | new `scripts/sync-model-manifests.mjs` (generated `models` section + `--check`; worklets preserved); regenerated manifest (9 deliverables + 2 documented legacy aliases, eager flags preserved); dfn3 cards added to `public/app/models/models-manifest.json`; dfn3 filenames added to legacy `MODEL_FILES`/`MODEL_REGISTRY`; `docs/guides/MODEL_DELIVERY.md` registry map | `sync-model-manifests.mjs --check` exit 0; `model-registry-consistency` stays drift-free; `pnpm validate`, `worklets:verify`, `validate-model-integrity` all exit 0 | doc manifest remains hand-maintained (by design — model cards) but drift-guarded by test | (in batch PR) | keep generator output committed |
| VIP-009 | Confirmed gap | `FileIngestion.js:40` `MAX_FILE_BYTES = Number.MAX_SAFE_INTEGER`; no pre-decode memory policy | new `src/core/upload-limits.js` (tier budgets, WAV header probe, warn/refuse, post-decode checks); `FileIngestion.js` wiring (probe → warn hook → refusal; post-decode/post-resample budget asserts; never truncates) | `tests/upload-limits.test.js` 20 cases (exit 0); file-ingestion suites 85+31 green | physical Android/desktop memory validation unverified (no devices) | (in batch PR) | device runs under VIP-028 |
| VIP-024 | Confirmed (#789) | CSPs still allowlisted fonts.googleapis.com/gstatic while fonts are self-hosted since Android packaging began (only CSPs + guard tests referenced the origins) | `server/securityHeaders.js`, `vercel.json` (origins removed, both CSP variants), `tests/deployment-config.test.js` (asserts absence now) | 106 tests (deployment-config, precision-studio-shell, android-complete-app, server, privacy-invariants) exit 0 | runtime confirmation via `test:privacy-runtime` needs Chromium (CI browser tier) | (in batch PR) | privacy-runtime in CI |
| VIP-025 | Confirmed gap | `vip://` handler set COOP/COEP but no CSP (CLAUDE.md §9 documented gap) | new `electron/vip-csp.cjs` (strict + web-parity scoped legacy exception for `/app,/blueprint,/docs` — required or the Engineer shell cannot boot); `electron/main.cjs` sets headers per response | `tests/electron-vip-csp.test.js` (13 cases incl. `/apple` boundary + strict/legacy diff = only the exception) + electron suites 33 green | runtime enforcement unverified (no xvfb/electron binary in sandbox) — CI desktop tier remains the proof | (in batch PR) | `xvfb-run pnpm test:electron-security` in CI |
| VIP-005 | Confirmed + reproduced | DFN3 catastrophic on whisper/babble/clipped (reproduced exactly at this commit: whisper-clean/enhance SI-SDR out −16.5, babble/enhance Δ −17.2, clipped/enhance out −5.4, whisper-white/enhance Δ −7.4). **Metric correction to the audit: −31.2 dB is speech-level Δ, not fricative (fricative reads 0.0 on whisper fixtures).** | new `src/core/EnhanceGuard.js` (whisper-confidence block; low-SNR/sparse-speech conservative fallback; never claims universal safety; explicit reversible override); `public/landing.js` wiring (analysis-complete / outcome-change / pre-Process); `LiveMeters.js` fake 85% whisper-retention default removed | `tests/enhance-guard.test.js` 17 cases; landing/module suites 256+ green; `pnpm test:quality` unchanged PASS | babble is NOT detected as a class (guard says so honestly); listening tests need the corpus | (in batch PR) | corpus + listening per VIP-006 |
| VIP-007 | Confirmed (placeholder) | `AutoAnalysis.js` hard-coded `speakers = []` ("placeholder… real implementation would use diarization.js") while a tested diarization path existed | `AutoAnalysis.js` `runSpeakerHook` adapter (injected hook keeps core pure; contracts: ordered non-overlapping segments, verbatim identities, dominant-speaker exclusion, failure→warning, cancel propagates, 60 s bounded timeout); Landing + premium-workspace inject existing `SpeakerDetection.detectSpeakers` | `tests/autoanalysis-speakers.test.js` 14 cases; 340 tests across 7 affected suites (incl. mobile-freeze-regressions, diarization) exit 0 | ONNX diarization models are optional/blocked on delivery; k-means fallback quality is baseline (VIP-031/015) | (in batch PR) | ECAPA fusion eval (VIP-015) |
| VIP-011 | Missing | content-hash.js is MurmurHash3 ("not a security primitive"); no source identity anywhere | new `src/core/sha256.js` (streaming FIPS 180-4, cross-checked vs Node crypto), `src/workers/SourceHashWorker.js`, `src/pipeline/SourceHash.js` (worker + cooperative fallback, progress, abort), `verifyBlobSha256` | `tests/source-hash.test.js` 15 cases (NIST + edge + chunking + cancellation + mismatch) exit 0 | Forensic UI display panel = VIP-020 | (in batch PR) | VIP-020 display |
| VIP-010 | Missing | no export record existed (audit log = channel-0 hashes only) | new `src/core/Provenance.js` (schema v1, mandatory-vs-null policy, canonical-JSON manifestDigest, tamper/output-mismatch/unsupported-schema detection, honesty contract pinned in tests); Landing export downloads `.viprovenance.json` sidecar (best-effort, never blocks audio) | `tests/provenance.test.js` 19 cases exit 0 | Engineer-export sidecar wiring + Forensic UI panel = VIP-020; WER/etc. fields await corpus | (in batch PR) | VIP-020; sidecar on remaining export paths |
| VIP-040 | Missing | `ExportManager.encodeWav` dither used `Math.random()` (non-reproducible) | seeded mulberry32 TPDF via `ditherSeed`; recorded in sidecar `export.options`; Landing path already deterministic | determinism cases in `tests/provenance.test.js` (same seed ⇒ identical bytes; different seeds differ; dither-off deterministic) exit 0 | seeded dither quality is standard TPDF (±1 LSB) — documented, no audio change unseeded | (in batch PR) | done (record kept in provenance) |
| VIP-006 | Missing | quality gate is synthetic-only; no corpus | `scripts/quality/corpus/README.md` (schema v1, license policy, metric eligibility, provisioning checklist) + `scripts/quality/load-corpus.mjs` (checksum + license admission gate) | `tests/quality-corpus.test.js` 7 cases (synthetic bytes) exit 0 | **≥30 licensed real clips not provisioned** (no dataset egress, no licensed recordings in sandbox) — the identified missing dependency; WER needs a pinned offline ASR | (in batch PR) | owner provisions corpus (checklist) |
| VIP-008 | Confirmed (needs secrets) | published Android artifact is `assembleDebug` (README); release signing needs owner keystore | none (no secrets may be created/committed) | n/a | **Owner action checklist in §3** | (none) | owner provides signing identity |
| VIP-013/014/016/017/018/022/026/027/028/029/033/035/036/037 | Deferred per mission §4 | — | none | — | see audit register | — | per roadmap |
| VIP-019/021/020/032/038 | Started-blocked / scoped | VIP-020 builds on VIP-010/011 (done); VIP-032 needs the migration plan (in audit); VIP-038 needs CI + native builds; VIP-019/021 need browser QA environment | building blocks delivered (provenance, hash); the palette-vs-handler ID question resolved (live palette matches; `src/ui` `RegionActionPalette` component is a separate, unwired variant with different IDs — pin/remove decision in VIP-021) | — | browser QA unavailable in sandbox | — | continue in next pass |

## 2. VIP-001 — GitHub Actions billing lock: recovery procedure (owner action)

**Evidence (2026-11-02):** `gh run list --workflow ci.yml` — 0 successes in the last 40 runs,
earliest listed 2026-10-29. `gh run view <id>` annotation: *"The job was not started because
your account is locked due to a billing issue."* Affected: `production-gate` in `ci.yml`,
`deploy.yml` consumers (`workflow_run` jobs), `release-build.yml`, plus scheduled
`njsscan`/`Semgrep`/Dependabot runs. This is an account-level restriction, not a repository
or workflow defect. **No billing or account settings were touched by this pass.**

**Recovery steps (in order):**
1. Repository owner signs in to GitHub → **Settings → Billing and plans** (or
   `https://github.com/settings/billing`) → resolve the payment-method issue / overdue
   balance that locked the account. For organization-owned billing, an org owner must do this.
2. Confirm **Actions spending limit** allows runs (Settings → Billing → Plans and usage →
   Pay as you go / Actions spending limit).
3. Re-run the failed workflows: `gh run list --workflow ci.yml --limit 5`, then
   `gh run rerun <id> --failed` for the newest `main` run and the branch run — or simply push
   the branch again after the lock clears.
4. Require a green `production-gate` on `arena/df224b21-voiceisolate-pro` **before** any merge
   to `main` (the branch carries 10 reviewable commits listed below).
5. After merge, confirm `deploy.yml` deployed the passing SHA and regenerate release
   provenance from produced artifacts (VIP-038) before claiming platform sync.

**Acceptance:** `gh run list --workflow ci.yml` shows a success for the branch tip;
`prod:verify` report.json written with the branch SHA.

## 3. VIP-008 — Android release signing: owner-action checklist (no secrets created)

1. Create/choose a release keystore **outside the repository** (never commit it).
2. Provide CI secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
   `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (names to match `release-build.yml`).
3. Run `pnpm android:release` / `pnpm android:bundle` (scripts exist) instead of
   `pnpm android:build` (which is `assembleDebug`); verify `verify-android-complete.mjs`.
4. Publish the release AAB/APK with `SHA256SUMS` + `release-manifest.json`; update
   `docs/DOWNLOADS.md` naming so debug vs release assets are unambiguous
   (the current `VoiceIsolate-Pro-android-debug.apk` name should stay labeled debug).
5. Regenerate `docs/releases/release-provenance.json` from the produced artifacts and run
   `pnpm provenance:validate:strict` (VIP-038).

## 4. Test evidence summary (commands actually executed in this pass)

| Command | Exit | Result | Commit |
|---|---:|---|---|
| `pnpm install --frozen-lockfile` | 0 | clean install | e63c431 (baseline: 246 suites / 4,421 tests PASS at 2514d2c) |
| `node scripts/validate-onnx-models.js` | 0 | 7 required verified locally; 2 optional skipped ("not claimed as passed") | 6337488 |
| `jest tests/model-manifest-sync…` (8 suites) | 0 | 203 tests | 6337488 |
| `pnpm validate` / `worklets:verify` / `validate-model-integrity` | 0 | all pass | 6337488 |
| `jest` ingestion suites | 0 | 85 + 31 tests | 2b92eb4 |
| `pnpm audit --prod` | 0 | **No known vulnerabilities found** (body-parser@2.4.0, qs@6.17.1, ip-address@10.7.5 resolved) | bc9c6b5 |
| `jest` API/Stripe/webhook suites (7) | 0 | 206 tests | bc9c6b5 |
| `pnpm test:monetization:e2e` | 0 | 12/12 fake-Stripe checkout→webhook→claim→cancel | bc9c6b5 |
| `jest` deployment/privacy suites (5) | 0 | 106 tests | fe9e1f9 |
| `jest` electron suites (3) | 0 | 33 tests | be7ff46 |
| `node scripts/quality/quality-matrix.cjs --secs 2` | 0 | whisper/babble/clipped enhance catastrophes reproduced exactly (see VIP-005) | 7eaa3a3 (evidence) |
| `pnpm test:quality` | 0 | PASS, pinned metrics unchanged (no DSP bytes touched) | 7eaa3a3 |
| `jest` landing/module suites | 0 | 256 + 260 tests | 7eaa3a3 / 9c56566 |
| `jest` autoanalysis/diarization suites (7) | 0 | 340 tests | fcc7c46 |
| `jest tests/provenance + source-hash` | 0 | 34 tests | 9c56566 |
| `jest` export suites (5) | 0 | 77 tests | 9c56566 |
| `jest tests/quality-corpus` | 0 | 7 tests | 426ef99 |
| `pnpm prod:verify:static` (final) | see §5 | full static gate incl. complete jest run | 426ef99 |

**Not executed in this sandbox (never claimed as passing):** all Chromium browser tiers
(no Playwright Chromium obtainable — CDN blocked), `downloads:validate` and any remote-URL
tier (egress restricted), Electron runtime smoke (no binary/display), Android packaging
(no JDK/SDK/signing), `provenance:validate:strict` (still expected to FAIL until native
artifacts are rebuilt — by design), physical-device testing.

## 5. Final gate result

See the commit message of the ledger commit and the PR body for the recorded
`prod:verify:static` summary at the final SHA. (The gate re-runs the complete Jest
suite, lint, validate, quality gate, model/worklet integrity, privacy static checks,
and the production build in one report at `output/prod-verify/report.json`.)

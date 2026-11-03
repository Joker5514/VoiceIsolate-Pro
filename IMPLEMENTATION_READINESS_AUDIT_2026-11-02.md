# VoiceIsolate-Pro — Master TODO Extraction & Implementation Readiness Audit

**Audit date:** 2026-11-02 (America/Chicago) · **Mode:** read-only audit & planning (no code, branch, PR, or file modifications to existing content; this document is the deliverable itself)
**Branch audited:** `arena/df224b21-voiceisolate-pro`, HEAD `2514d2c` — *"feat(ui): make engineer and landing blocks collapsible (#884)"* (branched from `main`)
**Method:** every "verified" claim corresponds to a command actually executed in this checkout or a code path read at the cited file/line. Anything not executed is explicitly labeled *unverified*.

---

## 1. Repository Baseline

**Repository identity**
- Repo: `Joker5514/VoiceIsolate-Pro` (proprietary / `UNLICENSED`, `package.json`).
- Working tree clean at audit start; no user changes present to preserve.
- **Limitation:** local git history is a single squashed commit — commit-level archaeology impossible; history-dependent statements rely on `gh` metadata (PR titles) and in-tree audit documents.
- Product version **25.0.2** (`versionCode` 250002). Latest published release **v25.0.3** (2026-09-09) whose native assets predate current `main`. `docs/releases/release-provenance.json`: web=unknown, android=stale, windows=stale. `pnpm provenance:validate:strict` **FAILS** (executed) — Web/Android/Windows/`main`/tag are demonstrably not one build.

**Application structure (production paths)**

| Surface | Entry | Engine |
|---|---|---|
| Landing (Standard) | `public/index.html` → `public/landing.js` (1,935 ln) | `StemSeparation` → `MLWorkerHost` → `src/workers/MLWorker.js`; import analysis via `src/core/audio/analysis/AutoAnalysis.js` |
| Engineer Console | `public/app/index.html` → `public/app/app.js` (8,516 ln legacy shell) + `engineer-console.js` skin | `StemSeparation`/`EngineerModeBridge` + `dsp-worker.js` fallback; `FullAnalysisHost` analysis |
| Desktop | `electron/main.cjs` (+ `preload.cjs`, `navigation-policy.cjs`, `sam-proxy.cjs`) | consumes `pnpm build` via `vip://app` |
| Android | Capacitor `android/app/src/main/java/com/voiceisolatepro/app/MainActivity.java` | same `build/`; WebViewAssetLoader COOP/COEP |
| Server/API | `server.js` + `api-routes/` (Stripe/JWT/sync/mailer) | no audio endpoints (verified `check-no-cloud-audio`) |

Canonical layers `src/core → src/workers → src/pipeline → src/presentation` exist and are test-pinned (`tests/architectural-invariants.test.js`, `tests/production-dsp-import-graph.test.js`).

**Active vs legacy code**
- Active: `src/` 4-layer modules, `public/landing.js`, `public/app/` Engineer shell, `public/app/lib/` re-export facades (verified: e.g. `public/app/lib/whisper-logic.js` re-exports `/src/core/WhisperLogic.js`).
- Legacy/orphaned (imported by no entry point): `public/app/batch-orchestrator.js` + `batch-processor.js` (header references the deleted `pipeline-orchestrator.js`), `public/app/offline-processor.js` (self-labeled "LEGACY / NOT ON THE PRODUCTION ENGINEER PROCESS PATH"), `public/app/ml-worker.js` (spawned by nothing; `tests/architectural-invariants.test.js:160` forbids spawning it), `src/pipeline/ProcessingOrchestrator.js` (CLAUDE.md §2.1 "inactive compatibility code"). `src/sam3_integration/` is a flag-OFF vision sidecar (`featureFlag.js` default off).

**Gates executed in this audit**

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm test` (Jest) | **PASS — 246 suites, 4,421 tests passed, 1 skipped** (223 s; skips platform/model-conditional) |
| `pnpm validate` | PASS (incl. shipped-model SHA-256 verification) |
| `pnpm lint` | 0 errors, **93 warnings** |
| `pnpm version:check` | PASS (25.0.2 / 250002 aligned) |
| `pnpm worklets:verify` | PASS |
| `pnpm check:privacy` (static) | PASS |
| `pnpm test:quality` (real `MLWorker.js` + shipped ONNX, deterministic WASM) | **PASS with documented improvement gaps** |
| `node scripts/quality/quality-matrix.cjs --secs 2` (15 scenarios × 4 profiles) | Ran to completion; results in §8 |
| `pnpm audit --prod` | **3 vulnerabilities: 1 high, 2 moderate** (§7) |
| `pnpm provenance:validate` (default) | PASS with 3 notices (web unknown, android/windows stale) |
| `pnpm provenance:validate:strict` | **FAIL** |
| `pnpm prod:verify:static` | **18 PASS / 1 FAIL** — `model-delivery` (§3, D1) |

**Not run here (environment limits — never treat as passing):** all Chromium browser tiers (`test:live`, `test:shell-qa`, `test:engineer`, `test:calibration`, `test:privacy-runtime`, `test:landing`, `test:ui`, `test:quick-clean`, `test:tier-picker`, `test:sw-offline`), network tier (`downloads:validate`), Electron desktop tier, Android/Electron packaging, listening tests. *Evidence for why:* Playwright Chromium download fails in this sandbox (`cdn.playwright.dev` TLS-blocked, egress limited to github/npm/pypi hosts) and no system Chromium exists.

**GitHub state (via `gh`)**
- Open PRs: **1** — #859 "Upgrade stripe to 23.0.0" (bot-generated, `MERGEABLE`, 2026-10-21; `payment_method_types` → `allowed_payment_method_types`, API version `2026-09-30.endive`).
- Open issues: **4** — #790 (stale QA prompt doc), #789 (production page loads Google Fonts), #788 (BLOCKER: Drive QA folder lacks test-audio pack), #592 (Google-only sign-in).
- **CI is entirely down:** 0 successes in the last 40 `ci.yml` runs (since ≥2026-10-29). Run annotation: *"The job was not started because your account is locked due to a billing issue."* Recent merges to `main` (#879, #883, #884, gate-attack migration, dead-code cleanup) landed **without a passing production gate**.

**TODO/FIXME inventory:** 2 markers in first-party code — `src/core/ModelManifest.js:175` (`sizeBytes: null // TODO`) and `:180` (`// TODO: Model file not yet available`), both on the unshipped `bsrnn_complex` placeholder.

---

## 2. Executive Assessment

**Condition:** an unusually disciplined codebase. The architecture (Stem-Split & Live-Mix, 4-layer ESM, single-STFT contract, cooperative scheduling) is real: 246 green suites pin the invariants; structural validation, model integrity, worklet integrity, privacy invariants, and an SI-SDR quality gate with pinned baselines all exist and pass locally. File ingestion (magic-byte sniffing, image rejection, timeouts, cancellation), cancellation (cooperative + worker recycle), stale-result suppression (request IDs, `JobController` supersession, `AnalysisCoordinator` generations), and content-keyed caching (`sk3` full-content digest) are implemented *and tested* — several common audit wish-list items are already done here.

**Biggest blockers are operational and quality-shaped, not architectural:**

1. **CI is dead (GitHub billing lock)** — the "single definition of verified" cannot run; nothing can be safely gated or deployed.
2. **Core audio quality is the product gap.** The two shipped spectral models are single-frame nets trained from scratch for 600 steps on synthetic mixtures (`scripts/export_onnx_models.py:361-381`). Both the pinned gate and the 15-scenario matrix show the default chain *lowers* SI-SDR on several noisy conditions, Maximum cuts fricatives −10…−13 dB, and DeepFilterNet3 is catastrophic on whispers/babble (§8). This needs a measured model-quality program, not UX polish.
3. **Release truth is stale:** strict provenance fails; the published Android artifact is a debug-sideload APK; native artifacts predate `main`.
4. **The Forensic experience — one of the four promised surfaces — is the least complete:** the audit log hashes only channel 0 of stage buffers (`public/app/app.js:7929-7951`); no source-file SHA-256 identity, no per-export provenance manifest, no reproducibility record.
5. **Two competing analysis stacks** (`AutoAnalysis` for Landing/Unified UX vs `FullAnalysis(+Host)` for Engineer) with a live placeholder (speakers always `[]`) in the newer one.

Architectural surgery is **not** indicated. The right moves are small: repair the gate, consolidate registries, wire existing diarization into the new analysis, and invest in model quality behind an extended test corpus.

---

## 3. Confirmed Defects (evidence-backed)

| # | Defect | Evidence | Status |
|---|---|---|---|
| D1 | **`prod:verify` static tier is not hermetic and is gated by an optional, unshipped model.** `scripts/prod-verify.mjs:76` runs `scripts/validate-onnx-models.js`, which HEAD-checks remote Vercel Blob URLs and **fails the entire gate** if `demucs_v4_quantized.onnx` (optional, `shipped:false`) is unreachable, reading a *second* registry (`public/app/models-manifest.json`) instead of `ModelManifest.js`. | Executed `node scripts/validate-onnx-models.js` → FAIL on `demucs` URL; local models pass. `prod:verify:static` → `model-delivery FAIL`. | Confirmed (code + run). Pass-with-network behavior *unverified* (sandbox blocks `blob.vercel-storage.com`); CI behavior unknown while CI is down. |
| D2 | **Production dependency vulnerabilities; overrides pin still-vulnerable versions.** `body-parser` <2.4.0 (HIGH DoS, GHSA-27r3-jxmh-p828), `qs` ≤6.16.0 (moderate, GHSA-6pq8-jhm2-2vcw), `ip-address` ≤10.7.3 (moderate, GHSA-rxp7-6hxx-x8q5). `package.json` overrides pin `body-parser@2.3.0` and `qs>=6.16.0` — one patch behind fixed releases. | `pnpm audit --prod` executed. | Confirmed. |
| D3 | **Auto-analysis speaker detection is a hard-coded placeholder.** `src/core/audio/analysis/AutoAnalysis.js:318-321` returns `speakers = []` ("For now, empty — real implementation would use diarization.js") while README claims auto analysis includes "speaker detection". `AnalysisOverlays.SECONDARY_SPEAKER` can never fire from Landing import analysis. Real diarization exists at `src/pipeline/SpeakerDetection.js` → `DiarizationWorker` → `src/core/diarization.js`. | Callers: `public/app/premium-workspace.js:632`, `public/landing.js:1327`. | Confirmed (claim/behavior mismatch). |
| D4 | **The published Android artifact is a debug build.** README: "The Android artifact is a **debug/sideload APK**"; `pnpm android:build` → `gradlew assembleDebug`. Release hardening (`WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)`, `MainActivity.java:163`) is correct — but the *shipped* binary isn't a release build. | README release table; `package.json` scripts. | Confirmed (release-integrity defect). |
| D5 | **No upload size limit.** `src/pipeline/FileIngestion.js:40`: `const MAX_FILE_BYTES = Number.MAX_SAFE_INTEGER`. Mitigations exist (adaptive decode timeouts ≤180 s, streaming reads, USM 768 MB working cap, tier budgets) but nothing prevents a decode attempt larger than device RAM → OOM/tab death on mobile. | Code cited. | Confirmed *gap*; OOM crash *unverified* (not reproduced). |
| D6 | **Production loads Google Fonts (external GET).** `server/securityHeaders.js` + `vercel.json` CSP allow `fonts.googleapis.com`/`fonts.gstatic.com`. Matches open issue #789. Not audio egress; violates strict "no third-party origins" posture. | CSP strings `server/securityHeaders.js:60-70`, `vercel.json:126,139`. | Confirmed (tracked as #789). |
| D7 | **Dead code in hot worker:** `classifyWebGpuFailure` assigned but never used — `src/workers/MLWorker.js:295`. | `pnpm lint`. | Confirmed (minor). |
| D8 | **CI production gate has not passed for ≥4 days** (billing lock) while merges continue. | `gh run list` (0/40 successes; billing-lock annotation). | Confirmed (process defect, external). |

Explicitly **checked and NOT defective** (verified sound): image/invalid-MIME rejection (`src/core/media-types.js`, `FileIngestion.assertIngestibleAsync` — images/MIDI refused, magic-byte sniffing for octet-stream); stale-result overwrite (`JobController` supersession + worker `requestId` + `AnalysisCoordinator` generation orphans → `StaleAnalysisError`; tests `analysis-cooperative.test.js`, `ml-worker-cancellation-behavior.test.js`, `mope-responsiveness-cancel.test.js`); cache correctness on file change (`MLStemCache` `sk3` full-sample MurmurHash3 digest + `modelChainRevision` in `DerivedCache` keys — the sk2 sparse-probe collision class is already fixed and documented); single-STFT invariant (`single-stft-assert.test.js`, `architectural-invariants.test.js`); Electron security config (`electron/main.cjs:274-281` verified `contextIsolation:true, nodeIntegration:false, sandbox:true`); no audio egress (static checks pass; runtime egress recorder exists in CI browser tier); deterministic core DSP (NMF seeded `seed=42` `UniversalSourceMatrix.js:347`, deterministic k-means init `diarization.js:279`; only WAV dither uses `Math.random()` — `ExportManager.js:53`).

---

## 4. Incomplete Features

| # | Feature | Where | State |
|---|---|---|---|
| I1 | `bsrnn_complex` (4-D complex BSRNN) | `ModelManifest.js:171-203` | Manifest placeholder only (`sha256:null`, `sizeBytes:null`, 2 TODOs). |
| I2 | `sam_audio` ONNX on-device path | `ModelManifest.js:300-321`, `src/core/providers/*` | Placeholder ("Place a verified SAM-Audio ONNX export at this path"). Real path = desktop Python worker (`services/sam-audio/server.py`, hardened loopback; mock mode in dev); browser/Android fall back to USM query priors. |
| I3 | `universal_separator` (AudioSep-class) | `ModelManifest.js:323-345` | Placeholder (`sha256:null`). Classical NMF + language-prior USM **is** shipped (`UniversalSourceMatrix.js`). |
| I4 | Forensic audit log | `public/app/app.js:7929-7951` | Wired (`auditLogBtn`) but records only `{stage, SHA-256(channel-0), ts}` — no source-file hash, model ids/versions, parameters, output-file hashes, cancel/failure entries, or manifest integrity. |
| I5 | Export formats | `ExportOrchestrator.js:32,233` (`format !== 'wav'` throws) | WAV-16 only (dither modes 0–3). ExportControls honestly offers one option. |
| I6 | Release provenance | `docs/releases/release-provenance.json` | Schema+validator excellent; content stale/unknown ×3; strict mode fails. |
| I7 | Unified Premium UX (#820) | `docs/ui/unified-premium-ux-820.md`, `premium-workspace.js`, `src/ui/components/*` | Mostly implemented (signal canvas, selection, palette, Raw/Processed/Removed, profiles, tokens) but inherits D3; spec still says "Import/**Record**" though recording is architecturally forbidden. |
| I8 | Target-speaker enrollment | `src/core/TargetSpeaker.js`, `SpeakerEmbeddingWorker` | ECAPA path optional/not-bundled (~25 MB, `pnpm models:fetch-ecapa`); mel-voiceprint fallback EER 37% (documented) — functional but weak. |
| I9 | Whisper Forensic multi-pass DSP | `app.js:8400+` (`runForensicPasses`, `platformProfile.forensicCap`) | Implemented and platform-capped; real-whisper quality unverified. |
| I10 | Batch processing | `public/app/batch-orchestrator.js`, `batch-processor.js` | Built + tested but unreachable from any UI; header references the deleted live-mic monolith. Awaiting keep/retire decision. |

---

## 5. Missing Features (vs. the four-experience target)

1. **Per-export forensic provenance manifest** — original-file SHA-256 (note: `content-hash.js` is MurmurHash3-128, explicitly *not* a security primitive), source metadata, timestamps, app/pipeline/`INFERENCE_REVISION` versions, model ids + pinned hashes, parameter snapshot, output hashes, operation history incl. failed/cancelled, self-integrity. Building blocks exist (`ResearchSession`, `ProjectPack`, `ParameterSchema.snapshotParams`, forensicLog) but are not composed into an export sidecar.
2. **Source hash verification UI** (Forensic): display/verify SHA-256 of the original file; detect post-hoc mutation.
3. **Real-recording evaluation corpus + perceptual metrics** (STOI/ESTOI, PESQ, WER, segmental SNR) and a listening-test protocol — the gate is synthetic-only (documented).
4. **Overlapping-speaker separation** — diarization contract is non-overlapping segments (`diarization.js` header); matrix scenario `overlap-2spk` shows negative SI-SDR delta on *every* profile (§8).
5. **Speaker detection in Landing auto-analysis** (D3).
6. **Engineer model-selection/capability surface** — chains chosen via outcomes (Landing `modelSelect` = "Outcome"); `CapabilityChecker.js` exists but is not surfaced.
7. **Export formats** beyond WAV (decision + license-safe encoder).
8. **Android thermal/low-memory instrumentation** — `PerformanceTier.js` is feature-detected (good) but nothing observes thermal state (no thermal handling anywhere in the tree).
9. **WER-based intelligibility evidence** for the whisper/forensic marketing claims.
10. **Non-Google auth** (#592) and the QA test-audio pack (#788).

---

## 6. Model and Technology Assessment

Shipped and verified present (`public/app/models/`, hash-pinned in `ModelManifest.js`, `pnpm validate` checks bytes): `bsrnn_vocals.onnx` (3.9 MB), `rnnoise_suppressor.onnx` (2.0 MB), `silero_vad.onnx` + `_int8` (2.3 MB each), `dfn3_enc/erb_dec/df_dec` (8.6 MB). Default chain `['bsrnn_vocals']` (`src/core/ml-defaults.js`).

| Technology | Status | Assessment / recommendation |
|---|---|---|
| **BSRNN (as shipped `bsrnn_vocals`)** | **Partial** — shipped but it is a small custom band-split LSTM (600 steps, synthetic data), not research-grade BSRNN | Naming invites over-claiming. Quality ceiling is the #1 product issue. Research-grade BSRNN weights are a Phase-3 candidate behind VIP-006; verify checkpoint license before anything is bundled (research weights are often non-commercial). |
| **DeepFilterNet3** | **Implemented** (composite manifest, own 960-pt STFT branch, `src/workers/DeepFilterNet.js`, MIT OR Apache-2.0, license file shipped) | Real win on some noise (noise-only suppression 42 dB; white-5db +2.6 delta on enhance) but **catastrophic on whispers and babble** (matrix: whisper-clean/enhance SI-SDR out −16.5 dB, fricative −31.2 dB; babble/enhance delta −17.2 dB). Keep opt-in "Enhance Speech"; never default for whisper/babble content; add UI guardrail (VIP-005). |
| **SCNet** | **Missing** — zero references in repo | Best Phase-3 candidate (efficient multi-stem separation; quality/FLOP far above current nets). Prototype: ONNX export spike, ORT-Web feasibility, memory/RTF profile, license review. Do not commit without gates. |
| **BS-RoFormer** | **Research candidate** (named in `docs/archive/REIMAGINE-multi-frame-models.md`: "SOTA quality, heaviest; WebGPU-gated") | Evaluate only after SCNet data; likely desktop/WebGPU-only; checkpoint licenses commonly restrictive. |
| **Silero VAD** | **Implemented** (fp32 + int8, pinned; `VadAnalysis.js` with SoftVad fallback) | Keep. Gap: Landing `AutoAnalysis` uses classical detection only — unify (VIP-032). |
| **ECAPA-TDNN** | **Partial** — integrated (`SpeakerEmbeddingWorker`, Kaldi-fbank, measured EER 1.9%) but optional/not bundled | Decide bundle-vs-fetch per platform; wire cluster-mean embeddings into diarization fusion (path specified in CLAUDE.md §7) to lift the weak k-means baseline. |
| **MossFormer2** (overlapping speech) | **Missing** | *Not recommended for browser* (size/runtime). If pursued, prototype as an Electron local Python worker (SAM-Audio pattern) or research a lighter permutation-free separator. Phase 4 research only. |
| **AudioSep** (text-conditioned) | **Partial** — classical NMF + language priors shipped; ONNX placeholder | Keep classical (always-local, deterministic); ML path research-only; pin or remove the manifest placeholder (VIP-017/VIP-012). |
| **CLAP** | **Missing / research** | Only useful atop USM labeling; heavy encoders. Defer unless labeling quality proves insufficient. |
| **ONNX Runtime Web** | **Implemented** (vendored `ort.min.js` 1.25.1, never CDN — invariant-tested) | Keep. |
| **WebGPU** | **Implemented with real fallback engineering** (per-session pin after compile/OOM failure, device-loss handling, backend-specific batch caps — `MLWorker.js:74-101,274-288`; `ml-worker-webgpu-fallback.test.js`) | Template for optional accelerators. |
| **WASM SIMD/threaded** | **Implemented** (vendored `ort-wasm-simd-threaded*`; COOP/COEP enforced incl. Android) | Keep. |
| Demucs v4 (int8, ~149 MB) | Optional/unshipped (`gitignore`d) | Keep unshipped — but it currently *gates the release gate* (D1), which is backwards. |

**License inventory gaps:** `ModelManifest.js` records licenses for DFN3 parts and ECAPA; `silero_vad*` and the project-trained models carry no `license` field. Add SPDX fields to every entry (cheap; powers the Forensic surface). Any research checkpoint (BS-RoFormer/BSRNN-pretrained/MossFormer2/AudioSep/CLAP) needs license verification before download or bundling.

---

## 7. Security and Privacy Findings

**Strong (verified):** strict CSP with scoped legacy-inline exception (`/app`, `/blueprint`, `/docs` only); `Permissions-Policy: microphone=()`; COOP/COEP; no `getUserMedia` in product code (invariant-tested); no audio-processing endpoints (`check-no-cloud-audio` PASS); model SHA-256 verified before ONNX session creation; `LICENSE_JWT_SECRET` env-only, production fail-fast + dev ephemeral-per-process warning (`api-routes/entitlements.js:26-36`); no auth API (deleted by design); Electron `contextIsolation/nodeIntegration/sandbox` + preload-only IPC + `navigation-policy.cjs` + hardened `sam-proxy.cjs` (refuses non-loopback, checks `/health` identity, caps jobs/size); Android WebView debugging tied to `BuildConfig.DEBUG`; SAM-Audio worker refuses browser `Origin`, loopback-only, never logs audio; Google Drive = user-initiated file I/O only (ADR-002); Stripe/Resend server-side; `store.js` owner-only perms (POSIX-tested); static + runtime egress audits (`privacy-runtime-smoke.cjs` records every request/WS/beacon/RTCPeerConnection in Chromium — CI browser tier).

**Findings:**
1. **D2 — dependency CVEs** (1 high, 2 moderate). Fix = two override bumps + re-audit.
2. **D6/#789 — Google Fonts** external GET on production page load.
3. **D4 — debug APK** as the official Android artifact.
4. **`vip://` sets no CSP in Electron** (documented, compensated by sam-proxy rules) — defense-in-depth gap (P2).
5. Remote/blob-hosted optional models: pinned in the manifest and hash-checked by `MLWorker` on fetch (mismatch refused) — acceptable; `models:validate` honestly notes remote hashes "not claimed as passed".
6. **PR #859 (Stripe 23)** unreviewed bot PR against payment code — needs human review + test-mode payment before merge.

**Provenance/forensic integrity evaluation:** existing pieces — stage hashes of channel 0 (`app.js:7929`), `ResearchSession` JSON experiment log (opt-in `research-mode.js`, wired), `ProjectPack` (.vippack handoff with manifest), `release-provenance.json` (release-level, schema-validated). Missing for a useful integrity record: original-file SHA-256, model/version/param embedding in export sidecars, operation history incl. failures/cancellations, output-file hashing, manifest self-integrity, deterministic-export option (dither uses `Math.random()` — `ExportManager.js:53`; acceptable audio practice, fatal for bit-reproducibility claims). **Nothing here supports claims of forensic certification or chain-of-custody compliance.** A well-built manifest is an integrity *record*, not legal evidence by itself.

---

## 8. Performance and Audio Quality Findings

**Audio quality — measured in this audit (real `MLWorker.js` + shipped models, deterministic single-thread WASM):**

`pnpm test:quality` (9 fixtures × 4 profiles, pinned baseline) **passes**, with these pinned realities: default-chain SI-SDR deltas negative on `white-5db` (−1.0 landing), `hvac-5db` (−0.4…−0.6), `hum-10db` (−2.1…−2.8); Maximum-chain fricatives −10…−13 dB; `music-0db` deltas negative on all profiles.

`quality-matrix --secs 2` (15 scenarios × 4 profiles, warm compile) adds independent confirmation (columns: SI-SDR in/out/delta, speech-level Δ, HF 4–12 kHz Δ, fricative Δ, gap-leak, noise reduction, peak, RTF):

| Finding | Numbers (landing / engineer / maximum / enhance) |
|---|---|
| Whisper suppression by Enhance | `whisper-clean/enhance` SI-SDR out **−16.5 dB** (fricative Δ −31.2, HF Δ −34.7); `whisper-white-10db/enhance` delta **−7.4 dB**; `whisper-music-5db/enhance` **−6.3 dB** |
| Babble destroys Enhance | `babble-0db/enhance` delta **−17.2 dB** (others −0.9…−1.1) |
| Clipped input destroys Enhance | `clipped/enhance` SI-SDR out **−5.4 dB** (others keep +8…+9) |
| Overlapping speakers bad everywhere | `overlap-2spk` delta negative on **all** profiles (−0.9 … −17.2) |
| Maximum-chain fricative cost | fricative Δ −10…−13 dB on every speech scenario |
| Speech-level attenuation | all chains −1…−9 dB (enhance often worst) |
| Noise-only suppression | 5.0 / 7.2 / 9.7 / 42.6 dB (landing/engineer/maximum/enhance) |
| Silence sanity | peak = 0.000 on all profiles (no false signal) |
| **RTF (warm, 2 s fixtures, this machine)** | **0.08–0.59** across all rows — desktop compute is not the bottleneck |

Caveat: synthetic fixtures are proxies (documented); `--secs 2` rows are short; RTF figures are desktop-warm, not mobile.

**Performance (evidence mix, labeled):**
- *Verified present:* cooperative time-budgeted yielding (`ui-yield.js`), `dsp-worker.js` offload, O(1) dereverb recurrence, single feature-extraction pass fix (PR #883; `FullAnalysis.js:60-82` `opts.extraction` reuse — consistent with the 2026-11-01 audit's measured 43–47% analysis speedups), import-window de-dup (`vip:fileImported` `detail.analysis`), stem-cache digest memoisation, `PerformanceTier` byte budgets (160/384 MB/unbounded), USM 768 MB working cap, warmup + per-session batch caps, process timeout 180 s, progress-stall fail-fast 45 s, cancel-grace worker recycle 1.5 s.
- *Verified measured here:* Jest 223 s; quality gate 28 s; matrix 38 s; RTF table above.
- *Not verified here:* browser long-task/cancel-latency/mobile figures (perf harness `scripts/perf/perf-harness.cjs` exists — records timings, asserts stability only).
- **Gap — mobile thermal:** no thermal observation or adaptive degradation anywhere (searched tree). Sustained jobs on throttled CPUs risk hitting fixed timeouts. Add thermal status → degrade (batch caps, longer timeouts with UI notice) or at minimum measure on throttled devices (VIP-022).
- **Gap — time-to-first-result:** measure first (`perf-harness --import-settle`), then consider moving `AutoAnalysis` feature passes to a worker (pattern exists in `FullAnalysisHost`). **No optimization without a named bottleneck** (per instructions); `mobile-freeze-regressions.test.js` must stay green.
- **Cancellation latency:** cooperative per batch (`CANCEL_POLL_MS`) in MLWorker and per budget-window (~21 ms) in analysis; a single in-flight `session.run` cannot be interrupted (documented, acceptable). 2026-11-01 audit measured 46.8 ms cancel stop for a 30 s cooperative pass.

---

## 9. UI/UX TODOs

**Standard (Landing):** largely complete (drag-drop/Drive import, auto analysis with regions/overlays, Outcome select, 4 profiles, cancel, progress, playback, Raw/Processed/Removed, WAV export). TODOs: wire speakers into auto analysis (VIP-007); whisper-safety guard on "Enhance Speech" (VIP-005); make "Boost Whisper"/"Forensic Extract" recommendations evidence-based (current trigger heuristic `voiceRatio < 0.18`, `app.js:8367`); fix #820 spec "Record" language.

**Advanced (Live-Mix + comparison):** deep and real — stem lanes, per-speaker volume/mute/solo with 0–200% enhance, instant A/B comparison lanes with level matching (`PlaybackMixer.js`, `ComparisonLevelMatch.js`), gate/de-esser playback worklets, transport crop/loop. TODOs: browser-verify every #820 palette action maps to real processing (VIP-021 — *unverified here*); Removed-residual audition on Landing.

**Engineer:** strong (67 controls, locks, presets, hints, calibrated sliders, integrity card, USM panel, target speaker, diarization timeline, analysis workspace, research/benchmark panels). TODOs: model-selection/capability panel (VIP-019); make the "DSP Integrity" card read real pipeline diagnostics (currently mirrors DOM state, `engineer-console.js:694`); feed performance metrics from `PipelineTiming`/`BenchmarkHarness`.

**Forensic:** weakest. TODOs: source SHA-256 + verify (VIP-011), provenance manifest export (VIP-010), operation history incl. failed/cancelled, reproducible-processing record (VIP-040), spectral inspection extensions. Every new control must bind to real processing — the provenance panel binds to real hash/manifest computation (not decoration).

**Cross-cutting:** one session/engine across surfaces is mostly held (`audioSessionStore` + shared `StemSeparation`); the two analysis stacks are the main coherence risk (VIP-032).

---

## 10. Master TODO Register

Format: **ID · Priority · Category · Task · Current state · Evidence · Required work · Dependencies · Risk · Complexity · Acceptance criteria · Validation.**

### P0 — Critical

**VIP-001 · P0 · release — Restore the production gate (GitHub Actions billing lock).**
State: broken (external). Evidence: `gh run list` 0/40 successes since ≥2026-10-29; billing-lock annotation. Work: resolve billing; re-run `ci.yml` on `main`; require green before any merge/deploy. Deps: none (blocks everything). Risk: none to code. Complexity: Low (external). AC: `ci.yml` green on `main` tip. Validation: `gh run list`; `prod:verify` report with commit SHA.

**VIP-002 · P0 · security — Patch production dependency vulnerabilities.**
State: broken. Evidence: `pnpm audit --prod`; overrides pin `body-parser@2.3.0` / `qs>=6.16.0`. Work: bump to `body-parser≥2.4.0`, `qs≥6.16.1`, `ip-address≥10.7.4` (or transitive via express/express-rate-limit); re-audit. Deps: VIP-001 to merge safely. Risk: express 5 body-parsing behavior (low). Complexity: Low. AC: `pnpm audit --prod` clean. Validation: `pnpm audit`, `pnpm test`, `pnpm test:monetization:e2e`.

**VIP-003 · P0 · release — Make `prod:verify` static tier hermetic; stop gating on optional models.**
State: broken. Evidence: `scripts/prod-verify.mjs:76` → `validate-onnx-models.js` (network HEAD checks; second registry `public/app/models-manifest.json`; fails on unshipped `demucs`); observed FAIL. Work: move `model-delivery` to the `--network` tier (or skip-with-notice when unreachable/optional); route checks through `ModelManifest.js`; keep `validate-model-integrity.mjs` as the hash gate. Deps: none. Risk: lose remote-liveness monitoring (retain in network tier). Complexity: Medium. AC: `prod:verify:static` passes offline; network tier still checks remote delivery. Validation: run both tiers; unit-test optional-model handling.

### P1 — High

**VIP-004 · P1 · audio/ML — Model-quality program for the shipped spectral chain.**
State: partial (weak models pinned as baseline). Evidence: `export_onnx_models.py:361-381` (600-step synthetic); `quality-baseline.json`; matrix §8. Work: extend corpus (VIP-006); train/evaluate stronger (multi-frame) masks with `quality-gate.cjs --update` diffs as the review record; grow `improvementRequired` (VIP-034). Deps: VIP-006. Risk: overfitting synthetic gate (mitigate: real corpus + listening). Complexity: High. AC: `white-5db`, `hvac-5db`, `hum-10db` SI-SDR-delta ≥ 0 for landing/engineer chains with fricative level no worse than −6 dB. Validation: `test:quality`, `quality:matrix`, listening panel.

**VIP-005 · P1 · audio/UX — Whisper & quiet-speech preservation.**
State: partial (feature exists; quality mismatch). Evidence: gate + matrix whisper rows (enhance −7…−17 dB); `WhisperLogic.js`; `runForensicPasses` (`app.js:8400`); CLAUDE.md "do not claim whisper safety" for DFN3. Work: UI guardrail (warn/auto-route whisper-flagged audio away from DFN3); tune chain exponents/whisper DSP vs whisper fixtures; bind the "Whisper Retention" metric to measured whisper-band energy. Deps: VIP-006. Risk: further consonant loss (fricative metrics guard). Complexity: Medium. AC: enhance never lowers whisper-region SI-SDR >1 dB vs input when whisper regions detected; whisper fixture deltas ≥ 0. Validation: quality gate whisper scenarios + listening.

**VIP-006 · P1 · testing — Real-recording quality corpus + extended metrics.**
State: missing. Evidence: `docs/guides/AUDIO_QUALITY.md` ("proxies"); no PESQ/STOI/WER in tree. Work: license-clean recorded-speech set (e.g. LibriSpeech-derived + DEMAND-style beds + field samples), STOI/PESQ/WER tooling (permissive, offline), MUSHRA-style listening protocol; expose as `test:quality:real` (audio external to git). Deps: VIP-001. Risk: corpus licensing (keep CC0/permissive). Complexity: Medium. AC: repeatable command producing SI-SDR/STOI/PESQ/WER tables over ≥30 real clips across 4 noise classes. Validation: runbook + committed metric schema.

**VIP-007 · P1 · ML/UX — Wire diarization into AutoAnalysis speaker detection.**
State: broken placeholder. Evidence: `AutoAnalysis.js:318-321`; real path `SpeakerDetection.js`/`DiarizationWorker.js`. Work: call `SpeakerDetectionSession` (or adapt `diarization.js` output to `speakers` + `SECONDARY_SPEAKER` overlay) preserving cooperative/abort semantics. Deps: none. Risk: analysis latency (run non-blocking after core metrics). Complexity: Medium. AC: Landing import analysis populates speakers/overlay on 2-speaker audio; placeholder removed. Validation: unit tests + `test:landing` smoke.

**VIP-008 · P1 · release — Ship release-signed Android (optional: Windows signing).**
State: broken (debug artifact published). Evidence: README; `android:build` = `assembleDebug`. Work: release keystore → `android:release`/`android:bundle` scripts; publish AAB+APK with `SHA256SUMS`/`release-manifest.json` (workflow exists); update download page. Deps: VIP-001. Risk: keystore management; sideload continuity. Complexity: Medium. AC: published Android asset is a release build; `downloads:validate` passes; provenance regenerated. Validation: `verify-android-complete.mjs`, device install.

**VIP-009 · P1 · reliability — File-size policy & OOM guards.**
State: missing cap. Evidence: `FileIngestion.js:40`. Work: tier-based soft cap (warn/refuse thresholds with clear errors), pre-decode duration×channels memory estimate, document long-file support. Deps: none. Risk: false refusals (configurable + explained). Complexity: Low-Medium. AC: oversized upload refused deterministically; 5-min and 60-min fixtures within memory budgets (`perf-harness` `pageMem`). Validation: unit tests + `perf-harness --mobile`.

**VIP-010 · P1 · forensics — Export provenance manifest v1.**
State: missing. Evidence: `app.js:7929-7951`; uncomposed `ResearchSession`/`ProjectPack`. Work: `.viprovenance.json` sidecar on every export: original-file SHA-256 (WebCrypto, worker), source metadata, timestamp, app version + `INFERENCE_REVISION` + `modelChainRevision`, model ids+sha256, `snapshotParams`, output SHA-256, op history incl. failed/cancelled (`JobController`), schema version; optional detached manifest hash. Wording: "integrity record — not certification". Deps: VIP-011. Risk: user confusion re: legal status (wording); hash cost (worker). Complexity: Medium. AC: every export has a sidecar verifiable by a checker script; Forensic UI displays it. Validation: unit tests incl. tamper detection.

**VIP-011 · P1 · forensics — Source SHA-256 + verification UI.**
State: missing. Evidence: cache key is MurmurHash3 (`content-hash.js`: "not a security primitive"). Work: SHA-256 of source bytes at import (worker + progress), display + "verify source" re-hash, mismatch warnings; keep MurmurHash for caches. Deps: none. Risk: large-file import cost. Complexity: Low-Medium. AC: SHA-256 shown for any imported file; re-verification detects mutation. Validation: unit + UI smoke.

**VIP-012 · P1 · architecture — Consolidate model registries.**
State: drift. Evidence: `ModelManifest.js` (canonical) vs `public/app/models-manifest.json` (packaging + URL list used by `validate-onnx-models.js`); `MODEL_DELIVERY.md` "Why Models Are Not Committed" contradicts 18 MB of committed `.onnx` (`git ls-files`). Work: generate the packaging manifest from `ModelManifest.js`; fix docs. Deps: VIP-003. Risk: tooling reading models-manifest.json (`prepare-android-complete`, `sw-precache`). Complexity: Medium. AC: single source of truth; docs consistent. Validation: `pnpm validate`, build + worklet checks.

### P2 — Medium

**VIP-013 · P2 · ML — SCNet prototype & evaluation.** State: missing. Work: ONNX export spike, ORT-Web WebGPU/WASM feasibility, memory/RTF profile (`BenchmarkHarness`), license review. Deps: VIP-006. Risk: mobile memory. Complexity: High. AC: written eval (SI-SDR vs incumbent, size, RTF) with go/no-go. Validation: quality gate + perf harness.
**VIP-014 · P2 · ML — BS-RoFormer / research-BSRNN evaluation.** Same shape as VIP-013; **checkpoint license is the hard gate** (verify before download). Deps: VIP-013.
**VIP-015 · P2 · ML — ECAPA-TDNN packaging decision + diarization fusion.** Work: bundle-vs-fetch per platform; wire cluster-mean ECAPA fusion (CLAUDE.md §7 table) into `diarization`. Deps: VIP-007. AC: diarization EER improves on `scripts/quality/speaker-eval.mjs` 10-speaker set. Complexity: Medium.
**VIP-016 · P2 · ML — Overlapping-speaker handling (research).** Survey permutation-free/light separators; desktop-worker prototype (SAM-Audio pattern) before any web claim. Deps: VIP-015. AC: research doc + prototype metrics; explicit web no-go unless size/RTF gates pass.
**VIP-017 · P2 · ML — Text-conditioned isolation (AudioSep-class).** Evaluate real AudioSep ONNX (license/size); pin `universal_separator` or remove placeholder; keep classical fallback. Deps: VIP-012.
**VIP-018 · P2 · ML — CLAP sound-event labeling (research/defer).** Only if USM label quality proves insufficient.
**VIP-019 · P2 · UX — Engineer model selection & capability panel.** Surface `CapabilityChecker` + manifest (task, size, quantization, backend) as read-only inspector + chain display (`activeModelChain` exists); expert override maps to `modelIds` chains clamped by presets. Deps: VIP-012. AC: every control changes real processing. Complexity: Medium.
**VIP-020 · P2 · UX — Forensic interface v2.** Provenance panel (VIP-010/011), operation history, region spectral metrics, reproducibility toggles. Deps: VIP-010, VIP-011.
**VIP-021 · P2 · UX — Pin every #820 palette action to real processing.** Browser QA matrix (Isolate/Enhance/Reduce Noise/Boost Whisper/Preview); wire or remove decorative controls. Validation: `test:ui`, `test:shell-qa`.
**VIP-022 · P2 · performance — Android thermal/low-end behavior.** Thermal status listener → degrade (batch caps, longer timeouts with notice); measure low/mid devices. Deps: VIP-028.
**VIP-023 · P2 · performance — Time-to-first-result for auto-analysis.** Measure first (`perf-harness --import-settle`); then worker-offload `AutoAnalysis` passes (pattern: `FullAnalysisHost`). Guard: `mobile-freeze-regressions.test.js` green.
**VIP-024 · P2 · security — Self-host Google Fonts.** Vendor WOFF2 to `public/fonts`; drop googleapis/gstatic from both CSPs. AC: `privacy-runtime` shows zero third-party requests. Complexity: Low. (#789.)
**VIP-025 · P2 · security — CSP for `vip://` in Electron.** Set CSP in the custom protocol handler; keep sam-proxy rules. Complexity: Medium.
**VIP-026 · P2 · release — Stripe v23 decision (PR #859).** Review; `test:monetization:e2e` + test-mode payment; upgrade webhook API version per PR notes; merge or close with comment. Complexity: Medium.
**VIP-027 · P2 · product — Auth scope decision (#592).** Google-only blocks users; decide license-token-only entitlements or second IdP. (Product decision first.)
**VIP-028 · P2 · testing — Device test matrix execution.** Real hardware runs of §13 matrix; record in `docs/audits/`. Complexity: Medium (logistics).
**VIP-029 · P2 · testing — Long-file soak (1–2 h).** `perf-harness` long runs; export blob-size limits; durable-cache pressure (`DerivedCache`). Deps: VIP-009.
**VIP-030 · P2 · docs — Close #790 (stale QA prompt) and #788 (Drive QA test-audio pack).** Complexity: Low.
**VIP-031 · P2 · ML — Diarization quality upgrade.** ECAPA fusion (VIP-015) or better clustering; confidence calibration for UI. Deps: VIP-007.
**VIP-032 · P2 · architecture — Unify analysis stacks.** One canonical analysis contract (CLAUDE.md §2.2: `AnalysisCoordinator` + `AnalysisSnapshot`); make `AutoAnalysis` an adapter or document both with shared extraction. **Do not build a third path.** Risk: largest architectural item — sequence carefully. AC: one snapshot schema end-to-end; `validateAnalysisSnapshot` on all producers. Complexity: High.
**VIP-033 · P2 · UX/product — Export format decision.** Keep WAV-only (document) or add FLAC first (license-safe); MP3 only with a clean encoder. Deps: VIP-010 (sidecar covers all formats).
**VIP-034 · P2 · testing — Grow the improvement tier.** Add `white-5db/engineer`, `hvac-*`, `hum-*`, `overlap-*` pairs as they cross 0; never shrink the list. Deps: VIP-004. Complexity: Low.

### P3 — Future

**VIP-035 · P3 · architecture — Retire orphaned legacy** (`batch-orchestrator.js`, `batch-processor.js`, `offline-processor.js`, `public/app/ml-worker.js`): delete with tests, or archive with explicit "not shipped" headers. CLAUDE.md protects some legacy — owner sign-off required before deleting `ml-worker.js`.
**VIP-036 · P3 · cleanup — Lint warnings to zero** (93, incl. `classifyWebGpuFailure`).
**VIP-037 · P3 · docs — Fix MODEL_DELIVERY.md drift** ("Why Models Are Not Committed" vs committed weights; blob-rewrite vs committed path).
**VIP-038 · P3 · release — Provenance automation:** record deployed web SHA; regenerate `release-provenance.json` from produced artifacts; strict mode as the release bar. Deps: VIP-001, VIP-008.
**VIP-039 · P3 · ML — Decide `bsrnn_complex` fate** (export per `export_bsrnn_onnx.py` or remove entry + TODOs).
**VIP-040 · P3 · forensics — Deterministic export option** (seeded dither or forensic default dither-off; record dither setting in provenance).

---

## 11. Dependency Map

```
VIP-001 (CI/billing) ──> everything mergeable/deployable
VIP-002 (deps CVEs) ─┐
VIP-003 (gate fix)  ─┴─> safe release pipeline
VIP-006 (real corpus) ──> VIP-004, VIP-005, VIP-013/014, VIP-034
VIP-009 (size policy) ──> VIP-029
VIP-011 (SHA-256) ──> VIP-010 ──> VIP-020, VIP-033
VIP-007 (diarization wiring) ──> VIP-031, VIP-015 ──> VIP-016
VIP-012 (registry consolidation) ──> VIP-003 cleanup, VIP-017, VIP-019
VIP-028 (device matrix) ──> VIP-022, VIP-023
VIP-008 + VIP-038 ──> Phase-6 release
VIP-032 (analysis unification): independent; do before new analysis features
```

---

## 12. Phased Implementation Roadmap

**Phase 0 — Baseline and verification** (VIP-001, VIP-003, VIP-006-start, VIP-030)
Objectives: gate alive + hermetic; corpus scoped; issues triaged. Deliverables: green `ci.yml` on `main`; offline-passing `prod:verify:static`; corpus spec. Risks: billing resolution time. Testing: full `prod:verify` mirrored in CI. **Done when:** CI green on a fresh PR.

**Phase 1 — Stability and security** (VIP-002, VIP-008, VIP-009, VIP-011, VIP-012, VIP-024, VIP-025, VIP-035-decision)
Objectives: CVEs cleared, signed-artifact path, ingestion limits, hash identity, single registry. Risks: express bumps; Android signing logistics. Testing: `pnpm test`, `test:privacy-runtime`, `models:validate`, `verify-android-complete`. **Done when:** audit clean; release build reproducible; oversized uploads refused deterministically.

**Phase 2 — Audio quality and performance** (VIP-004, VIP-005, VIP-034, VIP-022, VIP-023, VIP-029)
Objectives: default chain ≥0 dB SI-SDR delta on noisy scenarios; whisper safety; mobile reliability. Depends on Phase 0 corpus. Testing: quality gate + matrix + listening + device runs. **Done when:** VIP-004/005 ACs pass and no pinned metric regresses >0.5 dB.

**Phase 3 — Improved source separation** (VIP-013, VIP-014, VIP-039, VIP-012-follow-through)
Objectives: evidence-based upgrade of `bsrnn_vocals` (SCNet first; BS-RoFormer optional), inside the existing `strategy` dispatch + manifest-pin flow (design reference: `docs/archive/REIMAGINE-multi-frame-models.md`). Gates: license, size budget, RTF, quality ≥ incumbent on the corpus. **Done when:** go/no-go recorded; if go, model ships with hash pin + quality re-pin.

**Phase 4 — Audio intelligence** (VIP-007, VIP-015, VIP-031, VIP-016/017/018-research)
Objectives: speakers in auto-analysis, ECAPA fusion, confidence reporting; research-only for overlap/text-conditioned/CLAP. **Done when:** speaker overlays correct on 2–4-speaker fixtures; confidence shown; research docs complete.

**Phase 5 — Professional and forensic workflows** (VIP-010, VIP-011, VIP-019, VIP-020, VIP-032, VIP-033, VIP-040, VIP-021)
Objectives: provenance end-to-end, engineer diagnostics, analysis-stack unification, export decisions. **Done when:** forensic panel emits verifiable manifests; all four experiences share one session/engine (proven by tests).

**Phase 6 — Release readiness** (VIP-026, VIP-027-decision, VIP-028, VIP-036, VIP-037, VIP-038)
Objectives: device matrix validated, offline packaging verified (`prepare-android-complete`/`sw-precache`), privacy/security review sign-off, docs current, strict provenance green after native rebuilds. **Done when:** `pnpm provenance:validate:strict` passes against published assets.

---

## 13. Testing and Acceptance Criteria

**Content matrix:** clean speech · quiet speech · whispered speech · noisy speech (white/HVAC/hum/babble/street) · overlapping speakers · music-with-vocals · environmental/field · long recordings (30–120 min) · large files (≥1 GB) · sample rates 8–96 kHz · mono/stereo/5.1-downmix.
**Device matrix:** low-end Android (4 GB; `--mobile` emulation first), midrange Android, integrated-GPU laptop (WASM path), discrete-GPU desktop (WebGPU), Electron desktop, PWA offline.

**Metrics:** SI-SDR (±delta) — gated today; SDR/SIR/SAR for separation; STOI/ESTOI + PESQ (VIP-006); WER via offline ASR (VIP-006); segmental SNR; fricative-band level (gated — keep); transient preservation; phase coherence (round-trip tests exist); perceptual artifact listening; RTF, peak memory (`pageMem`), startup time, cancel latency, long-task counts, UI responsiveness, failure rate.

**Automation split:**
- *Automated now (keep green):* 246 Jest suites; `validate`; lint; DSP isolation; quality gate (synthetic); privacy static; model/worklet integrity; version sync; provenance schema; `monetization-e2e`.
- *Automated with browser (CI tiers):* shell QA, engineer/landing/quick-clean/calibration/UI smokes, privacy-runtime egress, sw-offline, perf harness (stability asserts).
- *Listening (manual, documented):* artifact A/B on real recordings per release (protocol in VIP-006).
- *Device-level (manual):* device matrix (VIP-028), thermal behavior (VIP-022), install/update flows.

**Global acceptance rule:** no single metric proves quality — hold SI-SDR *and* fricative/speech-level *and* pass listening on whisper + noisy categories before re-pinning (`quality-gate.cjs --update` diff reviewed).

---

## 14. Deferred and Rejected Ideas

- **Live microphone / restored `pipeline-orchestrator.js`:** rejected by architecture (CLAUDE.md §1.1; `microphone=()`; invariant tests).
- **Cloud processing/audio upload:** rejected by product promise + enforced checks.
- **Replacing Stem-Split & Live-Mix or AnalysisCoordinator:** rejected — no structural failure evidence; repairs (VIP-032) are smaller. Never add a second orchestrator.
- **Demucs as default chain:** rejected (149 MB, ORT-Web limits — blueprint HTDemucs note). Keep optional/unshipped.
- **"Forensic certification / chain-of-custody" claims:** rejected — an integrity manifest is achievable; legal certification is not claimable (§7).
- **MossFormer2/CLAP in-browser now:** deferred (size/runtime infeasible without measurements).
- **BS-RoFormer before SCNet:** deferred — heaviest option first is the wrong order.
- **iOS v1:** deferred by explicit platform scope (CLAUDE.md §1.2).
- **Tauri 2 rewrite:** deferred (Electron works and is hardened; pilot noted in CLAUDE.md §9).
- **MP3 export:** deferred (license/complexity; WAV is honest today).
- **Deleting `public/app/` wholesale:** rejected — it is the shipped Engineer surface.

---

## 15. Top 10 Immediate Tasks

1. **VIP-001** — Restore GitHub Actions (billing); get `ci.yml` green on `main`.
2. **VIP-002** — Patch body-parser/qs/ip-address (override bumps) and re-audit.
3. **VIP-003** — Fix `model-delivery` gate step (hermetic static tier; stop gating on the optional Demucs blob; kill the second registry).
4. **VIP-009** — Upload size policy + pre-decode memory estimate (removes a real mobile crash class cheaply).
5. **VIP-007** — Replace `speakers = []` with the existing diarization path (visible product claim; small wiring job).
6. **VIP-005** — Whisper guardrail on Enhance Speech (UI + gate) — protects the headline promise.
7. **VIP-011 + VIP-010** — Source SHA-256 display/verify + export provenance sidecar v1 (Forensic foundation).
8. **VIP-006** — Real-recording corpus + STOI/PESQ/WER tooling (unblocks all quality work).
9. **VIP-012** — Consolidate `ModelManifest.js` vs `models-manifest.json` (prevents future D1-class drift).
10. **VIP-008** — Publish a release-signed Android build and regenerate provenance (long lead time — start now).

---

## 16. Implementation Readiness

**Ready now:** VIP-002/003/005/007/009/011/012 need no further information — the codebase, tests, and local gates support immediate work.

**Blockers / missing information before certain tasks can begin:**
1. **GitHub Actions billing lock (VIP-001)** — hard blocker for gated merges and deploys.
2. **Real-recording corpus (VIP-006)** — no quality/model task (VIP-004/005/013/014) should start without it; licensing decision needed from the owner.
3. **Product decisions (not technical):** Android release-signing identity (VIP-008); export-format scope (VIP-033); Stripe v23 merge (VIP-026); auth scope (VIP-027/#592); fate of batch/offline legacy (VIP-035) and `bsrnn_complex` (VIP-039) — CLAUDE.md protects some legacy; owner sign-off required before deletion.
4. **Device access** for Phases 2/6 (physical Android + GPU tiers) — unverifiable in this sandbox (browser tiers cannot run: Playwright CDN blocked, no system Chromium).
5. **Unverified in this audit** (run where Chromium/network exist before trusting): `test:live`, `test:shell-qa`, `test:engineer`, `test:calibration`, `test:ui`, `test:quick-clean`, `test:tier-picker`, `test:privacy-runtime`, `test:sw-offline`, `downloads:validate`, Electron security smoke, and `model-delivery` *with* network.
6. **History limitation:** local git squashed to one commit; anything needing commit archaeology requires remote history (`gh`).

**Final word:** this repository is closer to done than most — its reliability machinery (cancellation, staleness, caching, integrity pins, quality gate) is genuinely implemented and tested. The path to a reliable, high-performance, privacy-first professional workstation runs through **model quality**, the **forensic provenance layer**, and **restoring the release pipeline** — not through re-architecture.

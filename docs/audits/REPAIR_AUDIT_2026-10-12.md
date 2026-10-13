# Repair audit — 2026-10-12

Evidence-first repair of findings F01–F26 from the audit of `a5f18a6`, applied on
`0b020cc` (`main`, 30 commits ahead; `a5f18a6` is an ancestor). Every disposition
below names the reproduction that established it and the check that now pins it.

Status labels: **FIXED** (reproduced, repaired, regression + runtime check),
**DISPROVED** (not a defect at `0b020cc`), **BLOCKED** (needs something this
environment does not have), **NOT VERIFIED** (no runtime evidence obtainable here).

## 1. Outcome

- F01-F26: 24 FIXED, F22 DISPROVED at `0b020cc` (fixed by #826; packaged
  runtime re-verified), F10 FIXED with the real `docker build` BLOCKED (no
  daemon). F19's code is FIXED; enabling it on the web is an owner decision
  (no page registers the worker), so F19 is listed as PARTIAL.
- Phase 3 (remaining semantic audit): 49 findings across DSP, analysis,
  storage, SAM/SAM3, native/CI and test realism. 16 FIXED and 3 PARTIAL with
  regressions, 1 BLOCKED, 1 owner decision, 28 reported with evidence (§6).
  UI handler and native/CI coverage is partial (§5).
- First review round, 60 threads on PR #846: 56 fixed; 4 closed without a
  code change (2 answered with evidence, 2 product questions left open for
  the owner). Second round, 21 threads: see §7.
- Jest 224 suites / 3828 tests pass after merging `main` (#845) (baseline 208 / 3603).
  `pnpm lint` 0 errors over every shipped first-party group. SI-SDR gate PASS.
- Not production-ready as a release claim: see release blockers.

### Release blockers and owner decisions

| Item | Why it blocks | Needed |
|---|---|---|
| Strict provenance | `pnpm provenance:validate:strict` fails: web `unknown`, Android/Windows `stale`. Rechecked at the end; not altered. | Rebuild + publish native artifacts from this tree, regenerate provenance from them. |
| Web offline launch | No shipping page registers the service worker (F19). Landing says "Works Offline"; on the web that holds only for an already-open tab. | Decide: call `registerSW()` from both entry pages (verified by `pnpm test:sw-offline`, costs a ~5.8 MiB precache on first visit) or narrow the claim. |
| Purchase flow dormant | No page loads `paywall.js`; the API is excluded from the Vercel deploy; checkout never calls `/license/claim`. | Decide where purchases live and which host serves the API. |
| Backend scale-out | `api-routes/store.js` file store is single-instance; no DB adapter; no email transport; no Stripe reconciliation job. | A database service and an email provider (new paid services, not added). |
| Android cloud backup | `android:allowBackup="true"` with no extraction rules lets Auto Backup copy WebView storage (the local library) off the device; a test pins `true`. | Owner decision: `allowBackup="false"` or backup rules excluding WebView data. |
| Docker image | `deploy/Dockerfile` fixed against an emulated install only. | `docker build` on a host with a daemon. |
| Real SAM-Audio | Only the deterministic mock model ran; weights/code are unpinned (SAM-N03). | Pin revisions + hashes; run with real weights. |
| CI | Every GitHub Actions job on this branch fails in about 2 s with `runner_id` 0, and `main` fails identically (account runner lock). Local `prod:verify` is the only gate evidence. | Restore the account's Actions runners. |
| Native packages | Android AAB and Windows NSIS not built here (no JDK/signing; Linux host). | `pnpm android:build:win`, `pnpm build:electron`. |

## 2. Finding matrix

| ID | Reproduced | Disposition | Changed files | Regression | Runtime evidence | Remaining gaps |
|---|---|---|---|---|---|---|
| F01 | Yes: polarity inversion and two sign flips collided under `sk2`; head/middle byte edits collided under `fp_` | FIXED | `src/core/content-hash.js` (new), `src/pipeline/MLStemCache.js`, `src/core/storage/CacheManifest.js`, `src/core/FileLibrary.js`, `src/pipeline/USMNode.js`, `src/core/ModelManifest.js`, `src/core/storage/DerivedCache.js` | `tests/content-identity.test.js` | MurmurHash3 x86_128 reference vector ("The quick brown fox…" → `2f1583c3…`); the repro inputs now get distinct keys | Old `sk2` entries are orphaned (evicted by budget); legacy `fp_` library rows are adopted by re-hashing; superseded stem packs are deleted |
| F02 | Partly: checkpoints already present (#814); cancel was acked before the run stopped | FIXED | `src/workers/MLWorker.js` | `tests/ml-worker-cancellation-behavior.test.js`, `tests/mope-responsiveness-cancel.test.js` | Real-model cancel acked in 2 ms after stop | — |
| F03 | Yes: Chromium `dispose()` never settled (>3 s) | FIXED | `src/pipeline/PlaybackMixer.js`, `src/pipeline/EngineerModeBridge.js` | `tests/playback-mixer-lifecycle.test.js` | `runtime-contracts-browser-check` F03 | — |
| F04 | Yes: 928 of 5000 non-zero samples output as 0, max error 0.60 | FIXED | `src/core/UniversalSourceMatrix.js`, `src/core/stft-math.js` | `tests/universal-source-matrix.test.js` | Node identity reconstruction | — |
| F05 | Yes: 830 ms main-thread task for 20 s of audio, abort ignored | FIXED | `src/pipeline/USMWorkerClient.js` (new), `src/pipeline/PromptedIsolation.js`, `src/core/providers/ExistingOnnxProvider.js`, `src/core/UniversalSourceMatrix.js` | `tests/providers-sam.test.js` | `runtime-contracts-browser-check` F05 | Long files refused above ~128 s at default settings (not chunked); path dormant (only `ProcessingOrchestrator` reaches it) |
| F06 | Yes: 10 s WebM → 1.19 s of silence; size heuristic misrouted short HD clips | FIXED | `src/pipeline/media-decode.js`, `scripts/make-decode-fixtures.sh` (new) | `tests/media-capture-window.test.js`, `tests/m4a-decode-fallback.test.js` | `runtime-contracts-browser-check --fixtures` F06 | Capture is real-time; ±1 block when media opens in digital silence; MP4/AAC not decodable in open-source Chromium (environment) |
| F07 | Core claim already fixed (`renderMix` used); Drive export ignored crop and skipped validation | FIXED | `public/app/app.js` | `tests/video-export-wiring.test.js`, `tests/playback-region.test.js` | `runtime-contracts-browser-check` F07: live playback vs `renderMix` residual 89.6 dB SNR | `renderMix` holds ~2× the region transiently |
| F08 | Yes: dry lane 576 frames ahead of wet (Chromium) | FIXED | `src/pipeline/PlaybackMixer.js` | `tests/audio-click-fix.test.js`, `tests/playback-region.test.js` | `runtime-contracts-browser-check` F08: dry/wet lag 0 | — |
| F09 | Yes: output peak 46.6 (linear) with the ceiling at −6 dBFS (Chromium) | FIXED | `src/pipeline/PlaybackMixer.js` | `tests/playback-mixer-lifecycle.test.js` | `runtime-contracts-browser-check` F09 | — |
| F10 | Yes (emulated): lockfile/workspace config absent; `setup-ort` failed as ESM | FIXED / build BLOCKED | `deploy/Dockerfile` | — | Emulated `pnpm install --prod --frozen-lockfile` in an image-shaped tree | Real `docker build` (no daemon) |
| F11 | Yes: startup spawned the Blob upload | FIXED | `server.js`, `scripts/upload-to-vercel-blob.mjs` | `tests/server-startup-no-provisioning.test.js` | Server start spawns nothing; upload script dry-runs by default | Blob never contacted |
| F12 | Yes: in-memory licences, simulated email log | FIXED | `api-routes/store.js` (new), `api-routes/monetization.js`, `api-routes/index.js` | `tests/backend-entitlements.test.js` | Restart-safe idempotency, transactional quota | Single instance only; no email transport |
| F13 | Yes: cancelled STUDIO token stayed valid | FIXED | `api-routes/entitlements.js` (new), `api-routes/monetization.js`, `api-routes/sync.js` | `tests/backend-entitlements.test.js` | Downgrade/cancel/failed payment effective on next request | — |
| F14 | Yes: NIM returned fabricated 0.95 success | FIXED | `api-routes/nim/index.js`, `api-routes/nim/grpc-client.js` (deleted) | `tests/backend-entitlements.test.js` | 501 before reading the body | — |
| F15 | Yes: 200 KB sync push → 413 | FIXED | `api-routes/index.js`, `api/handler.js`, `api-routes/sync.js` | `tests/backend-entitlements.test.js` | Per-route budgets, JSON error shape | — |
| F16 | Yes: worker answers OPTIONS 501, no CORS; CSP blocks loopback | FIXED | `electron/sam-proxy.cjs` (new), `electron/main.cjs`, `electron/preload.cjs`, `electron/ipc-channels.cjs`, `src/core/providers/LocalSamAudioWorkerProvider.js`, `services/sam-audio/server.py` | `tests/sam-worker-runtime.test.js`, `tests/electron-sam-ipc.test.js` | Electron renderer → IPC → worker: separate OK, cancel 14 ms, direct fetch blocked | Mock model only; path dormant in shipped UI |
| F17 | Yes: a cancelled `sam-1` made every later provider's first job 499 | FIXED | same as F16 | `tests/sam-worker-runtime.test.js` | Real worker: fresh provider and concurrent jobs succeed | Cancellation cannot interrupt a running `model.separate` |
| F18 | Yes: span/visual ran as text, identical output | FIXED | `src/core/providers/AudioIsolationProvider.js`, both providers, `services/sam-audio/server.py`, `electron/sam-proxy.cjs` | `tests/sam-worker-runtime.test.js` | Refused (`UNSUPPORTED_TARGETING` / 400) in Node and Electron | Span/visual prompting not implemented |
| F19 | Yes: SW never registered (and `registerSW()` threw SecurityError); if registered, offline Engineer failed on 41 `/src` modules and a deploy kept serving the old `app.js` | PARTIAL: worker logic FIXED; registration = owner decision | `public/app/sw.js`, `public/app/sw-register.js`, `scripts/sw-precache.cjs` (new), `scripts/build.mjs`, `scripts/vercel-build.js`, `scripts/verify-worklets.js`, `scripts/sw-offline-check.cjs` (new) | `tests/sw-precache.test.js`, `tests/service-worker-lifecycle.test.js`, `tests/worklet-packaging.test.js` | `pnpm test:sw-offline` 17/17 | Not registered by any page; cold offline Process uses the DSP fallback (ORT wasm and files over 1 MiB not precached) |
| F20 | Yes: 5 tests fail on the original | FIXED | `src/core/storage/openIdb.js`, `IdbBlobBackend.js`, `TrackState.js`, `ProjectStore.js`, `CacheManifest.js`, `DerivedCache.js`, `src/core/FileLibrary.js` | `tests/idb-commit.test.js` | Real Chromium commit/abort | — |
| F21 | Yes: emulator matrix, 2 wrong outcomes | FIXED | `firestore.rules`, `scripts/firestore-rules-matrix.mjs` (new) | — | Firestore emulator 22/22 | Production project not contacted |
| F22 | At `a5f18a6` yes; at `0b020cc` no (#826) | DISPROVED | — | existing `tests/electron-navigation-policy.test.js` | Dev and packaged (`electron-builder --dir`) bridge present, sandbox on | — |
| F23 | Dormant: `ExportControls` never mounted | FIXED (claims removed) | `src/workers/AudioEncoderWorker.js`, `src/pipeline/ExportOrchestrator.js`, `src/presentation/ExportControls.js`, `public/app/paywall.js`, docs | `tests/export-controls.test.js`, `tests/export-orchestrator.test.js` | — | No MP3 encoder (none approved) |
| F24 | Yes: reachable through Landing `encodeReviewedWav` | FIXED | `src/workers/AudioEncoderWorker.js` | `tests/audio-encoder-wav.test.js` | Chromium `decodeAudioData` of output | — |
| F25 | Yes: `session-persist.js` parse error; lint skipped ~80 shipped files, `api/`, `api-routes/`, `server.js`, `scripts/`, `packages/` | FIXED | `eslint.config.js`, `package.json`, `public/app/debug-audit.js`, `scripts/firestore-rules-matrix.mjs` | `tests/lint-coverage.test.js` | `pnpm lint`: 0 errors / 88 warnings over the full set | Warnings not triaged |
| F26 | Yes: unity mask, 5000 samples: 2853 off by >1% of peak, head error 0.50; boundary impulses output 0 | FIXED | `src/workers/MLWorker.js`, `src/core/ModelManifest.js` | `tests/ml-worker-dsp.test.js`, `tests/stem-split-core.test.js` | Quality gate PASS; real-model edge leakage gone | HF taper still always on |

## 3. Material changes

**F01 — content identity.** `sk2` and the file fingerprint sampled the signal, so
edits outside the probes reused old stems. `ContentHasher128` (MurmurHash3
x86_128, streaming, per-channel headers) digests every sample (`sk3`) and every
byte of a file (`c128_`). Stem keys also carry `modelChainRevision()`, a digest of
each model's sha256, normalization, mask exponent and framing, so a model or
inference change cannot reuse stems.

**F02 — cancel ack.** The worker acknowledged `cancel` immediately. Requests now
run through `enqueueRequest`; the ack is posted when the run has actually stopped.

**F03/F08/F09 — PlaybackMixer.** `dispose()` is bounded and idempotent, closes
ports and only closes a context it owns. The dry lane is delayed by the measured
compressor (288 frames) and worklet latency so dry and wet align; compressor and
limiter get matched-latency bypass legs because both colour audio at ratio 1. A
WaveShaper hard ceiling follows the limiter. `renderMix` renders the latency
budget and crops it.

**F04/F26 — framing.** Both STFT paths now pad by `N − hop` with odd reflection
and crop after OLA, divide by the true window² sum (no floor, no fades). Boundary
impulses survive; identity error ≤ 4.8e-7.

**F05 — prompted USM.** Runs in a one-shot module worker that is terminated on
settle, abort or timeout; working memory is estimated and over-budget inputs are
refused with the length limit in the message.

**F06 — accelerated capture.** Captures unmuted at 1×, measures dropped frames,
drains post-roll and locates the content window; truncation is judged against the
media's own duration, not file size.

**F07 — Drive export.** Uses the crop region and validates the rendered mix.

**F10/F11 — deploy.** Dockerfile installs with the real workspace config and
lockfile; server start no longer uploads; the upload script dry-runs unless
`--yes`, checks sha256 pins and skips identical objects.

**F12–F15 — backend.** Transactional store (`memory` for dev, atomic file under
`VIP_DATA_DIR`; production without it answers 503). Tokens identify, the stored
entitlement decides, on every request. NIM answers 501. Per-route body budgets
with one JSON error shape.

**F16–F18 — SAM worker.** Jobs use `sam-<uuid>`; client and server cancellation
sets are bounded and cleared per job. Span/visual/anchors are refused by both
providers, the proxy and the server. The worker refuses any `Origin`, non-loopback
`Host` and non-JSON POST (closing the connection on refusal), so no web page can
drive it; Electron reaches it through `vip:sam-worker-separate`/`-cancel` and
`electron/sam-proxy.cjs`. In a web page the provider reports
`browser-transport-unavailable` instead of attempting a CSP-blocked fetch.

**F19 — service worker.** Network-first for all same-origin code with cache
fallback, so a missed stamp can no longer pin old code. Precache and generation
are computed by `scripts/sw-precache.cjs` from the whole served tree in both
builds (265 URLs, 5.77 MiB; covers every URL a real session executes except
models and the ORT wasm). Install is atomic. Models are left to MLWorker's
integrity-checked IndexedDB cache. `registerSW()` registers the root shim
(`/sw.js`); registering `/app/sw.js` at `/` always threw.

**F20 — IndexedDB commits.** `idbTxDone` resolves on `complete`, rejects on
`abort`/error, with listeners attached at transaction creation.

**F21 — Firestore.** Update keeps `userId` immutable; delete checks the stored
owner only.

**F23/F24 — encoder.** WAV only; malformed PCM, rates and sizes are rejected;
clipping is clamped and counted.

**F25 — lint.** `pnpm lint` covers `public/app`, `public/*.js`, `src`, `server`,
`server.js`, `electron`, `api`, `api-routes`, `scripts`, `packages`. Config, not
code, absorbs false positives (browser globals inside Playwright callbacks,
typeof-guarded runtime globals, `/* global */` builtins). Two real defects fixed.

**Phase 3 repairs (90b256c, f03b430, f038d6d).**

- *Analysis.* `framesToSegments` now starts a new segment at any time gap, so
  each class is no longer one span from its first to its last frame (A1). A
  single diarization cluster is never matched as the target, so Isolate cannot
  lift a non-target voice back to ~0.9 (A3). The SNR floor uses audible
  quantiles and caps silence at 60 dB instead of ~215 dB (A6). Reverb onsets
  compare frame flux to a fixed threshold rather than the last frame's flux
  (A7). Landing aborts speaker detection when the file changes (A12, partial).
- *DSP.* The de-esser rebuilds its high-pass on the first block, so it no
  longer compresses the full band at the default 6.5 kHz (N01). Stereo
  re-expansion rebuilds L/R from mid/side with a 10 ms energy envelope instead
  of a per-sample ratio that zeroed sign-disagreeing samples (N02).
- *Storage.* Clear Local Data removes OPFS `library/`, `vip-projects` and the
  legacy speaker DB, and reports blocked deletes; model-cache connections
  close on `versionchange` (S1, S10). Remove-from-library clears the session,
  is not restored on boot and is revived by re-import; removed rows are evicted
  first and project sources never (S2, S4). Pack manifests are validated before
  any write, failed imports drop their project, and export refuses to drop a
  missing source silently (S3, S4). OPFS requires `createWritable` and falls
  back to IndexedDB on a failed write (S5). At most two stem packs per file;
  superseded revisions are deleted (S6).
- *SAM.* `ensure-sam-in-build` no longer stages the Python worker or FFmpeg
  into `build/` (APK/asar); Android excludes `sam_audio.onnx` and
  `verify-android-complete` guards all three (SAM-N01). Capability probing and
  docs stop claiming an on-device SAM loader that does not exist (SAM-N02). The
  SAM3 asset policy normalizes paths (SAM-N10). Model metadata matches the
  files (SAM-N11). The Electron proxy verifies `/health`, refuses ports below
  1024 and caps jobs and response size (SAM-N04, partial).

**Review-thread repairs (1d2e9f9, af3f4b7, f03b430).** Webhook same-second ties,
legacy long-lived tokens, outbox growth, owner-only store files, `/health`
robustness, uploader content hash, metadata-timeout trust, the one-block capture
rule, hop < FFT, USM memory estimate, model-revision fields, single async USM
hash, legacy `fp_` adoption, final-read abort, superseded stems, gate lookahead
in lockstep with the dry delay, SAM job uniqueness/TTL/fullmatch, proxy caps,
`event.waitUntil` for runtime cache writes, the Electron CSP doc correction,
`VIP_runAudit`, and 15 test hardenings (see §7).

## 4. Commands and results

All runs on `ccr-58149caf-j14xcr` in this container (Linux, Node 22.22.0,
pnpm, pre-installed Chromium). Final-state runs are at the head listed in §8.

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS (approved) |
| `pnpm test` (final, after merging #845) | PASS: 224 suites, 3828 tests, 0 failed |
| `pnpm lint` | PASS: 0 errors, 88 warnings (all pre-existing lines) |
| `pnpm validate` | PASS ("All checks passed") |
| `pnpm worklets:verify` | PASS |
| `pnpm models:validate` | PASS (remote Blob hashes not downloaded, not claimed) |
| `pnpm ci:check-patches` | PASS (no drift) |
| `pnpm test:quality` | PASS; max |Δ| 0.07 dB over 66 metrics vs baseline |
| `node scripts/runtime-contracts-browser-check.cjs --fixtures …` | PASS 28/28 (Chromium): F03/F05/F06/F07/F08/F09/F20/F24 |
| `node scripts/sw-offline-check.cjs` | PASS 17/17 (Chromium) |
| `pnpm test:live / landing / engineer / calibration / quick-clean / privacy-runtime / shell-qa` | PASS (Chromium) |
| `xvfb-run -a pnpm prod:verify --desktop` | PASS at `c63274c`: every static, browser and desktop step passed (shell-qa 388.9 s). `--network` NOT RUN. Android and Electron package steps NOT VERIFIED. Round-2 review fixes were re-checked with Jest, lint, validate and the live/landing/engineer/calibration smokes, not a full rerun |
| `pnpm test:electron-security` (dev + packaged `electron-builder --dir`) | PASS |
| Firestore rules matrix (`npx firebase emulators:exec …`, scratch dir) | PASS 22/22 fixed rules; original rules wrong on 2 cases |
| `pnpm provenance:validate:strict` | FAIL (expected, unaltered): web `unknown`, Android/Windows `stale` |
| `docker build` | BLOCKED: no Docker daemon |
| Android AAB / Windows NSIS | NOT VERIFIED: no JDK/signing; Linux host |
| GitHub Actions CI | BLOCKED: account runner lock (earlier heads: jobs failed in ~2 s, `runner_id` 0, `main` identical; on `c63274c` no Actions run started at all) |
| Model metadata + forward pass (onnxruntime-web 1.25.1, wasm) | All four shipped models load; sha256 and size match `ModelManifest.js`; spectral I/O `[batch, 2049]` both ways; masks finite (bsrnn 0.0003-0.9998, rnnoise 0.0001-0.448) |

Tolerances: identity reconstruction ≤ 4.8e-7 (float32 round-off over a
4096-point OLA); WAV decode ≤ 2/32767 (16-bit quantization); live vs export
residual ≥ 80 dB SNR (render-quantum timing jitter only); quality gate 0.5 dB
(the repo's pinned gate). No listening tests were performed; no claim of
perceptual quality is made.

## 5. Coverage ledger

| Area | Method | Status |
|---|---|---|
| F01-F26 surfaces | Reproduction, repair, regression, runtime check | Covered (§2) |
| DSP / SpectralCleanup / framing / FFT / resampling | Auditor read 14 files + targeted numeric probes | Covered; 9 findings reported (§6) |
| Analysis, diarization, enrollment, recommendations | Auditor read 12 files + scratch runs | Covered; 7 reported |
| IDB/OPFS migrations, crash consistency, quota, eviction | Auditor (31 files) + fake-IDB/OPFS simulations | Covered; 4 reported |
| SAM3 visual pipeline, SAM providers, model/provider compatibility | Auditor (53 files) | Covered; 6 reported/blocked (dormant module) |
| UI handlers and dynamic loading | Direct checks: all 29 dynamic `import()` targets resolve; file switch during Process aborts and waits (`_fileSeq`); Process re-entry guarded; no slider/input path reaches `runPipeline` | Partially covered: a full handler-by-handler race audit did not complete (auditor stopped twice on usage limits) |
| Native, CI, deployment | Direct checks: Android manifest/WebView settings, Capacitor config, workflow soft-fail steps; Electron covered by F16/F22 work and security smoke | Partially covered: no full read of every workflow and build script |
| Tests that bypass production behaviour | Heuristic scan of 222 suites | Partially covered (TM-2) |
| Model binaries | Metadata, hashes, I/O, forward pass; provenance from `scripts/export_onnx_models.py` | Covered |

Explicit exclusions: `public/lib/` (vendored), `node_modules/`, `docs/` prose
beyond claims checked here, `ios/` (out of scope per CLAUDE.md), the legacy
`public/app/ml-worker.js` SAB path (frozen), real SAM weights, production
Firestore/Stripe/Blob (never contacted), Google Drive (no upload performed).

## 6. Phase 3 findings

Status: FIXED, PARTIAL, BLOCKED, OWNER (needs a product decision), REPORTED
(evidence recorded, not changed here).

| ID | Sev | Finding | Status | Evidence / regression |
|---|---|---|---|---|
| A1 | high | Analysis segments of a class merged into one span | FIXED | `tests/full-analysis.test.js` |
| A2 | high | Diarization reports one speaker on real 2-speaker files ≥10 s | REPORTED | Needs labelled multi-speaker data to retune k selection safely |
| A3 | high | Isolate lifts the non-target voice when diarization has one cluster | FIXED | `tests/target-speaker.test.js` |
| A4 | med | Isolate is destructive and compounds; re-enroll cannot restore | REPORTED | |
| A5 | med | Enroll/Isolate scan the whole stem on the main thread | REPORTED | |
| A6 | med | SNR ≈ +215 dB on digital silence | FIXED | `tests/full-analysis.test.js` |
| A7 | med | Reverb estimate depends on the last 100 ms | FIXED | `tests/full-analysis.test.js`; weak dry/wet discrimination remains (needs a new estimator) |
| A8 | med | Hum detector fires on voiced speech | REPORTED | |
| A9 | med | Speaker detection/enrollment use channel 0 only | REPORTED | |
| A10 | low | Silero VAD fed without 64-sample context; 3-tap decimation | REPORTED | |
| A11 | low | Recommendation labels Live-Mix controls as process-time | REPORTED | |
| A12 | low | Landing speaker detection not cancellable; VAD copies full mono | PARTIAL | Abort fixed (`tests/landing-speaker-abort.test.js`); the copy remains |
| N01 | high | De-esser never builds its high-pass at 6.5 kHz | FIXED | `tests/deesser-processor.test.js`; subtractive crossover still weak (−0.96 dB at 9 kHz) |
| N02 | high | Stereo re-expansion by per-sample ratio | FIXED | `tests/stereo-reexpansion.test.js` |
| N03 | med | NR Floor has no effect on the ML path; inverted in the DSP fallback | REPORTED | |
| N04 | med | DSP fallback output double-processed by Live-Mix | REPORTED | |
| N05 | med | DSPCore STFT drops 16-45 ms at the edges | REPORTED | |
| N06 | med | Fallback Wiener NR is a no-op | REPORTED | |
| N07 | med | Click remover rewrites sibilant samples | REPORTED | |
| N08 | med | Surround downmix loses the centre for layouts other than quad/5.1 | REPORTED | |
| N09 | low | snrFloor/breathControl treat raw magnitudes as dBFS | REPORTED | |
| N10 | low | Fallback de-ess reads dB as percent | REPORTED | |
| N11 | low | ERB gate double-applies boundary bins | REPORTED | |
| S1 | high | Clear Local Data leaves OPFS audio and `vip-projects`, reports success | FIXED | `tests/storage-hardening.test.js` |
| S2 | med | Removed tracks keep bytes and come back on reload | FIXED | `tests/storage-hardening.test.js` |
| S3 | med | Unvalidated `.vippack` fields break the library; half imports | FIXED | `tests/storage-hardening.test.js` |
| S4 | med | Track cap evicts project sources; export drops them silently | FIXED | `tests/storage-hardening.test.js` |
| S5 | med | OPFS without `createWritable`: no IDB fallback, empty files | FIXED | `tests/storage-hardening.test.js` (Safari itself not run) |
| S6 | med | Durable stem cache unbounded per file | FIXED | `tests/file-library.test.js` |
| S7 | med | Durable analysis cache never invalidated | REPORTED | |
| S8 | med | Pack import/export hold 2-3 copies in RAM, no cap | REPORTED | |
| S9 | low | `importFile` mutates session after the caller gave up | REPORTED | |
| S10 | low | Model-cache IDB ignores `versionchange`; bridge failure fatal | PARTIAL | `versionchange` fixed in all three holders |
| S11 | low | Large OPFS restores lose the MIME type | REPORTED | |
| SAM-N01 | high | FFmpeg (GPL, unpinned) and the Python worker staged into the APK/asar | FIXED | `tests/vip-sam-runtime-package.test.js`, `verify-android-complete` guard |
| SAM-N02 | med | Docs/capabilities claim on-device SAM; no loader exists | FIXED | Capability reports `present-but-unsupported`; APK excludes the file |
| SAM-N03 | med | SAM worker loads unpinned weights/code; probe triggers download | BLOCKED | Needs upstream revision SHAs and weight hashes (network) |
| SAM-N04 | med | Proxy trusts any process on the port; unbounded response | PARTIAL | Health check, port floor, caps (`tests/sam-worker-runtime.test.js`); no per-launch token; mock workers still selectable |
| SAM-N05 | med | SAM3 segmenter returns image-independent detections with no provenance | REPORTED | Dormant module |
| SAM-N06 | med | SAM3 frame gate stalls after one lost frame | REPORTED | Dormant module |
| SAM-N07 | med | Sam3Host lifecycle (unsettled stop, init race) | REPORTED | Dormant module |
| SAM-N08 | low | SAM worker caches its first load failure | REPORTED | |
| SAM-N09 | low | SAM3 worker boot overwrites host status | REPORTED | Dormant module |
| SAM-N10 | low | SAM3 asset policy bypass (encoded traversal, siblings, localhost) | FIXED | `tests/sam3-integration.test.js` |
| SAM-N11 | low | Model metadata contradicts files/export scripts | FIXED | Metadata and READMEs corrected |
| NCI-1 | med | `allowBackup="true"` without extraction rules | OWNER | A test pins `true` |
| NCI-2 | low | WebView `setSafeBrowsingEnabled(false)`, `setAllowFileAccess(true)` with an asset loader | REPORTED | |
| NCI-3 | low | `eslint.yml` `continue-on-error`, njsscan `\|\| true` | REPORTED | Reporting workflows; the `prod:verify` gate is unaffected |
| TM-2 | low | ~75 of 222 suites match no execution pattern (heuristic, over-counts) | REPORTED | Shell behaviour is covered by the browser smokes |

Totals: 49 findings: 16 FIXED, 3 PARTIAL, 1 BLOCKED, 1 OWNER, 28 REPORTED.
Model provenance (from code, not names): `bsrnn_vocals.onnx` and
`rnnoise_suppressor.onnx` are custom networks trained by
`scripts/export_onnx_models.py` for 600 steps on synthetic mixtures; they are
not the upstream BSRNN checkpoint or Mozilla RNNoise. Silero VAD files are
upstream exports, hash-pinned.

## 7. Review threads (PR #846)

**First round, 60 cubic-dev-ai threads.** Fixed: 56 (commits 1d2e9f9,
af3f4b7, 6627b7e, f03b430, c63274c). Closed without a code change: 4. Two were
answered with evidence: the MLWorker short-clip reflection is bounded by
design (a parity test now pins it to `stft-math`), and the USM worker timeout
has ~25× headroom because input is bounded at ~128 s. Two are product
decisions left open for the owner: the checkout success-page wiring and Stripe
reconciliation (purchase flow dormant). Two earlier follow-ups (reverb onset
rule, Landing ONNX diarizer cancel) were answered with measurements.

**Second round, 21 threads** (review of the storage/SAM/report commits). All
21 changed code, tests or docs:

- Clear Local Data now also counts OPFS entries, Web Storage keys and Cache
  API entries that survive.
- A failed OPFS overwrite keeps the previous file.
- Pack rollback hands reused rows back to the project that still links them,
  and covers rows that failed after commit.
- Reviving a row whose blob is gone stores the audio again.
- Model-cache `versionchange` handlers close their own connection.
- The SAM3 policy refuses `//host` paths.
- The build drops a staged `sam_audio.onnx`, and probe failures report
  `unknown`.
- The debug audit awaits its worker checks and no longer applies a preset.
- Engineer refreshes its list after an incomplete clear.
- Test harness and documentation fixes.

The read-only `navigator` P1 did not reproduce: these suites passed under
Jest's Node environment. The helper was hardened anyway.

## 8. Git state

- Tree at start: clean at `0b020cc`. The `sam-runtime.marker.json` change
  mentioned in the brief was not present in this cloud checkout.
- Branch `ccr-58149caf-j14xcr`, draft PR #846. All changes on it are this
  repair's, except `cebcfb0` and `5ffeaa2`, which the owner applied from
  review suggestions; both are superseded by equivalent text in `6627b7e`.
- `main` advanced with #845 (fused-STFT framing, Engineer WAV export). It
  overlapped F26 and F24. The merge keeps this branch's odd-reflection framing
  without the 8 ms edge fades (#845 listed them as observed but unchanged),
  adopts #845's sample-rate guard, SpectralCleanup framing and WAV rounding,
  and corrects #845's notes that said the fades remain. Checks after the
  merge: Jest 224/3828 (one F24 test now expects rounding: 16384, not 16383),
  lint 0 errors, validate, `test:quality` PASS, and the live, landing,
  engineer, calibration and engineer-upload smokes PASS. `#845`'s
  `mlworker-ola-edges` tests pass on this framing.
- `git diff --stat origin/main..HEAD` after the merge: 136 files changed, 7562 insertions(+), 2023 deletions(-).

# Repair audit — 2026-10-12

Evidence-first repair of findings F01–F26 from the audit of `a5f18a6`, applied on
`0b020cc` (`main`, 30 commits ahead; `a5f18a6` is an ancestor). Every disposition
below names the reproduction that established it and the check that now pins it.

Status labels: **FIXED** (reproduced, repaired, regression + runtime check),
**DISPROVED** (not a defect at `0b020cc`), **BLOCKED** (needs something this
environment does not have), **NOT VERIFIED** (no runtime evidence obtainable here).

## 1. Outcome

- 24 findings FIXED, F22 DISPROVED at `0b020cc` (fixed by #826; packaged runtime
  re-verified), F10 FIXED with the real `docker build` BLOCKED (no daemon).
- Jest 218 suites / 3728 tests pass (baseline 208 / 3603). `pnpm lint` now covers
  every shipped first-party group: 0 errors. SI-SDR gate PASS, max |Δ| 0.07 dB
  over 66 metrics vs baseline.
- Not production-ready as a release claim: see release blockers.

### Release blockers and owner decisions

| Item | Why it blocks | Needed |
|---|---|---|
| Strict provenance | `pnpm provenance:validate:strict` fails: web `unknown`, Android/Windows `stale`. Not altered. | Rebuild + publish native artifacts from this tree, regenerate provenance from them. |
| Web offline launch | No shipping page registers the service worker (F19). Landing says "Works Offline"; on the web that holds only for an already-open tab. | Decide: call `registerSW()` from both entry pages (verified by `pnpm test:sw-offline`, costs a 5.77 MiB precache on first visit) or narrow the claim. |
| Backend scale-out | `api-routes/store.js` file store is single-instance; no DB adapter; no email transport (licenses are delivered by `/license/claim`). | A database service and an email provider (new paid services, not added). |
| Docker image | `deploy/Dockerfile` fixed against an emulated install only. | `docker build` on a host with a daemon. |
| Real SAM-Audio | Only the deterministic mock model ran; no Python SAM runtime/weights here. | Run `services/sam-audio` with real weights and the Electron proxy. |
| Phase 3 findings | See §6. | Owner triage of items not repaired here. |

## 2. Finding matrix

| ID | Reproduced | Disposition | Changed files | Regression | Runtime evidence | Remaining gaps |
|---|---|---|---|---|---|---|
| F01 | Yes: polarity inversion and two sign flips collided under `sk2`; head/middle byte edits collided under `fp_` | FIXED | `src/core/content-hash.js` (new), `src/pipeline/MLStemCache.js`, `src/core/storage/CacheManifest.js`, `src/core/FileLibrary.js`, `src/pipeline/USMNode.js`, `src/core/ModelManifest.js`, `src/core/storage/DerivedCache.js` | `tests/content-identity.test.js` | MurmurHash3 x86_128 reference vector ("The quick brown fox…" → `2f1583c3…`); the repro inputs now get distinct keys | Old `sk2`/derived entries are orphaned, not migrated (evicted by budget) |
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
| F19 | Yes: SW never registered (and `registerSW()` threw SecurityError); if registered, offline Engineer failed on 41 `/src` modules and a deploy kept serving the old `app.js` | FIXED (registration = owner decision) | `public/app/sw.js`, `public/app/sw-register.js`, `scripts/sw-precache.cjs` (new), `scripts/build.mjs`, `scripts/vercel-build.js`, `scripts/verify-worklets.js`, `scripts/sw-offline-check.cjs` (new) | `tests/sw-precache.test.js`, `tests/service-worker-lifecycle.test.js`, `tests/worklet-packaging.test.js` | `pnpm test:sw-offline` 16/16 | Not registered by any page; cold offline Process uses the DSP fallback (ORT wasm not precached) |
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

## 4. Commands and results

See §7 (filled at the end of the run).

## 5. Coverage ledger

See §8.

## 6. Phase 3 findings

See §9.

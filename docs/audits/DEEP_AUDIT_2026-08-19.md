# VoiceIsolate Pro — Deep Audit Report (2026-08-19)

**Release status: CONDITIONAL GO**

| Field | Value |
|-------|--------|
| Canonical repo | [Joker5514/VoiceIsolate-Pro](https://github.com/Joker5514/VoiceIsolate-Pro) |
| Branch audited | `main` @ `aa72a21` (+ this audit branch) |
| Product version | **25.0.2** / Android `versionCode` **250002** |
| Prior audit | [DEEP_AUDIT_2026-08-17.md](DEEP_AUDIT_2026-08-17.md) |
| Auto-merge / deploy | **Not performed** (human review required) |

---

## Top-level status

| Item | Result |
|------|--------|
| **Release status** | **CONDITIONAL GO** |
| **Blockers** | **0** |
| **Critical (residual)** | **0** after this audit’s native rebuild (was: EXE/APK lagged #772 until 2026-08-19T00:43Z) |
| **Platforms passed (automated)** | Web prod headers; `pnpm test:ci` **149** suites / **2780** tests; validate; privacy; cloud-audio; lint (0 errors); STFT suites |
| **Platforms limited** | Full Safari/Firefox/iOS device matrix; 30‑min soak; physical Android/Electron interactive retest this session |
| **Changes in this audit** | Lint cleanup (unused DerivedCache imports); native rebuild + pin refresh for #772; this report |
| **Evidence** | This file · command log · PR (review only) |

### Prompt architecture claim vs ground truth

| Claim in prompt | Actual (repository evidence) |
|-----------------|------------------------------|
| Vite / React / TypeScript SPA | **Express + vanilla ES modules** (`public/`, `src/`); **no Vite, no React** |
| Live microphone AudioWorklet isolation | **Upload-only**; `Permissions-Policy: microphone=()`; Gate/DeEsser are **playback-only** |
| ~52 controls | **67** `SLIDER_REGISTRY` IDs (+ Whisper Mode UI) |
| Packaging | **Vercel web**, **Electron Windows**, **Capacitor Android** |

Hard rules (CLAUDE.md): 100% local audio, no mic, single STFT/iSTFT spectral phase, no ML in worklet `process()`.

---

## Phase 0 — Ground truth & architecture map

```
Upload → decode/resample 48 kHz → MLWorker (ONNX WebGPU→WASM) / classical DSP
       → stems → Live-Mix (PlaybackMixer + Gate/DeEsser worklets)
       → cooperative post-ML finalization (expand / dewhistle / safety)
       → Complete 100% → deferred idle analysis (desktop)
```

| Layer | Paths |
|-------|--------|
| Landing | `public/index.html`, `landing.js` |
| Engineer | `public/app/app.js`, `engineer-console.*`, `DspSlider.js` |
| Registry | `public/app/slider-map.js` (67 IDs) |
| Progress / cancel | `docs/guides/PROCESS_PROGRESS.md`, `JobController.js`, `ui-yield.js` |
| STFT | `src/core/stft-math.js`, `stft-budget.js`, `MLWorker.js` fused path |
| Desktop | `electron/`, `pnpm build:electron` |
| Android | `android/`, Capacitor 8, `pnpm android:build:win` |
| Deploy | `vercel.json` → `public/` + COOP/COEP |
| Privacy CI | `pnpm check:privacy`, `pnpm check:cloud-audio` |

### Baseline commands (this session)

| Command | Result |
|---------|--------|
| `pnpm validate` | **PASS** |
| `pnpm check:privacy` | **PASS** |
| `pnpm check:cloud-audio` | **PASS** |
| `pnpm lint` | **PASS** (warnings only; unused import cleaned in this PR) |
| `pnpm test:ci` | **PASS** — 149 suites / **2780** tests |
| Focused STFT / 88% suites | **PASS** (53 tests) |
| Prod HEAD | **200** + COOP/COEP + `microphone=()` |
| Download URLs | **200** APK + EXE |
| `pnpm build` | See PR log |

Bundled ONNX (approx.): BSRNN 3.69 MB · RNNoise 1.93 MB · Silero VAD 2.22 MB (+ int8 optional).

Recent hardening already on `main` before this audit: #770 Android upload, #771 Android UI freeze, #772 desktop post-ML 88% cooperative finalization.

---

## Issue register

| ID | Sev | Platform | Impact | Root cause | Fix status | Test / evidence |
|----|-----|----------|--------|------------|------------|-----------------|
| **B-001** | High | Desktop/Android installers | Users on GitHub Releases miss #772 desktop 88% fix | Natives last uploaded 2026-08-18T23:15Z **before** `aa72a21` | **Fixed** — rebuild + clobber upload **2026-08-19T00:43Z** + pin refresh | Release API; DOWNLOADS.md |
| **B-002** | Low | Lint / maintainability | Noise in CI logs | Unused `saveAnalysisDurable` / `loadAnalysisDurable` imports; unused eslint-disable | **Fixed** | `pnpm lint` |
| **B-003** | Medium | Docs / prompt myths | Wrong expectations (Vite/React/live mic) | External prompts vs CLAUDE.md | **Documented** (this report) | CLAUDE.md / README upload-only |
| **B-004** | Medium | Auth optional | Firebase CDN if auth UI loaded | Documented ADR exception; placeholders | **Mitigated / documented** | firebase-config.js |
| **B-005** | Medium | Matrix | Device-specific WebGPU/Safari gaps unknown | Session scope | **Open** | Checklist |
| **B-006** | Low | Jest | Worker force-exit / jsdom navigation noise | Known harness teardown | **Open** (non-blocking; suites pass) | test:ci log |
| **B-007** | Low | Experimental | `public/mic-capture.js` still on disk | Allowlisted unwired | **Open** — quarantine in 30‑day plan | privacy gate |

---

## DSP / STFT validation

Automated (this session):

- `tests/stft-math.test.js`
- `tests/single-stft-assert.test.js`
- `tests/mlworker-fused-stft.test.js`
- `tests/architectural-invariants.test.js`
- `tests/desktop-88-progress.test.js`

Contract: fused `fused-spectral-single-stft` for default BSRNN; post-ML dewhistle is **time-domain only** (no second STFT). Progress bands documented in [PROCESS_PROGRESS.md](../guides/PROCESS_PROGRESS.md).

Loudness: do **not** claim full ITU-R BS.1770 unless UI labels a compliant meter.

---

## Compatibility matrix (this session)

| Target | Evidence | Result |
|--------|----------|--------|
| Web prod headers / 200 | HEAD | **PASS** |
| Unit/integration CI | `pnpm test:ci` | **PASS** |
| Download hub / APK / EXE HTTP | HEAD | **PASS** |
| Electron package (post-rebuild) | This audit upload | **PASS** (artifact) |
| Android APK (post-rebuild) | This audit upload | **PASS** (artifact) |
| Firefox / Safari / iOS | — | **LIMITED** |
| 30‑min soak | — | **LIMITED** |

---

## Security / privacy

| Check | Result |
|-------|--------|
| `pnpm check:privacy` | **PASS** |
| `pnpm check:cloud-audio` | **PASS** |
| Prod Permissions-Policy | `microphone=()` |
| COOP/COEP | Enabled |
| Product getUserMedia | Forbidden |
| Firebase | Optional non-audio CDN exception |
| Secrets | No live Firebase keys in repo (placeholders) |

Allowed network (non-audio): same-origin assets, optional auth CDN if Firebase UI enabled, Vercel platform.

---

## Stress / soak

Not re-executed exhaustively this session. Regression coverage for freeze bands: mobile/desktop structural tests + `debug-progress-stall.cjs` (asserts progress past 88%). Prior remediations #758–#772 remain on `main`.

---

## Release-readiness checklist

| Criterion | Status |
|-----------|--------|
| validate / privacy / cloud-audio | **PASS** |
| lint (errors) | **PASS** |
| test:ci | **PASS** (2780) |
| production build | Required green on PR |
| Local-only verified | **PASS** |
| Single STFT/iSTFT tested | **PASS** |
| Controls wired (67) | **PASS** |
| Desktop 88% cooperative path | **PASS** in code/tests; **native rebuild** in this audit |
| Essential device E2E | **LIMITED** |
| Auto-merge | **Not done** |

**GO if:** reviewers accept matrix gaps and approve native pin refresh.  
**NO-GO if:** a claimed supported device must ship without interactive smoke this week.

---

## 30 / 60 / 90 day roadmap

**30 days:** Playwright Chromium+Firefox Engineer smoke; quarantine `mic-capture.js`; gate Firebase behind feature flag (zero gstatic by default); CI artifact for STFT round-trip SNR.

**60 days:** WebGPU device-lost e2e; export codec honesty; Electron signing review.

**90 days:** Soak harness 30–120 min; dependency supply-chain pin review.

---

## Commands to reproduce

```bash
git checkout main && git pull
pnpm install
pnpm validate && pnpm check:privacy && pnpm check:cloud-audio
pnpm lint
pnpm test:ci
pnpm build
pnpm test -- tests/desktop-88-progress.test.js tests/stft-math.test.js tests/architectural-invariants.test.js
# optional:
node scripts/debug-progress-stall.cjs 60
curl -sI https://voice-isolate-pro.vercel.app/ | findstr /I "cross-origin permissions"
```

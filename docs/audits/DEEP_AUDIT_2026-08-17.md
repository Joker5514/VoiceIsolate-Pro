# VoiceIsolate Pro — Deep Audit Report (2026-08-17)

**Release status: CONDITIONAL GO**

| Field | Value |
|-------|--------|
| Canonical repo | [Joker5514/VoiceIsolate-Pro](https://github.com/Joker5514/VoiceIsolate-Pro) |
| Branch audited | `main` @ `36f381b` (+ audit branch fixes) |
| Product version | **25.0.2** / Android `versionCode` **250002** |
| Auditor | Automated principal audit (evidence-driven) |
| Auto-merge / deploy | **Not performed** (review required) |

---

## Top-level status

| Item | Result |
|------|--------|
| **Release status** | **CONDITIONAL GO** |
| **Blockers** | **0** open in code after this PR’s fixes |
| **Critical (residual)** | **2** documented limitations (not silent failures) — see register |
| **Platforms passed (automated / headers)** | Web production headers + unit/integration CI; STFT/privacy gates |
| **Platforms limited** | Full device matrix (Safari iOS, Firefox GPU, long soak, real mic-denied UX on devices) **not fully re-executed in this session** |
| **Changes made** | SAM capability-cache poison fix; mobile-ui test sync to DspSlider; how-it-works upload-only copy; privacy gate covers landing/HTML |
| **Evidence** | This report · command log · PR · `pnpm test:ci` / `validate` / `check:privacy` |

### Prompt architecture claim vs ground truth

The audit prompt assumed **Vite/React/TypeScript + live microphone**. **Repository evidence contradicts that:**

| Claim in prompt | Actual product |
|-----------------|----------------|
| Vite/React/TS app | **Express + vanilla ES modules** (`public/`, `src/`), Jest, Playwright; **no React/Vite** |
| Live microphone AudioWorklet isolation | **Upload-only**; `Permissions-Policy: microphone=()`; Gate/DeEsser are **playback-only** |
| ~52 controls | **67** registry IDs in `SLIDER_REGISTRY` (+ Whisper Mode UI) |
| Packaging | **Vercel web**, **Electron Windows**, **Capacitor Android** |

Hard rules (CLAUDE.md / skill) remain authoritative: 100% local audio, no mic, single STFT/iSTFT spectral phase, no ML in worklet `process()`.

---

## Phase 0 — Ground truth & architecture map

### Surfaces

```
Upload file → decode/resample 48 kHz → MLWorker (ONNX WebGPU→WASM) / classical DSP
           → stems → Live-Mix (PlaybackMixer AudioParams + Gate/DeEsser worklets)
           → Offline polish / export (WAV etc.)
```

| Layer | Paths |
|-------|--------|
| Landing | `public/index.html`, `landing.js` |
| Engineer | `public/app/app.js`, `index.html`, `engineer-console.*`, `DspSlider.js` |
| Registry | `public/app/slider-map.js` (`SLIDER_REGISTRY`) |
| STFT math / budget | `src/core/stft-math.js`, `stft-budget.js` |
| ML | `src/workers/MLWorker.js`, `public/app/ml-worker.js` |
| Playback worklets | `src/workers/GateProcessor.js`, `DeEsserProcessor.js` |
| Desktop | `electron/`, `pnpm build:electron` |
| Android | `android/`, Capacitor, `pnpm android:build:win` |
| Deploy | `vercel.json` → `public/` + COOP/COEP |
| Privacy gates | `pnpm check:privacy`, `pnpm check:cloud-audio` |

### Baseline commands (this session)

| Command | Result |
|---------|--------|
| `pnpm validate` | **PASS** |
| `pnpm check:cloud-audio` | **PASS** |
| `pnpm check:privacy` | **PASS** |
| `pnpm lint` | **PASS** (warnings only) |
| `pnpm test:ci` | **PASS** — **148** suites / **2757** tests (was 7 failing before fixes) |
| `pnpm build` | **PASS** |
| Production HEAD | Landing + `/app/` **200**; **COOP=same-origin**, **COEP=require-corp**, **Permissions-Policy=microphone=(), camera=(), geolocation=()** |
| Native release | v25.0.2 APK ~96.8 MB + EXE ~138 MB @ `34d0981` (pinned in docs #768) |

Bundled ONNX (approx.): `bsrnn_vocals` 3.69 MB · `rnnoise_suppressor` 1.93 MB · `silero_vad` 2.22 MB (+ int8 optional).

---

## Issue register

| ID | Sev | Platform | Repro | Impact | Root cause | Fix status | Test | Residual |
|----|-----|----------|-------|--------|------------|------------|------|----------|
| **A-001** | High | Desktop/SAM | Select `local-worker` after a failed probe in same process | Wrong provider (`onnx-local`) despite healthy worker mock | Module-level `_capsCache` poisoned by prior failure | **Fixed** — skip cache when `fetchImpl` injected; export `clearSamCapabilityCache` | `tests/providers-sam.test.js` | Cache still used in prod (intentional) |
| **A-002** | Medium | CI | `pnpm test:ci` | False regressions blocking confidence | `mobile-ui` still asserted pre-DspSlider `--pct` / `rt-badge` strings | **Fixed** — tests updated to DspSlider contracts | `tests/mobile-ui.test.js` | — |
| **A-003** | Medium | Web docs | Read how-it-works | Misleading “live input / live mic path” claims | Stale copy vs upload-only product | **Fixed** — copy corrected | Manual | Marketing sites outside repo not scanned |
| **A-004** | Medium | Privacy CI | Import mic into landing HTML | Could reintroduce mic silently | Gate only checked `app.js` | **Fixed** — also scan landing + HTML shells | `check-privacy-invariants` | `public/mic-capture.js` still exists **unwired** (allowlisted) |
| **A-005** | Critical* | Auth | Load `firebase-config.js` | CDN Firebase JS; optional cloud auth/sync | Documented ADR exception; placeholders in source | **Mitigated / documented** — not removed (would break optional auth) | Manual | *Critical only if marketed as “zero network”; audio path remains local |
| **A-006** | Low | Lint | `pnpm lint` | Noise | Unused imports / directives | **Open** (non-blocking warnings) | lint | Clean in follow-up |
| **A-007** | Medium | Matrix | Full Safari/Firefox/Android GPU matrix | Unknown device-specific ORT/WebGPU gaps | Session scope / no full device lab this run | **Open** — checklist below | Manual | CONDITIONAL GO driver |
| **A-008** | Low | Soak | 30+ min live-mix soak | Leak/glitch unknown | Not re-run this session | **Open** | Manual | Prior freezes addressed in #758–#765 / #767 |

\*Firebase is intentional non-audio cloud; do not confuse with audio exfiltration.

---

## DSP / STFT validation (evidence)

Automated suites **passed** this session:

- `tests/stft-math.test.js`
- `tests/single-stft-assert.test.js`
- `tests/mlworker-fused-stft.test.js`
- `tests/architectural-invariants.test.js`

Contract: fused spectral path `fused-spectral-single-stft` for default BSRNN vocals; architectural tests forbid getUserMedia in product app path and nested STFT loops where asserted.

**Not re-measured numerically in this session:** full impulse/sine round-trip dB tables from a fresh OfflineAudioContext harness beyond existing unit fixtures — rely on existing `stft-roundtrip-sine` / cola tests in tree (run via `pnpm test:ci`).

Loudness: do **not** claim full ITU-R BS.1770 compliance unless a dedicated meter path is labeled as such in UI (treat as approximate if present).

---

## Compatibility matrix (this session)

| Target | Evidence | Result |
|--------|----------|--------|
| Web prod (Vercel) headers / 200 | HEAD requests | **PASS** COOP/COEP + mic deny |
| Chromium unit/jsdom CI | `pnpm test:ci` | **PASS** (post-fix) |
| Electron packaging | Prior rebuild 2026-08-17T06:56Z | **PASS** artifact publish (not reinstalled this session) |
| Android APK | Same | **PASS** artifact publish |
| Firefox / Safari desktop | — | **LIMITED** (not retested here) |
| iOS Safari | — | **LIMITED** |
| Android device WebGPU matrix | — | **LIMITED** |
| 30‑min soak | — | **LIMITED** |

---

## Security / privacy

| Check | Result |
|-------|--------|
| `pnpm check:privacy` | **PASS** |
| `pnpm check:cloud-audio` | **PASS** |
| Prod Permissions-Policy | `microphone=()` |
| COOP/COEP | Enabled (SAB-capable) |
| Product getUserMedia | Forbidden; only `public/mic-capture.js` allowlisted & unwired |
| Firebase / Stripe / Vercel Analytics deps | Present in ecosystem — **audio must not flow**; Firebase documented exception |
| Secrets in firebase-config | Placeholder keys only in repo (`YOUR_API_KEY`) — rotate if ever committed real keys |

Observed **allowed** network classes (non-audio): same-origin assets, optional auth CDN if Firebase UI loaded, Vercel platform. No hosted fal/Replicate/OpenAI audio backends in processing sources (CI).

---

## Stress / fault (scope note)

Full adversarial matrix (malformed files, device-lost WebGPU, 30‑min soak) was **not exhaustively re-executed** in this turn. Prior remediation (#758 freeze@88, #762 cold-open, #763–#765 cancel jobs, #767 slider a11y) remains on `main` and in published natives.

Fault-injection automated coverage exists partially via provider/privacy/architectural tests; expand Playwright device jobs in 30‑day roadmap.

---

## Changes in this audit PR

1. **`src/core/providers/selectProvider.js`** — do not use poisoned capability cache when `fetchImpl` is injected; export `clearSamCapabilityCache()`.
2. **`tests/mobile-ui.test.js`** — align with `createDspSliderRow` architecture.
3. **`public/app/how-it-works.html`** — remove false live-mic / live-input product claims.
4. **`scripts/check-privacy-invariants.js`** — also forbid `mic-capture` references from landing + HTML shells.
5. **This report** + command checklist.

---

## Release-readiness checklist

| Criterion | Status |
|-----------|--------|
| Clean install / lockfile | pnpm OK |
| validate / privacy / cloud-audio | **PASS** |
| lint (errors) | **PASS** |
| test:ci | **PASS** (post-fix) |
| production build | Required green on PR |
| Local-only audio policy verified | **PASS** (source + CI + headers) |
| Single STFT/iSTFT contract tested | **PASS** (suite) |
| Controls wired (registry) | **PASS** (67 IDs + DspSlider) |
| WebGPU→WASM ORT path | Present in MLWorker (device matrix limited) |
| Worklet no ML in `process()` | **PASS** (architecture + skill) |
| Essential upload/process/export | Web automated partial; full E2E device **LIMITED** |
| No auto-merge | Honored |

**GO if:** reviewers accept residual matrix gaps and Firebase optional cloud remains clearly non-audio.  
**NO-GO if:** a supported platform must ship with untested WebGPU/Safari blockers this week — then complete matrix first.

---

## 30 / 60 / 90 day hardening roadmap

**30 days**
- Playwright Engineer + Landing smoke on Chromium + Firefox; Android WebView smoke script
- Delete or quarantine `public/mic-capture.js` behind an explicit experimental package path
- Gate Firebase script behind feature flag so default shell makes **zero** gstatic requests
- Numeric STFT round-trip report artifact in CI (impulse + sine SNR thresholds)

**60 days**
- WebGPU device-lost + WASM fallback e2e
- Export codec honesty audit (WAV/MP3 claims vs encoders present)
- Electron signing/notarization + crash-log privacy review

**90 days**
- Soak harness (30–120 min) with memory sampling
- Dependency supply-chain pin review; reduce unused `@vercel/analytics` if unused
- Accessibility audit pass on all registry controls with axe + keyboard crawl

---

## Commands to reproduce

```bash
git checkout main && git pull
pnpm install
pnpm validate
pnpm check:privacy
pnpm check:cloud-audio
pnpm lint
pnpm test:ci
pnpm build
# optional focused:
pnpm test -- tests/providers-sam.test.js tests/mobile-ui.test.js tests/stft-math.test.js
```

Production header check:

```bash
curl -sI https://voice-isolate-pro.vercel.app/ | findstr /I "cross-origin permissions"
curl -sI https://voice-isolate-pro.vercel.app/app/ | findstr /I "cross-origin permissions"
```

# AUDIT_BASELINE — VoiceIsolate Pro

**Date:** 2026-08-09 (UTC)  
**Git HEAD:** `26bb58f` (`main`) + local audit branch fixes  
**Product version:** **25.0.1** (`package.json` / Android `versionCode` **250001** / iOS **250001**)  
**Auditor mode:** principal eng + QA + release + multi-platform  

This baseline is the Phase 0 source-of-truth map. It reflects the **actual repository**, not aspirational architecture.

---

## 1. Repository structure map

```
VoiceIsolate-Pro/
├── package.json              # Root app + scripts (v25.0.1)
├── pnpm-workspace.yaml       # packages/* workspace
├── pnpm-lock.yaml
├── server.js                 # Dev server (COOP/COEP, static public/)
├── vercel.json               # Production deploy + download redirects
├── capacitor.config.json     # Android/iOS WebView shell
├── eslint.config.js
├── CLAUDE.md / README.md / AGENTS.md
├── public/                   # Web shell (Vercel output)
│   ├── index.html + landing.js + landing.css   # Landing Live-Mix
│   ├── app/                  # Engineer Mode
│   ├── download/             # Download hub HTML
│   ├── lib/                  # ORT + three.js (local)
│   ├── models/ + app/models/ # ONNX markers + local models
│   ├── manifest.json + sw.js # PWA
│   └── mic-capture.js        # NOT wired into product (see risks)
├── src/                      # Canonical modules (sync → public/src for static)
│   ├── core/                 # audio-config, ModelManifest, FileLibrary, media-types
│   ├── pipeline/             # FileIngestion, media-decode, PlaybackMixer, stems
│   ├── presentation/         # UploadWiring, SliderUI, speakers
│   ├── workers/              # Gate/DeEsser processors
│   └── sam3_integration/     # Vision sidecar (flag OFF)
├── packages/vip-sam-runtime  # SAM-Audio packaging helper
├── services/sam-audio/       # Local Python SAM-Audio worker (127.0.0.1)
├── electron/                 # Desktop main/preload/builder
├── android/                  # Capacitor Android
├── ios/                      # Capacitor iOS (scaffold)
├── api/ + api-routes/        # Optional monetization/health (no audio)
├── scripts/                  # build, validate, smokes, mobile/electron
├── tests/                    # Jest (~129 suites)
├── docs/                     # DOWNLOADS, SAM, audits
└── .github/workflows/        # ci, deploy, release-build, eslint, semgrep
```

**Ignored / local-only (not shipped):** `node_modules/`, `build/`, `dist/`, `public/src/`, `.venv-sam/`, `.tools/`, `*.log`, large demucs ONNX.

---

## 2. Platforms and entry points

| Platform | Entry | Build / run | Artifact |
|----------|-------|-------------|----------|
| **Web Landing** | `public/index.html` → `landing.js` | Vercel / `pnpm dev` | https://voice-isolate-pro.vercel.app/ |
| **Web Engineer** | `public/app/index.html` → `app.js` | same | …/app/ |
| **Download hub** | `public/download/index.html` | same | …/download/ |
| **PWA** | `manifest.json` + `sw.js` → `/app/sw.js` | static | standalone display |
| **Android** | Capacitor `android/` WebView `webDir=build` | `pnpm android:build:win` | `VoiceIsolate-Pro-android-debug.apk` |
| **iOS** | Capacitor `ios/` | `pnpm ios:build` | scaffold (not primary ship) |
| **Desktop** | `electron/main.cjs` + `build/` | `pnpm build:electron` | `VoiceIsolate-Pro-25.0.1-win-x64.exe` |
| **SAM-Audio worker** | `services/sam-audio/server.py` | `pnpm sam:worker:prod` | localhost only |

---

## 3. Source of truth (ownership)

| Concern | Owner |
|---------|--------|
| **Product version** | `package.json#version` → `pnpm mobile:sync-version` |
| **DSP offline stages** | `public/app/dsp-core.js`, `dsp-stages.js`, `app.js` process path |
| **Live-Mix / RT params** | `src/pipeline/PlaybackMixer.js`, `EngineerModeBridge.js` |
| **STFT single-pass contract** | CLAUDE.md + `stft-math` / budget + architectural tests |
| **Upload / decode** | `src/presentation/UploadWiring.js`, `media-decode.js`, `FileIngestion.js`, `app.js#handleFile` |
| **ML models** | `src/core/ModelManifest.js`, `public/app/models-manifest.json`, ONNX under `public/app/models/` |
| **Feature flags (SAM3)** | `src/sam3_integration/`, env / localStorage / `?sam3=1` |
| **UI workflow tiers** | `public/app/workflow-tier.js` (Creator / Studio / Forensic) |
| **Downloads / releases** | `docs/DOWNLOADS.md`, `public/download/index.html`, `vercel.json` redirects, GitHub Releases |
| **Security headers** | `server.js`, `vercel.json` (COOP/COEP for SAB) |
| **Optional cloud auth** | `public/app/firebase-config.js` (**auth/presets only**, documented exception — **never audio**) |

---

## 4. Build / test commands (actual)

| Command | Purpose |
|---------|---------|
| `pnpm install` | Deps + ORT/Three setup |
| `pnpm validate` | Structure, sliders=67, stages=32, no mic in app, worklets |
| `pnpm check:cloud-audio` | No hosted cloud audio backends in processing sources |
| `pnpm worklets:verify` | Gate / de-esser / legacy packaging integrity |
| `pnpm models:validate` | ONNX URL/size presence |
| `pnpm test` / `pnpm test:ci` | Full Jest suite |
| `pnpm test:landing` | Playwright Landing E2E (ML + mix + transport) |
| `pnpm test:engineer` | Playwright Engineer RT sliders |
| `pnpm test:live` | Playwright full Engineer pipeline peak/NaN checks |
| `pnpm test:sam` / `pnpm test:sam3` | SAM packages / vision scaffold |
| `pnpm build` | `public/` + `src/` → `build/` (+ SAM ensure) |
| `pnpm android:build:win` | Debug APK → `dist/android/` |
| `pnpm build:electron` | NSIS → `dist/electron/` |

**CI (`.github/workflows/ci.yml`):** validate + optional model validate + DSP isolation + duplicate keys on PR/main. Uses `npm install` (not pnpm) — known drift risk (Medium).

---

## 5. Release / download routes (verified 2026-08-09)

| Asset | URL | HTTP |
|-------|-----|------|
| Download hub | https://voice-isolate-pro.vercel.app/download/ | **200** |
| Android APK latest | …/releases/latest/download/VoiceIsolate-Pro-android-debug.apk | **200** |
| Windows NSIS latest | …/releases/latest/download/VoiceIsolate-Pro-25.0.1-win-x64.exe | **200** |
| GitHub Latest tag | **v25.0.1** | — |

**In-repo links** in `public/download/index.html` and `docs/DOWNLOADS.md` match published v25.0.1 names (fixed in #743–#744).

---

## 6. Platform feature matrix

| Capability | Web | Android | Desktop |
|------------|-----|---------|---------|
| Landing Live-Mix stem split | Yes | Yes (WebView) | Yes |
| Engineer DSP / tiers | Yes | Yes | Yes |
| Upload-only (no product mic) | Yes | Yes | Yes |
| Local BSRNN / RNNoise / VAD | Yes | Yes (bundled) | Yes |
| Demucs (optional large) | CDN Blob optional | Optional / not full bundle | Optional |
| Peak-safe ML export (#745) | Yes | Yes (if rebuilt) | Yes (if rebuilt) |
| Windows octet-stream upload (#746) | Yes | Yes | Yes |
| SAM-Audio real Meta worker | Optional loopback | Limited | **Primary** (`services/sam-audio`) |
| SAM 3 vision | Flag OFF scaffold | Same | Same |
| PWA offline shell | SW present | N/A | N/A |
| Code signing | N/A | Debug APK only | Unsigned NSIS |
| Store listing | N/A | Not Play-signed | N/A |

---

## 7. Shared vs duplicated code

| Shared (good) | Duplication / drift risks |
|---------------|---------------------------|
| `src/pipeline/*` used by Landing + Engineer | Engineer still owns large `public/app/app.js` (~6k lines) |
| `UploadWiring` shared | Landing decode-on-upload vs Engineer deferred decode |
| Worklets under `src/workers` + `public/app` packaging | Legacy `dsp-processor.js` still shipped |
| Version sync script for mobile | PWA `manifest.json` was **21.0.0** (fixed this pass → 25.0.1) |
| COOP/COEP on server + vercel | Electron custom protocol must keep SAB path careful |

---

## 8. Findings (inspected)

### Critical
| ID | Finding | Status |
|----|---------|--------|
| C1 | ML isolation export peaks ~7.0 (no brickwall) | **Fixed** #745 |
| C2 | Windows `application/octet-stream` uploads rejected | **Fixed** #746 |
| C3 | Windows download URL pointed at non-existent 25.0.0 asset (404) | **Fixed** #743–#744; v25.0.1 released |

### High
| ID | Finding | Status / action |
|----|---------|-----------------|
| H1 | Published APK/EXE must include #745+#746; rebuild if older | Last rebuild included #745; **re-upload after #746 recommended** |
| H2 | Firebase CDN ESM for optional auth (not audio) | Documented exception; placeholders in config — do not ship real keys in repo |
| H3 | CI uses `npm install` while repo is pnpm-primary | Medium/High drift — prefer `pnpm install --frozen-lockfile` in CI |

### Medium
| ID | Finding | Status / action |
|----|---------|-----------------|
| M1 | PWA manifest version stale **21.0.0** | **Fixed this pass → 25.0.1** |
| M2 | `public/mic-capture.js` implements `getUserMedia` (not wired) | Documented; keep unwired |
| M3 | Demucs not always local (Blob CDN for large model) | By design optional; isolation chain defaults BSRNN |
| M4 | iOS scaffold only | OK if Android+Web+Desktop are ship targets |
| M5 | Unsigned desktop / debug APK | Documented on download page |

### Low
| ID | Finding |
|----|---------|
| L1 | Local `sam-*.log` files present (gitignored) |
| L2 | Multiple local clones on workstation (`VoiceIsolate-Pro` worktree diverged) — use audit clone or clean `origin/main` |
| L3 | Diarization ONNX optional — landing warns when missing |

### Security / secrets (this pass)
| Check | Result |
|-------|--------|
| Pattern scan (keys/tokens/PEM) in source | **No production secrets** — hits only test fixtures (`tests/monetization.test.js`, etc.) |
| `.env*` gitignored | Yes |
| `.env.example` | Placeholders only (Stripe, Blob, Vercel, store keys) |
| Cloud audio backends in processing sources | **`check:cloud-audio` PASS** |
| getUserMedia in product app path | Banned by validate for `public/app/*`; mic-capture unwired |

**If any real token was ever committed historically:** owner must revoke/rotate; not present in current tree scan.

---

## 9. Risk matrix (residual)

| Risk | Level | Mitigation |
|------|-------|------------|
| Super-unity ML peaks on old installs | High if not updated | Ship #745 binaries; web already fixed |
| Octet-stream upload fail on old web cache | Medium | Hard refresh; #746 on main |
| HF-gated SAM weights missing | Medium | Worker fails closed; mock only with explicit env |
| CI/npm vs pnpm lock drift | Medium | Align CI to pnpm |
| Firebase/auth network on Engineer boot | Low | Optional; auth module may skip |
| Multi-minute mobile OOM | Medium | Deferred decode + mid-only ML path |

---

## 10. Assumptions requiring verification

1. Production Vercel auto-deploys `main` after each merge (preview/prod links observed green).  
2. Release assets on GitHub `v25.0.1` were rebuilt with peak-safety; **upload fix #746 may post-date last APK/EXE** — rebuild to be definitive.  
3. “Wispr AI” in product language maps to **WhisperHunter** + AI enhancement modules in-repo (not a separate cloud service).  
4. Store credentials (Apple/Google) only via env for CI, never committed.  

---

## 11. Validation commands run for this baseline

| Command | Result |
|---------|--------|
| `node scripts/validate.js` | **PASS** |
| `node scripts/check-no-cloud-audio.js` | **PASS** |
| `node scripts/verify-worklets.js` | **PASS** |
| HTTP HEAD Android/Windows/download hub | **200 / 200 / 200** |
| Secret path scan (source tree) | **No live secrets** |
| Full Jest | **PASS** 130 suites / **2637** tests (`pnpm test:ci` equivalent) |
| `pnpm test:landing` | **PASS** |
| `pnpm test:engineer` | **PASS** |
| `pnpm test:live` | **PASS** (peak ≤ limThresh) |

---

## 12. Changes applied in this audit pass

| Change | Why |
|--------|-----|
| `AUDIT_BASELINE.md` | Phase 0 map (this document) |
| `public/manifest.json` version **25.0.1** | PWA was stale at 21.0.0 |
| `.github/workflows/ci.yml` → pnpm + test:ci | Align CI with lockfile; run unit tests |
| `public/mic-capture.js` header | Explicit “not product shell / no-mic rule” |
| Prior main: #743–#746 | Downloads, peak safety, upload octet-stream |

---

## 13. Explicit non-goals this pass

- Play Store / App Store full signing pipeline  
- Real Meta SAM-Audio HF weight distribution  
- Production SAM 3 vision weights  
- Full rewrite of Engineer `app.js` modularization  

---

*End of Phase 0 baseline. Subsequent phases must only modify code against findings above.*

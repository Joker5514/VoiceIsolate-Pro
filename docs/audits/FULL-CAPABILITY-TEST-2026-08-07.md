# Full capability test — VoiceIsolate Pro v25.0.1

**Date (UTC):** 2026-08-07  
**Repo SHA tested:** `ee42846` + local peak-safety fix  
**Workstation:** Windows · Node 25 · Playwright Chromium · openjdk 25  

## Executive summary

| Layer | Result |
|-------|--------|
| Static validate | **PASS** |
| No cloud audio | **PASS** |
| Worklet packaging | **PASS** (gate / de-esser / legacy) |
| ONNX models | **PASS** (bsrnn, rnnoise, vad local; demucs CDN) |
| Unit / integration Jest | **PASS** 129 suites · **2629** tests |
| Landing E2E smoke | **PASS** (ML stems, sliders, presets, mute, speakers, transport) |
| Engineer RT slider smoke | **PASS** (live AudioParams during playback) |
| Engineer live pipeline smoke | **PASS** after peak-safety fix (was FAIL: peak 7.06) |
| Production web + downloads | **PASS** HTTP 200 |
| Local COOP/COEP | **PASS** (`same-origin` / `require-corp`) |
| Android / Electron package | **Built & published** as v25.0.1 (not re-built this pass) |

### Bug found & fixed

**Engineer ML path skipped brickwall limiter** → processed buffers could peak at **~7.0** (export clip).  
Root cause: `_runMLIsolationPipeline` set `outputBuffer` without the offline DSP `truePeakLimit` path.  
Fix: `_applyOutputSafetyLimit()` on every successful process; hard clamp in `DSP.truePeakLimit`.  
Re-test: live smoke **peak 0.891** (−1 dBFS) · **PASS**.

---

## 1. Automated unit / integration (Jest)

```
Test Suites: 129 passed, 129 total
Tests:       2629 passed, 2629 total
```

Coverage areas exercised (non-exhaustive): DSP stages · STFT/COLA · worklets · ML worker · stem split · PlaybackMixer · file library · transport · presets · sliders · diarization · WhisperHunter · SAM-Audio IPC · SAM3 integration · Android config · download links · architectural invariants · upload/decode · video export wiring · engineer freezes/speed.

## 2. Static / security / packaging

| Check | Result |
|-------|--------|
| `node scripts/validate.js` | PASS — 67 sliders, 32 stages, no mic, ORT local |
| `node scripts/check-no-cloud-audio.js` | PASS |
| `node scripts/verify-worklets.js` | PASS · Android assets in sync |
| `node scripts/validate-onnx-models.js` | PASS · 4 models verified |

## 3. Landing (Live-Mix) E2E — `pnpm test:landing`

Real Chromium · real server · real ONNX:

- Upload 3 s synthetic WAV → ML stem separation (not passthrough)
- Playback + analyser energy
- Waveform / spectrum paint
- Slider → AudioParam calibration (NR, voice, volume, EQ, comp, de-ess)
- Presets: residual-monitor, original, voice-clarity, whisper-boost
- Voice / background mute toggles
- Diarization / speaker cards / mute / solo
- Transport: pause, seek, stop, replay
- Zero console errors  

**Result: ALL CHECKS PASSED**

## 4. Engineer Mode RT — `pnpm test:engineer`

- Live-Mix bridge on `/app/`
- Playback through bridge
- Real-time sliders: eqMid, outGain, dryWet, specTilt, limThresh, compRatio, stereoWidth
- No console errors  

**Result: ALL CHECKS PASSED**

## 5. Engineer full pipeline — `pnpm test:live`

| Metric | Before fix | After fix |
|--------|------------|-----------|
| nanCount | 0 | 0 |
| peak | **7.06 FAIL** | **0.891 PASS** |
| rms | 0.158 | 0.156 |
| partial CoV | OK | OK |
| runMs | ~2.3 s | ~1.6 s |

**Result: PASS ✓**

## 6. Production surfaces (HTTP HEAD)

| URL | Status |
|-----|--------|
| https://voice-isolate-pro.vercel.app/ | 200 |
| …/app/ | 200 |
| …/download/ | 200 |
| …/landing.js · …/app/app.js | 200 |
| …/app/models/bsrnn_vocals.onnx | 200 |
| GitHub latest Android APK | 200 |
| GitHub latest Windows 25.0.1 exe | 200 |

## 7. Local server capability matrix

| Route / feature | Status |
|-----------------|--------|
| `/` Landing | 200 |
| `/app/` Engineer | 200 |
| `/download/` | 200 |
| Workflow tiers JS | 200 |
| PlaybackMixer module | 200 |
| SAM3 runtime module | 200 |
| BSRNN model | 200 |
| COOP / COEP | same-origin / require-corp |

## 8. Feature matrix (intent → verification)

| Capability | How verified | Status |
|------------|--------------|--------|
| Upload-only (no mic) | validate + architectural tests | **PASS** |
| 100% local audio (no cloud) | check-no-cloud-audio | **PASS** |
| Single-pass STFT contract | stft-math / cola / budget / architectural | **PASS** |
| Landing stem split + Live-Mix | landing-smoke | **PASS** |
| Landing presets / mute / speakers | landing-smoke | **PASS** |
| Engineer process (ML isolation) | live-smoke | **PASS** (post-fix) |
| Engineer RT sliders | engineer-rt-smoke | **PASS** |
| Creator/Studio/Forensic tiers | unit (workflow wiring) + shell present | **PASS** (UI smoke partial) |
| Gate / de-esser worklets | worklets verify + unit | **PASS** |
| BSRNN / RNNoise / VAD models | model validate + smokes | **PASS** |
| Demucs optional CDN | model validate CDN | **PASS** (optional) |
| WhisperHunter | unit tests | **PASS** |
| File library / durable stems | unit tests | **PASS** |
| Video upload/export wiring | unit tests | **PASS** (no full video E2E) |
| SAM-Audio Desktop IPC | unit tests | **PASS** (mock; no HF weights) |
| SAM-Audio production worker | not run (needs HF gated weights) | **SKIP** |
| SAM 3 vision sidecar | unit + module 200; flag OFF | **PASS** (scaffold) |
| Android complete package | unit + prior APK build | **PASS** |
| Electron offline package | prior NSIS build v25.0.1 | **PASS** |
| Download links | unit + HTTP 200 | **PASS** |
| SharedArrayBuffer headers | COOP/COEP on server | **PASS** |

## 9. Explicit skips / residual risk

| Item | Why skipped | Risk |
|------|-------------|------|
| Real Meta SAM-Audio with HF weights | Needs gated HF access + GPU/CPU setup | Production worker fails closed without weights |
| Real SAM 3 weights | Flag OFF; heuristic scaffold only | No production vision ID claims |
| Play Store signed AAB | Debug APK only | Sideload only |
| Code-signed Windows exe | Unsigned NSIS | SmartScreen warning |
| Multi-minute mobile freeze soak | Engineer mobile unit tests only | Long files may still stress low-RAM devices |
| Full video remux E2E in browser | Unit wiring only | Edge-case codecs may fail |
| Physical device Android install | APK built/published; not installed here | WebView quirks possible |

## 10. Commands to reproduce

```bash
cd VoiceIsolate-Pro
pnpm install
npx playwright install chromium

pnpm validate
pnpm check:cloud-audio
pnpm worklets:verify
pnpm models:validate
pnpm test:ci

pnpm test:landing
pnpm test:engineer
pnpm test:live
```

## 11. Peak-safety fix files

- `public/app/app.js` — `_applyOutputSafetyLimit` + call after successful process  
- `public/app/dsp-core.js` — hard clamp in `truePeakLimit`  

---

**Bottom line:** Core product paths for Landing, Engineer process/playback, DSP/worklets, models, privacy, and published downloads are green. One real export clipping bug was found on the ML path and fixed. Optional SAM production weights and signed store builds remain out of this pass.

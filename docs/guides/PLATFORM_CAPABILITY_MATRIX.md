# Platform Capability Matrix (v25 + SAM Option B)

| Capability | Web/PWA | Android (Capacitor) | Desktop Electron |
|------------|---------|---------------------|------------------|
| Shared renderer (`public/app` + `src`) | ✅ | ✅ WebView | ✅ |
| Local ONNX (BSRNN/RNNoise/VAD) | ✅ | ✅ (device-dependent) | ✅ |
| ECAPA-TDNN speaker embedding (optional) | ✅ if model fetched (`pnpm models:fetch-ecapa`, SHA-verified); absent → `unavailable` + mel fallback | ✅ same (WebView build) | ✅ if assets present |
| Live-Mix worklets (gate/de-ess) | ✅ | ✅ if WebAudio OK | ✅ |
| Live microphone capture | ❌ by design | ❌ by design | ❌ by design |
| Prompted Isolation (USM query) | ✅ offline | ✅ offline | ✅ offline |
| Real SAM-Audio (Meta PyTorch worker) | ❌ page cannot reach it | ❌ | ⚪ IPC + CUDA/CPU; no shipping UI calls it yet |
| SAM-Audio ONNX on-device | ❌ no loader | ❌ no loader (excluded from APK) | ❌ no loader |
| Local SAM-Audio worker (loopback) | ❌ page cannot reach it (no CORS, Origin refused) | ❌ same | ✅ IPC spawn + main-process proxy |
| **SAM 3 vision sidecar** (`src/sam3_integration`) | ✅ bundled (flag OFF) | ✅ in WebView build (flag OFF) | ✅ in app + extraResources (flag OFF) |
| SAM 3 real browser weights | ⚪ if `/app/models/sam3/*` | ⚪ if assets present | ⚪ if assets present |
| Cloud/fal/Replicate audio or vision inference | ❌ forbidden | ❌ forbidden | ❌ forbidden |
| Single-pass STFT budget | ✅ | ✅ | ✅ |

**SAM 3 vs SAM-Audio:** SAM 3 = optional **vision/video** tracking (not audio separation). Enable with `VIP_SAM3_ENABLED=1`. See [SAM3_TECHNICAL_DOCUMENTATION.md](../SAM3_TECHNICAL_DOCUMENTATION.md).

## Verification state (2026-11-04, PR #888 branch — not published state)

Browser tier 11/11 in Chromium on the PR branch (incl. CSP +
privacy smokes); corpus baseline, stress sweep, diarization and
ECAPA evals measured on the same branch. Firefox/WebKit not run
here; Android/desktop artifacts not built here. Full refresh:
[`VERIFICATION_STATE.md`](VERIFICATION_STATE.md). The published
`v25.0.3` artifacts predate current source and are not
synchronized with it (`releases/PLATFORM_SYNC.md`).

## Android notes

- minSdk effective **26**, target/compile **35**, Capacitor **8.3**
- No on-device SAM-Audio: no loader exists, and `sam_audio.onnx` is excluded from the APK
- Prompted isolation uses **USM + existing ONNX** (fully local)
- largeHeap enabled; long jobs must yield / cancel

## Desktop notes

- Electron **39**, contextIsolation + sandbox
- SAM worker: `python services/sam-audio/server.py` via main IPC
- Packaged builds seed ONNX models to userData cache

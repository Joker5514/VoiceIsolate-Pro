# Platform Capability Matrix (v25 + SAM Option B)

| Capability | Web/PWA | Android (Capacitor) | Desktop Electron |
|------------|---------|---------------------|------------------|
| Shared renderer (`public/app` + `src`) | ✅ | ✅ WebView | ✅ |
| Local ONNX (BSRNN/RNNoise/VAD) | ✅ | ✅ (device-dependent) | ✅ |
| Live-Mix worklets (gate/de-ess) | ✅ | ✅ if WebAudio OK | ✅ |
| Live microphone capture | ❌ by design | ❌ by design | ❌ by design |
| Prompted Isolation (USM query) | ✅ offline | ✅ offline | ✅ offline |
| Real SAM-Audio (Meta PyTorch worker) | ⚪ loopback if user runs worker | ❌ (use ONNX path) | ✅ IPC + CUDA/CPU |
| SAM-Audio ONNX on-device | ⚪ if `sam_audio.onnx` shipped | ⚪ if model in assets/WebView | ⚪ optional |
| Local SAM-Audio worker (loopback) | ⚪ user-run | ⚪ advanced (ADB reverse) | ✅ IPC spawn |
| **SAM 3 vision sidecar** (`src/sam3_integration`) | ✅ bundled (flag OFF) | ✅ in WebView build (flag OFF) | ✅ in app + extraResources (flag OFF) |
| SAM 3 real browser weights | ⚪ if `/app/models/sam3/*` | ⚪ if assets present | ⚪ if assets present |
| Cloud/fal/Replicate audio or vision inference | ❌ forbidden | ❌ forbidden | ❌ forbidden |
| Single-pass STFT budget | ✅ | ✅ | ✅ |

**SAM 3 vs SAM-Audio:** SAM 3 = optional **vision/video** tracking (not audio separation). Enable with `VIP_SAM3_ENABLED=1`. See [SAM3_TECHNICAL_DOCUMENTATION.md](../SAM3_TECHNICAL_DOCUMENTATION.md).

## Android notes

- minSdk effective **26**, target/compile **35**, Capacitor **8.3**
- Real on-device SAM = optional **SAM-Audio ONNX** under `/app/models/sam_audio.onnx` (ORT in WebView)
- Without that file, prompted isolation uses **USM + existing ONNX** (still fully local)
- largeHeap enabled; long jobs must yield / cancel

## Desktop notes

- Electron **39**, contextIsolation + sandbox
- SAM worker: `python services/sam-audio/server.py` via main IPC
- Packaged builds seed ONNX models to userData cache

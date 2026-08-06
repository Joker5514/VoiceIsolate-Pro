# Platform Capability Matrix (v25 + SAM Option B)

| Capability | Web/PWA | Android (Capacitor) | Desktop Electron |
|------------|---------|---------------------|------------------|
| Shared renderer (`public/app` + `src`) | ✅ | ✅ WebView | ✅ |
| Local ONNX (BSRNN/RNNoise/VAD) | ✅ | ✅ (device-dependent) | ✅ |
| Live-Mix worklets (gate/de-ess) | ✅ | ✅ if WebAudio OK | ✅ |
| Live microphone capture | ❌ by design | ❌ by design | ❌ by design |
| Prompted Isolation (USM query) | ✅ offline | ✅ offline | ✅ offline |
| Browser SAM-Audio ONNX | ❌ not verified | ❌ | ❌ |
| Local SAM-Audio worker (loopback) | ⚪ user-run | ⚪ advanced only | ✅ IPC spawn |
| Cloud/fal/Replicate audio | ❌ forbidden | ❌ forbidden | ❌ forbidden |
| Single-pass STFT budget | ✅ | ✅ | ✅ |

## Android notes

- minSdk effective **26**, target/compile **35**, Capacitor **8.3**
- Do **not** claim on-device SAM without device matrix + model export
- largeHeap enabled; long jobs must yield / cancel

## Desktop notes

- Electron **39**, contextIsolation + sandbox
- SAM worker: `python services/sam-audio/server.py` via main IPC
- Packaged builds seed ONNX models to userData cache

# VoiceIsolate Pro v24.0 — Mobile Compatibility Report

**Date:** 2026-06-03  
**Platforms Analyzed:** Android (Capacitor 8), iOS (Capacitor 8), Mobile Web  
**Branch:** `claude/voiceisolate-pro-modernization-h00XA`

---

## 1. Feature Compatibility Matrix

| Feature | Chrome Android | Safari iOS | Firefox Android | Capacitor Android | Capacitor iOS |
|---------|---------------|------------|-----------------|-------------------|---------------|
| AudioContext | ✅ | ✅ | ✅ | ✅ | ✅ |
| AudioWorklet | ✅ Chrome 67+ | ✅ Safari 14.1+ | ✅ Firefox 76+ | ✅ | ✅ |
| SharedArrayBuffer | ✅ COOP+COEP | ⚠️ Requires COOP+COEP | ✅ COOP+COEP | ⚠️ WKWebView | ⚠️ WKWebView |
| Web Workers | ✅ | ✅ | ✅ | ✅ | ✅ |
| ONNX Runtime WASM | ✅ | ✅ | ✅ | ✅ | ✅ |
| ONNX Runtime WebGPU | ✅ Chrome 113+ | ❌ Not supported | ❌ | ✅ | ❌ |
| WASM SIMD | ✅ | ✅ Safari 16.4+ | ✅ | ✅ | ✅ Safari 16.4+ |
| Atomics | ✅ | ✅ | ✅ | ⚠️ WKWebView flags | ⚠️ WKWebView flags |
| Cache API | ✅ | ✅ | ✅ | ✅ | ✅ |
| IndexedDB | ✅ | ✅ | ✅ | ✅ | ✅ |
| `crossOriginIsolated` | ✅ | ⚠️ Limited | ✅ | ❌ WKWebView | ❌ WKWebView |

---

## 2. Critical Issues

### MOB-01 — SharedArrayBuffer in WKWebView (iOS / Capacitor)

**Status:** Known limitation  
**Impact:** SharedArrayBuffer is unavailable in WKWebView without service worker injection of COOP/COEP headers. The `sw.js` service worker fallback provides header injection, but WKWebView's limitations prevent full cross-origin isolation.

**Current Mitigation:**
- `_allocateRings()` checks `self.crossOriginIsolated` and falls back gracefully
- Without SAB: ML masking is disabled; DSP passthrough mode activates
- The app still processes audio via offline DSP pipeline (no live ML inference)

**Recommended Future Fix:** Use Capacitor's `CapacitorHttp` plugin to add COOP/COEP headers at the native layer for iOS. Track Android WebView status as Chromium 92+ supports COOP/COEP.

---

### MOB-02 — WebGPU Unavailable on iOS Safari / Capacitor iOS

**Status:** Known limitation  
**Impact:** ONNX Runtime defaults to WASM execution on iOS. Processing is significantly slower than on WebGPU-capable Android devices.

**Current Mitigation:**
- `ml-worker.js` automatically falls back to WASM (`detectAndroidWebView()`)
- WASM SIMD is used when available (Safari 16.4+)
- Demucs v4 load is deferred to prevent OOM on first launch

---

### MOB-03 — Memory Pressure on Mobile

**Status:** Active concern  
**Impact:** Loading all ML models simultaneously (~96 MB) causes OOM crashes on low-RAM Android devices (<3 GB) and older iPhones.

**Current Mitigations:**
- Demucs v4 (87 MB) excluded from `allowedModels` at worker init
- Demucs loaded on-demand only when separation is explicitly requested
- Small models (VAD, RNNoise) preloaded via `_vipPreloadModels(['silero_vad', 'rnnoise'])`

**Recommendation:** Add a memory pressure observer (if the Memory Pressure API becomes available in WebKit) and unload Demucs when in background.

---

## 3. Android-Specific Notes

### AudioWorklet Availability
- Chromium-based Android WebView: AudioWorklet available since Chrome 66 (Android)
- Samsung Internet: Available since version 8.0
- Minimum requirement: Chrome 66 / WebView 66

### SharedArrayBuffer
- Standard Chromium 92+ Android: SAB available with COOP+COEP headers
- Older Android WebView: May require `--enable-features=CrossOriginIsolation` flag
- Capacitor 8 target: Android API 22+ (covers Chrome 88+ WebView baseline)

---

## 4. iOS-Specific Notes

### AudioWorklet Availability  
- Safari 14.1+ (iOS 14.5+): Full AudioWorklet support
- Older Safari: Falls back to ScriptProcessor (deprecated) — **not implemented**
- Recommendation: Detect AudioWorklet availability via `startup-healthcheck.js:verifyWorklet()`

### WASM SIMD
- Safari 16.4+ (iOS 16.4+): WASM SIMD supported
- Earlier Safari: ONNX Runtime falls back to non-SIMD WASM
- Performance impact: ~2-4× slower inference without SIMD

### Audio Session
- iOS requires user gesture before `AudioContext` can be created (Web Audio autoplay policy)
- The app correctly defers `AudioContext` creation to the first click/keydown event
- Capacitor's `App.addListener('appResume', ...)` should resume suspended AudioContext

---

## 5. Capability Detection (startup-healthcheck.js)

The new `startup-healthcheck.js` module provides:

```javascript
import { runStartupHealthcheck } from './startup-healthcheck.js';
const result = await runStartupHealthcheck();

result.capabilities = {
  audioWorklet: boolean,
  sharedArrayBuffer: boolean,
  atomics: boolean,
  crossOriginIsolated: boolean,
  onnxRuntime: boolean,
  workerReachable: boolean,
  committedModels: string[],
  missingModels: string[],
}
```

**Automatic Fallbacks:**

| Capability Missing | Fallback Mode |
|-------------------|---------------|
| AudioWorklet | DSP passthrough via OfflineAudioContext (Worker DSP) |
| SharedArrayBuffer | Transferable message-based inference (no SAB rings) |
| ONNX Runtime | Classical DSP only (no ML enhancement) |
| WebGPU | WASM execution path |
| WASM SIMD | Non-SIMD WASM path |

---

## 6. Capacitor 8 Configuration

### capacitor.config.json
```json
{
  "appId": "com.voiceisolatepro.app",
  "appName": "VoiceIsolate Pro",
  "webDir": "public",
  "plugins": {
    "SplashScreen": { "launchShowDuration": 1500 }
  }
}
```

### Android Build Requirements
- Android Studio Hedgehog or later
- NDK 25+ for WASM compilation
- `minSdkVersion`: 22 (Android 5.1)
- `targetSdkVersion`: 34 (Android 14)

### iOS Build Requirements
- Xcode 15+
- iOS deployment target: 14.0 (for AudioWorklet support)
- Swift 5.9+

---

## 7. Performance Benchmarks (Estimated)

| Device Class | Processing 1 min Audio | ML Mode |
|-------------|------------------------|---------|
| Android (Pixel 7, WebGPU) | ~8-15 seconds | Full (Demucs + VAD) |
| Android (mid-range, WASM SIMD) | ~25-40 seconds | VAD + RNNoise only |
| iOS 16+ (WASM SIMD) | ~30-45 seconds | VAD + RNNoise only |
| iOS 14-15 (non-SIMD) | ~60-90 seconds | VAD only |
| Low-RAM Android (<3 GB) | ~20-30 seconds | DSP passthrough |

---

## 8. Recommendations

1. **Implement Capacitor native HTTP plugin** to inject COOP/COEP headers at the native level for iOS, enabling SAB and live ML inference in Capacitor apps.
2. **Add `appResume` listener** to resume suspended AudioContext after iOS app backgrounding.
3. **Implement progressive model loading** — load VAD first (2.2 MB), process audio with minimal ML, then lazily load larger models in the background.
4. **Add offline/airplane-mode detection** — gracefully handle network-dependent model fetching.
5. **Implement WASM memory limit** — cap WASM heap at 512 MB to prevent OOM on memory-constrained devices.

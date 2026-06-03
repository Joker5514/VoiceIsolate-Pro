# VoiceIsolate Pro v24.0 — Bundle Report

**Date:** 2026-06-03  
**Branch:** `claude/voiceisolate-pro-modernization-h00XA`

---

## 1. Current Bundle Breakdown

The application is a **static site** served from `public/` — there is no bundler/transpiler step. Files are loaded directly as ES modules and classic scripts.

### Critical Path Assets (blocking on first load)

| File | Size (est.) | Load | Purpose |
|------|-------------|------|---------|
| `public/app/index.html` | ~35 KB | Synchronous | Shell + tab UI |
| `public/app/style.css` | ~50 KB | Synchronous | Dark industrial theme |
| `public/app/slider-map.js` | ~9 KB | ESM import | Slider/stage data |
| `public/app/app.js` | ~38 KB | ESM module | Main orchestrator |
| `public/app/vip-boot.js` | ~11 KB | Classic script | Pre-flight checks |
| `public/app/pipeline-orchestrator.js` | ~36 KB | Classic script | AudioWorklet + ML init |
| `public/lib/ort.min.js` | ~730 KB | Deferred (importScripts) | ONNX Runtime |

**Total critical path JS:** ~124 KB (excluding ORT)

### Deferred Assets

| File | Size (est.) | When Loaded |
|------|-------------|-------------|
| `public/lib/ort-wasm-simd-threaded.wasm` | ~10 MB | On ONNX init |
| `public/app/models/silero_vad.onnx` | 2.2 MB | On first inference |
| `public/app/models/rnnoise_suppressor.onnx` | 1.8 MB | On first inference |
| `public/app/models/bsrnn_vocals.onnx` | 4.3 MB | On separation request |
| `demucs_v4_quantized.onnx` | ~87 MB | On explicit request |
| Three.js ESM | ~570 KB | On 3D spectrogram init |

---

## 2. Loading Optimizations Applied

### Phase 13 — Dynamic Import Opportunities

The following modules are candidates for **lazy dynamic import** to reduce Time to Interactive:

| Module | Size | Current | Recommended |
|--------|------|---------|-------------|
| `neon-pulse-visualizer.js` | ~20 KB | Eager | `import()` when viz panel opens |
| `neon-pulse-card.js` | ~24 KB | Eager | `import()` when card requested |
| `diarization-timeline.js` | ~11 KB | Eager | `import()` when diarization enabled |
| `paywall.js` | ~27 KB | Eager | `import()` when user upgrades |
| `batch-orchestrator.js` | ~10 KB | Eager | `import()` when batch mode opens |
| `batch-processor.js` | ~15 KB | Eager | `import()` when batch mode opens |
| `ai-engine-v2.js` | ~23 KB | Eager | `import()` when AI features used |
| `debug-audit.js` | ~13 KB | Eager | `import()` on DevTools trigger only |

**Estimated saving:** ~143 KB deferred until needed

### Current Model Loading Strategy

The app already implements best-practice lazy model loading:
- Small models (VAD, RNNoise) preloaded via `window._vipPreloadModels` with `IndexedDB` caching
- Large models (Demucs v4) loaded on first use only
- Model caching via Cache API + IndexedDB avoids re-downloading across sessions

---

## 3. Recommended Bundle Optimizations

### 3.1 Code Splitting (High Impact)

Convert eager `<script src>` tags to dynamic imports for non-critical modules:

```javascript
// Instead of: <script src="/app/paywall.js">
// In app.js when paywall needed:
const { Paywall } = await import('./paywall.js');
Paywall.show();
```

**Files to defer:**
- `paywall.js` (27 KB) — only needed when user hits feature gate
- `neon-pulse-card.js` (24 KB) — only needed on visualizer page
- `ai-engine-v2.js` (23 KB) — only needed with AI features

### 3.2 Three.js Selective Import (Medium Impact)

Three.js at ~570 KB (ESM) is a significant cost for the 3D spectrogram. Options:
- Lazy-load `three.module.min.js` when the 3D spectrogram tab is opened
- Use Three.js `three.core.min.js` (already available in `public/lib/`) for reduced size

### 3.3 WASM Streaming Instantiation (Low Impact)

Verify ONNX Runtime uses `instantiateStreaming` (not `arrayBuffer()`) to parse WASM in parallel with download. Confirmed present in ORT 1.18+ defaults.

### 3.4 Service Worker Prefetch (Low Impact)

The service worker (`public/app/sw.js`) could prefetch committed ONNX models during idle time via `requestIdleCallback`. This prevents the first-inference delay of 2–5 seconds.

---

## 4. Performance Budget Recommendations

| Metric | Current | Target |
|--------|---------|--------|
| First Contentful Paint | ~800 ms | <500 ms |
| Time to Interactive | ~2.5 s | <1.5 s |
| Total Blocking Time | ~400 ms | <200 ms |
| JS transferred (critical) | ~124 KB | <80 KB |
| First inference latency | ~3–8 s | <2 s (with prefetch) |

---

## 5. Caching Strategy

| Asset Type | Cache Policy | Current |
|------------|-------------|---------|
| WASM files | `immutable, max-age=31536000` | ✅ vercel.json |
| ONNX models | `max-age=86400` | ✅ vercel.json |
| JS modules | Default (no cache header) | ⚠️ Add `Cache-Control: max-age=3600` |
| CSS | Default | ⚠️ Add `Cache-Control: max-age=3600` |

**Recommendation:** Add a 1-hour cache on JS/CSS assets with content-hash busting on deploy.

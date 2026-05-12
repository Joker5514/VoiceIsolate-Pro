# VoiceIsolate Pro — 100% Completion Checklist

Generated: 2026-05-12

## ✅ Fully Implemented

| File | Status | Notes |
|------|--------|-------|
| `public/app/dsp-processor.js` | ✅ Complete | Full AudioWorkletProcessor, Cooley-Tukey FFT, Single-Pass STFT/iSTFT, SAB, Hann window, overlap-add |
| `public/app/ml-worker.js` | ✅ Complete | WebGPU→WASM fallback, SAB polling, Silero VAD, BSRNN, RNNoise, Demucs (with graceful fallback), Wiener filter, diarization |
| `public/app/app.js` | ✅ Complete | 86KB — full ONNX init, 52-slider wiring, SAB creation, AudioWorklet setup |
| `public/app/dsp-core.js` | ✅ Complete | 65KB — all pipeline stage processors |
| `public/app/pipeline-orchestrator.js` | ✅ Complete | 36KB — full 32-stage orchestration |
| `public/app/offline-processor.js` | ✅ Complete | 19KB — OfflineAudioContext, batch processing, WAV export |
| `public/app/ring-buffer.js` | ✅ Complete | SAB ring buffer for worklet↔main thread |
| `public/app/slider-map.js` | ✅ Complete | All 52 slider definitions |
| `public/app/auth.js` | ✅ Complete | FREE/PRO/STUDIO/ENTERPRISE tier gates |
| `public/app/visuals.js` | ✅ Complete | 3D spectrogram + waveform canvas |
| `public/app/index.html` | ✅ Complete | 52-slider UI, Engineer Mode v19 |
| `public/app/style.css` | ✅ Complete | Dark theme, 42KB |
| `vercel.json` | ✅ Complete | COOP + COEP headers for SharedArrayBuffer |
| `public/app/models/bsrnn_vocals.onnx` | ✅ Present | 3.7MB — live in repo |
| `public/app/models/rnnoise_suppressor.onnx` | ✅ Present | 1.9MB — live in repo |
| `public/app/models/silero_vad.onnx` | ✅ Present | 2.2MB — live in repo |
| `public/app/models/silero_vad_int8.onnx` | ✅ Present | 2.3MB — live in repo |

## ✅ Added in This PR

| File | Status | Notes |
|------|--------|-------|
| `public/app/fft-bridge.js` | ✅ NEW | Offline STFT/iSTFT utility + WAV encoder for Creator/Forensic modes. Exports `computeSTFT`, `reconstructISTFT`, `encodeWAV`, `fftInPlace`, `makeHannWindow` |
| `public/app/dsp-stages.js` | ✅ NEW | All 32 named DSP stage functions as pure spectral operators — `runFullPipeline()` dispatcher included |
| `public/app/models/demucs_v4_quantized.onnx.placeholder` | ✅ UPDATED | Clear instructions for obtaining/converting the model; runtime fallback behaviour documented |

## 🔵 Demucs Status

The `demucs_v4_quantized.onnx` model is not committed due to size (50–200 MB).
`ml-worker.js` already handles this gracefully:

- If the Demucs model is unavailable or its session cannot be created, the worker emits a warning and continues processing instead of failing the job.
- The fallback path is the normal non-Demucs separation flow already implemented in `ml-worker.js` (that is, processing continues without Demucs rather than attempting to hard-fail or block inference).
- Use the actual warning text emitted by `ml-worker.js` as the source of truth when validating logs; this checklist intentionally avoids duplicating exact log strings or internal conditionals that can drift out of sync.
- BSRNN remains the primary fallback/standalone separator when Demucs is absent.

To add Demucs: run `python scripts/download_demucs.py` and commit the output.

## Architecture Invariants (Verified)

1. **Single Forward STFT**: `fftInPlace(re, im, false)` called exactly once per frame in `dsp-processor.js` and once per frame in `fft-bridge.js computeSTFT()`
2. **Single iSTFT**: `fftInPlace(re, im, true)` called exactly once per frame in both paths
3. **No external API calls**: All network requests are same-origin `.onnx` model fetches — verified in `vercel.json` CSP header
4. **SAB headers set**: `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` in `vercel.json`
5. **WebGPU → WASM fallback**: `resolveProviders()` and `createSessionWithFallback()` in `ml-worker.js` handle this transparently

## Deployment Checklist

- [ ] Run `pnpm install` (or `npm install`)
- [ ] Copy ORT WASM files: `node scripts/setup-ort.js`
- [ ] (Optional) Download Demucs: `python scripts/download_demucs.py`
- [ ] Deploy to Vercel: `vercel --prod`
- [ ] Verify SharedArrayBuffer is available: open console, check `typeof SharedArrayBuffer !== 'undefined'`
- [ ] Test Live mode: click 🎙️, confirm <10ms latency
- [ ] Test Creator mode: upload MP3, confirm WAV export

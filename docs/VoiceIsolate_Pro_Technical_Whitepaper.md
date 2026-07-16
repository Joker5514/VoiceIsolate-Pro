# VoiceIsolate Pro — Technical Whitepaper (v26)

**Audience:** DSP engineers, HCI researchers, and developers extending the stack  
**Companion:** `docs/VoiceIsolate_Pro_Architecture_v26.md`  
**Constraint:** 100% local inference; single-pass spectral contract  

---

## Abstract

VoiceIsolate Pro performs **on-device voice isolation** in the browser by separating offline machine-learning source separation from real-time mix controls. A single offline pass produces clean and residual stems; a Web Audio Live-Mix graph then exposes sub-frame parameter control without re-running neural networks. Spectral processing obeys a **single forward STFT and single inverse STFT** per path, avoiding cumulative phase smearing from multi-pass transforms.

---

## 1. Problem setting

Recovering speech from noise, music, or multi-talker scenes is classically solved with spectral subtraction, Wiener filtering, or supervised deep networks. Browser constraints differ from desktop DAWs:

- No guaranteed GPU until WebGPU is available  
- Strict real-time audio quantum (128 samples)  
- Memory and GC pressure that destroy live-mic ring-buffer designs  

VoiceIsolate Pro therefore **decouples** heavy isolation from live interaction.

---

## 2. Architecture

### 2.1 Stem-Split & Live-Mix

1. **Stem-Split (offline):** decode → 48 kHz → ONNX (BS-RNN / Demucs / RNNoise chain) → clean + noise stems.  
2. **Live-Mix (real-time):** dual buffer sources → gains → EQ → compressor → gate/de-esser worklets → destination.

Sliders never call `InferenceSession.run`. This yields **zero ML latency** on parameter changes.

### 2.2 Single-pass spectral contract

For offline DSP refinement:

\[
x \xrightarrow{\mathrm{STFT}} X \xrightarrow{\text{in-place ops}} X' \xrightarrow{\mathrm{iSTFT}} \hat{x}
\]

In-place ops include Wiener NR, voice-band focus, WhisperHunter gain, extreme isolation masks. Multiplicative mask composition follows:

\[
X' = X \cdot \max\!\big( \prod_k M_k,\; M_{\mathrm{floor}} \big)
\]

with \(M_{\mathrm{floor}}\) typically \(-30\) dB.

### 2.3 Dual mode FFT budgets

| Mode | FFT | Hop | Intent |
|------|-----|-----|--------|
| Live-Mix | n/a (PCM stems) | n/a | Sub-10 ms param response |
| Creator (Engineer default) | 2048 | 768 | Speed / quality balance |
| Forensic | 4096 | 1024 | Whisper recovery resolution |

Ring-buffer constants require `HOP_SIZE % 128 === 0` for any future quantum-aligned spectral live path (`src/core/ring-buffer-constants.js`).

---

## 3. Machine learning

### 3.1 Runtime

ONNX Runtime Web with:

1. **WebGPU** primary (when `navigator.gpu` adapter exists)  
2. **WASM** SIMD/threaded fallback  

Models are same-origin, **SHA-256 verified**, cached in IndexedDB (web) or filesystem (desktop).

### 3.2 Model tasks

| Model | Role | Strategy |
|-------|------|----------|
| `bsrnn_vocals` | Default vocal mask | Spectral magnitude mask |
| `rnnoise` | Denoise mask | Spectral magnitude mask |
| `demucs` | Heavy separation | Waveform segment |
| Silero VAD | Activity (optional) | Time-domain |

Inference runs in a **classic Worker** (`MLWorker.js`), never inside `AudioWorkletProcessor.process()`.

---

## 4. Latency and quality trade-offs

| Path | Typical cost | Quality notes |
|------|--------------|---------------|
| Live-Mix only | Hardware + graph | Perfect for A/B stem balance |
| BS-RNN isolate | Model size ~4 MB + STFT OLA | Fast first-load after compile |
| Demucs chain | ~149 MB quantized | Higher quality, long first compile |
| DSP fallback | Single STFT path on mid channel | Used when ML passthrough |

Stereo files use **mid-channel ML** once, re-expanding with a gain envelope to preserve imaging (~2× faster).

---

## 5. WhisperHunter

WhisperHunter is a **local** adaptive spectral enhancer for low-SNR speech:

- Broader formant band (~200–5500 Hz)  
- Hangover VAD for whisper tails  
- Soft Wiener + harmonic reinforcement  
- Platform profiles (desktop/browser/Android) for chunk budgets  

It augments, not replaces, ML isolation.

---

## 6. Reproducibility (Research Mode)

Enable Research Mode in Engineer UI to:

1. Log model IDs, FFT/hop, full parameter snapshot  
2. Capture stage timings (`decode`, `ml_isolation`, `pipeline`)  
3. Export JSON session files locally  
4. Export the typed parameter schema for papers/supplements  

Modules: `src/core/ResearchSession.js`, `public/app/research-mode.js`, `src/pipeline/BenchmarkHarness.js`.

---

## 7. Extending the system

### Add a model

1. Place `.onnx` under `public/app/models/`  
2. Add entry + SHA-256 to `src/core/ModelManifest.js`  
3. Implement strategy branch in `MLWorker.js` if not spectral-mask/waveform  

### Add a Live-Mix control

1. Add AudioParam setter on `PlaybackMixer`  
2. Map slider in `EngineerModeBridge.PARAM_MAP` or landing `SliderUI`  
3. Document in `ParameterSchema.js`  

### Add offline spectral stage

Insert **inside** the single STFT window in `_spectralStageAsync` — never open a second STFT/iSTFT pair on the same channel path.

---

## 8. Ethical and privacy notes

- Audio never leaves the device for inference.  
- License/auth endpoints may exchange tokens only; they must not receive PCM.  
- Researchers should document browser, WebGPU availability, and model hashes when publishing results.

---

## 9. References (internal)

- `CLAUDE.md` — AI contributor source of truth  
- `docs/VoiceIsolate-Pro_Master_Blueprint_v2.1.md`  
- `docs/WORKLETS.md`  
- `docs/audits/AUDIT-REPORT-2026-06-21.md`  

---

*Whitepaper revision aligned with Architecture v26.*

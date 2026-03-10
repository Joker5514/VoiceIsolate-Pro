# ML Model Files

VoiceIsolate Pro uses ONNX Runtime Web for local inference. No audio leaves the device.

---

## Silero VAD v5 (Required — 2 MB)

Automatically used when present. Enables intelligent noise reduction that only suppresses
noise during non-speech segments, preserving voice quality.

**Download:**
```bash
curl -L -o silero_vad.onnx \
  "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"
```

---

## DeepFilterNet3 — Low-Latency Variant (Recommended — ~35 MB total)

Real-time speech enhancement: noise suppression + de-reverberation. Used by `ml-worker.js`
between VAD and Demucs. Three sub-models must be placed in this directory together.

**Download (all three at once):**
```bash
curl -L "https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/DeepFilterNet3_ll_onnx.tar.gz" \
  | tar -xz --strip-components=1
```

This extracts:
- `enc.onnx`      — encoder (~10 MB)
- `erb_dec.onnx`  — ERB mask decoder (~10 MB)
- `df_dec.onnx`   — deep-filter coefficient decoder (~15 MB)

If any of the three is missing the worker skips DeepFilterNet entirely and falls back
to spectral NR in the main pipeline.

**Requirements:**
- Sample rate: 48 kHz (the worker resamples automatically)
- Latency target: < 20 ms/chunk on modern hardware (WASM), < 5 ms with WebGPU

---

## Demucs v4 (Optional — ~150 MB, WebGPU recommended)

High-quality ML vocal stem separation. The worker attempts to load this when
`navigator.gpu` is available (WebGPU-capable browser).

Place the INT8-quantised ONNX export at `public/app/models/demucs_v4.onnx`.

See: https://github.com/facebookresearch/demucs

---

## BSRNN (Blocked — not yet integrated)

Band-Split RNN requires `einops` ops not supported by ONNX Runtime Web's WASM backend.
Graceful fallback: pipeline skips BSRNN silently.

---

## DeepFilterNet3 (Optional — ~35MB total, 3 files)

Real-time speech denoising and de-reverberation. Operates at 48 kHz with 10 ms
latency. Runs **before** Demucs in the pipeline: VAD → DeepFilterNet → Demucs.
Falls back silently if the files are absent — Demucs separation is unaffected.

**Download:**
```bash
# From the VoiceIsolate-Pro repo root:
mkdir -p public/app/models/deepfilter
curl -L "https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/DeepFilterNet3_ll_onnx.tar.gz" \
  | tar -xz --strip-components=1 -C public/app/models/deepfilter
# Extracts: enc.onnx  erb_dec.onnx  df_dec.onnx  (~35 MB combined)
```

**Load in app.js:**
```js
mlWorker.postMessage({ type: 'loadModel', model: 'deepfilter', wasmRoot });
```

**Enhance before separation:**
```js
// 1. Enhance with DeepFilterNet3
const enhanced = await mlCall({ type: 'runEnhance', signal, sampleRate }, [signal.buffer]);
// 2. Separate vocals with Demucs
const vocals   = await mlCall({ type: 'runSeparation', signal: enhanced, sampleRate, model: 'demucs' }, [enhanced.buffer]);
```

## Execution Providers

| GPU available | Primary provider | Fallback |
|---------------|-----------------|----------|
| WebGPU        | `webgpu`        | `wasm`   |
| None          | `wasm`          | —        |

All WASM binaries are loaded from:
`https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/`

---

## Pipeline Order

```
Input audio
    │
    ▼
[Silero VAD]          silero_vad.onnx    — speech activity mask
    │
    ▼
[DeepFilterNet3]      enc + erb_dec + df_dec — noise/reverb removal
    │
    ▼
[Demucs v4]           demucs_v4.onnx     — vocal stem extraction
    │
    ▼
Isolated voice output
```

All models are optional. Missing models are logged as warnings; the pipeline
continues with classical DSP fallbacks.

# ML Model Files

VoiceIsolate Pro uses ONNX Runtime Web for local inference. No audio leaves the device.

## Silero VAD v5 (Required — 2MB)

Automatically used when present. Enables intelligent noise reduction that only suppresses
noise during non-speech segments, preserving voice quality.

**Download:**
```bash
curl -L -o silero_vad.onnx \
  "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"
```

## Demucs v4 (Optional — ~150MB, requires GPU)

High-quality ML source separation. VoiceIsolate Pro will attempt to load this when
`navigator.gpu` is available (WebGPU-capable browser).

**Download:**
Too large to include in repo. See: https://github.com/facebookresearch/demucs

Place the INT8-quantized ONNX export at `public/app/models/demucs_v4.onnx`.

## BSRNN (Optional — ~80MB)

Band-Split RNN ensemble partner. Complements Demucs for voice/background separation.

Place at `public/app/models/bsrnn.onnx`.

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
|--------------|-----------------|----------|
| WebGPU       | `webgpu`        | `wasm`   |
| None         | `wasm`          | —        |

All WASM binaries are loaded from:
`https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/`

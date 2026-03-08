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

## Execution Providers

| GPU available | Primary provider | Fallback |
|--------------|-----------------|----------|
| WebGPU       | `webgpu`        | `wasm`   |
| None         | `wasm`          | —        |

All WASM binaries are loaded from:
`https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/`

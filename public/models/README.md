# VoiceIsolate Pro — Speaker Diarization ONNX Models

> This is an optional local diarization integration note, not the VoiceIsolate
> production model card. The shipped isolation models are delivered through the
> same-origin manifest described in [`docs/guides/MODEL_DELIVERY.md`](../../docs/guides/MODEL_DELIVERY.md).
> The Hugging Face links below are third-party source references and are never
> used as browser runtime fallback URLs.

Place the following ONNX model files at these **exact** URL paths (served from `public/models/`):

| Path | Model | Purpose |
|------|-------|---------|
| `/models/pyannote-segmentation-3.0.onnx` | pyannote segmentation 3.0 | Frame-level multi-speaker segmentation (7 classes / 10 ms) |
| `/models/wespeaker-resnet34.onnx` | WeSpeaker ResNet34 | 256-dim speaker embeddings |
| `/models/silero-vad.onnx` | Silero VAD v5 | Voice activity detection gate |

All inference runs **100% locally** via `onnxruntime-web`. No audio leaves the device.

---

## Required onnxruntime-web Version

VoiceIsolate Pro pins **`onnxruntime-web@1.25.1`** (see root `package.json`).

- Execution providers: **`webgpu`** preferred, **`wasm`** fallback
- Load ORT from the vendored bundle: `/lib/ort.min.js` (installed by `pnpm setup:ort`)

Create sessions with:

```javascript
const session = await ort.InferenceSession.create('/models/silero-vad.onnx', {
  executionProviders: ['webgpu', 'wasm'],
});
```

---

## Model Sources (Hugging Face)

### 1. pyannote-segmentation-3.0.onnx

- **Repo:** [onnx-community/pyannote-segmentation-3.0](https://huggingface.co/onnx-community/pyannote-segmentation-3.0)
- **ONNX file:** [onnx/model.onnx](https://huggingface.co/onnx-community/pyannote-segmentation-3.0/tree/main/onnx) (rename to `pyannote-segmentation-3.0.onnx`)
- **Upstream:** [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)
- **Input:** `input_values` — `float32 [1, 1, num_samples]` @ 16 kHz
- **Output:** logits `float32 [1, num_frames, 7]` (10 ms per frame)

### 2. wespeaker-resnet34.onnx

- **Repo:** [onnx-community/wespeaker-voxceleb-resnet34-LM](https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM) (community ONNX export)
- **Alternate:** [k2-fsa/sherpa-onnx model collection](https://github.com/k2-fsa/sherpa-onnx) — obtain a compatible ONNX ResNet34 256-dim export; access conditions are defined upstream
- **Place as:** `/models/wespeaker-resnet34.onnx`
- **Input:** `float32 [1, num_frames, 80]` log-mel spectrogram (25 ms window, 10 ms hop @ 16 kHz)
- **Output:** `float32 [1, 256]` speaker embedding

### 3. silero-vad.onnx

- **Repo:** [onnx-community/silero-vad](https://huggingface.co/onnx-community/silero-vad)
- **Alternate (shipped in app):** `/app/models/silero_vad.onnx` — copy or symlink to `/models/silero-vad.onnx`
- **Input:** `input` `float32 [1, 512]` + recurrent `state` `[2, 1, 128]` + `sr` scalar `16000`
- **Output:** speech probability `float32` (frame-level; 10 ms resolution after post-processing)

---

## Local Setup

```bash
# From repo root — create public/models/ and place files:
public/models/pyannote-segmentation-3.0.onnx
public/models/wespeaker-resnet34.onnx
public/models/silero-vad.onnx

# Optional: symlink existing Silero VAD from the app bundle
# Windows (PowerShell, run as admin if needed):
# New-Item -ItemType HardLink -Path public/models/silero-vad.onnx -Target public/app/models/silero_vad.onnx
```

---

## Integration

`SpeakerDiarizer` (`public/app/speaker-diarizer.js`) expects three pre-loaded `ort.InferenceSession` instances.
Run diarization **after** the Deca-Pass STFT → ML → iSTFT pipeline on the **cleaned** buffer for best accuracy.

```javascript
import SpeakerDiarizer from './speaker-diarizer.js';

const diarizer = new SpeakerDiarizer(segSession, embSession, vadSession, 16000);
const timeline = await diarizer.diarize(processedAudioBuffer);
```

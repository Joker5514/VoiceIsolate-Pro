# VoiceIsolate Pro — Speaker Diarization ONNX Models

> This is an optional local diarization integration note, not the VoiceIsolate
> production model card. The shipped isolation models are delivered through the
> same-origin manifest described in [`docs/guides/MODEL_DELIVERY.md`](../../docs/guides/MODEL_DELIVERY.md).
> The Hugging Face links below are third-party source references and are never
> used as browser runtime fallback URLs.
>
> These three files are committed in this directory and served as same-origin
> static assets. Production (from PR #958, commit `b561794`) no longer rewrites
> `/models/*` or `/app/models/*` to Vercel Blob. `server.js` still proxies
> **unshipped** `/models/*.onnx` and `/app/models/*.onnx` files to Blob when
> the local file is missing (a blocked store will 403 those optional files).

Place the following ONNX model files at these **exact** URL paths (served from `public/models/`):

| Path | Model | Purpose |
|------|-------|---------|
| `/models/pyannote-segmentation-3.0.onnx` | pyannote segmentation 3.0 | Frame-level multi-speaker segmentation (7 powerset classes, one frame per 270 samples ≈ 16.9 ms) |
| `/models/wespeaker-resnet34.onnx` | WeSpeaker ResNet34 | 256-dim speaker embeddings |
| `/models/silero-vad.onnx` | Silero VAD v5 | Voice activity detection gate |

All inference runs **100% locally** via `onnxruntime-web`. No audio leaves the device.

---

## Required onnxruntime-web Version

VoiceIsolate Pro pins **`onnxruntime-web@1.25.1`** (see root `package.json`).

- Execution providers: **`webgpu`** preferred, **`wasm`** fallback
- Load ORT from the vendored bundle: `/lib/ort.min.js` (installed by `pnpm setup:ort`)

Create sessions with one provider at a time. Do not pass `webgpu` and `wasm` together: a combined list can succeed on WASM while the caller records WebGPU.

```javascript
let session;
try {
  session = await ort.InferenceSession.create('/models/silero-vad.onnx', {
    executionProviders: ['webgpu'],
  });
} catch {
  session = await ort.InferenceSession.create('/models/silero-vad.onnx', {
    executionProviders: ['wasm'],
  });
}
```

---

## Model Sources (Hugging Face)

### 1. pyannote-segmentation-3.0.onnx

- **Repo:** [onnx-community/pyannote-segmentation-3.0](https://huggingface.co/onnx-community/pyannote-segmentation-3.0)
- **ONNX file:** [onnx/model.onnx](https://huggingface.co/onnx-community/pyannote-segmentation-3.0/tree/main/onnx) (rename to `pyannote-segmentation-3.0.onnx`)
- **Upstream:** [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)
- **Input:** `input_values` — `float32 [1, 1, num_samples]` @ 16 kHz
- **Output:** logits `float32 [1, num_frames, 7]`, one frame per 270 samples (≈ 16.9 ms; 589 frames per 10 s). The diarizer runs it on windows of up to 10 s.

### 2. wespeaker-resnet34.onnx

- **Repo:** [onnx-community/wespeaker-voxceleb-resnet34-LM](https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM) (community ONNX export)
- **Alternate:** [k2-fsa/sherpa-onnx model collection](https://github.com/k2-fsa/sherpa-onnx) — obtain a compatible ONNX ResNet34 256-dim export; access conditions are defined upstream
- **Place as:** `/models/wespeaker-resnet34.onnx`
- **Input:** `input_features` — `float32 [1, num_frames, 80]` Kaldi fbank as in wespeaker `compute_fbank` / `torchaudio.compliance.kaldi.fbank` (input ×32768, DC removal, 0.97 pre-emphasis, Hamming window, 25 ms window, 10 ms hop @ 16 kHz, 80 mel bins from 20 Hz to Nyquist), then per-segment mean normalisation (CMN); pad to at least 9 frames. Output embeddings are L2-normalised before cosine clustering
- **Output:** `last_hidden_state` — `float32 [1, 256]` speaker embedding

### 3. silero-vad.onnx

- **Repo:** [onnx-community/silero-vad](https://huggingface.co/onnx-community/silero-vad)
- **Alternate (shipped in app):** `/app/models/silero_vad.onnx` — copy or symlink to `/models/silero-vad.onnx`
- **Input:** `input` `float32 [1, 576]` = the previous chunk's last 64 samples + 512 new samples @ 16 kHz in [-1, 1]; `state` `float32 [2, 1, 128]` carried from the previous chunk's `stateN`; `sr` `int64` scalar 16000. Without the 64-sample context the model outputs ≈ 0 on clear speech.
- **Output:** `output` speech probability `float32 [1, 1]` per 512-sample chunk (32 ms) and `stateN`. Regions follow silero-vad `get_speech_timestamps` (threshold 0.5, neg 0.35, min speech 250 ms, min silence 100 ms, pad 30 ms)

---


## Licenses (redistribution)

| File | Source | License |
|------|--------|---------|
| `pyannote-segmentation-3.0.onnx` | [onnx-community/pyannote-segmentation-3.0](https://huggingface.co/onnx-community/pyannote-segmentation-3.0) (upstream [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)) | MIT |
| `wespeaker-resnet34.onnx` | [onnx-community/wespeaker-voxceleb-resnet34-LM](https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM) | CC-BY-4.0 (attribution via this table) |
| `silero-vad.onnx` | Copy of the shipped `/app/models/silero_vad.onnx` (upstream [onnx-community/silero-vad](https://huggingface.co/onnx-community/silero-vad) / [snakers4/silero-vad](https://github.com/snakers4/silero-vad)) | MIT |

Pinned SHA-256 (production gate in `tests/model-integrity.test.js`):

- `pyannote-segmentation-3.0.onnx` (5,986,908 bytes) `057ee564753071c0b09b5b611648b50ac188d50846bff5f01e9f7bbf1591ea25`
- `wespeaker-resnet34.onnx` (26,535,549 bytes) `3955447b0499dc9e0a4541a895df08b03c69098eba4e56c02b5603e9f7f4fcbb`
- `silero-vad.onnx` (2,327,524 bytes) `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`

## Local Setup

The three files above are already committed in this directory. A clean checkout
is enough for production and for local `server.js` static serving. To restore
them if they were deleted, run `pnpm models:diarization` from the repo root
(that copies `silero-vad.onnx` from `public/app/models/silero_vad.onnx` and
downloads the other two from the Hugging Face sources listed above).

---

## Integration

`SpeakerDiarizer` (`public/app/speaker-diarizer.js`) expects three pre-loaded `ort.InferenceSession` instances.
Run diarization **after** the Deca-Pass STFT → ML → iSTFT pipeline on the **cleaned** buffer for best accuracy.

```javascript
import SpeakerDiarizer from './speaker-diarizer.js';

const diarizer = new SpeakerDiarizer(segSession, embSession, vadSession, 16000);
const timeline = await diarizer.diarize(processedAudioBuffer);
```

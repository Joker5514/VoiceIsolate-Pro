# VoiceIsolate Pro — ML Models Reference

> **Threads from Space v11** | Pipeline: 35-stage Deca-Pass DSP  
> All models run 100% locally via `onnxruntime-web` (WebGPU → WASM fallback).  
> No cloud APIs. No telemetry. Models are **never** bundled in the repo — you must place them here.

---

## Quick Start

```bash
# Place .onnx files in this directory:
# public/app/models/<filename>.onnx
# Then reload the browser. The UI will auto-detect presence via HEAD requests.
```

Total download: ~189 MB (all models, INT8 quantised where available)

---

## Model Inventory

| Stage | Model key | Filename | Size | Quantization | Source |
|-------|-----------|----------|------|-------------|--------|
| S04   | `noise_classifier` | `noise_classifier.onnx` | ~2.5 MB | fp32 | Custom / ESC-50 |
| S05   | `silero_vad` | `silero_vad.onnx` | ~1.7 MB | fp32 | [snakers4/silero-vad](https://github.com/snakers4/silero-vad/tree/master/files) |
| S08   | `deepfilter` | `deepfilter-int8.onnx` | ~9 MB | INT8 | [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet/releases) |
| S10   | `dns2_conformer_small` | `dns2_conformer_small.onnx` | ~14 MB | fp32 | [microsoft/DNS-Challenge](https://github.com/microsoft/DNS-Challenge) |
| S11   | `bsrnn` | `bsrnn-int8.onnx` | ~37 MB | INT8 | [bytedance/music_source_separation](https://github.com/bytedance/music_source_separation) |
| S13   | `demucs` | `demucs-v4-int8.onnx` | ~82 MB | INT8 | [facebookresearch/demucs](https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th) |
| S17   | `ecapa-tdnn` | `ecapa-tdnn-int8.onnx` | ~20 MB | INT8 | [speechbrain/spkrec-ecapa-voxceleb](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb) |
| S22   | `convtasnet` | `convtasnet-int8.onnx` | ~18 MB | INT8 | [asteroid-team/asteroid](https://github.com/asteroid-team/asteroid) |

---

## Tensor Specifications

### S05 — Silero VAD (`silero_vad.onnx`)

```
Inputs:
  input  float32  [1, 512]        — 512 PCM samples @ 16 kHz (32ms window)
  sr     int64    [1]             — sample rate (16000 or 8000)
  state  float32  [2, 1, 64]     — LSTM hidden state (persist between windows)

Outputs:
  output  float32  [1, 1]        — speech probability scalar 0..1
  stateN  float32  [2, 1, 64]   — updated LSTM state (feed back next call)

Notes:
  - Window: 512 samples = 32ms @ 16kHz. Use 256 samples for 8 kHz.
  - Threshold: >0.5 = speech. >0.7 = confident speech.
  - Resample to 16kHz before feeding. ml-worker.js handles resampling internally.
  - State MUST be threaded between consecutive windows or VAD accuracy degrades.
  - Model download: direct .onnx from GitHub releases — no conversion needed.
```

### S08 — DeepFilterNet2 (`deepfilter-int8.onnx`)

```
Inputs:
  input   float32  [1, 1, 2049]  — per-bin STFT magnitude @ 48kHz, FFT=4096
                                    bins = fftSize/2 + 1 = 2049

Outputs:
  output  float32  [1, 1, 2049]  — per-bin real-valued gain mask [0..1]

Notes:
  - Sample rate: 48 kHz. Resample if source is 44.1 kHz.
  - FFT size: 4096 → 2049 positive-frequency bins.
  - Output mask applied in-place: magnitude[k] *= mask[k]
  - INT8 quantised — use WebGPU EP for best throughput.
  - Conversion: pip install deepfilternet; python -c "from df import init_df; ..."
    See: https://github.com/Rikorose/DeepFilterNet/blob/main/onnx_export.py
```

### S10 — DNS v2 Conformer Small (`dns2_conformer_small.onnx`)

```
Inputs:
  input   float32  [1, 1, 513]   — STFT magnitude @ 16kHz, FFT=1024
                                    bins = fftSize/2 + 1 = 513

Outputs:
  output  float32  [1, 1, 513]   — per-bin gain mask [0..1]

Notes:
  - Sample rate: 16 kHz. Normalize magnitude to ~[0, 1] before inference.
  - Conversion from DNS-Challenge PyTorch checkpoint:
    python scripts/export_onnx.py --model conformer_small --out dns2_conformer_small.onnx
```

### S11 — BSRNN (`bsrnn-int8.onnx`)

```
Inputs:
  input   float32  [1, 2, 44100] — 1 second stereo audio @ 44.1 kHz
                                    shape: [batch=1, channels=2, samples=44100]

Outputs:
  output  float32  [1, 2, 44100] — separated vocals (stereo)

Notes:
  - For mono input: duplicate channel → stereo: input[:,0,:] = input[:,1,:] = mono
  - Average output channels back to mono for the pipeline.
  - Chunk 44100 samples (1s) with 50% overlap-add for longer files.
  - Ensemble with Demucs: blended_mask = demucs*0.7 + bsrnn*0.3
  - Conversion from bytedance repo:
    python export.py --model bsrnn_vocals --quantize int8 --out bsrnn-int8.onnx
    Dynamic axes: --dynamic-axes input:2 output:2
```

### S13 — Demucs v4 (`demucs-v4-int8.onnx`)

```
Inputs:
  input   float32  [1, 2, 44100] — 1 second stereo audio @ 44.1 kHz
                                    shape: [batch=1, channels=2, samples=44100]

Outputs:
  output  float32  [1, 2, 44100] — separated vocals (stereo), 4-source model
                                    output[:, :, :] = vocals track only
                                    (htdemucs_ft_vocals — single-source fine-tuned)

Notes:
  - Source: htdemucs_ft model fine-tuned on vocals.
  - PyTorch weights: 955717e8-8726e21a.th (~320MB fp32)
  - Convert to ONNX INT8:
    pip install demucs torch onnxruntime
    python -c "
    import torch, demucs.pretrained as p
    model = p.get_model('htdemucs_ft')
    # Export only the vocals stem (index 3)
    dummy = torch.zeros(1, 2, 44100)
    torch.onnx.export(model, dummy, 'demucs-v4.onnx',
      input_names=['input'], output_names=['output'],
      dynamic_axes={'input': {2: 'samples'}, 'output': {2: 'samples'}},
      opset_version=17)
    "
    # Quantize:
    python -m onnxruntime.quantization.quantize \
      --input demucs-v4.onnx --output demucs-v4-int8.onnx \
      --quant_type QInt8 --per_channel
  - CRITICAL: Run on WebGPU EP. CPU WASM is ~8× slower than real-time.
  - CRITICAL: context window = 44100 samples (1s). Use overlap-add for
    longer files with a 512-sample fade at chunk boundaries.
```

### S17 — ECAPA-TDNN (`ecapa-tdnn-int8.onnx`)

```
Inputs:
  input   float32  [1, 1, N]     — variable-length mono audio (any N)
                                    preferred: 16kHz, 2–10 seconds for enrollment

Outputs:
  output  float32  [1, 192]      — 192-dim L2-normalized speaker embedding

Notes:
  - Identification: cosine_similarity(emb_a, emb_b) > 0.75 → same speaker
  - Enrollment: average multiple embeddings for robustness.
  - Conversion from SpeechBrain:
    import speechbrain as sb
    model = sb.pretrained.SpeakerRecognition.from_hparams(
      'speechbrain/spkrec-ecapa-voxceleb')
    # Use speechbrain's ONNX export utility:
    model.encode_batch = torch.jit.trace(model.encode_batch,
      example_inputs=(torch.zeros(1,1,16000),))
    torch.onnx.export(model.encode_batch, torch.zeros(1,1,16000),
      'ecapa-tdnn.onnx', input_names=['input'], output_names=['output'],
      dynamic_axes={'input':{2:'samples'}})
    # Then INT8 quantize as above.
```

### S22 — ConvTasNet (`convtasnet-int8.onnx`)

```
Inputs:
  input   float32  [1, 1, N]     — variable-length mono mix (any N)
                                    shape: [batch=1, channels=1, samples=N]

Outputs:
  output  float32  [1, 4, N]     — up to 4 separated speaker streams
                                    output[:,0,:] = speaker 0 (loudest)
                                    output[:,1,:] = speaker 1
                                    ...

Notes:
  - Dynamic ONNX axes required for variable N.
  - Conversion from asteroid:
    from asteroid.models import ConvTasNet
    model = ConvTasNet.from_pretrained('mpariente/ConvTasNet_WHAM!_sepclean')
    model.eval()
    dummy = torch.zeros(1, 1, 16000)
    torch.onnx.export(model, dummy, 'convtasnet.onnx',
      input_names=['input'], output_names=['output'],
      dynamic_axes={'input':{2:'T'},'output':{2:'T'}},
      opset_version=17)
    # Quantize:
    python -m onnxruntime.quantization.quantize \
      --input convtasnet.onnx --output convtasnet-int8.onnx --quant_type QInt8
  - Max speakers: 4. If model outputs fewer, remaining streams are zero.
  - targetSpeaker index 0 = highest energy speaker.
```

### Noise Classifier (`noise_classifier.onnx`)

```
Inputs:
  input   float32  [1, 64]       — 64-dim log mel-band energies
                                    aggregated over 512ms window

Outputs:
  output  float32  [1, 7]        — class logits (apply softmax)
                                    classes: music, white_noise, crowd,
                                             HVAC, keyboard, traffic, silence

Notes:
  - Custom model — train on ESC-50 + UrbanSound8K.
  - Architecture: 2-layer MLP (64→128→128→7) or lightweight CNN.
  - Feature extraction (512ms @ 16kHz = 8192 samples):
    1. Compute 512-point FFT with 50% overlap, take magnitude
    2. Apply 64-band mel filterbank (16kHz, fmin=50, fmax=8000)
    3. Log-compress: log(mel + 1e-8)
    4. Average across time frames → single 64-dim vector
  - Training:
    from sklearn.preprocessing import StandardScaler
    # Normalize features with StandardScaler fitted on training set.
    # Bake mean/std into model as a normalisation layer for portability.
  - Export:
    torch.onnx.export(model, torch.zeros(1,64), 'noise_classifier.onnx',
      input_names=['input'], output_names=['output'], opset_version=17)
```

---

## Fetch & Cache Strategy

Models are loaded at runtime by `ml-worker.js` via `ort.InferenceSession.create(path, opts)`.  
The `ml-worker-fetch-cache.js` patch (loaded on the main thread) adds:

1. **IndexedDB cache** — models stored as `ArrayBuffer` after first fetch
2. **Chunked download with progress** — `ReadableStream` with UI progress bar
3. **SHA-256 integrity check** — optional, verifies file not corrupted
4. **Fallback URL support** — alternate CDN path if local file 404s

```js
// Usage (auto-wired in vip-boot.js):
await window._vipPreloadModels(['silero_vad', 'deepfilter', 'demucs']);
// Models served to ml-worker via Object URL after download+cache.
```

---

## Prioritized Loading Order

For fastest perceived startup, load models in this order:

| Priority | Model | Reason |
|----------|-------|---------|
| 1 | `silero_vad` (1.7 MB) | Needed immediately for live mic gating |
| 2 | `deepfilter` (9 MB) | Highest perceptual improvement in Creator mode |
| 3 | `dns2_conformer_small` (14 MB) | DNS noise gate |
| 4 | `ecapa-tdnn` (20 MB) | Speaker ID (non-blocking) |
| 5 | `convtasnet` (18 MB) | Multi-speaker (non-blocking) |
| 6 | `bsrnn` (37 MB) | Heavy — load last |
| 7 | `demucs` (82 MB) | Heaviest — background load |

---

## DSP Fallback Behavior (No Models)

Every ML stage degrades gracefully when its model file is absent:  

| Stage | ML behavior | Fallback behavior |
|-------|-------------|-------------------|
| S04 Noise Classify | Classifies noise type | Returns `unknown` — adaptive EQ skipped |
| S05 VAD | Speech probability per frame | Assumes all frames = speech (no gating) |
| S08 DeepFilter | Per-bin spectral suppression | Passthrough (gain mask = all-1s) |
| S10 DNS v2 | Conformer noise gate | Passthrough |
| S11 BSRNN | Band-split RNN vocal extraction | Demucs-only or straight passthrough |
| S13 Demucs | htdemucs vocal isolation | Passthrough — spectral-only stages still run |
| S17 ECAPA | Speaker embedding | No speaker ID — multi-speaker mode disabled |
| S22 ConvTasNet | Multi-speaker separation | Single-stream passthrough |

> DSP-only stages (S01–S03, S06–S07, S09, S12, S14–S16, S19–S21, S23–S35) are unaffected by model absence and run at full quality regardless.

---

*Auto-detected by `ml-worker-models-patch.js` on every page load via HEAD requests to `models/*.onnx`.*

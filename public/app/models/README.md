# VoiceIsolate Pro — ML Model Files

**Location:** `public/app/models/`  
**Required by:** `ml-worker.js` (Threads from Space v11)  
**Execution:** `onnxruntime-web` — WebGPU → WASM fallback, 100% local, no cloud

> **Models directory is currently empty.**  
> The DSP-only stages still produce output. Stages S04, S05, S08, S10, S11, S13, S17, S22 will run in passthrough mode until models are placed here.

---

## Quick Reference

| File | Stage | Size | Quantization | Priority |
|------|-------|------|--------------|----------|
| `silero_vad.onnx` | S05 VAD | 1.7 MB | fp32 | **High** — gates all downstream processing |
| `deepfilter-int8.onnx` | S08 Noise Suppression | 9 MB | INT8 | High |
| `dns2_conformer_small.onnx` | S10 DNS v2 | 14 MB | fp32 | Medium |
| `bsrnn-int8.onnx` | S11 BSRNN | 37 MB | INT8 | High — ensemble partner for Demucs |
| `demucs-v4-int8.onnx` | S13 Voice Isolation | 82 MB | INT8 | **Critical** — main vocal separator |
| `ecapa-tdnn-int8.onnx` | S17 Speaker ID | 20 MB | INT8 | Low (forensic mode only) |
| `noise_classifier.onnx` | S04 Noise Class | 2.5 MB | fp32 | Medium |
| `convtasnet-int8.onnx` | S22 Multi-Speaker | 18 MB | INT8 | Low (advanced mode) |

**Total: ~184 MB** (all models). Minimum useful set: `silero_vad.onnx` + `demucs-v4-int8.onnx` (~84 MB).

---

## Model Details

### `silero_vad.onnx` — Silero VAD v4
**Stage:** S05 · **Size:** ~1.7 MB · **Source:** https://github.com/snakers4/silero-vad

**Tensor interface:**

| Name | Shape | dtype | Description |
|------|-------|-------|-------------|
| `input` | `[1, 512]` | float32 | 512 audio samples @ 16 kHz (32ms window) |
| `sr` | `[1]` | int64 | Sample rate (16000 or 8000) |
| `state` | `[2, 1, 64]` | float32 | LSTM hidden state — thread between windows |
| `output` | `[1, 1]` | float32 | Speech probability [0..1] |
| `stateN` | `[2, 1, 64]` | float32 | Updated LSTM state |

**Get it:**
```bash
# Direct download (pre-exported ONNX):
curl -L -o public/app/models/silero_vad.onnx \
  "https://github.com/snakers4/silero-vad/raw/master/files/silero_vad.onnx"
```

---

### `deepfilter-int8.onnx` — DeepFilterNet2
**Stage:** S08 · **Size:** ~9 MB · **Source:** https://github.com/Rikorose/DeepFilterNet

**Tensor interface:**

| Name | Shape | dtype | Description |
|------|-------|-------|-------------|
| `input` | `[1, 1, 2049]` | float32 | STFT magnitude, FFT=4096, 48 kHz |
| `output` | `[1, 1, 2049]` | float32 | Per-bin gain mask [0..1] |

**Get it:**
```bash
pip install deepfilternet
python - <<'PY'
import torch
from df import init_df
model, df_state, _ = init_df()
dummy = torch.zeros(1, 1, 2049)
torch.onnx.export(model.enc, dummy, "deepfilter-int8.onnx",
  input_names=["input"], output_names=["output"],
  dynamic_axes={"input":{0:"batch"},"output":{0:"batch"}},
  opset_version=17)
PY
cp deepfilter-int8.onnx public/app/models/
```

---

### `demucs-v4-int8.onnx` — htdemucs_ft (vocals fine-tuned)
**Stage:** S13 · **Size:** ~82 MB · **Source:** https://github.com/facebookresearch/demucs

**Tensor interface:**

| Name | Shape | dtype | Description |
|------|-------|-------|-------------|
| `input` | `[1, 2, 44100]` | float32 | Stereo audio, 1 second @ 44.1 kHz |
| `output` | `[1, 2, 44100]` | float32 | Separated vocals (stereo) |

> **Mono input:** Duplicate channel — `stereo[0] = stereo[1] = monoSignal`  
> **Long audio:** Overlap-add with 25% overlap across 44100-sample chunks  

**Export:**
```bash
pip install demucs onnxruntime
python - <<'PY'
import torch, demucs.pretrained
model = demucs.pretrained.get_model("htdemucs_ft")
model.eval()
dummy = torch.zeros(1, 2, 44100)
torch.onnx.export(
  model, dummy,
  "demucs-v4-int8.onnx",
  input_names=["input"], output_names=["output"],
  dynamic_axes={"input":{2:"samples"},"output":{2:"samples"}},
  opset_version=17
)
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic("demucs-v4-int8.onnx", "demucs-v4-int8.onnx", weight_type=QuantType.QInt8)
PY
cp demucs-v4-int8.onnx public/app/models/
```

> ⚠ **Size note:** Full htdemucs is ~680 MB fp32. INT8 quantization reduces to ~82 MB.  
> WebGPU strongly recommended — WASM inference is ~8× real-time on a modern machine.

---

### `bsrnn-int8.onnx` — Band-Split RNN (vocals)
**Stage:** S11 · **Size:** ~37 MB · **Source:** https://github.com/bytedance/music_source_separation

**Tensor interface:** Identical to Demucs — `[1, 2, 44100]` stereo in/out.

```bash
python - <<'PY'
import torch
from models.bsrnn import BSRNN
model = BSRNN.from_pretrained("vocals")
model.eval()
dummy = torch.zeros(1, 2, 44100)
torch.onnx.export(model, dummy, "bsrnn-int8.onnx",
  input_names=["input"], output_names=["output"], opset_version=17)
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic("bsrnn-int8.onnx", "bsrnn-int8.onnx", weight_type=QuantType.QInt8)
PY
cp bsrnn-int8.onnx public/app/models/
```

---

### `ecapa-tdnn-int8.onnx` — ECAPA-TDNN Speaker Embeddings
**Stage:** S17 · **Size:** ~20 MB · **Source:** https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb

**Tensor interface:**

| Name | Shape | dtype | Description |
|------|-------|-------|-------------|
| `input` | `[1, 1, T]` | float32 | Variable-length mono audio (16 kHz) |
| `output` | `[1, 192]` | float32 | L2-normalized 192-dim speaker embedding |

```bash
pip install speechbrain
python - <<'PY'
import torch, speechbrain.pretrained as sp
classifier = sp.EncoderClassifier.from_hparams("speechbrain/spkrec-ecapa-voxceleb")
dummy = torch.zeros(1, 1, 16000)
torch.onnx.export(
  classifier.mods.embedding_model, dummy,
  "ecapa-tdnn-int8.onnx",
  input_names=["input"], output_names=["output"],
  dynamic_axes={"input":{2:"samples"}}, opset_version=17
)
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic("ecapa-tdnn-int8.onnx", "ecapa-tdnn-int8.onnx", weight_type=QuantType.QInt8)
PY
cp ecapa-tdnn-int8.onnx public/app/models/
```

---

### `dns2_conformer_small.onnx` — Microsoft DNS Challenge v2
**Stage:** S10 · **Size:** ~14 MB · **Source:** https://github.com/microsoft/DNS-Challenge

**Tensor interface:**

| Name | Shape | dtype | Description |
|------|-------|-------|-------------|
| `input` | `[1, 1, 513]` | float32 | STFT magnitude, FFT=1024, 16 kHz |
| `output` | `[1, 1, 513]` | float32 | Per-bin gain mask |

---

### `noise_classifier.onnx` — Custom Noise Classifier
**Stage:** S04 · **Size:** ~2.5 MB · **Source:** Train yourself (ESC-50 + UrbanSound8K)

**Tensor interface:**

| Name | Shape | dtype | Description |
|------|-------|-------|-------------|
| `input` | `[1, 64]` | float32 | 64-dim log mel energies (512ms window) |
| `output` | `[1, 7]` | float32 | Logits over 7 noise classes |

**Classes (index order):** `music`, `white_noise`, `crowd`, `HVAC`, `keyboard`, `traffic`, `silence`

```bash
python - <<'PY'
import torch, torch.nn as nn
model = nn.Sequential(nn.Linear(64,128), nn.ReLU(), nn.Linear(128,7))
dummy = torch.zeros(1, 64)
torch.onnx.export(model, dummy, "noise_classifier.onnx",
  input_names=["input"], output_names=["output"], opset_version=17)
PY
# Fine-tune on ESC-50 / UrbanSound8K before deploying
cp noise_classifier.onnx public/app/models/
```

---

### `convtasnet-int8.onnx` — ConvTasNet Multi-Speaker
**Stage:** S22 · **Size:** ~18 MB · **Source:** https://github.com/asteroid-team/asteroid

**Tensor interface:**

| Name | Shape | dtype | Description |
|------|-------|-------|-------------|
| `input` | `[1, 1, T]` | float32 | Variable-length mono mix |
| `output` | `[1, 4, T]` | float32 | 4 separated speaker streams |

```bash
pip install asteroid
python - <<'PY'
import torch
from asteroid.models import ConvTasNet
model = ConvTasNet.from_pretrained("mpariente/ConvTasNet_WHAM!_sepclean")
model.eval()
dummy = torch.zeros(1, 1, 44100)
torch.onnx.export(model, dummy, "convtasnet-int8.onnx",
  input_names=["input"], output_names=["output"],
  dynamic_axes={"input":{2:"samples"},"output":{2:"samples"}}, opset_version=17)
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic("convtasnet-int8.onnx", "convtasnet-int8.onnx", weight_type=QuantType.QInt8)
PY
cp convtasnet-int8.onnx public/app/models/
```

---

## Verification

After placing model files, run this in the browser DevTools console:

```js
(async () => {
  const models = window._vipModelManifest;
  for (const [key, meta] of Object.entries(models)) {
    try {
      const sess = await ort.InferenceSession.create(meta.path, {executionProviders:['wasm']});
      console.log(`\u2713 ${key}: inputs=${JSON.stringify(sess.inputNames)}`);
      await sess.dispose?.();
    } catch(e) {
      console.warn(`\u2717 ${key}: ${e.message}`);
    }
  }
})();
```

---

## Deployment Notes

- All `.onnx` files must be served from the same origin (CORS).
- **git-lfs required** for files > 50 MB:
  ```bash
  git lfs track "*.onnx"
  git add .gitattributes
  git add public/app/models/*.onnx
  git commit -m "feat: add ONNX model files"
  ```
- Vercel: LFS files served correctly with GitHub integration.
- Add a service worker cache for instant second-load (models don't change often).

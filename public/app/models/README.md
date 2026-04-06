# VoiceIsolate Pro — Model Directory

Place ONNX model files here. The app runs in **DSP-only mode** until models
are present — all 35 pipeline stages produce output; ML-enhanced stages show
a `⚠ DSP` badge in the UI. The banner in the top of the app lists every
missing file with its source link.

---

## Required Models

| Stage | File | Size (INT8) | Input Shape | Output Shape | Source |
|---|---|---|---|---|---|
| S04 | `noise_classifier.onnx` | ~2.5 MB | `[1, 64]` mel energies | `[1, 7]` class logits | Custom — ESC-50 / UrbanSound8K |
| S05 | `silero_vad.onnx` | ~1.7 MB | `[1, 512]` PCM @ 16 kHz + LSTM state `[2,1,128]` | `[1,1]` speech prob + new state | [snakers4/silero-vad](https://github.com/snakers4/silero-vad/tree/master/files) |
| S08 | `deepfilter-int8.onnx` | ~9 MB | `[1, 1, 2049]` magnitude @ 48 kHz | `[1, 1, 2049]` gain mask | [DeepFilterNet releases](https://github.com/Rikorose/DeepFilterNet/releases) |
| S10 | `dns2_conformer_small.onnx` | ~14 MB | `[1, 1, 513]` magnitude @ 16 kHz | `[1, 1, 513]` gain mask | [MS DNS-Challenge](https://github.com/microsoft/DNS-Challenge) |
| S11 | `bsrnn-int8.onnx` | ~37 MB | `[1, 2, 44100]` stereo float32 | `[1, 2, 44100]` vocals | [bytedance/music_source_separation](https://github.com/bytedance/music_source_separation) |
| S13 | `demucs-v4-int8.onnx` | ~82 MB | `[1, 2, 44100]` stereo float32 | `[1, 2, 44100]` vocals stem | [facebookresearch/demucs](https://github.com/facebookresearch/demucs) |
| S17 | `ecapa-tdnn-int8.onnx` | ~20 MB | `[1, 1, N]` mono variable-length | `[1, 192]` speaker embedding | [speechbrain/spkrec-ecapa-voxceleb](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb) |
| S22 | `convtasnet-int8.onnx` | ~18 MB | `[1, 1, N]` mono mix | `[1, 4, N]` 4-speaker separation | [asteroid-team/asteroid](https://github.com/asteroid-team/asteroid) |

**Total on-disk: ~184 MB**  
**Total memory (all loaded): ~240 MB peak (WebGPU VRAM)**

---

## Tensor Shape Notes

- **Demucs / BSRNN**: Input is **stereo** `[1, 2, N]`. For mono, duplicate: `stack([mono, mono], axis=0)`. The worker does this automatically.
- **Silero VAD**: Stateful LSTM. Thread `h` and `c` state outputs back as inputs on every window. The worker's `handleVAD()` manages this.
- **DeepFilterNet**: Expects 48 kHz. FFT size = 4096 → 2049 bins. Ensure your STFT config matches.
- **DNS v2 Conformer**: Expects 16 kHz. FFT size = 1024 → 513 bins. Normalise magnitude (`/ max`) before inference.
- **All INT8 models**: Export FP32 first, then quantize with `quantize_dynamic`. Accuracy loss < 1 dB SDR.

---

## Quick-Start: Download Pre-Exported ONNX Files

### Silero VAD (pre-exported, no conversion needed)
```bash
wget https://github.com/snakers4/silero-vad/raw/master/files/silero_vad.onnx \
     -O public/app/models/silero_vad.onnx
```

### DeepFilterNet2 (pip install + export)
```bash
pip install deepfilternet
python3 - <<'EOF'
from df.enhance import init_df
import torch
model, df_state, _ = init_df()
model.eval()
dummy = torch.randn(1, 1, 2049)
torch.onnx.export(
    model, dummy, 'public/app/models/deepfilter-int8.onnx',
    input_names=['input'], output_names=['output'],
    dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
    opset_version=17
)
EOF
# INT8 quantize
python3 -c "
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic('public/app/models/deepfilter-int8.onnx',
                 'public/app/models/deepfilter-int8.onnx',
                 weight_type=QuantType.QInt8)"
```

### Demucs v4 htdemucs_ft
```bash
pip install demucs
python3 - <<'EOF'
import torch
from demucs.pretrained import get_model
model = get_model('htdemucs_ft'); model.eval()
dummy = torch.randn(1, 2, 44100)
torch.onnx.export(
    model, dummy, 'public/app/models/demucs-v4-int8.onnx',
    input_names=['input'], output_names=['output'],
    dynamic_axes={'input': {2: 'samples'}, 'output': {2: 'samples'}},
    opset_version=17
)
EOF
python3 -c "
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic('public/app/models/demucs-v4-int8.onnx',
                 'public/app/models/demucs-v4-int8.onnx',
                 weight_type=QuantType.QInt8)"
```

### BSRNN (ByteDance)
```bash
git clone https://github.com/bytedance/music_source_separation
cd music_source_separation && pip install -r requirements.txt
python3 - <<'EOF'
import torch
from models.bsrnn import BSRNN
model = BSRNN(); model.eval()
dummy = torch.randn(1, 2, 44100)
torch.onnx.export(
    model, dummy, '../public/app/models/bsrnn-int8.onnx',
    input_names=['input'], output_names=['output'],
    dynamic_axes={'input': {2: 'samples'}, 'output': {2: 'samples'}},
    opset_version=17
)
EOF
```

### ECAPA-TDNN (SpeechBrain)
```bash
pip install speechbrain
python3 - <<'EOF'
import torch, speechbrain as sb
from speechbrain.pretrained import EncoderClassifier
clf = EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb')
clf.eval()
dummy = torch.randn(1, 1, 16000)
torch.onnx.export(
    clf.mods.embedding_model, dummy,
    'public/app/models/ecapa-tdnn-int8.onnx',
    input_names=['input'], output_names=['output'],
    dynamic_axes={'input': {2: 'samples'}},
    opset_version=17
)
EOF
```

### DNS v2 Conformer Small
```bash
# Clone Microsoft DNS-Challenge and follow export instructions in README.
# Target path: public/app/models/dns2_conformer_small.onnx
```

### ConvTasNet (asteroid-team)
```bash
pip install asteroid
python3 - <<'EOF'
import torch
from asteroid.models import ConvTasNet
model = ConvTasNet.from_pretrained('mpariente/ConvTasNet_WHAM!_sepclean'); model.eval()
dummy = torch.randn(1, 1, 44100)
torch.onnx.export(
    model, dummy, 'public/app/models/convtasnet-int8.onnx',
    input_names=['input'], output_names=['output'],
    dynamic_axes={'input': {2: 'samples'}, 'output': {2: 'samples'}},
    opset_version=17
)
EOF
```

---

## Verify All Files Present

```bash
ls -lh public/app/models/*.onnx | awk '{print $5, $9}'
```

Expected output (approximate):
```
1.7M  silero_vad.onnx
2.5M  noise_classifier.onnx
9.0M  deepfilter-int8.onnx
14M   dns2_conformer_small.onnx
18M   convtasnet-int8.onnx
20M   ecapa-tdnn-int8.onnx
37M   bsrnn-int8.onnx
82M   demucs-v4-int8.onnx
```

After placing files, reload the app. The `⚠ DSP` badges on ML-enhanced stages
should turn to `● ML`, and the missing-model banner should disappear.

---

## Cache Management (DevTools)

The app caches downloaded models in IndexedDB (`vip-model-cache`).

```javascript
// Check cache status
await window._vipCacheStatus();

// Force re-download all models
await window._vipClearModelCache();
location.reload();

// Preload specific models
await window._vipPreloadModels(['silero_vad', 'deepfilter']);
```

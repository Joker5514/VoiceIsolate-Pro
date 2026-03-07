# Quick Download Guide

## Automated Download (Recommended)

```bash
python scripts/download-models.py
```

## Manual Download Commands

If the automated script fails, use these direct commands:

### 1. Silero VAD (2.24 MB)

```bash
# Option 1: wget
wget https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx \
     -O public/models/silero-vad.onnx

# Option 2: curl
curl -L https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx \
     -o public/models/silero-vad.onnx

# Option 3: GitHub direct (alternative mirror)
wget https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx \
     -O public/models/silero-vad.onnx
```

**Expected SHA256:** `a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808`

### 2. ECAPA-TDNN (6.5 MB)

```bash
# Option 1: wget
wget https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb/resolve/main/embedding_model.onnx \
     -O public/models/ecapa-tdnn.onnx

# Option 2: curl
curl -L https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb/resolve/main/embedding_model.onnx \
     -o public/models/ecapa-tdnn.onnx
```

### 3. Demucs v4 (150-300 MB) - Requires Export

**Option A: Use Community Export (Recommended)**

```bash
git clone https://github.com/GitStroberi/demucs-onnx.git
cd demucs-onnx
pip install -r requirements.txt
python export_demucs.py --model htdemucs --output ../public/models/demucs-v4.onnx
```

**Option B: Export from Official Demucs**

```bash
pip install demucs torch onnx
python -c "
import torch
from demucs.pretrained import get_model
model = get_model('htdemucs')
torch.onnx.export(model, dummy_input, 'public/models/demucs-v4.onnx')
"
```

**Option C: Quantize for Browser Performance**

```bash
pip install onnxruntime-tools
python -m onnxruntime.quantization.quantize_dynamic \
    public/models/demucs-v4.onnx \
    public/models/demucs-v4-quant.onnx
```

## Verification

```bash
# Check files exist and sizes are correct
ls -lh public/models/*.onnx

# Expected output:
# -rw-r--r-- 1 user user 2.2M  silero-vad.onnx
# -rw-r--r-- 1 user user 6.5M  ecapa-tdnn.onnx
# -rw-r--r-- 1 user user 150M  demucs-v4.onnx (or demucs-v4-quant.onnx)
```

## Troubleshooting

### Hugging Face Rate Limits

If you hit rate limits, use the GitHub mirrors or wait 10 minutes.

### Large File Download Failures

```bash
# Resume interrupted downloads with wget
wget -c <url> -O <output>

# Or use aria2c for parallel downloads
sudo apt install aria2
aria2c -x 16 -s 16 <url> -o <output>
```

### Corporate Firewalls

If direct downloads are blocked:

1. Download on personal machine
2. Transfer via USB/SCP
3. Or use company-approved CDN/mirror

## CDN Hosting (Enterprise)

For production deployments, host models on your own CDN:

```javascript
// Update model paths in ml-worker.ts
const MODELS = {
  DEMUCS: 'https://your-cdn.com/models/demucs-v4.onnx',
  ECAPA:  'https://your-cdn.com/models/ecapa-tdnn.onnx',
  VAD:    'https://your-cdn.com/models/silero-vad.onnx',
};
```

Add CORS headers to your CDN:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET
Cross-Origin-Resource-Policy: cross-origin
```

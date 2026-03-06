# VoiceIsolate Pro - Utility Scripts

## download-models.py

Automated downloader for ONNX model files required by the ML pipeline.

### Usage

```bash
# From project root
python scripts/download-models.py
```

### What it downloads

1. **Silero VAD v5** (2.24 MB)
   - Voice Activity Detection model
   - Source: Hugging Face `onnx-community/silero-vad`
   - Checksum verified

2. **ECAPA-TDNN** (6.5 MB)
   - Speaker embedding/verification model
   - Source: Hugging Face `speechbrain/spkrec-ecapa-voxceleb`

3. **Demucs v4** (manual export required)
   - Source separation model
   - See script output for export instructions

### Requirements

Python 3.7+ with standard library only (no external dependencies).

### Output

Files are downloaded to:
```
public/models/
├── silero-vad.onnx        (2.24 MB)
├── ecapa-tdnn.onnx        (6.5 MB)
└── demucs-v4.onnx         (manual - ~150-300 MB)
```

### Troubleshooting

**"Connection timeout" errors:**
```bash
# Use alternative mirror or download manually
wget https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx \
     -O public/models/silero-vad.onnx
```

**Checksum verification failures:**
- Delete partial download and retry
- Check internet connection stability
- Report issue if persistent

**Demucs export issues:**
- Requires ~4GB RAM and PyTorch installed
- Export can take 10-30 minutes
- Use quantized version for faster browser inference

# ONNX Model Setup for VoiceIsolate Pro

This directory must contain three ONNX model files for the ML pipeline to function:

## Required Models

### 1. demucs-v4.onnx (Source Separation)
**Purpose:** Isolate vocals from background music/noise  
**Source:** Hugging Face - [facebookresearch/demucs](https://huggingface.co/facebook/htdemucs)  
**Export Instructions:**
```bash
# Install Demucs and export to ONNX
pip install demucs torch onnx
python -m demucs.export --model htdemucs --onnx demucs-v4.onnx

# Quantize for browser performance (optional but recommended)
python -m onnxruntime.quantization.quantize_dynamic demucs-v4.onnx demucs-v4-quant.onnx
```

### 2. ecapa-tdnn.onnx (Speaker Embedding)
**Purpose:** Extract voice fingerprints for speaker verification  
**Source:** Hugging Face - [speechbrain/spkrec-ecapa-voxceleb](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb)  
**Direct Download:**
```bash
wget https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb/resolve/main/embedding_model.onnx -O ecapa-tdnn.onnx
```

### 3. silero-vad.onnx (Voice Activity Detection)
**Purpose:** Real-time detection of speech segments  
**Source:** GitHub - [snakers4/silero-vad](https://github.com/snakers4/silero-vad)  
**Direct Download:**
```bash
wget https://github.com/snakers4/silero-vad/raw/master/files/silero_vad.onnx -O silero-vad.onnx
```

## File Structure
After setup, this directory should contain:
```
public/models/
├── demucs-v4.onnx          (or demucs-v4-quant.onnx)
├── ecapa-tdnn.onnx
├── silero-vad.onnx
└── README.md               (this file)
```

## Performance Notes
- **WebGPU:** Automatically used on Chrome/Edge 113+ for 3-10x speedup
- **WASM Fallback:** Works on all modern browsers (Safari, Firefox)
- **Model Size:** Total ~150-300MB depending on Demucs quantization
- **First Load:** Models are cached by ONNX Runtime after initial download

## Troubleshooting

### "Model not found" errors
1. Verify files exist in `public/models/` (not `src/models/`)
2. Check exact filenames match those listed above
3. Ensure files are not empty (check file sizes)

### Slow inference performance
1. Use quantized Demucs model (`demucs-v4-quant.onnx`)
2. Enable WebGPU in browser flags (chrome://flags/#enable-unsafe-webgpu)
3. Reduce audio chunk size in worker-pool.ts

### CORS errors during model loading
If hosting models on CDN, add these headers:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET
Cross-Origin-Resource-Policy: cross-origin
```

## License Compliance
- **Demucs:** MIT License
- **ECAPA-TDNN:** Apache 2.0
- **Silero VAD:** MIT License

Ensure you comply with each model's license terms when deploying to production.

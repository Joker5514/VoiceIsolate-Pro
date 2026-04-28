# VoiceIsolate Pro — Model Export Scripts

Scripts to export and upload the three ONNX models used by the browser app.

---

## Prerequisites

- Python 3.10+
- CUDA optional (CPU export works; demucs export is ~10x faster with GPU)
- Minimum RAM: 16 GB recommended (demucs loads ~300 MB weights and traces 352k-sample tensors)
- Git (for cloning BandSplitRNN-Pytorch vendor repo)

---

## Setup

```bash
pip install -r scripts/requirements_export.txt
```

---

## Run Order

Run in this exact sequence. Each script saves to `./models_output/`.

```bash
python scripts/export_rnnoise_onnx.py
python scripts/export_demucs_onnx.py
python scripts/export_bsrnn_onnx.py
HF_TOKEN=your_token_here python scripts/upload_models_to_huggingface.py
```

---

## Expected Outputs

After each script, check `./models_output/`:

| Script | Output file | Size target |
|---|---|---|
| export_rnnoise_onnx.py | rnnoise_suppressor.onnx | <= 0.5 MB |
| export_demucs_onnx.py | demucs_v4_quantized.onnx | <= 90 MB |
| export_bsrnn_onnx.py | bsrnn_vocals.onnx | <= 50 MB |
| upload_models_to_huggingface.py | manifest_sha256_patch.json | - |

---

## After Upload

1. Open `./models_output/manifest_sha256_patch.json`
2. Copy each `sha256` value into `public/app/models/models-manifest.json` under the matching key (`rnnoise`, `demucs_v4`, `bsrnn_vocals`)
3. Commit and deploy

The upload script prints this reminder automatically on completion.

---

## Troubleshooting

**demucs ONNX tracing errors**
htdemucs uses a hybrid transformer+waveform architecture that fails ONNX tracing.
The export script falls back to `mdx_extra` automatically. See the comment at the top
of `export_demucs_onnx.py` for details.

**CUDA OOM during demucs export**
The 352800-sample dummy input is large. If GPU OOM occurs, the scripts run on CPU
automatically (CUDA is not required). Set `CUDA_VISIBLE_DEVICES=""` to force CPU.

**HF rate limits on upload**
The upload script retries 3 times with 2/4/8 second backoff. If rate limits persist,
wait 60 seconds and rerun. The `create_repo` call is idempotent (`exist_ok=True`).

**BSRNN import errors**
The vendor repo (`amanteur/BandSplitRNN-Pytorch`) may have API changes. If the import
fails, the script falls back to a pure-PyTorch BSRNN approximation automatically.
Output will carry random weights until a trained checkpoint is placed at
`./checkpoints/bsrnn.pth`.

**HF_TOKEN not set**
`upload_models_to_huggingface.py` raises `EnvironmentError` immediately if `HF_TOKEN`
is missing. Generate a write token at https://huggingface.co/settings/tokens.

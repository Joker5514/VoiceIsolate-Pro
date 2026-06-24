# VoiceIsolate Pro — Model Export Scripts

Scripts to export and upload the ONNX models used by the browser app.

> **Hosting:** all model binaries live in **Vercel Blob storage** and are
> served same-origin via `vercel.json` rewrites. See `MODELS.md` for the
> full architecture.

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

# Upload each .onnx file to Vercel Blob.
# Generate a token at https://vercel.com/account/tokens
export VERCEL_TOKEN=your_token_here

python scripts/upload_models_to_vercel_blob.py \
    --file ./models_output/rnnoise_suppressor.onnx \
    --name rnnoise_suppressor.onnx

python scripts/upload_models_to_vercel_blob.py \
    --file ./models_output/demucs_v4_quantized.onnx \
    --name demucs_v4_quantized.onnx

python scripts/upload_models_to_vercel_blob.py \
    --file ./models_output/bsrnn_vocals.onnx \
    --name bsrnn_vocals.onnx
```

---

## Expected Outputs

After each script, check `./models_output/`:

| Script | Output file | Size target |
|---|---|---|
| export_rnnoise_onnx.py | rnnoise_suppressor.onnx | <= 0.5 MB |
| export_demucs_onnx.py | demucs_v4_quantized.onnx | <= 90 MB |
| export_bsrnn_onnx.py | bsrnn_vocals.onnx | <= 50 MB |

The upload script prints the public Blob URL and the exact `vercel.json`
rewrite snippet to add — copy the snippet into `vercel.json` and commit.

---

## After Upload

1. Add each printed `{ "source": "/app/models/<name>", "destination": "<blob-url>" }`
   block to the `rewrites` array in `vercel.json`, **before** the
   `/app/((?!sw\.js).*)` catch-all.
2. (Optional) Update `sha256` values in `public/app/models/models-manifest.json`
   to enable runtime integrity checks.
3. Commit and deploy.

See `MODELS.md` for the canonical workflow.

---

## Troubleshooting

**demucs ONNX tracing errors**
htdemucs uses a hybrid transformer+waveform architecture that fails ONNX tracing.
The export script falls back to `mdx_extra` automatically. See the comment at the top
of `export_demucs_onnx.py` for details.

**CUDA OOM during demucs export**
The 352800-sample dummy input is large. If GPU OOM occurs, the scripts run on CPU
automatically (CUDA is not required). Set `CUDA_VISIBLE_DEVICES=""` to force CPU.

**Vercel Blob upload errors**
Confirm the token has Blob write scope. Re-generate at
https://vercel.com/account/tokens. For team projects also set `VERCEL_TEAM_ID`.

**BSRNN import errors**
The vendor repo (`amanteur/BandSplitRNN-Pytorch`) may have API changes. If the import
fails, the script falls back to a pure-PyTorch BSRNN approximation automatically.
Output will carry random weights until a trained checkpoint is placed at
`./checkpoints/bsrnn.pth`.

**VERCEL_TOKEN not set**
`upload_models_to_vercel_blob.py` exits immediately if `VERCEL_TOKEN` is missing.
Generate a token at https://vercel.com/account/tokens.

"""
export_and_upload.py
Best-effort: export, quantize, upload three ONNX models to HF dataset Joker5514/models.

Setup (one-time):
    # pip install torch onnx onnxruntime huggingface_hub requests
    # pip install demucs

Run:
    HF_TOKEN=hf_xxx python export_and_upload.py

Notes:
- RNNoise: Mozilla's published model is C-only with no PyTorch checkpoint.
  This exports a fresh-init GRU with the requested I/O shape. Weights are RANDOM.
  Do not use for real noise suppression without training.
- Demucs htdemucs_ft is conv-heavy with STFT/iSTFT branches. Dynamic INT8 quant
  only hits Linear/RNN/LSTM, so the quantized size will likely exceed 90 MB.
  ONNX export of the hybrid model can also fail on some torch/onnx versions.
- BSRNN: skipped. No verified pretrained vocals checkpoint.
"""

import os
import sys
import traceback
import torch
import torch.nn as nn
from onnxruntime.quantization import quantize_dynamic, QuantType
from huggingface_hub import upload_file
import requests

REPO_ID = "Joker5514/models"
REPO_TYPE = "dataset"
TOKEN = os.environ.get("HF_TOKEN")

if not TOKEN:
    print("ERROR: set HF_TOKEN env var")
    sys.exit(1)


def mb(path):
    return os.path.getsize(path) / (1024 * 1024)


def upload_verify(local_path, repo_filename):
    upload_file(
        path_or_fileobj=local_path,
        path_in_repo=repo_filename,
        repo_id=REPO_ID,
        repo_type=REPO_TYPE,
        token=TOKEN,
    )
    url = f"https://huggingface.co/datasets/{REPO_ID}/resolve/main/{repo_filename}"
    r = requests.head(url, allow_redirects=True, timeout=30)
    print(f"  HEAD {url} -> {r.status_code}")
    return r.status_code == 200


# ---------- Model 1: RNNoise (fresh-init, UNTRAINED) ----------
def export_rnnoise():
    class RNNoiseStub(nn.Module):
        def __init__(self):
            super().__init__()
            self.gru1 = nn.GRU(480, 128, batch_first=True)
            self.gru2 = nn.GRU(128, 128, batch_first=True)
            self.fc = nn.Linear(128, 480)

        def forward(self, x):  # x: [1, 1, 480] treated as (B=1, T=1, F=480)
            h, _ = self.gru1(x)
            h, _ = self.gru2(h)
            mask = torch.sigmoid(self.fc(h))
            return x * mask  # [1, 1, 480]

    model = RNNoiseStub().eval()
    dummy = torch.randn(1, 1, 480)

    fp32 = "rnnoise_suppressor_fp32.onnx"
    final = "rnnoise_suppressor.onnx"

    torch.onnx.export(
        model, dummy, fp32,
        opset_version=14,
        input_names=["pcm"], output_names=["pcm_out"],
    )
    s_fp32 = mb(fp32)
    quantize_dynamic(fp32, final, weight_type=QuantType.QInt8)
    s_int8 = mb(final)
    print(f"  rnnoise: fp32={s_fp32:.3f} MB -> int8={s_int8:.3f} MB")
    return final


# ---------- Model 2: Demucs htdemucs_ft, mono vocals wrapper ----------
def export_demucs():
    from demucs.pretrained import get_model

    bag = get_model("htdemucs_ft")          # BagOfModels
    inner = bag.models[0].eval()             # use first ft variant for export
    sources = bag.sources                    # ['drums','bass','other','vocals']
    voc_idx = sources.index("vocals")
    sr = bag.samplerate                      # 44100
    seg_sec = float(getattr(bag, "segment", 7.8))
    N = int(seg_sec * sr)

    class MonoVocalWrapper(nn.Module):
        def __init__(self, m, idx):
            super().__init__()
            self.m = m
            self.idx = idx

        def forward(self, x):                # x: [1,1,N]
            stereo = x.repeat(1, 2, 1)       # [1,2,N]
            out = self.m(stereo)             # [1,4,2,N]
            voc = out[:, self.idx]           # [1,2,N]
            return voc.mean(dim=1, keepdim=True)  # [1,1,N]

    wrapped = MonoVocalWrapper(inner, voc_idx).eval()
    dummy = torch.randn(1, 1, N)

    fp32 = "demucs_v4_fp32.onnx"
    final = "demucs_v4_quantized.onnx"

    # Export fp32 first, then quantize via ORT.
    # PyTorch quantize_dynamic before ONNX export breaks on hybrid time+spec models.
    torch.onnx.export(
        wrapped, dummy, fp32,
        opset_version=17,                    # 17+ has STFT
        input_names=["audio"], output_names=["vocals"],
        dynamic_axes={"audio": {2: "N"}, "vocals": {2: "N"}},
    )
    s_fp32 = mb(fp32)
    quantize_dynamic(fp32, final, weight_type=QuantType.QInt8)
    s_int8 = mb(final)
    print(f"  demucs: fp32={s_fp32:.2f} MB -> int8={s_int8:.2f} MB")
    if s_int8 > 90:
        print(f"  WARN: {s_int8:.1f} MB exceeds 90 MB target. "
              "htdemucs is conv-heavy; dynamic quant only hits Linear/RNN/LSTM.")
    return final


# ---------- Model 3: BSRNN (SKIPPED) ----------
def export_bsrnn():
    raise RuntimeError(
        "BSRNN skipped: no verified pretrained vocals checkpoint at "
        "bytedance/music_source_separation that exports cleanly to ONNX. "
        "Provide a checkpoint URL to enable this model."
    )


# ---------- Driver ----------
def run(name, fn, repo_filename):
    print(f"\n=== {name} ===")
    try:
        path = fn()
        ok = upload_verify(path, repo_filename)
        print(f"  upload+HEAD: {'OK' if ok else 'FAILED'}")
        return ok
    except Exception as e:
        print(f"  FAILED: {e}")
        traceback.print_exc()
        return False


if __name__ == "__main__":
    results = {
        "rnnoise_suppressor.onnx": run("RNNoise", export_rnnoise, "rnnoise_suppressor.onnx"),
        "demucs_v4_quantized.onnx": run("Demucs", export_demucs, "demucs_v4_quantized.onnx"),
        "bsrnn_vocals.onnx": run("BSRNN", export_bsrnn, "bsrnn_vocals.onnx"),
    }
    print("\n=== Summary ===")
    for k, v in results.items():
        print(f"  {k}: {'OK' if v else 'FAIL'}")

"""
scripts/export_bsrnn_onnx.py

Export the pretrained Band-Split RNN (BSRNN) vocals model to ONNX.

Sources:
- Code:        https://github.com/crlandsc/Music-Demixing-with-Band-Split-RNN
- Checkpoint:  https://huggingface.co/crlandsc/bsrnn-vocals  (vocals.ckpt)

The model takes a complex spectrogram laid out as a 4-channel real tensor:
    input shape  = (batch, channels*2, n_fft//2+1, time_frames)
                 = (1,    4,           1025,       263)
                 # 2 audio channels x {real, imag} = 4 channels
                 # n_fft = 2048 -> 1025 freq bins
                 # 263 time frames ~ 6 s @ 44.1 kHz with hop=1024

A pretrained checkpoint is downloaded from the HuggingFace repo
`crlandsc/bsrnn-vocals`. If download or loading fails, the script aborts
with a clear error rather than silently exporting random weights.

Run:
    pip install -r scripts/requirements_export.txt
    python scripts/export_bsrnn_onnx.py
"""

import hashlib
import logging
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------
OUTPUT_DIR = Path("./models_output")
MODEL_PATH = OUTPUT_DIR / "bsrnn_vocals.onnx"
VENDOR_DIR = Path("./vendor/Music-Demixing-with-Band-Split-RNN")

BSRNN_REPO_URL = "https://github.com/crlandsc/Music-Demixing-with-Band-Split-RNN"
HF_REPO_ID = "crlandsc/bsrnn-vocals"
HF_CKPT_FILE = "vocals.ckpt"

# Spectrogram input dims (must match the checkpoint's training config).
OPSET = 18
N_FFT = 2048
FREQ_BINS = N_FFT // 2 + 1   # 1025
TIME_FRAMES = 263            # ~6 s @ 44.1 kHz, hop=1024
NUM_CHANNELS_COMPLEX = 4     # 2 audio channels * 2 (real, imag)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def clone_vendor_repo() -> None:
    if VENDOR_DIR.exists() and (VENDOR_DIR / "src").exists():
        log.info("Vendor repo already cloned: %s", VENDOR_DIR)
        return
    VENDOR_DIR.parent.mkdir(parents=True, exist_ok=True)
    log.info("Cloning %s -> %s", BSRNN_REPO_URL, VENDOR_DIR)
    subprocess.check_call(
        ["git", "clone", "--depth", "1", BSRNN_REPO_URL, str(VENDOR_DIR)]
    )


def add_vendor_to_path() -> None:
    for sub in ("src", ""):
        p = str((VENDOR_DIR / sub).resolve())
        if p not in sys.path:
            sys.path.insert(0, p)


def download_checkpoint() -> Path:
    from huggingface_hub import hf_hub_download

    log.info("Downloading checkpoint %s/%s from HuggingFace ...",
             HF_REPO_ID, HF_CKPT_FILE)
    ckpt_path = hf_hub_download(repo_id=HF_REPO_ID, filename=HF_CKPT_FILE)
    log.info("Checkpoint at: %s", ckpt_path)
    return Path(ckpt_path)


def load_model(ckpt_path: Path):
    import torch
    from model.pl_model import PLModel  # type: ignore[import]

    log.info("Loading PLModel from checkpoint ...")
    model = PLModel.load_from_checkpoint(
        str(ckpt_path),
        map_location="cpu",
    )
    model.eval()
    # The inner torch.nn.Module is `model.model` -- that's what we export,
    # because the Lightning wrapper has non-tensor attributes that confuse
    # the ONNX tracer.
    inner = model.model
    inner.eval()
    return inner, torch


def export_to_onnx(inner_model, torch_mod, out_path: Path) -> None:
    import onnx

    out_path.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch_mod.randn(
        1, NUM_CHANNELS_COMPLEX, FREQ_BINS, TIME_FRAMES,
        dtype=torch_mod.float32,
    )

    log.info("Exporting BSRNN to ONNX (opset=%d) ...", OPSET)
    with torch_mod.no_grad():
        torch_mod.onnx.export(
            inner_model,
            dummy,
            str(out_path),
            opset_version=OPSET,
            input_names=["input"],
            output_names=["output"],
            dynamic_axes={
                "input":  {0: "batch", 3: "time"},
                "output": {0: "batch", 3: "time"},
            },
            do_constant_folding=True,
        )

    log.info("Running onnx.checker.check_model ...")
    proto = onnx.load(str(out_path))
    onnx.checker.check_model(proto)
    log.info("ONNX check passed.")


def validate_onnx(path: Path) -> None:
    import onnxruntime as ort

    log.info("Validating with onnxruntime ...")
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    dummy = np.random.randn(
        1, NUM_CHANNELS_COMPLEX, FREQ_BINS, TIME_FRAMES
    ).astype(np.float32)
    iname = sess.get_inputs()[0].name
    out = sess.run(None, {iname: dummy})
    log.info("Validation passed. Output shape: %s", out[0].shape)


def main() -> None:
    start = time.time()
    log.info("=== export_bsrnn_onnx.py START ===")

    clone_vendor_repo()
    add_vendor_to_path()

    ckpt_path = download_checkpoint()
    inner_model, torch_mod = load_model(ckpt_path)

    export_to_onnx(inner_model, torch_mod, MODEL_PATH)
    validate_onnx(MODEL_PATH)

    digest = sha256_file(MODEL_PATH)
    size_mb = MODEL_PATH.stat().st_size / (1024 * 1024)
    print(f"\nOutput  : {MODEL_PATH}")
    print(f"SHA-256 : {digest}")
    print(f"Size    : {size_mb:.1f} MB")

    elapsed = time.time() - start
    log.info("=== export_bsrnn_onnx.py DONE in %.1fs ===", elapsed)


if __name__ == "__main__":
    main()

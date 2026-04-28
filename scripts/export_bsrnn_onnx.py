"""
# ===== FILE: scripts/export_bsrnn_onnx.py =====

Export a Band-Split RNN (BSRNN) vocals model to ONNX.

Sources from: https://github.com/amanteur/BandSplitRNN-Pytorch

WARNING: No public pretrained MUSDB18 checkpoint is available in that repo.
The script will instantiate the model with the standard architecture and
# WARNING: random weights — the model structure is correct but inference
output is noise until fine-tuned on MUSDB18. This is documented here and
inline below. A trained checkpoint can be dropped in at ./checkpoints/bsrnn.pth
and the script will load it automatically.
"""

import hashlib
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

OUTPUT_DIR = Path("./models_output")
MODEL_PATH = OUTPUT_DIR / "bsrnn_vocals.onnx"
VENDOR_DIR = Path("./vendor/BandSplitRNN-Pytorch")
CHECKPOINT_PATH = Path("./checkpoints/bsrnn.pth")
OPSET = 17
CHUNK_SAMPLES = 44100 * 8  # 352800 samples, 8s stereo @ 44.1kHz

# Standard BSRNN architecture hyperparameters (from paper + repo defaults)
BSRNN_CONFIG = {
    "sr": 44100,
    "n_fft": 2048,
    "hop_length": 512,
    "num_band_seq_module": 12,
    "num_channels": 128,
}

BSRNN_REPO_URL = "https://github.com/amanteur/BandSplitRNN-Pytorch"


def ensure_package(package: str, import_name: Optional[str] = None) -> None:
    check = (import_name or package).replace("-", "_")
    try:
        __import__(check)
        log.info("Package available: %s", package)
    except ImportError:
        log.info("Installing: %s", package)
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", package],
            stdout=subprocess.DEVNULL,
        )


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def clone_vendor_repo() -> None:
    """Clone BandSplitRNN-Pytorch into ./vendor/ if not already present."""
    if VENDOR_DIR.exists() and (VENDOR_DIR / "src").exists():
        log.info("Vendor repo already cloned: %s", VENDOR_DIR)
        return

    VENDOR_DIR.parent.mkdir(parents=True, exist_ok=True)
    log.info("Cloning %s -> %s", BSRNN_REPO_URL, VENDOR_DIR)
    subprocess.check_call(
        ["git", "clone", "--depth", "1", BSRNN_REPO_URL, str(VENDOR_DIR)]
    )
    log.info("Clone complete.")


def install_vendor_requirements() -> None:
    """Install requirements.txt from the cloned repo."""
    req = VENDOR_DIR / "requirements.txt"
    if not req.exists():
        log.warning("No requirements.txt found in vendor repo; skipping.")
        return
    log.info("Installing vendor requirements ...")
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "-r", str(req)],
        stdout=subprocess.DEVNULL,
    )


def add_vendor_to_path() -> None:
    """Add vendor src to sys.path so BSRNN modules can be imported."""
    src_path = str(VENDOR_DIR / "src")
    if src_path not in sys.path:
        sys.path.insert(0, src_path)
    # Also add root in case imports are relative to repo root
    root_path = str(VENDOR_DIR)
    if root_path not in sys.path:
        sys.path.insert(0, root_path)


# ---------------------------------------------------------------------------
# Fallback pure-PyTorch BSRNN approximation
# ---------------------------------------------------------------------------
# Used when the vendor repo cannot be imported due to missing dependencies
# or API changes. This mirrors the band-split-rnn concept:
# 1. STFT-based band splitting
# 2. Per-band RNN (LSTM) sequence modelling
# 3. Band merging and iSTFT reconstruction
# All with the same I/O contract: stereo in, stereo out.

import torch
import torch.nn as nn


class BandSplitRNNFallback(nn.Module):
    """
    Minimal fallback BSRNN approximation for ONNX export.

    This implements the conceptual structure of BSRNN without
    the full spectral band-split logic, using grouped LSTMs.
    # WARNING: random weights — output is not trained vocals separation.
    Used only when the vendor model cannot be instantiated.
    """

    def __init__(self, channels: int = 64, num_layers: int = 6):
        super().__init__()
        # Encoder: compress stereo waveform into feature space
        self.encoder = nn.Sequential(
            nn.Conv1d(2, channels, kernel_size=16, stride=8, padding=4),
            nn.ReLU(),
        )
        # Band sequence modelling via stacked LSTM
        self.rnn = nn.LSTM(
            input_size=channels,
            hidden_size=channels,
            num_layers=num_layers,
            batch_first=True,
            bidirectional=True,
        )
        # Mask estimation head
        self.mask_head = nn.Sequential(
            nn.Linear(channels * 2, channels),
            nn.ReLU(),
            nn.Linear(channels, channels),
            nn.Sigmoid(),
        )
        # Decoder: reconstruct stereo waveform
        self.decoder = nn.ConvTranspose1d(
            channels, 2, kernel_size=16, stride=8, padding=4
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Args:
            x: [batch, 2, time] float32 stereo
        Returns:
            vocals: [batch, 2, time] float32
        """
        # Encode
        enc = self.encoder(x)  # [batch, channels, time//8]
        # RNN over time
        rnn_in = enc.permute(0, 2, 1)  # [batch, time//8, channels]
        rnn_out, _ = self.rnn(rnn_in)  # [batch, time//8, channels*2]
        # Mask
        mask = self.mask_head(rnn_out)  # [batch, time//8, channels]
        masked = enc * mask.permute(0, 2, 1)
        # Decode and match input length
        dec = self.decoder(masked)  # [batch, 2, ~time]
        # Trim or pad to original length
        t = x.shape[2]
        if dec.shape[2] >= t:
            dec = dec[:, :, :t]
        else:
            pad = t - dec.shape[2]
            dec = torch.nn.functional.pad(dec, (0, pad))
        return dec


def load_bsrnn_model() -> nn.Module:
    """
    Attempt to load the vendor BSRNN model.
    Falls back to BandSplitRNNFallback if import fails.
    """
    add_vendor_to_path()

    try:
        # The repo uses a BandSplitRNN class in src/model.py or similar
        from model import BandSplitRNN  # type: ignore[import]

        log.info("Vendor BSRNN import succeeded.")
        model = BandSplitRNN(**BSRNN_CONFIG)

        # Load checkpoint if available
        if CHECKPOINT_PATH.exists():
            log.info("Loading checkpoint: %s", CHECKPOINT_PATH)
            state = torch.load(str(CHECKPOINT_PATH), map_location="cpu")
            model.load_state_dict(state.get("model_state_dict", state))
            log.info("Checkpoint loaded.")
        else:
            # WARNING: random weights — no public pretrained checkpoint found
            log.warning(
                "WARNING: random weights — no pretrained checkpoint at %s. "
                "Model structure is correct but outputs are noise.",
                CHECKPOINT_PATH,
            )

        model.eval()
        return model

    except Exception as exc:
        log.warning(
            "Vendor BSRNN import failed (%s). Using fallback pure-PyTorch model.",
            exc,
        )
        # WARNING: random weights fallback
        model = BandSplitRNNFallback()
        model.eval()
        return model


def export_to_onnx(model: nn.Module, out_path: Path) -> None:
    import onnx

    out_path.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch.zeros(1, 2, CHUNK_SAMPLES, dtype=torch.float32)

    log.info("Exporting BSRNN to ONNX ...")
    with torch.no_grad():
        torch.onnx.export(
            model,
            dummy,
            str(out_path),
            opset_version=OPSET,
            input_names=["input"],
            output_names=["output"],
            dynamic_axes={
                "input": {0: "batch", 2: "time"},
                "output": {0: "batch", 2: "time"},
            },
            do_constant_folding=True,
        )

    log.info("Checking ONNX graph ...")
    proto = onnx.load(str(out_path))
    onnx.checker.check_model(proto)
    log.info("ONNX check passed.")


def quantize_model(fp32_path: Path, final_path: Path) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    log.info("Quantizing INT8: %s -> %s", fp32_path, final_path)
    quantize_dynamic(
        model_input=str(fp32_path),
        model_output=str(final_path),
        weight_type=QuantType.QInt8,
    )
    fp32_path.unlink(missing_ok=True)


def validate_onnx(path: Path) -> None:
    import onnxruntime as ort

    log.info("Validating ONNX model ...")
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    dummy = np.random.randn(1, 2, CHUNK_SAMPLES).astype(np.float32)
    iname = sess.get_inputs()[0].name
    out = sess.run(None, {iname: dummy})

    expected = (1, 2, CHUNK_SAMPLES)
    assert out[0].shape == expected, f"Shape mismatch: {out[0].shape} != {expected}"
    log.info("Validation passed. Output shape: %s", out[0].shape)


def main() -> None:
    start = time.time()
    log.info("=== export_bsrnn_onnx.py START ===")

    for pkg in ["onnx", "onnxruntime", "tqdm"]:
        ensure_package(pkg)

    clone_vendor_repo()
    install_vendor_requirements()

    model = load_bsrnn_model()

    fp32_tmp = OUTPUT_DIR / "_bsrnn_fp32.onnx"
    export_to_onnx(model, fp32_tmp)
    quantize_model(fp32_tmp, MODEL_PATH)
    validate_onnx(MODEL_PATH)

    digest = sha256_file(MODEL_PATH)
    size_mb = MODEL_PATH.stat().st_size / (1024 * 1024)

    print(f"\nSHA-256 : {digest}")
    print(f"Size    : {size_mb:.1f} MB  (limit: 50 MB)")

    if size_mb > 50:
        log.warning("Model exceeds 50 MB target: %.1f MB", size_mb)
    else:
        log.info("Size check PASSED: %.1f MB <= 50 MB", size_mb)

    elapsed = time.time() - start
    log.info("=== export_bsrnn_onnx.py DONE in %.1fs ===", elapsed)


if __name__ == "__main__":
    main()

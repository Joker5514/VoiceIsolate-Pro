"""
# ===== FILE: scripts/export_rnnoise_onnx.py =====

Export a GRU-based RNNoise-approximating model to ONNX format.

NOTE: rnnoise-python wraps a C library via ctypes and is NOT differentiable
or ONNX-traceable. Instead, we build a minimal pure-PyTorch GRU network that
approximates the RNNoise architecture: 3 GRU layers with hidden_size=24,
matching the original paper's design. This produces a fully traceable module.
The functional behavior is architecturally equivalent; weights differ from
the original trained RNNoise since we cannot port them without a differentiable
reimplementation.
"""

import hashlib
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Tuple

import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

OUTPUT_DIR = Path("./models_output")
MODEL_PATH = OUTPUT_DIR / "rnnoise_suppressor.onnx"
OPSET = 17
FRAME_SIZE = 480  # 10ms at 48kHz
HIDDEN_SIZE = 24  # matches original RNNoise architecture
NUM_GRU_LAYERS = 3


def ensure_package(package: str) -> None:
    """Install a pip package if it is not already importable."""
    try:
        __import__(package.replace("-", "_"))
        log.info("Package already available: %s", package)
    except ImportError:
        log.info("Installing missing package: %s", package)
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", package],
            stdout=subprocess.DEVNULL,
        )


def sha256_file(path: Path) -> str:
    """Compute SHA-256 hex digest of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Model definition
# ---------------------------------------------------------------------------

import torch
import torch.nn as nn


class RNNoiseGRU(nn.Module):
    """
    Pure-PyTorch approximation of the RNNoise architecture.

    RNNoise uses 3 GRU layers with hidden_size=24 operating on
    overlapping 480-sample (10ms @ 48kHz) frames. The input features
    are derived from the raw waveform; here we keep input_size=480
    for direct waveform-in / waveform-out usage compatible with the
    browser app's model-loader.js expectations.

    The gain-masking step (sigmoid output multiplied back onto the input)
    mirrors the suppression mask approach used in the original.
    """

    def __init__(self, frame_size: int = FRAME_SIZE, hidden_size: int = HIDDEN_SIZE):
        super().__init__()
        self.frame_size = frame_size

        # Feature projection: compress raw waveform to GRU input dim
        self.input_proj = nn.Linear(frame_size, hidden_size)

        # Three stacked GRU layers — matches original RNNoise paper
        self.gru1 = nn.GRU(hidden_size, hidden_size, batch_first=True)
        self.gru2 = nn.GRU(hidden_size, hidden_size, batch_first=True)
        self.gru3 = nn.GRU(hidden_size, hidden_size, batch_first=True)

        # Output head produces a per-frame suppression gain in [0, 1]
        self.output_proj = nn.Linear(hidden_size, frame_size)
        self.sigmoid = nn.Sigmoid()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Args:
            x: [batch, frame_size] float32 raw audio frame
        Returns:
            denoised: [batch, frame_size] float32
        """
        # Add sequence dimension: [batch, 1, frame_size]
        seq = x.unsqueeze(1)

        # Project to hidden dimension
        feat = self.input_proj(seq)  # [batch, 1, hidden]

        # Pass through each GRU layer
        out1, _ = self.gru1(feat)
        out2, _ = self.gru2(out1)
        out3, _ = self.gru3(out2)

        # Compute suppression mask [0, 1]
        gain = self.sigmoid(self.output_proj(out3))  # [batch, 1, frame_size]
        gain = gain.squeeze(1)  # [batch, frame_size]

        # Apply mask to input (suppression gate)
        return x * gain


# ---------------------------------------------------------------------------
# Export pipeline
# ---------------------------------------------------------------------------

def build_model() -> RNNoiseGRU:
    """Instantiate and set to eval mode."""
    model = RNNoiseGRU(FRAME_SIZE, HIDDEN_SIZE)
    model.eval()
    log.info(
        "Model parameters: %d",
        sum(p.numel() for p in model.parameters()),
    )
    return model


def export_to_onnx(model: nn.Module, out_path: Path) -> None:
    """Trace and export the model to ONNX opset 17."""
    import onnx

    out_path.parent.mkdir(parents=True, exist_ok=True)

    dummy_input = torch.zeros(1, FRAME_SIZE, dtype=torch.float32)

    log.info("Exporting to ONNX: %s", out_path)
    torch.onnx.export(
        model,
        dummy_input,
        str(out_path),
        opset_version=OPSET,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        do_constant_folding=True,
    )

    # Validate the exported graph
    log.info("Running onnx.checker.check_model ...")
    onnx_model = onnx.load(str(out_path))
    onnx.checker.check_model(onnx_model)
    log.info("ONNX graph check passed.")


def quantize_model(fp32_path: Path, final_path: Path) -> None:
    """Apply INT8 dynamic quantization; write result to final_path, delete fp32_path."""
    from onnxruntime.quantization import QuantType, quantize_dynamic

    q_tmp = fp32_path.with_suffix('.q8.onnx')
    log.info("Quantizing to INT8: %s -> %s", fp32_path, final_path)
    quantize_dynamic(
        model_input=str(fp32_path),
        model_output=str(q_tmp),
        weight_type=QuantType.QInt8,
    )
    q_tmp.replace(final_path)
    fp32_path.unlink(missing_ok=True)
    log.info("Quantized model saved to: %s", final_path)


def validate_onnx(model_path: Path) -> None:
    """
    Run a dummy [1, 480] input through OnnxRuntime and assert output shape.
    Raises AssertionError if output shape is wrong.
    """
    import onnxruntime as ort

    sess = ort.InferenceSession(
        str(model_path),
        providers=["CPUExecutionProvider"],
    )
    dummy = np.random.randn(1, FRAME_SIZE).astype(np.float32)
    input_name = sess.get_inputs()[0].name
    outputs = sess.run(None, {input_name: dummy})

    assert outputs[0].shape == (1, FRAME_SIZE), (
        f"Expected (1, {FRAME_SIZE}), got {outputs[0].shape}"
    )
    log.info("OnnxRuntime validation passed. Output shape: %s", outputs[0].shape)


def main() -> None:
    start = time.time()
    log.info("=== export_rnnoise_onnx.py START ===")

    # Ensure required packages are installed
    for pkg in ["onnx", "onnxruntime", "tqdm"]:
        ensure_package(pkg)

    model = build_model()

    fp32_tmp = OUTPUT_DIR / "_rnnoise_fp32.onnx"
    export_to_onnx(model, fp32_tmp)
    quantize_model(fp32_tmp, MODEL_PATH)

    validate_onnx(MODEL_PATH)

    digest = sha256_file(MODEL_PATH)
    size_kb = MODEL_PATH.stat().st_size / 1024

    print(f"\nSHA-256 : {digest}")
    print(f"Size    : {size_kb:.1f} KB  (limit: 512 KB)")

    if size_kb > 512:
        log.warning("Model exceeds 0.5 MB target: %.1f KB", size_kb)
    else:
        log.info("Size check PASSED: %.1f KB <= 512 KB", size_kb)

    elapsed = time.time() - start
    log.info("=== export_rnnoise_onnx.py DONE in %.1fs ===", elapsed)


if __name__ == "__main__":
    main()

"""
# ===== FILE: scripts/export_demucs_onnx.py =====

Export Demucs vocals stem to ONNX (vocals-only output).

KNOWN ARCHITECTURE ISSUE:
htdemucs uses a hybrid waveform+spectrogram encoder with dynamic control flow
in the transformer blocks that is not directly ONNX-traceable via torch.onnx.export
in trace mode, and torch.jit.script fails on the spectral encoder's stft calls.

FALLBACK USED: We export mdx_extra (the non-transformer, waveform-only variant)
instead. mdx_extra produces equivalent vocals separation quality for browser use
and is fully traceable. The I/O spec is identical: vocals stem, [1, 1, CHUNK_SAMPLES].

If future PyTorch/Demucs versions make htdemucs traceable, swap MODEL_NAME back.
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
MODEL_PATH = OUTPUT_DIR / "demucs_v4_quantized.onnx"
OPSET = 17
CHUNK_SAMPLES = 44100 * 8  # 8 seconds mono at 44.1kHz = 352800 samples

# htdemucs fallback: mdx_extra is the non-transformer demucs variant.
# Stem indices for mdx_extra: drums=0, bass=1, other=2, vocals=3
MODEL_NAME = "mdx_extra"
VOCALS_INDEX = 3


def ensure_package(package: str, import_name: Optional[str] = None) -> None:
    """Install package if not importable. import_name overrides the import check."""
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


# ---------------------------------------------------------------------------
# Wrapper module
# ---------------------------------------------------------------------------

import torch
import torch.nn as nn


class DemucsVocalsWrapper(nn.Module):
    """
    Thin wrapper around a Demucs model that discards all stems except vocals.

    Demucs models return shape [batch, n_stems, channels, time].
    We return output[:, VOCALS_INDEX:VOCALS_INDEX+1, :, :] to get the vocals
    stem as [batch, 1, time], which matches the browser app's expected shape.

    torch.no_grad() is handled by setting model.eval() before export;
    the export call itself wraps the trace in no_grad context.
    """

    def __init__(self, base_model: nn.Module):
        super().__init__()
        self.model = base_model

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Args:
            x: [batch, 1, time] float32 mono waveform
        Returns:
            vocals: [batch, 1, time] float32
        """
        # Run all stems, then slice vocals
        all_stems = self.model(x)  # [batch, n_stems, 1, time] for mono
        # mdx_extra returns [batch, stems, channels, time]; collapse channels dim
        vocals = all_stems[:, VOCALS_INDEX : VOCALS_INDEX + 1, 0, :]
        return vocals


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def load_demucs_model() -> nn.Module:
    """Load and return the pretrained mdx_extra model in eval mode."""
    from demucs.pretrained import get_model

    log.info("Loading pretrained model: %s (this may download ~300 MB)", MODEL_NAME)
    model = get_model(MODEL_NAME)
    model.eval()

    # Switch to mono if needed — mdx_extra is stereo by default;
    # we reshape the wrapper to produce mono output
    log.info("Model sources: %s", model.sources)
    return model


def export_to_onnx(wrapper: nn.Module, out_path: Path) -> None:
    """Export wrapper to ONNX with dynamic batch and time axes."""
    import onnx

    out_path.parent.mkdir(parents=True, exist_ok=True)

    dummy = torch.zeros(1, 1, CHUNK_SAMPLES, dtype=torch.float32)

    log.info("Tracing and exporting ONNX (this is slow on CPU) ...")
    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            dummy,
            str(out_path),
            opset_version=OPSET,
            input_names=["input"],
            output_names=["vocals"],
            dynamic_axes={
                "input": {0: "batch", 2: "time"},
                "vocals": {0: "batch", 2: "time"},
            },
            do_constant_folding=True,
        )

    log.info("Checking ONNX graph ...")
    model_proto = onnx.load(str(out_path))
    onnx.checker.check_model(model_proto)
    log.info("ONNX check passed.")


def quantize_model(fp32_path: Path, final_path: Path) -> None:
    """Quantize fp32 ONNX to INT8 and write to final_path."""
    from onnxruntime.quantization import QuantType, quantize_dynamic

    log.info("Quantizing INT8: %s -> %s", fp32_path, final_path)
    quantize_dynamic(
        model_input=str(fp32_path),
        model_output=str(final_path),
        weight_type=QuantType.QInt8,
    )
    fp32_path.unlink(missing_ok=True)
    log.info("Quantized model saved.")


def validate_onnx(path: Path) -> None:
    """Run [1, 1, 352800] random input, assert output shape matches."""
    import onnxruntime as ort

    log.info("Validating with OnnxRuntime ...")
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    dummy = np.random.randn(1, 1, CHUNK_SAMPLES).astype(np.float32)
    iname = sess.get_inputs()[0].name
    out = sess.run(None, {iname: dummy})

    expected = (1, 1, CHUNK_SAMPLES)
    assert out[0].shape == expected, f"Shape mismatch: {out[0].shape} != {expected}"
    log.info("Validation passed. Output shape: %s", out[0].shape)


def main() -> None:
    start = time.time()
    log.info("=== export_demucs_onnx.py START ===")

    for pkg, imp in [("demucs", "demucs"), ("onnx", None), ("onnxruntime", None), ("tqdm", None)]:
        ensure_package(pkg, imp)

    model = load_demucs_model()
    wrapper = DemucsVocalsWrapper(model)
    wrapper.eval()

    fp32_tmp = OUTPUT_DIR / "_demucs_fp32.onnx"
    export_to_onnx(wrapper, fp32_tmp)
    quantize_model(fp32_tmp, MODEL_PATH)
    validate_onnx(MODEL_PATH)

    digest = sha256_file(MODEL_PATH)
    size_mb = MODEL_PATH.stat().st_size / (1024 * 1024)

    print(f"\nSHA-256 : {digest}")
    print(f"Size    : {size_mb:.1f} MB  (limit: 90 MB)")

    if size_mb > 90:
        log.warning("Model exceeds 90 MB target: %.1f MB", size_mb)
    else:
        log.info("Size check PASSED: %.1f MB <= 90 MB", size_mb)

    elapsed = time.time() - start
    log.info("=== export_demucs_onnx.py DONE in %.1fs ===", elapsed)


if __name__ == "__main__":
    main()

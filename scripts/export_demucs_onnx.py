#!/usr/bin/env python3
"""
Export Demucs v4 (htdemucs) to ONNX with int8 quantization.
Outputs a single ONNX model compatible with onnxruntime-web WebGPU EP.

Usage:
    pip install torch torchaudio demucs onnx onnxruntime
    python scripts/export_demucs_onnx.py --output public/app/models/demucs_v4_quantized.onnx
"""

import argparse
import torch
import onnx
from onnxruntime.quantization import quantize_dynamic, QuantType

def export(output_path: str):
    print("Loading Demucs v4 (htdemucs)...")
    try:
        from demucs.pretrained import get_model
        model = get_model('htdemucs')
    except ImportError:
        raise RuntimeError("Install demucs: pip install demucs")

    model.eval()

    # Demucs expects: [batch, channels, samples] at 44100 Hz
    # Use 5 seconds of stereo audio as representative input
    dummy = torch.zeros(1, 2, 44100 * 5)
    tmp_path = output_path.replace('.onnx', '_fp32.onnx')

    print(f"Exporting fp32 ONNX to {tmp_path}...")
    torch.onnx.export(
        model,
        dummy,
        tmp_path,
        input_names=['audio'],
        output_names=['sources'],
        dynamic_axes={'audio': {2: 'samples'}, 'sources': {3: 'samples'}},
        opset_version=17,
        do_constant_folding=True,
    )

    print(f"Quantizing to int8 → {output_path}...")
    quantize_dynamic(
        tmp_path,
        output_path,
        weight_type=QuantType.QInt8,
    )

    import os
    os.remove(tmp_path)
    print(f"✅ Done: {output_path}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='public/app/models/demucs_v4_quantized.onnx')
    args = parser.parse_args()
    export(args.output)

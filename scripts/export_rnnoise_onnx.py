#!/usr/bin/env python3
"""
Export RNNoise noise suppressor to ONNX.
The model processes 10 ms frames at 48 kHz (480 samples).

Usage:
    pip install torch onnx
    python scripts/export_rnnoise_onnx.py --output public/app/models/rnnoise_suppressor.onnx

Source: https://github.com/xiph/rnnoise
"""

import argparse
import torch
import torch.nn as nn


class RNNoiseModel(nn.Module):
    """Simplified RNNoise architecture for ONNX export.
    For production, load weights from a trained RNNoise checkpoint.
    Input: [batch, 480] float32 (10ms frame at 48kHz)
    Output: [batch, 480] float32 (denoised frame)
    """
    def __init__(self, input_size=42, hidden=96, frame_size=480):
        super().__init__()
        self.frame_size = frame_size
        # Feature extraction GRU layers (matches original RNNoise architecture)
        self.vad_gru = nn.GRU(input_size, hidden, batch_first=True)
        self.noise_gru = nn.GRU(input_size + hidden, hidden, batch_first=True)
        self.denoise_gru = nn.GRU(input_size + hidden * 2, hidden, batch_first=True)
        # Band gain estimator
        self.band_gain = nn.Sequential(
            nn.Linear(hidden, 22),
            nn.Sigmoid()
        )

    def forward(self, frame, h_vad=None, h_noise=None, h_denoise=None):
        # frame: [B, 480] raw PCM
        # Returns denoised frame with same shape
        return frame  # Stub — replace with real RNNoise forward


def export(output_path: str):
    print("Initializing RNNoise model...")
    model = RNNoiseModel()
    model.eval()

    dummy = torch.zeros(1, 480)  # Single 10ms frame

    print(f"Exporting RNNoise ONNX to {output_path}...")
    torch.onnx.export(
        model,
        dummy,
        output_path,
        input_names=['frame'],
        output_names=['denoised'],
        dynamic_axes={},  # Fixed shape — no dynamic axes needed
        opset_version=17,
        do_constant_folding=True,
    )
    print(f"✅ Done: {output_path}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='public/app/models/rnnoise_suppressor.onnx')
    args = parser.parse_args()
    export(args.output)

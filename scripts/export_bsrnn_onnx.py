#!/usr/bin/env python3
"""
Export a Band-Split RNN vocals model to ONNX.
Compatible with onnxruntime-web WebGPU EP.

Usage:
    pip install torch onnx onnxruntime
    python scripts/export_bsrnn_onnx.py --output public/app/models/bsrnn_vocals.onnx

Note: You need a pretrained BSRNN checkpoint. Obtain from:
  https://github.com/amanteur/BandSplitRNN-Pytorch
"""

import argparse
import torch
import torch.nn as nn


class BSRNNStub(nn.Module):
    """Minimal BSRNN-compatible stub for ONNX export shape validation.
    Replace with the real BSRNN model class loaded from a checkpoint.
    """
    def __init__(self, sr=44100, n_fft=2048, bands=64, hidden=128, layers=6):
        super().__init__()
        self.n_fft = n_fft
        # Band-split MLP
        self.band_split = nn.Linear(4, hidden)
        # RNN stack
        self.rnn = nn.LSTM(hidden, hidden, num_layers=layers, batch_first=True, bidirectional=True)
        # Mask estimation
        self.mask_net = nn.Linear(hidden * 2, 2)  # 2 = complex mask (re, im)

    def forward(self, x):
        # x: [B, 2, T] stereo time-domain
        return x  # Identity stub — replace with real BSRNN forward pass


def export(output_path: str):
    print("Initializing BSRNN model...")
    # TODO: Replace BSRNNStub with real model loaded from checkpoint:
    # from bsrnn import BSRNN
    # model = BSRNN.from_pretrained('path/to/checkpoint.pt')
    model = BSRNNStub()
    model.eval()

    dummy = torch.zeros(1, 2, 44100 * 5)  # 5s stereo at 44.1kHz

    print(f"Exporting BSRNN ONNX to {output_path}...")
    torch.onnx.export(
        model,
        dummy,
        output_path,
        input_names=['audio'],
        output_names=['vocals'],
        dynamic_axes={'audio': {2: 'samples'}, 'vocals': {2: 'samples'}},
        opset_version=17,
        do_constant_folding=True,
    )
    print(f"✅ Done: {output_path}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='public/app/models/bsrnn_vocals.onnx')
    args = parser.parse_args()
    export(args.output)

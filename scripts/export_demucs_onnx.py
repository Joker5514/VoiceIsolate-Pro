#!/usr/bin/env python3
"""
export_demucs_onnx.py -- VoiceIsolate Pro . Threads from Space v8

Exports Demucs v4 (htdemucs) to demucs_v4_quantized.onnx for onnxruntime-web.
Produces a vocal ratio-mask tensor [1, 1, T] matching ml-worker.js I/O exactly:

    const demucsIn  = new ort.Tensor('float32', pcmChunk, [1, 1, pcmChunk.length]);
    const result    = await demucsSess.run({ input: demucsIn });
    const vocalMask = result.vocal_mask?.data || result.output?.data;

Critical export blocker and fix
--------------------------------
HDemucs.forward() calls torch.stft() internally on complex tensors.
  - opset <=17  ->  SymbolicValueError  (complex ops not representable)
  - opset 20    ->  traces but OOMs during graph serialisation for large models

Fix: monkey-patch torch.stft with a pure real-valued cosine/sine matmul
decomposition BEFORE tracing. The patch is mathematically equivalent
(DFT identity) and produces only standard float32 matmul + trig nodes that
onnxruntime-web WebGPU/WASM both support natively at opset 17.

Requirements
------------
    pip install -r scripts/requirements_export.txt

Usage
-----
    python scripts/export_demucs_onnx.py [--out-dir OUT_DIR] [--trace-secs N]

Outputs
-------
    demucs_v4_fp32.onnx          -- intermediate full-precision graph
    demucs_v4_quantized.onnx     -- INT8 dynamic-quantized (target for Vercel Blob)

After export, run in order
--------------------------
    1. npx vercel blob put demucs_v4_quantized.onnx --content-type application/octet-stream
    2. Paste Blob URL into vercel.json rewrite for /app/models/demucs_v4_quantized.onnx
    3. Update models-manifest.json  ->  demucs_v4.sha256  +  status="vercel_blob"
    4. Update ml-worker.js          ->  MODEL_SHA256['demucs_v4_quantized.onnx']
    5. git rm public/app/models/demucs_v4_quantized.onnx.placeholder
"""

import argparse
import hashlib
import os
import sys
import numpy as np

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
parser = argparse.ArgumentParser(
    description='Export Demucs v4 -> ONNX for onnxruntime-web'
)
parser.add_argument('--out-dir',     default='.',    help='Directory to write .onnx files (default: cwd)')
parser.add_argument('--trace-secs',  type=int, default=5,     help='PCM length in seconds for jit.trace (default: 5)')
parser.add_argument('--sample-rate', type=int, default=44100, help='Sample rate expected by Demucs (default: 44100)')
args = parser.parse_args()

OUT_DIR     = args.out_dir
TRACE_SECS  = args.trace_secs
SAMPLE_RATE = args.sample_rate
OUT_FP32    = os.path.join(OUT_DIR, 'demucs_v4_fp32.onnx')
OUT_INT8    = os.path.join(OUT_DIR, 'demucs_v4_quantized.onnx')

os.makedirs(OUT_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# [0/8] Imports
# ---------------------------------------------------------------------------
print('[0/8] Importing torch, demucs, onnx, onnxruntime...')
try:
    import torch
    import torch.nn as nn
except ImportError:
    sys.exit('ERROR: torch not installed.  Run: pip install torch torchaudio')

try:
    from demucs.pretrained import get_model
except ImportError:
    sys.exit('ERROR: demucs not installed.  Run: pip install demucs>=4.0.0')

try:
    import onnx
except ImportError:
    sys.exit('ERROR: onnx not installed.  Run: pip install onnx')

try:
    import onnxruntime
    from onnxruntime.quantization import quantize_dynamic, QuantType
except ImportError:
    sys.exit('ERROR: onnxruntime not installed.  Run: pip install onnxruntime')

# ---------------------------------------------------------------------------
# [1/8] Load pretrained HDemucs v4
# ---------------------------------------------------------------------------
print('[1/8] Loading htdemucs pretrained weights (first run downloads ~300 MB)...')
demucs = get_model('htdemucs')
demucs.eval()
print(f'      Loaded: {type(demucs).__name__}')

# ---------------------------------------------------------------------------
# [2/8] Thin vocal-mask wrapper
#
# ml-worker.js feeds [1, 1, T] mono PCM and reads result.output.data as a
# per-sample gain mask in [0, 1].  This wrapper:
#   a) stereo-izes the mono input  (HDemucs requires 2 channels)
#   b) extracts the vocals stem    (index 3: drums/bass/other/VOCALS)
#   c) collapses to mono and computes a ratio mask vs the input mix
# ---------------------------------------------------------------------------
class DemucsVocalMaskWrapper(nn.Module):
    """Wraps HDemucs to output a mono vocal ratio-mask [1, 1, T]."""

    # htdemucs stem order (demucs/htdemucs.py  SOURCES constant)
    VOCAL_STEM_IDX = 3  # 0=drums  1=bass  2=other  3=vocals

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, x):
        # x: [1, 1, T]  mono float32 PCM at 44100 Hz

        # a) stereo-ize
        x_stereo = x.expand(1, 2, -1)                           # [1, 2, T]

        # b) Demucs inference  ->  [batch, n_stems=4, channels=2, T]
        with torch.no_grad():
            stems = self.model(x_stereo)

        vocals_stereo = stems[:, self.VOCAL_STEM_IDX]           # [1, 2, T]
        vocals_mono   = vocals_stereo.mean(dim=1, keepdim=True) # [1, 1, T]

        # c) ratio mask  (safe for ml-worker mask multiplication)
        eps  = 1e-8
        mask = vocals_mono.abs() / (x.abs() + eps)              # [1, 1, T]
        mask = torch.clamp(mask, 0.0, 1.0)
        return mask   # ONNX output name -> 'output'

wrapper = DemucsVocalMaskWrapper(demucs)
wrapper.eval()
print('[2/8] DemucsVocalMaskWrapper built')

# ---------------------------------------------------------------------------
# [3/8] Monkey-patch torch.stft -> real-valued DFT
#
# MUST happen BEFORE jit.trace so the tracer captures the patched version.
# The DFT identity X[k] = sum_n x[n]*(cos - j*sin) is implemented as two
# float32 matmuls, producing only standard ONNX opset-17 nodes.
# ---------------------------------------------------------------------------
_orig_torch_stft = torch.stft

def _real_valued_stft(
    input,
    n_fft,
    hop_length=None,
    win_length=None,
    window=None,
    center=True,
    pad_mode='reflect',
    normalized=False,
    onesided=True,
    return_complex=False,
):
    """
    Real-valued STFT -- ONNX opset 17 compatible.

    Replaces torch.stft's complex output with a float32 stack:
        [..., freq_bins, time_frames, 2]   dim-1 = [real, imag]
    Mathematically identical to the standard DFT via the cosine/sine identity.
    """
    hop  = hop_length or (n_fft // 4)
    wl   = win_length or n_fft
    freq = (n_fft // 2 + 1) if onesided else n_fft

    # Centre-pad
    if center:
        pad = n_fft // 2
        input = torch.nn.functional.pad(input, (pad, pad), mode=pad_mode)

    # Overlapping frames  [..., T_frames, n_fft]
    frames = input.unfold(-1, n_fft, hop)

    # Analysis window
    if window is not None:
        w = window.to(dtype=frames.dtype, device=frames.device)
        if wl < n_fft:
            pad_l = (n_fft - wl) // 2
            w = torch.nn.functional.pad(w, (pad_l, n_fft - wl - pad_l))
        frames = frames * w

    # DFT basis  [freq, n_fft]  -- constant; folded to ONNX initializers
    k     = torch.arange(freq,  dtype=frames.dtype, device=frames.device)
    n     = torch.arange(n_fft, dtype=frames.dtype, device=frames.device)
    phase = 2.0 * np.pi * k.unsqueeze(1) * n.unsqueeze(0) / n_fft
    cos_mat = torch.cos(phase)    # [freq, n_fft]
    sin_mat = torch.sin(phase)    # [freq, n_fft]

    # frames [..., T, n_fft] @ basis.T  ->  [..., T, freq]
    real_part = torch.matmul(frames,  cos_mat.transpose(0, 1))
    imag_part = torch.matmul(frames, -sin_mat.transpose(0, 1))

    if normalized:
        scale     = n_fft ** 0.5
        real_part = real_part / scale
        imag_part = imag_part / scale

    # Permute to [..., freq, T] then stack -> [..., freq, T, 2]
    real_part = real_part.transpose(-2, -1)
    imag_part = imag_part.transpose(-2, -1)
    return torch.stack([real_part, imag_part], dim=-1)

torch.stft = _real_valued_stft
print('[3/8] torch.stft patched to real-valued DFT (opset-17 compatible)')

try:
    import torchaudio.functional as _taf
    _taf.spectrogram = lambda *a, **kw: _real_valued_stft(*a, **kw)
    print('[3/8] torchaudio.functional.spectrogram patched')
except Exception as _e:
    print(f'[3/8] torchaudio patch skipped ({_e})')

# ---------------------------------------------------------------------------
# [4/8] JIT trace
# ---------------------------------------------------------------------------
T     = SAMPLE_RATE * TRACE_SECS
dummy = torch.zeros(1, 1, T, dtype=torch.float32)
print(f'[4/8] torch.jit.trace with input [1, 1, {T}] ({TRACE_SECS}s @ {SAMPLE_RATE} Hz)...')
try:
    traced = torch.jit.trace(wrapper, dummy, strict=False)
    print('[4/8] jit.trace succeeded')
except Exception as e:
    print(f'[4/8] jit.trace failed ({e}) -- falling back to eager export')
    traced = wrapper

# Pre-export sanity check
with torch.no_grad():
    test_out = traced(dummy)
assert test_out.shape == (1, 1, T), \
    f'Shape mismatch: expected (1,1,{T}), got {test_out.shape}'
assert float(test_out.min()) >= 0.0, \
    f'Mask has negative values: min={float(test_out.min())}'
assert float(test_out.max()) <= 1.0 + 1e-5, \
    f'Mask exceeds 1.0: max={float(test_out.max())}'
print(f'[4/8] Wrapper output verified: shape={list(test_out.shape)}  '
      f'min={float(test_out.min()):.4f}  max={float(test_out.max()):.4f}')

# ---------------------------------------------------------------------------
# [5/8] ONNX export -- opset 17, dynamic time axis
# ---------------------------------------------------------------------------
print(f'[5/8] Exporting to {OUT_FP32} (opset 17, dynamic time axis)...')
torch.onnx.export(
    traced,
    dummy,
    OUT_FP32,
    opset_version=17,
    input_names=['input'],
    output_names=['output'],
    dynamic_axes={
        'input':  {0: 'batch', 2: 'time'},
        'output': {0: 'batch', 2: 'time'},
    },
    do_constant_folding=True,
    export_params=True,
    verbose=False,
)
fp32_mb = os.path.getsize(OUT_FP32) / 1e6
print(f'[5/8] FP32 export complete: {fp32_mb:.1f} MB  ->  {OUT_FP32}')

# ---------------------------------------------------------------------------
# [6/8] ONNX graph validation + optional onnxsim simplification
# ---------------------------------------------------------------------------
print('[6/8] Validating ONNX graph...')
model_proto = onnx.load(OUT_FP32)
onnx.checker.check_model(model_proto)
print('[6/8] onnx.checker.check_model passed')

try:
    from onnxsim import simplify as _simplify
    simplified, ok = _simplify(model_proto)
    if ok:
        onnx.save(simplified, OUT_FP32)
        print('[6/8] onnxsim: graph simplified and saved')
    else:
        print('[6/8] onnxsim: could not simplify -- using original graph')
except ImportError:
    print('[6/8] onnxsim not installed -- skipping  (pip install onnxsim)')

# ---------------------------------------------------------------------------
# [7/8] INT8 dynamic quantization
# ---------------------------------------------------------------------------
print(f'[7/8] INT8 dynamic quantization  ->  {OUT_INT8}...')
quantize_dynamic(
    OUT_FP32,
    OUT_INT8,
    weight_type=QuantType.QInt8,
    optimize_model=True,
)
int8_mb = os.path.getsize(OUT_INT8) / 1e6
print(f'[7/8] INT8 file size: {int8_mb:.1f} MB')
if int8_mb > 100:
    print('      NOTE: Exceeds 100 MB Git limit -- Vercel Blob upload required (expected)')
else:
    print('      OK: Under 100 MB')

# ---------------------------------------------------------------------------
# [8/8] Smoke test with onnxruntime CPU
# ---------------------------------------------------------------------------
print('[8/8] Smoke test with onnxruntime CPUExecutionProvider...')
sess       = onnxruntime.InferenceSession(OUT_INT8, providers=['CPUExecutionProvider'])
test_input = np.zeros((1, 1, SAMPLE_RATE * 3), dtype=np.float32)
outputs    = sess.run(None, {'input': test_input})
out        = outputs[0]
expected_T = SAMPLE_RATE * 3

assert out.shape == (1, 1, expected_T), \
    f'[FAIL] shape {out.shape} != (1, 1, {expected_T})'
assert out.min() >= 0.0,         f'[FAIL] min={out.min()} < 0'
assert out.max() <= 1.0 + 1e-4, f'[FAIL] max={out.max()} > 1'
print(f'[8/8] Smoke test PASSED  shape={list(out.shape)}  '
      f'min={out.min():.4f}  max={out.max():.4f}')

# ---------------------------------------------------------------------------
# SHA-256 + post-export copy-paste instructions
# ---------------------------------------------------------------------------
with open(OUT_INT8, 'rb') as _f:
    sha256 = hashlib.sha256(_f.read()).hexdigest()

print()
print('=' * 70)
print(f'  OUTPUT : {OUT_INT8}')
print(f'  SIZE   : {int8_mb:.1f} MB')
print(f'  SHA256 : {sha256}')
print('=' * 70)
print()
print('NEXT STEPS -- run in order:')
print()
print('  1. Upload to Vercel Blob:')
print(f'       npx vercel blob put {OUT_INT8} --content-type application/octet-stream')
print()
print('  2. Add rewrite in vercel.json:')
print('       { "source": "/app/models/demucs_v4_quantized.onnx",')
print('         "destination": "<BLOB_URL_FROM_STEP_1>" }')
print()
print('  3. Update public/app/models/models-manifest.json:')
print(f'       demucs_v4.sha256  ->  "{sha256}"')
print('       demucs_v4.status   ->  "vercel_blob"')
print()
print('  4. Update public/app/ml-worker.js  MODEL_SHA256:')
print(f'       \'demucs_v4_quantized.onnx\': \'{sha256}\',')
print()
print('  5. Remove placeholder:')
print('       git rm public/app/models/demucs_v4_quantized.onnx.placeholder')
print('       git commit -m "chore(models): remove demucs placeholder -- real model on Vercel Blob"')
print()
print('  6. Verify in browser:')
print('       DevTools -> Application -> Cache Storage -> vip-models-v1')
print('       Confirm demucs_v4_quantized.onnx cached after first page load')
print('       Console: "[ml-worker] demucs loaded via webgpu (same-origin)"')

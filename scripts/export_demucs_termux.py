#!/usr/bin/env python3
"""
export_demucs_termux.py -- VoiceIsolate Pro . Termux / Android variant

Designed to run on Android via Termux with no GPU and limited RAM (~4-8 GB).
Uses htdemucs_ft_vocals (vocals-only fine-tune, ~80 MB weights) instead of
the full htdemucs model to avoid OOM during jit.trace.

Setup (Termux, one-time)
------------------------
    pkg update && pkg upgrade -y
    pkg install python rust cmake ninja clang libopenblas -y
    pip install --upgrade pip wheel setuptools
    pip install -r scripts/requirements_export_termux.txt

Usage
-----
    python scripts/export_demucs_termux.py [--out-dir OUT_DIR]

Outputs
-------
    demucs_v4_fp32.onnx          -- intermediate full-precision graph
    demucs_v4_quantized.onnx     -- INT8 dynamic-quantized target for Vercel Blob

RAM budget (typical Android, 6 GB device)
-----------------------------------------
    Model load      ~350 MB
    jit.trace 2s    ~600 MB peak
    ONNX export     ~400 MB
    INT8 quant      ~200 MB
    Total peak      ~1.5 GB  -- safe on 4 GB+ devices

After export
------------
    See printed NEXT STEPS for vercel.json, models-manifest.json,
    ml-worker.js MODEL_SHA256, and git rm placeholder instructions.
"""

import argparse
import gc
import hashlib
import os
import sys
import psutil

def _ram_mb():
    return psutil.Process().memory_info().rss / 1e6

def _avail_mb():
    return psutil.virtual_memory().available / 1e6

def _ram_guard(stage, threshold_mb=500):
    avail = _avail_mb()
    print(f'[RAM] {stage}: process={_ram_mb():.0f} MB  available={avail:.0f} MB')
    if avail < threshold_mb:
        gc.collect()
        avail = _avail_mb()
        if avail < threshold_mb:
            sys.exit(
                f'ERROR: Less than {threshold_mb} MB RAM available before {stage}.\n'
                f'Close other apps and retry, or use --trace-secs 1 to reduce peak usage.'
            )

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
parser = argparse.ArgumentParser(
    description='Export Demucs v4 -> ONNX (Termux/Android, CPU-only)'
)
parser.add_argument('--out-dir',     default='.',  help='Output directory (default: cwd)')
parser.add_argument('--trace-secs',  type=int, default=2,
    help='PCM seconds for jit.trace. Lower = less RAM. Min 1. (default: 2)')
parser.add_argument('--sample-rate', type=int, default=44100,
    help='Sample rate expected by Demucs (default: 44100)')
parser.add_argument('--model',       default='htdemucs_ft_vocals',
    help='Demucs checkpoint name (default: htdemucs_ft_vocals)')
args = parser.parse_args()

OUT_DIR     = args.out_dir
TRACE_SECS  = max(1, args.trace_secs)
SAMPLE_RATE = args.sample_rate
MODEL_NAME  = args.model
OUT_FP32    = os.path.join(OUT_DIR, 'demucs_v4_fp32.onnx')
OUT_INT8    = os.path.join(OUT_DIR, 'demucs_v4_quantized.onnx')

os.makedirs(OUT_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# [0/8] Imports
# ---------------------------------------------------------------------------
print('[0/8] Importing dependencies...')
try:
    import numpy as np
except ImportError:
    sys.exit('ERROR: numpy not installed.  Run: pip install numpy')

try:
    import torch
    import torch.nn as nn
    # Force CPU -- no CUDA on Android
    torch.set_num_threads(4)  # cap threads to avoid thermal throttle
except ImportError:
    sys.exit('ERROR: torch not installed.  Run: pip install torch')

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

try:
    import psutil
except ImportError:
    sys.exit('ERROR: psutil not installed.  Run: pip install psutil')

print(f'[0/8] torch={torch.__version__}  onnx={onnx.__version__}  '
      f'ort={onnxruntime.__version__}')
print(f'[0/8] Available RAM: {_avail_mb():.0f} MB')

_ram_guard('model load', threshold_mb=800)

# ---------------------------------------------------------------------------
# [1/8] Load model
# ---------------------------------------------------------------------------
print(f'[1/8] Loading {MODEL_NAME} pretrained weights...')
print('      (First run downloads the checkpoint -- needs ~100-300 MB data)')
demucs = get_model(MODEL_NAME)
demucs.eval()
# Move to CPU explicitly and free any intermediate tensors
demucs = demucs.cpu()
gc.collect()
print(f'[1/8] Loaded: {type(demucs).__name__}')
print(f'[1/8] RAM after load: {_ram_mb():.0f} MB')

# Detect vocal stem index dynamically -- different checkpoints vary
if hasattr(demucs, 'sources'):
    sources = list(demucs.sources)
elif hasattr(demucs, 'source_names'):
    sources = list(demucs.source_names)
else:
    sources = ['drums', 'bass', 'other', 'vocals']  # htdemucs default

if 'vocals' in sources:
    VOCAL_IDX = sources.index('vocals')
else:
    VOCAL_IDX = len(sources) - 1  # last stem as fallback
    print(f'[1/8] WARNING: "vocals" not found in {sources}, using index {VOCAL_IDX}')

print(f'[1/8] Stems: {sources}  ->  vocal index = {VOCAL_IDX}')

# ---------------------------------------------------------------------------
# [2/8] Vocal mask wrapper
# ---------------------------------------------------------------------------
class DemucsVocalMaskWrapper(nn.Module):
    """Produces mono vocal ratio-mask [1, 1, T] from mono PCM [1, 1, T]."""

    def __init__(self, model, vocal_idx):
        super().__init__()
        self.model     = model
        self.vocal_idx = vocal_idx

    def forward(self, x):
        # x: [1, 1, T]  mono float32 PCM
        x_stereo      = x.expand(1, 2, -1)                           # [1, 2, T]
        with torch.no_grad():
            stems     = self.model(x_stereo)                         # [1, N, 2, T]
        vocals_stereo = stems[:, self.vocal_idx]                     # [1, 2, T]
        vocals_mono   = vocals_stereo.mean(dim=1, keepdim=True)      # [1, 1, T]
        eps  = 1e-8
        mask = vocals_mono.abs() / (x.abs() + eps)
        return torch.clamp(mask, 0.0, 1.0)                           # [1, 1, T]

wrapper = DemucsVocalMaskWrapper(demucs, VOCAL_IDX)
wrapper.eval()
print('[2/8] DemucsVocalMaskWrapper ready')

# ---------------------------------------------------------------------------
# [3/8] Monkey-patch torch.stft -> real-valued DFT (opset-17 fix)
# ---------------------------------------------------------------------------
_orig_stft = torch.stft

def _real_valued_stft(
    input, n_fft, hop_length=None, win_length=None, window=None,
    center=True, pad_mode='reflect', normalized=False,
    onesided=True, return_complex=False,
):
    hop  = hop_length or (n_fft // 4)
    wl   = win_length or n_fft
    freq = (n_fft // 2 + 1) if onesided else n_fft

    if center:
        input = torch.nn.functional.pad(input, (n_fft // 2, n_fft // 2), mode=pad_mode)

    frames = input.unfold(-1, n_fft, hop)   # [..., T_frames, n_fft]

    if window is not None:
        w = window.to(dtype=frames.dtype, device=frames.device)
        if wl < n_fft:
            pad_l = (n_fft - wl) // 2
            w = torch.nn.functional.pad(w, (pad_l, n_fft - wl - pad_l))
        frames = frames * w

    k     = torch.arange(freq,  dtype=frames.dtype, device=frames.device)
    n     = torch.arange(n_fft, dtype=frames.dtype, device=frames.device)
    phase = 2.0 * np.pi * k.unsqueeze(1) * n.unsqueeze(0) / n_fft
    cos_m = torch.cos(phase)
    sin_m = torch.sin(phase)

    real  = torch.matmul(frames,  cos_m.transpose(0, 1)).transpose(-2, -1)
    imag  = torch.matmul(frames, -sin_m.transpose(0, 1)).transpose(-2, -1)

    if normalized:
        real, imag = real / (n_fft**0.5), imag / (n_fft**0.5)

    return torch.stack([real, imag], dim=-1)   # [..., freq, T, 2]

torch.stft = _real_valued_stft
print('[3/8] torch.stft patched (real-valued DFT, opset-17 compatible)')

try:
    import torchaudio.functional as _taf
    _taf.spectrogram = lambda *a, **kw: _real_valued_stft(*a, **kw)
    print('[3/8] torchaudio.functional.spectrogram patched')
except Exception as _e:
    print(f'[3/8] torchaudio patch skipped ({_e})')

# ---------------------------------------------------------------------------
# [4/8] JIT trace  (short clip to conserve RAM on Termux)
# ---------------------------------------------------------------------------
T     = SAMPLE_RATE * TRACE_SECS
dummy = torch.zeros(1, 1, T, dtype=torch.float32)
_ram_guard('jit.trace', threshold_mb=600)
print(f'[4/8] torch.jit.trace  input=[1,1,{T}]  ({TRACE_SECS}s @ {SAMPLE_RATE} Hz)...')
try:
    traced = torch.jit.trace(wrapper, dummy, strict=False)
    print('[4/8] jit.trace succeeded')
except Exception as e:
    print(f'[4/8] jit.trace failed ({e}) -- using eager module')
    traced = wrapper

gc.collect()

# Shape + value-range check
with torch.no_grad():
    test_out = traced(dummy)
assert test_out.shape == (1, 1, T), \
    f'Shape mismatch: expected (1,1,{T}), got {test_out.shape}'
assert float(test_out.min()) >= 0.0,       'Mask has negative values'
assert float(test_out.max()) <= 1.0 + 1e-5,'Mask exceeds 1.0'
print(f'[4/8] Output verified: shape={list(test_out.shape)}  '
      f'min={float(test_out.min()):.4f}  max={float(test_out.max()):.4f}')
del test_out; gc.collect()

# ---------------------------------------------------------------------------
# [5/8] ONNX export
# ---------------------------------------------------------------------------
_ram_guard('ONNX export', threshold_mb=400)
print(f'[5/8] Exporting to {OUT_FP32} (opset 17)...')
torch.onnx.export(
    traced, dummy, OUT_FP32,
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
del traced, dummy, wrapper, demucs; gc.collect()
fp32_mb = os.path.getsize(OUT_FP32) / 1e6
print(f'[5/8] FP32 export: {fp32_mb:.1f} MB')

# ---------------------------------------------------------------------------
# [6/8] Graph validation + optional onnxsim
# ---------------------------------------------------------------------------
print('[6/8] Validating ONNX graph...')
model_proto = onnx.load(OUT_FP32)
onnx.checker.check_model(model_proto)
print('[6/8] Graph check passed')

try:
    from onnxsim import simplify as _sim
    simplified, ok = _sim(model_proto)
    if ok:
        onnx.save(simplified, OUT_FP32)
        print('[6/8] onnxsim: simplified')
    else:
        print('[6/8] onnxsim: could not simplify')
except ImportError:
    print('[6/8] onnxsim not installed -- skipping (pip install onnxsim)')
del model_proto; gc.collect()

# ---------------------------------------------------------------------------
# [7/8] INT8 quantization
# ---------------------------------------------------------------------------
_ram_guard('INT8 quantization', threshold_mb=200)
print(f'[7/8] Quantizing to INT8  ->  {OUT_INT8}...')
quantize_dynamic(OUT_FP32, OUT_INT8, weight_type=QuantType.QInt8, optimize_model=True)
int8_mb = os.path.getsize(OUT_INT8) / 1e6
print(f'[7/8] INT8 size: {int8_mb:.1f} MB')
if int8_mb > 100:
    print('      Exceeds 100 MB Git limit -- Vercel Blob required (expected)')

# ---------------------------------------------------------------------------
# [8/8] Smoke test
# ---------------------------------------------------------------------------
print('[8/8] Smoke test...')
sess  = onnxruntime.InferenceSession(OUT_INT8, providers=['CPUExecutionProvider'])
tin   = np.zeros((1, 1, SAMPLE_RATE * 2), dtype=np.float32)   # 2s test (less RAM)
out   = sess.run(None, {'input': tin})[0]
expT  = SAMPLE_RATE * 2
assert out.shape == (1, 1, expT), f'[FAIL] shape {out.shape}'
assert out.min() >= 0.0,          f'[FAIL] min={out.min()}'
assert out.max() <= 1.0 + 1e-4,   f'[FAIL] max={out.max()}'
print(f'[8/8] PASSED  shape={list(out.shape)}  min={out.min():.4f}  max={out.max():.4f}')

# ---------------------------------------------------------------------------
# SHA-256 + instructions
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
print('NEXT STEPS:')
print()
print('  1. Copy file off Termux (optional -- run blob upload from Termux directly):')
print('       # If you have Vercel CLI in Termux:')
print(f'       npx vercel blob put {OUT_INT8} --content-type application/octet-stream')
print()
print('       # Or transfer to PC first:')
print(f'       scp {OUT_INT8} user@yourpc:~/VoiceIsolate-Pro/public/app/models/')
print()
print('  2. Add rewrite to vercel.json:')
print('       { "source": "/app/models/demucs_v4_quantized.onnx",')
print('         "destination": "<BLOB_URL>" }')
print()
print('  3. models-manifest.json:')
print(f'       demucs_v4.sha256  ->  "{sha256}"')
print('       demucs_v4.status   ->  "vercel_blob"')
print()
print('  4. ml-worker.js MODEL_SHA256:')
print(f'       \'demucs_v4_quantized.onnx\': \'{sha256}\',')
print()
print('  5. git rm public/app/models/demucs_v4_quantized.onnx.placeholder')
print()
print(f'[DONE]  RAM at exit: {_ram_mb():.0f} MB')

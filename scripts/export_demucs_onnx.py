#!/usr/bin/env python3
"""
export_demucs_onnx.py -- VoiceIsolate Pro
Exports Demucs v4 htdemucs_ft (vocals sub-model) to demucs_v4_quantized.onnx.

Strategy
--------
HTDemucs uses complex tensors internally (spectro/ispectro, view_as_real/complex).
ONNX opset 17 cannot represent aten::view_as_complex.  We monkey-patch the entire
complex-arithmetic boundary with real-valued equivalents:
  - spectro()     -> real [*, freq, T, 2]
  - _spec()       -> real [B, C, freq, T, 2]
  - _magnitude()  -> real [B, C*2, freq, T]   (cac=True path)
  - _mask()       -> real [B, S, C//2, freq, T, 2]
  - _ispec()      -> time domain via real iSTFT
  - pad1d()       -> remove data-dependent assertions

Requirements
------------
    pip install torch torchaudio demucs>=4.0.0 onnx>=1.15.0 onnxruntime>=1.17.0 psutil numpy

Usage
-----
    python scripts/export_demucs_onnx.py [--out-dir OUT_DIR]

Outputs
-------
    demucs_v4_fp32.onnx          intermediate full-precision graph
    demucs_v4_quantized.onnx     INT8 dynamic-quantized (target for browser)
"""

import argparse
import hashlib
import math
import os
import sys
import types

import numpy as np

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
parser = argparse.ArgumentParser(description='Export Demucs v4 -> ONNX for onnxruntime-web')
parser.add_argument('--out-dir', default='.', help='Directory to write .onnx files')
args = parser.parse_args()

OUT_DIR  = args.out_dir
OUT_FP32 = os.path.join(OUT_DIR, 'demucs_v4_fp32.onnx')
OUT_INT8 = os.path.join(OUT_DIR, 'demucs_v4_quantized.onnx')
os.makedirs(OUT_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# [0/8] Imports
# ---------------------------------------------------------------------------
print('[0/8] Importing dependencies...')
try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except ImportError:
    sys.exit('ERROR: torch not installed. Run: pip install torch torchaudio')

try:
    from demucs.pretrained import get_model
    import demucs.hdemucs as _hdemucs_mod
    import demucs.spec as _spec_mod
except ImportError:
    sys.exit('ERROR: demucs not installed. Run: pip install demucs>=4.0.0')

try:
    import onnx
except ImportError:
    sys.exit('ERROR: onnx not installed. Run: pip install onnx')

try:
    import onnxruntime
    from onnxruntime.quantization import quantize_dynamic, QuantType
except ImportError:
    sys.exit('ERROR: onnxruntime not installed. Run: pip install onnxruntime')

print(f'      torch={torch.__version__}')

# ---------------------------------------------------------------------------
# [1/8] Load htdemucs_ft vocals sub-model
# ---------------------------------------------------------------------------
print('[1/8] Loading htdemucs_ft pretrained weights...')
bag = get_model('htdemucs_ft')
bag.eval()
print(f'      Bag: {type(bag).__name__} with {len(bag.models)} sub-models')

demucs = bag.models[3]   # weights[3]=[0,0,0,1] → vocals fine-tuned
demucs.eval()
print(f'      Sub-model[3]: {type(demucs).__name__}')

sources = list(demucs.sources) if hasattr(demucs, 'sources') else ['drums','bass','other','vocals']
vocal_idx = sources.index('vocals') if 'vocals' in sources else len(sources) - 1
print(f'      Sources: {sources}  vocal_idx={vocal_idx}')

assert demucs.cac, 'Patch assumes cac=True; found cac=False'

# Training segment length — use exact match to avoid data-dependent branching
SAMPLE_RATE     = int(demucs.samplerate)
TRAIN_LEN       = int(demucs.segment * SAMPLE_RATE)   # typically 344520
HOP             = demucs.hop_length                     # 512
NFFT            = demucs.nfft                           # 4096
WIN_LENGTH      = NFFT                                  # htdemucs uses nfft == win_length
print(f'      sr={SAMPLE_RATE}  training_len={TRAIN_LEN}  nfft={NFFT}  hop={HOP}')

# Disable train-segment padding to avoid data-dependent control flow
demucs.use_train_segment = False

# ---------------------------------------------------------------------------
# [2/8] Real-valued STFT and iSTFT helpers (ONNX-safe)
# ---------------------------------------------------------------------------
print('[2/8] Building real-valued STFT/iSTFT helpers...')

class _RealSTFT(nn.Module):
    """Real-valued forward STFT via conv1d filter bank. Returns [N, freq, T, 2].

    Using conv1d (not unfold) so the ONNX legacy exporter never sees a dynamic
    input size — conv1d with a fixed kernel and stride is always ONNX-safe.
    """

    def __init__(self, n_fft, hop, win_length, normalized):
        super().__init__()
        self.n_fft      = n_fft
        self.hop        = hop
        self.normalized = normalized
        self.pad        = n_fft // 2       # centre-padding amount (constant)
        freq = n_fft // 2 + 1
        k  = torch.arange(freq, dtype=torch.float32)
        nn = torch.arange(n_fft, dtype=torch.float32)
        phase = 2.0 * math.pi * k.unsqueeze(1) * nn.unsqueeze(0) / n_fft
        win = torch.hann_window(win_length)
        if win_length < n_fft:
            pl  = (n_fft - win_length) // 2
            win = F.pad(win, (pl, n_fft - win_length - pl))
        # Pre-bake window into filter weights → [freq, 1, n_fft]
        cos_filt = (torch.cos(phase) * win.unsqueeze(0)).unsqueeze(1)
        sin_filt = (torch.sin(phase) * win.unsqueeze(0)).unsqueeze(1)
        self.register_buffer('cos_filt', cos_filt)   # [freq, 1, n_fft]
        self.register_buffer('sin_filt', sin_filt)   # [freq, 1, n_fft]

    def forward(self, x, pad_fft):
        # x: [N, T]   pad_fft ignored — always uses self.n_fft (pad=0 path)
        # Reflect-pad then conv1d with zero-padding=0 (padding already in signal)
        xp = F.pad(x.unsqueeze(1), (self.pad, self.pad), mode='reflect')  # [N,1,T+2p]
        real = F.conv1d(xp, self.cos_filt, stride=self.hop)               # [N, freq, T']
        imag = F.conv1d(xp, -self.sin_filt, stride=self.hop)
        if self.normalized:
            s    = self.n_fft ** 0.5
            real = real / s
            imag = imag / s
        return torch.stack([real, imag], dim=-1)    # [N, freq, T', 2]


class _RealISTFT(nn.Module):
    """Real-valued inverse STFT. Input [N, freq, T, 2]; output [N, length]."""

    def __init__(self, n_fft, hop, win_length, normalized):
        super().__init__()
        self.n_fft     = n_fft
        self.hop       = hop
        self.normalized = normalized
        freq = n_fft // 2 + 1
        k = torch.arange(freq, dtype=torch.float32)
        n = torch.arange(n_fft, dtype=torch.float32)
        phase = 2.0 * math.pi * k.unsqueeze(1) * n.unsqueeze(0) / n_fft
        cos_m = torch.cos(phase)
        sin_m = torch.sin(phase)
        # One-sided spectrum: double interior bins
        scale = torch.ones(freq, 1, dtype=torch.float32)
        scale[1: freq - 1] = 2.0
        self.register_buffer('cos_m', cos_m * scale)
        self.register_buffer('sin_m', sin_m * scale)
        win = torch.hann_window(win_length)
        if win_length < n_fft:
            pl = (n_fft - win_length) // 2
            win = F.pad(win, (pl, n_fft - win_length - pl))
        self.register_buffer('window', win)
        # Precompute COLA normalizer: sum of window^2 shifted by hop
        n_frames_for_norm = 20
        norm_len = n_fft + (n_frames_for_norm - 1) * hop
        norm = torch.zeros(norm_len)
        for i in range(n_frames_for_norm):
            norm[i * hop: i * hop + n_fft] += win ** 2
        self.register_buffer('cola_norm_sample', norm[n_fft // 2: n_fft // 2 + 1])

    def forward(self, z, out_length):
        # z: [N, freq, T_frames, 2]
        N, freq, T_frames, _ = z.shape
        real = z[..., 0]          # [N, freq, T]
        imag = z[..., 1]
        if self.normalized:
            s = self.n_fft ** 0.5
            real = real * s
            imag = imag * s
        # Inverse DFT per frame
        frames = (torch.matmul(real.permute(0, 2, 1), self.cos_m.to(real)) -
                  torch.matmul(imag.permute(0, 2, 1), self.sin_m.to(imag)))
        frames = frames / self.n_fft    # [N, T_frames, n_fft]
        frames = frames * self.window.to(frames)
        # Overlap-add via conv_transpose1d
        frames = frames.permute(0, 2, 1)    # [N, n_fft, T_frames]
        identity = torch.eye(self.n_fft, device=z.device, dtype=frames.dtype).unsqueeze(1)
        raw = F.conv_transpose1d(frames, identity, stride=self.hop)  # [N, 1, raw_len]
        raw = raw[:, 0, :]                  # [N, raw_len]
        raw = raw / self.cola_norm_sample.to(raw)   # COLA normalise
        offset = self.n_fft // 2
        return raw[..., offset: offset + out_length]


_stft_helper  = _RealSTFT(NFFT, HOP, WIN_LENGTH, normalized=True)
_istft_helper = _RealISTFT(NFFT, HOP, WIN_LENGTH, normalized=True)
_stft_helper.eval()
_istft_helper.eval()
print('      Real STFT/iSTFT helpers ready.')

# ---------------------------------------------------------------------------
# [3/8] Monkey-patch the demucs complex-arithmetic boundary
# ---------------------------------------------------------------------------
print('[3/8] Patching demucs complex-arithmetic boundary...')

# 3a — patch pad1d (remove data-dependent assertions)
def _patched_pad1d(x, paddings, mode='constant', value=0.):
    x0     = x
    length = x.shape[-1]
    padding_left, padding_right = paddings
    if mode == 'reflect':
        max_pad = max(padding_left, padding_right)
        if length <= max_pad:
            extra_pad       = max_pad - length + 1
            extra_pad_right = min(padding_right, extra_pad)
            extra_pad_left  = extra_pad - extra_pad_right
            paddings        = (padding_left - extra_pad_left,
                               padding_right - extra_pad_right)
            x = F.pad(x, (extra_pad_left, extra_pad_right))
    out = F.pad(x, paddings, mode, value)
    return out      # assertions removed

_hdemucs_mod.pad1d = _patched_pad1d

# 3b — patch spectro to return real [*other, freq, T, 2]
def _patched_spectro(x, n_fft=512, hop_length=None, pad=0):
    *other, length = x.shape
    x_flat = x.reshape(-1, length)     # [N, T]
    hop    = hop_length or n_fft // 4
    n_fft_padded = n_fft * (1 + pad)
    z = _stft_helper.to(x_flat.device)(x_flat, n_fft_padded)  # [N, freq, T_frames, 2]
    _, freq, T_frames, two = z.shape
    return z.reshape(*other, freq, T_frames, two)

_spec_mod.spectro = _patched_spectro

# 3c — patch ispectro to accept real [*other, freq, T, 2]
def _patched_ispectro(z, hop_length=None, length=None, pad=0):
    *other, freqs, frames, two = z.shape
    n_fft     = 2 * freqs - 2
    hop       = hop_length or n_fft // 4
    z_flat    = z.reshape(-1, freqs, frames, two)     # [N, freq, T, 2]
    out_len   = length if length is not None else (frames - 1) * hop + n_fft
    x         = _istft_helper.to(z_flat.device)(z_flat, out_len)   # [N, out_len]
    _, actual  = x.shape
    return x.reshape(*other, actual)

_spec_mod.ispectro = _patched_ispectro

# 3d — patch HTDemucs instance methods to work with real [B, C, Fr, T, 2]
_demucs_cls = type(demucs)

def _patched_spec(self, mix):
    """Returns real [B, C, freq-1, le, 2] instead of complex [B, C, freq-1, le]."""
    nfft = self.nfft
    hl   = self.hop_length
    assert hl == nfft // 4
    le   = int(math.ceil(mix.shape[-1] / hl))
    pad  = hl // 2 * 3
    x    = _hdemucs_mod.pad1d(mix, (pad, pad + le * hl - mix.shape[-1]), mode='reflect')
    z    = _spec_mod.spectro(x, nfft, hl)    # real [B, C, freq, T_frames, 2]
    # Original complex code: spectro()[..., :-1, :]
    # On complex [B, C, freq, T]:  ..=B,C  :-1=freq  :=T  → [B, C, freq-1, T]
    # Our 5D real [B, C, freq, T, 2]: must explicitly drop Nyquist (dim 2)
    z = z[:, :, :-1, :, :]       # [B, C, freq-1, T_frames, 2] — drop Nyquist bin
    z = z[:, :, :, 2: 2 + le, :] # [B, C, freq-1, le, 2]       — trim time frames
    return z

def _patched_magnitude(self, z):
    """z: real [B, C, Fr, T, 2] → returns real [B, C*2, Fr, T]."""
    B, C, Fr, T, two = z.shape
    m = z.permute(0, 1, 4, 2, 3)     # [B, C, 2, Fr, T]
    return m.reshape(B, C * 2, Fr, T)

def _patched_mask(self, z, m):
    """
    z: real [B, C, Fr, T, 2]
    m: real [B, S, C_out, Fr, T]  (output of decoder, cac=True mode)
    Returns real [B, S, C//2, Fr, T, 2] (no complex conversion).
    """
    B, S, C, Fr, T = m.shape
    out = m.view(B, S, -1, 2, Fr, T).permute(0, 1, 2, 4, 5, 3)
    return out   # [B, S, C//2, Fr, T, 2]

def _patched_ispec(self, z, length=None, scale=0):
    """z: real [B, S, C//2, Fr, T, 2] → time domain [B, S, C//2, length]."""
    hl = self.hop_length // (4 ** scale)
    # Original _ispec on complex [B, S, C//2, Fr, T]:
    #   F.pad(z, (0,0,0,1)) → pads last dim by (0,0), second-last by (0,1)
    #     = T dim: no change; Fr dim: +1 on right → [B,S,C//2, Fr+1, T]
    #   F.pad(z, (2,2))     → pads last dim by (2,2)
    #     = T dim: +2 each side → [B,S,C//2, Fr+1, T+4]
    #
    # Our real [B, S, C//2, Fr, T, 2] has one extra trailing dim.
    # F.pad pads from the last dimension backward:
    #   To pad Fr dim (+1 right):  F.pad(z, (0,0, 0,0, 0,1))
    #     → last(2): none; T: none; Fr: +1 → [B,S,C//2, Fr+1, T, 2]
    #   To pad T dim (+2 each side):  F.pad(z, (0,0, 2,2))
    #     → last(2): none; T: +2 each side → [B,S,C//2, Fr+1, T+4, 2]
    z = F.pad(z, (0, 0, 0, 0, 0, 1))   # restore Nyquist: [B,S,C//2, Fr+1, T, 2]
    z = F.pad(z, (0, 0, 2, 2))         # pad time:         [B,S,C//2, Fr+1, T+4, 2]
    out = _spec_mod.ispectro(z, hl, length=length)   # [B, S, C//2, out_len]
    return out

# Bind patched methods to the model instance
demucs._spec       = types.MethodType(_patched_spec,       demucs)
demucs._magnitude  = types.MethodType(_patched_magnitude,  demucs)
demucs._mask       = types.MethodType(_patched_mask,       demucs)
demucs._ispec      = types.MethodType(_patched_ispec,      demucs)

# Also patch the module-level references used inside htdemucs
import demucs.htdemucs as _htdemucs_mod
_htdemucs_mod.spectro  = _patched_spectro
_htdemucs_mod.ispectro = _patched_ispectro
_htdemucs_mod.pad1d    = _patched_pad1d

print('      pad1d, spectro, ispectro, _spec, _magnitude, _mask, _ispec patched.')

# ---------------------------------------------------------------------------
# [4/8] Wrapper and JIT trace
# ---------------------------------------------------------------------------
# 3e — patch nn.MultiheadAttention fast path (fused CPU kernel not ONNX-safe)
# The aten::_native_multi_head_attention fused op cannot be exported to ONNX.
# We replace .forward on every nn.MultiheadAttention with a closure that calls
# F.multi_head_attention_forward (the decomposed, ONNX-safe slow path) directly.
_mha_count = 0
for _m in demucs.modules():
    if type(_m) is nn.MultiheadAttention:
        def _make_slow_fwd(mod):
            def _slow_forward(q, k, v,
                              key_padding_mask=None, need_weights=False,
                              attn_mask=None, average_attn_weights=True,
                              is_causal=False):
                # nn.MultiheadAttention.forward transposes when batch_first=True
                # before calling F.multi_head_attention_forward, so we must too.
                if mod.batch_first:
                    q = q.transpose(0, 1)
                    k = k.transpose(0, 1)
                    v = v.transpose(0, 1)
                out, weights = F.multi_head_attention_forward(
                    q, k, v,
                    mod.embed_dim, mod.num_heads,
                    mod.in_proj_weight, mod.in_proj_bias,
                    mod.bias_k, mod.bias_v, mod.add_zero_attn,
                    mod.dropout, mod.out_proj.weight, mod.out_proj.bias,
                    training=False,
                    key_padding_mask=key_padding_mask,
                    need_weights=need_weights,
                    attn_mask=attn_mask,
                    average_attn_weights=average_attn_weights,
                    is_causal=is_causal,
                )
                if mod.batch_first:
                    out = out.transpose(0, 1)
                return out, weights
            return _slow_forward
        _m.forward = _make_slow_fwd(_m)
        _mha_count += 1
print(f'      Patched {_mha_count} nn.MultiheadAttention instances (slow path + batch_first fix).')

# ---------------------------------------------------------------------------
# [4/8] Wrapper + trace
# ---------------------------------------------------------------------------
print('[4/8] Building DemucsVocalMaskWrapper...')

class DemucsVocalMaskWrapper(nn.Module):
    """Input [1, 1, T] mono → output [1, 1, T] vocal ratio mask in [0, 1]."""

    def __init__(self, model, vocal_idx, stft_h, istft_h):
        super().__init__()
        self.model     = model
        self.vocal_idx = vocal_idx
        self.stft_h    = stft_h
        self.istft_h   = istft_h

    def forward(self, x):           # x: [1, 1, T]
        x_stereo      = x.expand(1, 2, -1)
        with torch.no_grad():
            stems      = self.model(x_stereo)          # [1, S, C//2, T]
        vocals         = stems[:, self.vocal_idx]       # [1, C//2, T]
        vocals_mono    = vocals.mean(dim=1, keepdim=True)
        mask           = vocals_mono.abs() / (x.abs() + 1e-8)
        return torch.clamp(mask, 0.0, 1.0)

wrapper = DemucsVocalMaskWrapper(demucs, vocal_idx, _stft_helper, _istft_helper)
wrapper.eval()

# Smoke test before trace
dummy = torch.zeros(1, 1, TRAIN_LEN, dtype=torch.float32)
print(f'      Dummy shape: {list(dummy.shape)} ({TRAIN_LEN/SAMPLE_RATE:.2f}s)')

with torch.no_grad():
    test_out = wrapper(dummy)
print(f'      Wrapper output: {list(test_out.shape)}  '
      f'min={float(test_out.min()):.4f}  max={float(test_out.max()):.4f}')

assert test_out.shape[0] == 1 and test_out.shape[1] == 1, \
    f'Unexpected output shape: {test_out.shape}'

print('[4/8] torch.jit.trace...')
try:
    traced = torch.jit.trace(wrapper, dummy, strict=False)
    with torch.no_grad():
        verify = traced(dummy)
    print(f'      Traced output: {list(verify.shape)}  '
          f'min={float(verify.min()):.4f}  max={float(verify.max()):.4f}')
except Exception as e:
    print(f'      jit.trace failed ({e}) -- using eager wrapper')
    traced = wrapper

# ---------------------------------------------------------------------------
# [5/8] ONNX export -- opset 17, legacy (TorchScript) exporter
# ---------------------------------------------------------------------------
print(f'[5/8] Exporting to {OUT_FP32} (opset 17, legacy exporter)...')
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
    dynamo=False,       # legacy TorchScript exporter
)
fp32_mb = os.path.getsize(OUT_FP32) / 1e6
print(f'[5/8] FP32 export done: {fp32_mb:.1f} MB')

# ---------------------------------------------------------------------------
# [6/8] ONNX checker
# ---------------------------------------------------------------------------
print('[6/8] Validating ONNX graph...')
model_proto = onnx.load(OUT_FP32)
onnx.checker.check_model(model_proto)
print('[6/8] onnx.checker passed.')

# ---------------------------------------------------------------------------
# [7/8] INT8 quantization
# ---------------------------------------------------------------------------
print(f'[7/8] INT8 dynamic quantization -> {OUT_INT8}...')
quantize_dynamic(OUT_FP32, OUT_INT8, weight_type=QuantType.QInt8)
int8_mb = os.path.getsize(OUT_INT8) / 1e6
print(f'[7/8] INT8 size: {int8_mb:.1f} MB')

# ---------------------------------------------------------------------------
# [8/8] Smoke test
# ---------------------------------------------------------------------------
print('[8/8] Smoke test (onnxruntime CPUExecutionProvider)...')
sess       = onnxruntime.InferenceSession(OUT_INT8, providers=['CPUExecutionProvider'])
smoke_in   = np.zeros((1, 1, TRAIN_LEN), dtype=np.float32)
outputs    = sess.run(None, {'input': smoke_in})
out        = outputs[0]

assert out.shape[0] == 1 and out.shape[1] == 1 and out.shape[2] == TRAIN_LEN, \
    f'[FAIL] shape {out.shape}'
assert float(out.min()) >= 0.0,          f'[FAIL] min={out.min()} < 0'
assert float(out.max()) <= 1.0 + 1e-4,  f'[FAIL] max={out.max()} > 1'
print(f'[8/8] SMOKE TEST PASSED  shape={list(out.shape)}  '
      f'min={out.min():.4f}  max={out.max():.4f}')

# ---------------------------------------------------------------------------
# SHA-256 + summary
# ---------------------------------------------------------------------------
sha256 = hashlib.sha256()
with open(OUT_INT8, 'rb') as f:
    for chunk in iter(lambda: f.read(1 << 20), b''):
        sha256.update(chunk)
digest = sha256.hexdigest()

print()
print('=' * 70)
print(f'  OUTPUT : {OUT_INT8}')
print(f'  SIZE   : {int8_mb:.2f} MB')
print(f'  SHA256 : {digest}')
print('=' * 70)
print()
print('NEXT STEPS:')
print('  1. npx vercel blob put demucs_v4_quantized.onnx')
print('  2. Update vercel.json rewrite + ml-worker.js MODEL_SHA256')
print(f'       sha256: {digest}')

#!/usr/bin/env python3
"""
Export rnnoise_suppressor.onnx and bsrnn_vocals.onnx for VoiceIsolate Pro.

Contract enforced by public/app/ml-worker.js:
  input  name='input'   shape=[1, 2049]  dtype=float32  (magnitude bins, fft_size=4096 @ 48kHz)
  output name='output'  shape=[1, 2049]  dtype=float32  (soft mask, values in [0, 1])
  opset 18, dynamic batch axis on dim 0

No off-the-shelf checkpoint matches this single-frame [1, 2049] interface (Mozilla
RNNoise uses 22 Bark-band PCM features; Open-Unmix/BSRNN use multi-frame stereo
spectrograms with different bin counts). The task's authorized fallback path —
"train a small GRU/LSTM ... on spectral MSE loss" — is what we execute here.

Training data is synthetic: clean speech-like signals (harmonic stacks with
formant filtering) mixed with colored noise (white/pink/brown/babble) at random
SNR. Oracle Wiener masks are used as targets. This trains the networks to
perform real spectral masking rather than passthrough — a genuine step up from
the prior random-weight stubs whose sigmoid bias forced ~0.82 / ~0.88 output.
"""

from __future__ import annotations

import hashlib
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

NUM_BINS = 2049     # (FFT_SIZE / 2) + 1, FFT_SIZE = 4096
FFT_SIZE = 4096
SAMPLE_RATE = 48000
HOP = 1024
SEED = 1729
OPSET = 18

torch.manual_seed(SEED)
np.random.seed(SEED)


# ──────────────────────────── Model architectures ────────────────────────────

class RNNoiseSpectral(nn.Module):
    """Spectral-domain bidirectional-GRU noise-suppression mask predictor.

    The frequency axis is chunked into a sequence so the recurrent layer sees
    a real sequence (a single-timestep GRU collapses to a constant function,
    which we observed in v1). 2049 bins → padded to 2052 = 76 chunks × 27
    bins. Bidirectional GRU lets each frequency region attend to lower and
    higher bins, mirroring how Mozilla RNNoise's Bark-band aggregation works.
    """

    def __init__(self, num_bins: int = NUM_BINS, chunk_size: int = 27,
                 hidden: int = 128, layers: int = 2):
        super().__init__()
        self.num_bins = num_bins
        self.chunk_size = chunk_size
        self.padded = ((num_bins + chunk_size - 1) // chunk_size) * chunk_size  # 2052
        self.num_chunks = self.padded // chunk_size                              # 76
        self.pad_amt = self.padded - num_bins                                    # 3

        self.encoder = nn.Linear(chunk_size, hidden)
        self.gru = nn.GRU(hidden, hidden, num_layers=layers,
                          batch_first=True, bidirectional=True)
        self.decoder = nn.Linear(hidden * 2, chunk_size)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [B, num_bins], magnitudes ≥ 0
        B = x.shape[0]
        x_log = torch.log1p(x * 50.0)                                # log-compress
        x_pad = F.pad(x_log, (0, self.pad_amt))                      # [B, padded]
        x_chunks = x_pad.view(B, self.num_chunks, self.chunk_size)   # [B, 76, 27]
        h = F.relu(self.encoder(x_chunks))                            # [B, 76, hidden]
        h, _ = self.gru(h)                                            # [B, 76, hidden*2]
        out = self.decoder(h)                                         # [B, 76, 27]
        out = out.reshape(B, self.padded)[:, :self.num_bins]
        return torch.sigmoid(out)


class BSRNNSpectral(nn.Module):
    """Band-split LSTM spectral mask predictor for vocal isolation.

    True to the BSRNN concept: split the spectrum into perceptually-motivated
    bands, encode each independently, then run a bidirectional LSTM *across
    the band sequence* so each band can attend to the others. Per-band
    decoders emit masks that are reassembled to the original 2049-bin layout.

    Bands tuned for 48 kHz / 4096-FFT (bin width = 11.72 Hz):
      band 0 :  bin 0..43      (0–500 Hz, sub-bass)
      band 1 :  bin 43..128    (500 Hz–1.5 kHz, lower vocal)
      band 2 :  bin 128..256   (1.5–3 kHz, primary vocal formants)
      band 3 :  bin 256..512   (3–6 kHz, upper vocal/presence)
      band 4 :  bin 512..1024  (6–12 kHz, brilliance)
      band 5 :  bin 1024..2049 (12–24 kHz, air/cymbals)
    """

    BAND_EDGES = (0, 43, 128, 256, 512, 1024, NUM_BINS)

    def __init__(self, hidden: int = 96, layers: int = 2):
        super().__init__()
        self.band_widths = [self.BAND_EDGES[i + 1] - self.BAND_EDGES[i]
                            for i in range(len(self.BAND_EDGES) - 1)]
        self.band_enc = nn.ModuleList([nn.Linear(w, hidden) for w in self.band_widths])
        self.band_dec = nn.ModuleList([nn.Linear(hidden * 2, w) for w in self.band_widths])
        self.lstm = nn.LSTM(hidden, hidden, num_layers=layers,
                            batch_first=True, bidirectional=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x_log = torch.log1p(x * 50.0)
        feats = []
        for i, enc in enumerate(self.band_enc):
            lo, hi = self.BAND_EDGES[i], self.BAND_EDGES[i + 1]
            feats.append(F.relu(enc(x_log[:, lo:hi])))
        h = torch.stack(feats, dim=1)                               # [B, 6, hidden]
        h, _ = self.lstm(h)                                          # [B, 6, hidden*2]
        outs = [dec(h[:, i, :]) for i, dec in enumerate(self.band_dec)]
        mask = torch.cat(outs, dim=-1)                               # [B, num_bins]
        return torch.sigmoid(mask)


# ──────────────────────────── Synthetic training data ────────────────────────

def _hann_window(n: int) -> torch.Tensor:
    return 0.5 - 0.5 * torch.cos(2 * torch.pi * torch.arange(n) / n)


def _stft_mag(x: torch.Tensor) -> torch.Tensor:
    """Magnitude STFT, single-frame extraction. Input [B, FFT_SIZE] → [B, NUM_BINS]."""
    win = _hann_window(FFT_SIZE).to(x.device)
    spec = torch.fft.rfft(x * win, n=FFT_SIZE)
    return spec.abs()


def _gen_speech_like(batch: int) -> torch.Tensor:
    """Harmonic stack with formant-filtered envelope — voiced-speech-like frames."""
    t = torch.arange(FFT_SIZE) / SAMPLE_RATE       # [FFT_SIZE]
    f0 = 80.0 + 220.0 * torch.rand(batch, 1)       # 80–300 Hz
    n_harmonics = 30
    harmonics = torch.arange(1, n_harmonics + 1).float()  # [n_h]
    # phase per (batch, harmonic)
    phase = 2 * torch.pi * torch.rand(batch, n_harmonics)
    # amplitude envelope: 1/h decay + random formant emphasis
    amp = 1.0 / harmonics
    formants = torch.tensor([500.0, 1500.0, 2500.0])      # 3 formants
    formant_w = 200.0
    sig = torch.zeros(batch, FFT_SIZE)
    for b in range(batch):
        freqs = f0[b] * harmonics                  # [n_h]
        # formant gain
        gain = torch.zeros(n_harmonics)
        for fc in formants:
            gain += torch.exp(-((freqs - fc) / formant_w) ** 2)
        gain = gain / (gain.max() + 1e-6) + 0.2
        a = amp * gain
        wave = (a.unsqueeze(1) * torch.sin(2 * torch.pi * freqs.unsqueeze(1) * t.unsqueeze(0)
                                           + phase[b].unsqueeze(1))).sum(dim=0)
        sig[b] = wave
    # normalise
    sig = sig / (sig.abs().max(dim=1, keepdim=True).values + 1e-6)
    return sig


def _gen_noise(batch: int) -> torch.Tensor:
    """Mix of white / pink / brown / babble-like noise, randomly chosen per batch."""
    out = torch.zeros(batch, FFT_SIZE)
    for b in range(batch):
        kind = np.random.choice(['white', 'pink', 'brown', 'babble'])
        n = torch.randn(FFT_SIZE)
        if kind == 'pink':
            # 1/f shaping in spectrum
            spec = torch.fft.rfft(n)
            freqs = torch.arange(spec.shape[0]).float() + 1.0
            spec = spec / freqs.sqrt()
            n = torch.fft.irfft(spec, n=FFT_SIZE)
        elif kind == 'brown':
            spec = torch.fft.rfft(n)
            freqs = torch.arange(spec.shape[0]).float() + 1.0
            spec = spec / freqs
            n = torch.fft.irfft(spec, n=FFT_SIZE)
        elif kind == 'babble':
            # multiple low-freq harmonic bursts → speech-babble-ish
            t = torch.arange(FFT_SIZE) / SAMPLE_RATE
            n = sum(0.3 * torch.sin(2 * torch.pi * (200 + 800 * torch.rand(1).item()) * t
                                    + torch.rand(1).item() * 6.28)
                    for _ in range(8))
            n = n + 0.3 * torch.randn(FFT_SIZE)
        n = n / (n.abs().max() + 1e-6)
        out[b] = n
    return out


def _gen_accomp(batch: int) -> torch.Tensor:
    """Music-accompaniment-like signal: bass-heavy + cymbals (high-freq broadband)."""
    out = torch.zeros(batch, FFT_SIZE)
    t = torch.arange(FFT_SIZE) / SAMPLE_RATE
    for b in range(batch):
        # bass: 40–180 Hz fundamental + harmonics
        f_bass = 40 + 140 * torch.rand(1).item()
        bass = sum((1.0 / k) * torch.sin(2 * torch.pi * f_bass * k * t
                                          + torch.rand(1).item() * 6.28)
                    for k in range(1, 6))
        # high freq cymbals: bandpassed noise > 6 kHz
        n = torch.randn(FFT_SIZE)
        spec = torch.fft.rfft(n)
        freqs = torch.fft.rfftfreq(FFT_SIZE, d=1.0 / SAMPLE_RATE)
        mask = ((freqs > 6000) & (freqs < 16000)).float()
        spec = spec * mask
        cymb = torch.fft.irfft(spec, n=FFT_SIZE)
        sig = 0.7 * bass + 0.3 * cymb
        sig = sig / (sig.abs().max() + 1e-6)
        out[b] = sig
    return out


def make_denoising_batch(batch: int):
    """clean speech + noise → noisy magnitude, oracle Wiener mask."""
    clean = _gen_speech_like(batch)
    noise = _gen_noise(batch)
    snr_db = -5 + 25 * torch.rand(batch, 1)         # -5 .. +20 dB
    noise_gain = 10 ** (-snr_db / 20)
    noisy = clean + noise_gain * noise
    cm = _stft_mag(clean)
    nm = _stft_mag(noise_gain * noise)
    mix_m = _stft_mag(noisy)
    # Oracle Wiener mask: |S|² / (|S|² + |N|²)
    mask = cm.pow(2) / (cm.pow(2) + nm.pow(2) + 1e-9)
    # Normalise input magnitude to ~[0,1]
    nin = mix_m / (mix_m.max(dim=1, keepdim=True).values + 1e-6)
    return nin, mask


def make_vocal_separation_batch(batch: int):
    """vocal + accomp → mix magnitude, vocal-dominance mask."""
    vocal = _gen_speech_like(batch)
    accomp = _gen_accomp(batch)
    ratio_db = -5 + 15 * torch.rand(batch, 1)         # -5 .. +10 dB vocal-to-accomp
    accomp_gain = 10 ** (-ratio_db / 20)
    mix = vocal + accomp_gain * accomp
    vm = _stft_mag(vocal)
    am = _stft_mag(accomp_gain * accomp)
    mix_m = _stft_mag(mix)
    mask = vm.pow(2) / (vm.pow(2) + am.pow(2) + 1e-9)
    nin = mix_m / (mix_m.max(dim=1, keepdim=True).values + 1e-6)
    return nin, mask


# ──────────────────────────── Training loop ──────────────────────────────────

def train_model(model: nn.Module, gen_batch_fn, *,
                steps: int, batch_size: int, lr: float, label: str) -> None:
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=steps)
    model.train()
    t0 = time.time()
    losses = []
    for step in range(steps):
        x, y = gen_batch_fn(batch_size)
        pred = model(x)
        # combined loss: MSE on mask + small L1 on log-domain mask deviation
        mse = F.mse_loss(pred, y)
        l1 = F.l1_loss(pred, y)
        loss = mse + 0.2 * l1
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        losses.append(loss.item())
        if (step + 1) % max(1, steps // 10) == 0:
            recent = float(np.mean(losses[-50:]))
            print(f'  [{label}] step {step + 1:>4}/{steps} '
                  f'loss(50-avg)={recent:.4f} lr={sched.get_last_lr()[0]:.2e} '
                  f'elapsed={time.time() - t0:.1f}s', flush=True)
    model.eval()
    print(f'  [{label}] training done in {time.time() - t0:.1f}s. '
          f'final loss(50-avg)={float(np.mean(losses[-50:])):.4f}', flush=True)


# ──────────────────────────── ONNX export + validation ───────────────────────

def export_onnx(model: nn.Module, out_path: Path, *, input_name: str = 'input',
                output_name: str = 'output') -> None:
    model.eval()
    dummy = torch.randn(1, NUM_BINS, dtype=torch.float32).abs()  # magnitudes ≥ 0
    torch.onnx.export(
        model,
        (dummy,),
        out_path.as_posix(),
        input_names=[input_name],
        output_names=[output_name],
        dynamic_axes={input_name: {0: 'batch'}, output_name: {0: 'batch'}},
        opset_version=OPSET,
        do_constant_folding=True,
    )


def validate_onnx(out_path: Path, label: str) -> dict:
    import onnx
    import onnxruntime as ort

    onnx_model = onnx.load(out_path.as_posix())
    onnx.checker.check_model(onnx_model)

    sess = ort.InferenceSession(out_path.as_posix(),
                                providers=['CPUExecutionProvider'])
    in_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name

    # Random magnitude input (non-negative)
    x = np.abs(np.random.randn(1, NUM_BINS)).astype(np.float32)
    y = sess.run([out_name], {in_name: x})[0]

    assert y.shape == (1, NUM_BINS), f'{label} bad shape {y.shape}'
    assert y.dtype == np.float32, f'{label} bad dtype {y.dtype}'
    assert (y >= 0.0).all() and (y <= 1.0).all(), \
        f'{label} mask not in [0,1] (min={y.min()}, max={y.max()})'

    # Confirm dynamic batch dim works
    x4 = np.abs(np.random.randn(4, NUM_BINS)).astype(np.float32)
    y4 = sess.run([out_name], {in_name: x4})[0]
    assert y4.shape == (4, NUM_BINS), f'{label} dynamic batch broken {y4.shape}'

    size = out_path.stat().st_size
    sha = hashlib.sha256(out_path.read_bytes()).hexdigest()
    return {
        'label': label,
        'path': str(out_path),
        'size_bytes': size,
        'size_mb': size / 1024 / 1024,
        'in_name': in_name,
        'out_name': out_name,
        'out_shape': list(y.shape),
        'out_min': float(y.min()),
        'out_max': float(y.max()),
        'out_mean': float(y.mean()),
        'sha256': sha,
    }


# ──────────────────────────── Main ───────────────────────────────────────────

def main() -> int:
    here = Path(__file__).resolve().parent.parent  # repo root
    cwd_outdir = Path.cwd()
    print(f'[export] CWD = {cwd_outdir}', flush=True)
    print(f'[export] torch={torch.__version__}  device=cpu  opset={OPSET}', flush=True)

    # Task 1: RNNoise
    print('\n=== TASK 1: rnnoise_suppressor.onnx ===', flush=True)
    print('source: trained-from-scratch GRU on synthetic noisy-speech / Wiener-mask targets',
          flush=True)
    rnnoise = RNNoiseSpectral()
    n_params_rn = sum(p.numel() for p in rnnoise.parameters())
    print(f'  arch: chunk(2049→76×27) → Linear(27→96) → BiGRU(96, 2 layers) '
          f'→ Linear(192→27) → reassemble → Sigmoid', flush=True)
    print(f'  params: {n_params_rn:,}  (~{n_params_rn * 4 / 1024 / 1024:.2f} MB)', flush=True)
    train_model(rnnoise, make_denoising_batch,
                steps=600, batch_size=24, lr=1.5e-3, label='rnnoise')
    rn_path = cwd_outdir / 'rnnoise_suppressor.onnx'
    export_onnx(rnnoise, rn_path)
    rn_info = validate_onnx(rn_path, 'rnnoise')
    print(f'  validated: shape={rn_info["out_shape"]} '
          f'range=[{rn_info["out_min"]:.3f}, {rn_info["out_max"]:.3f}] '
          f'mean={rn_info["out_mean"]:.3f} '
          f'size={rn_info["size_mb"]:.2f}MB', flush=True)

    # Task 2: BSRNN
    print('\n=== TASK 2: bsrnn_vocals.onnx ===', flush=True)
    print('source: trained-from-scratch band-split LSTM on synthetic vocal/accomp Wiener-mask targets',
          flush=True)
    bsrnn = BSRNNSpectral()
    n_params_bs = sum(p.numel() for p in bsrnn.parameters())
    print(f'  arch: 6-band split → per-band Linear(→64) → BiLSTM(64, 2 layers) '
          f'→ per-band Linear(128→band_w) → reassemble → Sigmoid', flush=True)
    print(f'  params: {n_params_bs:,}  (~{n_params_bs * 4 / 1024 / 1024:.2f} MB)', flush=True)
    train_model(bsrnn, make_vocal_separation_batch,
                steps=600, batch_size=24, lr=1.5e-3, label='bsrnn')
    bs_path = cwd_outdir / 'bsrnn_vocals.onnx'
    export_onnx(bsrnn, bs_path)
    bs_info = validate_onnx(bs_path, 'bsrnn')
    print(f'  validated: shape={bs_info["out_shape"]} '
          f'range=[{bs_info["out_min"]:.3f}, {bs_info["out_max"]:.3f}] '
          f'mean={bs_info["out_mean"]:.3f} '
          f'size={bs_info["size_mb"]:.2f}MB', flush=True)

    # Task 3: SHA256 + summary
    print('\n=== TASK 3: SHA256 + summary ===', flush=True)
    print(f'\n  rnnoise sha256: {rn_info["sha256"]}')
    print(f'  bsrnn sha256: {bs_info["sha256"]}')

    print('\n| Model | Source Used | Output Shape | Value Range | File Size | SHA256 |')
    print('|-------|-------------|--------------|-------------|-----------|--------|')
    print(f'| rnnoise_suppressor | trained-from-scratch GRU on synthetic data | '
          f'{tuple(rn_info["out_shape"])} | '
          f'[{rn_info["out_min"]:.3f}, {rn_info["out_max"]:.3f}] | '
          f'{rn_info["size_mb"]:.2f} MB | {rn_info["sha256"][:16]}… |')
    print(f'| bsrnn_vocals | trained-from-scratch band-split LSTM on synthetic data | '
          f'{tuple(bs_info["out_shape"])} | '
          f'[{bs_info["out_min"]:.3f}, {bs_info["out_max"]:.3f}] | '
          f'{bs_info["size_mb"]:.2f} MB | {bs_info["sha256"][:16]}… |')
    return 0


if __name__ == '__main__':
    sys.exit(main())

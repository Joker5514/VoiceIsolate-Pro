#!/usr/bin/env python3
"""Reference oracle for MET-01 (ESTOI).

Generates deterministic speech-like test signals, scores them with the
pinned Python reference (pystoi 0.4.1), and writes pinned fixtures:

    scripts/quality/fixtures/estoi/<name>.ref.f64   (float64 little-endian)
    scripts/quality/fixtures/estoi/<name>.deg.f64
    scripts/quality/fixtures/estoi/manifest.json    (expected stoi/estoi)

Run with the project venv (pystoi pinned there):

    /home/hatch/vip-verify/.venv-estoi/bin/python scripts/quality/estoi-oracle.py

Pinned versions are recorded in the manifest and in
scripts/quality/estoi-requirements.txt. Never hand-edit the manifest:
regenerate it with this script.

Notes on the reference itself (verified 2026-11-25, pystoi 0.4.1):
- pystoi.stoi(x, y, fs, extended=True) is ESTOI (Jensen & Taal 2016);
  extended=False is ordinary STOI.
- On all-silence input pystoi's ESTOI is NON-deterministic: its
  row/column normalisation adds unseeded EPS-scale random noise, so
  repeated runs return values scattered around 0 (observed range
  roughly [-0.002, +0.007]). The silence fixture is therefore marked
  toleranceExempt in the manifest; the JS implementation deterministically
  returns 0.0 there (the zero-noise limit).
- On input too short to form STFT frames pystoi raises (AxisError from
  its silence-removal step). The JS implementation instead throws a
  documented Error; see metrics.cjs.
"""
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE_DIR = os.path.join(HERE, "fixtures", "estoi")
SEED = 12345
DURATION_SEC = 1.2


def speech_like(rng, fs, dur=DURATION_SEC):
    """Deterministic speech-like signal: harmonic complex with syllabic
    F0 / amplitude variation, two silent pauses, fricative noise bursts."""
    n = int(fs * dur)
    t = np.arange(n) / fs
    n_syl = max(4, int(dur / 0.12))
    f0_knots = rng.uniform(95, 165, n_syl + 2)
    f0 = np.interp(np.arange(n), np.linspace(0, n - 1, n_syl + 2), f0_knots)
    phase = 2 * np.pi * np.cumsum(f0) / fs
    x = np.zeros(n)
    for k in range(1, 10):
        fm = rng.uniform(1.5, 6.5)
        ph = rng.uniform(0, 2 * np.pi)
        a = (0.55 + 0.45 * np.sin(2 * np.pi * fm * t + ph)) / k ** 0.8
        x += a * np.sin(k * phase)
    env_knots = rng.uniform(0.35, 1.0, n_syl + 2)
    env = np.interp(np.arange(n), np.linspace(0, n - 1, n_syl + 2), env_knots)
    ker = np.hanning(201)
    ker /= ker.sum()
    env = np.convolve(env, ker, mode="same")
    x *= env
    for start in (0.35, 0.8):
        i0, i1 = int(start * fs), int((start + 0.12) * fs)
        x[i0:i1] = 0
    for start in (0.15, 0.55, 0.95):
        i0, i1 = int(start * fs), int((start + 0.06) * fs)
        burst = rng.standard_normal(i1 - i0) * np.hanning(i1 - i0)
        x[i0:i1] += 0.25 * burst
    x /= np.max(np.abs(x))
    x *= 0.8
    return x


def add_noise_at_snr(rng, x, snr_db):
    n = rng.standard_normal(len(x))
    n = n / np.sqrt(np.mean(n ** 2)) * np.sqrt(np.mean(x ** 2)) * 10 ** (-snr_db / 20)
    return x + n


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def main():
    from pystoi import stoi
    import scipy

    os.makedirs(FIXTURE_DIR, exist_ok=True)
    rng = np.random.default_rng(SEED)

    # (name, sample_rate, kind, build degraded from clean)
    specs = [
        ("identical-10k", 10000, "identical", lambda r, x: x.copy()),
        ("mild-noise-10k", 10000, "additive-noise-snr+10dB",
         lambda r, x: add_noise_at_snr(r, x, 10)),
        ("severe-noise-10k", 10000, "additive-noise-snr-5dB",
         lambda r, x: add_noise_at_snr(r, x, -5)),
        ("clipped-10k", 10000, "hard-clip-1.8x-to-0.7",
         lambda r, x: np.clip(1.8 * x, -0.7, 0.7)),
        ("shifted-10k", 10000, "shift-200-samples-zero-fill",
         lambda r, x: np.concatenate([np.zeros(200), x[:-200]])),
        ("silence-10k", 10000, "all-silence",
         lambda r, x: np.zeros_like(x)),
        ("identical-16k", 16000, "identical", lambda r, x: x.copy()),
        ("mild-noise-16k", 16000, "additive-noise-snr+10dB",
         lambda r, x: add_noise_at_snr(r, x, 10)),
        ("identical-48k", 48000, "identical", lambda r, x: x.copy()),
        ("mild-noise-48k", 48000, "additive-noise-snr+10dB",
         lambda r, x: add_noise_at_snr(r, x, 10)),
        ("severe-noise-48k", 48000, "additive-noise-snr-5dB",
         lambda r, x: add_noise_at_snr(r, x, -5)),
        ("mild-noise-8k", 8000, "additive-noise-snr+10dB",
         lambda r, x: add_noise_at_snr(r, x, 10)),
        ("mild-noise-441k", 44100, "additive-noise-snr+10dB",
         lambda r, x: add_noise_at_snr(r, x, 10)),
    ]

    fixtures = []
    for name, fs, kind, build_deg in specs:
        clean = speech_like(rng, fs) if kind != "all-silence" else np.zeros(int(fs * DURATION_SEC))
        deg = build_deg(rng, clean)
        ref_path = os.path.join(FIXTURE_DIR, name + ".ref.f64")
        deg_path = os.path.join(FIXTURE_DIR, name + ".deg.f64")
        clean.astype("<f8").tofile(ref_path)
        deg.astype("<f8").tofile(deg_path)
        estoi = float(stoi(clean, deg, fs, extended=True))
        stoi_v = float(stoi(clean, deg, fs, extended=False))
        entry = {
            "name": name,
            "kind": kind,
            "sampleRate": fs,
            "samples": int(len(clean)),
            "refFile": name + ".ref.f64",
            "degFile": name + ".deg.f64",
            "refSha256": sha256(ref_path),
            "degSha256": sha256(deg_path),
            "stoi": stoi_v,
            "estoi": estoi,
        }
        if kind == "all-silence":
            # pystoi ESTOI on silence is nondeterministic (unseeded EPS
            # noise in row/column normalisation); the recorded value is
            # one draw only. Exempt from the 1e-4 comparison; the JS
            # implementation deterministically returns 0.0 (see manifest
            # notes and metrics.cjs).
            entry["toleranceExempt"] = True
            entry["toleranceExemptReason"] = (
                "pystoi ESTOI on all-silence input is nondeterministic "
                "(unseeded EPS-scale noise in row_col_normalize); observed "
                "repeat runs scatter around 0 in roughly [-0.002, +0.007]. "
                "JS returns 0.0 deterministically."
            )
        fixtures.append(entry)
        print(f"{name}: stoi={stoi_v:.12f} estoi={estoi:.12f}")

    manifest = {
        "generatedBy": "scripts/quality/estoi-oracle.py",
        "pystoi": "0.4.1",
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        "python": sys.version.split()[0],
        "seed": SEED,
        "durationSec": DURATION_SEC,
        "signal": (
            "speech-like harmonic complex, syllabic F0 95-165 Hz, "
            "per-harmonic amplitude modulation, two 120 ms pauses, "
            "three fricative noise bursts; peak-normalised to 0.8"
        ),
        "notes": [
            "Expected scores come from pystoi 0.4.1 (stoi(x, y, fs, "
            "extended=True) for ESTOI, extended=False for STOI).",
            "ESTOI is only valid on aligned clean-reference / degraded "
            "pairs. It is NOT valid on field recordings without a clean "
            "reference (e.g. the Drive-video clips).",
            "pystoi resamples any fs != 10000 Hz to 10000 Hz internally "
            "(Octave-compatible polyphase resampler); the JS port mirrors "
            "that resampler exactly, so 16 kHz / 48 kHz fixtures exercise "
            "the JS resampler against the reference.",
        ],
        "fixtures": fixtures,
    }
    manifest_path = os.path.join(FIXTURE_DIR, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(f"wrote {manifest_path} ({len(fixtures)} fixtures)")


if __name__ == "__main__":
    main()

# VoiceIsolate Pro

> **v22.1.0** — Real-time voice isolation, speaker fingerprinting, spectrogram visualization, and advanced DSP — all in a sleek, audio-reactive UI.

---

## Overview

VoiceIsolate Pro is a high-performance audio processing engine built for precision voice isolation, real-time visualization, and speaker identification. It separates voices from any background — music, white noise, crowd noise, HVAC — and lets you **see** and **identify** every voice in real time.

---

## Core Capabilities

### 🎙️ Voice Isolation
- Separates vocals from music, white noise, crowd noise, and HVAC
- Multi-speaker source separation (isolate individual voices from a mix)
- Adaptive Wiener filter for dynamic noise suppression
- DNS v2 ONNX deep learning model for neural noise suppression
- Harmonic enhancer v2 for voice clarity post-isolation
- Real-time noise classifier — auto-detects noise type (music / crowd / HVAC / white noise)

### 🧬 Voice Fingerprinting (Speaker ID)
- Biometric voice profiles — identify speakers like a fingerprint
- Real-time speaker diarization (who spoke when)
- Speaker enrollment and persistent profile storage
- Confidence scoring per identification
- Cross-session speaker memory

### 📊 Real-Time Spectrogram Visualization
- 2D/3D hybrid spectrogram with mel-scale frequency axis
- Per-speaker color lanes — each voice gets its own color track
- 60fps rendering with zoom/pan controls
- Snapshot export (PNG/SVG)
- Spectrogram colors sync with speaker aura rings in the UI

### 🎨 UI — Deep Space Glassmorphism
- Dark glassmorphism design system (electric indigo primary)
- Audio-reactive ambient glow — UI pulses with audio energy
- Speaker aura rings that pulse with voice activity (color-matched to spectrogram lanes)
- Micro-animations on all interactive elements
- Inter (UI) + JetBrains Mono (data/code) typography
- Mobile-first bottom sheet layout, fully responsive

---

## Architecture

```
Input Layer
└── Audio stream / file (WAV, MP3, FLAC, OGG)
      │
Processing Engine
├── Pre-emphasis filter
├── Noise Gate
├── Noise Classifier CNN (music / crowd / HVAC / white noise)
├── Adaptive Wiener Filter
├── Spectral Subtraction
├── DNS v2 ONNX Model (neural noise suppression)
├── Multi-Speaker Source Separation
├── Harmonic Enhancer v2
└── Voice Fingerprint Engine (speaker diarization + ID)
      │
Visualization Layer
├── 2D/3D Hybrid Spectrogram (mel-scale, 60fps)
├── Per-Speaker Color Lanes
└── Audio-Reactive UI (aura rings, ambient glow)
      │
Output Layer
└── Multi-format export + real-time streaming
```

### Key Source Files

| File | Purpose |
|------|---------|
| `voiceisolate.py` | Main entry point |
| `src/dsp/wiener.py` | Adaptive Wiener filter |
| `src/dsp/spectral.py` | Spectral subtraction |
| `src/dsp/harmonic.py` | Harmonic enhancer v2 |
| `src/ml/dns_v2.onnx` | DNS v2 neural model |
| `src/ml/noise_classifier.onnx` | Noise type classifier CNN |
| `src/fingerprint/engine.py` | Voice fingerprinting + diarization |
| `src/viz/spectrogram.py` | Real-time spectrogram renderer |
| `src/ui/theme.css` | Deep space glassmorphism design system |
| `scripts/validate.js` | CI validation script |
| `scripts/check-duplicate-keys.js` | Duplicate key checker (CI) |

---

## ML Models

| Model | Type | Status |
|-------|------|--------|
| DNS v2 | ONNX (neural noise suppression) | Active |
| Noise Classifier CNN | ONNX (music/crowd/HVAC/white noise) | Roadmap |
| Voice Fingerprint | Embedding model (speaker ID) | Roadmap |

---

## Roadmap

### Active Issues

| # | Feature | Status |
|---|---------|--------|
| [#251](https://github.com/Joker5514/VoiceIsolate-Pro/issues/251) | Voice Fingerprinting — speaker ID & biometric profiles | Open |
| [#252](https://github.com/Joker5514/VoiceIsolate-Pro/issues/252) | Real-Time Spectrogram — voice overlay & frequency analysis | Open |
| [#253](https://github.com/Joker5514/VoiceIsolate-Pro/issues/253) | Advanced DSP — enhanced isolation, noise suppression, audio intelligence | Open |
| [#254](https://github.com/Joker5514/VoiceIsolate-Pro/issues/254) | Modern UI Overhaul — sleek dark theme, reactive audio lights | Open |
| [#259](https://github.com/Joker5514/VoiceIsolate-Pro/issues/259) | CI Fix — missing check-duplicate-keys.js + copilot-instructions.md | Open |
| [#268](https://github.com/Joker5514/VoiceIsolate-Pro/issues/268) | DSP Upgrades v2 — adaptive Wiener, DNS v2, multi-speaker separation | Open |
| [#269](https://github.com/Joker5514/VoiceIsolate-Pro/issues/269) | Spectrogram v2 — 2D/3D hybrid, mel-scale, per-speaker lanes, 60fps | Open |
| [#270](https://github.com/Joker5514/VoiceIsolate-Pro/issues/270) | UI Overhaul v2 — deep space glassmorphism, aura rings, audio-reactive glow | Open |

### Integration Map

```
Voice Fingerprinting (#251)
├── feeds → Spectrogram per-speaker color lanes (#252, #269)
└── feeds → Speaker aura rings in UI (#254, #270)

Noise Classifier (#268)
└── feeds → Noise type badge in UI (#270)

DSP Upgrades (#253, #268)
└── feeds → Cleaner input to spectrogram + fingerprint engine
```

---

## Monetization

| Tier | Price | Features |
|------|-------|---------|
| Free | $0 | Basic isolation, 5 min sessions, watermarked export |
| Pro | $10/mo | Full DSP, spectrogram, fingerprinting, unlimited sessions |
| API | $500+/mo | REST API access, batch processing, white-label |

---

## Installation

```bash
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro
pip install -r requirements.txt
```

## Usage

```bash
# Basic voice isolation
python voiceisolate.py --input audio.mp3 --output isolated_voice.wav

# With speaker fingerprinting
python voiceisolate.py --input audio.mp3 --output isolated_voice.wav --fingerprint

# Real-time mode with spectrogram
python voiceisolate.py --realtime --spectrogram
```

---

## Browser & Mobile Support

| Platform | Support |
|----------|---------|
| Chrome 90+ | ✅ Full |
| Firefox 88+ | ✅ Full |
| Safari 15+ | ✅ Full |
| Mobile (iOS/Android) | ✅ Bottom sheet layout |

---

## Contributing

Pull requests are welcome. For major changes, open an issue first to discuss what you'd like to change. See active issues above for the current roadmap.

## License

[MIT](LICENSE)

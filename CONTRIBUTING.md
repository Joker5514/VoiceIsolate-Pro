# Contributing to VoiceIsolate Pro

Thank you for considering contributing to VoiceIsolate Pro! This document provides guidelines and information for developers who want to contribute.

## Getting Started

### Prerequisites

- Node.js 18+ (LTS recommended)
- Modern browser with Web Audio API support (Chrome/Edge/Firefox)
- Git

### Setup

```bash
# Clone the repository
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro

# Install dependencies
npm install

# Start the dev server
npm run dev
```

The app will be available at `http://localhost:3000/app/`.

## Development Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start local development server |
| `npm run lint` | Run ESLint on source files |
| `npm run lint:fix` | Run ESLint with auto-fix |
| `npm run test` | Run Jest unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run validate` | Run structural validation checks |

## Architecture Overview

### Single-Pass Spectral Principle

**Critical rule**: The audio pipeline uses ONE STFT → all spectral processing in-place → ONE iSTFT. Never introduce additional STFT/iSTFT round-trips.

This prevents phase smearing and echo artifacts that occur with multiple spectral transformations.

### File Structure

```
public/
├── index.html              # Landing page / router
├── app/                    # Main application
│   ├── index.html          # Engineer Mode v19 UI
│   ├── style.css           # Dark industrial theme
│   ├── app.js              # Main DSP pipeline + UI (52 sliders)
│   ├── dsp-worker.js       # AudioWorklet processor
│   ├── ml-worker.js        # ML inference worker (ONNX Runtime)
│   └── models/             # ONNX model files (download separately)
└── blueprint/              # Technical architecture docs
```

### The 52-Slider System

Sliders are organized into groups in `app.js`:

| Group | Sliders | Purpose |
|-------|---------|---------|
| `gate` | 6 | Noise gate controls |
| `nr` | 5 | Noise reduction parameters |
| `eq` | 10 | 10-band parametric EQ |
| `dyn` | 8 | Dynamics (compression/limiting) |
| `spec` | 8 | Spectral processing (filters, de-ess) |
| `adv` | 6 | Advanced (dereverb, harmonics, stereo) |
| `sep` | 5 | Voice separation controls |
| `out` | 4 | Output stage (gain, mix, dither) |

Each slider definition includes:
- `id`: Unique identifier (used in presets)
- `label`: Display name
- `min/max/val`: Value range and default
- `rt`: Real-time capable (wired to AudioParam)
- `desc`: Tooltip description

### Adding a New Slider

1. Add definition to appropriate group in `SLIDERS` constant
2. Add default value to all 7 presets in `PRESETS`
3. Wire it to DSP code in the processing pipeline
4. Run `npm run validate` to verify structural integrity

### ML Models

Models are loaded via ONNX Runtime Web. Place model files in `public/app/models/`:

- `silero_vad.onnx` - Voice activity detection (required for VAD)
- `enc.onnx`, `erb_dec.onnx`, `df_dec.onnx` - DeepFilterNet3 (all three required)
- `demucs_v4.onnx` - Vocal stem separation (WebGPU recommended)

See `public/app/models/README.md` for download instructions.

## Code Style

- Use single quotes for strings
- Use `setTargetAtTime()` (not `setValueAtTime()`) for slider-to-AudioParam wiring
- Always disconnect audio nodes on stop (prevents double playback)
- Use `typeof AudioContext !== 'undefined'` checks (not `window.AudioContext`)

## Testing

### Unit Tests

Tests are in `tests/` using Jest:

```bash
npm run test
```

Current test coverage:
- DSP math (FFT, Wiener, dither)
- Slider definitions (52 sliders, unique IDs)
- Preset completeness (all 7 presets cover all parameters)
- STAGES array (exactly 32 stages)

### Manual Testing

Always test with actual audio files:
1. Upload a test file (speech with background noise)
2. Process with "Podcast" preset
3. Verify no freezing/silence
4. A/B compare original vs processed
5. Check all sliders update audio in real-time

## Pull Request Guidelines

1. **Branch naming**: `feature/description` or `fix/description`
2. **Run checks before PR**:
   ```bash
   npm run lint
   npm run test
   npm run validate
   ```
3. **Keep PRs focused**: One feature or fix per PR
4. **Update tests**: Add tests for new functionality
5. **Update presets**: If adding sliders, update all 7 presets

## Architecture Constraints

These rules MUST be preserved:

1. **Single-pass spectral** - No additional STFT/iSTFT round-trips
2. **Privacy-first** - Zero external API calls during audio processing
3. **Audio cleanup** - Always disconnect nodes on stop/reset
4. **32-stage pipeline** - Stages execute in defined order

## Questions?

Open an issue or check the [Blueprint](public/blueprint/index.html) for detailed architecture documentation.

---

**Threads from Space v8** — Privacy-First — 2026

# VoiceIsolate Pro — Copilot Agent Instructions

## Project Identity
VoiceIsolate Pro is a browser-based, privacy-first voice isolation and audio processing platform.
Built on the **Threads from Space** multi-threaded DSP architecture.

## Architecture — Non-Negotiables
These constraints MUST be preserved in every PR and code change:

### 1. Single-Pass Spectral Architecture
- **ONE STFT → all spectral operations in-place → ONE iSTFT**
- NEVER introduce additional STFT/iSTFT round-trips — causes phase smearing and echo artifacts
- All spectral stages (13–19) operate on the same complex buffer between transforms

### 2. Threads from Space Concurrency
- Web Workers for CPU-bound DSP (thread pool via `ThreadManager`)
- WebGPU compute shaders for STFT/iSTFT and ML inference
- SharedArrayBuffer + ring buffer for AudioWorklet ↔ Worker zero-copy transfer
- Never block the main thread with DSP operations

### 3. Privacy-First Local Processing
- Zero external API calls during audio processing
- All ML models loaded from local ONNX files (no cloud inference)
- Content Security Policy blocks network during processing
- No telemetry, no analytics that includes audio data

### 4. Audio Node Cleanup
- Always disconnect gain nodes from `ctx.destination` on stop
- Fully tear down audio graph on stop/reset (prevents double playback)
- Use `typeof AudioContext !== 'undefined'` checks (not `window.AudioContext`)

## Tech Stack
- **Frontend**: Vanilla HTML/CSS/JS (single-file compatible with CodePen)
- **Audio**: Web Audio API, AudioWorklet, OfflineAudioContext
- **ML Runtime**: ONNX Runtime Web (WebGPU primary, WASM fallback)
- **3D Viz**: Three.js r128 (CDN)
- **Fonts**: Google Fonts (Outfit, JetBrains Mono)
- **Deployment**: Vercel (static site, `outputDirectory: public`)

## File Structure
```
public/
├── index.html          # Landing page / router
├── app/
│   ├── index.html      # Main app (Engineer Mode v19)
│   ├── style.css       # Red-dominant dark industrial theme
│   └── app.js          # 52 sliders, real-time DSP chain, 3D spectrogram
├── blueprint/
│   └── index.html      # v18 technical architecture blueprint
└── docs/
    ├── TECHNICAL_GUIDE.md
    └── v7.5-blueprint.md
```

## 32-Stage Octa-Pass Pipeline
Every code change must preserve these 8 passes in order:

| Pass | Stages | Function |
|------|--------|----------|
| 1. INGEST | 01–04 | Decode, buffer, noise profile, VAD |
| 2. ANALYSIS | 05–08 | STFT, pitch track, speaker embed, room analyze |
| 3. ML SEPARATION | 09–12 | Demucs, BSRNN, ensemble fusion, voiceprint gate |
| 4. SPECTRAL | 13–16 | Spectral subtract, ERB gate, hum eliminate, transient repair |
| 5. ROOM | 17–20 | Dereverb, room compensate, stereo recover, iSTFT |
| 6. TIME-DOMAIN | 21–24 | Dynamics, de-ess, gap fill, temporal coherence |
| 7. NEURAL | 25–28 | HiFi-GAN vocoder, formant preserve, conformer refine, A/B quality |
| 8. MASTER | 29–32 | LUFS normalize, voice HF boost, brick-wall limit, audit log |

## ML Models (ONNX Runtime Web)
- **Demucs v4.1**: Hybrid Transformer+U-Net source separation (~150MB INT8)
- **BSRNN**: Band-Split RNN secondary separation, ensemble partner
- **ECAPA-TDNN**: 256-dim speaker embeddings, cosine similarity gating (τ=0.65)
- **Silero VAD v5**: Voice activity detection (~2MB, sub-ms inference)
- **HiFi-GAN v2**: Neural vocoder for harmonic reconstruction
- **Conformer**: Spectral enhancement, residual artifact removal

## Slider System (52 Parameters)
The app.js defines 52 sliders across groups: gate (6), noise reduction (5), EQ (10+),
compression, de-ess, reverb, stereo, output. Each slider maps to Web Audio API AudioParams
via `setTargetAtTime()` for smooth real-time updates.

## Key Design Patterns
- **Noise gate**: Never set DynamicsCompressor threshold too aggressively — crushes audio to silence
- **Progress tracking**: Use percentage-based indicators, not stage numbers (stages execute out of order)
- **Web Audio chain**: Source → filter nodes → gainNode → destination (enables real-time slider updates)
- **Smart noise floor**: Profile from initial 500ms quiet segment via `NoiseProfiler`

## Three Execution Modes
1. **Live** (<10ms latency): AudioWorklet + SAB ring buffer, reduced pipeline
2. **Creator/Offline**: Full 32-stage pipeline, OfflineAudioContext, maximum quality
3. **Forensic**: Conservative settings + SHA-256 audit chain at every stage

## Code Quality Rules
- All code must be tested in sandbox before delivery
- Validate balanced braces, function counts, stage presence
- Single-file HTML preference for web deliverables (zero external deps beyond CDN fonts)
- Use `setTargetAtTime` (not `setValueAtTime`) for slider-to-param wiring during playback

## Monetization Tiers
- **Free**: 5 min/file, watermarked, One-Tap mode only
- **Creator Pro** ($12/mo): Unlimited, all presets, batch up to 100
- **Studio** ($29/mo): Engineer panel, API access, desktop app
- **Forensic** ($79/mo): Audit chain, chain-of-custody certification

## When Making Changes
1. Check that single-pass spectral architecture is preserved
2. Verify audio node cleanup on stop/reset
3. Run `npm run validate` (structural checks)
4. Test with actual audio file — confirm no freezing/silence
5. Verify all 52 sliders still wire to AudioParams correctly

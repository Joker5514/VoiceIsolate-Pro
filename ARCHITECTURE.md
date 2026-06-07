# VoiceIsolate Pro Architecture

## Overview

VoiceIsolate Pro is a voice isolation and audio enhancement platform built on the **Threads from Space Architecture**. The system uses multi-threaded DSP, GPU-accelerated processing, and ML-powered models.

**Repository**: [Joker5514/VoiceIsolate-Pro](https://github.com/Joker5514/VoiceIsolate-Pro)  
**Live Demo**: [v0-voice-isolate-pro.vercel.app](https://v0-voice-isolate-pro.vercel.app)  
**Current Version**: 24.0.0

---

## Current Architecture (v24.0)

### System Components

The codebase consists of **43 application modules**:

```
VoiceIsolate-Pro/
├── api/                      # API route handlers
├── api-routes/               # API route definitions
│   ├── nim/                  # NIM endpoints
│   └── sync.js               # Synchronization endpoint
├── public/
│   └── app/                  # Client-side (43 JS files)
│       ├── pipeline-orchestrator.js
│       ├── pipeline-state.js
│       ├── diarization-timeline.js
│       └── model-cdn-loader.js
├── android/                  # Android platform
└── .github/                  # GitHub workflows
```

### Processing Pipeline

**Current Single-Pass STFT Architecture**:

1. **Stage 10**: Single forward FFT
2. **Stages 10-12**: ML masking (single-frame [1,2049] magnitude masks)
3. **Final**: Single inverse FFT with 32 stages (in-place)

**Limitation**: Hard quality ceiling - cannot leverage multi-frame models (MDX-Net, Demucs, BS-Roformer).

### Model Inventory

| Model | Status | Type |
|-------|--------|------|
| silero_vad | ✅ Working | VAD |
| rnoise | ⚠️ Legacy | Noise Suppression |
| bsrnn_vocals | ⚠️ Legacy | Vocal Separation |
| demucs_v4 | ❌ Blocked | Separation |

---

## Architectural Limitations

1. **Single-Pass STFT**: No temporal context, fixed window size, phase smearing
2. **Configuration Drift**: vercel.json COEP mismatch, version drift (package.json 24.0.0 vs README v25.0)
3. **Live Mic Path**: Incompatible with multi-frame models
4. **Security**: Fixed in PR #584 (NIM auth, JWT validation, LICENSE_SECRET)

---

## Proposed Architecture (v25.0+)

### Key Decisions

1. **Drop Live Microphone Path**: Replace with record-then-process workflow
2. **Multi-Frame Models**: Use MDX-Net, DeepFilterNet with native STFT
3. **Real Checkpoints**: Production-quality models via Vercel Blob + WebGPU

### New Processing Pipeline

```
[File Upload] → [PCM Decode] → [Model-Native STFT + Overlap-Add] → [Diarization] → [DSP Polish] → [Export]
```

### Model Strategy

| Component | Proposed |
|-----------|----------|
| VAD | silero_vad (keep) |
| Noise Suppression | DeepFilterNet 2/3 |
| Vocal Separation | MDX-Net (primary) |
| Diarization | ECAPA-TDNN |

---

## Configuration

### Environment Variables

- `LICENSE_JWT_SECRET`: HMAC-SHA256 signing key (required)
- `VERCEL_ENV`: Deployment environment

### vercel.json Headers

```json
{
  "headers": [{
    "source": "/(.*)",
    "headers": [
      {"key": "Cross-Origin-Embedder-Policy", "value": "require-corp"},
      {"key": "Cross-Origin-Opener-Policy", "value": "same-origin"}
    ]
  }]
}
```

**Note**: COEP value must be consistent across vercel.json and all test files.

---

## Testing

- **Total**: 1,915 tests
- **Passing**: 1,904
- **Failing**: 11 (vercel.json config drift)
- **CI**: ci/validate (48s), ESLint, nodejsscan, semgrep

---

## References

- [PR #584 - Security Audit](https://github.com/Joker5514/VoiceIsolate-Pro/pull/584)
- [Redesign Proposal](https://drive.google.com/drive/folders/1E_0HZu-pD_6lGJ9keg3RhpwZ1zRhI5np)
























































































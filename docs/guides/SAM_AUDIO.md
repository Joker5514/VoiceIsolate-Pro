# SAM-Audio Integration Guide

## Decision

**Option B — local/self-hosted worker only.**

There is **no verified browser ONNX/WebGPU export** of Meta SAM-Audio in this repository. Claims of in-browser SAM are forbidden until a tested export + redistribution rights exist.

| Platform | SAM support |
|----------|-------------|
| Web/PWA | Local worker on `127.0.0.1` if user starts it; else USM/ONNX prompted path |
| Android | **No on-device SAM claim**; WebView uses shared ONNX/USM; optional private worker is advanced |
| Desktop Electron | Main process can spawn `services/sam-audio/server.py` on loopback |

## Modes

```text
SAM_AUDIO_MODE=disabled|browser|local-worker
```

- `disabled` (default for safety in docs; Electron may set `local-worker` when user starts worker)
- `browser` — always unavailable until real export lands (`BrowserSamAudioProvider`)
- `local-worker` — HTTP to loopback only

## Provider selection

```js
import { selectIsolationProvider } from '../core/providers/selectProvider.js';
import { runPromptedIsolation } from '../pipeline/PromptedIsolation.js';
```

Default offline isolation remains BSRNN / RNNoise / USM. SAM is additive for Creator/Forensic prompted isolation.

## Security

- Worker binds `127.0.0.1` only.
- Client rejects non-loopback URLs.
- No fal.ai / Replicate / public HF inference.
- HF tokens only in main/worker environment.
- No SAM inside AudioWorklet.

## STFT invariant

SAM worker returns **PCM stems**. It does not add STFT cycles inside the spectral single-pass path. USM classical fallback still uses one STFT/iSTFT via existing budget hooks.

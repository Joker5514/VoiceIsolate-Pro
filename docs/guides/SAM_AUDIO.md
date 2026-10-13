# SAM-Audio Integration Guide

## Decision

**Real SAM-Audio where the platform can run it; local fallbacks otherwise.**

| Platform | Real SAM path | Fallback |
|----------|---------------|----------|
| **Desktop Electron** | **Yes** — Meta `sam_audio` via local Python worker (CUDA/CPU). Electron IPC starts worker. | Mock separator if package/weights missing (dev/CI) |
| **Android** | **No.** There is no on-device SAM-Audio loader, so a `sam_audio.onnx` file is never used (and is excluded from the APK). | Classical USM query + BSRNN/RNNoise (always local) |
| **Web/PWA** | **No.** No ONNX loader; the page cannot reach a loopback worker (no CORS, Origin refused). | USM query priors |

No shipping page calls the prompted-isolation provider stack today; the
Desktop worker is reachable through `vipDesktop` IPC only.

There is **no cloud SAM** (no fal/Replicate). Live/AudioWorklet never runs SAM.

## Desktop — real SAM

```bash
# Install Meta SAM-Audio per upstream docs, then:
set SAM_AUDIO_MODEL=facebook/sam-audio-small
set SAM_AUDIO_DEVICE=cuda
python services/sam-audio/server.py --port 8765
# Or from Electron: vipDesktop.samWorkerStart()
```

Set `SAM_AUDIO_REQUIRE_REAL=1` to refuse mock fallback.

## Android / Web — no on-device SAM

A SAM-Audio ONNX path would need a loader with a multi-input (audio + text
prompt) tensor contract, a pinned SHA-256 in `ModelManifest.js`, and a
provider that selects it. None exist yet. `getSamPlatformCapabilities()`
reports a present file as `present-but-unsupported`, and Android packaging
excludes `sam_audio.onnx`. USM + BSRNN remain fully local.

## Modes

```text
SAM_AUDIO_MODE=disabled|browser|local-worker|auto
```

- `disabled` — USM/ONNX only
- `auto` — worker if healthy, else USM/ONNX (Desktop Electron defaults toward worker)
- `local-worker` — require loopback worker
- `browser` — only if verified browser export exists (currently not)

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

# Local SAM-Audio Worker (production)

Private **localhost-only** worker for Creator / Forensic / Desktop prompted isolation.
Uses Meta **sam_audio** when installed + HF-gated weights are authorized.

## Production setup (Desktop)

```bash
# 1) Shared FFmpeg (Windows torchcodec) + .venv-sam + official package
pnpm sam:setup

# 2) Meta gated weights — request access then:
hf auth login
# or: set HF_TOKEN / HUGGING_FACE_HUB_TOKEN

# 3) Production worker (real model required; mock blocked)
pnpm sam:worker -- --production --preload
# or:
set SAM_AUDIO_PRODUCTION=1
set SAM_AUDIO_ALLOW_MOCK=0
pnpm sam:worker
```

### Health

```bash
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8765/capabilities
curl http://127.0.0.1:8765/ready
```

`capabilities.real === true` means Meta weights loaded.  
`production: true` with `real: false` → `/ready` returns **503** (no silent mock).

## Dev / CI (mock allowed)

```bash
set SAM_AUDIO_ALLOW_MOCK=1
set SAM_AUDIO_PRODUCTION=0
pnpm sam:worker
```

Deterministic mock separator keeps integration tests green without GPU/HF.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `SAM_AUDIO_MODE` | `local-worker` | or `disabled` |
| `SAM_AUDIO_HOST` | `127.0.0.1` | loopback only |
| `SAM_AUDIO_PORT` | `8765` | |
| `SAM_AUDIO_MODEL` | `facebook/sam-audio-small` | HF model id |
| `SAM_AUDIO_DEVICE` | `auto` | `cuda` / `cpu` |
| `SAM_AUDIO_PRODUCTION` | `0` (Electron desktop defaults `1`) | require real model |
| `SAM_AUDIO_ALLOW_MOCK` | `1` unless production | CI/dev mock |
| `SAM_AUDIO_PRELOAD` | `0` | warm-load at start |
| `SAM_AUDIO_REQUIRE_REAL` | off | same as production fail-closed |
| `VIP_FFMPEG_SHARED_BIN` | auto | shared FFmpeg DLLs (Windows) |
| `HF_TOKEN` | — | gated Meta weights |

## Architecture notes

- **PCM tensors only** — worker never decodes audio files, so torchcodec can run in **stub** mode on Windows.
- **`torchcodec_bootstrap.py`** — prepends shared FFmpeg; installs stub if native fails.
- **`sam_hub_compat.py`** — fixes hub 1.x vs sam_audio `proxies`/`resume_download` break (facebookresearch/sam-audio#89).
- **No cloud SAM** — all audio stays on-device / loopback.
- **No AudioWorklet SAM** — DSP worklets never load SAM.
- **Browser** — does not claim real SAM without verified ONNX at `/app/models/sam_audio.onnx`.

## Security

- Binds loopback only (non-loopback host forced to 127.0.0.1).
- Does not log audio or prompts.
- HF tokens only in process env / Electron main — never frontend JS.
- Web client refuses non-loopback worker base URLs.
- No CORS. Requests with an `Origin` header, a non-loopback `Host`, or a POST
  body that is not `application/json` are refused (403/415), so a web page
  cannot drive the worker (cross-origin, preflight, or DNS rebinding).
- Job ids must match `[A-Za-z0-9._:-]{1,128}`; clients use random UUIDs. A
  cancel is remembered for at most 10 min / 1024 ids and cleared when its job
  finishes. Cancellation is checked before and after inference; it cannot
  interrupt a running `model.separate` call.
- Text prompts only: `mode` other than `text`, or any `anchors`, answers 400
  `unsupported-targeting` (span/visual prompting is not implemented).
- One request body is at most 64 MiB, so a job is at most 12,582,144 samples
  (about 262 s at 48 kHz) of base64 float32.

## Electron

Main process starts/stops the worker via IPC (`vip:sam-worker-*`).  
Separation and cancellation also go through the main process
(`vip:sam-worker-separate` / `vip:sam-worker-cancel`, `electron/sam-proxy.cjs`):
the renderer CSP blocks loopback fetches, and the worker has no CORS.  
Desktop defaults: `SAM_AUDIO_PRODUCTION=1`, `ALLOW_MOCK=0`, `--preload`.

## Android / Browser

- **Browser:** no transport. The page CSP blocks loopback and the worker answers no CORS, so the provider reports `browser-transport-unavailable` and selection falls back to USM/ONNX; no silent “browser SAM” claim. Node tools can still call the worker directly.
- **Android:** optional on-device ORT when `sam_audio.onnx` is present; else USM/BSRNN. Real Desktop-class SAM is the Python worker on a private host (advanced).

## Package identity

Shipped as `@voiceisolate/vip-sam-runtime` on web, Android, and desktop builds  
(`public/app/models/sam-runtime.marker.json`).

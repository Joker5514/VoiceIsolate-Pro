# Local SAM-Audio Worker (Option B)

Private **localhost-only** worker for Creator / Forensic / Desktop prompted isolation.

## Defaults

```bash
SAM_AUDIO_MODE=local-worker   # or disabled
SAM_AUDIO_HOST=127.0.0.1
SAM_AUDIO_PORT=8765
SAM_AUDIO_MODEL=facebook/sam-audio-small
SAM_AUDIO_DEVICE=auto
```

## Run

```bash
# Mock separator (no gated weights) — used in CI/dev
python services/sam-audio/server.py --port 8765

# Health
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8765/capabilities
```

## Security

- Binds loopback only.
- Does not log audio or prompts.
- HF tokens must live in process env / main process — never in frontend JS.
- Web client refuses non-loopback base URLs.

## Electron

Main process can start/stop this worker via IPC (`vip:sam-worker-*`). Renderer only receives status + base URL through preload.

## Android / Browser

- **Browser:** no verified SAM ONNX — use this worker if running on the same machine, else USM/ONNX.
- **Android:** does not claim on-device SAM; optional reverse-tunnel to a private worker is advanced/manual.

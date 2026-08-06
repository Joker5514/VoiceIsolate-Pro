# SAM 3 local model assets

Optional **vision/video** weights for VoiceIsolate Pro’s SAM 3 sidecar  
(`src/sam3_integration/`). This is **not** SAM-Audio sound separation.

## Rules

- Ship only **licensed**, browser-compatible assets under this directory.
- Runtime allowlist: same-origin `/app/models/sam3/*` only.
- No Hugging Face / fal / Replicate / CDN fetches during inference.

## Enable

```text
VIP_SAM3_ENABLED=1
# or browser: localStorage.setItem('vip-sam3-enabled','1')
# or ?sam3=1
```

Without weights the sidecar runs a **local heuristic** (explicit `ready-heuristic` status).

## Platforms

This folder is copied into `build/` for **Web**, **Android** (Capacitor), and **Desktop** (Electron).

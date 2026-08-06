# @voiceisolate/vip-sam-runtime

The **SAM-Audio runtime package** shipped with VoiceIsolate Pro on:

- Web / PWA  
- Android (Capacitor shared renderer)  
- Desktop (Electron)

This package is the **program-side** SAM integration (contracts, paths, manifests).  
**Model weights** are gated by Meta and install via Hugging Face after access is granted.

## Desktop (real Meta SAM — production)

```bash
pnpm sam:setup            # FFmpeg shared + .venv-sam + official sam-audio
hf auth login             # after HF access to facebook/sam-audio-*
pnpm sam:worker -- --production --preload
# or Electron vipDesktop.samWorkerStart()  (production defaults)
```

Dev/CI mock (no HF weights):

```bash
set SAM_AUDIO_ALLOW_MOCK=1
pnpm sam:worker
```

## Android / Web (on-device ORT)

Place licensed ONNX at `public/app/models/sam_audio.onnx` then rebuild:

```bash
pnpm build
pnpm cap:sync
```

Without ONNX, prompted isolation still runs fully local via USM + BSRNN.

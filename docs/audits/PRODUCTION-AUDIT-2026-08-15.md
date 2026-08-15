# VoiceIsolate Pro — Production Audit 2026-08-15

Evidence-based audit of Google Drive docs, GitHub `main`, and Vercel project `voice-isolate-pro`.  
Fixes limited to defects with direct evidence (see PR `audit/prod-e2e-2026-08-15`).

| Field | Evidence |
|-------|----------|
| **Production commit** | `99461b319b6cb9278ada1c896de6206a72229de1` (Vercel READY, `main`) |
| **Deploy source** | `vercel.json` `outputDirectory: "public"` + `scripts/vercel-build.js` → `src/` → `public/src/` |
| **Domain** | https://voice-isolate-pro.vercel.app/ |
| **COOP/COEP** | Present on `/`, `/app/app.js`, worklets, WASM (curl HEAD 2026-08-15) |
| **Default ML** | `DEFAULT_ML_CHAIN = ['bsrnn_vocals']` → `fused-spectral-single-stft` in MLWorker |
| **Playback worklets** | `/src/workers/GateProcessor.js`, `DeEsserProcessor.js` only |
| **Mic** | `Permissions-Policy: microphone=()` |

## Defects fixed in accompanying PR

| ID | Severity | Fix |
|----|----------|-----|
| D-01 | High | Stub `public/app/voice-isolate-processor.js` so URL is real JS, not SPA HTML |
| D-02 | High | Stop forcing `Content-Type: text/javascript` on all `*.js` (mislabels HTML bodies) |
| D-03 | Medium | CLAUDE.md Live Mode / STFT claims aligned with upload-only + fused ML path |

## Residual risks (not fixed — product decision)

| Risk | Notes |
|------|--------|
| Legacy `public/app/ml-worker.js` still served | Active path is `/src/workers/MLWorker.js`; legacy remains for debug-audit reachability |
| Multi-model serial chains | Demucs / mixed chains use multi-STFT by design (`serial-mixed`) |
| Sub-10 ms Live isolation | Not a shipping product path (upload-only) |
| Blob model hosting | ONNX via Vercel Blob rewrite; audio never uploaded |

Full tables: see PR body / agent final report.

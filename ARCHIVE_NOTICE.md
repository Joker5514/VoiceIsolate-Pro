# Archive Notice — Root-Level Dead Files Removed

**Date:** 2026-04-12  
**Audit:** VoiceIsolate Pro Full Audit & Debug Report  
**Branch:** fix/audit-cleanup-dead-files-v8

## Files Removed from Root

The following root-level files were **stale duplicates** of canonical files inside `public/app/`.
Vercel `outputDirectory: "public"` means these root files were **never served** in any deployment.
They existed only in the git tree, consuming ~186 KB and creating developer confusion about
which file is the real implementation.

| Removed File | Canonical Replacement | Why Removed |
|---|---|---|
| `app.js` (84 KB) | `public/app/app.js` (116 KB) | Stale copy, older architecture |
| `dsp-core.js` (50 KB) | `public/app/dsp-core.js` (47.9 KB) | Stale copy, diverged from served version |
| `style.css` (16 KB) | `public/app/style.css` | Stale copy |
| `voice-isolate-processor.js` (9 KB) | `public/app/voice-isolate-processor.js` (14.9 KB) | v20 ring-buffer arch, superseded by v2 STFT worklet |
| `ml-worker.js` (13 KB) | `public/app/ml-worker.js` (28.6 KB) | Stale copy, missing ONNX WebGPU boot |
| `dsp-worker.js` (14 KB) | `public/app/dsp-processor.js` | Different filename, old arch |

## TypeScript → JavaScript

`voiceisolate_presets.ts` had no build step and was dead at runtime.
Converted to `voiceisolate_presets.js` (same content, type annotations stripped).
The original `.ts` file is preserved as `voiceisolate_presets.ts.bak.md` for reference.

## Vercel Deployment Verification

- `outputDirectory: "public"` — only `public/**` is served
- COOP/COEP headers confirmed present in `vercel.json`
- `voice-isolate-processor.js` and `dsp-processor.js` both covered by no-cache + JS content-type rule
- WASM files: `application/wasm` + `immutable` caching
- ONNX models: `application/octet-stream` + `immutable` caching
- CSP updated: `wasm-unsafe-eval` added for onnxruntime-web WebGPU path

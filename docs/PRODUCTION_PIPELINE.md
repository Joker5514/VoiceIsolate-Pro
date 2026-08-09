# Production pipeline (shipping)

**Version:** 25.0.1+  
**Privacy:** All audio, spectrograms, embeddings, and stems stay on-device. Upload-only (no product microphone).

## Shipping path (production)

1. **Ingest** — `FileIngestion` / Engineer deferred `ensureDecoded` (local decode only).  
2. **ML isolation** — `src/workers/MLWorker.js` via `StemSeparation` / Engineer `_runMLIsolationPipeline`.  
3. **Spectral-mask models** (`strategy: 'spectral-mask'`, shared STFT geometry, e.g. `bsrnn_vocals` + `rnnoise`):  
   - **One forward STFT** per channel  
   - All mask heads run on the same complex magnitudes  
   - Masks fused by **product** in-domain  
   - **One inverse STFT** + OLA  
4. **Waveform-only branch** (`strategy: 'waveform'`, e.g. optional Demucs):  
   - Separate path; **does not** claim single-STFT invariants.  
5. **Live-Mix** — `PlaybackMixer` AudioParams only (no re-ML).  
6. **Target speaker** (optional) — local mel voiceprint enrollment + soft gain (no re-STFT).  

### ORT backend

WebGPU preferred, WASM fallback. UI shows `engOrtPill` + `#ortBackendLabel` (`WebGPU` / `WASM`) and `#activeModelChain`.

## Experimental / not production spectral claims

| Path | Flag | Notes |
|------|------|--------|
| Engineer offline `_spectralStageAsync` DSP STFT | `VIP_EXPERIMENTAL_ENGINEER_SPECTRAL` or `localStorage vip-experimental-engineer-spectral=1` or whisperMode ≥ 2 on DSP fallback | Extra STFT cycle; **not** the shipping single-STFT claim |
| Legacy live SAB ring / multi-thread WASM | Requires SAB + COOP/COEP | Optional; Android WebView often lacks SAB |

## STFT counters

MLWorker posts `stftCounts: { forward, inverse }` and `pipelineMode` on each `stems` message.  
Fused path: `pipelineMode: 'fused-spectral-single-stft'` with forward/inverse = channel count (one cycle per channel).

## Privacy CI

```bash
pnpm check:privacy   # getUserMedia + cloud audio backends
pnpm check:cloud-audio
```

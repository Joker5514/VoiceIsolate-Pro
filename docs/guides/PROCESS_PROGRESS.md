# Process progress, cancellation, and worker terminal contract

Engineer Mode / Electron desktop processing must never leave the UI frozen at **~88%** after ML isolation. Post-ML finalization is cooperative and reports truthful stage progress through **100%**.

## Production Process path (authoritative)

```
public/app/index.html
  → classic: public/app/dsp-core.js   (window.DSPCore math only)
  → module:  public/app/app.js
       → Process (runPipeline)
            → src/pipeline/StemSeparation.js
                 → src/pipeline/MLWorkerHost.js
                      → src/workers/MLWorker.js  (fused-spectral-single-stft)
            → post-ML: expand / dewhistle / stemsToAudioBuffer (cooperative)
            → Complete (100%) then deferred FullAnalysis
```

**Not on the production path:** `public/app/dsp-stages.js` (quarantined), `public/app/offline-processor.js` (legacy), historical `DSPChain`, and `public/app/ml-worker.js` (legacy Engineer worker — canonical is `src/workers/MLWorker.js`). Guarded by `tests/production-dsp-import-graph.test.js`.

## Weighted progress model

| Band | Stage |
|------|--------|
| 0–8% | Decode / preparation (`ensureDecoded`) |
| 8–82% | ONNX isolation (`separateStems` / MLWorker) — mapped via `_mapMlProgressPercent` |
| 82–90% | Post-isolation stereo expand / cleanup (`_expandMonoCleanToStereo`) |
| 90–97% | Residual dewhistle + stem `AudioBuffer` rebuild + Live-Mix load |
| 97–100% | Output safety + playback activation (`Complete` only when buffers ready) |

DSP **fallback** (when ML unavailable) also reports 90→100 cooperatively and must never pin a live job at 88%.

**Rule:** do not mark 100% until `outputBuffer` / Live-Mix path is ready. Progress updates must `await yieldToBrowser()` so Electron can paint.

## Cancellation

- Overlay **Cancel** → `JobController` aborts the current signal.
- `runPipeline` mirrors the signal onto `abortFlag`.
- Post-ML loops call `_throwIfProcessAborted()` / `processInChunks({ signal })`.
- `AbortError` / `CancellationError` → status **Cancelled** (not a processing failure).
- MLWorker `cancel` → terminal `cancelled` message; `StemSeparation` rejects with `AbortError`.

## Worker terminal-message contract (`StemSeparation` ↔ `MLWorker`)

For each `requestId` (unique per job):

| Message | Meaning |
|---------|---------|
| `progress` / `stage` | Non-terminal; refreshes stall watchdog |
| `stems` | Success (exactly one; includes `backend`) |
| `error` | Failure (exactly one) |
| `cancelled` | Cancelled (exactly one) |

> Note: success is `stems` (not a generic `done`) — this is the documented VIP terminal success type.

Host requirements:

- Pass `AbortSignal` into `separateStems`; on abort post `{ type: 'cancel', requestId }`.
- Ignore stale `requestId`s; reject late `stems` after cancel (no false complete).
- Listen for `error` and `messageerror`.
- Clear timeout + stall `setInterval` (+ cancel grace timer) in `cleanup`.
- Missing terminal message → stall/timeout rejects; overlay cleared in `runPipeline` `finally`.
- Large PCM transfers use `postMessage(..., transferList)` (owned buffers).

ONNX recovery: prefer WebGPU; on session/device/OOM failure perform **one** local WASM retry (`ort-fallback` stage). Never endlessly retry WebGPU; never recreate sessions on the renderer thread.

## Deferred auto-analysis

After **Complete (100%)**:

- Mobile: auto full-analysis is **skipped** (user taps Analyze).
- Desktop / Electron: analysis is scheduled via `requestIdleCallback` / delayed timeout and deduped with `_deferredAnalysisFileSeq`.
- Analysis failure is nonfatal — processed audio stays available.

## Local diagnostics

Enable in DevTools:

```js
localStorage.setItem('vip-debug-progress', '1');
// or: globalThis.VIP_DEBUG_PROGRESS = true;
```

Logs `[VIP][progress]` objects with `jobId`, stage, stage start/end, `elapsedMs`, percent, ORT `provider`, abort reason, desktop/mobile flags. **No network / no telemetry upload.**

## Key utilities

- `src/pipeline/ui-yield.js` — `yieldToBrowser`, `createYieldBudget`, `throwIfAborted`, `processInChunks`
- Desktop Electron chunk size: **1 s** (`_postMlChunkSamples`) so the renderer stays responsive

## Reproduce progress stalls

```bash
node scripts/debug-progress-stall.cjs 60
```

Expect progress to advance past 88% and complete (or cancel cleanly).

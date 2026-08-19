# Process progress, cancellation, and worker terminal contract

Engineer Mode / Electron desktop processing must never leave the UI frozen at **~88%** after ML isolation. Post-ML finalization is cooperative and reports truthful stage progress through **100%**.

## Weighted progress model

| Band | Stage |
|------|--------|
| 0–8% | Decode / preparation (`ensureDecoded`) |
| 8–82% | ONNX isolation (`separateStems` / MLWorker) — mapped via `_mapMlProgressPercent` |
| 82–90% | Stereo expand (`_expandMonoCleanToStereo`) |
| 90–96% | Residual / dewhistle (`_postIsolationDeWhistle`) |
| 96–98% | Build `AudioBuffer` + Live-Mix stem load |
| 98–99% | Output safety limit |
| 100% | Playable/exportable buffers ready (`Complete`) |

**Rule:** do not mark 100% until `outputBuffer` / Live-Mix path is ready. Progress updates must `await yieldToBrowser()` so Electron can paint.

## Cancellation

- Overlay **Cancel** → `JobController` aborts the current signal.
- `runPipeline` mirrors the signal onto `abortFlag`.
- Post-ML loops call `_throwIfProcessAborted()` / `processInChunks({ signal })`.
- `AbortError` / `CancellationError` → status **Cancelled** (not a processing failure).
- MLWorker `cancel` → terminal `cancelled` message; `StemSeparation` rejects with `AbortError`.

## Worker terminal-message contract (`StemSeparation` ↔ `MLWorker`)

For each `requestId`:

| Message | Meaning |
|---------|---------|
| `progress` / `stage` | Non-terminal; refreshes stall watchdog |
| `stems` | Success (exactly one) |
| `error` | Failure (exactly one) |
| `cancelled` | Cancelled (exactly one) |

Host requirements:

- Ignore stale `requestId`s.
- Listen for `error` and `messageerror`.
- Clear timeout + stall `setInterval` in `cleanup` / `finally`.
- Never leave progress capped at 88% after error/cancel — overlay is cleared in `runPipeline` `finally`.

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

Logs `[VIP][progress]` objects with `jobId`, stage, percent, desktop/mobile flags. **No network.**

## Key utilities

- `src/pipeline/ui-yield.js` — `yieldToBrowser`, `createYieldBudget`, `throwIfAborted`, `processInChunks`
- Desktop Electron chunk size: **1 s** (`_postMlChunkSamples`) so the renderer stays responsive

## Reproduce progress stalls

```bash
node scripts/debug-progress-stall.cjs 60
```

Expect progress to advance past 88% and complete (or cancel cleanly).

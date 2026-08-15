# MOPE / processing cancellation & desktop responsiveness

## Bottlenecks (desktop Prompt / MOPE path)

| Issue | Where | Mitigation |
|-------|--------|------------|
| Re-init MLWorker every process | `ProcessingOrchestrator.initialize` | Shared `_initPromise` / `_initialized` |
| SAM `/ready` probe every job | `selectProvider.js` | 15s capability cache |
| No stem soft-cache for standard mode | Orchestrator | Session `_stemCache` (file+options key) |
| Main-thread freeze during analysis | FullAnalysis | Worker + heartbeats (existing) + cancel |
| Overlay without Cancel | `processing-overlay` | Cancel button + JobController |

## JobController (`src/pipeline/JobController.js`)

- One active job; `beginJob` supersedes prior.
- `AbortSignal` via `job.controller.signal`.
- `updateJob(jobId, …)` ignores stale IDs.
- `CancellationError` / `isCancellationError` for non-error UX.
- Exposed as `globalThis.__VIP_JOBS__` for classic overlay script.

## Cancel propagation

```
UI Cancel → JobController.cancelCurrent()
         → AbortSignal abort
         → ProcessingOrchestrator / FullAnalysisHost onAbort
         → MLWorker / FullAnalysisWorker { type: 'cancel', requestId }
         → LocalSamAudioWorkerProvider /cancel + fetch abort
```

Stale results: workers/hosts ignore non-matching `requestId`; JobController rejects non-current UI updates.

## Manual test checklist

1. Engineer Process → overlay shows Cancel; Cancel → notification “cancelled”, not hard error; Process again works.
2. Analyze → Cancel mid-run → cancelled state; re-Analyze works.
3. Desktop MOPE/prompted isolation twice on same file (standard mode) → second may hit stem cache (metadata.fromCache).
4. Desktop SAM worker: second MOPE should not re-probe `/ready` for ~15s.
5. Focus returns to prior control after overlay hides.
6. Process buttons disabled while overlay active.

## Privacy

All local; timings via `debugLog` only; no network telemetry.

/**
 * DEAD ENTRY — historical live-mic spectral worklet (removed).
 *
 * Production playback worklets:
 *   - /src/workers/GateProcessor.js   (registerProcessor 'vip-gate')
 *   - /src/workers/DeEsserProcessor.js (registerProcessor 'vip-deesser')
 *
 * This file exists so production never serves SPA HTML for this URL with a
 * JavaScript Content-Type (false 200 + HTML body), which would poison
 * AudioWorklet module registration if a stale client still requested the path.
 */
/* eslint-disable no-undef */
throw new Error(
  '[VIP] voice-isolate-processor.js is retired. '
  + 'Use GateProcessor/DeEsserProcessor for playback worklets; '
  + 'ML isolation is offline via /src/workers/MLWorker.js.',
);

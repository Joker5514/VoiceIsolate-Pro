/** Lightweight, privacy-safe ingestion diagnostics shared by Stems and Engineer. */

export const INGEST_EVENTS = Object.freeze([
  'ingest.start',
  'ingest.demux',
  'ingest.decode.start',
  'ingest.decode.chunk',
  'ingest.decode.complete',
  'ingest.metadata.validate',
  'ingest.worker.transfer',
  'ingest.provider.verify',
  'ingest.ready',
  'ingest.failed',
  'ingest.decoded',
]);

/**
 * Structured ingest event. Scalars only: no PCM, no file bytes.
 * Also forwards to the Stems/Engineer diagnostics panel when it is mounted.
 * @param {string} event
 * @param {object} [details]
 * @param {'info'|'warn'|'error'} [level]
 */
export function traceIngest(event, details = {}, level = 'info') {
  const safe = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) safe[key] = value;
  }
  emitIngestionDebug(event, safe);
  try {
    const log = globalThis.VIP_liveDiagnostics?.log;
    if (typeof log === 'function') log(level, event, safe);
  } catch { /* diagnostics must never affect ingestion */ }
}

export function emitIngestionDebug(stage, details = {}) {
  try {
    if (typeof globalThis.dispatchEvent !== 'function' || typeof globalThis.CustomEvent !== 'function') return;
    const safe = {};
    for (const [key, value] of Object.entries(details || {})) {
      if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) safe[key] = value;
    }
    globalThis.dispatchEvent(new CustomEvent('vip:ingestion-debug', {
      detail: { stage: String(stage), at: Date.now(), ...safe },
    }));
  } catch { /* diagnostics must never affect ingestion */ }
}

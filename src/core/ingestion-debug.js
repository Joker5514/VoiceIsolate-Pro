/** Lightweight, privacy-safe ingestion diagnostics shared by Stems and Engineer. */
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

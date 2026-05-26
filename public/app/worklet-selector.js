/**
 * worklet-selector.js — Canonical AudioWorklet resolver
 * ======================================================
 * AUDIT FIX #1: Two AudioWorkletProcessor files exist:
 *   - dsp-processor.js       (21 KB) — CANONICAL for Live mode
 *     Full 32-stage Octa-Pass pipeline, SharedArrayBuffer ring-buffer,
 *     WebGPU ONNX offload path, all 52 slider parameters.
 *   - voice-isolate-processor.js (10 KB) — SAB-UNAVAILABLE fallback
 *     Lightweight spectral gate + Wiener filter. Used ONLY when
 *     crossOriginIsolated === false (SAB blocked by missing COOP/COEP).
 *
 * USAGE in app.js:
 *   import { resolveWorkletUrl } from './worklet-selector.js';
 *   await audioContext.audioWorklet.addModule(resolveWorkletUrl());
 *
 * NEVER call addModule() with a hard-coded path — always use this module.
 * This prevents the InvalidStateError: "A processor with that name already
 * exists" that occurs when both processors are registered in the same
 * AudioWorkletGlobalScope.
 */

'use strict';

/**
 * Returns the URL of the AudioWorklet processor file appropriate for the
 * current browser environment.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forceFallback=false]  Force the lightweight fallback
 *   (useful for testing the fallback path without disabling COOP/COEP).
 * @param {boolean} [opts.verbose=false]  Log the selected processor to console.
 * @returns {string}  Relative URL ready for audioContext.audioWorklet.addModule()
 */
export function resolveWorkletUrl({ forceFallback = false, verbose = false } = {}) {
  const sabAvailable = (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated === true
  );

  const useFallback = forceFallback || !sabAvailable;

  const url = useFallback
    ? './voice-isolate-processor.js'   // Lightweight: no SAB needed
    : './dsp-processor.js';            // Full pipeline: SAB + ring-buffer

  if (verbose || (typeof location !== 'undefined' && location.hostname === 'localhost')) {
    const reason = useFallback
      ? (forceFallback ? 'forced' : `crossOriginIsolated=${typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'undefined'}`)
      : 'crossOriginIsolated=true';
    console.info(
      `[worklet-selector] Using ${url.split('/').pop()} (${reason})`,
      { sabAvailable, crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'N/A' }
    );
  }

  return url;
}

/**
 * Returns a human-readable label for the active processor.
 * Used by the debug-audit.js and processing-overlay.js UIs.
 * @returns {'full-pipeline'|'lightweight-fallback'}
 */
export function activeProcessorMode() {
  return (typeof SharedArrayBuffer !== 'undefined' && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated)
    ? 'full-pipeline'
    : 'lightweight-fallback';
}

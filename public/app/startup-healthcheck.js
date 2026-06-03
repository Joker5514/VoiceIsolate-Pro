/**
 * VoiceIsolate Pro — startup-healthcheck.js
 * ==========================================
 * Pre-flight capability checks before the audio pipeline starts.
 * All checks are non-destructive — they probe, never allocate permanent resources.
 *
 * Usage:
 *   import { runStartupHealthcheck } from './startup-healthcheck.js';
 *   const result = await runStartupHealthcheck();
 *   if (!result.ok) { showFatalBanner(result.failures); return; }
 */

/**
 * @typedef {Object} HealthCheckResult
 * @property {boolean} ok          - true only when ALL required checks pass
 * @property {string[]} failures   - human-readable failure messages
 * @property {string[]} warnings   - non-fatal degraded-mode warnings
 * @property {Object}  capabilities - detailed per-feature flags
 */

/**
 * Verify that the AudioWorklet API is available.
 * This does NOT create an AudioContext — just probes the constructor.
 * @returns {{ ok: boolean, message: string }}
 */
export function verifyWorklet() {
  const ok = (
    typeof AudioContext !== 'undefined' &&
    typeof AudioContext.prototype.audioWorklet !== 'undefined'
  ) || (
    typeof window !== 'undefined' &&
    typeof window.AudioContext !== 'undefined' &&
    typeof window.AudioContext.prototype.audioWorklet !== 'undefined'
  );
  return {
    ok,
    message: ok ? 'AudioWorklet: available' : 'AudioWorklet: unavailable (browser too old or insecure context)',
  };
}

/**
 * Verify SharedArrayBuffer and Atomics are available (requires COOP+COEP).
 * @returns {{ ok: boolean, message: string }}
 */
export function verifySharedArrayBuffer() {
  const sabOk = typeof SharedArrayBuffer !== 'undefined';
  const atomicsOk = typeof Atomics !== 'undefined';
  const isoOk = typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : sabOk;

  const ok = sabOk && atomicsOk && isoOk;
  let message;
  if (!sabOk) {
    message = 'SharedArrayBuffer: unavailable — check COOP/COEP headers';
  } else if (!atomicsOk) {
    message = 'Atomics: unavailable — check COOP/COEP headers';
  } else if (!isoOk) {
    message = 'SharedArrayBuffer: available but crossOriginIsolated=false (COOP/COEP headers missing)';
  } else {
    message = 'SharedArrayBuffer: available and cross-origin isolated';
  }
  return { ok, message };
}

/**
 * Verify ONNX Runtime Web is loaded and functional.
 * @returns {{ ok: boolean, message: string }}
 */
export function verifyInferenceEngine() {
  const ortPresent = (
    (typeof window !== 'undefined' && typeof window.ort !== 'undefined') ||
    (typeof self !== 'undefined' && typeof self.ort !== 'undefined') ||
    (typeof ort !== 'undefined')
  );
  const ok = ortPresent;
  return {
    ok,
    message: ok
      ? 'ONNX Runtime: loaded'
      : 'ONNX Runtime: not loaded — /lib/ort.min.js may be missing',
  };
}

/**
 * Verify AudioContext can be created (requires user gesture — call AFTER one).
 * @param {AudioContext|null} existingCtx - pass an existing ctx to avoid double-create
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function verifyAudioContext(existingCtx = null) {
  try {
    const CtxClass = window.AudioContext || window.webkitAudioContext;
    if (!CtxClass) return { ok: false, message: 'AudioContext: constructor unavailable' };

    let ctx = existingCtx;
    let owned = false;
    if (!ctx) {
      ctx = new CtxClass({ latencyHint: 'interactive', sampleRate: 48000 });
      owned = true;
    }

    if (ctx.state === 'suspended') await ctx.resume();
    const ok = ctx.state === 'running';

    if (owned) {
      ctx.close().catch(() => {});
    }

    return {
      ok,
      message: ok
        ? `AudioContext: running at ${ctx.sampleRate}Hz`
        : `AudioContext: state=${ctx.state} (not running)`,
    };
  } catch (err) {
    return { ok: false, message: `AudioContext: creation failed — ${err.message}` };
  }
}

/**
 * Verify that the ML worker path is reachable via a HEAD request.
 * Non-blocking — returns ok=true when offline to avoid false negatives.
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function verifyWorker() {
  try {
    const res = await fetch('/app/ml-worker.js', { method: 'HEAD', cache: 'no-store' });
    const ok = res.ok;
    return {
      ok,
      message: ok
        ? 'ML worker: reachable'
        : `ML worker: unreachable — HTTP ${res.status}`,
    };
  } catch (err) {
    // Network offline or blocked — treat as warning, not hard failure
    return {
      ok: true,
      message: `ML worker: network check skipped (${err.message}) — offline mode`,
    };
  }
}

/**
 * Verify that committed ONNX model files are present.
 * @returns {Promise<{ ok: boolean, message: string, present: string[], missing: string[] }>}
 */
export async function verifyModels() {
  const models = [
    '/app/models/silero_vad.onnx',
    '/app/models/rnnoise_suppressor.onnx',
    '/app/models/bsrnn_vocals.onnx',
  ];

  const results = await Promise.allSettled(
    models.map(url =>
      fetch(url, { method: 'HEAD', cache: 'no-store' })
        .then(r => ({ url, ok: r.ok, status: r.status }))
        .catch(() => ({ url, ok: false, status: 0 }))
    )
  );

  const present = [];
  const missing = [];
  for (const r of results) {
    const { url, ok } = r.value || {};
    if (ok) present.push(url);
    else missing.push(url);
  }

  const ok = missing.length === 0;
  return {
    ok,
    message: ok
      ? `Models: all ${present.length} committed models present`
      : `Models: ${missing.length} missing — ${missing.join(', ')}`,
    present,
    missing,
  };
}

/**
 * Run all health checks in parallel and aggregate the result.
 * Critical checks (AudioWorklet, SAB) are required.
 * Warning checks (models, worker) degrade gracefully.
 *
 * @param {{ skipAudioContext?: boolean, skipNetwork?: boolean }} opts
 * @returns {Promise<HealthCheckResult>}
 */
export async function runStartupHealthcheck(opts = {}) {
  const [worklet, sab, ort] = [
    verifyWorklet(),
    verifySharedArrayBuffer(),
    verifyInferenceEngine(),
  ];

  const networkChecks = opts.skipNetwork
    ? [{ ok: true, message: 'Worker check: skipped' }, { ok: true, message: 'Models check: skipped', present: [], missing: [] }]
    : await Promise.all([verifyWorker(), verifyModels()]);

  const [worker, models] = networkChecks;

  const failures = [];
  const warnings = [];

  if (!worklet.ok) failures.push(worklet.message);
  if (!sab.ok) failures.push(sab.message);
  if (!ort.ok) warnings.push(ort.message);
  if (!worker.ok) warnings.push(worker.message);
  if (!models.ok) warnings.push(models.message);

  const capabilities = {
    audioWorklet: worklet.ok,
    sharedArrayBuffer: sab.ok,
    atomics: typeof Atomics !== 'undefined',
    crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : sab.ok,
    onnxRuntime: ort.ok,
    workerReachable: worker.ok,
    committedModels: models.present || [],
    missingModels: models.missing || [],
  };

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    capabilities,
  };
}

/**
 * Run checks and block processing start until all required capabilities are present.
 * Resolves immediately if already ok, otherwise polls at 500ms intervals.
 *
 * @param {number} timeoutMs - max wait time (default 30s)
 * @returns {Promise<HealthCheckResult>}
 */
export async function waitForCapabilities(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await runStartupHealthcheck({ skipNetwork: true });
    if (result.ok) return result;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return runStartupHealthcheck({ skipNetwork: true });
}

/**
 * Execution-provider handshake.
 *
 * A GPU adapter is only a candidate. `providerVerified` stays false until a
 * caller reports that InferenceSession.create succeeded for webgpu or wasm.
 * The ready message from the worker is not that proof.
 */

const VERIFIED_BACKENDS = new Set(['webgpu', 'wasm']);

/**
 * @param {object} [msg]
 * @returns {{
 *   providerVerified: boolean,
 *   backend: string|null,
 *   gpuCandidate: boolean,
 *   ready: boolean,
 *   code: string|null,
 *   detail: string|null,
 * }}
 */
export function explainProviderReady(msg = {}) {
  const runtimeMissing = msg.runtimePresent === false || msg.code === 'PROVIDER_INIT_FAILED';
  if (runtimeMissing) {
    return {
      providerVerified: false,
      backend: null,
      gpuCandidate: false,
      ready: false,
      code: 'PROVIDER_INIT_FAILED',
      detail: msg.detail || msg.message || 'ONNX Runtime did not initialize. The WASM provider is unavailable until /lib/ort.min.js loads in the worker.',
    };
  }
  if (msg.type === 'error' && msg.code !== 'PROVIDER_INIT_FAILED') {
    return {
      providerVerified: false,
      backend: null,
      gpuCandidate: msg.gpuCandidate === true,
      ready: false,
      code: msg.code || null,
      detail: msg.message || msg.detail || null,
    };
  }
  const backend = VERIFIED_BACKENDS.has(msg.backend) ? msg.backend : null;
  // Only a session-backed announcement counts. A ready handshake that copies
  // providerVerified: true is still unverified.
  const sessionBacked = msg.type === 'ort-provider' || msg.sessionCreated === true;
  const verified = sessionBacked && msg.providerVerified === true && backend != null;
  if (!verified) {
    return {
      providerVerified: false,
      backend: backend || (msg.backend === 'wasm' || msg.gpuCandidate === true ? 'wasm' : null),
      gpuCandidate: msg.gpuCandidate === true,
      ready: msg.type !== 'error',
      code: 'PROVIDER_UNVERIFIED',
      detail: msg.detail || 'Execution provider is not verified. A GPU adapter is only a candidate until InferenceSession.create succeeds.',
    };
  }
  return {
    providerVerified: true,
    backend,
    gpuCandidate: msg.gpuCandidate === true || backend === 'webgpu',
    ready: true,
    code: null,
    detail: null,
  };
}

/**
 * Eager startup failed before any Process request. The dead worker has to be
 * dropped. Leaving it allocated keeps the backend probing and disables Process.
 * An error that belongs to a request returns null so that path can clean itself up.
 * @returns {{ terminate: true, backend: 'unavailable', message: string }|null}
 */
export function planStartupProviderFailure(msg = {}) {
  if (msg.requestId != null || msg.code !== 'PROVIDER_INIT_FAILED') return null;
  return {
    terminate: true,
    backend: 'unavailable',
    message: msg.message || 'Local ML worker initialization failed',
  };
}

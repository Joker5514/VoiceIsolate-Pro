/**
 * Resolve where the SAM runtime lives on each platform.
 */
'use strict';

/**
 * @param {object} [env]
 * @returns {{
 *   packageId: string,
 *   workerScript: string,
 *   onnxWebPath: string,
 *   defaultPort: number,
 *   defaultHost: string,
 *   modelId: string
 * }}
 */
export function getSamRuntimePaths(env = {}) {
  const modelId = env.SAM_AUDIO_MODEL || 'facebook/sam-audio-small';
  const port = Number(env.SAM_AUDIO_PORT || 8765) || 8765;
  const host = env.SAM_AUDIO_HOST || '127.0.0.1';

  // Electron packaged: resources/sam-audio/server.py
  // Dev: repo services/sam-audio/server.py
  let workerScript = env.SAM_AUDIO_WORKER_SCRIPT || '';
  try {
    const proc = typeof globalThis !== 'undefined' ? globalThis.process : undefined;
    if (!workerScript && proc && proc.resourcesPath) {
      workerScript = `${proc.resourcesPath}/sam-audio/server.py`.replace(/\\/g, '/');
    }
  } catch { /* browser */ }
  if (!workerScript) {
    workerScript = 'services/sam-audio/server.py';
  }

  return {
    packageId: 'vip-sam-runtime',
    workerScript,
    onnxWebPath: '/app/models/sam_audio.onnx',
    defaultPort: port,
    defaultHost: host,
    modelId,
  };
}

export default { getSamRuntimePaths };

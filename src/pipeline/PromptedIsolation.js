/**
 * Prompted isolation orchestrator — Creator/Forensic/batch only.
 * Selects onnx-local (USM) or local SAM worker; never live / never cloud.
 */
'use strict';

import { selectIsolationProvider } from '../core/providers/selectProvider.js';
import { separateUniversal } from '../core/UniversalSourceMatrix.js';
import { STFT_OWNERS } from '../core/stft-budget.js';

/**
 * @param {object} opts
 * @param {Float32Array|Float32Array[]} opts.audio
 * @param {number} opts.sampleRate
 * @param {string} [opts.prompt]
 * @param {'text'|'span'|'visual'} [opts.mode]
 * @param {Array<{start:number,end:number}>} [opts.anchors]
 * @param {'target'|'residual'|'both'} [opts.output]
 * @param {'creator'|'forensic'|'batch'} [opts.processingMode]
 * @param {string} [opts.samMode]
 * @param {string} [opts.workerBaseUrl]
 * @param {boolean} [opts.isAndroid]
 * @param {boolean} [opts.isDesktop]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.jobId]
 */
export async function runPromptedIsolation(opts) {
  const processingMode = opts.processingMode || 'creator';
  if (processingMode === 'live') {
    throw new Error('[VIP][PromptedIsolation] not available in live mode');
  }

  const { throwIfAborted } = await import('./JobController.js');
  throwIfAborted(opts.signal, opts.jobId);

  // Record that prompted path may use USM STFT once (budget soft-guard).
  try {
    globalThis.__vipStftBudget?.record?.(STFT_OWNERS.USM, 'prompted-isolation');
  } catch { /* best-effort */ }

  const selection = await selectIsolationProvider({
    samMode: opts.samMode || 'auto',
    workerBaseUrl: opts.workerBaseUrl,
    isAndroid: !!opts.isAndroid,
    isDesktop: !!opts.isDesktop,
    preferSam: opts.samMode === 'local-worker',
    usmFn: (pcm, sr, cfg) => separateUniversal(pcm, sr, cfg),
    fetchImpl: opts.fetchImpl,
  });
  throwIfAborted(opts.signal, opts.jobId);

  const provider = selection.provider;
  const result = await provider.isolate({
    audio: opts.audio,
    sampleRate: opts.sampleRate,
    prompt: opts.prompt || 'person speaking',
    mode: opts.mode || 'text',
    anchors: opts.anchors || [],
    output: opts.output || 'both',
    preserveResidual: true,
    processingMode,
    signal: opts.signal,
  });
  throwIfAborted(opts.signal, opts.jobId);

  return {
    ...result,
    selectionReason: selection.reason,
    fallback: !!selection.fallback,
    providerId: provider.id,
  };
}

export default { runPromptedIsolation };

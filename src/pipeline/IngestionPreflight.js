/** Shared by Landing FileIngestion and the Engineer's deferred decode path. */
import { readDeviceSignals, selectPerformanceTier } from '../core/PerformanceTier.js';
import { budgetError, estimateIngestionMemory, ingestionBudget, parseWavMetadata } from '../core/IngestionBudget.js';
import { probeMediaMetadata, runBounded } from './media-decode.js';

export async function preflightIngestion(file, { signal, timeoutMs = 15000, onBudget = () => {} } = {}) {
  if (signal?.aborted) throw new DOMException('Ingestion cancelled', 'AbortError');
  // Bounded header read, never blob.arrayBuffer() before the budget decision.
  const header = await runBounded(() => file.slice(0, 1024 * 1024).arrayBuffer(), {
    timeoutMs, signal, timeoutCode: 'INGESTION_HEADER_TIMEOUT', timeoutMessage: 'Audio header read timed out.',
  });
  let metadata = parseWavMetadata(header);
  const bytes = new Uint8Array(header);
  const signature = bytes.length >= 4 ? String.fromCharCode(...bytes.subarray(0, 4)) : '';
  if (!metadata && ['RIFF', 'RF64'].includes(signature)) {
    // Malformed PCM metadata is a decode error, not permission to allocate an
    // unbounded fallback capture. The browser decoder never sees this file.
    throw new Error(`[VIP][FileIngestion] Could not decode '${file.name || 'file'}': invalid or incomplete WAV header.`);
  }
  if (!metadata) {
    try { metadata = await probeMediaMetadata(file, signal, timeoutMs); }
    catch (error) {
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') throw error;
      metadata = null;
    }
  }
  const signals = readDeviceSignals();
  const budget = ingestionBudget(signals, selectPerformanceTier(signals));
  const estimate = estimateIngestionMemory(metadata, file.size, budget);
  if (estimate.decision === 'refuse') throw budgetError(estimate, file.name);
  onBudget(estimate);
  return estimate;
}

export function assertDecodedIngestionBudget(decoded, fileBytes, estimate) {
  const actual = estimateIngestionMemory({
    duration: decoded.duration, channels: decoded.numberOfChannels,
    sampleRate: decoded.sampleRate, source: 'decoded-buffer',
  }, fileBytes, { workingBytes: estimate.budgetBytes, tier: estimate.tier });
  if (actual.decision === 'refuse') throw budgetError(actual);
  return actual;
}

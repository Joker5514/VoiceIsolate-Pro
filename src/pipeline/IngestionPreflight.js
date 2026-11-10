/** Shared by Landing FileIngestion and the Engineer's deferred decode path. */
import { readDeviceSignals, selectPerformanceTier } from '../core/PerformanceTier.js';
import {
  budgetError, chainChunkContract, estimateIngestionMemory, ingestionBudget, parseWavMetadata, resolveIngestionPlan,
} from '../core/IngestionBudget.js';
import { probeMediaMetadata, runBounded } from './media-decode.js';

export async function preflightIngestion(file, {
  signal, timeoutMs = 15000, onBudget = () => {}, profile = 'AUTO', modelIds = null,
} = {}) {
  if (signal?.aborted) throw new DOMException('Ingestion cancelled', 'AbortError');
  // Bounded header read, never blob.arrayBuffer() before the budget decision.
  const header = await runBounded(() => file.slice(0, 1024 * 1024).arrayBuffer(), {
    timeoutMs, signal, timeoutCode: 'INGESTION_HEADER_TIMEOUT', timeoutMessage: 'Audio header read timed out.',
  });
  let metadata = parseWavMetadata(header, file.size);
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
  const tier = selectPerformanceTier(signals);
  const budget = ingestionBudget(signals, tier);
  const contract = modelIds?.length ? chainChunkContract(modelIds) : undefined;
  const estimate = resolveIngestionPlan(metadata, file.size, budget, {
    profile, contract, modelId: modelIds?.[0],
  });
  // Full-file `decision: refuse` is not a dead end when a chunk window fits.
  if (estimate.strategy === 'refuse') throw budgetError(estimate, file.name);
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

/** Pure, conservative import/processing memory planning. No DOM or decoding.
 * Browser PCM is Float32 regardless of the source bit depth. The estimate is
 * an allocation budget, not a claim about total browser/device memory.
 */
import { SAMPLE_RATE, MAX_CHANNELS } from './audio-config.js';
import { PerformanceTier, detectPerformanceTier } from './PerformanceTier.js';

const MIB = 1024 * 1024;
export const INGESTION_BUDGETS = Object.freeze({
  HIGH: Object.freeze({ workingBytes: 3072 * MIB, deviceMemoryFraction: 0.375 }),
  BALANCED: Object.freeze({ workingBytes: 768 * MIB, deviceMemoryFraction: 0.25 }),
  CONSTRAINED: Object.freeze({ workingBytes: 256 * MIB, deviceMemoryFraction: 0.125 }),
});
export const SOFT_BUDGET_FRACTION = 0.75;

export function ingestionBudget(signals = {}, tier = detectPerformanceTier()) {
  const policy = INGESTION_BUDGETS[tier] || INGESTION_BUDGETS[PerformanceTier.CONSTRAINED];
  const reported = Number(signals.deviceMemory);
  const deviceLimit = Number.isFinite(reported) && reported > 0 ? reported * 1024 ** 3 * policy.deviceMemoryFraction : Infinity;
  return { tier, workingBytes: Math.floor(Math.min(policy.workingBytes, deviceLimit)), deviceMemoryReported: Number.isFinite(reported) && reported > 0 };
}

/** RIFF/RF64 WAV fmt + data metadata. Never trusts an unbounded chunk length. */
export function parseWavMetadata(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (b.length < 12) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (at) => String.fromCharCode(...b.subarray(at, at + 4));
  if (!['RIFF', 'RF64'].includes(tag(0)) || tag(8) !== 'WAVE') return null;
  const riffEnd = tag(0) === 'RIFF' ? Math.min(b.length, v.getUint32(4, true) + 8) : b.length;
  let fmt = null;
  let dataBytes = null;
  for (let at = 12; at + 8 <= riffEnd;) {
    const id = tag(at);
    let size = v.getUint32(at + 4, true);
    const start = at + 8;
    if (id === 'data' && size === 0xffffffff && start + 8 <= riffEnd) {
      const low = v.getUint32(start, true), high = v.getUint32(start + 4, true);
      size = low + high * 2 ** 32;
    }
    if (id === 'fmt ' && size >= 16 && start + 16 <= riffEnd) {
      fmt = { format: v.getUint16(start, true), channels: v.getUint16(start + 2, true), sampleRate: v.getUint32(start + 4, true), bitDepth: v.getUint16(start + 14, true) };
    }
    if (id === 'data') dataBytes = size;
    if (fmt && dataBytes !== null) break;
    const next = start + size + (size % 2);
    if (!Number.isSafeInteger(next) || next <= at || next > riffEnd) return null;
    at = next;
  }
  if (!fmt || dataBytes === null || fmt.channels < 1 || fmt.channels > 64 || fmt.sampleRate < 1 || fmt.sampleRate > 768000 || fmt.bitDepth < 1 || fmt.bitDepth > 64) return null;
  const blockAlign = fmt.channels * Math.ceil(fmt.bitDepth / 8);
  return { ...fmt, duration: Math.floor(dataBytes / blockAlign) / fmt.sampleRate, source: 'wav-header', complete: true };
}

export function estimateIngestionMemory(metadata, fileBytes, budget) {
  if (!metadata || !Number.isFinite(metadata.duration) || metadata.duration <= 0
    || !Number.isFinite(fileBytes) || fileBytes < 0 || !Number.isFinite(budget?.workingBytes)) {
    return { known: false, estimatedBytes: null, budgetBytes: budget?.workingBytes ?? null, decision: 'refuse' };
  }
  // Unknown channel count is explicitly conservative. A post-decode check uses
  // the actual count before resampling or copying. Source bit depth describes
  // encoded storage, never the smaller Float32 working buffers.
  const channels = Number.isInteger(metadata.channels) && metadata.channels > 0 ? metadata.channels : MAX_CHANNELS;
  const rate = Number.isFinite(metadata.sampleRate) && metadata.sampleRate > 0 ? metadata.sampleRate : SAMPLE_RATE;
  const outputChannels = Math.min(channels, MAX_CHANNELS);
  const decodedBytes = Math.ceil(metadata.duration * rate * channels * 4);
  const canonicalBytes = Math.ceil(metadata.duration * SAMPLE_RATE * outputChannels * 4);
  const resamplingBytes = rate === SAMPLE_RATE && channels <= MAX_CHANNELS ? 0 : canonicalBytes;
  // Fast decode: compressed original + retry, decoded PCM, resampled PCM,
  // extraction. Processing: raw + clean/noise + mixer + cache/review copies.
  // Take the larger phase, not their sum; released decode buffers are not
  // assumed collectible immediately, hence the retained source allowance.
  const decodePeak = 2 * fileBytes + decodedBytes + canonicalBytes + resamplingBytes + canonicalBytes;
  const processingPeak = 6 * canonicalBytes + fileBytes;
  const estimatedBytes = Math.ceil(Math.max(decodePeak, processingPeak));
  const ratio = estimatedBytes / budget.workingBytes;
  return {
    known: true, estimatedBytes, budgetBytes: budget.workingBytes, tier: budget.tier,
    duration: metadata.duration, channels, outputChannels, sampleRate: rate,
    bitDepth: metadata.bitDepth ?? null, metadataSource: metadata.source || 'media-metadata',
    decodedBytes, canonicalBytes, resamplingBytes,
    decision: ratio > 1 ? 'refuse' : ratio >= SOFT_BUDGET_FRACTION ? 'warn' : 'allow',
  };
}

export function budgetError(estimate, name = 'recording') {
  const mb = (n) => Math.ceil(n / MIB);
  const err = new RangeError(`[VIP][FileIngestion] “${name}” exceeds this device's supported audio-memory budget. `
    + (estimate.known
      ? `Estimated working memory ${mb(estimate.estimatedBytes)} MiB; budget ${mb(estimate.budgetBytes)} MiB (${estimate.tier}). `
      : 'Its duration/channel layout could not be determined safely. ')
    + 'Use a shorter excerpt, a mono export, or a device with more memory. The file was not downsampled or truncated.');
  err.code = estimate.known ? 'INGESTION_BUDGET_EXCEEDED' : 'INGESTION_METADATA_REQUIRED';
  err.estimate = estimate;
  return err;
}

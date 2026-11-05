/** Pure, conservative import/processing memory planning. No DOM or decoding.
 * Browser PCM is Float32 regardless of the source bit depth. The estimate is
 * an allocation budget, not a claim about total browser/device memory.
 */
import { SAMPLE_RATE, MAX_CHANNELS } from './audio-config.js';
import { PerformanceTier, detectPerformanceTier } from './PerformanceTier.js';
import { MODEL_MANIFEST } from './ModelManifest.js';

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
  let dataOffset = null;
  let dataWindowable = false;
  for (let at = 12; at + 8 <= riffEnd;) {
    const id = tag(at);
    const declared = v.getUint32(at + 4, true);
    let size = declared;
    const start = at + 8;
    if (id === 'data' && size === 0xffffffff && start + 8 <= riffEnd) {
      const low = v.getUint32(start, true), high = v.getUint32(start + 4, true);
      size = low + high * 2 ** 32;
    }
    if (id === 'fmt ' && size >= 16 && start + 16 <= riffEnd) {
      fmt = { format: v.getUint16(start, true), channels: v.getUint16(start + 2, true), sampleRate: v.getUint32(start + 4, true), bitDepth: v.getUint16(start + 14, true) };
    }
    if (id === 'data') {
      dataBytes = size;
      dataOffset = start;
      // A 0xFFFFFFFF data size is an RF64 sentinel. Windowed reads stay off
      // until that layout is parsed from the ds64 table, not guessed.
      dataWindowable = declared !== 0xffffffff;
    }
    if (fmt && dataBytes !== null) break;
    const next = start + size + (size % 2);
    if (!Number.isSafeInteger(next) || next <= at || next > riffEnd) return null;
    at = next;
  }
  if (!fmt || dataBytes === null || fmt.channels < 1 || fmt.channels > 64 || fmt.sampleRate < 1 || fmt.sampleRate > 768000 || fmt.bitDepth < 1 || fmt.bitDepth > 64) return null;
  const blockAlign = fmt.channels * Math.ceil(fmt.bitDepth / 8);
  return {
    ...fmt,
    blockAlign,
    dataOffset: dataWindowable ? dataOffset : null,
    dataBytes,
    duration: Math.floor(dataBytes / blockAlign) / fmt.sampleRate,
    source: 'wav-header',
    complete: true,
  };
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
    decodePeak, processingPeak,
    compressedBytes: fileBytes,
    channelsAssumed: !(Number.isInteger(metadata.channels) && metadata.channels > 0),
    decision: ratio > 1 ? 'refuse' : ratio >= SOFT_BUDGET_FRACTION ? 'warn' : 'allow',
  };
}

const PROFILE_BY_TIER = Object.freeze({
  HIGH: 'HIGH',
  BALANCED: 'BALANCED',
  CONSTRAINED: 'LOW',
});

/** Preferred core length before the memory cap. Profiles change real chunk size. */
const CORE_SECONDS = Object.freeze({ HIGH: 45, BALANCED: 20, CONSTRAINED: 8 });

/** Resident copies of one window: input, model output, stitch tail, decoder block. */
const CHUNK_RESIDENT_COPIES = 4;

/**
 * Chunk contract for one manifest model. Spectral-mask heads are frame-wise
 * but the worker smooths masks across frames, so context covers that smoother
 * plus one analysis window. DeepFilterNet and other recurrent graphs are not
 * marked chunkable: independent windows would drop their state.
 * @param {string} [modelId]
 */
export function chunkContractFor(modelId = 'bsrnn_vocals') {
  const entry = MODEL_MANIFEST[modelId];
  if (!entry) {
    return Object.freeze({
      id: modelId, chunkable: false, sampleRate: SAMPLE_RATE, fftSize: 0, hopSize: 0, contextFrames: 0, strategy: null,
    });
  }
  const hop = entry.hopSize || 1024;
  const fft = entry.fftSize || 0;
  const spectral = entry.strategy === 'spectral-mask';
  return Object.freeze({
    id: entry.id,
    strategy: entry.strategy,
    sampleRate: entry.sampleRate || SAMPLE_RATE,
    fftSize: fft,
    hopSize: hop,
    contextFrames: spectral ? Math.max(fft, hop * 16) : Math.max(fft, hop, 1024),
    // Waveform and recurrent graphs (Demucs, DeepFilterNet) are not windowed.
    // Independent chunks would drop their state. Spectral masks are frame-wise.
    chunkable: spectral && (entry.sampleRate || SAMPLE_RATE) === SAMPLE_RATE,
  });
}

/** A chain is chunkable only when every model is, at one canonical rate. */
export function chainChunkContract(modelIds) {
  const ids = Array.isArray(modelIds) && modelIds.length ? modelIds : ['bsrnn_vocals'];
  const parts = ids.map((id) => chunkContractFor(id));
  const hop = Math.max(...parts.map((p) => p.hopSize || 0), 1024);
  const contextFrames = Math.max(...parts.map((p) => p.contextFrames || 0), hop);
  const sampleRates = new Set(parts.map((p) => p.sampleRate));
  return Object.freeze({
    id: parts.map((p) => p.id).join('+'),
    modelIds: Object.freeze([...ids]),
    strategy: parts.length === 1 ? parts[0].strategy : 'chain',
    sampleRate: SAMPLE_RATE,
    fftSize: Math.max(...parts.map((p) => p.fftSize || 0)),
    hopSize: hop,
    contextFrames,
    chunkable: parts.every((p) => p.chunkable) && sampleRates.size === 1,
  });
}

/**
 * Largest core that keeps one window's resident set inside the budget.
 * Core is hop-aligned. The window is core plus context on both sides.
 */
export function planChunkWindow(estimate, budget, contract, profile = 'AUTO') {
  const rate = SAMPLE_RATE;
  const channels = Math.max(1, estimate?.outputChannels || 1);
  const hop = Math.max(1, contract?.hopSize || 1024);
  const context = Math.max(hop, contract?.contextFrames || hop);
  const fade = hop;
  const tier = budget?.tier || PerformanceTier.CONSTRAINED;
  const reserve = Math.min(Math.floor((budget?.workingBytes || 0) * 0.2), 96 * MIB);
  const room = Math.max(0, (budget?.workingBytes || 0) - reserve);
  const bytesPerFrame = channels * 4 * CHUNK_RESIDENT_COPIES;
  const maxFrames = bytesPerFrame > 0 ? Math.floor(room / bytesPerFrame) : 0;
  const seconds = profile === 'LOW' ? CORE_SECONDS.CONSTRAINED
    : profile === 'BALANCED' ? CORE_SECONDS.BALANCED
      : profile === 'HIGH' ? CORE_SECONDS.HIGH
        : (CORE_SECONDS[tier] || CORE_SECONDS.CONSTRAINED);
  const preferred = Math.round(seconds * rate);
  let core = Math.min(preferred, maxFrames - 2 * context);
  core = Math.floor(core / hop) * hop;
  const viable = Boolean(contract?.chunkable) && core >= hop * 2 && Number.isFinite(estimate?.duration);
  const windowFrames = viable ? core + 2 * context : 0;
  const peakBytes = viable ? windowFrames * bytesPerFrame : Infinity;
  return {
    viable: viable && peakBytes <= (budget?.workingBytes || 0),
    modelId: contract?.id || null,
    coreFrames: viable ? core : 0,
    contextFrames: context,
    fadeFrames: fade,
    strideFrames: viable ? core - fade : 0,
    windowFrames,
    peakBytes: Number.isFinite(peakBytes) ? peakBytes : null,
    copies: CHUNK_RESIDENT_COPIES,
    coreSeconds: viable ? core / rate : 0,
  };
}

/**
 * Full-file decision plus the strategy the device can actually run.
 * `decision` stays the full-file verdict (`allow` / `warn` / `refuse`).
 * `strategy` is `full` when that verdict fits, `chunked` when a window fits,
 * and `refuse` only when neither does.
 */
export function resolveIngestionPlan(metadata, fileBytes, budget, options = {}) {
  const estimate = estimateIngestionMemory(metadata, fileBytes, budget);
  const contract = options.contract || chunkContractFor(options.modelId || 'bsrnn_vocals');
  const profile = options.profile || PROFILE_BY_TIER[budget?.tier] || 'AUTO';
  if (!estimate.known) {
    return {
      ...estimate,
      strategy: 'refuse',
      profile,
      contract,
      chunk: null,
      totalFrames: 0,
      wav: null,
      measurements: {
        compressedBytes: Number.isFinite(fileBytes) ? fileBytes : null,
        decodedBytes: null,
        canonicalBytes: null,
        ingestionPeakBytes: null,
        processingPeakBytes: null,
        chunkPeakBytes: null,
      },
    };
  }
  const chunk = planChunkWindow(estimate, budget, contract, profile);
  const strategy = estimate.decision === 'refuse'
    ? (chunk.viable ? 'chunked' : 'refuse')
    : 'full';
  return {
    ...estimate,
    strategy,
    profile,
    contract,
    chunk,
    totalFrames: Math.max(1, Math.round(estimate.duration * SAMPLE_RATE)),
    wav: metadata?.source === 'wav-header' ? metadata : null,
    measurements: {
      compressedBytes: fileBytes,
      decodedBytes: estimate.decodedBytes,
      canonicalBytes: estimate.canonicalBytes,
      ingestionPeakBytes: estimate.decodePeak,
      processingPeakBytes: estimate.processingPeak,
      chunkPeakBytes: chunk.peakBytes,
    },
  };
}

/** User-facing copy. Does not claim a backend that has not been selected. */
export function formatIngestionPlan(plan, name = 'recording') {
  const mb = (n) => (Number.isFinite(n) ? String(Math.ceil(n / MIB)) : 'unknown');
  if (!plan?.known) {
    return `RESOURCE LIMIT\nThe duration of “${name}” could not be read, so VoiceIsolate will not guess a buffer size.\nThe file was not downsampled or truncated.`;
  }
  if (plan.strategy === 'chunked') {
    const seconds = Math.round(plan.chunk?.coreSeconds || 0);
    return [
      'AUDIO OPTIMIZATION',
      `“${name}” needs more memory than this device can safely allocate for full decoding.`,
      'Source: preserved',
      `Model: ${plan.chunk?.modelId || plan.contract?.id || 'local'}`,
      'Strategy: Chunked processing',
      `Memory profile: ${plan.profile || 'AUTO'}`,
      `Device tier: ${plan.tier}`,
      `Chunk length: ${seconds}s with ${plan.chunk?.contextFrames || 0} samples of model context`,
      `Full-file working set: ${mb(plan.estimatedBytes)} MiB`,
      `Chunk working set: ${mb(plan.chunk?.peakBytes)} MiB`,
      `Budget: ${mb(plan.budgetBytes)} MiB`,
      'The source file was not downsampled or truncated.',
    ].join('\n');
  }
  if (plan.strategy === 'refuse' || plan.decision === 'refuse') {
    return [
      'RESOURCE LIMIT',
      `“${name}” exceeds the safe processing capacity of this device.`,
      `Compressed file: ${mb(plan.measurements?.compressedBytes)} MiB`,
      `Decoded PCM: ${mb(plan.decodedBytes)} MiB`,
      `Full-file working set: ${mb(plan.estimatedBytes)} MiB`,
      `Budget: ${mb(plan.budgetBytes)} MiB (${plan.tier})`,
      plan.contract && plan.contract.chunkable === false
        ? 'This model keeps state across the recording, so it is not split into windows.'
        : 'Chunked processing does not fit this budget either.',
      'The file was not downsampled or truncated.',
      'Use a shorter excerpt, or close other memory-intensive applications and retry on a device with more memory.',
    ].join('\n');
  }
  return '';
}

export function budgetError(estimate, name = 'recording') {
  const err = new RangeError(`[VIP][FileIngestion] ${formatIngestionPlan(estimate, name).replace(/\n/g, ' ')}`);
  err.code = estimate?.known ? 'INGESTION_BUDGET_EXCEEDED' : 'INGESTION_METADATA_REQUIRED';
  err.estimate = estimate;
  return err;
}

/** Pure, conservative import/processing memory planning. No DOM or decoding.
 * Browser PCM is Float32 regardless of the source bit depth. The estimate is
 * an allocation budget, not a claim about total browser/device memory.
 */
import { SAMPLE_RATE, MAX_CHANNELS } from './audio-config.js';
import { PerformanceTier, detectPerformanceTier } from './PerformanceTier.js';
import { MODEL_MANIFEST } from './ModelManifest.js';

const MIB = 1024 * 1024;
export const WAV_HEADER_WINDOW = MIB;
export const WAV_HEADER_WALK_CAP = 32 * MIB;

// WAVEFORMATEXTENSIBLE sub-format GUIDs, little-endian on disk.
const PCM_SUBFORMAT = Object.freeze([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);
const FLOAT_SUBFORMAT = Object.freeze([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);
const TRAILING_CHUNK_IDS = new Set(['LIST', 'fact', 'cue ', 'bext', 'iXML', 'FLLR', 'JUNK', 'PAD ', 'smpl', 'inst', 'plst', 'levl']);

function sameBytes(bytes, at, expected) {
  if (at < 0 || at + expected.length > bytes.length) return false;
  for (let i = 0; i < expected.length; i++) if (bytes[at + i] !== expected[i]) return false;
  return true;
}

function chunkChainEndsAt(bytes, view, tag, at, limit) {
  let cursor = at;
  for (let guard = 0; guard < 32 && cursor + 8 <= limit; guard++) {
    const id = tag(cursor);
    if (!TRAILING_CHUNK_IDS.has(id)) return false;
    const size = view.getUint32(cursor + 4, true);
    const next = cursor + 8 + size + (size % 2);
    if (!Number.isSafeInteger(next) || next <= cursor || next > limit) return false;
    cursor = next;
  }
  return cursor === limit;
}

/** PCM byte count before the first trailing metadata chunk that reaches `limit`. */
function pcmBytesBeforeTrailing(bytes, view, tag, dataOffset, limit, blockAlign) {
  if (limit > bytes.length || dataOffset < 0 || dataOffset >= limit) return null;
  const start = dataOffset + (dataOffset % 2);
  for (let at = start; at + 8 <= limit; at += 2) {
    if (!TRAILING_CHUNK_IDS.has(tag(at))) continue;
    if (!chunkChainEndsAt(bytes, view, tag, at, limit)) continue;
    const pcm = at - dataOffset;
    const aligned = pcm - (pcm % blockAlign);
    return aligned > 0 ? aligned : null;
  }
  return null;
}
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

/**
 * Read one WAVE chunk list.
 * A data size of 0 or 0xFFFFFFFF is an unfinished header, not a 64-bit length
 * stored in the PCM. ds64 supplies that length; otherwise `fileSize` is the
 * measured file, and the bytes after the data header are the PCM.
 * @returns {object|null}
 */
function readWaveChunks(b, v, tag, riffEnd, fileSize) {
  let fmt = null;
  let dataDeclared = null;
  let dataOffset = null;
  let ds64DataBytes = null;
  for (let at = 12; at + 8 <= riffEnd;) {
    const id = tag(at);
    const declared = v.getUint32(at + 4, true);
    const start = at + 8;
    if (id === 'ds64' && start + 16 <= riffEnd) {
      const low = v.getUint32(start + 8, true);
      const high = v.getUint32(start + 12, true);
      const bytes = low + high * 2 ** 32;
      if (Number.isSafeInteger(bytes) && bytes > 0) ds64DataBytes = bytes;
    }
    if (id === 'fmt ' && declared >= 16 && start + 16 <= riffEnd) {
      const format = v.getUint16(start, true);
      const channels = v.getUint16(start + 2, true);
      const sampleRate = v.getUint32(start + 4, true);
      const blockAlign = v.getUint16(start + 12, true);
      const containerBits = v.getUint16(start + 14, true);
      if (format === 0xfffe) {
        const extensible = declared >= 40 && start + 40 <= riffEnd;
        const cbSize = extensible ? v.getUint16(start + 16, true) : 0;
        const validBits = extensible ? v.getUint16(start + 18, true) : 0;
        const pcm = extensible && cbSize >= 22 && sameBytes(b, start + 24, PCM_SUBFORMAT);
        const flt = extensible && cbSize >= 22 && sameBytes(b, start + 24, FLOAT_SUBFORMAT);
        fmt = {
          format: flt ? 3 : 1,
          channels,
          sampleRate,
          bitDepth: validBits > 0 ? validBits : containerBits,
          containerBits,
          blockAlign,
          extensible: true,
          unsupported: !(pcm || flt),
        };
      } else {
        fmt = {
          format,
          channels,
          sampleRate,
          bitDepth: containerBits,
          containerBits,
          blockAlign,
          extensible: false,
          unsupported: false,
        };
      }
    }
    if (id === 'data' && start <= riffEnd) {
      dataDeclared = declared;
      dataOffset = start;
    }
    const declaredKnown = dataDeclared !== null && dataDeclared !== 0 && dataDeclared !== 0xffffffff;
    if (fmt && dataOffset !== null && (declaredKnown || ds64DataBytes != null)) break;
    // The rest of an unfinished data chunk is PCM, so the walk cannot skip it.
    if (declared === 0xffffffff || (id === 'data' && declared === 0)) break;
    const next = start + declared + (declared % 2);
    if (!Number.isSafeInteger(next) || next <= at || next > riffEnd) break;
    at = next;
  }
  if (!fmt || fmt.unsupported || dataOffset === null || dataDeclared === null) return null;
  if (fmt.channels < 1 || fmt.channels > 64 || fmt.sampleRate < 1 || fmt.sampleRate > 768000 || fmt.bitDepth < 1 || fmt.bitDepth > 64) return null;
  const blockAlign = fmt.blockAlign;
  const containerBytes = blockAlign / fmt.channels;
  if (!Number.isInteger(containerBytes) || containerBytes < 1 || containerBytes > 8) return null;
  if (containerBytes * 8 < fmt.bitDepth) return null;
  let dataBytes = dataDeclared;
  let dataWindowable = dataDeclared !== 0 && dataDeclared !== 0xffffffff;
  let unfinishedData = !dataWindowable && ds64DataBytes == null;
  if (!dataWindowable) {
    if (ds64DataBytes != null) {
      dataBytes = ds64DataBytes;
      dataWindowable = true;
    } else if (fileSize != null && fileSize > dataOffset) {
      const remain = fileSize - dataOffset;
      dataBytes = remain - (remain % blockAlign);
      // A zero or 0xFFFFFFFF data size used to swallow a trailing LIST.
      // When this buffer reaches EOF, stop at the first metadata chunk
      // whose own chain ends at EOF.
      if (b.length >= fileSize) {
        const cut = pcmBytesBeforeTrailing(b, v, tag, dataOffset, fileSize, blockAlign);
        if (cut != null) {
          dataBytes = cut;
          unfinishedData = false;
        }
      }
      dataWindowable = dataBytes > 0;
    } else {
      return null;
    }
  }
  if (!Number.isSafeInteger(dataBytes) || dataBytes <= 0) return null;
  if (fileSize != null && fileSize > dataOffset && dataBytes > fileSize - dataOffset) {
    const remain = fileSize - dataOffset;
    dataBytes = remain - (remain % blockAlign);
    if (!Number.isSafeInteger(dataBytes) || dataBytes <= 0) return null;
  }
  return {
    ...fmt,
    blockAlign,
    dataOffset: dataWindowable ? dataOffset : null,
    dataBytes,
    duration: Math.floor(dataBytes / blockAlign) / fmt.sampleRate,
    source: 'wav-header',
    complete: true,
    unfinishedData,
  };
}

/**
 * When the header window did not reach EOF, `tail` is the last bytes of the
 * file. A metadata chunk at the end (LIST, bext, …) is not PCM.
 * @param {object} meta
 * @param {Uint8Array} tail
 * @param {number} fileSize
 */
export function applyWavTail(meta, tail, fileSize) {
  if (!meta?.unfinishedData || !tail?.length || !(fileSize > meta.dataOffset)) return meta;
  const bytes = tail instanceof Uint8Array ? tail : new Uint8Array(tail);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at) => (at >= 0 && at + 4 <= bytes.length
    ? String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
    : '');
  const tailStart = fileSize - bytes.length;
  for (let at = 0; at + 8 <= bytes.length; at += 2) {
    if (!TRAILING_CHUNK_IDS.has(tag(at))) continue;
    if (!chunkChainEndsAt(bytes, view, tag, at, bytes.length)) continue;
    const absolute = tailStart + at;
    if (absolute <= meta.dataOffset) continue;
    const pcm = absolute - meta.dataOffset;
    const aligned = pcm - (pcm % meta.blockAlign);
    if (aligned <= 0) continue;
    return {
      ...meta,
      dataBytes: aligned,
      duration: Math.floor(aligned / meta.blockAlign) / meta.sampleRate,
      unfinishedData: false,
    };
  }
  return meta;
}

/** RIFF/RF64 WAV fmt + data metadata. Never trusts an unbounded chunk length.
 * `fileSize` is the measured blob length. A RIFF size of 0 does not hide the
 * chunks that follow it. Compressed containers do not come through here.
 */
export function parseWavMetadata(buffer, fileSize = null) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (b.length < 12) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (at) => (at >= 0 && at + 4 <= b.length
    ? String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
    : '');
  if (!['RIFF', 'RF64'].includes(tag(0)) || tag(8) !== 'WAVE') return null;
  const measured = Number(fileSize);
  const knownSize = Number.isFinite(measured) && measured > 0 ? measured : null;
  const declaredEnd = tag(0) === 'RIFF' ? v.getUint32(4, true) + 8 : b.length;
  const ends = [];
  if (declaredEnd >= 44 && declaredEnd <= b.length) ends.push(declaredEnd);
  if (!ends.includes(b.length)) ends.push(b.length);
  for (const riffEnd of ends) {
    const found = readWaveChunks(b, v, tag, riffEnd, knownSize);
    if (found) return found;
  }
  return null;
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

/** Shared by Landing FileIngestion and the Engineer's deferred decode path. */
import { readDeviceSignals, selectPerformanceTier } from '../core/PerformanceTier.js';
import {
  budgetError, chainChunkContract, estimateIngestionMemory, ingestionBudget, resolveIngestionPlan,
} from '../core/IngestionBudget.js';
import { parseMp4Duration, readCompressedLayout } from './CompressedAudioReader.js';
import { wavMetadataFor } from './ChunkedExtraction.js';
import { probeMediaMetadata, runBounded } from './media-decode.js';
import { emitIngestionDebug, traceIngest } from '../core/ingestion-debug.js';
import { decodeMetadataError } from '../core/DecodedAudio.js';

export async function preflightIngestion(file, {
  signal, timeoutMs = 15000, onBudget = () => {}, profile = 'AUTO', modelIds = null,
} = {}) {
  if (signal?.aborted) throw new DOMException('Ingestion cancelled', 'AbortError');
  // Sniff the fixed-size container signature first: non-WAV inputs must not
  // enter the bounded WAV chunk walk at all.
  emitIngestionDebug('preflight:start', { fileName: file.name || 'untitled', fileBytes: file.size, mime: file.type || 'unknown' });
  const head = new Uint8Array(await runBounded(() => file.slice(0, 12).arrayBuffer(), {
    timeoutMs,
    signal,
    timeoutCode: 'INGESTION_HEADER_TIMEOUT',
    timeoutMessage: 'Audio header read timed out.',
  }));
  const signature = head.length >= 4 ? String.fromCharCode(head[0], head[1], head[2], head[3]) : '';
  const mp4Brand = head.length >= 8 ? String.fromCharCode(head[4], head[5], head[6], head[7]) : '';
  const isMp4 = mp4Brand === 'ftyp'
    || /\.(mp4|m4v|mov)$/i.test(file.name || '')
    || /(?:mp4|quicktime)/i.test(file.type || '');
  const isWave = ['RIFF', 'RF64'].includes(signature)
    && head.length >= 12
    && String.fromCharCode(head[8], head[9], head[10], head[11]) === 'WAVE';
  const isId3 = head.length >= 3 && signature.startsWith('ID3');
  const isMpegFrame = head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
  const isMpeg = isId3 || isMpegFrame
    || /\.mp3$/i.test(file.name || '')
    || /(?:mpeg|mp3)/i.test(file.type || '');
  // Header walk, never blob.arrayBuffer() of the whole file before the budget decision.
  const headerController = typeof AbortController === 'function' ? new AbortController() : null;
  let metadata = isWave ? await runBounded(
    () => wavMetadataFor(file, { signal: headerController?.signal, headerChecked: true }),
    {
      timeoutMs,
      signal,
      onStop: () => headerController?.abort(),
      timeoutCode: 'INGESTION_HEADER_TIMEOUT',
      timeoutMessage: 'Audio header read timed out.',
    },
  ) : null;
  if (!metadata && ['RIFF', 'RF64'].includes(signature)) {
    // Malformed PCM metadata is a decode error, not permission to allocate an
    // unbounded fallback capture. The browser decoder never sees this file.
    throw new Error(`[VIP][FileIngestion] Could not decode '${file.name || 'file'}': invalid or incomplete WAV header.`);
  }
  if (!metadata && isMp4) {
    emitIngestionDebug('metadata:mp4-probe:start', { fileName: file.name || 'untitled' });
    const mp4Controller = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      const duration = await runBounded(
        () => parseMp4Duration(file, { signal: mp4Controller?.signal }),
        {
          timeoutMs,
          signal,
          onStop: () => mp4Controller?.abort(),
          timeoutCode: 'INGESTION_HEADER_TIMEOUT',
          timeoutMessage: 'Audio header read timed out.',
        },
      );
      if (Number.isFinite(duration) && duration > 0) {
        emitIngestionDebug('metadata:mp4-probe:success', { duration, source: 'mp4-mvhd-or-track' });
        metadata = { duration, channels: null, sampleRate: null, bitDepth: null, source: 'mp4-mvhd', complete: false };
      }
    } catch (error) {
      emitIngestionDebug('metadata:mp4-probe:error', { code: error?.code || error?.name || 'ERROR', message: error?.message || String(error) });
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') throw error;
      // Fall through to the browser's media-element probe for unusual MP4s.
    }
  }
  if ((isMp4 || isMpeg) && !(metadata?.source === 'wav-header')) {
    emitIngestionDebug('metadata:bitstream:start', { fileName: file.name || 'untitled', kind: isMp4 ? 'mp4' : 'mp3' });
    try {
      const layout = await readCompressedLayout(file, { signal, kind: isMp4 ? 'mp4' : 'mp3' });
      if (layout?.frames > 0 && layout.channels > 0 && layout.sampleRate > 0) {
        emitIngestionDebug('metadata:bitstream:success', {
          duration: layout.duration, channels: layout.channels, sampleRate: layout.sampleRate, frames: layout.frames, source: layout.source,
        });
        metadata = {
          duration: layout.duration,
          channels: layout.channels,
          sampleRate: layout.sampleRate,
          frames: layout.frames,
          bitDepth: null,
          source: layout.source,
          complete: true,
          bitstream: layout.bitstream,
        };
      } else {
        emitIngestionDebug('metadata:bitstream:unavailable', { fileName: file.name || 'untitled' });
      }
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
      if (error?.code === 'DECODE_METADATA_INVALID') throw error;
      emitIngestionDebug('metadata:bitstream:error', { code: error?.code || error?.name || 'ERROR', message: error?.message || String(error) });
    }
  }
  if (!metadata) {
    emitIngestionDebug('metadata:browser-probe:start', { fileName: file.name || 'untitled' });
    try { metadata = await probeMediaMetadata(file, signal, timeoutMs); }
    catch (error) {
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') throw error;
      metadata = null;
    }
    emitIngestionDebug(metadata?.duration > 0 ? 'metadata:browser-probe:success' : 'metadata:browser-probe:unavailable', { duration: metadata?.duration ?? null, source: metadata?.source || null });
  }
  const signals = readDeviceSignals();
  const tier = selectPerformanceTier(signals);
  const budget = ingestionBudget(signals, tier);
  const contract = modelIds?.length ? chainChunkContract(modelIds) : undefined;
  const bitstream = metadata?.bitstream || null;
  if (metadata) delete metadata.bitstream;
  const estimate = resolveIngestionPlan(metadata, file.size, budget, {
    profile, contract, modelId: modelIds?.[0],
  });
  if (bitstream) estimate.bitstream = bitstream;
  // Full-file `decision: refuse` is not a dead end when a chunk window fits.
  emitIngestionDebug('preflight:plan', { strategy: estimate.strategy, duration: estimate.duration ?? null, estimatedBytes: estimate.estimatedBytes ?? null, budgetBytes: estimate.budgetBytes ?? null, tier: estimate.tier || tier, metadataSource: estimate.metadataSource || metadata?.source || null });
  if (estimate.strategy === 'refuse') {
    emitIngestionDebug('preflight:refused', { code: 'INGESTION_METADATA_REQUIRED', known: estimate.known });
    throw budgetError(estimate, file.name);
  }
  if (estimate.strategy === 'chunked' && estimate.frameAuthority !== 'pcm') {
    const field = estimate.channelsAssumed ? 'channels' : 'frames';
    const error = decodeMetadataError({
      stage: 'ingest.metadata.validate',
      file: file.name || 'untitled',
      decoder: metadata?.source || 'container',
      field,
      message: `[VIP][FileIngestion] Cannot import “${file.name || 'file'}” in chunked mode: the container did not provide a measured channel count and a PCM frame count. A duration by itself is not a decode, and the channel count was not guessed. The file was not modified. Export WAV, M4A/AAC, or MP3, or use a shorter file that fits in memory.`,
    });
    traceIngest('ingest.metadata.validate', {
      ok: false, field, strategy: 'chunked', channels: estimate.channels ?? null, frames: estimate.sourceFrames ?? null, sampleRate: estimate.sampleRate ?? null,
    }, 'error');
    traceIngest('ingest.failed', {
      stage: 'ingest.metadata.validate', field, strategy: 'chunked', message: error.message, file: file.name || 'untitled',
    }, 'error');
    error.ingestTraced = true;
    throw error;
  }
  onBudget(estimate);
  emitIngestionDebug('preflight:ready', { strategy: estimate.strategy, duration: estimate.duration });
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

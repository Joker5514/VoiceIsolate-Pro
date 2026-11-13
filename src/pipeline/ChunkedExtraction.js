/**
 * Memory-bounded local extraction.
 *
 * Windows overlap by model context. Each window is handed to the existing
 * separation engine. Only the core is kept. Adjacent cores overlap by one
 * hop and are crossfaded, so a linear process of the source reconstructs it.
 * A failed window aborts the sink. The result is not reported complete.
 */
'use strict';

import { SAMPLE_RATE, MAX_CHANNELS } from '../core/audio-config.js';
import { applyWavTail, parseWavMetadata, WAV_HEADER_WALK_CAP, WAV_HEADER_WINDOW } from '../core/IngestionBudget.js';
import { interleaveFloat32, wavHeaderBytes } from '../core/WavEncoder.js';
import { openCompressedReader } from './CompressedAudioReader.js';
import { resampleWindow, sourceSpan } from './resample-window.js';

export { resampleWindow };

function abortError() {
  return typeof DOMException !== 'undefined'
    ? new DOMException('Processing cancelled', 'AbortError')
    : Object.assign(new Error('Processing cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function fail(code, message, segment) {
  const error = new Error(message);
  error.code = code;
  if (segment) error.segment = segment;
  return error;
}

function readPcmSample(view, offset, meta) {
  const container = meta.blockAlign / meta.channels;
  const bits = meta.bitDepth;
  if (meta.format === 3 && container === 4) return view.getFloat32(offset, true);
  if (meta.format === 1 && container === 2 && bits === 16) return view.getInt16(offset, true) / 32768;
  if (meta.format === 1 && container === 3 && bits === 24) {
    let v = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
    if (v & 0x800000) v -= 0x1000000;
    return v / 8388608;
  }
  if (meta.format === 1 && container === 4 && bits === 32) return view.getInt32(offset, true) / 2147483648;
  // WAVEFORMATEXTENSIBLE stores the valid bits left-justified in the container.
  if (meta.format === 1 && container === 4 && bits === 24) return (view.getInt32(offset, true) >> 8) / 8388608;
  if (meta.format === 1 && container === 4 && bits === 16) return (view.getInt32(offset, true) >> 16) / 32768;
  return null;
}

/** Interleaved PCM payload → planar float. Throws on a bit depth we do not read. */
export function decodeInterleavedPcm(view, frames, meta) {
  const channels = meta.channels;
  const container = meta.blockAlign / channels;
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = readPcmSample(view, (i * channels + c) * container, meta);
      if (sample == null) {
        throw fail('CHUNK_CODEC', `[VIP][ChunkedExtraction] PCM ${meta.format}/${meta.bitDepth}-bit in a ${container}-byte container cannot be read in windows.`);
      }
      out[c][i] = sample;
    }
  }
  return out;
}

/**
 * Crossfade `prevTail` with the head of `core`. They cover the same time range.
 * The tail of a non-final core is held back for the next call.
 */
export function stitchEmit(core, prevTail, fade, isLast) {
  const n = core[0].length;
  const overlap = prevTail ? Math.min(fade, n, prevTail[0].length) : 0;
  const hold = isLast ? 0 : Math.min(fade, Math.max(0, n - overlap));
  const writeLen = n - hold;
  const written = Array.from({ length: core.length }, () => new Float32Array(writeLen));
  for (let c = 0; c < core.length; c++) {
    const src = core[c];
    const dst = written[c];
    for (let i = 0; i < writeLen; i++) {
      if (i < overlap) {
        const t = overlap <= 1 ? 1 : i / (overlap - 1);
        dst[i] = prevTail[c][i] * (1 - t) + src[i] * t;
      } else {
        dst[i] = src[i];
      }
    }
  }
  const tail = hold > 0 ? core.map((ch) => ch.slice(n - hold)) : null;
  return { samples: written, emitted: writeLen, tail };
}

async function readWavSlice(file, wav, startFrame, frameCount) {
  const bytes = frameCount * wav.blockAlign;
  const offset = wav.dataOffset + startFrame * wav.blockAlign;
  const buf = await file.slice(offset, offset + bytes).arrayBuffer();
  if (buf.byteLength < bytes) {
    throw fail('CHUNK_CODEC', `[VIP][ChunkedExtraction] WAV ended ${bytes - buf.byteLength} bytes early at frame ${startFrame}.`);
  }
  return decodeInterleavedPcm(new DataView(buf), frameCount, wav);
}

async function readWavCanonical(file, plan, canonStart, canonCount) {
  const wav = plan.wav;
  if (!wav?.dataOffset || !wav.blockAlign) return null;
  const channels = Math.min(wav.channels, MAX_CHANNELS);
  if (wav.sampleRate === SAMPLE_RATE) {
    const pcm = await readWavSlice(file, wav, canonStart, canonCount);
    return pcm.slice(0, channels);
  }
  const totalSrc = Math.floor(wav.dataBytes / wav.blockAlign);
  const span = sourceSpan(wav.sampleRate, canonStart, canonCount);
  const srcStart = Math.max(0, Math.min(totalSrc, span.srcStart));
  const srcEnd = Math.max(srcStart, Math.min(totalSrc, span.srcEnd));
  if (srcEnd <= srcStart) {
    return Array.from({ length: channels }, () => new Float32Array(canonCount));
  }
  const pcm = await readWavSlice(file, wav, srcStart, srcEnd - srcStart);
  return resampleWindow(pcm.slice(0, channels), srcStart, wav.sampleRate, canonStart, canonCount);
}

function limitChannels(channels) {
  return channels.slice(0, MAX_CHANNELS).map((ch) => (ch instanceof Float32Array ? ch : new Float32Array(ch)));
}

export async function readCanonicalWindow(file, plan, canonStart, canonCount, options = {}) {
  if (typeof options.readWindow === 'function') {
    return limitChannels(await options.readWindow(canonStart, canonCount));
  }
  if (plan.wav?.dataOffset) {
    const wav = await readWavCanonical(file, plan, canonStart, canonCount);
    if (wav) return wav;
  }
  if (!options._reader) {
    options._reader = await openCompressedReader(file, plan);
  }
  return limitChannels(await options._reader.read(canonStart, canonCount));
}

function concatPlanar(parts, frames) {
  return parts.map((list) => {
    const joined = new Float32Array(frames);
    let offset = 0;
    for (const part of list) {
      joined.set(part, offset);
      offset += part.length;
    }
    return joined;
  });
}

function createMemorySink(channelCount) {
  const parts = Array.from({ length: channelCount }, () => []);
  let frames = 0;
  return {
    kind: 'pcm',
    write(samples) {
      for (let c = 0; c < channelCount; c++) parts[c].push(samples[c]);
      frames += samples[0].length;
    },
    async finish() {
      return { kind: 'pcm', channels: concatPlanar(parts, frames), frames };
    },
    async abort() {
      for (const list of parts) list.length = 0;
    },
  };
}

async function createFileSink({ channels, sampleRate, totalFrames }) {
  // Float32 spill. Quantizing to int16 here dithered the audio once, then
  // export dithered it again. The final encoder is the only quantizer.
  const header = wavHeaderBytes(channels, sampleRate, totalFrames, 32);
  let writer = null;
  let handle = null;
  let handleName = '';
  if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory && totalFrames * channels * 4 > 32 * 1024 * 1024) {
    try {
      const root = await navigator.storage.getDirectory();
      handleName = `vip-extract-${Date.now()}.wav`;
      handle = await root.getFileHandle(handleName, { create: true });
      writer = await handle.createWritable();
      await writer.write(header);
    } catch {
      writer = null;
      handle = null;
    }
  }
  const parts = writer ? null : [header];
  return {
    kind: 'file',
    write(samples) {
      const bytes = interleaveFloat32(samples);
      if (writer) return writer.write(bytes);
      parts.push(bytes);
      return undefined;
    },
    async finish() {
      if (writer) {
        await writer.close();
        writer = null;
        const file = await handle.getFile();
        const url = typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(file) : null;
        return { kind: 'file', file, url, frames: totalFrames, sampleRate, channels };
      }
      const blob = new Blob(parts, { type: 'audio/wav' });
      const url = typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(blob) : null;
      return { kind: 'file', file: blob, url, frames: totalFrames, sampleRate, channels };
    },
    async abort() {
      if (writer) {
        try { await writer.abort(); } catch { try { await writer.close(); } catch { /* already closed */ } }
        writer = null;
      }
      if (handle && handleName && navigator.storage?.getDirectory) {
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry(handleName);
        } catch { /* best-effort */ }
      }
    },
  };
}

function chooseSink(plan, prefer) {
  if (prefer === 'memory' || prefer === 'pcm') return 'pcm';
  if (prefer === 'file') return 'file';
  const pair = (plan.canonicalBytes || 0) * 2 + (plan.chunk?.peakBytes || 0);
  return pair <= (plan.budgetBytes || 0) ? 'pcm' : 'file';
}

/**
 * @param {Blob} file
 * @param {object} plan resolveIngestionPlan result
 * @param {object} options
 * @param {(channels: Float32Array[], sampleRate: number, info: object) => Promise<Float32Array[]>} options.processWindow
 * @param {(first: { index: number, clean: Float32Array[], noise: Float32Array[] | null, frames: number, startFrame: number, sampleRate: number }) => void} [options.onFirstWindow] Called once, right after the first
 *   window is written to the sink, with that window's emitted samples — the
 *   exact prefix of the final stems, so a caller can play it while the rest
 *   still processes. `noise` is null when the sink is file-backed (no noise
 *   stem is held). Best-effort: never awaited, and a throwing callback must
 *   not break extraction.
 */
export async function runChunkedExtraction(file, plan, options = {}) {
  const chunk = plan?.chunk;
  if (!chunk?.viable || !(chunk.strideFrames > 0)) {
    throw fail('CHUNK_PLAN', '[VIP][ChunkedExtraction] No viable chunk plan. Nothing was written.');
  }
  const total = plan.totalFrames;
  const channelCount = plan.outputChannels;
  const fade = chunk.fadeFrames;
  const sinkKind = chooseSink(plan, options.sink);
  const cleanSink = sinkKind === 'pcm' ? createMemorySink(channelCount) : await createFileSink({
    channels: channelCount, sampleRate: SAMPLE_RATE, totalFrames: total,
  });
  const noiseSink = sinkKind === 'pcm' ? createMemorySink(channelCount) : null;
  const readState = { readWindow: options.readWindow, signal: options.signal };
  let cleanTail = null;
  let noiseTail = null;
  let emitted = 0;
  let index = 0;
  const segments = [];
  try {
    for (let emitStart = 0; emitStart < total;) {
      if (options.signal?.aborted) throw abortError();
      const steadyCore = chunk.coreFrames;
      const firstCore = chunk.firstCoreFrames > 0 ? chunk.firstCoreFrames : steadyCore;
      const emitLen = Math.min(index === 0 ? firstCore : steadyCore, total - emitStart);
      const isLast = emitStart + emitLen >= total;
      const readStart = Math.max(0, emitStart - chunk.contextFrames);
      const readEnd = Math.min(total, emitStart + emitLen + chunk.contextFrames);
      const readCount = readEnd - readStart;
      const coreOffset = emitStart - readStart;
      const segment = { index, state: 'reading', startFrame: emitStart, frames: emitLen };
      segments.push(segment);
      options.onSegment?.(segment);
      const input = await readCanonicalWindow(file, plan, readStart, readCount, readState);
      if (!input?.length || input[0].length !== readCount) {
        segment.state = 'failed';
        throw fail('CHUNK_FAILED', `[VIP][ChunkedExtraction] Segment ${index} decoded ${input?.[0]?.length ?? 0} frames; expected ${readCount}. Output discarded.`, segment);
      }
      segment.state = 'processing';
      options.onSegment?.(segment);
      // Copy the core before the separator. transferOwned may detach `input`.
      const coreSnapshot = input.map((ch) => ch.slice(coreOffset, coreOffset + emitLen));
      let processed;
      try {
        processed = await options.processWindow(input, SAMPLE_RATE, { index, emitStart, emitLen, signal: options.signal });
      } catch (error) {
        segment.state = 'failed';
        error.segment = segment;
        throw error;
      }
      if (!processed || processed.length < input.length || processed[0].length !== readCount) {
        segment.state = 'failed';
        throw fail('CHUNK_FAILED', `[VIP][ChunkedExtraction] Segment ${index} returned ${processed?.[0]?.length ?? 0} frames; expected ${readCount}. The recording was not marked complete.`, segment);
      }
      const cleanCore = processed.slice(0, input.length).map((ch) => new Float32Array(ch.subarray(coreOffset, coreOffset + emitLen)));
      const noiseCore = cleanCore.map((ch, c) => {
        const n = new Float32Array(emitLen);
        const src = coreSnapshot[c];
        for (let i = 0; i < emitLen; i++) n[i] = src[i] - ch[i];
        return n;
      });
      const cleanPiece = stitchEmit(cleanCore, cleanTail, fade, isLast);
      await cleanSink.write(cleanPiece.samples);
      cleanTail = cleanPiece.tail;
      let noisePiece = null;
      if (noiseSink) {
        noisePiece = stitchEmit(noiseCore, noiseTail, fade, isLast);
        await noiseSink.write(noisePiece.samples);
        noiseTail = noisePiece.tail;
      }
      if (index === 0) {
        // The emitted piece is the crossfaded core minus the fade tail the
        // next segment emits, so it is the exact prefix of the final stems.
        // Publish it now: the caller can play the first window while the
        // rest still processes instead of waiting for the whole file.
        // Best-effort and never awaited — a preview failure must not break
        // extraction, and the loop must not stall on UI work.
        try {
          const first = options.onFirstWindow?.({
            index: 0,
            clean: cleanPiece.samples,
            noise: noisePiece ? noisePiece.samples : null,
            frames: cleanPiece.emitted,
            startFrame: emitStart,
            sampleRate: SAMPLE_RATE,
          });
          if (first && typeof first.catch === 'function') first.catch(() => {});
        } catch { /* preview is best-effort */ }
      }
      emitted += cleanPiece.emitted;
      segment.state = 'done';
      segment.emitted = cleanPiece.emitted;
      options.onProgress?.(Math.min(1, (emitStart + emitLen) / total), { index, emitted });
      if (isLast) break;
      const step = emitLen - fade;
      if (step <= 0) {
        segment.state = 'failed';
        throw fail('CHUNK_PLAN', `[VIP][ChunkedExtraction] Segment ${index} cannot advance. Output discarded.`, segment);
      }
      emitStart += step;
      index += 1;
    }
    if (emitted !== total) {
      throw fail('CHUNK_DURATION', `[VIP][ChunkedExtraction] Reconstructed ${emitted} frames; the plan required ${total}. Output discarded.`);
    }
    const clean = await cleanSink.finish();
    const noise = noiseSink ? await noiseSink.finish() : null;
    if (readState._reader?.close) await readState._reader.close();
    return {
      kind: clean.kind,
      clean: clean.channels || null,
      noise: noise?.channels || null,
      file: clean.file || null,
      url: clean.url || null,
      frames: emitted,
      duration: emitted / SAMPLE_RATE,
      sampleRate: SAMPLE_RATE,
      channels: channelCount,
      segments,
      strategy: 'chunked',
      modelId: chunk.modelId,
    };
  } catch (error) {
    await cleanSink.abort?.();
    await noiseSink?.abort?.();
    if (readState._reader?.close) {
      try { await readState._reader.close(); } catch { /* already closed */ }
    }
    throw error;
  }
}

/** Header parse used by tests and the WAV reader. Reads a geometrically growing
 * prefix (capped at 32 MiB) so large front-matter chunks do not cause a full
 * prefix copy and parse for every 1 MiB increment. An unfinished data size is
 * trimmed when a metadata chunk ends the file.
 * @param {Blob} file
 * @param {{signal?: AbortSignal}} [options]
 */
export async function wavMetadataFor(file, options = {}) {
  const size = Number(file?.size) || 0;
  const cap = Math.min(size > 0 ? size : WAV_HEADER_WALK_CAP, WAV_HEADER_WALK_CAP);
  const signal = options.signal || null;
  if (!options.headerChecked) {
    const header = new Uint8Array(await readHeaderSlice(file, 0, 12, signal));
    if (signal?.aborted) throw abortError();
    const signature = String.fromCharCode(...header.subarray(0, 4));
    const wave = String.fromCharCode(...header.subarray(8, 12));
    if (header.length < 12 || !['RIFF', 'RF64'].includes(signature) || wave !== 'WAVE') return null;
  }
  let length = 0;
  let meta = null;
  while (length < cap) {
    if (signal?.aborted) throw abortError();
    const next = Math.min(cap, Math.max(WAV_HEADER_WINDOW, length * 2));
    const buf = new Uint8Array(await readHeaderSlice(file, 0, next, signal));
    if (signal?.aborted) throw abortError();
    if (buf.length <= length) break;
    length = buf.length;
    meta = parseWavMetadata(buf, size || buf.length);
    if (meta) break;
  }
  if (signal?.aborted) throw abortError();
  if (meta?.unfinishedData && size > length) {
    const tailLen = Math.min(WAV_HEADER_WINDOW, size);
    const tail = new Uint8Array(await readHeaderSlice(file, size - tailLen, size, signal));
    if (signal?.aborted) throw abortError();
    meta = applyWavTail(meta, tail, size);
  }
  return meta;
}

function readHeaderSlice(file, start, end, signal) {
  if (!signal) return file.slice(start, end).arrayBuffer();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    let pending;
    try { pending = file.slice(start, end).arrayBuffer(); }
    catch (error) { finish(reject, error); return; }
    Promise.resolve(pending).then(
      (buffer) => finish(resolve, buffer),
      (error) => finish(reject, error),
    );
  });
}

/**
 * Canonical decoded-audio contract.
 *
 * A successful decode always carries a positive sample rate, a positive
 * channel count taken from the decoder or the PCM itself, and a positive
 * frame count taken from that PCM (or from a container table that enumerates
 * PCM frames). Empty channel lists, zero channels, and null frame counts are
 * rejected. Duration is frames / sampleRate within one sample.
 *
 * Chunked imports do not keep the whole file resident. They still have to
 * name the PCM they will decode: channel count, frame count, and rate, with
 * `metadataAuthority: 'pcm'`. A container duration with an assumed stereo
 * layout is not a decode.
 */
import { SAMPLE_RATE, resampledLength } from './audio-config.js';

/** One sample. Float64 round-trip of frames/rate stays inside this for legal lengths. */
export const DURATION_SAMPLE_TOLERANCE = 1;

const LAYOUTS = Object.freeze({
  1: 'mono',
  2: 'stereo',
  3: '3.0',
  4: '4.0',
  5: '5.0',
  6: '5.1',
  7: '6.1',
  8: '7.1',
});

/**
 * Why a chunked plan's frame count is trusted.
 * `pcm` is the normalized authority `buildChunkedDecodedAudio` writes.
 * `wav-pcm` is an exact PCM byte count from a WAV data chunk.
 * `mp4-sample-table` is the sample table, capped by the edit list.
 * `mp3-frames` counts samples in each parsed MPEG frame (1152 or 576). That
 * includes encoder delay and padding; it is the frame table, not a guess from
 * the file size. A decoder probe may still replace the channel count.
 * `decoded-pcm` / `decoded-buffer` are measurements from decoded samples.
 */
const PCM_AUTHORITIES = new Set([
  'pcm',
  'wav-pcm',
  'mp4-sample-table',
  'mp3-frames',
  'decoded-pcm',
  'decoded-buffer',
]);

export function channelLayoutName(channels) {
  if (!Number.isInteger(channels) || channels < 1) return null;
  return LAYOUTS[channels] || `${channels}-channel`;
}

/**
 * @param {{ stage?: string, file?: string|null, decoder?: string|null, field?: string|null, message: string, details?: object|null }} spec
 */
export function decodeMetadataError(spec) {
  const error = new Error(spec.message);
  error.name = 'DecodeMetadataError';
  error.code = 'DECODE_METADATA_INVALID';
  error.stage = spec.stage || 'ingest.metadata.validate';
  error.file = spec.file || null;
  error.decoder = spec.decoder || null;
  error.field = spec.field || null;
  if (spec.details) error.details = spec.details;
  return error;
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function positiveRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 768000;
}

/** Cross-realm safe. A transferred Float32Array fails `instanceof` in some test realms. */
function isFloat32Channel(value) {
  return ArrayBuffer.isView(value)
    && value.BYTES_PER_ELEMENT === 4
    && Object.prototype.toString.call(value) === '[object Float32Array]';
}

export function durationMatchesFrames(duration, frames, sampleRate) {
  if (!positiveRate(sampleRate) || !positiveInt(frames) || !Number.isFinite(duration) || duration <= 0) return false;
  return Math.abs(duration * sampleRate - frames) <= DURATION_SAMPLE_TOLERANCE;
}

function channelIsFinite(channel) {
  if (!channel || channel.length < 1) return false;
  for (let i = 0; i < channel.length; i++) {
    if (!Number.isFinite(channel[i])) return false;
  }
  return true;
}

/**
 * Channel count from a decoder measurement when one exists, otherwise from
 * the container. An explicit decoded count of 0 is unusable: do not replace
 * it with a guess.
 * @returns {number|null}
 */
export function resolveMeasuredChannels({ containerChannels = null, ascChannels = null, decodedChannels = null } = {}) {
  if (decodedChannels === 0) return null;
  if (positiveInt(decodedChannels)) return decodedChannels;
  if (positiveInt(containerChannels)) return containerChannels;
  if (positiveInt(ascChannels)) return ascChannels;
  return null;
}

function reject(field, message, extra = {}) {
  throw decodeMetadataError({ field, message, ...extra });
}

/**
 * Validate a decoded-audio record. Returns the same object when it is usable.
 * Chunked records omit resident PCM (`channelData` null) and must cite PCM
 * frame authority. Full records must carry aligned Float32 channels.
 */
export function validateDecodedAudio(decoded, context = {}) {
  const file = context.file || decoded?.sourceName || null;
  const decoder = context.decoder || decoded?.metadataSource || decoded?.decodingStrategy || null;
  const stage = context.stage || 'ingest.metadata.validate';
  const base = { file, decoder, stage };
  if (!decoded || typeof decoded !== 'object') {
    reject('decoded', '[VIP][DecodedAudio] The decoder returned no audio record. The file was not modified.', base);
  }
  const sampleRate = decoded.sampleRate;
  if (!positiveRate(sampleRate)) {
    reject('sampleRate', `[VIP][DecodedAudio] Sample rate is ${sampleRate}. A successful decode needs a positive rate. The file was not modified.`, base);
  }
  const channels = decoded.numberOfChannels;
  if (!positiveInt(channels)) {
    reject('channels', `[VIP][DecodedAudio] Channel count is ${channels}. A successful decode cannot report 0 or a missing channel count. The file was not modified.`, base);
  }
  const frames = decoded.numberOfFrames;
  if (!positiveInt(frames)) {
    reject('frames', `[VIP][DecodedAudio] Frame count is ${frames}. Frames are counted from PCM, never left null. The file was not modified.`, base);
  }
  if (!durationMatchesFrames(decoded.duration, frames, sampleRate)) {
    reject('duration', `[VIP][DecodedAudio] Duration ${decoded.duration} does not match ${frames} frames at ${sampleRate} Hz (tolerance ${DURATION_SAMPLE_TOLERANCE} sample). The file was not modified.`, base);
  }
  const chunked = decoded.strategy === 'chunked' && decoded.pcmResident === false;
  if (chunked) {
    if (Array.isArray(decoded.channelData) && decoded.channelData.length === 0) {
      reject('channels', '[VIP][DecodedAudio] Chunked decode reported an empty channel list. That is not a channel count. The file was not modified.', base);
    }
    if (!PCM_AUTHORITIES.has(decoded.metadataAuthority)) {
      reject('frames', `[VIP][DecodedAudio] Chunked decode has no PCM frame authority (${decoded.metadataAuthority || 'missing'}). Duration and a guessed layout are not a decode. The file was not modified.`, base);
    }
    if (positiveInt(decoded.sourceChannels) && decoded.sourceChannels < channels) {
      reject('channels', `[VIP][DecodedAudio] Processing ${channels} channels from a ${decoded.sourceChannels}-channel source. The file was not modified.`, base);
    }
    if (decoded.channelData == null) return decoded;
  }
  const list = decoded.channelData;
  if (!Array.isArray(list) || list.length !== channels) {
    reject('channels', `[VIP][DecodedAudio] PCM has ${Array.isArray(list) ? list.length : 0} channels; the record says ${channels}. The file was not modified.`, base);
  }
  for (let i = 0; i < list.length; i++) {
    const channel = list[i];
    if (!isFloat32Channel(channel)) {
      reject('channelData', `[VIP][DecodedAudio] Channel ${i} is not Float32 PCM. The file was not modified.`, base);
    }
    if (channel.byteLength === 0) {
      reject('channelData', `[VIP][DecodedAudio] Channel ${i} was detached before it could be used. The file was not modified.`, base);
    }
    if (channel.length !== frames) {
      reject('frames', `[VIP][DecodedAudio] Channel ${i} has ${channel.length} frames; expected ${frames}. Channels must stay aligned. The file was not modified.`, base);
    }
    if (!channelIsFinite(channel)) {
      reject('channelData', `[VIP][DecodedAudio] Channel ${i} has a non-finite sample. The file was not modified.`, base);
    }
  }
  return decoded;
}

/**
 * Build a record from PCM that is already in memory. Declared zero channels
 * or a null frame count are ignored when the arrays themselves are usable.
 * A declared positive count that disagrees with the arrays is an error.
 */
export function recoverDecodedAudio(input = {}, context = {}) {
  const list = input.channelData;
  const file = context.file || input.sourceName || null;
  const decoder = context.decoder || input.metadataSource || 'decoded-pcm';
  const base = { file, decoder, stage: context.stage || 'ingest.metadata.validate' };
  if (!Array.isArray(list) || list.length < 1 || !isFloat32Channel(list[0]) || list[0].length < 1) {
    const field = !Array.isArray(list) || list.length < 1 ? 'channels' : 'frames';
    reject(field, '[VIP][DecodedAudio] PCM is missing, so channel count and frame count cannot be recovered. The file was not modified.', base);
  }
  const channels = list.length;
  const frames = list[0].length;
  if (positiveInt(input.numberOfChannels) && input.numberOfChannels !== channels) {
    reject('channels', `[VIP][DecodedAudio] Declared ${input.numberOfChannels} channels but the PCM has ${channels}. The file was not modified.`, base);
  }
  if (positiveInt(input.numberOfFrames) && input.numberOfFrames !== frames) {
    reject('frames', `[VIP][DecodedAudio] Declared ${input.numberOfFrames} frames but the PCM has ${frames}. The file was not modified.`, base);
  }
  if (!positiveRate(input.sampleRate)) {
    reject('sampleRate', '[VIP][DecodedAudio] PCM is present but the sample rate is missing. The rate is not estimated from the file size. The file was not modified.', base);
  }
  return validateDecodedAudio({
    ...input,
    channelData: list,
    sampleRate: input.sampleRate,
    numberOfChannels: channels,
    numberOfFrames: frames,
    duration: frames / input.sampleRate,
    strategy: input.strategy || 'full',
    decodingStrategy: input.decodingStrategy || input.strategy || 'full',
    pcmResident: true,
    metadataAuthority: 'decoded-pcm',
    channelLayout: input.channelLayout || channelLayoutName(channels),
    metadataSource: input.metadataSource || 'decoded-pcm',
  }, context);
}

/**
 * AudioBuffer contract. Frame count and channel count come from the buffer
 * the decoder produced. The channel views are not retained.
 */
export function assertAudioBufferContract(buffer, context = {}) {
  const file = context.file || null;
  const base = { file, decoder: context.decoder || 'audio-buffer', stage: context.stage || 'ingest.metadata.validate' };
  if (!buffer || typeof buffer.getChannelData !== 'function') {
    reject('decoded', '[VIP][DecodedAudio] The decoder did not return an audio buffer. The file was not modified.', base);
  }
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const sampleRate = buffer.sampleRate;
  if (!positiveInt(channels)) {
    reject('channels', `[VIP][DecodedAudio] Decoded buffer reports ${channels} channels. The file was not modified.`, base);
  }
  if (!positiveInt(frames)) {
    reject('frames', `[VIP][DecodedAudio] Decoded buffer reports ${frames} frames. The file was not modified.`, base);
  }
  if (!positiveRate(sampleRate)) {
    reject('sampleRate', `[VIP][DecodedAudio] Decoded buffer reports sample rate ${sampleRate}. The file was not modified.`, base);
  }
  for (let i = 0; i < channels; i++) {
    const channel = buffer.getChannelData(i);
    if (!isFloat32Channel(channel) || channel.length !== frames) {
      reject('frames', `[VIP][DecodedAudio] Decoded channel ${i} length ${channel?.length} does not match ${frames}. The file was not modified.`, base);
    }
    if (!channelIsFinite(channel)) {
      reject('channelData', `[VIP][DecodedAudio] Decoded channel ${i} has a non-finite sample. The file was not modified.`, base);
    }
  }
  return {
    sampleRate,
    numberOfChannels: channels,
    numberOfFrames: frames,
    duration: frames / sampleRate,
    channelLayout: channelLayoutName(channels),
    metadataAuthority: 'decoded-buffer',
    // Counts checked against the buffer. The channel views stay on the
    // AudioBuffer, so this object is not itself a resident PCM record.
    pcmChecked: true,
  };
}

/**
 * Chunked success record. Requires a plan whose frames were counted from PCM.
 * `channelData` is null: the bytes are not resident, and an empty array is
 * not used as a stand-in channel count.
 */
export function buildChunkedDecodedAudio(plan, file = {}, extra = {}) {
  const name = file?.name || extra.sourceName || 'untitled';
  const base = {
    file: name,
    decoder: plan?.metadataSource || plan?.contract?.id || 'chunked',
    stage: 'ingest.metadata.validate',
  };
  if (!plan || plan.strategy !== 'chunked') {
    reject('strategy', '[VIP][DecodedAudio] Chunked decode was requested without a chunked plan. The file was not modified.', base);
  }
  if (plan.frameAuthority !== 'pcm' || !positiveInt(plan.sourceFrames) || plan.channelsAssumed) {
    const field = plan?.channelsAssumed || !positiveInt(plan?.channels) ? 'channels' : 'frames';
    reject(field, `[VIP][FileIngestion] Cannot import “${name}” in chunked mode: the container did not provide a measured channel count and a PCM frame count (authority ${plan?.frameAuthority || 'missing'}). Duration and a guessed layout are not a decode. The file was not modified. Export WAV, M4A/AAC, or MP3, or use a shorter file that fits in memory.`, base);
  }
  const numberOfChannels = plan.outputChannels;
  const numberOfFrames = plan.totalFrames;
  const sampleRate = SAMPLE_RATE;
  if (!positiveInt(numberOfChannels) || !positiveInt(numberOfFrames)) {
    reject(!positiveInt(numberOfChannels) ? 'channels' : 'frames', `[VIP][FileIngestion] Chunked plan for “${name}” has channels ${numberOfChannels} and frames ${numberOfFrames}. The file was not modified.`, base);
  }
  const record = {
    strategy: 'chunked',
    decodingStrategy: 'chunked',
    pcmResident: false,
    channelData: null,
    sampleRate,
    sourceSampleRate: plan.sampleRate,
    numberOfChannels,
    sourceChannels: plan.channels,
    numberOfFrames,
    sourceFrames: plan.sourceFrames,
    duration: numberOfFrames / sampleRate,
    channelLayout: channelLayoutName(plan.channels),
    metadataAuthority: 'pcm',
    metadataSource: plan.metadataSource || null,
    sourceName: name,
    ingestionPlan: plan,
    sourceFile: file,
    ...extra,
  };
  return validateDecodedAudio(record, { file: name, decoder: record.metadataSource, stage: 'ingest.metadata.validate' });
}

/**
 * Fields safe to log. Throws when the record would reproduce
 * { channels: 0, frames: null } as a success.
 */
export function ingestDecodedDetail(decoded, { bytes = null } = {}) {
  const valid = validateDecodedAudio(decoded);
  const frames = valid.numberOfFrames;
  const channels = valid.numberOfChannels;
  const residentBytes = valid.pcmResident && Array.isArray(valid.channelData)
    ? valid.channelData.reduce((sum, channel) => sum + (channel?.byteLength || 0), 0)
    : 0;
  return {
    bytes,
    duration: valid.duration,
    sampleRate: valid.sampleRate,
    channels,
    frames,
    sourceChannels: valid.sourceChannels ?? channels,
    sourceSampleRate: valid.sourceSampleRate ?? valid.sampleRate,
    sourceFrames: valid.sourceFrames ?? frames,
    chunkCount: valid.chunkCount ?? null,
    decodedPcmBytes: residentBytes,
    plannedPcmBytes: frames * channels * 4,
    strategy: valid.strategy || valid.decodingStrategy || null,
    channelLayout: valid.channelLayout || channelLayoutName(valid.sourceChannels || channels),
    metadataAuthority: valid.metadataAuthority || null,
    pcmResident: valid.pcmResident !== false,
  };
}

/** The production failure shape is not a successful decode. */
export function assertSuccessfulDecodeReport(report, context = {}) {
  const channels = report?.channels ?? report?.numberOfChannels;
  const frames = report?.frames ?? report?.numberOfFrames;
  return validateDecodedAudio({
    sampleRate: report?.sampleRate,
    numberOfChannels: channels,
    numberOfFrames: frames,
    duration: report?.duration,
    strategy: report?.strategy || 'full',
    pcmResident: report?.strategy !== 'chunked',
    metadataAuthority: report?.strategy === 'chunked' ? (report?.metadataAuthority || null) : 'decoded-pcm',
    channelData: report?.strategy === 'chunked' ? null : report?.channelData,
  }, context);
}

/**
 * Descriptor carried with a worker transfer. The arrays are the authority;
 * a declared count is checked against them and never invents a missing one.
 */
export function describeTransferredChannels(channelData, sampleRate, declared = {}) {
  return recoverDecodedAudio({
    channelData,
    sampleRate,
    numberOfChannels: declared.numberOfChannels,
    numberOfFrames: declared.numberOfFrames,
    strategy: 'full',
    metadataSource: 'worker-transfer',
  }, { stage: 'ingest.worker.transfer', decoder: 'worker', file: declared.file || null });
}

export function canonicalFrameCount(sourceFrames, sourceRate) {
  if (!positiveInt(sourceFrames) || !positiveRate(sourceRate)) return null;
  const frames = resampledLength(sourceFrames, sourceRate);
  return positiveInt(frames) ? frames : null;
}

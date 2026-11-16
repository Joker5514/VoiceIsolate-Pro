/**
 * Decoded-audio contract. The production stems log
 * { sampleRate: 48000, channels: 0, frames: null, duration: 2258.752, strategy: 'chunked' }
 * must be impossible to report as a successful decode.
 *
 * The 9,177,121-byte / 2258.752 s recording is not in this repo. Fixtures are synthetic.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

let audio;
let budget;
let preflight;
let compressed;
let chunked;
let handshake;

const PRODUCTION_DURATION = 2258.752;
const PRODUCTION_BYTES = 9177121;
const PRODUCTION_FRAMES = Math.round(PRODUCTION_DURATION * 48000);

beforeAll(async () => {
  audio = await import('../src/core/DecodedAudio.js');
  budget = await import('../src/core/IngestionBudget.js');
  preflight = await import('../src/pipeline/IngestionPreflight.js');
  compressed = await import('../src/pipeline/CompressedAudioReader.js');
  chunked = await import('../src/pipeline/ChunkedExtraction.js');
  handshake = await import('../src/core/ProviderHandshake.js');
});

function tinyBudget() {
  return { workingBytes: 64 * 1024 * 1024, tier: 'CONSTRAINED' };
}

function monoPcm(frames, value = 0.25) {
  const channel = new Float32Array(frames);
  for (let i = 0; i < frames; i++) channel[i] = value;
  return [channel];
}

function wavBlob({ seconds = 1, channels = 1, rate = 48000, bits = 16, dataBytes = null } = {}) {
  const block = channels * (bits / 8);
  const frames = Math.round(seconds * rate);
  const data = dataBytes == null ? frames * block : dataBytes;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * block, 28);
  header.writeUInt16LE(block, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(data, 40);
  const payload = Buffer.alloc(data);
  const file = new Blob([header, payload], { type: 'audio/wav' });
  Object.defineProperty(file, 'name', { value: 'synthetic.wav' });
  return file;
}

describe('successful decode gate', () => {
  test('the production stems report is not a successful decode', () => {
    const reported = {
      sampleRate: 48000,
      channels: 0,
      frames: null,
      duration: PRODUCTION_DURATION,
      bytes: PRODUCTION_BYTES,
      strategy: 'chunked',
    };
    expect(() => audio.assertSuccessfulDecodeReport(reported, { file: 'production-log' })).toThrow(/Channel count/);
  });

  test('an empty chunked channel list cannot stand in for a channel count', () => {
    expect(() => audio.validateDecodedAudio({
      strategy: 'chunked',
      pcmResident: false,
      channelData: [],
      sampleRate: 48000,
      numberOfChannels: 2,
      numberOfFrames: PRODUCTION_FRAMES,
      duration: PRODUCTION_FRAMES / 48000,
      metadataAuthority: 'pcm',
    })).toThrow(/empty channel list/);
  });

  test('synthetic PCM at the reported duration, rate and byte length validates as chunked mono', () => {
    const metadata = {
      duration: PRODUCTION_FRAMES / 48000,
      channels: 1,
      sampleRate: 48000,
      frames: PRODUCTION_FRAMES,
      source: 'wav-header',
      dataBytes: PRODUCTION_FRAMES * 2,
      blockAlign: 2,
    };
    const plan = budget.resolveIngestionPlan(metadata, PRODUCTION_BYTES, tinyBudget(), { profile: 'LOW' });
    expect(plan.strategy).toBe('chunked');
    expect(plan.frameAuthority).toBe('pcm');
    expect(plan.channelsAssumed).toBe(false);
    const decoded = audio.buildChunkedDecodedAudio(plan, { name: 'synthetic-not-the-production-file.wav', size: PRODUCTION_BYTES });
    expect(decoded.channelData).toBeNull();
    expect(decoded.numberOfChannels).toBe(1);
    expect(decoded.numberOfFrames).toBe(PRODUCTION_FRAMES);
    expect(decoded.sampleRate).toBe(48000);
    expect(decoded.duration).toBeCloseTo(PRODUCTION_DURATION, 6);
    const detail = audio.ingestDecodedDetail(decoded, { bytes: PRODUCTION_BYTES });
    expect(detail).toMatchObject({
      bytes: PRODUCTION_BYTES,
      sampleRate: 48000,
      channels: 1,
      frames: PRODUCTION_FRAMES,
      strategy: 'chunked',
      pcmResident: false,
      decodedPcmBytes: 0,
    });
    expect(detail.channels).toBeGreaterThan(0);
    expect(detail.frames).toBeGreaterThan(0);
    expect(() => audio.assertSuccessfulDecodeReport(detail)).not.toThrow();
  });

  test('a duration-only container is not promoted to a successful chunked decode', () => {
    const plan = budget.resolveIngestionPlan(
      { duration: PRODUCTION_DURATION, channels: null, sampleRate: null, source: 'mp4-mvhd' },
      PRODUCTION_BYTES,
      tinyBudget(),
      { profile: 'LOW' },
    );
    expect(plan.strategy).toBe('chunked');
    expect(plan.channelsAssumed).toBe(true);
    expect(plan.frameAuthority).toBe('duration-estimate');
    expect(() => audio.buildChunkedDecodedAudio(plan, { name: 'voice.m4a' })).toThrow(/channel count and a PCM frame count/);
  });
});

describe('PCM recovery and layout', () => {
  test.each([
    ['mono', 1],
    ['stereo', 2],
    ['multichannel', 6],
  ])('%s PCM recovers channels and frames when the declared metadata is zero or null', (_label, count) => {
    const channelData = Array.from({ length: count }, (_, channel) => {
      const data = new Float32Array(5);
      data[0] = 0.1 * (channel + 1);
      data[4] = -0.2;
      return data;
    });
    const recovered = audio.recoverDecodedAudio({
      channelData,
      sampleRate: 48000,
      numberOfChannels: 0,
      numberOfFrames: null,
    });
    expect(recovered.numberOfChannels).toBe(count);
    expect(recovered.numberOfFrames).toBe(5);
    expect(recovered.channelLayout).toBe(count === 1 ? 'mono' : count === 2 ? 'stereo' : '5.1');
    expect(recovered.duration).toBeCloseTo(5 / 48000, 8);
  });

  test('inconsistent channel lengths and a non-finite sample are rejected', () => {
    expect(() => audio.validateDecodedAudio({
      strategy: 'full',
      pcmResident: true,
      sampleRate: 48000,
      numberOfChannels: 2,
      numberOfFrames: 4,
      duration: 4 / 48000,
      metadataAuthority: 'decoded-pcm',
      channelData: [new Float32Array(4), new Float32Array(3)],
    })).toThrow(/aligned|frames/i);
    const bad = new Float32Array([0, Number.NaN]);
    expect(() => audio.recoverDecodedAudio({ channelData: [bad], sampleRate: 16000 })).toThrow(/non-finite/);
    const interior = new Float32Array([0.1, Number.NaN, 0.2]);
    expect(() => audio.recoverDecodedAudio({ channelData: [interior], sampleRate: 48000 })).toThrow(/non-finite/);
  });

  test('missing PCM cannot be repaired by inventing frames from a byte size', () => {
    expect(() => audio.recoverDecodedAudio({
      channelData: [],
      sampleRate: 48000,
      bytes: PRODUCTION_BYTES,
    })).toThrow(/cannot be recovered/);
    expect(() => audio.recoverDecodedAudio({
      channelData: monoPcm(8),
      sampleRate: 0,
    })).toThrow(/sample rate/);
  });

  test('a declared positive frame count that disagrees with the PCM is an error', () => {
    expect(() => audio.describeTransferredChannels(monoPcm(8), 48000, { numberOfFrames: 4 })).toThrow(/frames/);
  });

  test('44100 Hz PCM maps onto the canonical 48000 Hz frame count', () => {
    const sourceFrames = 44100;
    expect(audio.canonicalFrameCount(sourceFrames, 44100)).toBe(48000);
    const plan = budget.resolveIngestionPlan({
      duration: 1,
      channels: 2,
      sampleRate: 44100,
      frames: sourceFrames,
      source: 'mp3-frames',
    }, 128000, tinyBudget(), { profile: 'LOW' });
    expect(plan.frameAuthority).toBe('pcm');
    expect(plan.sourceFrames).toBe(sourceFrames);
    expect(plan.totalFrames).toBe(48000);
    expect(plan.sampleRate).toBe(44100);
    expect(plan.outputChannels).toBe(2);
  });

  test('decoder channel 0 is not replaced with stereo', () => {
    expect(audio.resolveMeasuredChannels({ containerChannels: 2, decodedChannels: 0 })).toBeNull();
    expect(audio.resolveMeasuredChannels({ containerChannels: 0, ascChannels: 1, decodedChannels: null })).toBe(1);
    expect(audio.resolveMeasuredChannels({ containerChannels: 2, decodedChannels: 1 })).toBe(1);
  });
});

describe('chunk assembly', () => {
  test('variable chunks, an empty chunk, and a short final chunk keep every sample', () => {
    const out = chunked.assemblePlanarChannels([
      [new Float32Array([1, 2]), new Float32Array(0), new Float32Array([3])],
      [new Float32Array([4]), new Float32Array([5, 6])],
    ], 3);
    expect(Array.from(out[0])).toEqual([1, 2, 3]);
    expect(Array.from(out[1])).toEqual([4, 5, 6]);
  });

  test('a short aggregate is not zero-padded', () => {
    expect(() => chunked.assemblePlanarChannels([[new Float32Array([1, 2, 3])]], 8)).toThrow(/Refusing to pad/);
  });

  test('uneven final windows still sum to the plan, and a channel mismatch fails', async () => {
    const hop = 1024;
    const total = hop * 5 + 100;
    const plan = {
      chunk: {
        viable: true,
        coreFrames: hop * 4,
        firstCoreFrames: hop * 4,
        contextFrames: hop,
        fadeFrames: hop,
        strideFrames: hop * 3,
        modelId: 'bsrnn_vocals',
      },
      totalFrames: total,
      outputChannels: 1,
      canonicalBytes: total * 4,
      budgetBytes: 32 * 1024 * 1024,
      duration: total / 48000,
      sampleRate: 48000,
      frameAuthority: 'pcm',
    };
    const tone = (start, count) => [Float32Array.from({ length: count }, (_, i) => Math.sin((start + i) * 0.01))];
    const result = await chunked.runChunkedExtraction(null, plan, {
      sink: 'memory',
      readWindow: (start, count) => tone(start, count),
      processWindow: async (input) => input.map((channel) => new Float32Array(channel)),
    });
    expect(result.frames).toBe(total);
    expect(result.channels).toBe(1);
    expect(result.sampleRate).toBe(48000);
    expect(result.segments.at(-1).frames).toBeLessThan(plan.chunk.coreFrames);
    expect(chunked.plannedChunkCount(plan)).toBe(result.segments.length);
    await expect(chunked.runChunkedExtraction(null, { ...plan, outputChannels: 2 }, {
      sink: 'memory',
      readWindow: (start, count) => tone(start, count),
      processWindow: async (input) => input,
    })).rejects.toMatchObject({ code: 'CHUNK_FAILED' });
  });

  test('cancellation during a window rejects and a failed window does not return PCM', async () => {
    const plan = {
      chunk: {
        viable: true, coreFrames: 2048, firstCoreFrames: 2048, contextFrames: 512, fadeFrames: 512, strideFrames: 1536,
      },
      totalFrames: 8000,
      outputChannels: 1,
      budgetBytes: 8 * 1024 * 1024,
      canonicalBytes: 8000 * 4,
    };
    const signal = new AbortController();
    signal.abort();
    await expect(chunked.runChunkedExtraction(null, plan, {
      signal: signal.signal,
      readWindow: () => [new Float32Array(8)],
      processWindow: async (input) => input,
    })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(chunked.runChunkedExtraction(null, plan, {
      readWindow: (_start, count) => [new Float32Array(count)],
      processWindow: async () => { throw Object.assign(new Error('boom'), { code: 'CHUNK_FAILED' }); },
    })).rejects.toThrow(/boom/);
  });
});

describe('container PCM layout', () => {
  test('a mono WAV preflight counts frames from the data chunk', async () => {
    const file = wavBlob({ seconds: 1, channels: 1, rate: 48000 });
    const plan = await preflight.preflightIngestion(file);
    expect(plan.frameAuthority).toBe('pcm');
    expect(plan.channels).toBe(1);
    expect(plan.channelsAssumed).toBe(false);
    expect(plan.sourceFrames).toBe(48000);
    expect(plan.outputChannels).toBe(1);
  });

  test('a truncated WAV counts only the PCM bytes that are present', () => {
    const bytes = Buffer.alloc(46);
    bytes.write('RIFF', 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WAVE', 8);
    bytes.write('fmt ', 12);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(48000, 24);
    bytes.writeUInt32LE(96000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(48000 * 2 * 10, 40);
    bytes.writeInt16LE(1000, 44);
    const meta = budget.parseWavMetadata(bytes, bytes.length);
    expect(meta.channels).toBe(1);
    expect(meta.dataBytes).toBe(2);
    expect(Math.floor(meta.dataBytes / meta.blockAlign)).toBe(1);
  });

  test('MPEG channel mode is read from the frame header', async () => {
    const frame = Buffer.alloc(417);
    frame[0] = 0xff;
    frame[1] = 0xfb;
    frame[2] = 0x90;
    frame[3] = 0xc0;
    const file = new Blob([frame, frame], { type: 'audio/mpeg' });
    Object.defineProperty(file, 'name', { value: 'mono.mp3' });
    const info = await compressed.parseMp3Frames(file);
    expect(info.channels).toBe(1);
    expect(info.sampleRate).toBe(44100);
    const layout = compressed.layoutFromParsedAudio(info);
    expect(layout.channels).toBe(1);
    expect(layout.frames).toBe(2304);
    expect(layout.source).toBe('mp3-frames');
    const plan = await preflight.preflightIngestion(file);
    expect(plan.channels).toBe(1);
    expect(plan.sourceFrames).toBe(2304);
    expect(plan.frameAuthority).toBe('pcm');
  });

  test('MPEG-2 Layer III frames count 576 samples at the MPEG-2 rate', async () => {
    const frame = Buffer.alloc(417);
    frame[0] = 0xff;
    frame[1] = 0xf3;
    frame[2] = 0xc0;
    frame[3] = 0x00;
    const file = new Blob([frame, frame], { type: 'audio/mpeg' });
    Object.defineProperty(file, 'name', { value: 'mpeg2.mp3' });
    const info = await compressed.parseMp3Frames(file);
    expect(info.sampleRate).toBe(22050);
    expect(info.samples).toHaveLength(2);
    expect(info.samples[0].duration).toBe(576);
    const layout = compressed.layoutFromParsedAudio(info);
    expect(layout.frames).toBe(1152);
  });

  test('AAC channel 0 in the sample entry falls back to AudioSpecificConfig', () => {
    expect(compressed.aacChannelCount(Uint8Array.from([0x11, 0x88]))).toBe(1);
    expect(compressed.aacChannelCount(Uint8Array.from([0x11, 0x90]))).toBe(2);
    // channelConfiguration 7 is 7.1 (8 channels). 8 is reserved.
    expect(compressed.aacChannelCount(Uint8Array.from([0x11, 0xb8]))).toBe(8);
    expect(compressed.aacChannelCount(Uint8Array.from([0x11, 0xc0]))).toBeNull();
    const layout = compressed.layoutFromParsedAudio({
      codec: 'mp4a.40.2',
      channels: 0,
      sampleRate: 48000,
      description: Uint8Array.from([0x11, 0x88]),
      timescale: 48000,
      primingFrames: 0,
      samples: [{ time: 0, duration: 1024 }, { time: 1024, duration: 1024 }],
    });
    expect(layout.channels).toBe(1);
    expect(layout.frames).toBe(2048);
    expect(layout.source).toBe('mp4-sample-table');
    const zeroDecoder = compressed.layoutFromParsedAudio({
      codec: 'mp4a.40.2',
      channels: 2,
      decodedChannels: 0,
      sampleRate: 48000,
      timescale: 48000,
      samples: [{ time: 0, duration: 1024 }],
    });
    expect(zeroDecoder).toBeNull();
    const hour = 3600 * 48000;
    const half = 1800 * 48000;
    const trimmed = compressed.layoutFromParsedAudio({
      codec: 'mp4a.40.2',
      channels: 1,
      sampleRate: 48000,
      timescale: 48000,
      primingFrames: 0,
      editPlaybackFrames: half,
      samples: [{ time: 0, duration: hour }],
    });
    expect(trimmed.frames).toBe(half);
    expect(trimmed.duration).toBeCloseTo(1800, 6);
  });

  test('an edit list shorter than the sample table caps the chunked plan', async () => {
    const box = (type, payload) => {
      const out = Buffer.alloc(8 + payload.length);
      out.writeUInt32BE(out.length, 0);
      out.write(type, 4, 4, 'ascii');
      payload.copy(out, 8);
      return out;
    };
    const mvhd = Buffer.alloc(20);
    mvhd.writeUInt32BE(1000, 12);
    mvhd.writeUInt32BE(1800 * 1000, 16);
    const elst = Buffer.alloc(20);
    elst.writeUInt32BE(1, 4);
    elst.writeUInt32BE(1800 * 1000, 8);
    elst.writeInt32BE(0, 12);
    elst.writeInt16BE(1, 16);
    const mdhd = Buffer.alloc(24);
    mdhd.writeUInt32BE(48000, 12);
    const stsdEntry = Buffer.alloc(36);
    stsdEntry.writeUInt32BE(36, 0);
    stsdEntry.write('mp4a', 4, 4, 'ascii');
    stsdEntry.writeUInt16BE(1, 24);
    stsdEntry.writeUInt32BE(48000 * 65536, 32);
    const stsd = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), stsdEntry]);
    const stts = Buffer.alloc(16);
    stts.writeUInt32BE(1, 4);
    stts.writeUInt32BE(3600, 8);
    stts.writeUInt32BE(48000, 12);
    const stsc = Buffer.alloc(20);
    stsc.writeUInt32BE(1, 4);
    stsc.writeUInt32BE(1, 8);
    stsc.writeUInt32BE(3600, 12);
    stsc.writeUInt32BE(1, 16);
    const stsz = Buffer.alloc(20);
    stsz.writeUInt32BE(8, 4);
    stsz.writeUInt32BE(3600, 8);
    const stco = Buffer.alloc(16);
    stco.writeUInt32BE(1, 4);
    stco.writeUInt32BE(64, 8);
    const stbl = box('stbl', Buffer.concat([
      box('stsd', stsd), box('stts', stts), box('stsc', stsc), box('stsz', stsz), box('stco', stco),
    ]));
    const trak = box('trak', Buffer.concat([
      box('edts', box('elst', elst)),
      box('mdia', Buffer.concat([box('mdhd', mdhd), box('minf', stbl)])),
    ]));
    const file = new Blob([box('moov', Buffer.concat([box('mvhd', mvhd), trak]))], { type: 'audio/mp4' });
    Object.defineProperty(file, 'name', { value: 'trimmed.m4a' });
    const info = await compressed.parseMp4Audio(file);
    expect(info.editPlaybackFrames).toBe(1800 * 48000);
    const layout = compressed.layoutFromParsedAudio(info);
    expect(layout.frames).toBe(1800 * 48000);
    expect(layout.frames).toBeLessThan(3600 * 48000);
  });

  test('a long container with only a movie duration cannot be logged as decoded', async () => {
    const ticks = Math.round(PRODUCTION_DURATION * 1000);
    const payload = Buffer.alloc(20);
    payload.writeUInt32BE(1000, 12);
    payload.writeUInt32BE(ticks, 16);
    const box = (type, body) => {
      const out = Buffer.alloc(8 + body.length);
      out.writeUInt32BE(out.length, 0);
      out.write(type, 4, 4, 'ascii');
      body.copy(out, 8);
      return out;
    };
    const ftyp = box('ftyp', Buffer.from('isom\x00\x00\x02\x00isomiso2'));
    const moov = box('moov', box('mvhd', payload));
    const file = new Blob([ftyp, box('mdat', Buffer.alloc(16)), moov], { type: 'video/mp4' });
    Object.defineProperty(file, 'name', { value: 'duration-only.mp4' });
    await expect(preflight.preflightIngestion(file)).rejects.toMatchObject({
      code: 'DECODE_METADATA_INVALID',
      field: 'channels',
      stage: 'ingest.metadata.validate',
    });
  });
});

describe('worker transfer and provider handshake', () => {
  test('a transferred Float32 channel keeps its frame count after the sender buffer is detached', () => {
    const channel = new Float32Array([0.25, -0.5, 0.125, 0]);
    const moved = structuredClone(
      { channelData: [channel], sampleRate: 48000 },
      { transfer: [channel.buffer] },
    );
    expect(channel.byteLength).toBe(0);
    const restored = audio.describeTransferredChannels(moved.channelData, moved.sampleRate, {
      numberOfChannels: 0,
      numberOfFrames: null,
    });
    expect(restored.numberOfChannels).toBe(1);
    expect(restored.numberOfFrames).toBe(4);
    expect(Array.from(moved.channelData[0])).toEqual([0.25, -0.5, 0.125, 0]);
  });

  test('a ready handshake with a GPU candidate stays unverified', () => {
    const ready = handshake.explainProviderReady({
      type: 'ready',
      backend: 'wasm',
      gpuCandidate: true,
      providerVerified: true,
    });
    expect(ready.providerVerified).toBe(false);
    expect(ready.gpuCandidate).toBe(true);
    expect(ready.code).toBe('PROVIDER_UNVERIFIED');
    const verified = handshake.explainProviderReady({
      type: 'ort-provider',
      backend: 'wasm',
      providerVerified: true,
    });
    expect(verified).toMatchObject({ providerVerified: true, backend: 'wasm' });
    const missing = handshake.explainProviderReady({ type: 'error', code: 'PROVIDER_INIT_FAILED' });
    expect(missing).toMatchObject({ providerVerified: false, ready: false, code: 'PROVIDER_INIT_FAILED' });
    expect(handshake.planStartupProviderFailure({
      code: 'PROVIDER_INIT_FAILED',
      message: 'ONNX Runtime did not initialize in the worker.',
    })).toEqual({
      terminate: true,
      backend: 'unavailable',
      message: 'ONNX Runtime did not initialize in the worker.',
    });
    expect(handshake.planStartupProviderFailure({
      code: 'PROVIDER_INIT_FAILED',
      requestId: 4,
    })).toBeNull();
    const landing = fs.readFileSync(path.join(root, 'public/landing.js'), 'utf8');
    expect(landing).toContain('planStartupProviderFailure');
    expect(landing).toMatch(/startup\?\.terminate[\s\S]*ownedWorker\.terminate\(\)/);
  });

  test('the stems page no longer derives channels from an empty PCM list', () => {
    const landing = fs.readFileSync(path.join(root, 'public/landing.js'), 'utf8');
    const engineer = fs.readFileSync(path.join(root, 'public/app/app.js'), 'utf8');
    expect(landing).not.toMatch(/channels:\s*Array\.isArray\(next\.channelData\)/);
    expect(landing).toContain('ingestDecodedDetail');
    expect(landing).toContain("vipLog('info', 'ingest.decoded'");
    expect(engineer).toContain("structuredLog('info', 'ingest.decoded'");
    expect(engineer).toContain('buildChunkedDecodedAudio');
  });
});

'use strict';
let budget, preflight, chunked, compressed;
beforeAll(async () => {
  budget = await import('../src/core/IngestionBudget.js');
  preflight = await import('../src/pipeline/IngestionPreflight.js');
  chunked = await import('../src/pipeline/ChunkedExtraction.js');
  compressed = await import('../src/pipeline/CompressedAudioReader.js');
});
function wavHeader({ seconds = 1, channels = 2, rate = 48000, bits = 16 } = {}) {
  const block = channels * bits / 8;
  const data = Math.round(seconds * rate) * block;
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * block, 28);
  b.writeUInt16LE(block, 32); b.writeUInt16LE(bits, 34); b.write('data', 36); b.writeUInt32LE(data, 40);
  return b;
}
test('WAV metadata uses declared data length, channels, rate and bit depth', () => {
  expect(budget.parseWavMetadata(wavHeader({ seconds: 2, channels: 1, rate: 44100, bits: 24 })))
    .toMatchObject({ duration: 2, channels: 1, sampleRate: 44100, bitDepth: 24, source: 'wav-header' });
  expect(budget.parseWavMetadata(Buffer.from('RIFFbroken'))).toBeNull();
});

test('large WAV front matter is parsed with geometrically bounded reads', async () => {
  const metadataBytes = 9 * 1024 * 1024;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(48000, 4);
  fmt.writeUInt32LE(96000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
  const chunks = Buffer.alloc(56 + metadataBytes);
  chunks.write('RIFF', 0); chunks.writeUInt32LE(chunks.length - 8, 4); chunks.write('WAVE', 8);
  chunks.write('JUNK', 12); chunks.writeUInt32LE(metadataBytes, 16);
  const fmtAt = 20 + metadataBytes;
  chunks.write('fmt ', fmtAt); chunks.writeUInt32LE(fmt.length, fmtAt + 4); fmt.copy(chunks, fmtAt + 8);
  chunks.write('data', fmtAt + 24); chunks.writeUInt32LE(4, fmtAt + 28);
  const blob = new Blob([chunks], { type: 'audio/wav' });
  const originalSlice = blob.slice.bind(blob);
  const ranges = [];
  blob.slice = (start, end) => { ranges.push([start, end]); return originalSlice(start, end); };

  await expect(chunked.wavMetadataFor(blob)).resolves.toMatchObject({
    sampleRate: 48000, dataBytes: 4, blockAlign: 2,
  });
  expect(ranges.length).toBeLessThan(8);
  expect(ranges.every(([start]) => start === 0)).toBe(true);
});

test('non-WAV preflight stops after the fixed-size signature read', async () => {
  const blob = new Blob([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00')], { type: 'audio/mpeg' });
  const originalSlice = blob.slice.bind(blob);
  const ranges = [];
  blob.slice = (start, end) => { ranges.push([start, end]); return originalSlice(start, end); };

  await expect(preflight.preflightIngestion(blob)).rejects.toMatchObject({
    code: 'INGESTION_METADATA_REQUIRED',
  });
  expect(ranges).toEqual([[0, 12]]);
});

function mp4Box(type, payload) {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 4, 'ascii');
  payload.copy(out, 8);
  return out;
}

function mp4DurationFile(seconds, version = 0) {
  const payload = Buffer.alloc(version === 1 ? 32 : 20);
  payload.writeUInt8(version, 0);
  const timescaleAt = version === 1 ? 20 : 12;
  const durationAt = version === 1 ? 24 : 16;
  payload.writeUInt32BE(1000, timescaleAt);
  if (version === 1) payload.writeBigUInt64BE(BigInt(seconds * 1000), durationAt);
  else payload.writeUInt32BE(seconds * 1000, durationAt);
  const ftyp = mp4Box('ftyp', Buffer.from('isom\x00\x00\x02\x00isomiso2'));
  const mdat = mp4Box('mdat', Buffer.alloc(32));
  const moov = mp4Box('moov', mp4Box('mvhd', payload));
  const file = new Blob([ftyp, mdat, moov], { type: 'video/mp4' });
  Object.defineProperty(file, 'name', { value: '8372043366_1794517439075 (1).mp4' });
  return file;
}

test.each([0, 1])('MP4 movie duration v%d is read when moov follows mdat', async (version) => {
  const file = mp4DurationFile(37, version);
  await expect(compressed.parseMp4Duration(file)).resolves.toBe(37);
  await expect(preflight.preflightIngestion(file)).resolves.toMatchObject({ duration: 37 });
});

test('a stalled WAV header read times out and stops the scan', async () => {
  jest.useFakeTimers();
  const signature = Buffer.alloc(12);
  signature.write('RIFF', 0); signature.write('WAVE', 8);
  let reads = 0;
  const file = {
    size: 4096,
    name: 'stalled.wav',
    slice: jest.fn(() => ({
      arrayBuffer: () => (++reads === 1
        ? Promise.resolve(signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength))
        : new Promise(() => {})),
    })),
  };
  const pending = preflight.preflightIngestion(file, { timeoutMs: 25 });
  const rejection = expect(pending).rejects.toMatchObject({
    code: 'INGESTION_HEADER_TIMEOUT',
    message: 'Audio header read timed out.',
  });
  await jest.advanceTimersByTimeAsync(25);
  await rejection;
  expect(file.slice).toHaveBeenCalledTimes(2);
  jest.useRealTimers();
});

function wavFile({ seconds = 1, channels = 1, rate = 48000, bits = 16 } = {}) {
  const header = wavHeader({ seconds, channels, rate, bits });
  return Buffer.concat([header, Buffer.alloc(header.readUInt32LE(40))]);
}

test('a RIFF size of 0 still describes the fmt and data chunks Chrome can decode', () => {
  const file = wavFile();
  file.writeUInt32LE(0, 4);
  expect(budget.parseWavMetadata(file, file.length)).toMatchObject({
    duration: 1, channels: 1, sampleRate: 48000, dataBytes: 96000, dataOffset: 44,
  });
});

test('an unfinished data size uses the file length and never the PCM as a 64-bit size', () => {
  const file = wavFile();
  file.writeUInt32LE(0, 40);
  expect(budget.parseWavMetadata(file, file.length)).toMatchObject({ duration: 1, dataBytes: 96000 });
  file.writeUInt32LE(0xffffffff, 40);
  expect(budget.parseWavMetadata(file, file.length)).toMatchObject({ duration: 1, dataBytes: 96000 });
  expect(budget.parseWavMetadata(file)).toBeNull();
});

test('RF64 reads the PCM length from ds64', () => {
  const dataBytes = 96000;
  const b = Buffer.alloc(80);
  b.write('RF64', 0);
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVE', 8);
  b.write('ds64', 12);
  b.writeUInt32LE(28, 16);
  b.writeBigUInt64LE(BigInt(b.length - 8), 20);
  b.writeBigUInt64LE(BigInt(dataBytes), 28);
  b.writeBigUInt64LE(48000n, 36);
  b.writeUInt32LE(0, 44);
  b.write('fmt ', 48);
  b.writeUInt32LE(16, 52);
  b.writeUInt16LE(1, 56);
  b.writeUInt16LE(1, 58);
  b.writeUInt32LE(48000, 60);
  b.writeUInt32LE(96000, 64);
  b.writeUInt16LE(2, 68);
  b.writeUInt16LE(16, 70);
  b.write('data', 72);
  b.writeUInt32LE(0xffffffff, 76);
  expect(budget.parseWavMetadata(b)).toMatchObject({
    duration: 1, dataBytes, dataOffset: 80, sampleRate: 48000,
  });
});

test('a WAV whose RIFF size was left at 0 is planned instead of refused as undecodable', async () => {
  const bytes = wavFile();
  bytes.writeUInt32LE(0, 4);
  const file = new Blob([bytes], { type: 'audio/wav' });
  Object.defineProperty(file, 'name', { value: 'unfinished.wav' });
  const plan = await preflight.preflightIngestion(file);
  expect(plan.duration).toBe(1);
  expect(plan.strategy).toBe('full');
});
test('device tiers have bounded working budgets and soft/hard decisions', () => {
  const high = budget.ingestionBudget({ deviceMemory: 8 }, 'HIGH');
  const balanced = budget.ingestionBudget({ deviceMemory: 4 }, 'BALANCED');
  const constrained = budget.ingestionBudget({ deviceMemory: 2 }, 'CONSTRAINED');
  expect(high.workingBytes).toBeGreaterThan(balanced.workingBytes);
  expect(balanced.workingBytes).toBeGreaterThan(constrained.workingBytes);
  const meta = { duration: 60, channels: 2, sampleRate: 48000, source: 'test' };
  expect(budget.estimateIngestionMemory(meta, 11_520_000, high).decision).toBe('allow');
  expect(budget.estimateIngestionMemory({ ...meta, duration: 300 }, 57_600_000, balanced).decision).toBe('warn');
  expect(budget.estimateIngestionMemory({ ...meta, duration: 3600 }, 691_200_000, constrained).decision).toBe('refuse');
  expect(budget.estimateIngestionMemory(null, 1, constrained)).toMatchObject({ known: false, decision: 'refuse' });
});
test('five-minute stereo workflow fits BALANCED; unknown compressed metadata refuses before decode', async () => {
  const meta = { duration: 300, channels: 2, sampleRate: 48000 };
  const plan = budget.estimateIngestionMemory(meta, 57_600_000, budget.ingestionBudget({ deviceMemory: 4 }, 'BALANCED'));
  expect(plan.decision).not.toBe('refuse');
  const file = new Blob([Buffer.from('not a wav')], { type: 'audio/mpeg' });
  Object.defineProperty(file, 'name', { value: 'unknown.mp3' });
  await expect(preflight.preflightIngestion(file)).rejects.toMatchObject({ code: 'INGESTION_METADATA_REQUIRED' });
});
test('malformed WAV and pre-aborted imports fail without decode', async () => {
  const bad = new Blob([Buffer.from('RIFF0000WAVEbroken')], { type: 'audio/wav' });
  Object.defineProperty(bad, 'name', { value: 'bad.wav' });
  await expect(preflight.preflightIngestion(bad)).rejects.toThrow(/Could not decode/);
  const controller = new AbortController(); controller.abort();
  await expect(preflight.preflightIngestion(bad, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
});
test('the reported 7922 MiB file is a full-file plan, and a chunk still fits BALANCED', () => {
  const balanced = budget.ingestionBudget({ deviceMemory: 4 }, 'BALANCED');
  expect(balanced.workingBytes).toBe(768 * 1024 * 1024);
  const meta = { duration: 3605, channels: 2, sampleRate: 48000, source: 'media-metadata' };
  const plan = budget.resolveIngestionPlan(meta, 546816, balanced, { profile: 'BALANCED', modelId: 'bsrnn_vocals' });
  expect(plan.decision).toBe('refuse');
  expect(plan.strategy).toBe('chunked');
  expect(Math.ceil(plan.estimatedBytes / (1024 * 1024))).toBe(7922);
  expect(plan.measurements.processingPeakBytes).toBe(plan.estimatedBytes);
  expect(plan.chunk.peakBytes).toBeLessThanOrEqual(balanced.workingBytes);
  expect(plan.chunk.coreFrames).toBe(Math.floor((20 * 48000) / 1024) * 1024);
  expect(plan.chunk.firstCoreFrames).toBe(Math.floor((8 * 48000) / 1024) * 1024);
  expect(plan.chunk.firstCoreFrames).toBeLessThan(plan.chunk.coreFrames);
  const text = budget.formatIngestionPlan(plan, 'this.m4a');
  expect(text).toMatch(/8s first window, then 20s/);
  expect(text).toMatch(/AUDIO OPTIMIZATION/);
  expect(text).toMatch(/Chunked processing/);
  expect(text).not.toMatch(/WebGPU/);
  expect(text).toMatch(/not downsampled or truncated/);
});

test('memory profiles change chunk length inside the same device budget', () => {
  const balanced = budget.ingestionBudget({}, 'BALANCED');
  const meta = { duration: 3605, channels: 2, sampleRate: 48000, source: 'media-metadata' };
  const low = budget.resolveIngestionPlan(meta, 546816, balanced, { profile: 'LOW' });
  const high = budget.resolveIngestionPlan(meta, 546816, balanced, { profile: 'HIGH' });
  expect(low.strategy).toBe('chunked');
  expect(high.strategy).toBe('chunked');
  expect(low.chunk.coreFrames).toBeLessThan(high.chunk.coreFrames);
  expect(low.chunk.peakBytes).toBeLessThanOrEqual(balanced.workingBytes);
  // LOW is already 8 s throughout, so the first window is not shorter than the rest.
  expect(low.chunk.firstCoreFrames).toBe(low.chunk.coreFrames);
  expect(high.chunk.firstCoreFrames).toBe(Math.floor((8 * 48000) / 1024) * 1024);
  expect(high.chunk.firstCoreFrames).toBeLessThan(high.chunk.coreFrames);
});

test('a recurrent model is not described as chunked when the full file does not fit', () => {
  const balanced = budget.ingestionBudget({}, 'BALANCED');
  const meta = { duration: 3605, channels: 2, sampleRate: 48000, source: 'media-metadata' };
  const contract = budget.chainChunkContract(['deepfilternet3']);
  expect(contract.chunkable).toBe(false);
  const plan = budget.resolveIngestionPlan(meta, 546816, balanced, { contract, profile: 'AUTO' });
  expect(plan.strategy).toBe('refuse');
  expect(budget.formatIngestionPlan(plan, 'this.m4a')).toMatch(/not split into windows/);
});

function pcm16(samples) {
  const out = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2));
  return out;
}

test('an unfinished data chunk stops before a trailing LIST instead of playing it', () => {
  const tone = Array.from({ length: 64 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / 48000) * 0.1);
  const list = Buffer.concat([
    Buffer.from('INFO'),
    Buffer.from('ISFT'), Buffer.from([4, 0, 0, 0]), Buffer.from('DAW!'),
  ]);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(48000, 4);
  fmt.writeUInt32LE(96000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
  const body = Buffer.concat([
    Buffer.from('fmt '), Buffer.from([16, 0, 0, 0]), fmt,
    Buffer.from('data'), Buffer.from([0, 0, 0, 0]), pcm16(tone),
    Buffer.from('LIST'), Buffer.alloc(4), list,
  ]);
  body.writeUInt32LE(list.length, body.length - list.length - 4);
  const file = Buffer.concat([
    Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), body,
  ]);
  file.writeUInt32LE(file.length - 8, 4);
  const meta = budget.parseWavMetadata(file, file.length);
  const beforeFrames = Math.floor((file.length - meta.dataOffset) / meta.blockAlign);
  const view = new DataView(file.buffer, file.byteOffset + meta.dataOffset, meta.dataBytes);
  const pcm = chunked.decodeInterleavedPcm(view, meta.dataBytes / meta.blockAlign, meta);
  let tailPeak = 0;
  for (let i = tone.length; i < pcm[0].length; i++) tailPeak = Math.max(tailPeak, Math.abs(pcm[0][i]));
  // Before this fix the parser consumed the LIST (72 frames, tail peak 0.66).
  expect(meta.dataBytes).toBe(tone.length * 2);
  expect(pcm[0].length).toBe(tone.length);
  expect(tailPeak).toBe(0);
  expect(beforeFrames).toBeGreaterThan(tone.length);
});

test('block align is the fmt field, and 24-bit samples in a 32-bit container stay left-justified', () => {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(48000, 4);
  fmt.writeUInt32LE(192000, 8); fmt.writeUInt16LE(4, 12); fmt.writeUInt16LE(24, 14);
  const payload = Buffer.from([0x00, 0x00, 0x00, 0x40]);
  const body = Buffer.concat([
    Buffer.from('fmt '), Buffer.from([16, 0, 0, 0]), fmt,
    Buffer.from('data'), Buffer.from([4, 0, 0, 0]), payload,
  ]);
  const file = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), body]);
  file.writeUInt32LE(file.length - 8, 4);
  const meta = budget.parseWavMetadata(file, file.length);
  expect(meta.blockAlign).toBe(4);
  expect(meta.bitDepth).toBe(24);
  const view = new DataView(file.buffer, file.byteOffset + meta.dataOffset, meta.dataBytes);
  const pcm = chunked.decodeInterleavedPcm(view, 1, meta);
  expect(pcm[0][0]).toBeCloseTo(0.5, 5);
});

test('WAVE_FORMAT_EXTENSIBLE PCM 24-in-32 decodes, and a non-PCM subtype is refused', () => {
  const guid = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);
  const fmt = Buffer.alloc(40);
  fmt.writeUInt16LE(0xfffe, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(48000, 4);
  fmt.writeUInt32LE(192000, 8); fmt.writeUInt16LE(4, 12); fmt.writeUInt16LE(32, 14);
  fmt.writeUInt16LE(22, 16); fmt.writeUInt16LE(24, 18);
  guid.copy(fmt, 24);
  const payload = Buffer.from([0x00, 0x00, 0x00, 0x40]);
  const body = Buffer.concat([
    Buffer.from('fmt '), Buffer.from([40, 0, 0, 0]), fmt,
    Buffer.from('data'), Buffer.from([4, 0, 0, 0]), payload,
  ]);
  const file = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), body]);
  file.writeUInt32LE(file.length - 8, 4);
  const meta = budget.parseWavMetadata(file, file.length);
  expect(meta.format).toBe(1);
  expect(meta.extensible).toBe(true);
  expect(meta.blockAlign).toBe(4);
  expect(meta.bitDepth).toBe(24);
  const view = new DataView(file.buffer, file.byteOffset + meta.dataOffset, meta.dataBytes);
  const pcm = chunked.decodeInterleavedPcm(view, 1, meta);
  expect(pcm[0][0]).toBeCloseTo(0.5, 5);
  const badFmt = Buffer.from(fmt);
  badFmt.fill(0, 24, 40);
  const badBody = Buffer.concat([
    Buffer.from('fmt '), Buffer.from([40, 0, 0, 0]), badFmt,
    Buffer.from('data'), Buffer.from([4, 0, 0, 0]), payload,
  ]);
  const bad = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), badBody]);
  bad.writeUInt32LE(bad.length - 8, 4);
  expect(budget.parseWavMetadata(bad, bad.length)).toBeNull();
});

test('a fmt chunk past the first 1 MiB is still a WAV plan', async () => {
  const junk = Buffer.alloc(1024 * 1024 + 64);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(48000, 4);
  fmt.writeUInt32LE(96000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
  const body = Buffer.concat([
    Buffer.from('JUNK'), Buffer.alloc(4), junk,
    Buffer.from('fmt '), Buffer.from([16, 0, 0, 0]), fmt,
    Buffer.from('data'), Buffer.from([4, 0, 0, 0]), Buffer.from([0, 0, 0, 0]),
  ]);
  body.writeUInt32LE(junk.length, 4);
  const fileBytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), body]);
  fileBytes.writeUInt32LE(fileBytes.length - 8, 4);
  const file = new Blob([fileBytes], { type: 'audio/wav' });
  Object.defineProperty(file, 'name', { value: 'long-header.wav' });
  const viaWindow = await chunked.wavMetadataFor(file);
  expect(viaWindow).toMatchObject({ sampleRate: 48000, dataBytes: 4, blockAlign: 2 });
  const plan = await preflight.preflightIngestion(file);
  expect(plan.strategy).not.toBe('refuse');
  expect(plan.sampleRate).toBe(48000);
});

test('post-decode check catches a container that understated channels', () => {
  const estimate = { budgetBytes: 256 * 1024 * 1024, tier: 'CONSTRAINED' };
  expect(() => preflight.assertDecodedIngestionBudget({ duration: 300, numberOfChannels: 6, sampleRate: 48000 }, 1, estimate))
    .toThrow(/budget/);
});

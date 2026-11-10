'use strict';
let budget, preflight;
beforeAll(async () => {
  budget = await import('../src/core/IngestionBudget.js');
  preflight = await import('../src/pipeline/IngestionPreflight.js');
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
  const text = budget.formatIngestionPlan(plan, 'this.m4a');
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

test('post-decode check catches a container that understated channels', () => {
  const estimate = { budgetBytes: 256 * 1024 * 1024, tier: 'CONSTRAINED' };
  expect(() => preflight.assertDecodedIngestionBudget({ duration: 300, numberOfChannels: 6, sampleRate: 48000 }, 1, estimate))
    .toThrow(/budget/);
});

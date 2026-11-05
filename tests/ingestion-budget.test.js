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

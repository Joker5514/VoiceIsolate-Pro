'use strict';

let chunked;
let budget;
let compressed;

beforeAll(async () => {
  chunked = await import('../src/pipeline/ChunkedExtraction.js');
  budget = await import('../src/core/IngestionBudget.js');
  compressed = await import('../src/pipeline/CompressedAudioReader.js');
});

function tone(start, count, channels = 1) {
  return Array.from({ length: channels }, (_, c) => {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = Math.sin((start + i + c * 17) * 0.01) * 0.5;
    return out;
  });
}

function planFor(total, { channels = 1, core = 4096, context = 1024, fade = 1024 } = {}) {
  return {
    chunk: {
      viable: true,
      coreFrames: core,
      contextFrames: context,
      fadeFrames: fade,
      strideFrames: core - fade,
      modelId: 'bsrnn_vocals',
      peakBytes: 1024,
    },
    totalFrames: total,
    outputChannels: channels,
    canonicalBytes: total * channels * 4,
    budgetBytes: 64 * 1024 * 1024,
    duration: total / 48000,
    sampleRate: 48000,
  };
}

test('identity windows reconstruct the source with the original duration', async () => {
  const total = 10000;
  const channels = 1;
  const plan = planFor(total, { channels });
  const result = await chunked.runChunkedExtraction(null, plan, {
    sink: 'memory',
    readWindow: (start, count) => tone(start, count, channels),
    processWindow: async (input) => input.map((ch) => new Float32Array(ch)),
  });
  expect(result.frames).toBe(total);
  expect(result.duration).toBeCloseTo(total / 48000, 6);
  expect(result.segments.every((s) => s.state === 'done')).toBe(true);
  const expected = tone(0, total, channels)[0];
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(result.clean[0][i] - expected[i]));
  expect(peak).toBe(0);
});

test('a constant gain survives the overlap crossfade', async () => {
  const total = 9000;
  const plan = planFor(total);
  const result = await chunked.runChunkedExtraction(null, plan, {
    sink: 'memory',
    readWindow: (start, count) => tone(start, count),
    processWindow: async (input) => input.map((ch) => {
      const out = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) out[i] = ch[i] * 0.5;
      return out;
    }),
  });
  const expected = tone(0, total)[0];
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(result.clean[0][i] - expected[i] * 0.5));
  expect(peak).toBeLessThan(1e-6);
  const boundary = plan.chunk.coreFrames - plan.chunk.fadeFrames;
  const jump = Math.abs(result.clean[0][boundary] - result.clean[0][boundary - 1]);
  const srcJump = Math.abs(expected[boundary] * 0.5 - expected[boundary - 1] * 0.5);
  expect(jump).toBeLessThanOrEqual(srcJump + 1e-5);
});

test('a failed window is not a complete recording', async () => {
  const plan = planFor(8000);
  await expect(chunked.runChunkedExtraction(null, plan, {
    sink: 'memory',
    readWindow: (start, count) => tone(start, count),
    processWindow: async () => [new Float32Array(4)],
  })).rejects.toMatchObject({ code: 'CHUNK_FAILED', segment: { state: 'failed' } });
});

test('cancellation discards the partial result', async () => {
  const controller = new AbortController();
  controller.abort();
  const plan = planFor(8000);
  await expect(chunked.runChunkedExtraction(null, plan, {
    sink: 'memory',
    signal: controller.signal,
    readWindow: (start, count) => tone(start, count),
    processWindow: async (input) => input,
  })).rejects.toMatchObject({ name: 'AbortError' });
});

test('a 16-bit WAV window round-trips within one quantization step', async () => {
  const frames = 64;
  const channels = 2;
  const pcm = Buffer.alloc(frames * channels * 2);
  const view = new DataView(pcm.buffer);
  const samples = [];
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const q = ((i * 3 + c * 1000) % 20001) - 10000;
      samples.push(q);
      view.setInt16((i * channels + c) * 2, q, true);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(48000 * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  const file = new Blob([header, pcm], { type: 'audio/wav' });
  Object.defineProperty(file, 'name', { value: 'window.wav' });
  const meta = budget.parseWavMetadata(header);
  expect(meta.dataOffset).toBe(44);
  const plan = { wav: meta, outputChannels: channels };
  const got = await chunked.readCanonicalWindow(file, plan, 0, frames);
  expect(got).toHaveLength(2);
  expect(got[0]).toHaveLength(frames);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const q = samples[i * channels + c];
      expect(Math.abs(got[c][i] - q / 32768)).toBeLessThanOrEqual(1 / 32768);
    }
  }
});

function box(type, payload) {
  const size = 8 + payload.length;
  const out = Buffer.alloc(size);
  out.writeUInt32BE(size, 0);
  out.write(type, 4, 4, 'ascii');
  payload.copy(out, 8);
  return out;
}

test('an MP4 audio sample table is read without loading a media payload', async () => {
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(48000, 12);
  const stsdEntryHead = Buffer.alloc(36);
  stsdEntryHead.writeUInt32BE(36, 0);
  stsdEntryHead.write('mp4a', 4, 4, 'ascii');
  stsdEntryHead.writeUInt16BE(2, 24);
  stsdEntryHead.writeUInt32BE(48000 * 65536, 32);
  const stsd = Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
    stsdEntryHead,
  ]);
  const stts = Buffer.alloc(16);
  stts.writeUInt32BE(1, 4);
  stts.writeUInt32BE(2, 8);
  stts.writeUInt32BE(1024, 12);
  const stsc = Buffer.alloc(20);
  stsc.writeUInt32BE(1, 4);
  stsc.writeUInt32BE(1, 8);
  stsc.writeUInt32BE(2, 12);
  stsc.writeUInt32BE(1, 16);
  const stsz = Buffer.alloc(20);
  stsz.writeUInt32BE(16, 4);
  stsz.writeUInt32BE(2, 8);
  const stco = Buffer.alloc(16);
  stco.writeUInt32BE(1, 4);
  stco.writeUInt32BE(4096, 8);
  const stbl = box('stbl', Buffer.concat([
    box('stsd', stsd), box('stts', stts), box('stsc', stsc), box('stsz', stsz), box('stco', stco),
  ]));
  const minf = box('minf', stbl);
  const mdia = box('mdia', Buffer.concat([box('mdhd', mdhd), minf]));
  const moov = box('moov', box('trak', mdia));
  const file = new Blob([moov], { type: 'audio/mp4' });
  Object.defineProperty(file, 'name', { value: 'clip.m4a' });
  const info = await compressed.parseMp4Audio(file);
  expect(info.sampleRate).toBe(48000);
  expect(info.channels).toBe(2);
  expect(info.samples).toHaveLength(2);
  expect(info.samples[0]).toMatchObject({ offset: 4096, size: 16, duration: 1024 });
  expect(info.samples[1].offset).toBe(4112);
});

function siSdr(ref, est) {
  let dot = 0;
  let energy = 0;
  for (let i = 0; i < ref.length; i++) {
    dot += ref[i] * est[i];
    energy += ref[i] * ref[i];
  }
  if (energy === 0) return Infinity;
  const scale = dot / energy;
  let noise = 0;
  let signal = 0;
  for (let i = 0; i < ref.length; i++) {
    const s = scale * ref[i];
    const e = est[i] - s;
    signal += s * s;
    noise += e * e;
  }
  if (noise === 0) return Infinity;
  return 10 * Math.log10(signal / noise);
}

test('file-sink float32 spill matches the memory sink above 90 dB SI-SDR', async () => {
  const total = 20000;
  const channels = 2;
  const plan = planFor(total, { channels, core: 4096, context: 512, fade: 512 });
  const options = {
    readWindow: (start, count) => tone(start, count, channels),
    processWindow: async (input) => input.map((ch) => {
      const out = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) out[i] = ch[i] * 0.8;
      return out;
    }),
  };
  const memory = await chunked.runChunkedExtraction(null, plan, { ...options, sink: 'memory' });
  const file = await chunked.runChunkedExtraction(null, plan, { ...options, sink: 'file' });
  const bytes = Buffer.from(await file.file.arrayBuffer());
  const meta = budget.parseWavMetadata(bytes);
  expect(meta.format).toBe(3);
  expect(meta.bitDepth).toBe(32);
  const data = bytes.subarray(meta.dataOffset, meta.dataOffset + meta.dataBytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoded = chunked.decodeInterleavedPcm(view, file.frames, meta);
  const scores = [];
  const errors = [];
  for (let c = 0; c < channels; c++) {
    const ref = memory.clean[c];
    const est = decoded[c];
    let energy = 0;
    let peakErr = 0;
    for (let i = 0; i < ref.length; i++) {
      energy += ref[i] * ref[i];
      peakErr = Math.max(peakErr, Math.abs(ref[i] - est[i]));
    }
    const score = siSdr(ref, est);
    scores.push(score);
    errors.push(peakErr);
    expect(energy).toBeGreaterThan(0);
    expect(peakErr).toBe(0);
    expect(score).toBeGreaterThan(90);
  }
  console.log(`WAV_ENCODER_MEASUREMENTS ${JSON.stringify({
    chunkedFileVsMemorySiSdrDb: scores.map((score) => (score === Infinity ? 'Infinity' : score)),
    chunkedPeakAbsError: errors,
  })}`);
});

test('MPEG-1 Layer III frame length is stable across two frames', async () => {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  const file = new Blob([frame, frame], { type: 'audio/mpeg' });
  Object.defineProperty(file, 'name', { value: 'clip.mp3' });
  const info = await compressed.parseMp3Frames(file);
  expect(info.sampleRate).toBe(44100);
  expect(info.samples).toHaveLength(2);
  expect(info.samples[0].size).toBe(417);
  expect(info.samples[1].offset).toBe(417);
});

function maxAbs(a, b) {
  const n = Math.min(a.length, b.length);
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  if (a.length !== b.length) return Infinity;
  return m;
}

/** Second-difference spikes that the source does not explain, same idea as the audit harness. */
function newClicks(out, src, sr = 48000) {
  const d2 = (x) => {
    const d = new Float64Array(Math.max(0, x.length - 2));
    for (let i = 0; i < d.length; i++) d[i] = Math.abs(x[i] - 2 * x[i + 1] + x[i + 2]);
    return d;
  };
  const dout = d2(out);
  const dsrc = d2(src);
  const hits = [];
  const thresh = 10 ** (-70 / 20);
  for (let i = 0; i < dout.length; i++) {
    if (dout[i] <= 14 * 1e-7 && dout[i] <= thresh) continue;
    const a = Math.max(0, i - 49);
    const b = Math.min(dsrc.length, i + 48);
    let srcMax = 0;
    for (let j = a; j < b; j++) if (dsrc[j] > srcMax) srcMax = dsrc[j];
    // A click is a 2nd-difference peak much larger than the source nearby.
    // Scale is loose for unit tones; the comparison vs current chunking uses the same rule.
    if (dout[i] > 14 * Math.max(srcMax, 1e-7) && dout[i] > 2 * Math.max(srcMax, 1e-6)) {
      if (!hits.length || (i + 1) - hits[hits.length - 1] > 96) hits.push(i + 1);
    }
  }
  return hits;
}

test('an 8 s first core then 20 s cores reconstructs a time-invariant process with max abs 0 vs uniform 20 s chunking', async () => {
  const hop = 1024;
  const first = Math.floor((8 * 48000) / hop) * hop;
  const core = Math.floor((20 * 48000) / hop) * hop;
  const total = first + core + hop * 4; // first window, one full steady window, a short tail
  const uniform = planFor(total, { core, fade: hop, context: hop });
  const shorter = planFor(total, { core, fade: hop, context: hop });
  shorter.chunk.firstCoreFrames = first;
  const options = {
    sink: 'memory',
    readWindow: (start, count) => tone(start, count),
    processWindow: async (input) => input.map((ch) => {
      const out = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) out[i] = ch[i] * 0.5;
      return out;
    }),
  };
  const a = await chunked.runChunkedExtraction(null, uniform, options);
  const b = await chunked.runChunkedExtraction(null, shorter, options);
  expect(a.frames).toBe(total);
  expect(b.frames).toBe(total);
  expect(b.segments[0].frames).toBe(first);
  expect(b.segments[1].frames).toBe(core);
  expect(maxAbs(a.clean[0], b.clean[0])).toBe(0);
  const src = tone(0, total)[0];
  const scaled = new Float32Array(total);
  for (let i = 0; i < total; i++) scaled[i] = src[i] * 0.5;
  expect(maxAbs(b.clean[0], scaled)).toBeLessThan(1e-6);
  const join = first - hop;
  const jump = Math.abs(b.clean[0][join] - b.clean[0][join - 1]);
  const srcJump = Math.abs(scaled[join] - scaled[join - 1]);
  expect(jump).toBeLessThanOrEqual(srcJump + 1e-5);
  expect(newClicks(b.clean[0], scaled)).toEqual([]);
});

test('the first-core join has no extra discontinuity on a linear process', async () => {
  const hop = 1024;
  const first = hop * 4;
  const core = hop * 8;
  const total = first + core + hop * 2;
  const plan = planFor(total, { core, fade: hop, context: hop });
  plan.chunk.firstCoreFrames = first;
  const result = await chunked.runChunkedExtraction(null, plan, {
    sink: 'memory',
    readWindow: (start, count) => tone(start, count),
    processWindow: async (input) => input.map((ch) => new Float32Array(ch)),
  });
  const expected = tone(0, total)[0];
  expect(maxAbs(result.clean[0], expected)).toBe(0);
  expect(result.segments[0].frames).toBe(first);
  const join = first - hop;
  const jump = Math.abs(result.clean[0][join] - result.clean[0][join - 1]);
  const srcJump = Math.abs(expected[join] - expected[join - 1]);
  expect(jump).toBeLessThanOrEqual(srcJump + 1e-7);
  expect(newClicks(result.clean[0], expected)).toEqual([]);
});

'use strict';
/**
 * Fragmented MP4 (moov + moof/mdat) and video-only MP4 ingestion.
 *
 * Live report (Stems page, Android, 207 MB .mp4): the log stopped after
 * `ingest.start`. Repro: a fragmented MP4 of that size on a BALANCED device
 * is planned as chunked, but the reader only knew `stbl` sample tables, so
 * the container gave no measured channels/frames and chunked import refused
 * the file. A video-only MP4 on a HIGH device fell through to a realtime
 * media-element capture that ran for the full video length.
 *
 * Oracle: ffprobe's independent demux of the same files
 * (tests/fixtures/mp4/*.audio-packets.json, see the README there).
 */
const fs = require('fs');
const path = require('path');

let compressed;
let preflight;
beforeAll(async () => {
  compressed = await import('../src/pipeline/CompressedAudioReader.js');
  preflight = await import('../src/pipeline/IngestionPreflight.js');
});

const FIX = path.join(__dirname, 'fixtures', 'mp4');
function fixture(name, type = 'video/mp4') {
  const file = new Blob([fs.readFileSync(path.join(FIX, name))], { type });
  Object.defineProperty(file, 'name', { value: name });
  return file;
}
function packets(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, `${name}.audio-packets.json`), 'utf8'));
}

describe.each(['frag-moof-base', 'frag-data-offset'])('fragmented MP4 %s', (name) => {
  test('the audio sample table is rebuilt from moof/traf/trun and matches ffprobe byte for byte', async () => {
    const info = await compressed.parseMp4Audio(fixture(`${name}.mp4`));
    const truth = packets(name);
    expect(info).not.toBeNull();
    expect(info.sampleRate).toBe(48000);
    expect(info.channels).toBe(2);
    expect(info.timescale).toBe(48000);
    expect(info.samples).toHaveLength(truth.length);
    info.samples.forEach((s, i) => {
      const [pos, size, , duration] = truth[i];
      expect([s.offset, s.size]).toEqual([pos, size]);
      // ffprobe reports a nominal 1024 for the final packet; the trun stores
      // the real (shorter) tail, exactly as the progressive file's stts does.
      if (i < truth.length - 1) expect(s.duration).toBe(duration);
      if (i > 0) expect(s.time).toBe(info.samples[i - 1].time + info.samples[i - 1].duration);
    });
  });

  test('layout has measured channels and PCM frames, so a chunked plan can run', async () => {
    const layout = await compressed.readCompressedLayout(fixture(`${name}.mp4`), { kind: 'mp4' });
    expect(layout).toMatchObject({ channels: 2, sampleRate: 48000, source: 'mp4-sample-table', complete: true });
    const info = layout.bitstream;
    const total = info.samples.reduce((n, s) => n + s.duration, 0);
    expect(layout.frames).toBe(total - (info.primingFrames || 0));
    // The remux kept every packet: within one AAC frame (the progressive
    // file's edit list trims 1024 priming frames; empty_moov drops that list).
    const progressive = await compressed.readCompressedLayout(fixture('progressive.mp4'), { kind: 'mp4' });
    expect(progressive.frames).toBe(144000);
    expect(Math.abs(layout.frames - progressive.frames)).toBeLessThanOrEqual(1024);
  });

  test('preflight plans the file from the container (PCM authority), not a duration guess', async () => {
    const plan = await preflight.preflightIngestion(fixture(`${name}.mp4`));
    expect(plan.metadataSource).toBe('mp4-sample-table');
    expect(plan.frameAuthority).toBe('pcm');
    expect(plan.channels).toBe(2);
    expect(plan.sourceFrames).toBeGreaterThan(140000);
    expect(plan.bitstream.samples.length).toBe(packets(name).length);
  });
});

test('progressive MP4 sample table still matches ffprobe (unchanged path)', async () => {
  const info = await compressed.parseMp4Audio(fixture('progressive.mp4'));
  const truth = packets('progressive');
  expect(info.samples.map((s) => [s.offset, s.size])).toEqual(truth.map((p) => [p[0], p[1]]));
});

test('a progressive MP4 reads no box past its moov (normal files pay nothing extra)', async () => {
  const file = fixture('progressive.mp4');
  const originalSlice = file.slice.bind(file);
  const ranges = [];
  file.slice = (start, end) => { ranges.push([start, end]); return originalSlice(start, end); };
  await compressed.parseMp4Audio(file);
  // ftyp header, free/mdat headers, moov header, moov body; never a moof walk.
  expect(ranges.length).toBeLessThanOrEqual(6);
});

test('a video-only MP4 is refused at preflight with NO_AUDIO_TRACK instead of a realtime capture', async () => {
  const file = fixture('video-only.mp4');
  await expect(compressed.readCompressedLayout(file, { kind: 'mp4' })).rejects.toMatchObject({ code: 'NO_AUDIO_TRACK' });
  const t0 = Date.now();
  await expect(preflight.preflightIngestion(file)).rejects.toMatchObject({ code: 'NO_AUDIO_TRACK' });
  expect(Date.now() - t0).toBeLessThan(2000);
});

test('an MP4 with an audio track in a codec this reader does not demux is not called video-only', async () => {
  // Rewrite the mp4a sample entry fourcc to an unknown audio codec: the trak
  // is still a sound track (hdlr soun), so the reader must return null and
  // leave the file to the browser decoder rather than refuse it.
  const bytes = Buffer.from(fs.readFileSync(path.join(FIX, 'progressive.mp4')));
  const at = bytes.indexOf(Buffer.from('mp4a'));
  expect(at).toBeGreaterThan(0);
  bytes.write('zzzz', at, 4, 'ascii');
  const file = new Blob([bytes], { type: 'video/mp4' });
  Object.defineProperty(file, 'name', { value: 'odd-codec.mp4' });
  await expect(compressed.parseMp4Audio(file)).resolves.toBeNull();
});

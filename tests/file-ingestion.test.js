'use strict';

let inferMediaKind;
let isIngestibleMedia;
let assertIngestible;

beforeAll(async () => {
  const mediaTypes = await import('../src/core/media-types.js');
  const fileIngestion = await import('../src/pipeline/FileIngestion.js');
  inferMediaKind = mediaTypes.inferMediaKind;
  isIngestibleMedia = mediaTypes.isIngestibleMedia;
  assertIngestible = fileIngestion.assertIngestible;
});

describe('media-types', () => {
  test('accepts audio MIME types', () => {
    expect(inferMediaKind({ type: 'audio/wav', name: 'clip.wav' })).toBe('audio');
    expect(isIngestibleMedia({ type: 'audio/mpeg', name: 'track.mp3' })).toBe(true);
  });

  test('accepts video MIME types', () => {
    expect(inferMediaKind({ type: 'video/mp4', name: 'clip.mp4' })).toBe('video');
  });

  test('treats .m4a as audio even when MIME is video/mp4', () => {
    expect(inferMediaKind({ type: 'video/mp4', name: 'Voice 260625_203313.m4a' })).toBe('audio');
    expect(inferMediaKind({ type: 'audio/mp4', name: 'memo.m4a' })).toBe('audio');
  });

  test('infers audio from extension when MIME is empty', () => {
    expect(inferMediaKind({ type: '', name: 'voice.flac' })).toBe('audio');
    expect(inferMediaKind({ type: '', name: 'track.ogg' })).toBe('audio');
  });

  test('infers audio from extension when MIME is application/octet-stream', () => {
    expect(inferMediaKind({ type: 'application/octet-stream', name: 'recording.wav' })).toBe('audio');
    expect(isIngestibleMedia({ type: 'application/octet-stream', name: 'podcast.mp3' })).toBe(true);
  });

  test('rejects MIDI by MIME and extension', () => {
    expect(inferMediaKind({ type: 'audio/midi', name: 'song.mid' })).toBe('midi');
    expect(inferMediaKind({ type: '', name: 'track.midi' })).toBe('midi');
  });

  test('returns null for unknown binary files', () => {
    expect(inferMediaKind({ type: 'application/octet-stream', name: 'data.bin' })).toBe(null);
  });
});

function makeFile(name, type, bytes = 16) {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('FileIngestion.assertIngestible', () => {
  test('allows octet-stream WAV files (common on Windows)', () => {
    expect(() => assertIngestible(makeFile('voice.wav', 'application/octet-stream'))).not.toThrow();
  });

  test('rejects unknown octet-stream without media extension', () => {
    expect(() => assertIngestible(makeFile('archive.bin', 'application/octet-stream')))
      .toThrow(/Unsupported type/);
  });

  test('rejects MIDI with a clear message', () => {
    expect(() => assertIngestible(makeFile('song.mid', 'audio/midi'))).toThrow(/MIDI/);
  });
});
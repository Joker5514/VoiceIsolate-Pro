'use strict';

let inferMediaKind;
let isIngestibleMedia;
let assertIngestible;

let isVideoSource;

beforeAll(async () => {
  const mediaTypes = await import('../src/core/media-types.js');
  const fileIngestion = await import('../src/pipeline/FileIngestion.js');
  inferMediaKind = mediaTypes.inferMediaKind;
  isIngestibleMedia = mediaTypes.isIngestibleMedia;
  isVideoSource = mediaTypes.isVideoSource;
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

  test('isVideoSource detects video containers for remux/preview', () => {
    expect(isVideoSource({ type: 'video/mp4', name: 'clip.mp4' })).toBe(true);
    expect(isVideoSource({ type: '', name: 'clip.mov' })).toBe(true);
    expect(isVideoSource({ type: 'video/webm', name: 'clip.webm' })).toBe(true);
    expect(isVideoSource({ type: 'audio/webm', name: 'note.webm' })).toBe(false);
    expect(isVideoSource({ type: 'video/mp4', name: 'memo.m4a' })).toBe(false);
    expect(isVideoSource({ type: 'audio/wav', name: 'a.wav' })).toBe(false);
  });
});

function makeFile(name, type, bytes = 16) {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('FileIngestion.assertIngestible', () => {
  test('allows octet-stream WAV files (common on Windows)', () => {
    expect(() => assertIngestible(makeFile('voice.wav', 'application/octet-stream'))).not.toThrow();
  });

  test('allows generic octet-stream without extension (decoder is final judge)', () => {
    // Windows often tags downloads as application/octet-stream; sniff/decode later.
    expect(() => assertIngestible(makeFile('archive.bin', 'application/octet-stream'))).not.toThrow();
  });

  test('rejects explicit non-media MIME types', () => {
    expect(() => assertIngestible(makeFile('doc.pdf', 'application/pdf')))
      .toThrow(/Unsupported type/);
  });

  test('rejects MIDI with a clear message', () => {
    expect(() => assertIngestible(makeFile('song.mid', 'audio/midi'))).toThrow(/MIDI/);
  });
});
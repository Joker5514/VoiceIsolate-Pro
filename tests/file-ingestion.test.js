'use strict';

let inferMediaKind;
let isIngestibleMedia;
let isImageMimeType;
let isImageFile;
let assertIngestible;

let isVideoSource;

beforeAll(async () => {
  const mediaTypes = await import('../src/core/media-types.js');
  const fileIngestion = await import('../src/pipeline/FileIngestion.js');
  inferMediaKind = mediaTypes.inferMediaKind;
  isIngestibleMedia = mediaTypes.isIngestibleMedia;
  isImageMimeType = mediaTypes.isImageMimeType;
  isImageFile = mediaTypes.isImageFile;
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

  describe('image detection', () => {
    test('isImageMimeType identifies image/ MIME types', () => {
      expect(isImageMimeType('image/jpeg')).toBe(true);
      expect(isImageMimeType('image/png')).toBe(true);
      expect(isImageMimeType('image/gif')).toBe(true);
      expect(isImageMimeType('image/webp')).toBe(true);
      expect(isImageMimeType('image/avif')).toBe(true);
      expect(isImageMimeType('audio/mpeg')).toBe(false);
      expect(isImageMimeType('video/mp4')).toBe(false);
      expect(isImageMimeType('')).toBe(false);
      expect(isImageMimeType(null)).toBe(false);
    });

    test('isImageFile detects images by MIME type', () => {
      expect(isImageFile({ type: 'image/jpeg', name: 'photo.jpg' })).toBe(true);
      expect(isImageFile({ type: 'image/png', name: 'icon.png' })).toBe(true);
      expect(isImageFile({ type: 'audio/mpeg', name: 'track.mp3' })).toBe(false);
    });

    test('isImageFile detects images by extension when MIME is empty', () => {
      expect(isImageFile({ type: '', name: 'photo.jpg' })).toBe(true);
      expect(isImageFile({ type: '', name: 'screenshot.png' })).toBe(true);
      expect(isImageFile({ type: '', name: 'icon.gif' })).toBe(true);
      expect(isImageFile({ type: '', name: 'art.webp' })).toBe(true);
      expect(isImageFile({ type: '', name: 'recording.wav' })).toBe(false);
    });

    test('inferMediaKind returns "image" for image MIME types', () => {
      expect(inferMediaKind({ type: 'image/jpeg', name: 'photo.jpg' })).toBe('image');
      expect(inferMediaKind({ type: 'image/png', name: 'icon.png' })).toBe('image');
      expect(inferMediaKind({ type: 'image/gif', name: 'anim.gif' })).toBe('image');
      expect(inferMediaKind({ type: 'image/webp', name: 'banner.webp' })).toBe('image');
    });

    test('inferMediaKind returns "image" for image extensions even with empty MIME', () => {
      expect(inferMediaKind({ type: '', name: 'cover.jpg' })).toBe('image');
      expect(inferMediaKind({ type: '', name: 'screenshot.png' })).toBe('image');
      expect(inferMediaKind({ type: '', name: 'thumb.jpeg' })).toBe('image');
    });

    test('isIngestibleMedia returns false for images', () => {
      expect(isIngestibleMedia({ type: 'image/jpeg', name: 'photo.jpg' })).toBe(false);
      expect(isIngestibleMedia({ type: '', name: 'cover.jpg' })).toBe(false);
    });
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

  describe('image rejection', () => {
    test('rejects image/jpeg with UNSUPPORTED_MEDIA_TYPE', () => {
      expect(() => assertIngestible(makeFile('photo.jpg', 'image/jpeg')))
        .toThrow(/UNSUPPORTED_MEDIA_TYPE/);
    });

    test('rejects image/png with UNSUPPORTED_MEDIA_TYPE', () => {
      expect(() => assertIngestible(makeFile('icon.png', 'image/png')))
        .toThrow(/UNSUPPORTED_MEDIA_TYPE/);
    });

    test('rejects image/gif with UNSUPPORTED_MEDIA_TYPE', () => {
      expect(() => assertIngestible(makeFile('anim.gif', 'image/gif')))
        .toThrow(/UNSUPPORTED_MEDIA_TYPE/);
    });

    test('rejects image/webp with UNSUPPORTED_MEDIA_TYPE', () => {
      expect(() => assertIngestible(makeFile('banner.webp', 'image/webp')))
        .toThrow(/UNSUPPORTED_MEDIA_TYPE/);
    });

    test('rejects .jpg extension with empty MIME (image extension wins)', () => {
      expect(() => assertIngestible(makeFile('cover.jpg', '')))
        .toThrow(/UNSUPPORTED_MEDIA_TYPE/);
    });

    test('rejects .jpeg extension with empty MIME', () => {
      expect(() => assertIngestible(makeFile('photo.jpeg', '')))
        .toThrow(/UNSUPPORTED_MEDIA_TYPE/);
    });

    test('rejects .png extension with empty MIME', () => {
      expect(() => assertIngestible(makeFile('screenshot.png', '')))
        .toThrow(/UNSUPPORTED_MEDIA_TYPE/);
    });

    test('error message mentions audio or video', () => {
      const err = (() => {
        try { assertIngestible(makeFile('photo.jpg', 'image/jpeg')); }
        catch (e) { return e; }
      })();
      expect(err).toBeDefined();
      expect(err.message).toMatch(/audio or video/i);
    });
  });
});
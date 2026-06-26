/**
 * VoiceIsolate Pro — M4A / HE-AAC decode fallback regression tests
 *
 * Verifies the media-element capture fallback that handles audio formats
 * rejected by decodeAudioData() — notably HE-AAC v2 embedded in .m4a
 * containers, which is the default encoding on many Android voice recorders.
 *
 * All assertions are static source checks; no AudioContext or MediaRecorder
 * is instantiated, matching the pattern used by audio-upload-fixes.test.js.
 */
'use strict';

const fs  = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const fijs = fs.readFileSync(path.join(ROOT, 'src/pipeline/FileIngestion.js'), 'utf8');
const ljs  = fs.readFileSync(path.join(ROOT, 'public/landing.js'), 'utf8');

// ── FileIngestion.js: fallback function existence & structure ─────────────────

describe('M4A decode fallback — FileIngestion.js', () => {
  test('decodeViaMediaElement() is defined', () => {
    expect(fijs).toContain('function decodeViaMediaElement(');
  });

  test('fallback is gated on MediaRecorder availability', () => {
    expect(fijs).toContain('typeof MediaRecorder');
  });

  test('fallback creates an object URL and always revokes it', () => {
    expect(fijs).toContain('URL.createObjectURL(blob)');
    expect(fijs).toContain('URL.revokeObjectURL(url)');
  });

  test('object URL is revoked in a finally block (no leaks on error paths)', () => {
    expect(fijs).toMatch(/finally\s*\{[^}]*URL\.revokeObjectURL/s);
  });

  test('AudioContext is closed in a finally block (no hardware leaks)', () => {
    expect(fijs).toMatch(/finally\s*\{[^}]*actx\.close\(\)/s);
  });

  test('fallback routes audio via createMediaElementSource', () => {
    expect(fijs).toContain('createMediaElementSource(audio)');
  });

  test('fallback records via MediaRecorder', () => {
    expect(fijs).toContain('new MediaRecorder(');
    expect(fijs).toContain('recorder.start()');
    expect(fijs).toContain('recorder.stop()');
  });

  test('fallback emits the transcoding progress stage', () => {
    expect(fijs).toContain("onProgress('transcoding')");
  });

  test('audio.muted=true allows autoplay without a live user gesture', () => {
    expect(fijs).toContain('audio.muted = true');
  });

  test('MAX_MEDIA_FALLBACK_SECONDS guards against very long files (30 min cap)', () => {
    expect(fijs).toContain('MAX_MEDIA_FALLBACK_SECONDS');
    expect(fijs).toMatch(/30\s*\*\s*60/);
  });
});

// ── FileIngestion.js: decodeBlob fallback wiring ─────────────────────────────

describe('M4A decode fallback — decodeBlob wiring', () => {
  test('decodeBlob() accepts an onProgress callback', () => {
    expect(fijs).toMatch(/async function decodeBlob\(blob,\s*onProgress/);
  });

  test('decodeBlob() calls decodeViaMediaElement on decode failure', () => {
    expect(fijs).toContain('decodeViaMediaElement(blob, onProgress)');
  });

  test('ingestFile passes onProgress to decodeBlob', () => {
    expect(fijs).toContain('decodeBlob(file, onProgress)');
  });

  test('combined error message for M4A includes a conversion hint', () => {
    expect(fijs).toContain('.m4a');
    expect(fijs).toContain('MP3 or WAV');
  });

  test('M4A detection uses string methods (no ReDoS-vulnerable regex)', () => {
    // Replaced /\.m4a$/i and /audio\/(mp4|x-m4a)/ with endsWith/includes
    // to satisfy the nodejsscan ReDoS rule.
    expect(fijs).toContain("endsWith('.m4a')");
    expect(fijs).toContain("includes('mp4')");
    expect(fijs).toContain("includes('x-m4a')");
  });
});

// ── landing.js: UI feedback during transcoding ────────────────────────────────

describe('M4A decode fallback — landing.js UI feedback', () => {
  test("landing.js handles the 'transcoding' progress stage", () => {
    expect(ljs).toMatch(/stage\s*===\s*['"]transcoding['"]/);
  });

  test('landing.js shows an indeterminate spinner during transcoding', () => {
    expect(ljs).toMatch(/transcoding[\s\S]{0,300}indeterminate:\s*true/);
  });
});

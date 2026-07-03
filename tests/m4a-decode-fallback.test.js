/**
 * VoiceIsolate Pro — M4A / HE-AAC decode fallback regression tests
 *
 * Verifies the media-element + OfflineAudioContext fallback that handles audio
 * formats rejected by decodeAudioData() — notably HE-AAC v2 in .m4a containers.
 *
 * Static source checks only; no AudioContext or DOM is instantiated.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const fijs = fs.readFileSync(path.join(ROOT, 'src/pipeline/FileIngestion.js'), 'utf8');
const mdjs = fs.readFileSync(path.join(ROOT, 'src/pipeline/media-decode.js'), 'utf8');
const mtjs = fs.readFileSync(path.join(ROOT, 'src/core/media-types.js'), 'utf8');
const ljs = fs.readFileSync(path.join(ROOT, 'public/landing.js'), 'utf8');

describe('M4A decode fallback — media-decode.js', () => {
  test('decodeBlobToAudioBuffer() is exported', () => {
    expect(mdjs).toContain('export async function decodeBlobToAudioBuffer');
  });

  test('fallback uses live AudioContext + ScriptProcessorNode capture', () => {
    expect(mdjs).toContain('createMediaElementSource(media)');
    expect(mdjs).toContain('createScriptProcessor(SPN_BLOCK_SIZE, numChannels, numChannels)');
    expect(mdjs).not.toContain('MediaRecorder');
    expect(mdjs).not.toContain('offline.startRendering()');
  });

  test('ended listener is armed before awaiting play()', () => {
    expect(mdjs).toMatch(/const endedPromise = new Promise\([\s\S]*media\.addEventListener\('ended'/);
    expect(mdjs).toContain('await media.play()');
  });

  test('object URL is created and revoked in finally', () => {
    expect(mdjs).toContain('URL.createObjectURL(blob)');
    expect(mdjs).toMatch(/finally[\s\S]*URL\.revokeObjectURL\(url\)/);
  });

  test('media element is cleaned up in finally', () => {
    expect(mdjs).toMatch(/finally[\s\S]*media\.pause\(\)/);
    expect(mdjs).toMatch(/finally[\s\S]*media\.remove\(\)/);
  });

  test('fallback routes audio via createMediaElementSource', () => {
    expect(mdjs).toContain('createMediaElementSource(media)');
  });
  test('fallback creates audio/video element by inferred kind', () => {
    expect(mdjs).toContain("const tag = kind === 'video' ? 'video' : 'audio'");
  });
});

describe('M4A decode fallback — media-types.js', () => {
  test('extension-first inference treats .m4a as audio', () => {
    expect(mtjs).toContain('AUDIO_EXTENSIONS');
    expect(mtjs).toContain("if (AUDIO_EXTENSIONS.test(name)) return 'audio'");
    expect(mtjs).toContain('Extension wins over misleading MIME');
  });
});

describe('M4A decode fallback — FileIngestion wiring', () => {
  test('FileIngestion imports decodeBlobToAudioBuffer', () => {
    expect(fijs).toContain("import { decodeBlobToAudioBuffer } from './media-decode.js'");
  });

  test('ingestFile calls decodeBlobToAudioBuffer after yielding to the UI', () => {
    expect(fijs).toContain('decodeBlobToAudioBuffer(file)');
    expect(fijs).toMatch(/queueMicrotask\(resolve\)/);
  });

  test('validation uses inferMediaKind for extension-based acceptance', () => {
    expect(fijs).toContain('inferMediaKind');
  });
});

describe('M4A decode fallback — landing.js upload UX', () => {
  test('landing.js guards against stale concurrent ingestions', () => {
    expect(ljs).toContain('ingestSeq');
    expect(ljs).toMatch(/seq\s*!==\s*ingestSeq/);
  });

  test('landing.js wires upload zone and browse button', () => {
    expect(ljs).toContain('uploadZone');
    expect(ljs).toContain('wireUploadDropZone');
    expect(ljs).toContain('browseBtn');
  });

  test('landing.js resets file input so the same file can be re-selected', () => {
    expect(ljs).toMatch(/finally[\s\S]*ui\.fileInput\.value\s*=\s*''/);
  });
});
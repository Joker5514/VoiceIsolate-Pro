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
const m4ajs = fs.readFileSync(path.join(ROOT, 'public/app/m4a-decode-fix.js'), 'utf8');
const bootstrapJs = fs.readFileSync(path.join(ROOT, 'public/app/dsp-bootstrap.js'), 'utf8');

describe('M4A decode fallback — media-decode.js', () => {
  test('decodeBlobToAudioBuffer() is exported', () => {
    expect(mdjs).toContain('export async function decodeBlobToAudioBuffer');
  });

  describe('M4A decode fallback — legacy engineer patch wiring', () => {
    test('m4a-decode-fix exposes a reusable fallback helper on window', () => {
      expect(m4ajs).toContain('window.decodeM4AWithFallback');
      expect(m4ajs).toContain('window.__vipM4ADecodeFixLoaded = true');
    });

    test('dsp-bootstrap injects m4a-decode-fix.js without changing index.html', () => {
      expect(bootstrapJs).toContain("script.src = './m4a-decode-fix.js'");
      expect(bootstrapJs).toContain('window.__vipM4ADecodeFixLoaded');
    });
  });

  test('fallback uses live AudioContext + ScriptProcessorNode capture', () => {
    expect(mdjs).toContain('createMediaElementSource(media)');
    expect(mdjs).toContain('createScriptProcessor(SPN_BLOCK_SIZE, numChannels, numChannels)');
    expect(mdjs).not.toContain('MediaRecorder');
    expect(mdjs).not.toContain('offline.startRendering()');
  });

  test('ended listener is armed before awaiting play()', () => {
    expect(mdjs).toMatch(/media\.addEventListener\('ended'/);
    expect(mdjs).toContain('await media.play()');
    expect(mdjs).toContain('finishCapture');
  });

  test('capture timeout always settles the decode promise (no hang)', () => {
    expect(mdjs).toContain('captureSettled');
    expect(mdjs).toContain('finishCapture');
    expect(mdjs).toMatch(/setTimeout\([\s\S]*finishCapture/);
  });

  test('decode accepts onProgress hooks for live capture feedback', () => {
    expect(mdjs).toContain('onProgress = () => {}');
    expect(mdjs).toContain('reportProgress');
    expect(mdjs).toContain('readBlobWithProgress');
    expect(mdjs).toContain('createGrowingChannel');
    expect(fijs).toContain('onProgress: (pct) => onProgress');
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

  test('video tries fast decodeAudioData then accelerated media-element fallback', () => {
    expect(mdjs).toContain("if (kind === 'video')");
    expect(mdjs).toContain('_likelyTruncatedDecode');
    expect(mdjs).toContain('_decodeViaMediaElement(blob, kind, onProgress)');
    expect(mdjs).toContain('playbackRate');
    expect(mdjs).toContain('MAX_CAPTURE_PLAYBACK_RATE');
  });

  test('capture timeout scales with media duration and playback rate', () => {
    expect(mdjs).toContain('resetCaptureTimeout');
    expect(mdjs).toContain('realtimeMs');
    expect(mdjs).toMatch(/\/\s*playbackRate/);
    expect(mdjs).not.toContain('capturedFrames >= estimatedFrames');
  });

  test('small files use a single arrayBuffer read for speed', () => {
    expect(mdjs).toContain('FAST_READ_BYTES');
    expect(mdjs).toContain('total <= FAST_READ_BYTES');
  });

  test('media capture uses larger ScriptProcessor blocks for less overhead', () => {
    expect(mdjs).toContain('SPN_BLOCK_SIZE = 8192');
  });

  test('decode speed benchmark script enforces sub-realtime budget', () => {
    const bench = fs.readFileSync(path.join(ROOT, 'scripts/bench-decode-speed.cjs'), 'utf8');
    expect(bench).toContain('MAX_DECODE_RATIO');
    expect(bench).not.toContain('full-audit');
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

  test('ingestFile calls decodeBlobToAudioBuffer without an artificial pre-decode delay', () => {
    expect(fijs).toContain('decodeBlobToAudioBuffer(file');
    expect(fijs).not.toMatch(/queueMicrotask\(resolve\)/);
  });

  test('media-decode uses cross-browser safe decodeAudioData wrapper', () => {
    expect(mdjs).toContain('decodeAudioBufferSafe');
    expect(mdjs).toContain('safeDecodeAudioData');
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

  test('landing.js overlaps ML warmup with decode (non-blocking before process)', () => {
    expect(ljs).toContain('void warmupWorkerModels(modelIds)');
    expect(ljs).not.toContain('await warmupP');
  });
});
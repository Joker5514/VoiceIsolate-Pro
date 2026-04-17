/**
 * VoiceIsolate Pro — handleFile() Validation Tests
 *
 * Verifies that handleFile() accepts all file sizes (no upload limit),
 * rejects unsupported file types, and handles MIDI files with a clear error.
 *
 * Loads the class from public/app/app.js using the VM + fake-globals technique.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── Shared fixture: load VoiceIsolatePro.prototype.handleFile ─────────────────

let handleFile;

beforeAll(() => {
  const appJsPath = path.join(__dirname, '../public/app/app.js');
  const appJs     = fs.readFileSync(appJsPath, 'utf8');

  const sandbox = {
    document: {
      addEventListener:   jest.fn(),
      getElementById:     jest.fn(() => ({ addEventListener: jest.fn(), appendChild: jest.fn(), style: {} })),
      createElement:      jest.fn(() => ({ textContent: '', innerHTML: '' })),
      querySelector:      jest.fn(() => null),
      querySelectorAll:   jest.fn(() => ({ forEach: jest.fn() })),
      readyState:         'complete',
      body:               { appendChild: jest.fn() },
    },
    window: { LicenseManager: undefined },
    module:       { exports: {} },
    Float32Array: Float32Array,
    Math:         Math,
    console:      { error: jest.fn(), warn: jest.fn(), log: jest.fn() },
    parseFloat:   parseFloat,
    parseInt:     parseInt,
    URL: {
      createObjectURL: jest.fn(() => 'blob:test'),
      revokeObjectURL: jest.fn(),
    },
    setTimeout:   setTimeout,
    clearTimeout: clearTimeout,
    setInterval:  setInterval,
    clearInterval: clearInterval,
    Promise:      Promise,
    localStorage: {
      getItem:    jest.fn(() => null),
      setItem:    jest.fn(),
      removeItem: jest.fn(),
    },
    AudioContext:     jest.fn(() => ({})),
    requestAnimationFrame: jest.fn(cb => setTimeout(cb, 0)),
    cancelAnimationFrame:  jest.fn(),
    performance:      { now: jest.fn(() => Date.now()) },
  };

  const _sandboxWindow = { LicenseManager: undefined };
  Object.defineProperty(sandbox, 'window', {
    get: () => (typeof global !== 'undefined' && global.window != null)
      ? global.window
      : _sandboxWindow,
    set: () => {},
    configurable: true,
  });

  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox);

  const VoiceIsolatePro = sandbox.module.exports;
  handleFile = VoiceIsolatePro.prototype.handleFile;
});

// ── Helper: build a minimal mockVip ──────────────────────────────────────────
function makeMockVip() {
  return {
    ensureCtx:   jest.fn(),
    stop:        jest.fn(),
    setStatus:   jest.fn(),
    onAudioLoaded: jest.fn(),
    decodeViaVideoElement: jest.fn().mockResolvedValue({ length: 100 }),
    dom: {
      fileInfo:   { textContent: '' },
      videoPlayer: { src: '', onloadedmetadata: null, onerror: null },
      videoCard:  { style: { display: '' } },
      processBtn: { disabled: false },
      reprocessBtn: { disabled: false },
      mobileReprocessBtn: { disabled: false },
    },
    ctx: {
      decodeAudioData: jest.fn().mockResolvedValue({ length: 100 }),
    },
    params: {},
  };
}

// ── No upload limit — any file size is accepted ───────────────────────────────
describe('handleFile() — no upload size limit', () => {
  test('accepts a normally-sized file (5 MB) without error', async () => {
    const mockVip = makeMockVip();
    const mockFile = {
      name: 'normal.wav', size: 5 * 1024 * 1024, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.dom.fileInfo.textContent).not.toContain('File too large');
    expect(mockVip.dom.fileInfo.textContent).not.toContain('too large');
  });

  test('accepts a large file (500 MB) without a size error', async () => {
    const mockVip = makeMockVip();
    const mockFile = {
      name: 'large.wav', size: 500 * 1024 * 1024, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.dom.fileInfo.textContent).not.toContain('File too large');
    expect(mockVip.dom.fileInfo.textContent).not.toContain('hard cap');
  });

  test('accepts a very large file (2 GB) without a size error', async () => {
    const mockVip = makeMockVip();
    const mockFile = {
      name: 'huge.wav', size: 2 * 1024 * 1024 * 1024, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.dom.fileInfo.textContent).not.toContain('File too large');
  });

  test('handleFile source contains no hard-coded 200 MB cap', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
    expect(appJs).not.toContain('exceeds 200 MB hard cap');
    expect(appJs).not.toContain('fileSizeMB > 200');
  });

  test('handleFile source contains no LicenseManager file size check', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
    expect(appJs).not.toContain('LM.checkFileLimit');
  });
});

// ── MIME type / format validation ─────────────────────────────────────────────
describe('handleFile() — file type validation', () => {
  test('rejects MIDI files with a clear error', async () => {
    const mockVip = makeMockVip();
    const mockFile = {
      name: 'song.mid', size: 10 * 1024, type: 'audio/midi',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.setStatus).toHaveBeenCalledWith('ERROR');
    expect(mockVip.dom.fileInfo.textContent).toContain('MIDI');
  });

  test('rejects .midi extension files with a clear error', async () => {
    const mockVip = makeMockVip();
    const mockFile = {
      name: 'track.midi', size: 10 * 1024, type: '',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.setStatus).toHaveBeenCalledWith('ERROR');
    expect(mockVip.dom.fileInfo.textContent).toContain('MIDI');
  });

  test('rejects unsupported MIME types', async () => {
    const mockVip = makeMockVip();
    const mockFile = {
      name: 'data.bin', size: 1024, type: 'application/octet-stream',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.setStatus).toHaveBeenCalledWith('ERROR');
    expect(mockVip.dom.fileInfo.textContent).toContain('Unsupported');
  });

  test('accepts audio/wav files', async () => {
    const mockVip = makeMockVip();
    const mockFile = {
      name: 'audio.wav', size: 1024, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.dom.fileInfo.textContent).not.toContain('Unsupported');
    expect(mockVip.dom.fileInfo.textContent).not.toContain('MIDI');
  });

  test('accepts audio/mpeg (MP3) files', async () => {
    const mockVip = makeMockVip();
    const mockFile = {
      name: 'track.mp3', size: 1024, type: 'audio/mpeg',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.dom.fileInfo.textContent).not.toContain('Unsupported');
  });

  test('accepts video/mp4 files via video decode path', async () => {
    const mockVip = makeMockVip();
    const videoPlayer = { src: '', _onloadedmetadata: null, _onerror: null };
    Object.defineProperty(videoPlayer, 'onloadedmetadata', {
      get() { return this._onloadedmetadata; },
      set(fn) { this._onloadedmetadata = fn; setTimeout(() => fn && fn(), 0); }
    });
    Object.defineProperty(videoPlayer, 'onerror', {
      get() { return this._onerror; },
      set(fn) { this._onerror = fn; }
    });
    mockVip.dom.videoPlayer = videoPlayer;
    const mockFile = {
      name: 'clip.mp4', size: 1024, type: 'video/mp4',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.decodeViaVideoElement).toHaveBeenCalledWith(mockFile);
    expect(mockVip.ctx.decodeAudioData).not.toHaveBeenCalled();
    expect(mockVip.dom.fileInfo.textContent).not.toContain('Unsupported');
  });

  test('copies ArrayBuffer before decodeAudioData for audio files', async () => {
    const mockVip = makeMockVip();
    const rawBuffer = new ArrayBuffer(64);
    const mockFile = {
      name: 'voice.wav', size: 1024, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(rawBuffer),
    };

    await handleFile.call(mockVip, mockFile);

    const decodeArg = mockVip.ctx.decodeAudioData.mock.calls[0][0];
    expect(decodeArg).not.toBe(rawBuffer);
    expect(decodeArg.byteLength).toBe(rawBuffer.byteLength);
  });
});

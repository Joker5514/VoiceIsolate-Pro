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
const getAppCode = require('./helpers/get-app-code');

// ── Shared fixture: load VoiceIsolatePro.prototype.handleFile ─────────────────

let handleFile;
let vipProto;

beforeAll(() => {
  const appJs = getAppCode();

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
  vipProto = VoiceIsolatePro.prototype;
  handleFile = vipProto.handleFile;
});

// ── Helper: build a minimal mockVip ──────────────────────────────────────────
function makeMockVip() {
  const fileInput = { value: '' };
  return {
    ensureCtx:   jest.fn(),
    stop:        jest.fn(),
    setStatus:   jest.fn(),
    onAudioLoaded: jest.fn(),
    showNotification: jest.fn(),
    _showFileLoading: jest.fn(),
    _hideFileLoading: jest.fn(),
    _readFileArrayBuffer: vipProto._readFileArrayBuffer,
    _decodeFileBuffer: vipProto._decodeFileBuffer,
    decodeViaVideoElement: jest.fn().mockResolvedValue({ length: 100 }),
    _resetFileInput: jest.fn(function () { if (this.dom?.fileInput) this.dom.fileInput.value = ''; }),
    _waitForPipelineIdle: jest.fn().mockResolvedValue(undefined),
    _warmupMLModels: jest.fn().mockResolvedValue(undefined),
    abortFlag: false,
    dom: {
      fileInfo:   { textContent: '' },
      fileInput,
      videoPlayer: { src: '', onloadedmetadata: null, onerror: null },
      videoCard:  { style: { display: '' } },
      processBtn: { disabled: false },
      reprocessBtn: { disabled: false },
      mobileReprocessBtn: { disabled: false },
    },
    ctx: {
      state: 'running',
      resume: jest.fn().mockResolvedValue(undefined),
      decodeAudioData: jest.fn().mockResolvedValue({ length: 100 }),
    },
    params: {},
    _fileSeq: 0,
    isProcessing: false,
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

  test('restores process button states after a rejected file', async () => {
    const mockVip = makeMockVip();
    mockVip.dom.processBtn.disabled = false;
    mockVip.dom.reprocessBtn.disabled = true;
    mockVip.dom.mobileReprocessBtn.disabled = false;
    const mockFile = {
      name: 'data.bin', size: 1024, type: 'application/octet-stream',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.dom.processBtn.disabled).toBe(false);
    expect(mockVip.dom.reprocessBtn.disabled).toBe(true);
    expect(mockVip.dom.mobileReprocessBtn.disabled).toBe(false);
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

  test('accepts application/octet-stream when filename has a known audio extension', async () => {
    const mockVip = makeMockVip();
    const mockFile = {
      name: 'voice.wav', size: 1024, type: 'application/octet-stream',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.setStatus).not.toHaveBeenCalledWith('ERROR');
    expect(mockVip.dom.fileInfo.textContent).not.toContain('Unsupported');
    expect(mockVip.ctx.decodeAudioData).toHaveBeenCalled();
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

  test('accepts video/mp4 files through the shared media decode path', async () => {
    const mockVip = makeMockVip();
    const decoded = { length: 48000, duration: 2, sampleRate: 48000, numberOfChannels: 2 };
    mockVip.ctx.decodeAudioData.mockResolvedValue(decoded);
    mockVip.dom.videoPlayer = { src: '' };
    const mockFile = {
      name: 'clip.mp4', size: 1024, type: 'video/mp4',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(mockVip.onAudioLoaded).toHaveBeenCalledWith('clip.mp4', 1);
    expect(mockVip.dom.videoPlayer.src).toBe('blob:test');
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

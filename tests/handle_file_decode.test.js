const fs = require('fs');
const path = require('path');
const vm = require('vm');
const getAppCode = require('./helpers/get-app-code');

describe('VoiceIsolatePro handleFile() Audio Decoding', () => {
  let VoiceIsolatePro;
  let originalDocument;
  let originalWindow;
  let originalURL;

  beforeAll(() => {
    originalDocument = global.document;
    originalWindow = global.window;
    originalURL = global.URL;

    global.document = {
      addEventListener: jest.fn(),
      getElementById: jest.fn(() => ({ addEventListener: jest.fn(), appendChild: jest.fn() })),
      createElement: jest.fn(() => ({})),
    };
    global.window = {};

    global.URL = {
      createObjectURL: jest.fn(() => 'blob:test'),
      revokeObjectURL: jest.fn()
    };

    const appJs = getAppCode();

    const sandbox = {
      document: global.document,
      window: global.window,
      module: { exports: {} },
      Float32Array: Float32Array,
      Math: Math,
      console: { error: jest.fn() },
      parseFloat: parseFloat,
      URL: global.URL,
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
      Promise: Promise,
      requestAnimationFrame: (cb) => setTimeout(cb, 0),
    };
    vm.createContext(sandbox);
    vm.runInContext(appJs, sandbox);

    VoiceIsolatePro = sandbox.module.exports;
  });

  afterAll(() => {
    global.document = originalDocument;
    global.window = originalWindow;
    global.URL = originalURL;
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  it('decodes video files via the shared media decode path', async () => {
    const handleFile = VoiceIsolatePro.prototype.handleFile;
    const decoded = { length: 48000, duration: 1, sampleRate: 48000, numberOfChannels: 2 };

    const mockVip = {
      ensureCtx: jest.fn(),
      stop: jest.fn(),
      setStatus: jest.fn(),
      onAudioLoaded: jest.fn(),
      showNotification: jest.fn(),
      _showFileLoading: jest.fn(),
      _hideFileLoading: jest.fn(),
      _resetFileInput: jest.fn(),
      _readFileArrayBuffer: VoiceIsolatePro.prototype._readFileArrayBuffer,
      _decodeFileBuffer: VoiceIsolatePro.prototype._decodeFileBuffer,
      dom: {
        fileInfo: {},
        videoPlayer: { src: '' },
        videoCard: { style: {} }
      },
      ctx: {
        state: 'running',
        resume: jest.fn().mockResolvedValue(undefined),
        decodeAudioData: jest.fn().mockResolvedValue(decoded)
      }
    };

    const mockFile = {
      name: 'test.mp4',
      size: 1000,
      type: 'video/mp4',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10))
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(mockVip.inputBuffer).toBe(decoded);
    expect(mockVip.dom.videoPlayer.src).toBe('blob:test');
  });

  it('shows an error when decode fails for audio files', async () => {
    const handleFile = VoiceIsolatePro.prototype.handleFile;

    const mockVip = {
      ensureCtx: jest.fn(),
      stop: jest.fn(),
      setStatus: jest.fn(),
      onAudioLoaded: jest.fn(),
      showNotification: jest.fn(),
      _showFileLoading: jest.fn(),
      _hideFileLoading: jest.fn(),
      _resetFileInput: jest.fn(),
      _readFileArrayBuffer: VoiceIsolatePro.prototype._readFileArrayBuffer,
      _decodeFileBuffer: VoiceIsolatePro.prototype._decodeFileBuffer,
      dom: {
        fileInfo: { textContent: '' },
        videoPlayer: {},
        videoCard: { style: {} }
      },
      ctx: {
        state: 'running',
        resume: jest.fn().mockResolvedValue(undefined),
        decodeAudioData: jest.fn().mockRejectedValue(new Error('Decode failed'))
      }
    };

    const mockFile = {
      name: 'test.wav',
      size: 1000,
      type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10))
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.ctx.decodeAudioData).toHaveBeenCalled();
    expect(mockVip.dom.fileInfo.textContent).toContain('Cannot decode this audio format');
    expect(mockVip.dom.fileInfo.textContent).toContain('WAV or MP3');
    expect(mockVip.setStatus).toHaveBeenCalledWith('ERROR');
  });

  it('shows an error when decoded audio buffer is empty', async () => {
    const handleFile = VoiceIsolatePro.prototype.handleFile;

    const mockVip = {
      ensureCtx: jest.fn(),
      stop: jest.fn(),
      setStatus: jest.fn(),
      onAudioLoaded: jest.fn(),
      showNotification: jest.fn(),
      _showFileLoading: jest.fn(),
      _hideFileLoading: jest.fn(),
      _resetFileInput: jest.fn(),
      _readFileArrayBuffer: VoiceIsolatePro.prototype._readFileArrayBuffer,
      _decodeFileBuffer: VoiceIsolatePro.prototype._decodeFileBuffer,
      dom: {
        fileInfo: { textContent: '' },
        videoPlayer: {},
        videoCard: { style: {} }
      },
      ctx: {
        state: 'running',
        resume: jest.fn().mockResolvedValue(undefined),
        decodeAudioData: jest.fn().mockResolvedValue([])
      }
    };

    const mockFile = {
      name: 'test.wav',
      size: 1000,
      type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10))
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.ctx.decodeAudioData).toHaveBeenCalled();
    expect(mockVip.dom.fileInfo.textContent).toContain('Decoded audio is empty');
    expect(mockVip.setStatus).toHaveBeenCalledWith('ERROR');
  });
});
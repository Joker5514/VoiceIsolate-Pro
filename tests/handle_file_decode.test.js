const fs = require('fs');
const path = require('path');
const vm = require('vm');
const getAppCode = require('./helpers/get-app-code');

describe('VoiceIsolatePro handleFile() Audio Decoding', () => {
  let VoiceIsolatePro;
  let originalDocument;
  let originalWindow;
  let originalURL;
  let originalCustomEvent;

  beforeAll(() => {
    originalDocument = global.document;
    originalWindow = global.window;
    originalURL = global.URL;
    originalCustomEvent = global.CustomEvent;

    global.document = {
      addEventListener: jest.fn(),
      getElementById: jest.fn(() => ({ addEventListener: jest.fn(), appendChild: jest.fn() })),
      createElement: jest.fn(() => ({})),
    };
    global.window = { dispatchEvent: jest.fn() };
    global.CustomEvent = function CustomEvent(type, init = {}) {
      if (!(this instanceof CustomEvent)) return new CustomEvent(type, init);
      this.type = type;
      this.detail = init.detail;
    };

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
      CustomEvent: global.CustomEvent,
      requestAnimationFrame: (cb) => setTimeout(cb, 0),
      requestIdleCallback: (cb) => cb(),
      resetFileInput: (input) => {
        if (input) input.value = '';
      },
      yieldToBrowser: async () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(appJs, sandbox);

    VoiceIsolatePro = sandbox.module.exports;
  });

  afterAll(() => {
    global.document = originalDocument;
    global.window = originalWindow;
    global.URL = originalURL;
    global.CustomEvent = originalCustomEvent;
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  function makeMockVip() {
    return {
      ensureCtx: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn(),
      setStatus: jest.fn(),
      onAudioLoaded: jest.fn(),
      showNotification: jest.fn(),
      _showFileLoading: jest.fn(),
      _hideFileLoading: jest.fn(),
      _waitForPipelineIdle: jest.fn().mockResolvedValue(undefined),
      _warmupMLModels: jest.fn().mockResolvedValue(undefined),
      _updateProcessButtonsState: jest.fn(),
      _updateSaveButtonLabels: jest.fn(),
      _fileSeq: 0,
      _decodePromise: null,
      _decodeReady: false,
      abortFlag: false,
      isProcessing: false,
      dom: {
        fileInput: { value: 'selected-file' },
        fileInfo: { textContent: '' },
        videoPlayer: { src: '', load: jest.fn() },
        videoCard: { style: {} },
        processBtn: { disabled: true },
        mobileProcessBtn: { disabled: true },
        playBtn: { disabled: true },
        saveOrigBtn: { disabled: false },
      },
      ctx: {
        state: 'running',
        resume: jest.fn().mockResolvedValue(undefined),
        decodeAudioData: jest.fn(),
      },
    };
  }

  it('accepts video files without decoding during handleFile()', async () => {
    const handleFile = VoiceIsolatePro.prototype.handleFile;
    const mockVip = makeMockVip();

    const mockFile = {
      name: 'test.mp4',
      size: 1000,
      type: 'video/mp4',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10))
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.ctx.decodeAudioData).not.toHaveBeenCalled();
    expect(mockVip.inputBuffer).toBeNull();
    expect(mockVip._sourceFile).toBe(mockFile);
    expect(mockVip._decodeReady).toBe(false);
    expect(mockVip.dom.videoPlayer.src).toBe('blob:test');
    expect(mockVip.dom.fileInfo.textContent).toContain('ready (decode on Analyze/Process)');
    expect(mockVip.setStatus).toHaveBeenCalledWith('READY');
    expect(mockVip._warmupMLModels).toHaveBeenCalledTimes(1);
  });

  it('ensureDecoded decodes an accepted file and caches the decoded buffer', async () => {
    const handleFile = VoiceIsolatePro.prototype.handleFile;
    const ensureDecoded = VoiceIsolatePro.prototype.ensureDecoded;
    const decoded = { length: 48000, duration: 1, sampleRate: 48000, numberOfChannels: 2 };
    const mockVip = makeMockVip();
    mockVip.ctx.decodeAudioData.mockResolvedValue(decoded);
    mockVip.ensureDecoded = ensureDecoded;

    const mockFile = {
      name: 'test.wav',
      size: 1000,
      type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10))
    };

    await handleFile.call(mockVip, mockFile);
    const buffer = await ensureDecoded.call(mockVip);

    expect(mockVip.ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(buffer).toBe(decoded);
    expect(mockVip.inputBuffer).toBe(decoded);
    expect(mockVip.origBuffer).toBe(decoded);
    expect(mockVip._decodeReady).toBe(true);
    expect(mockVip.onAudioLoaded).toHaveBeenCalledWith('test.wav', 1);
    expect(mockVip._hideFileLoading).toHaveBeenCalled();
  });

  it('ensureDecoded surfaces decode failures after file acceptance', async () => {
    const handleFile = VoiceIsolatePro.prototype.handleFile;
    const ensureDecoded = VoiceIsolatePro.prototype.ensureDecoded;
    const mockVip = makeMockVip();
    mockVip.ctx.decodeAudioData.mockRejectedValue(new Error('Decode failed'));
    mockVip.ensureDecoded = ensureDecoded;

    const mockFile = {
      name: 'test.wav',
      size: 1000,
      type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10))
    };

    await handleFile.call(mockVip, mockFile);
    const buffer = await ensureDecoded.call(mockVip);

    expect(buffer).toBeNull();
    expect(mockVip.ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(mockVip.dom.fileInfo.textContent).toContain('Cannot decode this audio format');
    expect(mockVip.dom.fileInfo.textContent).toContain('WAV or MP3');
    expect(mockVip._decodeReady).toBe(false);
    expect(mockVip.setStatus).toHaveBeenCalledWith('ERROR');
  });

  it('ensureDecoded dedupes concurrent decode requests for the same accepted file', async () => {
    const handleFile = VoiceIsolatePro.prototype.handleFile;
    const ensureDecoded = VoiceIsolatePro.prototype.ensureDecoded;
    const decoded = { length: 48000, duration: 1, sampleRate: 48000, numberOfChannels: 2 };
    const mockVip = makeMockVip();
    mockVip.ensureDecoded = ensureDecoded;

    let resolveDecode;
    const decodePromise = new Promise((resolve) => {
      resolveDecode = () => resolve(decoded);
    });
    mockVip.ctx.decodeAudioData.mockReturnValue(decodePromise);

    const mockFile = {
      name: 'test.wav',
      size: 1000,
      type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10))
    };

    await handleFile.call(mockVip, mockFile);

    const first = ensureDecoded.call(mockVip);
    const second = ensureDecoded.call(mockVip);
    resolveDecode();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(mockVip.ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(firstResult).toBe(decoded);
    expect(secondResult).toBe(decoded);
    expect(mockVip.onAudioLoaded).toHaveBeenCalledTimes(1);
  });
});
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const getAppCode = require('./helpers/get-app-code');

describe('VoiceIsolatePro handleFile() and ensureDecoded()', () => {
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
    global.window = { dispatchEvent: jest.fn() };

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
      // Shims for functions stripped from /src/ imports that handleFile/ensureDecoded use
      resetFileInput: jest.fn(),
      yieldToBrowser: jest.fn().mockResolvedValue(undefined),
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

  // ── handleFile() — asserts file acceptance without immediate decode ────────

  it('accepts a video file and defers decoding', async () => {
    const handleFile = VoiceIsolatePro.prototype.handleFile;

    const mockVip = {
      ensureCtx: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn(),
      setStatus: jest.fn(),
      showNotification: jest.fn(),
      _showFileLoading: jest.fn(),
      _hideFileLoading: jest.fn(),
      _waitForPipelineIdle: jest.fn().mockResolvedValue(undefined),
      _warmupMLModels: jest.fn().mockResolvedValue(undefined),
      _updateProcessButtonsState: jest.fn(),
      _fileSeq: 0,
      abortFlag: false,
      isProcessing: false,
      dom: {
        fileInfo: { textContent: '' },
        videoPlayer: { src: '', muted: false },
        videoCard: { style: {} },
        fileInput: null,
      },
      ctx: {
        state: 'running',
        decodeAudioData: jest.fn(),
      },
    };

    const mockFile = {
      name: 'test.mp4',
      size: 1000,
      type: 'video/mp4',
      arrayBuffer: jest.fn(),
    };

    await handleFile.call(mockVip, mockFile);

    // File accepted without decoding
    expect(mockVip.ctx.decodeAudioData).not.toHaveBeenCalled();
    expect(mockVip._sourceFile).toBe(mockFile);
    expect(mockVip._decodeReady).toBe(false);
    expect(mockVip.isVideo).toBe(true);
    expect(mockVip.setStatus).toHaveBeenCalledWith('READY');
    expect(mockVip.dom.videoPlayer.src).toBe('blob:test');
  });

  it('accepts an audio file and defers decoding', async () => {
    const handleFile = VoiceIsolatePro.prototype.handleFile;

    const mockVip = {
      ensureCtx: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn(),
      setStatus: jest.fn(),
      showNotification: jest.fn(),
      _showFileLoading: jest.fn(),
      _hideFileLoading: jest.fn(),
      _waitForPipelineIdle: jest.fn().mockResolvedValue(undefined),
      _warmupMLModels: jest.fn().mockResolvedValue(undefined),
      _updateProcessButtonsState: jest.fn(),
      _fileSeq: 0,
      abortFlag: false,
      isProcessing: false,
      dom: {
        fileInfo: { textContent: '' },
        videoPlayer: {},
        videoCard: { style: {} },
        fileInput: null,
      },
      ctx: {
        state: 'running',
        decodeAudioData: jest.fn(),
      },
    };

    const mockFile = {
      name: 'test.wav',
      size: 2000,
      type: 'audio/wav',
      arrayBuffer: jest.fn(),
    };

    await handleFile.call(mockVip, mockFile);

    // File accepted without decoding
    expect(mockVip.ctx.decodeAudioData).not.toHaveBeenCalled();
    expect(mockVip._sourceFile).toBe(mockFile);
    expect(mockVip._decodeReady).toBe(false);
    expect(mockVip.isVideo).toBe(false);
    expect(mockVip.setStatus).toHaveBeenCalledWith('READY');
  });

  it('rejects unsupported MIDI files without decoding', async () => {
    const handleFile = VoiceIsolatePro.prototype.handleFile;

    const mockVip = {
      ensureCtx: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn(),
      setStatus: jest.fn(),
      showNotification: jest.fn(),
      _showFileLoading: jest.fn(),
      _hideFileLoading: jest.fn(),
      _waitForPipelineIdle: jest.fn().mockResolvedValue(undefined),
      _warmupMLModels: jest.fn().mockResolvedValue(undefined),
      _updateProcessButtonsState: jest.fn(),
      _fileSeq: 0,
      abortFlag: false,
      isProcessing: false,
      dom: {
        fileInfo: { textContent: '' },
        videoPlayer: {},
        videoCard: { style: {} },
        fileInput: null,
      },
      ctx: { state: 'running', decodeAudioData: jest.fn() },
    };

    const mockFile = {
      name: 'song.mid',
      size: 500,
      type: 'audio/midi',
      arrayBuffer: jest.fn(),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.ctx.decodeAudioData).not.toHaveBeenCalled();
    expect(mockVip._sourceFile).toBeUndefined();
    expect(mockVip.setStatus).toHaveBeenCalledWith('ERROR');
    expect(mockVip.dom.fileInfo.textContent).toContain('MIDI');
  });

  // ── ensureDecoded() — success / failure / deduplication ───────────────────

  it('ensureDecoded() resolves with the decoded buffer on success', async () => {
    const ensureDecoded = VoiceIsolatePro.prototype.ensureDecoded;
    const decoded = { length: 48000, duration: 1, sampleRate: 48000, numberOfChannels: 2 };

    const mockVip = {
      _fileSeq: 1,
      _sourceFile: {
        name: 'test.wav',
        type: 'audio/wav',
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
      },
      origBuffer: null,
      inputBuffer: null,
      _decodeReady: false,
      _decodePromise: null,
      isVideo: false,
      setStatus: jest.fn(),
      showNotification: jest.fn(),
      _showFileLoading: jest.fn(),
      _hideFileLoading: jest.fn(),
      ensureCtx: jest.fn().mockResolvedValue(undefined),
      onAudioLoaded: jest.fn(),
      ctx: {
        state: 'running',
        resume: jest.fn().mockResolvedValue(undefined),
        decodeAudioData: jest.fn().mockResolvedValue(decoded),
      },
    };

    const result = await ensureDecoded.call(mockVip, 1);

    // resampleToCanonical is a passthrough shim, so result === decoded
    expect(result).toBe(decoded);
    expect(mockVip.ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(mockVip.inputBuffer).toBe(decoded);
    expect(mockVip.origBuffer).toBe(decoded);
    expect(mockVip._decodeReady).toBe(true);
    expect(mockVip.onAudioLoaded).toHaveBeenCalledWith('test.wav', 1);
  });

  it('ensureDecoded() resets state and shows error when decode fails', async () => {
    const ensureDecoded = VoiceIsolatePro.prototype.ensureDecoded;

    const mockVip = {
      _fileSeq: 1,
      _sourceFile: {
        name: 'bad.wav',
        type: 'audio/wav',
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
      },
      origBuffer: null,
      inputBuffer: null,
      _decodeReady: false,
      _decodePromise: null,
      isVideo: false,
      dom: { fileInfo: { textContent: '' } },
      setStatus: jest.fn(),
      showNotification: jest.fn(),
      _showFileLoading: jest.fn(),
      _hideFileLoading: jest.fn(),
      ensureCtx: jest.fn().mockResolvedValue(undefined),
      onAudioLoaded: jest.fn(),
      ctx: {
        state: 'running',
        resume: jest.fn().mockResolvedValue(undefined),
        decodeAudioData: jest.fn().mockRejectedValue(new Error('Decode failed')),
      },
    };

    const result = await ensureDecoded.call(mockVip, 1);

    expect(result).toBeNull();
    expect(mockVip._decodeReady).toBe(false);
    expect(mockVip._decodePromise).toBeNull();
    expect(mockVip.setStatus).toHaveBeenCalledWith('ERROR');
    expect(mockVip.dom.fileInfo.textContent).toContain('Cannot decode');
    expect(mockVip.onAudioLoaded).not.toHaveBeenCalled();
  });

  it('ensureDecoded() deduplicates concurrent calls to a single decode', async () => {
    const ensureDecoded = VoiceIsolatePro.prototype.ensureDecoded;
    const decoded = { length: 48000, sampleRate: 48000, numberOfChannels: 2 };
    let decodeCallCount = 0;

    const mockVip = {
      _fileSeq: 1,
      _sourceFile: {
        name: 'test.wav',
        type: 'audio/wav',
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
      },
      origBuffer: null,
      inputBuffer: null,
      _decodeReady: false,
      _decodePromise: null,
      isVideo: false,
      setStatus: jest.fn(),
      showNotification: jest.fn(),
      _showFileLoading: jest.fn(),
      _hideFileLoading: jest.fn(),
      ensureCtx: jest.fn().mockResolvedValue(undefined),
      onAudioLoaded: jest.fn(),
      ctx: {
        state: 'running',
        resume: jest.fn().mockResolvedValue(undefined),
        decodeAudioData: jest.fn().mockImplementation(() => {
          decodeCallCount++;
          return Promise.resolve(decoded);
        }),
      },
    };

    // Start both calls before either resolves; they should share the same promise
    const p1 = ensureDecoded.call(mockVip, 1);
    const p2 = ensureDecoded.call(mockVip, 1);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(decodeCallCount).toBe(1);
    expect(r1).toBe(r2);
    expect(mockVip._decodeReady).toBe(true);
  });
});

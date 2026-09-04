const fs = require('fs');
const path = require('path');
const vm = require('vm');
const getAppCode = require('./helpers/get-app-code');

describe('VoiceIsolatePro handleFile() and ensureDecoded()', () => {
  let VoiceIsolatePro;
  let originalDocument;
  let originalWindow;
  let originalURL;
  let sandbox;
  let sandboxTimers;

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

    sandboxTimers = new Set();
    const sandboxSetTimeout = (callback, delay, ...args) => {
      const handle = setTimeout(() => {
        sandboxTimers.delete(handle);
        callback(...args);
      }, delay);
      sandboxTimers.add(handle);
      return handle;
    };
    const sandboxClearTimeout = (handle) => {
      sandboxTimers.delete(handle);
      clearTimeout(handle);
    };

    sandbox = {
      document: global.document,
      window: global.window,
      module: { exports: {} },
      Float32Array: Float32Array,
      Math: Math,
      console: { error: jest.fn(), warn: jest.fn(), log: jest.fn() },
      parseFloat: parseFloat,
      URL: global.URL,
      setTimeout: sandboxSetTimeout,
      clearTimeout: sandboxClearTimeout,
      Promise: Promise,
      requestAnimationFrame: (cb) => sandboxSetTimeout(cb, 0),
      FileLibrary: {
        setSessionState: jest.fn().mockResolvedValue(undefined),
        updateFileMeta: jest.fn().mockResolvedValue(undefined),
      },
      refreshLibraryList: jest.fn().mockResolvedValue(undefined),
      scheduleSaveTrackState: jest.fn(),
      WorkflowTier: { getConfig: jest.fn(() => ({})) },
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
    for (const handle of sandboxTimers) clearTimeout(handle);
    sandboxTimers.clear();
    delete sandbox.__VIP_JOBS__;
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

  it('_clearFile() aborts an active decode and invalidates its generation', () => {
    const abort = jest.fn();
    const mockVip = {
      _fileSeq: 7,
      _decodeAbortController: { abort },
      _sourceName: 'active.wav',
      _sourceFile: {},
      _decodePromise: Promise.resolve(),
      _resetCollaborationState: jest.fn(),
      stop: jest.fn(),
      _clearVideoElement: jest.fn(),
      _updateSaveButtonLabels: jest.fn(),
      setStatus: jest.fn(),
      dom: {},
    };

    VoiceIsolatePro.prototype._clearFile.call(mockVip);

    expect(abort).toHaveBeenCalledWith('file cleared');
    expect(mockVip._decodeAbortController).toBeNull();
    expect(mockVip._fileSeq).toBe(8);
    expect(mockVip.inputBuffer).toBeNull();
    expect(mockVip.origBuffer).toBeNull();
  });

  it('legacy decodeViaVideoElement uses the instance AudioContext in the VM shim', async () => {
    const decoded = { length: 48000, duration: 1, sampleRate: 48000, numberOfChannels: 1 };
    const mockVip = {
      ctx: {
        decodeAudioData: jest.fn().mockResolvedValue(decoded),
      },
    };
    const file = {
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await expect(VoiceIsolatePro.prototype.decodeViaVideoElement.call(mockVip, file))
      .resolves.toBe(decoded);
    expect(mockVip.ctx.decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it('allows a forced pipeline reset after cancellation clears the current job', () => {
    let currentJobId = 'newer-job';
    sandbox.__VIP_JOBS__ = {
      getCurrentJobId: jest.fn(() => currentJobId),
    };
    const originalGetElementById = sandbox.document.getElementById.getMockImplementation();
    sandbox.document.getElementById.mockImplementation(() => null);
    const fill = { style: { width: '70%' } };
    const bar = { setAttribute: jest.fn() };
    const detail = { textContent: 'Processing' };
    const mockVip = {
      _activePipelineJobId: 'cancelled-job',
      _pipelinePct: 70,
      dom: { pipeFill: fill, pipeBar: bar, pipeDetail: detail },
      updateProcessingOverlay: jest.fn(),
    };
    try {
      expect(VoiceIsolatePro.prototype.updatePipelineProgress.call(
        mockVip, 0, 'Cancelled', 0, { force: true },
      )).toBe(false);
      expect(fill.style.width).toBe('70%');

      currentJobId = null;
      expect(VoiceIsolatePro.prototype.updatePipelineProgress.call(
        mockVip, 0, 'Cancelled', 0, { force: true },
      )).toBe(true);
      expect(fill.style.width).toBe('0%');
      expect(detail.textContent).toBe('Cancelled');
    } finally {
      sandbox.document.getElementById.mockImplementation(originalGetElementById);
    }
  });

  it('decode job reaches 100 only after the buffer is installed', async () => {
    const progress = [];
    let currentJobId = null;
    sandbox.__VIP_JOBS__ = {
      beginJob: jest.fn(() => {
        currentJobId = 'decode-1';
        return { id: currentJobId, controller: new AbortController() };
      }),
      getCurrentJobId: jest.fn(() => currentJobId),
      getCurrentSignal: jest.fn(() => null),
      updateJob: jest.fn((jobId, stage, percent) => {
        progress.push({ jobId, stage, percent });
        return true;
      }),
      endJob: jest.fn(() => { currentJobId = null; }),
      isCancellationError: jest.fn(() => false),
    };
    const decoded = { length: 48000, duration: 1, sampleRate: 48000, numberOfChannels: 1 };
    const mockVip = {
      _fileSeq: 1,
      _sourceFile: {
        name: 'progress.wav',
        type: 'audio/wav',
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
      },
      origBuffer: null,
      inputBuffer: null,
      _decodeReady: false,
      _decodePromise: null,
      isProcessing: false,
      setStatus: jest.fn(),
      showNotification: jest.fn(),
      _showFileLoading: jest.fn(),
      _hideFileLoading: jest.fn(),
      showProcessingOverlay: jest.fn(),
      updateProcessingOverlay: jest.fn(),
      hideProcessingOverlay: jest.fn(),
      ensureCtx: jest.fn().mockResolvedValue(undefined),
      onAudioLoaded: jest.fn(function () {
        expect(this.inputBuffer).toBe(decoded);
        expect(progress.some((entry) => entry.percent === 100)).toBe(false);
      }),
      ctx: {
        state: 'running',
        decodeAudioData: jest.fn().mockResolvedValue(decoded),
      },
    };

    await VoiceIsolatePro.prototype.ensureDecoded.call(mockVip, 1);

    expect(progress.map((entry) => entry.percent)).toEqual(expect.arrayContaining([40, 80, 85, 100]));
    expect(progress.at(-1)).toMatchObject({ stage: 'Audio ready', percent: 100 });
  });
});

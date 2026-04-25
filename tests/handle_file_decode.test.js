const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

    const appJsPath = path.join(__dirname, '../public/app/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');

    const sandbox = {
      document: global.document,
      window: global.window,
      module: { exports: {} },
      Float32Array: Float32Array,
      Math: Math,
      console: { error: jest.fn() }, // Mock console.error to avoid noise
      parseFloat: parseFloat,
      URL: global.URL,
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
      Promise: Promise
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

  it('uses decodeViaVideoElement directly for video files', async () => {
    const handleFile = VoiceIsolatePro.prototype.handleFile;

    const mockVip = {
      ensureCtx: jest.fn(),
      stop: jest.fn(),
      setStatus: jest.fn(),
      onAudioLoaded: jest.fn(),
      showNotification: jest.fn(),
      decodeViaVideoElement: jest.fn().mockResolvedValue([1, 2, 3]), // Mock successful fallback decode
      dom: {
        fileInfo: {},
        videoPlayer: {},
        videoCard: { style: {} }
      },
      ctx: {
        decodeAudioData: jest.fn().mockRejectedValue(new Error('Decode failed'))
      }
    };

    const mockFile = {
      name: 'test.mp4',
      size: 1000,
      type: 'video/mp4',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10))
    };

    // To prevent the timeout in the `await new Promise(...)` section:
    // We execute the promise but we also setTimeout to trigger the `onloadedmetadata` event shortly after
    const timeoutId = setTimeout(() => {
      if (mockVip.dom.videoPlayer.onloadedmetadata) {
        mockVip.dom.videoPlayer.onloadedmetadata();
      }
    }, 10);

    await handleFile.call(mockVip, mockFile);

    clearTimeout(timeoutId);

    expect(mockVip.ctx.decodeAudioData).not.toHaveBeenCalled();
    expect(mockVip.decodeViaVideoElement).toHaveBeenCalledWith(mockFile);
    expect(mockVip.inputBuffer).toEqual([1, 2, 3]);
  });

  it('throws an error when decodeAudioData fails and file is not a video', async () => {
    const handleFile = VoiceIsolatePro.prototype.handleFile;

    const mockVip = {
      ensureCtx: jest.fn(),
      stop: jest.fn(),
      setStatus: jest.fn(),
      onAudioLoaded: jest.fn(),
      showNotification: jest.fn(),
      decodeViaVideoElement: jest.fn(),
      dom: {
        fileInfo: {},
        videoPlayer: {},
        videoCard: { style: {} }
      },
      ctx: {
        // Mock decodeAudioData to reject
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
    expect(mockVip.decodeViaVideoElement).not.toHaveBeenCalled();
    expect(mockVip.dom.fileInfo.textContent).toContain('Cannot decode this audio format');
    expect(mockVip.setStatus).toHaveBeenCalledWith('ERROR');
  });

  it('throws an error when decoded audio buffer is empty', async () => {
    const handleFile = VoiceIsolatePro.prototype.handleFile;

    const mockVip = {
      ensureCtx: jest.fn(),
      stop: jest.fn(),
      setStatus: jest.fn(),
      onAudioLoaded: jest.fn(),
      showNotification: jest.fn(),
      decodeViaVideoElement: jest.fn(),
      dom: {
        fileInfo: {},
        videoPlayer: {},
        videoCard: { style: {} }
      },
      ctx: {
        // Mock decodeAudioData to resolve with an empty buffer
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

/**
 * VoiceIsolate Pro — handleFile() Validation Tests
 *
 * Tests the new file-size sentinel (200 MB hard cap) and LicenseManager
 * checkFileLimit integration added to VoiceIsolatePro.handleFile() in
 * public/app/app.js.
 *
 * Loads the class from public/app/app.js (not the root app.js, which is a
 * different, smaller file) using the same VM + fake-globals technique as
 * handle_file_decode.test.js.
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
    window: {
      LicenseManager: undefined, // overridden per-test in global.window
    },
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
    requestAnimationFrame: jest.fn(),
    cancelAnimationFrame:  jest.fn(),
    performance:      { now: jest.fn(() => Date.now()) },
  };

  // Redirect window.LicenseManager lookups into sandbox.window
  Object.defineProperty(sandbox, 'window', {
    get: () => sandbox._window,
    set: (v) => { sandbox._window = v; },
  });
  sandbox._window = sandbox.window;

  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox);

  const VoiceIsolatePro = sandbox.module.exports;
  handleFile = VoiceIsolatePro.prototype.handleFile;
});

// ── Helper: build a minimal mockVip ──────────────────────────────────────────
function makeMockVip(windowOverride = {}) {
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
    },
    ctx: {
      decodeAudioData: jest.fn().mockResolvedValue({ length: 100 }),
    },
    params: {},
    _window: {
      LicenseManager: windowOverride.LicenseManager || undefined,
    },
  };
}

// ── File-size validation (MAX 200 MB hard cap) ────────────────────────────────
describe('handleFile() — file size validation (200 MB hard cap)', () => {
  test('rejects a file larger than 200 MB with a descriptive error message', async () => {
    const mockVip  = makeMockVip();
    const overSize = 201 * 1024 * 1024; // 201 MB
    const mockFile = {
      name: 'huge.wav', size: overSize, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.setStatus).toHaveBeenCalledWith('ERROR');
    expect(mockVip.dom.fileInfo.textContent).toContain('File too large');
    expect(mockVip.dom.fileInfo.textContent).toContain('201.0 MB');
    expect(mockVip.dom.fileInfo.textContent).toContain('200 MB');
  });

  test('rejects a file at exactly 200 MB + 1 byte', async () => {
    const mockVip  = makeMockVip();
    const oneOver  = 200 * 1024 * 1024 + 1;
    const mockFile = {
      name: 'over.mp3', size: oneOver, type: 'audio/mpeg',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.setStatus).toHaveBeenCalledWith('ERROR');
    expect(mockVip.dom.fileInfo.textContent).toContain('File too large');
  });

  test('does not reject a file at exactly 200 MB', async () => {
    const mockVip  = makeMockVip();
    const exactly  = 200 * 1024 * 1024;
    const mockFile = {
      name: 'max.wav', size: exactly, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    // Should NOT be called with 'ERROR' due to the size check
    const errorCalls = mockVip.setStatus.mock.calls.filter(c => c[0] === 'ERROR');
    // If ERROR was called it must not be because of size limit
    if (errorCalls.length > 0) {
      expect(mockVip.dom.fileInfo.textContent).not.toContain('File too large');
    }
  });

  test('does not reject a normally-sized file (5 MB)', async () => {
    const mockVip  = makeMockVip();
    const mockFile = {
      name: 'normal.wav', size: 5 * 1024 * 1024, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    expect(mockVip.dom.fileInfo.textContent).not.toContain('File too large');
  });

  test('error message includes the actual file size in MB (two decimal places)', async () => {
    const mockVip  = makeMockVip();
    // 250.5 MB
    const fileSize = Math.round(250.5 * 1024 * 1024);
    const mockFile = {
      name: 'big.wav', size: fileSize, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    await handleFile.call(mockVip, mockFile);

    const msg = mockVip.dom.fileInfo.textContent;
    // size displayed as X.X MB (one decimal)
    expect(msg).toMatch(/\d+\.\d\s*MB/);
  });
});

// ── LicenseManager.checkFileLimit integration ─────────────────────────────────
describe('handleFile() — LicenseManager.checkFileLimit integration', () => {
  test('calls checkFileLimit with fileSizeMB and 0 when LicenseManager is present', async () => {
    const checkFileLimit = jest.fn().mockReturnValue({ allowed: true });
    const mockVip  = makeMockVip({ LicenseManager: { checkFileLimit } });
    const fileSize = 50 * 1024 * 1024; // 50 MB
    const mockFile = {
      name: 'audio.wav', size: fileSize, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    // Provide window.LicenseManager accessible to the handleFile code
    mockVip.ctx.decodeAudioData = jest.fn().mockResolvedValue({ length: 100 });

    // Patch global.window for this call so the code inside VM can read it
    const savedWindow = global.window;
    global.window = { LicenseManager: { checkFileLimit } };

    await handleFile.call(mockVip, mockFile);

    global.window = savedWindow;

    // checkFileLimit should have been called with the file size in MB and 0
    expect(checkFileLimit).toHaveBeenCalledWith(50, 0);
  });

  test('blocks the file when checkFileLimit returns allowed:false', async () => {
    const checkFileLimit = jest.fn().mockReturnValue({
      allowed: false,
      reason: 'File size exceeds your plan limit of 25 MB.',
    });
    const mockVip  = makeMockVip();
    const mockFile = {
      name: 'big.wav', size: 30 * 1024 * 1024, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    const savedWindow = global.window;
    global.window = { LicenseManager: { checkFileLimit } };

    await handleFile.call(mockVip, mockFile);

    global.window = savedWindow;

    expect(mockVip.setStatus).toHaveBeenCalledWith('ERROR');
    expect(mockVip.dom.fileInfo.textContent).toContain('File size exceeds your plan limit of 25 MB.');
  });

  test('uses check.reason as the error message when blocked by LicenseManager', async () => {
    const reason        = 'Upgrade to PRO to process files larger than 25 MB.';
    const checkFileLimit = jest.fn().mockReturnValue({ allowed: false, reason });
    const mockVip  = makeMockVip();
    const mockFile = {
      name: 'medium.wav', size: 30 * 1024 * 1024, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    const savedWindow = global.window;
    global.window = { LicenseManager: { checkFileLimit } };

    await handleFile.call(mockVip, mockFile);

    global.window = savedWindow;

    expect(mockVip.dom.fileInfo.textContent).toContain(reason);
  });

  test('proceeds normally when LicenseManager is absent (window.LicenseManager undefined)', async () => {
    const mockVip  = makeMockVip();
    const mockFile = {
      name: 'audio.wav', size: 5 * 1024 * 1024, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    const savedWindow = global.window;
    global.window = {};    // no LicenseManager

    await handleFile.call(mockVip, mockFile);

    global.window = savedWindow;

    expect(mockVip.dom.fileInfo.textContent).not.toContain('File too large');
  });

  test('proceeds normally when LicenseManager lacks checkFileLimit method', async () => {
    const mockVip  = makeMockVip();
    const mockFile = {
      name: 'audio.wav', size: 5 * 1024 * 1024, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    const savedWindow = global.window;
    global.window = { LicenseManager: { someOtherMethod: jest.fn() } };

    await handleFile.call(mockVip, mockFile);

    global.window = savedWindow;

    expect(mockVip.dom.fileInfo.textContent).not.toContain('File too large');
  });

  test('size check runs before LicenseManager check (oversized file never calls LM)', async () => {
    const checkFileLimit = jest.fn().mockReturnValue({ allowed: true });
    const mockVip  = makeMockVip();
    const mockFile = {
      name: 'huge.wav', size: 300 * 1024 * 1024, type: 'audio/wav',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
    };

    const savedWindow = global.window;
    global.window = { LicenseManager: { checkFileLimit } };

    await handleFile.call(mockVip, mockFile);

    global.window = savedWindow;

    // The hard-cap error fires before the LM check
    expect(mockVip.dom.fileInfo.textContent).toContain('File too large');
    // LM checkFileLimit should NOT have been called since the hard cap triggered first
    expect(checkFileLimit).not.toHaveBeenCalled();
  });
});
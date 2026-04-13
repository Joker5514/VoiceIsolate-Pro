const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('VoiceIsolatePro Video Playback', () => {
  let VoiceIsolatePro;

  beforeAll(() => {
    // The test framework can't directly `import` app.js because it contains
    // browser-only code (document) that executes globally at the bottom if `module`
    // is not defined. We use `vm` to simulate a browser/module environment.
    const code = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
    const sandbox = {
      window: {},
      document: {
        addEventListener: () => {}
      },
      module: { exports: {} },
      Float32Array,
      Math,
      parseFloat,
      console,
      URL: { createObjectURL: () => {}, revokeObjectURL: () => {} },
      setTimeout,
      clearTimeout
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    VoiceIsolatePro = sandbox.module.exports;
  });

  test('handles video play promise rejection gracefully', () => {
    const play = VoiceIsolatePro.prototype.play;

    const catchMock = jest.fn();
    const playMock = jest.fn().mockReturnValue({ catch: catchMock });

    const mockThis = {
      stop: jest.fn(),
      ensureCtx: jest.fn(),
      abMode: 'original',
      inputBuffer: {},
      buildLiveChain: jest.fn(),
      ctx: { currentTime: 0 },
      dom: {
        tpABLabel: { textContent: '' },
        tpSpeed: { value: '1' },
        videoPlayer: {
          currentTime: 0,
          playbackRate: 1,
          muted: false,
          play: playMock
        }
      },
      isVideo: true,
      startSpectro: jest.fn(),
      startDiagnostics: jest.fn(),
      startFreq: jest.fn(),
      tickTime: jest.fn(),
      playOffset: 0
    };

    play.call(mockThis);

    expect(playMock).toHaveBeenCalled();
    expect(catchMock).toHaveBeenCalled();
  });
});

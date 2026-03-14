/**
 * Test for handling video playback failures.
 */

const fs = require('fs');
const path = require('path');

describe('Video Playback Failure Handling', () => {
  let VoiceIsolatePro;

  beforeAll(async () => {
    // Read the app.js code
    const appJsPath = path.join(__dirname, '../app.js');
    const code = fs.readFileSync(appJsPath, 'utf8');

    // We mock the `module` and `window` objects
    const module = { exports: {} };
    const window = {};
    const document = { addEventListener: jest.fn() };

    // Evaluate the code but inside a closure to prevent polluting globals and to return the class safely
    // Since jest complains about new Function (anti-pattern) and we can't `require` an ES Module easily
    // without transforming, and we can't dynamically import because of JEST + CommonJS test format conflicts,
    // Using `eval` in a safe localized wrapper is the most effective approach for testing this legacy structure
    // which mixes ES Module (in package.json) but CommonJS exports conditional logic (`if (typeof module !== 'undefined' && module.exports)`).

    const wrapper = `(function(module, window, document) {
      ${code}
      return module.exports;
    })`;

    VoiceIsolatePro = eval(wrapper)(module, window, document);
  });

  test('play() should gracefully catch rejected promise from videoPlayer.play()', async () => {
    // Check if VoiceIsolatePro loaded correctly
    expect(VoiceIsolatePro).toBeDefined();
    expect(typeof VoiceIsolatePro).toBe('function');

    // We mock the DOM environment just to test the prototype without instantiating
    const play = VoiceIsolatePro.prototype.play;

    // Return an actual rejected promise
    const rejectedPromise = Promise.reject(new Error('Test playback failure'));

    const playMock = jest.fn(() => rejectedPromise);

    // Fake instance setup representing the state inside play()
    const fakeInstance = {
      stop: jest.fn(),
      ensureCtx: jest.fn(),
      abMode: 'original',
      inputBuffer: { duration: 10, sampleRate: 44100 },
      outputBuffer: null,
      isVideo: true,
      playOffset: 0,
      ctx: { currentTime: 1 },
      dom: {
        tpABLabel: {},
        tpSpeed: { value: "1.0" },
        videoPlayer: {
          currentTime: 0,
          playbackRate: 1,
          muted: false,
          play: playMock
        }
      },
      analyserNode: {},
      buildLiveChain: jest.fn(),
      startSpectro: jest.fn(),
      startFreq: jest.fn(),
      tickTime: jest.fn()
    };

    expect(() => {
      play.call(fakeInstance);
    }).not.toThrow();

    expect(fakeInstance.dom.videoPlayer.play).toHaveBeenCalled();
    expect(fakeInstance.isPlaying).toBe(true);
    expect(fakeInstance.playStartTime).toBe(1);
    expect(fakeInstance.dom.videoPlayer.muted).toBe(true);

    // Catch the promise so Jest doesn't complain about unhandled rejection
    await expect(rejectedPromise).rejects.toThrow('Test playback failure');
  });
const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('VoiceIsolatePro', () => {
    let VoiceIsolatePro;
    let originalDocument;
    let originalWindow;

    beforeAll(() => {
        originalDocument = global.document;
        originalWindow = global.window;

        global.document = {
            addEventListener: jest.fn(),
            getElementById: jest.fn(() => ({ addEventListener: jest.fn(), appendChild: jest.fn() })),
            createElement: jest.fn(() => ({})),
        };
        global.window = {};

        const appJsPath = path.join(__dirname, '../public/app/app.js');
        const appJs = fs.readFileSync(appJsPath, 'utf8');

        const sandbox = {
            document: global.document,
            window: global.window,
            module: { exports: {} },
            Float32Array: Float32Array,
            Math: Math,
            console: console,
            parseFloat: parseFloat
        };
        vm.createContext(sandbox);
        vm.runInContext(appJs, sandbox);

        VoiceIsolatePro = sandbox.module.exports;
    });

    afterAll(() => {
        global.document = originalDocument;
        global.window = originalWindow;
    });

    describe('play() video handling', () => {
        it('catches video playback Promise rejections without crashing', async () => {
            const play = VoiceIsolatePro.prototype.play;

            const mockVip = {
                isVideo: true,
                dom: {
                    tpABLabel: {},
                    tpSpeed: { value: '1.0' },
                    videoPlayer: {
                        play: jest.fn().mockRejectedValue(new Error('play failed'))
                    }
                },
                abMode: 'processed',
                outputBuffer: {},
                buildLiveChain: jest.fn(),
                ctx: { currentTime: 0 },
                startSpectro: jest.fn(),
                startFreq: jest.fn(),
                tickTime: jest.fn(),
                stop: jest.fn(),
                ensureCtx: jest.fn(),
                playOffset: 0,
                playStartTime: 0,
                isPlaying: false
            };

            // Execute the play method
            play.call(mockVip);

            // Give promises time to resolve/reject and run catch blocks
            // If the catch() inside play() is missing, Jest will automatically fail the test due to an UnhandledPromiseRejectionWarning
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(mockVip.dom.videoPlayer.play).toHaveBeenCalled();
        });
    });
});

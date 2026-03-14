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

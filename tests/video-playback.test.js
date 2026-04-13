/**
 * @jest-environment jsdom
 */

// Use require since the app.js is a script with a CommonJS fallback
// Note that app.js doesn't export the module correctly if we import it via module
// because it's configured as commonjs via module.exports
const fs = require('fs');
const path = require('path');

describe('Video Playback Error Handling', () => {
  let VoiceIsolatePro;
  let vip;

  beforeAll(async () => {
    // Setup minimal DOM for VoiceIsolatePro constructor
    document.body.innerHTML = `
      <div id="tab-gate"></div>
      <div id="tab-nr"></div>
      <div id="tab-eq"></div>
      <div id="tab-dyn"></div>
      <div id="tab-spec"></div>
      <div id="tab-adv"></div>
      <div id="tab-sep"></div>
      <div id="tab-out"></div>

      <div id="uploadZone"></div>
      <input type="file" id="fileInput" />
      <button id="fileBtn"></button>
      <button id="micBtn"></button>
      <span id="micLabel"></span>
      <div id="fileInfo"></div>
      <button id="processBtn"></button>
      <button id="reprocessBtn"></button>
      <button id="stopProcBtn"></button>
      <button id="saveOrigBtn"></button>
      <button id="saveProcBtn"></button>

      <div id="videoCard"></div>
      <video id="videoPlayer"></video>

      <button id="tpPlay"></button>
      <button id="tpPause"></button>
      <button id="tpStop"></button>
      <button id="tpRew"></button>
      <button id="tpFwd"></button>
      <span id="tpCur"></span>
      <span id="tpTotal"></span>
      <input type="range" id="tpSeek" />
      <input type="range" id="tpSpeed" value="1" />
      <button id="tpAB"></button>
      <span id="tpABLabel"></span>

      <div id="fileSpectroCard"></div>
      <span id="fsModeLbl"></span>
      <span id="fsProgress"></span>
      <button id="fsBtnAB"></button>
      <select id="fsColormap"></select>
      <canvas id="fsYAxis"></canvas>
      <div id="fsMain"></div>
      <canvas id="fsCanvas"></canvas>
      <canvas id="fsOverlay"></canvas>
      <canvas id="fsXAxis"></canvas>

      <div id="spectro3DContainer"></div>
      <canvas id="spectro3DCanvas"></canvas>
      <button id="spectro3DReset"></button>
      <canvas id="spectro2DCanvas"></canvas>

      <canvas id="waveOrigCanvas"></canvas>
      <canvas id="waveProcCanvas"></canvas>
      <canvas id="freqCanvas"></canvas>

      <div id="pipeFill"></div>
      <span id="pipeStage"></span>
      <span id="pipeDetail"></span>

      <span id="hSNR"></span>
      <span id="hDur"></span>
      <span id="hSR"></span>
      <span id="hCh"></span>
      <span id="hRMS"></span>
      <span id="hPeak"></span>
      <span id="hStatus"></span>

      <span id="stLatency"></span>
      <span id="stProcTime"></span>
      <span id="stVoices"></span>

      <div id="tooltip"></div>
    `;

    // Mock window AudioContext and others
    global.window = global.window || {};
    global.window.AudioContext = class {
      constructor() { this.state = 'running'; }
      createBufferSource() { return { playbackRate: { value: 1 }, start: jest.fn(), onended: null }; }
      createBiquadFilter() { return { frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 }, type: '' }; }
      createDynamicsCompressor() { return { threshold: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, knee: { value: 0 } }; }
      createGain() { return { gain: { value: 0 } }; }
      createAnalyser() { return { fftSize: 2048, getByteFrequencyData: jest.fn() }; }
      createBuffer() { return {}; }
      resume() { return Promise.resolve(); }
      get currentTime() { return 0; }
    };

    // Setup requestAnimationFrame
    global.requestAnimationFrame = jest.fn((cb) => {
        return 1;
    });

    // Setup THREE mock
    global.window.THREE = {
      Scene: class { add() {} set background(v) {} },
      Color: class { constructor() {} },
      PerspectiveCamera: class { position={set:jest.fn(),x:0,y:0,z:0}; lookAt=jest.fn(); },
      WebGLRenderer: class { setSize() {} setPixelRatio() {} render() {} },
      PlaneGeometry: class { rotateX() {} setAttribute() {} get attributes() { return { position: { count: 0 } }; } },
      BufferAttribute: class { constructor() {} },
      MeshBasicMaterial: class { constructor() {} },
      Mesh: class { constructor() {} },
      AmbientLight: class { constructor() {} },
    };

    // Setup Performance
    global.performance = { now: () => 0 };

    // Stub offsetHeight, offsetWidth etc to avoid jsdom errors with canvas
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }) });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 100 });

    global.HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
      fillRect: jest.fn(),
      fillText: jest.fn(),
      beginPath: jest.fn(),
      moveTo: jest.fn(),
      lineTo: jest.fn(),
      stroke: jest.fn(),
      createImageData: jest.fn(() => ({ data: [] })),
      putImageData: jest.fn(),
      clearRect: jest.fn(),
      measureText: jest.fn(() => ({ width: 10 }))
    }));

    // mock window.HTMLMediaElement
    window.HTMLMediaElement.prototype.pause = () => {};

    // Load code dynamically using eval
    const appJsCode = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
    const exportsObj = {};
    const moduleObj = { exports: exportsObj };

    const wrapper = new Function('module', 'exports', 'window', 'document', appJsCode);
    wrapper(moduleObj, exportsObj, global.window, global.document);
    VoiceIsolatePro = moduleObj.exports;
  });

  beforeEach(() => {
    // Silence console errors for smooth test output
    jest.spyOn(console, 'error').mockImplementation(() => {});
    vip = new VoiceIsolatePro();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should catch unhandled promise rejections when video playback fails', async () => {
    // We want to test the exact condition in play():
    // this.dom.videoPlayer.play().catch(() => {});

    // Set up app state
    vip.isVideo = true;
    vip.abMode = 'original';
    vip.inputBuffer = { duration: 10, numberOfChannels: 1, sampleRate: 44100 };

    // Mock the chain setup to avoid complex dependencies
    vip.buildLiveChain = jest.fn();
    vip.startSpectro = jest.fn();
    vip.startFreq = jest.fn();
    vip.startDiagnostics = jest.fn();
    vip.tickTime = jest.fn();
    vip.ensureCtx = jest.fn();
    vip.ctx = { currentTime: 0 };

    // This is the important part: mock play() to return a rejected promise
    // Without the .catch() in the source code, this would cause an UnhandledPromiseRejectionWarning
    const mockPlay = jest.fn().mockReturnValue(Promise.reject(new Error("NotAllowedError: play() failed because the user didn't interact with the document first.")));
    vip.dom.videoPlayer.play = mockPlay;

    // Spy on the console to see if the error is unhandled (it shouldn't be)
    const consoleSpy = jest.spyOn(console, 'error');

    // Execute
    // Note: We don't await because play() is synchronous, and the promise rejection happens asynchronously
    vip.play();

    // Wait a tick for promises to resolve/reject
    await new Promise(resolve => setTimeout(resolve, 0));

    // Assertions
    expect(mockPlay).toHaveBeenCalled();
    // The promise rejection should be swallowed by .catch(() => {})
    // so it should not result in console.error or an unhandled rejection
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(vip.isPlaying).toBe(true);
  });
});

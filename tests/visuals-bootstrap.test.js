const fs = require('fs');
const path = require('path');

const VISUALS_BOOT_PATH = path.join(__dirname, '..', 'public', 'app', 'visuals-bootstrap.js');
const INDEX_HTML_PATH   = path.join(__dirname, '..', 'public', 'app', 'index.html');
const VIP_FIXES_PATH    = path.join(__dirname, '..', 'public', 'app', 'vip-fixes.js');
const PREMIUM_VIS_PATH  = path.join(__dirname, '..', 'public', 'app', 'premium-visuals.js');
const APP_JS_PATH       = path.join(__dirname, '..', 'public', 'app', 'app.js');

describe('visuals-bootstrap.js — visualization driver', () => {
  let src;
  beforeAll(() => { src = fs.readFileSync(VISUALS_BOOT_PATH, 'utf8'); });

  test('file exists and is non-trivial', () => {
    expect(src.length).toBeGreaterThan(3000);
  });

  test('exposes VIP_VISUALS API on window', () => {
    expect(src).toContain('global.VIP_VISUALS');
    expect(src).toContain('drawStatic');
    expect(src).toContain('onTabActivated');
    expect(src).toContain('activateTab');
    expect(src).toContain('initPremium');
    expect(src).toContain('setViewMode');
    expect(src).toContain('getViewMode');
    expect(src).toContain('toggleFullscreen');
    expect(src).toContain('toggleMinimized');
    expect(src).toContain('cycleTab');
    expect(src).toContain('wireChrome');
    expect(src).toContain('start');
    expect(src).toContain('stop');
  });

  test('owns viz chrome wiring (tabs, gallery, fullscreen, minimize)', () => {
    expect(src).toContain('_wireTabBar');
    expect(src).toContain('_wireFullscreen');
    expect(src).toContain('_wireGalleryToggle');
    expect(src).toContain('_wireTabNav');
    expect(src).toContain('_wireMinimizeToggle');
    expect(src).toContain('viz-fullscreen');
    expect(src).toContain('viz-minimized');
    expect(src).toContain('vizTabScroll');
  });

  test('supports gallery show-all view mode', () => {
    expect(src).toContain('viz-gallery');
    expect(src).toContain('btnVizGallery');
    expect(src).toContain("mode === 'gallery'");
  });

  test('wires VisualizationEngine for clusters tab', () => {
    expect(src).toContain('VisualizationEngine');
    expect(src).toContain('diarCanvas');
  });

  test('handles mobile viewport resize and orientation changes', () => {
    expect(src).toContain('orientationchange');
    expect(src).toContain('_resizeVisibleCanvases');
  });

  test('listens for vip:fileLoaded, vip:playStarted, vip:playStopped, vip:processingDone', () => {
    expect(src).toContain("'vip:fileLoaded'");
    expect(src).toContain("'vip:playStarted'");
    expect(src).toContain("'vip:playStopped'");
    expect(src).toContain("'vip:processingDone'");
  });

  test('wires premium visualizers for aura, topo, swarm, liquid', () => {
    expect(src).toContain('VIP_initPulsingAura');
    expect(src).toContain('VIP_initTopographic3D');
    expect(src).toContain('VIP_initParticleSwarm');
    expect(src).toContain('VIP_initLiquidWaves');
  });

  test('premium-visuals.js exposes coordinator tick API (no internal RAF loops)', () => {
    const premium = fs.readFileSync(PREMIUM_VIS_PATH, 'utf8');
    expect(premium).toContain('tick');
    expect(premium).toContain('resize');
    expect(premium).not.toMatch(/rafId\s*=\s*requestAnimationFrame\(draw\)/);
  });

  test('uses VIP_INFERNO_LUT from visuals.js for spectrogram colors', () => {
    expect(src).toContain('VIP_INFERNO_LUT');
  });

  test('reads from window._vipPlayAnalyser', () => {
    expect(src).toContain('_vipPlayAnalyser');
  });

  test('owns a single RAF loop guarded by a running flag', () => {
    expect(src).toContain('requestAnimationFrame');
    expect(src).toContain('_running');
    // Single _loop function as the RAF callback
    expect(src.match(/function _loop/g) || []).toHaveLength(1);
    expect(src).toContain('handle.tick');
  });

  test('debounces ResizeObserver layout work to avoid feedback loops', () => {
    expect(src).toContain('_scheduleLayoutResize');
    expect(src).toContain('_resizePremiumContainers');
    expect(src).not.toMatch(/new ResizeObserver\(\(\) => \{\s*_resizeVisibleCanvases\(\);\s*_syncPremiumViz\(\)/);
  });

  test('caches waveform bases instead of redrawing full buffers every frame', () => {
    expect(src).toContain('_waveBaseCache');
    expect(src).toContain('_drawWaveformBase');
    expect(src).toContain('putImageData');
  });

  test('does NOT define any STFT/iSTFT or fetch — pure tap consumer', () => {
    expect(src).not.toMatch(/forwardSTFT|inverseSTFT/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe('visuals-bootstrap loading and event wiring', () => {
  test('index.html loads visuals-bootstrap.js after visuals.js + premium-visuals.js', () => {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    const visualsIdx        = html.indexOf('./visuals.js');
    const premiumIdx        = html.indexOf('./premium-visuals.js');
    const bootstrapIdx      = html.indexOf('./visuals-bootstrap.js');
    expect(visualsIdx).toBeGreaterThan(-1);
    expect(premiumIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeGreaterThan(visualsIdx);
    expect(bootstrapIdx).toBeGreaterThan(premiumIdx);
  });

  test('vip-fixes.js dispatches vip:playStarted with analyser detail', () => {
    const src = fs.readFileSync(VIP_FIXES_PATH, 'utf8');
    expect(src).toContain("'vip:playStarted'");
    expect(src).toContain('analyser: _analyser');
  });

  test('vip-fixes.js dispatches vip:playStopped on teardown', () => {
    const src = fs.readFileSync(VIP_FIXES_PATH, 'utf8');
    expect(src).toContain("'vip:playStopped'");
  });

  test('vip-fixes runPipeline guard does not fake vip:processingDone on every exit', () => {
    const src = fs.readFileSync(VIP_FIXES_PATH, 'utf8');
    const guard = src.match(/app\.runPipeline = async function[\s\S]*?_fixRunPipelineWrapped = true/);
    expect(guard).toBeTruthy();
    expect(guard[0]).not.toContain("'vip:processingDone'");
    expect(guard[0]).toContain('_updateProcessButtonsState');
  });

  test('vip-fixes.js routes playback through orchestrator workletNode when present', () => {
    const src = fs.readFileSync(VIP_FIXES_PATH, 'utf8');
    expect(src).toMatch(/_vipOrch\?\.workletNode|_vipOrch\.workletNode/);
    expect(src).toContain('_gainNode.connect(orchWorklet)');
  });

  test('vip-fixes.js taps an analyser node and exposes it on window._vipPlayAnalyser', () => {
    const src = fs.readFileSync(VIP_FIXES_PATH, 'utf8');
    expect(src).toContain('createAnalyser');
    expect(src).toContain('window._vipPlayAnalyser');
  });

  test('vip-fixes.js requires confirm before click-isolation triggers runPipeline', () => {
    const src = fs.readFileSync(VIP_FIXES_PATH, 'utf8');
    const isoBlock = src.match(/vip:isolationBandSet[\s\S]*?vip:isolationBandClear/);
    expect(isoBlock).toBeTruthy();
    expect(isoBlock[0]).toContain('_pendingIsolation');
    expect(isoBlock[0]).toContain('_showIsoConfirm');
    expect(isoBlock[0]).not.toMatch(/vip:isolationBandSet[\s\S]*?runPipeline\(\)/);
    expect(src).toContain('vizIsoConfirmBtn');
    expect(src).toContain('_applyPendingIsolation');
  });

  test('visual-click-isolation.js clears overlays when isolation is cancelled', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'visual-click-isolation.js'), 'utf8');
    expect(src).toContain('clearAllIsolationVisuals');
    expect(src).toContain("addEventListener('vip:isolationBandClear', clearAllIsolationVisuals)");
  });

  test('app.js dispatches vip:fileLoaded after onAudioLoaded', () => {
    const src = fs.readFileSync(APP_JS_PATH, 'utf8');
    expect(src).toContain("'vip:fileLoaded'");
  });

  test('app.js dispatches vip:processingDone after runPipeline success', () => {
    const src = fs.readFileSync(APP_JS_PATH, 'utf8');
    expect(src).toContain("'vip:processingDone'");
  });

  test('app.js startSpectro/stopSpectro delegate to VIP_VISUALS when present', () => {
    const src = fs.readFileSync(APP_JS_PATH, 'utf8');
    expect(src).toContain('window.VIP_VISUALS');
    expect(src).toMatch(/startSpectro\(\)[\s\S]*VIP_VISUALS\.start/);
    expect(src).toMatch(/stopSpectro\(\)[\s\S]*VIP_VISUALS\.stop/);
  });

  test('app.js wires playback analyser and dispatches vip:playStarted / vip:playStopped', () => {
    const src = fs.readFileSync(APP_JS_PATH, 'utf8');
    expect(src).toContain('_ensurePlaybackAnalyser');
    expect(src).toContain('_dispatchPlayStarted');
    expect(src).toContain('_dispatchPlayStopped');
    expect(src).toContain('window._vipPlayAnalyser');
    expect(src).toContain("'vip:playStarted'");
    expect(src).toContain("'vip:playStopped'");
  });

  test('visuals.js exposes VIP_drawStaticSpectrogram for pre-playback spectro preview', () => {
    const visualsPath = path.join(__dirname, '..', 'public', 'app', 'visuals.js');
    const src = fs.readFileSync(visualsPath, 'utf8');
    expect(src).toContain('VIP_drawStaticSpectrogram');
    expect(src).toContain('drawStaticSpectrogram');
  });

  test('visuals-bootstrap.js resolves analyser via bridge / app fallback', () => {
    const src = fs.readFileSync(VISUALS_BOOT_PATH, 'utf8');
    expect(src).toContain('function _getAnalyser');
    expect(src).toContain('_ensurePlaybackAnalyser');
    expect(src).toContain('VIP_drawStaticSpectrogram');
  });

  test('app.js delegates viz chrome to VIP_VISUALS.wireChrome', () => {
    const src = fs.readFileSync(APP_JS_PATH, 'utf8');
    expect(src).toContain('VIP_VISUALS.wireChrome');
  });

  test('index.html includes Show All gallery toggle', () => {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    expect(html).toContain('btnVizGallery');
    expect(html).toContain('data-viz-panel');
  });

  test('index.html includes horizontal tab scroll rail and viz minimize controls', () => {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    expect(html).toContain('viz-tab-rail');
    expect(html).toContain('vizTabScroll');
    expect(html).toContain('btnVizMinimize');
    expect(html).toContain('btnVizTabPrev');
    expect(html).toContain('btnVizTabNext');
    expect(html).toContain('vizCardBody');
  });
});

describe('visuals-bootstrap module evaluated in jsdom-like sandbox', () => {
  test('exposes VIP_VISUALS object with expected methods after IIFE runs', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    // Provide stubs the script references through the global namespace
    window.VIP_INFERNO_LUT = new Uint8ClampedArray(256 * 3);
    window.VIP_initPulsingAura   = () => ({ stop() {} });
    window.VIP_initTopographic3D = () => ({ stop() {} });
    window.VIP_initParticleSwarm = () => ({ stop() {} });
    window.VIP_initLiquidWaves   = () => ({ stop() {} });

    const src = fs.readFileSync(VISUALS_BOOT_PATH, 'utf8');
    window.eval(src);

    expect(window.VIP_VISUALS).toBeTruthy();
    expect(typeof window.VIP_VISUALS.drawStatic).toBe('function');
    expect(typeof window.VIP_VISUALS.onTabActivated).toBe('function');
    expect(typeof window.VIP_VISUALS.initPremium).toBe('function');
    expect(typeof window.VIP_VISUALS.start).toBe('function');
    expect(typeof window.VIP_VISUALS.stop).toBe('function');
    expect(typeof window.VIP_VISUALS.setViewMode).toBe('function');
    expect(typeof window.VIP_VISUALS.getViewMode).toBe('function');
    expect(typeof window.VIP_VISUALS.wireChrome).toBe('function');
    expect(typeof window.VIP_VISUALS.toggleFullscreen).toBe('function');
    expect(typeof window.VIP_VISUALS.activateTab).toBe('function');
  });
});

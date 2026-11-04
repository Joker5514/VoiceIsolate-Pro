/**
 * VIP-021 — Engineer Action Controls, Boundary Clamping, Preview, Spectrogram & Cancel Tests
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let ENGINEER_ACTIONS;
let normalizeEngineerAction;
let validateSelectionBounds;
let resolveActionParameterPlan;
let computeSpectrogramGrid;
let getParamSpec;

async function loadBrowserModule(relPath, ctx, cache = new Map()) {
  const fullPath = path.resolve(__dirname, '..', relPath);
  if (cache.has(fullPath)) return cache.get(fullPath);
  const src = fs.readFileSync(fullPath, 'utf8');
  const mod = new vm.SourceTextModule(src, { identifier: fullPath, context: ctx });
  cache.set(fullPath, mod);
  await mod.link(async (specifier) => {
    const resolved = specifier.startsWith('/src/')
      ? path.resolve(__dirname, '..', specifier.slice(1))
      : path.resolve(path.dirname(fullPath), specifier);
    const relResolved = path.relative(path.resolve(__dirname, '..'), resolved);
    return loadBrowserModule(relResolved, ctx, cache);
  });
  await mod.evaluate();
  return mod;
}

beforeAll(async () => {
  const contract = await import('../src/core/EngineerActionContract.js');
  ENGINEER_ACTIONS = contract.ENGINEER_ACTIONS;
  normalizeEngineerAction = contract.normalizeEngineerAction;
  validateSelectionBounds = contract.validateSelectionBounds;
  resolveActionParameterPlan = contract.resolveActionParameterPlan;
  computeSpectrogramGrid = contract.computeSpectrogramGrid;
  const schema = await import('../src/core/ParameterSchema.js');
  getParamSpec = schema.getParamSpec;
});

describe('VIP-021 — EngineerActionContract normalization & boundary clamping', () => {
  test('normalizes hyphenated and underscored action aliases across DOM and RegionActionPalette', () => {
    expect(normalizeEngineerAction('isolate')).toBe(ENGINEER_ACTIONS.ISOLATE);
    expect(normalizeEngineerAction('enhance')).toBe(ENGINEER_ACTIONS.ENHANCE);
    expect(normalizeEngineerAction('enhance_voice')).toBe(ENGINEER_ACTIONS.ENHANCE);
    expect(normalizeEngineerAction('reduce-noise')).toBe(ENGINEER_ACTIONS.REDUCE_NOISE);
    expect(normalizeEngineerAction('reduce_noise')).toBe(ENGINEER_ACTIONS.REDUCE_NOISE);
    expect(normalizeEngineerAction('boost-whisper')).toBe(ENGINEER_ACTIONS.BOOST_WHISPER);
    expect(normalizeEngineerAction('boost_whisper')).toBe(ENGINEER_ACTIONS.BOOST_WHISPER);
    expect(normalizeEngineerAction('preview')).toBe(ENGINEER_ACTIONS.PREVIEW);
    expect(normalizeEngineerAction('unknown_stub')).toBeNull();
    expect(normalizeEngineerAction(null)).toBeNull();
  });

  test('validateSelectionBounds clamps reversed and out-of-range timestamps and rejects invalid inputs', () => {
    const clamped = validateSelectionBounds(14.5, -2.0, 10.0);
    expect(clamped.ok).toBe(true);
    expect(clamped.startSec).toBe(0);
    expect(clamped.endSec).toBe(10);
    expect(clamped.startNorm).toBe(0);
    expect(clamped.endNorm).toBe(1);

    expect(validateSelectionBounds(0.2, 0.8, 0).ok).toBe(false);
    expect(validateSelectionBounds(0.2, 0.8, NaN).ok).toBe(false);
    expect(validateSelectionBounds(NaN, 1.0, 5.0).ok).toBe(false);

    const tiny = validateSelectionBounds(1.0, 1.002, 10.0);
    expect(tiny.ok).toBe(false);
    expect(tiny.reason).toMatch(/too short/i);
  });

  test('resolveActionParameterPlan produces schema-valid clamped targets and scope notes', () => {
    for (const action of ['enhance_voice', 'reduce_noise', 'boost_whisper']) {
      const plan = resolveActionParameterPlan(action);
      expect(plan.supported).toBe(true);
      expect(plan.kind).toBe('parameters');
      for (const [id, value] of Object.entries(plan.params)) {
        const spec = getParamSpec(id);
        expect(spec).toBeDefined();
        expect(value).toBeGreaterThanOrEqual(spec.min);
        expect(value).toBeLessThanOrEqual(spec.max);
      }
      expect(plan.scopeNote.length).toBeGreaterThan(10);
    }

    const reducePlan = resolveActionParameterPlan('reduce-noise');
    expect(reducePlan.liveMixImmediate).toContain('bgSuppress');
    expect(reducePlan.requiresReprocess).toContain('nrAmount');

    const unsupported = resolveActionParameterPlan('export_selection');
    expect(unsupported.supported).toBe(false);
    expect(unsupported.kind).toBe('unsupported');
  });
});

describe('VIP-021 — Real STFT Spectrogram Grid (deterministic, zoom-responsive)', () => {
  test('computeSpectrogramGrid is deterministic (zero Math.random noise) and localizes tone frequency', () => {
    const sr = 16000;
    const len = sr;
    const signal = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const freq = i < len / 2 ? 500 : 6000;
      signal[i] = 0.8 * Math.sin((2 * Math.PI * freq * i) / sr);
    }

    const cols = 32;
    const rows = 32;
    const g1 = computeSpectrogramGrid(signal, cols, rows, { startNorm: 0, endNorm: 1 });
    const g2 = computeSpectrogramGrid(signal, cols, rows, { startNorm: 0, endNorm: 1 });
    expect(Array.from(g1)).toEqual(Array.from(g2));

    const leftHighFreq = g1[2 * cols + 4];
    const leftLowFreq = g1[(rows - 3) * cols + 4];
    expect(leftLowFreq).toBeGreaterThan(leftHighFreq + 0.2);

    const rightHighFreq = g1[8 * cols + 28];
    const rightDcFreq = g1[(rows - 1) * cols + 28];
    expect(rightHighFreq).toBeGreaterThan(rightDcFreq + 0.2);

    const zoomed = computeSpectrogramGrid(signal, cols, rows, { startNorm: 0.55, endNorm: 0.95 });
    expect(zoomed[8 * cols + 4]).toBeGreaterThan(zoomed[(rows - 1) * cols + 4] + 0.2);
  });
});

describe('VIP-021 — Signal Canvas Integration: preview, locks, comparison modes & cancel', () => {
  let sandboxCtx;

  beforeEach(() => {
    jest.useFakeTimers();
    const listeners = new Map();
    class FakeCustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    }
    const win = {
      addEventListener: (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent: (ev) => {
        for (const fn of listeners.get(ev.type) || []) fn(ev);
      },
    };
    sandboxCtx = vm.createContext({
      window: win,
      CustomEvent: FakeCustomEvent,
      setTimeout,
      clearTimeout,
      console,
      Promise,
      Object,
      Number,
      Math,
      JSON,
      Set,
      Map,
      Array,
      Float32Array,
      Date,
      performance,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('preview action seeks to selection start, starts playback, and auto-pauses at selection end', async () => {
    const mod = await loadBrowserModule('public/app/lib/signal-canvas-integration.js', sandboxCtx);
    const { createSignalCanvasIntegration } = mod.namespace;
    const ops = [];
    const mockApp = {
      origBuffer: { duration: 10 },
      isPlaying: false,
      ctx: { state: 'running', resume: jest.fn() },
      dom: { tpSpeed: { value: '1' } },
      ensureCtx: jest.fn(),
      seekTo: jest.fn(),
      play: jest.fn(function play() { this.isPlaying = true; }),
      pause: jest.fn(function pause() { this.isPlaying = false; }),
      showNotification: jest.fn(),
      _getTransportDuration: () => 10,
      _provenance: { recordOperation: (op) => ops.push(op) },
    };
    sandboxCtx.window._vipApp = mockApp;

    const integration = createSignalCanvasIntegration({
      app: mockApp,
      sessionStore: { getState: () => ({ duration: 10 }), subscribe: () => () => {} },
    });
    integration.bind();

    const res = sandboxCtx.window.__vipEngineerProcessSelection({
      action: 'preview',
      startSec: 2.0,
      endSec: 3.5,
    });
    expect(res.ok).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockApp.seekTo).toHaveBeenCalledWith(0.2);
    expect(mockApp.play).toHaveBeenCalledTimes(1);
    expect(mockApp.isPlaying).toBe(true);
    expect(ops.some((o) => o.id === 'region-preview')).toBe(true);

    jest.advanceTimersByTime(1600);
    expect(mockApp.pause).toHaveBeenCalledTimes(1);
    expect(mockApp.isPlaying).toBe(false);
  });

  test('locked controls remain untouched during palette parameter actions and comparison mode switches cleanly', async () => {
    const mod = await loadBrowserModule('public/app/lib/signal-canvas-integration.js', sandboxCtx);
    const { createSignalCanvasIntegration } = mod.namespace;
    const sliderValues = { nrAmount: 20, bgSuppress: 15, whisperLift: 0, voiceTunnel: 0 };
    const locked = new Set(['bgSuppress']);
    let bridgeMode = 'processed';

    const mockApp = {
      origBuffer: { duration: 8 },
      abMode: 'processed',
      _getTransportDuration: () => 8,
      _isSliderLocked: (id) => locked.has(id),
      _setSliderUi: (id, val) => { sliderValues[id] = val; },
      _syncBridgeParams: jest.fn(),
      showNotification: jest.fn(),
      _bridge: {
        setComparisonMode: jest.fn((m) => {
          bridgeMode = m;
          return true;
        }),
      },
      _provenance: { recordOperation: jest.fn() },
    };
    sandboxCtx.window._vipApp = mockApp;

    const integration = createSignalCanvasIntegration({
      app: mockApp,
      sessionStore: { getState: () => ({ duration: 8 }), subscribe: () => () => {} },
    });
    integration.bind();

    const out = sandboxCtx.window.__vipEngineerProcessSelection({
      action: 'reduce_noise',
      startSec: 1,
      endSec: 4,
    });
    expect(out.ok).toBe(true);
    expect(out.locked).toEqual(['bgSuppress']);
    expect(sliderValues.bgSuppress).toBe(15);
    expect(sliderValues.nrAmount).toBe(70);

    expect(sandboxCtx.window.__vipSetComparisonMode('raw')).toBe(true);
    expect(bridgeMode).toBe('original');
    expect(sandboxCtx.window.__vipSetComparisonMode('removed')).toBe(true);
    expect(bridgeMode).toBe('removed');
    expect(sandboxCtx.window.__vipSetComparisonMode('processed')).toBe(true);
    expect(bridgeMode).toBe('processed');
  });

  test('palette parameter actions fall back to the session duration when transport is zero, and still refuse when no duration is known', async () => {
    const mod = await loadBrowserModule('public/app/lib/signal-canvas-integration.js', sandboxCtx);
    const { createSignalCanvasIntegration } = mod.namespace;
    const sliderValues = { whisperLift: 0, voiceTunnel: 0 };

    // No decoded buffers and a zero transport clock, exactly the state after
    // a workspace import that has not been decoded by the app: the session
    // store (importSource) holds the duration under transport.duration.
    const mockApp = {
      _getTransportDuration: () => 0,
      _isSliderLocked: () => false,
      _setSliderUi: (id, val) => { sliderValues[id] = val; },
      _syncBridgeParams: jest.fn(),
      showNotification: jest.fn(),
      _provenance: { recordOperation: jest.fn() },
    };
    sandboxCtx.window._vipApp = mockApp;

    const integration = createSignalCanvasIntegration({
      app: mockApp,
      sessionStore: { getState: () => ({ transport: { duration: 4 } }), subscribe: () => () => {} },
    });
    integration.bind();

    const out = sandboxCtx.window.__vipEngineerProcessSelection({
      action: 'enhance',
      startSec: 0.8,
      endSec: 2.0,
    });
    expect(out.ok).toBe(true);
    expect(out.applied).toEqual({ whisperLift: 6, voiceTunnel: 60 });
    expect(sliderValues.whisperLift).toBe(6);
    expect(sliderValues.voiceTunnel).toBe(60);

    // Guard preserved: with no duration anywhere, the action still refuses
    // instead of applying parameters against unknown bounds.
    const mockAppNoAudio = {
      ...mockApp,
      _setSliderUi: jest.fn(),
    };
    sandboxCtx.window._vipApp = mockAppNoAudio;
    const integrationNoAudio = createSignalCanvasIntegration({
      app: mockAppNoAudio,
      sessionStore: { getState: () => ({ transport: { duration: 0 } }), subscribe: () => () => {} },
    });
    integrationNoAudio.bind();
    const refused = sandboxCtx.window.__vipEngineerProcessSelection({
      action: 'enhance',
      startSec: 0.8,
      endSec: 2.0,
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/Import and decode/);
    expect(mockAppNoAudio._setSliderUi).not.toHaveBeenCalled();
  });
});

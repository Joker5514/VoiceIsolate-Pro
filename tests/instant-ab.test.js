/**
 * Instant A/B — Original is a sample-aligned PlaybackMixer lane beside the
 * processed graph, so a switch is a short gain crossfade on the running
 * transport: no stem reload, no source restart, no playhead loss, and no
 * extra "prepare" step before the switch is available.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const getAppCode = require('./helpers/get-app-code');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let PlaybackMixer;
let AB_CROSSFADE_TC;
let EngineerModeBridge;
let isTextEntry;
let BrowserAdapter;

beforeAll(async () => {
  ({ PlaybackMixer, AB_CROSSFADE_TC } = await import('../src/pipeline/PlaybackMixer.js'));
  ({ EngineerModeBridge } = await import('../src/pipeline/EngineerModeBridge.js'));
  ({ isTextEntry } = await import('../src/platform/isTextEntry.js'));
  ({ BrowserAdapter } = await import('../src/platform/browser/BrowserAdapter.js'));
});

/** Recording Web Audio mock: sources remember start(); params remember automation. */
function mockCtx() {
  const sources = [];
  const param = (value = 0) => ({
    value,
    events: [],
    setTargetAtTime(target, time, tc) { this.events.push({ type: 'target', target, time, tc }); },
    setValueAtTime(v) { this.value = v; },
    cancelScheduledValues() {},
    linearRampToValueAtTime() {},
  });
  const node = (extra = {}) => ({
    connections: [],
    connect(dest) { this.connections.push(dest); return dest; },
    disconnect() {},
    gain: param(1),
    ...extra,
  });
  const ctx = {
    state: 'running',
    currentTime: 1,
    sampleRate: 48000,
    destination: node(),
    sources,
    createGain: () => node(),
    createBiquadFilter: () => node({ frequency: param(0), Q: param(1), gain: param(0), type: '' }),
    createDynamicsCompressor: () => node({
      threshold: param(0), knee: param(0), ratio: param(1), attack: param(0), release: param(0),
    }),
    createAnalyser: () => node({ fftSize: 2048, frequencyBinCount: 1024 }),
    createDelay: () => node({ delayTime: param(0) }),
    createWaveShaper: () => node({ curve: null }),
    createChannelSplitter: () => node(),
    createChannelMerger: () => node(),
    createBuffer: (ch, len, sr) => {
      const data = Array.from({ length: ch }, () => new Float32Array(len));
      return {
        numberOfChannels: ch, length: len, duration: len / sr, sampleRate: sr,
        getChannelData: (c) => data[c],
        copyToChannel(src, c) { data[c].set(src); },
      };
    },
    createBufferSource: () => {
      const src = node({
        buffer: null, onended: null, started: null, stopped: false,
        start(when, offset, duration) { this.started = { when, offset, duration }; },
        stop() { this.stopped = true; },
      });
      sources.push(src);
      return src;
    },
    resume: async () => {},
    close: async () => {},
  };
  return ctx;
}

const SEC = 48000;
function loadedMixer() {
  const ctx = mockCtx();
  const mixer = new PlaybackMixer({ context: ctx });
  mixer.loadStems([new Float32Array(SEC * 4)], [new Float32Array(SEC * 4)], SEC);
  const reference = ctx.createBuffer(1, SEC * 4, SEC);
  return { ctx, mixer, reference };
}
const lastTarget = (p) => p.events[p.events.length - 1];

describe('PlaybackMixer comparison lanes', () => {
  test('processed lane is the default output; no lane sources without a reference', async () => {
    const { ctx, mixer } = loadedMixer();
    expect(mixer.getComparisonMode()).toBe('processed');
    expect(mixer._compare.processed.gain.value).toBe(1);
    expect(mixer._compare.original.gain.value).toBe(0);
    expect(mixer._compare.removed.gain.value).toBe(0);
    await mixer.play();
    expect(ctx.sources).toHaveLength(2); // clean + noise only
    expect(mixer.setComparisonMode('original')).toBe(false);
    expect(mixer.getComparisonMode()).toBe('processed');
  });

  test('Original and Removed lanes start on the same sample as the stems', async () => {
    const { ctx, mixer, reference } = loadedMixer();
    mixer.setComparisonReference(reference);
    await mixer.seek(1.25);
    await mixer.play();
    const [clean, noise, original, removed] = ctx.sources.slice(-4);
    expect(clean.buffer).toBe(mixer.cleanBuffer);
    expect(original.buffer).toBe(reference); // zero-copy reference
    expect(removed.buffer).toBe(mixer.noiseBuffer);
    for (const lane of [original, removed]) {
      expect(lane.started.when).toBeCloseTo(clean.started.when, 12);
      expect(lane.started.offset).toBeCloseTo(clean.started.offset, 12);
    }
    expect(noise.started.offset).toBeCloseTo(1.25, 12);
  });

  test('switching while playing is a ≤10 ms crossfade, never a source rebuild', async () => {
    const { ctx, mixer, reference } = loadedMixer();
    mixer.setComparisonReference(reference);
    await mixer.play();
    const before = ctx.sources.length;
    const cleanSource = mixer._cleanSource;
    ctx.currentTime += 0.5;
    const pos = mixer.currentTime();
    expect(pos).toBeGreaterThan(0.4);
    expect(mixer.setComparisonMode('original')).toBe(true);
    expect(ctx.sources).toHaveLength(before);
    expect(mixer._cleanSource).toBe(cleanSource);
    expect(mixer.isPlaying()).toBe(true);
    expect(mixer.currentTime()).toBe(pos); // playhead untouched
    const off = lastTarget(mixer._compare.processed.gain);
    const on = lastTarget(mixer._compare.original.gain);
    expect(off).toMatchObject({ target: 0, tc: AB_CROSSFADE_TC });
    expect(on).toMatchObject({ target: 1, tc: AB_CROSSFADE_TC });
    expect(on.time).toBe(ctx.currentTime);
    // 3τ (95%) inside 10 ms, but never a hard step.
    expect(3 * AB_CROSSFADE_TC).toBeLessThanOrEqual(0.01);
    expect(AB_CROSSFADE_TC).toBeGreaterThan(0);
    mixer.setComparisonMode('removed');
    expect(lastTarget(mixer._compare.original.gain).target).toBe(0);
    expect(lastTarget(mixer._compare.removed.gain).target).toBe(1);
  });

  test('idle switches snap so the next play starts on the chosen lane', () => {
    const { mixer, reference } = loadedMixer();
    mixer.setComparisonReference(reference);
    mixer.setComparisonMode('original');
    expect(mixer._compare.original.gain.value).toBe(1);
    expect(mixer._compare.processed.gain.value).toBe(0);
    expect(mixer._compare.original.gain.events).toHaveLength(0);
  });

  test('a reference set mid-playback joins the running transport sample-aligned', async () => {
    const { ctx, mixer, reference } = loadedMixer();
    await mixer.play();
    ctx.currentTime += 0.75;
    mixer.setComparisonReference(reference);
    const original = ctx.sources.find((s) => s.buffer === reference);
    expect(original).toBeTruthy();
    expect(original.started.offset).toBeCloseTo(original.started.when - mixer._startedAt, 12);
  });

  test('levels are attenuation only and clearing the reference returns to Processed', () => {
    const { mixer, reference } = loadedMixer();
    mixer.setComparisonReference(reference);
    mixer.setComparisonLevels({ original: 2.5, processed: 0.4, removed: -1 });
    expect(mixer.getComparisonLevels()).toEqual({ original: 1, processed: 0.4, removed: 0 });
    mixer.setComparisonMode('original');
    mixer.setComparisonReference(null);
    expect(mixer.getComparisonMode()).toBe('processed');
    expect(mixer._compare.processed.gain.value).toBeCloseTo(0.4);
  });

  test('lanes wait the graph latency so they line up with the processed output', () => {
    const { mixer } = loadedMixer();
    const expected = mixer.latencyFrames() / 48000;
    expect(mixer._compare.originalDelay.delayTime.value).toBeCloseTo(expected, 9);
    expect(mixer._compare.removedDelay.delayTime.value).toBeCloseTo(expected, 9);
  });

  test('stop/seek/pause tear the lane sources down with the stems', async () => {
    const { ctx, mixer, reference } = loadedMixer();
    mixer.setComparisonReference(reference);
    await mixer.play();
    const lanes = ctx.sources.slice(-2);
    mixer.pause();
    expect(lanes.every((s) => s.stopped)).toBe(true);
    expect(mixer._originalSource).toBeNull();
  });

  test('setComparisonReferenceAsync copies cooperatively and a newer call supersedes', async () => {
    const { mixer } = loadedMixer();
    const ch = [new Float32Array(SEC).fill(0.25)];
    const first = mixer.setComparisonReferenceAsync(ch, SEC);
    const second = mixer.setComparisonReferenceAsync(ch, SEC);
    expect(await first).toBeNull();
    const buf = await second;
    expect(buf.getChannelData(0)[100]).toBeCloseTo(0.25);
    expect(mixer.getComparisonReference()).toBe(buf);
  });
});

describe('EngineerModeBridge comparison API', () => {
  test('holds, switches and clears the Original reference', () => {
    const ctx = mockCtx();
    const bridge = new EngineerModeBridge({ context: ctx });
    const out = ctx.createBuffer(1, SEC, SEC);
    const input = ctx.createBuffer(1, SEC, SEC);
    bridge.loadBuffer(out);
    expect(bridge.holdsComparisonReference(input)).toBe(false);
    expect(bridge.setComparisonReference(input)).toBe(true);
    expect(bridge.holdsComparisonReference(input)).toBe(true);
    expect(bridge.setComparisonMode('original')).toBe(true);
    expect(bridge.getComparisonMode()).toBe('original');
    bridge.clearComparisonReference();
    expect(bridge.holdsComparisonReference(input)).toBe(false);
    expect(bridge.getComparisonMode()).toBe('processed');
  });
});

describe('Engineer app instant A/B', () => {
  let VoiceIsolatePro;
  beforeAll(() => {
    const safeCode = getAppCode().replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);/, '');
    VoiceIsolatePro = new Function('window', 'document', `${safeCode}; return VoiceIsolatePro;`)({}, {});
  });

  function armedApp(overrides = {}) {
    const input = { duration: 4, getChannelData: () => new Float32Array(4) };
    const output = { duration: 4, getChannelData: () => new Float32Array(4) };
    const bridge = {
      ref: input,
      mode: 'processed',
      playing: true,
      holdsComparisonReference(b) { return b === this.ref; },
      setComparisonMode: jest.fn(function (m) { this.mode = m; return true; }),
      isPlaying() { return this.playing; },
    };
    const app = Object.assign(Object.create(VoiceIsolatePro.prototype), {
      inputBuffer: input, outputBuffer: output, abMode: 'processed', isProcessing: false,
      isPlaying: true, _bridge: bridge, _bridgeBuf: output, play: jest.fn(),
      updateAudioMetrics: jest.fn(), _computeAudioMetricsState: () => null,
      dom: { tpAB: { classList: { toggle: jest.fn() }, setAttribute: jest.fn() }, tpABLabel: { textContent: '', dataset: {} } },
    }, overrides);
    return { app, bridge, input, output };
  }

  test('toggleAB crossfades on the bridge without restarting playback', () => {
    const { app, bridge } = armedApp();
    VoiceIsolatePro.prototype.toggleAB.call(app);
    expect(app.abMode).toBe('original');
    expect(bridge.setComparisonMode).toHaveBeenCalledWith('original');
    expect(app.play).not.toHaveBeenCalled();
    expect(app._bridgeBuf).toBe(app.outputBuffer); // the bridge keeps the processed stems
    expect(app.dom.tpABLabel.textContent).toBe('Original');
    VoiceIsolatePro.prototype.toggleAB.call(app);
    expect(bridge.mode).toBe('processed');
    expect(app.play).not.toHaveBeenCalled();
  });

  test('the bridge keeps holding the processed output while Original is selected', () => {
    const { app, output } = armedApp({ abMode: 'original' });
    expect(app._getBridgePlaybackBuffer()).toBe(output);
    expect(app._getPlaybackBuffer()).toBe(app.inputBuffer); // visuals/duration unchanged
  });

  test('falls back to the legacy restart while processing or before the lane is armed', () => {
    const processing = armedApp({ isProcessing: true });
    expect(processing.app._switchABInstant('original')).toBe(false);
    const unarmed = armedApp();
    unarmed.bridge.ref = null;
    expect(unarmed.app._switchABInstant('original')).toBe(false);
    // Bridge still playing the original buffer from before Process: one restart.
    const stale = armedApp();
    stale.app._bridgeBuf = stale.input;
    expect(stale.app._switchABInstant('original')).toBe(false);
  });
});

describe('A/B wiring (source contracts)', () => {
  const LANDING = read('public/landing.js');
  const INDEX = read('public/index.html');
  const FIXES = read('public/app/vip-fixes.js');
  const APP = read('public/app/app.js');
  const PREMIUM = read('public/landing-premium.js');

  test('Landing has no manual prepare step and arms A/B when stems land', () => {
    expect(INDEX).not.toMatch(/prepareComparisonBtn/);
    expect(LANDING).not.toMatch(/prepareComparison|Prepare matched A\/B|QuickCleanReview/);
    expect(LANDING).toMatch(/resetComparison\(\);[\s\S]*void armComparison\(current\)/);
  });

  test('Landing mix edits re-match levels in the background instead of disabling A/B', () => {
    expect(LANDING).toMatch(/input\[type="range"\][\s\S]{0,200}scheduleLevelMatch\(\)/);
    expect(LANDING).not.toMatch(/Mix changed\. Prepare/);
  });

  test('vip-fixes tries the instant crossfade before the restart fallback', () => {
    expect(FIXES).toMatch(/function _toggleAB[\s\S]*_switchABInstant\(next\)[\s\S]*restartAt\(pos\)/);
    expect(FIXES).toMatch(/app\.dom\.tpAB = freshAB/);
  });

  test('tpAB is enabled exactly when processed audio exists', () => {
    expect(FIXES).toMatch(/btn\.disabled = !\(app\.outputBuffer \|\| app\.procBuffer\)/);
    expect(APP).toMatch(/_setProcessedPlaybackMode\(\) \{[\s\S]*_armInstantAB\(\)/);
  });

  test('landing-premium initialises once (a double init made X toggle twice)', () => {
    expect(PREMIUM).toMatch(/unifiedWorkspaceStarted/);
    expect(PREMIUM).toMatch(/abToggle: \(\) => window\.dispatchEvent\(new CustomEvent\('vip:abToggle'\)\)/);
  });
});

describe('X shortcut focus rules', () => {
  test('isTextEntry only blocks typed-text targets', () => {
    expect(isTextEntry({ tagName: 'INPUT', type: 'range' })).toBe(false);
    expect(isTextEntry({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTextEntry({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEntry({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'number' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT' })).toBe(true);
    expect(isTextEntry({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  test('BrowserAdapter fires abToggle once from a slider, never from a text field', () => {
    const listeners = [];
    const prev = global.window;
    global.window = { addEventListener: (t, fn) => listeners.push(fn), removeEventListener() {} };
    try {
      const adapter = new BrowserAdapter(null, null);
      const abToggle = jest.fn();
      adapter.setupKeyboardShortcuts({ abToggle });
      const key = (target, extra = {}) => listeners.forEach((fn) => fn({
        key: 'x', code: 'KeyX', target: { matches: () => target.tagName === 'INPUT', ...target }, preventDefault() {}, ...extra,
      }));
      key({ tagName: 'INPUT', type: 'range' });
      expect(abToggle).toHaveBeenCalledTimes(1);
      key({ tagName: 'INPUT', type: 'text' });
      key({ tagName: 'BODY' }, { ctrlKey: true });
      expect(abToggle).toHaveBeenCalledTimes(1);
    } finally {
      global.window = prev;
    }
  });
});

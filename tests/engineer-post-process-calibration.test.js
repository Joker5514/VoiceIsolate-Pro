/**
 * Audit AI-001: post-Process auto-calibration reads the processed output, so
 * it may move only Live-Mix controls. Process-time controls must keep
 * describing the settings that produced the audio (and the next Reprocess).
 *
 * Runs the real `_applyPresetValues` / `_autoCalibratePreset` bodies from
 * app.js against the real presets and recommender.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public/app/app.js'), 'utf8');

function methodSource(name, signature) {
  const start = appSource.indexOf(`\n  ${name}(${signature}) {`);
  if (start < 0) throw new Error(`method ${name} not found`);
  const end = appSource.indexOf('\n  }\n', start);
  return appSource.slice(start + 1, end + 4);
}

let LIVE;
let PRESETS;
let recommendEngineerPreset;

beforeAll(async () => {
  ({ LIVE_MIX_PARAM_IDS: LIVE } = await import('../src/core/ParameterSchema.js'));
  ({ getCalibratedPresets: PRESETS } = await import('../src/core/PresetCalibration.js'));
  PRESETS = PRESETS();
  ({ recommendEngineerPreset } = await import('../src/core/MixCalibration.js'));
});

function buildHarness({ skipAuto = false, suggestions = {} } = {}) {
  const liveIds = new Set(LIVE);
  const known = new Set([...Object.values(PRESETS).flatMap(Object.keys), ...Object.keys(suggestions), 'nrAmount', 'outGain']);
  const byId = Object.fromEntries([...known].map((id) => [id, { id }]));
  const AI = {
    autoTuneParamsAsync: () => Promise.resolve({ suggestions }),
  };
  const factory = new Function(
    'PRESETS', 'BRIDGE_RT_SLIDER_IDS', 'SLIDER_REG_BY_ID', 'SLIDER_BY_ID', 'WorkflowTier',
    'recommendEngineerPreset', 'createYieldBudget', 'structuredLog', 'globalThis',
    `return class Harness {
      constructor() { this.writes = []; this.params = {}; this._fileSeq = 1; this._userTouchedSliders = new Set(); }
      _isSliderLocked() { return false; }
      _shouldPreserveSlider() { return false; }
      _setSliderUi(id, v) { this.writes.push(id); this.params[id] = v; return true; }
      _syncBridgeParams() {}
      showNotification() {}
      ${methodSource('_applyPresetValues', 'presetName, options = {}')}
      ${methodSource('_autoCalibratePreset', 'buffer')}
    };`,
  );
  const Harness = factory(
    PRESETS, liveIds, byId, byId,
    { shouldSkipAutoCalibrate: () => skipAuto, getDefaultPreset: () => 'Podcast Clean' },
    recommendEngineerPreset, () => ({}), () => {}, { AIIntelligence: AI },
  );
  return { app: new Harness(), liveIds };
}

function quietBuffer() {
  const ch = new Float32Array(48000);
  for (let i = 0; i < ch.length; i++) ch[i] = 0.002 * Math.sin(2 * Math.PI * 220 * i / 48000);
  return { numberOfChannels: 1, sampleRate: 48000, length: ch.length, getChannelData: () => ch };
}

describe('post-Process auto-calibration (AI-001)', () => {
  test('writes Live-Mix controls only, including scene auto-tune suggestions', async () => {
    const { app, liveIds } = buildHarness({ suggestions: { nrAmount: 90, outGain: -3 } });
    const buffer = quietBuffer();
    app.outputBuffer = buffer;
    const rec = app._autoCalibratePreset(buffer);
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.preset).toBeTruthy();
    expect(app.writes.length).toBeGreaterThan(0);
    expect(app.writes.filter((id) => !liveIds.has(id))).toEqual([]);
    expect(app.params.outGain).toBe(-3);
    expect(app.params.nrAmount).toBeUndefined();
  });

  test('the presets it applies do carry Process-time ids that must be skipped', () => {
    const { liveIds } = buildHarness();
    const processTime = Object.values(PRESETS).flatMap(Object.keys)
      .filter((id) => id !== 'description' && !liveIds.has(id));
    expect(processTime.length).toBeGreaterThan(0);
  });

  test('tier default-preset branch is filtered the same way', () => {
    const { app, liveIds } = buildHarness({ skipAuto: true });
    app._autoCalibratePreset(quietBuffer());
    expect(app.writes.length).toBeGreaterThan(0);
    expect(app.writes.filter((id) => !liveIds.has(id))).toEqual([]);
  });
});

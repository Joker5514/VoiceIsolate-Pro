/**
 * Live test t24u: Randy clicked Whisper Boost, then Process Now. The preset
 * dropdown stayed on "Podcast Clean", the Process-time snapshot logged
 * changedCount 0 / changed {}, and the Auto-calibrated mix log named
 * "Voice Clarity". This runs the real app.js method bodies against the real
 * calibrated presets:
 *   preset click -> Process-time controls change -> snapshot changedCount > 0
 *   -> dropdown shows the preset -> calibration names the preset.
 * Every preset button in public/app/index.html is checked, not only Whisper Boost.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public/app/app.js'), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(path.join(root, 'public/app/index.html'), 'utf8');

function methodSource(name, signature) {
  const start = appSource.indexOf(`\n  ${name}(${signature}) {`);
  if (start < 0) throw new Error(`method ${name}(${signature}) not found in app.js`);
  const end = appSource.indexOf('\n  }\n', start);
  return appSource.slice(start + 1, end + 4);
}

const buttonNames = [...html.matchAll(/class="btn btn-preset"[^>]*data-preset="([^"]+)"/g)].map((m) => m[1]);
const optionNames = [...html.match(/<select id="presetSel"[\s\S]*?<\/select>/)[0].matchAll(/<option>([^<]+)<\/option>/g)]
  .map((m) => m[1].replace('&amp;', '&'));

let S; // ParameterSchema
let PRESETS;
let recommendEngineerPreset;

beforeAll(async () => {
  S = await import('../src/core/ParameterSchema.js');
  const cal = await import('../src/core/PresetCalibration.js');
  PRESETS = cal.getCalibratedPresets();
  ({ recommendEngineerPreset } = await import('../src/core/MixCalibration.js'));
});

function fakeSelect(initial) {
  const options = optionNames.map((n) => ({ value: n, textContent: n }));
  return { options, value: initial, dispatched: 0, dispatchEvent() { this.dispatched += 1; } };
}

function buildHarness() {
  const liveIds = new Set(S.LIVE_MIX_PARAM_IDS);
  const known = new Set(Object.values(PRESETS).flatMap(Object.keys));
  const byId = Object.fromEntries([...known].map((id) => [id, { id }]));
  const logs = [];
  const factory = new Function(
    'PRESETS', 'BRIDGE_RT_SLIDER_IDS', 'SLIDER_REG_BY_ID', 'SLIDER_BY_ID', 'WorkflowTier',
    'recommendEngineerPreset', 'createYieldBudget', 'structuredLog', 'globalThis',
    'resolvePresetNameLocal', 'buildMlProcessingConfig', 'diffProcessingConfig', 'window',
    'WORKER_ONLY_SPECTRAL_IDS',
    `return class Harness {
      constructor() {
        this.params = {}; this._fileSeq = 1; this._userTouchedSliders = new Set();
        this._sliderLocks = new Set(); this.liveChainBuilt = false;
        this.dom = { presetSel: arguments[0] };
        this._lastProcessingConfig = null;
      }
      _isSliderLocked() { return false; }
      _shouldPreserveSlider(id) { return this._userTouchedSliders.has(id); }
      _setSliderUi(id, v) { this.params[id] = v; window.VIP_PARAMS[id] = v; return true; }
      _setWhisperMode() {}
      _syncBridgeParams() {}
      _scheduleSessionPersist() {}
      showNotification() {}
      getEffectiveParams(p) { return { ...p }; }
      // DSP-01: the real applyPreset/_applyPresetValues clear worker-only
      // params the incoming preset does not set. Same behavior as
      // public/app/app.js _clearWorkerOnlyParamsNotInPreset (the harness
      // must provide every method the extracted bodies call).
      _clearWorkerOnlyParamsNotInPreset(preset) {
        if (!preset) return;
        for (const id of WORKER_ONLY_SPECTRAL_IDS) {
          if (Object.prototype.hasOwnProperty.call(preset, id)) continue;
          if (window.VIP_PARAMS) delete window.VIP_PARAMS[id];
          if (this.params) delete this.params[id];
        }
      }
      ${methodSource('applyPreset', 'name, options = {}')}
      ${methodSource('_applyPresetValues', 'presetName, options = {}')}
      ${methodSource('_autoCalibratePreset', 'buffer')}
      ${methodSource('_processSnapshotDiff', 'processingConfig')}
    };`,
  );
  const win = { VIP_PARAMS: {} };
  const Harness = factory(
    PRESETS, liveIds, byId, byId,
    { shouldSkipAutoCalibrate: () => false, getDefaultPreset: () => 'Podcast Clean' },
    recommendEngineerPreset, () => ({}), (level, msg, data) => logs.push({ level, msg, data }), {},
    (n) => (PRESETS[n] ? n : 'Voice Clarity'), S.buildMlProcessingConfig, S.diffProcessingConfig, win,
    S.WORKER_ONLY_SPECTRAL_IDS,
  );
  const sel = fakeSelect('Podcast Clean');
  const app = new Harness(sel);
  return { app, sel, logs, win, liveIds };
}

function quietBuffer() {
  const ch = new Float32Array(48000);
  for (let i = 0; i < ch.length; i++) ch[i] = 0.004 * Math.sin(2 * Math.PI * 220 * i / 48000);
  return { numberOfChannels: 1, sampleRate: 48000, length: ch.length, getChannelData: () => ch };
}

describe('preset buttons map to presets and dropdown options', () => {
  test('all nine buttons are wired to a calibrated preset and a dropdown option', () => {
    expect(buttonNames).toHaveLength(9);
    for (const n of buttonNames) {
      expect(PRESETS[n]).toBeTruthy();
      expect(optionNames).toContain(n);
    }
    expect(appSource).toMatch(/qsa\('\.btn-preset'\)\.forEach\(b => \{\s*b\.addEventListener\('click', \(\) => this\.applyPreset\(b\.dataset\.preset, \{ source: 'user' \}\)\)/);
  });
});

describe('Whisper Boost click -> Process -> calibrate (t24u repro)', () => {
  test('dropdown shows Whisper Boost, snapshot has changes, calibration names Whisper Boost', async () => {
    const { app, sel, logs, win, liveIds } = buildHarness();
    // Tier default state: Podcast Clean applied at boot (not a user choice).
    app.applyPreset('Podcast Clean');
    app.applyPreset('Whisper Boost', { source: 'user' });
    expect(sel.value).toBe('Whisper Boost');
    expect(sel.dispatched).toBe(0); // syncing the dropdown must not re-fire change

    const cfg = S.buildMlProcessingConfig(app.getEffectiveParams(win.VIP_PARAMS));
    expect(cfg.spectral.whisperMode).toBe(PRESETS['Whisper Boost'].whisperMode);
    const diff = app._processSnapshotDiff(cfg);
    expect(diff.baseline).toBe('schema-defaults');
    expect(diff.preset).toBe('Whisper Boost');
    expect(diff.changedCount).toBeGreaterThan(0);
    expect(Object.keys(diff.changed).length).toBe(diff.changedCount);

    const before = { ...app.params };
    app.outputBuffer = quietBuffer();
    const rec = app._autoCalibratePreset(app.outputBuffer);
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.preset).toBe('Whisper Boost');
    expect(rec.recommended).toBeTruthy();
    // The user's preset Live-Mix values are kept, not replaced by the recommendation.
    for (const id of liveIds) if (id in before) expect(app.params[id]).toBe(before[id]);
    const line = logs.find((l) => l.msg === '[VIP] Auto-calibrated mix');
    expect(line.data.preset).toBe('Whisper Boost');
    expect(line.data.presetSource).toBe('user');
  });

  test('second Process diffs against the first one', () => {
    const { app, win } = buildHarness();
    app.applyPreset('Whisper Boost', { source: 'user' });
    app._processSnapshotDiff(S.buildMlProcessingConfig(win.VIP_PARAMS));
    const same = app._processSnapshotDiff(S.buildMlProcessingConfig(win.VIP_PARAMS));
    expect(same.baseline).toBe('previous-process');
    expect(same.changedCount).toBe(0);
  });

  test('without a user preset, calibration still applies its recommendation', () => {
    const { app, logs } = buildHarness();
    app.applyPreset('Podcast Clean'); // tier default, not a user click
    const rec = app._autoCalibratePreset(quietBuffer());
    expect(rec.preset).toBe(rec.recommended);
    expect(logs.find((l) => l.msg === '[VIP] Auto-calibrated mix').data.presetSource).toBe('calibration');
  });
});

describe('every preset button applies', () => {
  // LM Arena fix session 2 (LOCAL 2026-11-25): 'Room Echo Reduction' and
  // 'Aggressive Isolate' are disabled pending re-qualification — they are
  // covered by the refusal test below, not by this applies-everywhere list.
  test.each([
    'Voice Clarity', 'Podcast Clean', 'Forensic Extract', 'Whisper Boost', 'Phone/Radio',
    'Hum Removal', 'Surveillance',
  ])('%s: dropdown syncs and Process-time snapshot carries its values', (name) => {
    const { app, sel, win } = buildHarness();
    const other = name === 'Forensic Extract' ? 'Whisper Boost' : 'Forensic Extract';
    app.applyPreset(other, { source: 'user' });
    const first = S.buildMlProcessingConfig(win.VIP_PARAMS);
    app._processSnapshotDiff(first);
    app.applyPreset(name, { source: 'user' });
    expect(sel.value).toBe(name);
    const cfg = S.buildMlProcessingConfig(win.VIP_PARAMS);
    for (const [k, v] of Object.entries(cfg.spectral)) {
      if (k in PRESETS[name]) expect(v).toBe(S.buildMlProcessingConfig({ ...win.VIP_PARAMS, [k]: PRESETS[name][k] }).spectral[k]);
    }
    const diff = app._processSnapshotDiff(cfg);
    expect(diff.preset).toBe(name);
    expect(diff.changedCount).toBeGreaterThan(0);
  });

  // Session 2: an unacknowledged user pick of a disabled preset is refused
  // (dropdown and _userPresetName keep the previous preset); an explicit
  // manual-only acknowledgement applies it.
  test.each(['Room Echo Reduction', 'Aggressive Isolate'])(
    '%s: unacknowledged user pick is refused, acknowledged pick applies',
    (name) => {
      const { app, sel } = buildHarness();
      app.applyPreset('Forensic Extract', { source: 'user' });
      expect(sel.value).toBe('Forensic Extract');
      app.applyPreset(name, { source: 'user' });
      expect(sel.value).toBe('Forensic Extract');
      expect(app._userPresetName).toBe('Forensic Extract');
      app.applyPreset(name, { source: 'user', acknowledged: true });
      expect(sel.value).toBe(name);
      expect(app._userPresetName).toBe(name);
    },
  );
});

describe('programmatic applies clear the user pick (t26u follow-up)', () => {
  // Tier switch (workflow-tier.js applyTierPreset) and WhisperHunter
  // (app.js _runInternal) call applyPreset(name) with no source. The UI then
  // shows the new preset, so calibration must not keep the old pick's mix.
  test.each([['tier switch', 'Podcast Clean'], ['WhisperHunter auto-apply', 'Voice Clarity']])(
    '%s after a user pick clears _userPresetName',
    async (_label, next) => {
      const { app, sel, logs } = buildHarness();
      app.applyPreset('Whisper Boost', { source: 'user' });
      expect(app._userPresetName).toBe('Whisper Boost');
      app.applyPreset(next);
      expect(sel.value).toBe(next);
      expect(app._userPresetName).toBeNull();
      app.outputBuffer = quietBuffer();
      const rec = app._autoCalibratePreset(app.outputBuffer);
      await new Promise((r) => setTimeout(r, 0));
      expect(rec.presetSource).not.toBe('user');
      const line = logs.filter((l) => l.msg === '[VIP] Auto-calibrated mix').pop();
      expect(line.data.presetSource).not.toBe('user');
    },
  );

  test('a later user pick still wins', () => {
    const { app } = buildHarness();
    app.applyPreset('Podcast Clean');
    app.applyPreset('Surveillance', { source: 'user' });
    expect(app._userPresetName).toBe('Surveillance');
  });

  // Session 2: a later user pick of a DISABLED preset does not win — the
  // previous pick stands.
  test('a later user pick of a disabled preset does not win', () => {
    const { app } = buildHarness();
    app.applyPreset('Podcast Clean');
    app.applyPreset('Aggressive Isolate', { source: 'user' });
    expect(app._userPresetName).toBeNull();
  });
});

const getAppCode = require('./helpers/get-app-code');

const appJs = getAppCode();
let VoiceIsolatePro;
try {
  const safeCode = appJs.replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);/, '');
  VoiceIsolatePro = new Function('window', 'document', safeCode + '; return VoiceIsolatePro;')({}, {});
} catch (e) {
  throw new Error('Failed to load VoiceIsolatePro: ' + e.message);
}

describe('Slider preserve + lock', () => {
  let ctx;

  beforeEach(() => {
    ctx = Object.create(VoiceIsolatePro.prototype);
    ctx._userTouchedSliders = new Set();
    ctx._sliderLocks = new Set();
    ctx.params = { gateThresh: -42, outGain: 0 };
    ctx._sliderIndexById = new Map();
    ctx.onSlider = jest.fn();
    ctx._applySliderToWorklet = jest.fn();
    ctx._setWhisperMode = jest.fn();
  });

  test('_shouldPreserveSlider respects lock and user touch', () => {
    ctx._sliderLocks.add('gateThresh');
    expect(VoiceIsolatePro.prototype._shouldPreserveSlider.call(ctx, 'gateThresh')).toBe(true);
    ctx._sliderLocks.delete('gateThresh');
    ctx._userTouchedSliders.add('outGain');
    expect(VoiceIsolatePro.prototype._shouldPreserveSlider.call(ctx, 'outGain')).toBe(true);
    expect(VoiceIsolatePro.prototype._shouldPreserveSlider.call(ctx, 'eqMid')).toBe(false);
  });

  test('applyPreset skips locked sliders only', () => {
    ctx._sliderLocks.add('gateThresh');
    ctx._setSliderUi = jest.fn();
    ctx._syncBridgeParams = jest.fn();
    ctx.showNotification = jest.fn();
    VoiceIsolatePro.prototype.applyPreset.call(ctx, 'Voice Clarity');
    const touchedIds = ctx._setSliderUi.mock.calls.map((c) => c[0]);
    expect(touchedIds).not.toContain('gateThresh');
    expect(touchedIds.length).toBeGreaterThan(0);
  });

  test('_applyPresetValues respects user-touched sliders during auto-calibrate', () => {
    ctx._userTouchedSliders.add('outGain');
    ctx._setSliderUi = jest.fn();
    VoiceIsolatePro.prototype._applyPresetValues.call(ctx, 'Voice Clarity', { respectUserTouched: true });
    const touchedIds = ctx._setSliderUi.mock.calls.map((c) => c[0]);
    expect(touchedIds).not.toContain('outGain');
    expect(touchedIds).toContain('gateThresh');
  });
});

describe('BRIDGE_RT_SLIDER_IDS', () => {
  test('matches EngineerModeBridge PARAM_MAP count (34 live controls)', () => {
    const safeCode = appJs.replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);/, '');
    const fn = new Function('window', 'document', safeCode + '; return BRIDGE_RT_SLIDER_IDS;');
    const ids = fn({ BRIDGE_RT_SLIDER_IDS: undefined }, {});
    expect(ids.size).toBe(34);
    expect(ids.has('hpQ')).toBe(true);
    expect(ids.has('deEssFreq')).toBe(true);
    expect(ids.has('nrAmount')).toBe(false);
    expect(ids.has('whisperLift')).toBe(false);
  });
});
/**
 * Process-time Engineer configuration contract.
 *
 * Covers the canonical snapshot, cache revision, bridge parity, and the
 * classic-worker spectral hook without loading ONNX Runtime.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let Schema;
let EngineerModeBridge;
let stemCacheKey;
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public/app/app.js'), 'utf8');

beforeAll(async () => {
  Schema = await import('../src/core/ParameterSchema.js');
  ({ EngineerModeBridge } = await import('../src/pipeline/EngineerModeBridge.js'));
  ({ stemCacheKey } = await import('../src/pipeline/MLStemCache.js'));
});

function loadSpectralControlHelper() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src/workers/EngineerSpectralControls.js'),
    'utf8',
  );
  const self = {};
  vm.runInNewContext(source, {
    self,
    globalThis: self,
    Float32Array,
    Math,
    Number,
    Object,
  });
  return self;
}

describe('Engineer Process-time snapshot', () => {
  test('covers every non-Live-Mix spectral and post-stem consumer with finite bounded values', () => {
    const config = Schema.buildMlProcessingConfig({
      nrAmount: 999,
      phaseCorr: -100,
      ditherAmt: 8,
      whisperLift: 'not-a-number',
    });
    expect(config.version).toBe(Schema.ML_PROCESSING_CONFIG_VERSION);
    expect(config.revision).toMatch(/^emc1-/);
    expect(Object.keys(config.spectral).sort()).toEqual([...Schema.ML_SPECTRAL_PARAM_IDS].sort());
    expect(Object.keys(config.postStem).sort()).toEqual([...Schema.ML_POST_STEM_PARAM_IDS].sort());
    expect(Object.keys(config.export).sort()).toEqual([...Schema.EXPORT_PARAM_IDS].sort());
    expect(config.spectral.nrAmount).toBe(100);
    expect(config.postStem.phaseCorr).toBe(0);
    expect(config.export.ditherAmt).toBe(3);
    expect(config.spectral.whisperLift).toBe(0);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.spectral)).toBe(true);
  });

  test('stem revision changes only when a Process-time stem control changes', () => {
    const base = Schema.buildMlProcessingConfig({ nrAmount: 40, outGain: 0 });
    const liveOnly = Schema.buildMlProcessingConfig({ nrAmount: 40, outGain: 12 });
    const changed = Schema.buildMlProcessingConfig({ nrAmount: 45, outGain: 0 });
    expect(liveOnly.revision).toBe(base.revision);
    expect(changed.revision).not.toBe(base.revision);
    const channel = [new Float32Array([0.1, 0.2, 0.3])];
    expect(stemCacheKey(channel, 48000, ['bsrnn_vocals'], 'clip.wav', changed.revision))
      .not.toBe(stemCacheKey(channel, 48000, ['bsrnn_vocals'], 'clip.wav', base.revision));
  });

  test('canonical Live-Mix IDs exactly match the bridge and schema metadata', () => {
    expect(new Set(EngineerModeBridge.supportedIds())).toEqual(new Set(Schema.LIVE_MIX_PARAM_IDS));
    const specs = new Map(Schema.PARAMETER_SCHEMA.map((spec) => [spec.id, spec]));
    for (const id of Schema.LIVE_MIX_PARAM_IDS) {
      expect(specs.get(id)?.rt).toBe(true);
      expect(specs.get(id)?.path).toBe('audioParam');
    }
    expect(Schema.LIVE_MIX_PARAM_IDS).not.toContain('nrAmount');
    expect(Schema.ML_SPECTRAL_PARAM_IDS).toContain('nrAmount');
    expect(Schema.LIVE_MIX_PARAM_IDS).not.toContain('subHarmonic');
    expect(Schema.ML_SPECTRAL_PARAM_IDS).toContain('subHarmonic');
  });
});

describe('Engineer spectral worker helper', () => {
  test('sanitizes the wire shape and changes masked bins without a second STFT', () => {
    const helper = loadSpectralControlHelper();
    const low = Schema.buildMlProcessingConfig({ nrAmount: 0, crowdNull: 0, bassCrush: 0 });
    const high = Schema.buildMlProcessingConfig({ nrAmount: 100, crowdNull: 0, bassCrush: 0 });
    const geometry = { fftSize: 16, hop: 4, bins: 9, sampleRate: 48000 };
    const source = new Float32Array([1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]);
    const lowRe = new Float32Array(source);
    const highRe = new Float32Array(source);
    const lowProcessor = helper.createEngineerFrameProcessor(low, geometry);
    const highProcessor = helper.createEngineerFrameProcessor(high, geometry);
    expect(lowProcessor.revision).toBe(low.revision);
    expect(highProcessor.revision).toBe(high.revision);
    lowProcessor.applyFrame(lowRe, new Float32Array(9), source, 0);
    highProcessor.applyFrame(highRe, new Float32Array(9), source, 0);
    const total = (values) => values.reduce((sum, value) => sum + Math.abs(value), 0);
    expect(total(highRe)).toBeLessThan(total(lowRe));
    expect(helper.createEngineerFrameProcessor({ version: 0 }, geometry)).toBeNull();
  });

  test('maps +/-12 semitones as octave envelope moves while preserving bin phase', () => {
    const helper = loadSpectralControlHelper();
    const geometry = { fftSize: 16, hop: 4, bins: 9, sampleRate: 1600 };
    const values = {
      nrAmount: 0,
      nrSpectralSub: 0,
      nrFloor: -120,
      nrSmoothing: 0,
      voiceFocusLo: 50,
      voiceFocusHi: 16000,
    };
    const makeFrame = () => ({
      re: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      im: Float32Array.from([0.2, -0.6, 1.1, -1.4, 1.8, -2.1, 2.5, -2.8, 3.2]),
    });
    const magnitude = (re, im, index) => Math.hypot(re[index], im[index]);
    const phase = (re, im, index) => Math.atan2(im[index], re[index]);

    const up = makeFrame();
    const upMagnitude = Float32Array.from(up.re, (value, index) => Math.hypot(value, up.im[index]));
    const upPhase = Array.from(up.re, (_value, index) => phase(up.re, up.im, index));
    helper.createEngineerFrameProcessor(
      Schema.buildMlProcessingConfig({ ...values, formantShift: 12 }),
      geometry,
    ).applyFrame(up.re, up.im, upMagnitude, 0);
    expect(magnitude(up.re, up.im, 4)).toBeCloseTo(upMagnitude[2], 5);
    upPhase.forEach((value, index) => expect(phase(up.re, up.im, index)).toBeCloseTo(value, 5));

    const down = makeFrame();
    const downMagnitude = Float32Array.from(down.re, (value, index) => Math.hypot(value, down.im[index]));
    helper.createEngineerFrameProcessor(
      Schema.buildMlProcessingConfig({ ...values, formantShift: -12 }),
      geometry,
    ).applyFrame(down.re, down.im, downMagnitude, 0);
    expect(magnitude(down.re, down.im, 2)).toBeCloseTo(downMagnitude[4], 5);
  });
});

describe('Engineer result lifecycle safeguards', () => {
  test('fresh and durable ML paths both transform cloned raw stems through the same cleanup', () => {
    expect(appSource).toContain('let clean = durable.clean.map((channel) => new Float32Array(channel));');
    expect(appSource).toContain('let clean = result.clean.map((channel) => new Float32Array(channel));');
    expect(appSource).toContain('await this._applyPostIsolationCleanup(clean, durable.sampleRate || buf.sampleRate);');
    expect(appSource).toContain('await this._applyPostIsolationCleanup(clean, result.sampleRate || buf.sampleRate);');
    expect(appSource).toContain('const durableClean = result.clean;');
  });

  test('DSP fallback invalidates a prior ML stem pair before producing a new buffer', () => {
    const start = appSource.indexOf('async _runFallbackPipeline(sourceBuf)');
    const end = appSource.indexOf('\n  _applyOutputSafetyLimit(', start);
    const fallback = appSource.slice(start, end);
    expect(fallback).toContain('this._cleanStemChannels = null;');
    expect(fallback).toContain('this._noiseStemChannels = null;');
    expect(fallback).toContain('this._stemProcessingRevision = null;');
    expect(fallback).toContain('this._bridgeBuf = null;');
  });

  test('Whisper Mode shares normal control state, persistence, reset, and accessibility paths', () => {
    const renderStart = appSource.indexOf('_renderWhisperModeGroup()');
    const renderEnd = appSource.indexOf('\n  _getSliderPanelId(', renderStart);
    const render = appSource.slice(renderStart, renderEnd);
    const setStart = appSource.indexOf('_setWhisperMode(mode');
    const setEnd = appSource.indexOf('\n  /** Wait for an in-flight pipeline', setStart);
    const setMode = appSource.slice(setStart, setEnd);
    expect(render).toContain('this._setWhisperMode(m.id);');
    expect(render).toContain('whisper-mode-reset');
    expect(render).toContain("aria-pressed");
    expect(setMode).toContain('this.sharedParams[idx] = m;');
    expect(setMode).toContain('this._scheduleSessionPersist();');
    expect(appSource).toMatch(/_setSliderUi\(id, rawValue[\s\S]*?if \(changed\) this\._scheduleSessionPersist\(\);/);
  });
});

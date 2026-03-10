/**
 * VoiceIsolate Pro — Slider Wiring Tests (Phase 6)
 * Verifies that all 52 slider IDs have corresponding DSP references in app.js
 */

const fs = require('fs');
const path = require('path');

const appJsPath = path.join(__dirname, '../public/app/app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

// Extract slider IDs only from the SLIDERS constant block
const slidersBlockMatch = appJs.match(/const SLIDERS = \{([\s\S]*?)\};\s*\n\/\/ ---- PRESETS/);
const slidersBlock = slidersBlockMatch ? slidersBlockMatch[1] : appJs;
const sliderIdRegex = /id:'(\w+)'/g;
const sliderIds = [];
let m;
while ((m = sliderIdRegex.exec(slidersBlock)) !== null) {
  sliderIds.push(m[1]);
}

describe('SLIDERS definition', () => {
  test('Should define exactly 52 sliders', () => {
    expect(sliderIds.length).toBe(52);
  });

  test('All sliders should have unique IDs', () => {
    const unique = new Set(sliderIds);
    expect(unique.size).toBe(sliderIds.length);
  });
});

describe('Slider DSP wiring', () => {
  // Critical sliders that were previously unwired — now all must appear in processing code
  const criticalSliders = [
    'bgSuppress',
    'crosstalkCancel',
    'formantShift',
    'phaseCorr',
    'ditherAmt',
    'derevAmt',
    'derevDecay',
    'nrSensitivity',
    'nrSpectralSub',
    'voiceFocusLo',
    'voiceFocusHi',
  ];

  criticalSliders.forEach(id => {
    test(`Slider '${id}' should appear in DSP processing code`, () => {
      // Check it's referenced in processing functions (not just the SLIDERS definition)
      const occurrences = (appJs.match(new RegExp(`p\\.${id}|params\\.${id}|p\\['${id}'\\]`, 'g')) || []).length;
      expect(occurrences).toBeGreaterThan(0);
    });
  });

  test('applySpectralNR should exist (replaced applyNR stub)', () => {
    expect(appJs).toContain('applySpectralNR');
  });

  test('applyBgSuppress should exist', () => {
    expect(appJs).toContain('applyBgSuppress');
  });

  test('applyDereverb should exist', () => {
    expect(appJs).toContain('applyDereverb');
  });

  test('applyFormantShift should exist', () => {
    expect(appJs).toContain('applyFormantShift');
  });

  test('applyPhaseCorr should exist', () => {
    expect(appJs).toContain('applyPhaseCorr');
  });

  test('applyCrosstalkCancel should exist', () => {
    expect(appJs).toContain('applyCrosstalkCancel');
  });

  test('applyDither should exist', () => {
    expect(appJs).toContain('applyDither');
  });
});

describe('STFT engine', () => {
  test('_fft method should be defined', () => {
    expect(appJs).toContain('_fft(re, im)');
  });

  test('_ifft method should be defined', () => {
    expect(appJs).toContain('_ifft(re, im)');
  });

  test('_makeWindow should be defined', () => {
    expect(appJs).toContain('_makeWindow(N)');
  });

  test('Blackman-Harris coefficients should be present', () => {
    expect(appJs).toContain('0.35875');
    expect(appJs).toContain('0.48829');
  });
});

describe('AudioWorklet registration', () => {
  test('dsp-worker.js should be referenced in ensureCtx', () => {
    expect(appJs).toContain("addModule('./dsp-worker.js')");
  });
});

describe('ONNX / VAD', () => {
  test('loadModels method should be defined', () => {
    expect(appJs).toContain('async loadModels()');
  });

  test('runVAD method should be defined', () => {
    expect(appJs).toContain('async runVAD(buf)');
  });
});

describe('ML Worker (Phase 4b)', () => {
  const fs = require('fs');
  const path = require('path');
  const mlWorkerPath = path.resolve(__dirname, '..', 'public/app/ml-worker.js');
  const mlWorkerJs = fs.existsSync(mlWorkerPath) ? fs.readFileSync(mlWorkerPath, 'utf8') : '';

  test('ml-worker.js file exists', () => {
    expect(fs.existsSync(mlWorkerPath)).toBe(true);
  });

  test('app.js spawns ML Worker with _spawnMlWorker', () => {
    expect(appJs).toContain('_spawnMlWorker()');
  });

  test('app.js creates Worker at correct path', () => {
    expect(appJs).toContain("new Worker('./ml-worker.js')");
  });

  test('app.js has _mlCall promise helper', () => {
    expect(appJs).toContain('_mlCall(payload, transfer)');
  });

  test('app.js has _onMlMessage router', () => {
    expect(appJs).toContain('_onMlMessage(msg)');
  });

  test('app.js runSeparation delegates to ML Worker', () => {
    expect(appJs).toContain('async runSeparation(buf, model');
  });

  test('ml-worker loads ORT via importScripts', () => {
    expect(mlWorkerJs).toContain('importScripts');
  });

  test('ml-worker handles runVAD message', () => {
    expect(mlWorkerJs).toContain("case 'runVAD':");
  });

  test('ml-worker handles runSeparation message', () => {
    expect(mlWorkerJs).toContain("case 'runSeparation':");
  });

  test('ml-worker handles runVocoder message', () => {
    expect(mlWorkerJs).toContain("case 'runVocoder':");
  });

  test('ml-worker handles loadModel message', () => {
    expect(mlWorkerJs).toContain("case 'loadModel':");
  });

  test('ml-worker supports all 6 model keys', () => {
    ['vad', 'demucs', 'bsrnn', 'ecapa', 'hifigan', 'conformer'].forEach(m => {
      expect(mlWorkerJs).toContain(`'${m}'`);
    });
  });

  test('ml-worker uses transferable ArrayBuffers for large results', () => {
    expect(mlWorkerJs).toContain('[separated.buffer]');
  });
});

describe('Forensic mode', () => {
  test('addAuditEntry method should be defined', () => {
    expect(appJs).toContain('async addAuditEntry(buf, stageName)');
  });

  test('downloadAuditLog method should be defined', () => {
    expect(appJs).toContain('downloadAuditLog()');
  });

  test('SHA-256 should use crypto.subtle.digest', () => {
    expect(appJs).toContain("crypto.subtle.digest('SHA-256'");
  });

  test('forensicLog array should be initialized in constructor', () => {
    expect(appJs).toContain('this.forensicLog = []');
  });
});

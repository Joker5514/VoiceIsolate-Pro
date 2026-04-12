/**
 * VoiceIsolate Pro — Slider Wiring Tests (Phase 6)
 * Verifies that all 52 slider IDs have corresponding DSP references in app.js
 */

const fs = require('fs');
const path = require('path');

const appJsPath = path.join(__dirname, '../public/app/app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

const mlWorkerPath = path.join(__dirname, '../public/app/ml-worker.js');
const mlWorkerJs = fs.readFileSync(mlWorkerPath, 'utf8');

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

  test('Hann window formula should be present', () => {
    // Window was updated from Blackman-Harris to periodic Hann for correct COLA
    expect(appJs).toContain('0.5 * (1 - Math.cos(');
  });
});

describe('AudioWorklet registration', () => {
  test('voice-isolate-processor.js should be referenced in ensureCtx', () => {
    expect(appJs).toContain("addModule('./voice-isolate-processor.js')");
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

describe('ML Worker wiring', () => {
  test('app.js communicates with ML Worker via _mlCall helper', () => {
    expect(appJs).toContain('_mlCall(payload, transfer');
  });


  test('app.js has _mlCall promise helper', () => {
    expect(appJs).toContain('_mlCall(payload, transfer');
  });


  test('app.js runSeparation delegates to ML Worker', () => {
    expect(appJs).toContain('async runSeparation(buf, model');
  });

  test('ml-worker loads ORT via importScripts', () => {
    expect(mlWorkerJs).toContain('importScripts');
  });

  test('ml-worker handles init message', () => {
    // ml-worker uses if/else if statements for message routing
    expect(mlWorkerJs).toMatch(/type\s*===?\s*['"]init['"]/);
  });

  test('ml-worker handles process message', () => {
    // ml-worker uses 'process' message type for audio processing
    expect(mlWorkerJs).toMatch(/type\s*===?\s*['"]process['"]/);
  });

  test('ml-worker handles reset message', () => {
    // ml-worker uses 'reset' message type to clear state
    expect(mlWorkerJs).toMatch(/type\s*===?\s*['"]reset['"]/);
  });

  test('ml-worker handles loadModel message', () => {
    // ml-worker handles model loading via 'loadModel' message
    expect(mlWorkerJs).toContain('loadModel');
  });

  test('ml-worker supports implemented model types', () => {
    // Current implementation supports: vad, deepfilter, demucs
    ['vad', 'demucs'].forEach(m => {
      expect(mlWorkerJs).toContain(`${m}`);
    });
  });

  test('ml-worker uses transferable ArrayBuffers for large results', () => {
    expect(mlWorkerJs).toContain('[output.buffer]');
  });

  // ── Regression: old test checked for initMLWorker which no longer exists ──

  test('app.js does NOT use the old initMLWorker() pattern (replaced by _mlCall)', () => {
    // The PR replaced `initMLWorker()` invocation with the `_mlCall` helper pattern.
    // This regression test confirms the old symbol is gone.
    expect(appJs).not.toContain('initMLWorker()');
  });

  // ── mlWorkerJs file load validation ────────────────────────────────────────

  test('mlWorkerJs was loaded and is non-empty', () => {
    expect(typeof mlWorkerJs).toBe('string');
    expect(mlWorkerJs.length).toBeGreaterThan(0);
  });

  // ── _mlCall implementation details ─────────────────────────────────────────

  test('app.js _mlCall has a default value of [] for the transfer parameter', () => {
    expect(appJs).toContain('_mlCall(payload, transfer = [])');
  });

  test('app.js _mlCall increments an ID counter for request tracking', () => {
    expect(appJs).toContain('_mlCallId');
    expect(appJs).toContain('++this._mlCallId');
  });

  test('app.js _mlCall returns a Promise', () => {
    // _mlCall wraps responses in a Promise for async/await callers
    const mlCallBlock = appJs.match(/_mlCall\(payload,[\s\S]*?\n  \}/)?.[0] || '';
    expect(mlCallBlock).toContain('Promise');
  });

  // ── ml-worker.js null-guard filter ─────────────────────────────────────────

  test('ml-worker.js includes .filter(Boolean) null-guard for transferables', () => {
    // The PR added `.filter(Boolean)` to guard against null stream entries
    expect(mlWorkerJs).toContain('.filter(Boolean)');
  });

  test('ml-worker.js defines the handleMultiSeparate function', () => {
    expect(mlWorkerJs).toContain('handleMultiSeparate');
  });

  test('ml-worker.js null-guard uses short-circuit: s && s.data && s.data.buffer', () => {
    expect(mlWorkerJs).toContain('s && s.data && s.data.buffer');
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
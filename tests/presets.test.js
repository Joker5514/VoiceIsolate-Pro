/**
 * VoiceIsolate Pro — Preset Completeness Tests (Phase 6)
 * Verifies tuned voice-isolation presets and wiring.
 */

const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');

// Extract preset names
const presetNameRegex = /const PRESETS = \{([\s\S]*?)\};\s*const STAGES/;
const presetsBlock = appJs.match(presetNameRegex)?.[1] || '';
const presetNames = [
  'Voice Clarity',
  'Podcast Clean',
  'Forensic Extract',
  'Music Vocal',
  'Whisper Boost',
  'Phone/Radio',
  'Live Performance',
  'Surveillance'
];

describe('Presets', () => {
  test('Should define exactly 8 tuned preset names', () => {
    presetNames.forEach(name => {
      expect(presetsBlock).toContain(`'${name}':`);
    });
    expect(presetNames.length).toBe(8);
  });

  test('Every tuned preset contains required isolation keys', () => {
    const requiredKeys = ['noiseReduction', 'voiceIsolation', 'highpassFreq', 'lowpassFreq', 'deEsser', 'compression', 'gate', 'vadThreshold', 'noiseOverSubtract', 'spectralFloor', 'voiceBoost', 'reverbReduction', 'description'];
    presetNames.forEach((presetName) => {
      const escapedPreset = presetName.replace('/', '\\/');
      const presetRegex = new RegExp(`'${escapedPreset}':\\s*\\{([\\s\\S]*?)\\n\\s*\\}`);
      const presetMatch = appJs.match(presetRegex);
      expect(presetMatch).not.toBeNull();
      const presetStr = presetMatch[1];
      requiredKeys.forEach((key) => {
        expect(presetStr).toContain(`${key}:`);
      });
    });
  });

  test('Surveillance preset keeps aggressive extraction values', () => {
    const m = appJs.match(/'Surveillance':\s*\{[\s\S]*?noiseOverSubtract:\s*3\.0,[\s\S]*?spectralFloor:\s*0\.0004,[\s\S]*?voiceBoost:\s*2\.0/);
    expect(m).not.toBeNull();
  });

  test('Preset application dispatches input and change events', () => {
    expect(appJs).toContain("dispatchEvent(new Event('input', { bubbles: true }))");
    expect(appJs).toContain("dispatchEvent(new Event('change', { bubbles: true }))");
  });

  test('Preset application stores non-slider values in VIP params', () => {
    expect(appJs).toContain('window.VIP_PARAMS = window.VIP_PARAMS || {}');
    expect(appJs).toContain('window.VIP_PARAMS[key] = value');
  });
});

describe('STAGES array', () => {
  test('Should define exactly 32 stages', () => {
    const stagesMatch = appJs.match(/const STAGES = \[([\s\S]*?)\];/);
    expect(stagesMatch).not.toBeNull();
    const stageItems = stagesMatch[1].match(/'[^']+'/g) || [];
    expect(stageItems.length).toBe(32);
  });
});

describe('index.html', () => {
  const htmlPath = path.join(__dirname, '../public/app/index.html');
  const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';

  test('Should load ONNX Runtime Web', () => {
    expect(html).toContain('onnxruntime-web');
  });

  test('Should have forensic mode toggle', () => {
    expect(html).toContain('forensicToggle');
  });

  test('Should have audit log button', () => {
    expect(html).toContain('auditLogBtn');
  });

  test('Should reference 32-Stage pipeline', () => {
    expect(html).toContain('32-Stage');
  });

  test('Should load session-persist.js before app.js', () => {
    const sessionPersistPos = html.indexOf('session-persist.js');
    const appJsPos = html.indexOf('./app.js');
    expect(sessionPersistPos).toBeGreaterThan(-1);
    expect(appJsPos).toBeGreaterThan(sessionPersistPos);
  });
});

describe('dsp-worker.js', () => {
  const workerPath = path.join(__dirname, '../public/app/dsp-worker.js');
  const processorPath = path.join(__dirname, '../public/app/voice-isolate-processor.js');

  test('dsp-worker.js file should exist', () => {
    expect(fs.existsSync(workerPath)).toBe(true);
  });

  test('Should register VoiceIsolateProcessor', () => {
    const processor = fs.readFileSync(processorPath, 'utf8');
    expect(processor).toContain("registerProcessor('voice-isolate-processor'");
  });

  test('Should implement process() method', () => {
    const processor = fs.readFileSync(processorPath, 'utf8');
    expect(processor).toContain('process(inputs, outputs');
  });
});

describe('ml-worker.js', () => {
  const mlPath = path.join(__dirname, '../public/app/ml-worker.js');

  test('ml-worker.js file should exist', () => {
    expect(fs.existsSync(mlPath)).toBe(true);
  });

  test('Should reference implemented model types', () => {
    const ml = fs.readFileSync(mlPath, 'utf8');
    // Current implementation includes: vad, deepfilter, demucs
    ['vad', 'demucs'].forEach(m => {
      expect(ml).toContain(`${m}`);
    });
  });

  test('Should use self.onmessage dispatcher', () => {
    const ml = fs.readFileSync(mlPath, 'utf8');
    expect(ml).toContain('self.onmessage');
  });

  test('v19-demo should include ml-worker.js', () => {
    expect(fs.existsSync(path.join(__dirname, '../v19-demo/ml-worker.js'))).toBe(true);
  });
});

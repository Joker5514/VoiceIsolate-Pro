/**
 * VoiceIsolate Pro — Preset Completeness Tests (Phase 6)
 * Verifies all 7 presets define values for all 52 slider parameters.
 */

const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');

// Extract slider IDs
const sliderIdRegex = /id:'(\w+)'/g;
const sliderIds = [];
let m;
while ((m = sliderIdRegex.exec(appJs)) !== null) {
  sliderIds.push(m[1]);
}

// Extract preset names
const presetNameRegex = /const PRESETS = \{([\s\S]*?)\};\s*const STAGES/;
const presetsBlock = appJs.match(presetNameRegex)?.[1] || '';
const presetNames = ['podcast','film','interview','forensic','music','broadcast','restoration'];

describe('Presets', () => {
  test('Should define exactly 7 named presets', () => {
    presetNames.forEach(name => {
      expect(presetsBlock).toContain(`${name}:`);
    });
    expect(presetNames.length).toBe(7);
  });

  presetNames.forEach(presetName => {
    describe(`Preset: ${presetName}`, () => {
      test(`Should include all 52 slider parameters`, () => {
        // Find preset block
        const presetRegex = new RegExp(`${presetName}:\\s*\\{([^}]+)\\}`);
        const presetMatch = appJs.match(presetRegex);
        expect(presetMatch).not.toBeNull();
        const presetStr = presetMatch[1];

        sliderIds.forEach(id => {
          expect(presetStr).toContain(id + ':');
        });
      });
    });
  });

  test('Podcast preset should have nrAmount ≥ 50 (noise-heavy use case)', () => {
    const m = appJs.match(/podcast:\s*\{[^}]+nrAmount:(\d+)/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1])).toBeGreaterThanOrEqual(50);
  });

  test('Forensic preset should have phaseCorr > 0', () => {
    const m = appJs.match(/forensic:\s*\{[^}]+phaseCorr:(\d+)/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1])).toBeGreaterThan(0);
  });

  test('Music preset should have dryWet < 100 (preserve natural sound)', () => {
    const m = appJs.match(/music:\s*\{[^}]+dryWet:(\d+)/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1])).toBeLessThan(100);
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
});

describe('dsp-worker.js', () => {
  const workerPath = path.join(__dirname, '../public/app/dsp-worker.js');

  test('dsp-worker.js file should exist', () => {
    expect(fs.existsSync(workerPath)).toBe(true);
  });

  test('Should register VoiceIsolateProcessor', () => {
    const worker = fs.readFileSync(workerPath, 'utf8');
    expect(worker).toContain("registerProcessor('voice-isolate-processor'");
  });

  test('Should implement process() method', () => {
    const worker = fs.readFileSync(workerPath, 'utf8');
    expect(worker).toContain('process(inputs, outputs)');
  });
});

describe('ml-worker.js', () => {
  const mlPath = path.join(__dirname, '../public/app/ml-worker.js');

  test('ml-worker.js file should exist', () => {
    expect(fs.existsSync(mlPath)).toBe(true);
  });

  test('Should define MODEL_PATHS for all 6 models', () => {
    const ml = fs.readFileSync(mlPath, 'utf8');
    ['vad', 'demucs', 'bsrnn', 'ecapa', 'hifigan', 'conformer'].forEach(m => {
      expect(ml).toContain(`${m}:`);
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

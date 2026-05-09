/**
 * VoiceIsolate Pro — Preset Completeness Tests
 * Verifies all 8 presets cover every one of the 52 slider IDs defined in SLIDERS.
 */

const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');

// Extract slider IDs from the SLIDERS block
const slidersBlockMatch = appJs.match(/const SLIDERS = \{([\s\S]*?)\};\s*\nconst SLIDER_MAP/);
const sliderIds = slidersBlockMatch
  ? [...slidersBlockMatch[1].matchAll(/id\s*:\s*'(\w+)'/g)].map(m => m[1])
  : [];

// Extract preset block text
const presetNameRegex = /const PRESETS = \{([\s\S]*?)\};\s*\n\/\/ Aliases/;
const presetsBlock = appJs.match(presetNameRegex)?.[1] || '';

const PRESET_NAMES = [
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
  test('Should define exactly 8 preset names', () => {
    PRESET_NAMES.forEach(name => {
      expect(presetsBlock).toContain(`'${name}':`);
    });
    expect(PRESET_NAMES.length).toBe(8);
  });

  test('SLIDERS block defines exactly 52 slider IDs', () => {
    expect(sliderIds.length).toBe(52);
  });

  test('Every preset covers all 52 slider IDs', () => {
    PRESET_NAMES.forEach(presetName => {
      const escapedPreset = presetName.replace('/', '\\/');
      // Match from preset key to the next preset key or end of PRESETS block
      const presetRegex = new RegExp(`'${escapedPreset}':\\s*\\{([\\s\\S]*?)\\},?\\s*(?='[A-Z]|$)`);
      const presetMatch = presetsBlock.match(presetRegex);
      expect(presetMatch).not.toBeNull();
      const presetStr = presetMatch[1];

      sliderIds.forEach(sliderId => {
        expect(presetStr).toContain(`${sliderId}:`);
      });
    });
  });

  test('Every preset has a description string', () => {
    PRESET_NAMES.forEach(presetName => {
      const escapedPreset = presetName.replace('/', '\\/');
      const presetRegex = new RegExp(`'${escapedPreset}':\\s*\\{([\\s\\S]*?)\\},?\\s*(?='[A-Z]|$)`);
      const presetMatch = presetsBlock.match(presetRegex);
      expect(presetMatch).not.toBeNull();
      expect(presetMatch[1]).toContain('description:');
    });
  });

  test('Preset application dispatches input and change events', () => {
    expect(appJs).toContain("dispatchEvent(new Event('input', { bubbles: true }))");
    expect(appJs).toContain("dispatchEvent(new Event('change', { bubbles: true }))");
  });

  test('Preset application stores non-slider values in VIP params', () => {
    expect(appJs).toContain('window.VIP_PARAMS = window.VIP_PARAMS || {}');
    expect(appJs).toContain('window.VIP_PARAMS[key] = value');
  });

  test('Forensic Extract uses maximum voice isolation', () => {
    expect(presetsBlock).toContain("'Forensic Extract':");
    const m = presetsBlock.match(/'Forensic Extract':\s*\{[\s\S]*?voiceIso:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1])).toBeGreaterThanOrEqual(95);
  });

  test('Surveillance uses maximum noise reduction', () => {
    const m = presetsBlock.match(/'Surveillance':\s*\{[\s\S]*?nrAmount:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1])).toBeGreaterThanOrEqual(88);
  });

  test('Phone/Radio uses narrow high-pass frequency', () => {
    const m = presetsBlock.match(/'Phone\/Radio':\s*\{[\s\S]*?hpFreq:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1])).toBeGreaterThanOrEqual(200);
  });

  test('Live Performance uses a lower noise reduction than Forensic Extract', () => {
    const liveNR = presetsBlock.match(/'Live Performance':\s*\{[\s\S]*?nrAmount:\s*(\d+)/);
    const forensicNR = presetsBlock.match(/'Forensic Extract':\s*\{[\s\S]*?nrAmount:\s*(\d+)/);
    expect(liveNR).not.toBeNull();
    expect(forensicNR).not.toBeNull();
    expect(parseInt(liveNR[1])).toBeLessThan(parseInt(forensicNR[1]));
  });
});

// ── Preset value-range validation ─────────────────────────────────────────────
// Ensures every numeric value a preset assigns is within the [min, max] range
// declared on its corresponding slider. Catches out-of-range typos like
// gateThresh: 9999 that the previous "key completeness" test would miss.
describe('Preset value-range validation', () => {
  // Build a sliderId → {min, max} table by parsing the SLIDERS literal.
  const slidersBlock = appJs.match(/const SLIDERS\s*=\s*\{([\s\S]*?)\};\s*\nconst SLIDER_MAP/);
  const sliderRanges = {};
  if (slidersBlock) {
    const sliderObjRegex = /\{\s*id\s*:\s*'(\w+)'[^{}]*?min\s*:\s*(-?\d+(?:\.\d+)?)[^{}]*?max\s*:\s*(-?\d+(?:\.\d+)?)/g;
    let m;
    while ((m = sliderObjRegex.exec(slidersBlock[1])) !== null) {
      sliderRanges[m[1]] = { min: parseFloat(m[2]), max: parseFloat(m[3]) };
    }
  }

  test('parsed at least 50 of 52 sliders with min/max metadata', () => {
    // A few sliders may declare min/max in a different key order; require the
    // parser to cover the bulk of the surface so the test is meaningful.
    expect(Object.keys(sliderRanges).length).toBeGreaterThanOrEqual(50);
  });

  PRESET_NAMES.forEach((presetName) => {
    test(`'${presetName}' assigns only in-range numeric values`, () => {
      const escapedPreset = presetName.replace('/', '\\/');
      const presetRegex = new RegExp(`'${escapedPreset}':\\s*\\{([\\s\\S]*?)\\},?\\s*(?='[A-Z]|$)`);
      const match = presetsBlock.match(presetRegex);
      expect(match).not.toBeNull();
      const body = match[1];

      // Tokenize "key: numericLiteral" pairs (skip strings, booleans, objects).
      const pairRegex = /(\w+)\s*:\s*(-?\d+(?:\.\d+)?)\b/g;
      const offenders = [];
      let p;
      while ((p = pairRegex.exec(body)) !== null) {
        const id    = p[1];
        const value = parseFloat(p[2]);
        const range = sliderRanges[id];
        if (!range) continue; // non-slider field (e.g. description, embedded sub-objects)
        if (value < range.min || value > range.max) {
          offenders.push(`${id}=${value} not in [${range.min}, ${range.max}]`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});

describe('STAGES array', () => {
  test('Should define exactly 32 stages', () => {
    const sliderMapJs = fs.readFileSync(path.join(__dirname, '../public/app/slider-map.js'), 'utf8');
    const stagesMatch = sliderMapJs.match(/export const STAGES = \[([\s\S]*?)\];/);
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
  const processorPath = path.join(__dirname, '../public/app/dsp-processor.js');

  test('dsp-worker.js file should exist', () => {
    expect(fs.existsSync(workerPath)).toBe(true);
  });

  test('dsp-processor.js is the canonical AudioWorklet processor', () => {
    const processor = fs.readFileSync(processorPath, 'utf8');
    expect(processor).toContain("registerProcessor('dsp-processor'");
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
    ['vad', 'demucs'].forEach(m => {
      expect(ml).toContain(`${m}`);
    });
  });

  test('Should use self.onmessage dispatcher', () => {
    const ml = fs.readFileSync(mlPath, 'utf8');
    expect(ml).toContain('self.onmessage');
  });

  test('v19-demo should NOT exist (removed as dead code)', () => {
    expect(fs.existsSync(path.join(__dirname, '../v19-demo'))).toBe(false);
  });
});

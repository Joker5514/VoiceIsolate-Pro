/**
 * VoiceIsolate Pro — voiceisolate_presets.ts Tests
 * Verifies preset structure, DSP parameter completeness, and
 * all safety rules defined in .qodo/rules.md.
 */

const fs = require('fs');
const path = require('path');

// Load and eval the TypeScript file by stripping TS-only syntax so it runs as JS.
const tsSource = fs.readFileSync(
  path.join(__dirname, '../voiceisolate_presets.ts'),
  'utf8'
);

// Remove TypeScript interface blocks and type annotations, then expose exports.
const jsSource = tsSource
  // Remove interface declarations (export interface Foo { ... })
  .replace(/export\s+interface\s+\w+\s*\{[^}]*\}/g, '')
  // Remove generic type annotation on PRESETS: Record<string, VoiceIsolatePreset>
  .replace(/:\s*Record<[^>]+>/g, '')
  // Remove 'export' keywords so assignments become plain 'const' declarations
  .replace(/^export\s+/gm, '');

const moduleExports = {};
// eslint-disable-next-line no-new-func
new Function('exports', jsSource)(moduleExports);

// Pull out the values we need to test
// They are plain 'const' in the eval scope; capture via the script returning them.
const evalResult = (function () {
  // Re-evaluate with an explicit return of the bindings we need.
  const src = jsSource + '\nreturn { PRESETS, DEFAULT_PRESET_ID };';
  // eslint-disable-next-line no-new-func
  return new Function(src)();
})();

const { PRESETS, DEFAULT_PRESET_ID } = evalResult;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns true if the string is strictly kebab-case:
 * one or more lowercase-alphanumeric segments joined by single hyphens.
 */
function isKebabCase(str) {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(str);
}

const EXPECTED_PARAM_KEYS = [
  'highPassFreq',
  'lowPassFreq',
  'compThreshold',
  'compRatio',
  'gateThreshold',
  'denoiseMix',
  'spectralGateDB',
  'outputGain',
  'clarityBoost',
  'dryWetMix',
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('voiceisolate_presets — module shape', () => {
  test('PRESETS is a non-null object', () => {
    expect(PRESETS).toBeDefined();
    expect(typeof PRESETS).toBe('object');
    expect(PRESETS).not.toBeNull();
  });

  test('PRESETS contains exactly 3 presets', () => {
    expect(Object.keys(PRESETS).length).toBe(3);
  });

  test('DEFAULT_PRESET_ID is a string', () => {
    expect(typeof DEFAULT_PRESET_ID).toBe('string');
  });

  test('DEFAULT_PRESET_ID is "podcast-clean"', () => {
    expect(DEFAULT_PRESET_ID).toBe('podcast-clean');
  });

  test('DEFAULT_PRESET_ID references an existing preset key', () => {
    expect(PRESETS).toHaveProperty(DEFAULT_PRESET_ID);
  });
});

describe('voiceisolate_presets — named presets exist', () => {
  const EXPECTED_KEYS = ['podcast-clean', 'voice-stream', 'aggressive-isolation'];

  EXPECTED_KEYS.forEach(key => {
    test(`PRESETS has key "${key}"`, () => {
      expect(PRESETS).toHaveProperty(key);
    });
  });
});

describe('voiceisolate_presets — preset object structure', () => {
  Object.entries(PRESETS).forEach(([key, preset]) => {
    describe(`Preset "${key}"`, () => {
      test('has an id string', () => {
        expect(typeof preset.id).toBe('string');
        expect(preset.id.length).toBeGreaterThan(0);
      });

      test('has a name string', () => {
        expect(typeof preset.name).toBe('string');
        expect(preset.name.length).toBeGreaterThan(0);
      });

      test('has a params object', () => {
        expect(typeof preset.params).toBe('object');
        expect(preset.params).not.toBeNull();
      });

      test('preset key matches preset.id', () => {
        expect(preset.id).toBe(key);
      });

      test('params contains all 10 expected DSP fields', () => {
        EXPECTED_PARAM_KEYS.forEach(field => {
          expect(preset.params).toHaveProperty(field);
          expect(typeof preset.params[field]).toBe('number');
        });
      });
    });
  });
});

describe('voiceisolate_presets — safety rules (.qodo/rules.md)', () => {
  describe('Rule: gateThreshold must be <= -30 dBFS', () => {
    Object.entries(PRESETS).forEach(([key, preset]) => {
      test(`${key}: gateThreshold (${preset.params.gateThreshold}) <= -30`, () => {
        expect(preset.params.gateThreshold).toBeLessThanOrEqual(-30);
      });
    });
  });

  describe('Rule: compRatio must be 1–20', () => {
    Object.entries(PRESETS).forEach(([key, preset]) => {
      test(`${key}: compRatio (${preset.params.compRatio}) is in [1, 20]`, () => {
        expect(preset.params.compRatio).toBeGreaterThanOrEqual(1);
        expect(preset.params.compRatio).toBeLessThanOrEqual(20);
      });
    });
  });

  describe('Rule: outputGain must be -12 to 6 dB', () => {
    Object.entries(PRESETS).forEach(([key, preset]) => {
      test(`${key}: outputGain (${preset.params.outputGain}) is in [-12, 6]`, () => {
        expect(preset.params.outputGain).toBeGreaterThanOrEqual(-12);
        expect(preset.params.outputGain).toBeLessThanOrEqual(6);
      });
    });
  });

  describe('Rule: dryWetMix must be 0.0 to 1.0', () => {
    Object.entries(PRESETS).forEach(([key, preset]) => {
      test(`${key}: dryWetMix (${preset.params.dryWetMix}) is in [0, 1]`, () => {
        expect(preset.params.dryWetMix).toBeGreaterThanOrEqual(0.0);
        expect(preset.params.dryWetMix).toBeLessThanOrEqual(1.0);
      });
    });
  });

  describe('Rule: denoiseMix must be 0.0 to 1.0', () => {
    Object.entries(PRESETS).forEach(([key, preset]) => {
      test(`${key}: denoiseMix (${preset.params.denoiseMix}) is in [0, 1]`, () => {
        expect(preset.params.denoiseMix).toBeGreaterThanOrEqual(0.0);
        expect(preset.params.denoiseMix).toBeLessThanOrEqual(1.0);
      });
    });
  });

  describe('Rule: all preset IDs must be kebab-case', () => {
    Object.entries(PRESETS).forEach(([key, preset]) => {
      test(`preset key "${key}" is kebab-case`, () => {
        expect(isKebabCase(key)).toBe(true);
      });

      test(`preset.id "${preset.id}" is kebab-case`, () => {
        expect(isKebabCase(preset.id)).toBe(true);
      });
    });
  });

  describe('Rule: aggressive-isolation requires denoiseMix >= 0.8', () => {
    test('aggressive-isolation: denoiseMix >= 0.8', () => {
      const preset = PRESETS['aggressive-isolation'];
      expect(preset).toBeDefined();
      expect(preset.params.denoiseMix).toBeGreaterThanOrEqual(0.8);
    });
  });
});

describe('voiceisolate_presets — individual preset values', () => {
  describe('podcast-clean', () => {
    const preset = PRESETS['podcast-clean'];

    test('highPassFreq is 80', () => expect(preset.params.highPassFreq).toBe(80));
    test('lowPassFreq is 16000', () => expect(preset.params.lowPassFreq).toBe(16000));
    test('compThreshold is -24', () => expect(preset.params.compThreshold).toBe(-24));
    test('compRatio is 3.5', () => expect(preset.params.compRatio).toBe(3.5));
    test('gateThreshold is -48', () => expect(preset.params.gateThreshold).toBe(-48));
    test('denoiseMix is 0.35', () => expect(preset.params.denoiseMix).toBe(0.35));
    test('spectralGateDB is 8', () => expect(preset.params.spectralGateDB).toBe(8));
    test('outputGain is 1.5', () => expect(preset.params.outputGain).toBe(1.5));
    test('clarityBoost is 2', () => expect(preset.params.clarityBoost).toBe(2));
    test('dryWetMix is 0.95', () => expect(preset.params.dryWetMix).toBe(0.95));
    test('name is "Podcast Clean"', () => expect(preset.name).toBe('Podcast Clean'));
  });

  describe('voice-stream', () => {
    const preset = PRESETS['voice-stream'];

    test('highPassFreq is 100', () => expect(preset.params.highPassFreq).toBe(100));
    test('lowPassFreq is 14000', () => expect(preset.params.lowPassFreq).toBe(14000));
    test('compThreshold is -20', () => expect(preset.params.compThreshold).toBe(-20));
    test('compRatio is 3', () => expect(preset.params.compRatio).toBe(3));
    test('gateThreshold is -44', () => expect(preset.params.gateThreshold).toBe(-44));
    test('denoiseMix is 0.3', () => expect(preset.params.denoiseMix).toBe(0.3));
    test('spectralGateDB is 6', () => expect(preset.params.spectralGateDB).toBe(6));
    test('outputGain is 1', () => expect(preset.params.outputGain).toBe(1));
    test('clarityBoost is 1.5', () => expect(preset.params.clarityBoost).toBe(1.5));
    test('dryWetMix is 0.9', () => expect(preset.params.dryWetMix).toBe(0.9));
    test('name is "Voice Stream"', () => expect(preset.name).toBe('Voice Stream'));
  });

  describe('aggressive-isolation', () => {
    const preset = PRESETS['aggressive-isolation'];

    test('highPassFreq is 120', () => expect(preset.params.highPassFreq).toBe(120));
    test('lowPassFreq is 12000', () => expect(preset.params.lowPassFreq).toBe(12000));
    test('compThreshold is -18', () => expect(preset.params.compThreshold).toBe(-18));
    test('compRatio is 5', () => expect(preset.params.compRatio).toBe(5));
    test('gateThreshold is -38', () => expect(preset.params.gateThreshold).toBe(-38));
    test('denoiseMix is 0.85', () => expect(preset.params.denoiseMix).toBe(0.85));
    test('spectralGateDB is 14', () => expect(preset.params.spectralGateDB).toBe(14));
    test('outputGain is 2', () => expect(preset.params.outputGain).toBe(2));
    test('clarityBoost is 3', () => expect(preset.params.clarityBoost).toBe(3));
    test('dryWetMix is 1.0', () => expect(preset.params.dryWetMix).toBe(1.0));
    test('name is "Aggressive Isolation"', () => expect(preset.name).toBe('Aggressive Isolation'));
  });
});

describe('voiceisolate_presets — boundary and regression checks', () => {
  test('No preset has gateThreshold exactly at the boundary (-30)', () => {
    // All should be strictly below -30, not right at the edge
    Object.entries(PRESETS).forEach(([key, preset]) => {
      expect(preset.params.gateThreshold).toBeLessThan(-30);
    });
  });

  test('No preset outputGain reaches the upper boundary (6 dB)', () => {
    Object.entries(PRESETS).forEach(([, preset]) => {
      expect(preset.params.outputGain).toBeLessThan(6);
    });
  });

  test('No preset outputGain falls below the lower boundary (-12 dB)', () => {
    Object.entries(PRESETS).forEach(([, preset]) => {
      expect(preset.params.outputGain).toBeGreaterThanOrEqual(-12);
    });
  });

  test('highPassFreq is lower than lowPassFreq in every preset (valid band)', () => {
    Object.entries(PRESETS).forEach(([key, preset]) => {
      expect(preset.params.highPassFreq).toBeLessThan(preset.params.lowPassFreq);
    });
  });

  test('All compRatio values are positive numbers', () => {
    Object.entries(PRESETS).forEach(([, preset]) => {
      expect(preset.params.compRatio).toBeGreaterThan(0);
    });
  });

  test('All spectralGateDB values are positive', () => {
    Object.entries(PRESETS).forEach(([, preset]) => {
      expect(preset.params.spectralGateDB).toBeGreaterThan(0);
    });
  });

  test('All clarityBoost values are non-negative', () => {
    Object.entries(PRESETS).forEach(([, preset]) => {
      expect(preset.params.clarityBoost).toBeGreaterThanOrEqual(0);
    });
  });

  test('PRESETS object keys are the same set as preset.id values', () => {
    const keys = Object.keys(PRESETS).sort();
    const ids = Object.values(PRESETS).map(p => p.id).sort();
    expect(keys).toEqual(ids);
  });

  test('No two presets share the same id', () => {
    const ids = Object.values(PRESETS).map(p => p.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  test('No two presets share the same name', () => {
    const names = Object.values(PRESETS).map(p => p.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
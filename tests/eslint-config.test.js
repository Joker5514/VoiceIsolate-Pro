const fs = require('fs');
const path = require('path');

/**
 * ESLint Configuration Validation
 *
 * Note: This test uses string-based evaluation because the environment's module resolution
 * for ESLint's flat config dependencies (@eslint/js, globals) is inconsistent across
 * different test runner contexts. This approach ensures we can validate the configuration's
 * structure without being blocked by environment-specific ESM resolution issues.
 */
describe('ESLint Configuration Validation', () => {
  let config;

  beforeAll(() => {
    const configPath = path.join(__dirname, '../eslint.config.js');
    const source = fs.readFileSync(configPath, 'utf8');

    // Create mocks for the imported modules that mirror the expected ESLint structure
    const jsMock = {
      configs: {
        recommended: { rules: { 'no-debugger': 'error' } }
      }
    };
    const globalsMock = {
      browser: { window: 'readonly' },
      worker: { self: 'readonly' },
      node: { process: 'readonly' },
      jest: { describe: 'readonly' }
    };

    // Robust extraction of the configuration array:
    // 1. Strip static import statements, including both `import ... from '...'`
    //    and bare side-effect imports like `import 'foo';`
    // 2. Replace 'export default' with 'return'
    const code = source
      .replace(/^\s*import(?:[\s\S]*?\s+from\s+)?['"][^'"\n]+['"]\s*;?\s*$/gm, '')
      .replace(/export\s+default/g, 'return');

    try {
      const evalFunc = new Function('js', 'globals', code);
      config = evalFunc(jsMock, globalsMock);
    } catch (err) {
      console.error('Failed to parse eslint.config.js for testing:', err);
      throw err;
    }
  });

  test('should export a non-empty array', () => {
    expect(Array.isArray(config)).toBe(true);
    expect(config.length).toBeGreaterThan(0);
  });

  test('should include recommended rules as the base entry', () => {
    // We check that the first entry matches our mock's recommended config
    expect(config[0]).toMatchObject({ rules: { 'no-debugger': 'error' } });
  });

  test('should define configuration for public/app/app.js', () => {
    const appConfig = config.find(c => c.files && c.files.includes('public/app/app.js'));
    expect(appConfig).toBeDefined();
    expect(appConfig.languageOptions.ecmaVersion).toBe(2022);
    // app.js uses ES module import syntax (imports from slider-map.js)
    expect(appConfig.languageOptions.sourceType).toBe('module');

    // Check for critical globals that app.js depends on
    const g = appConfig.languageOptions.globals;
    expect(g).toHaveProperty('ort', 'readonly');
    expect(g).toHaveProperty('THREE', 'readonly');
    expect(g).toHaveProperty('PipelineState', 'readonly');
  });

  test('should define configuration for public/app/dsp-processor.js (AudioWorklet)', () => {
    const dspConfig = config.find(c => c.files && c.files.includes('public/app/dsp-processor.js'));
    expect(dspConfig).toBeDefined();

    const g = dspConfig.languageOptions.globals;
    expect(g).toHaveProperty('AudioWorkletProcessor', 'readonly');
    expect(g).toHaveProperty('registerProcessor', 'readonly');
  });

  test('should define configuration for Web Workers (DSP and ML)', () => {
    ['public/app/dsp-worker.js', 'public/app/ml-worker.js'].forEach(file => {
      const workerConfig = config.find(c => c.files && c.files.includes(file));
      expect(workerConfig).toBeDefined();
      expect(workerConfig.languageOptions.globals).toHaveProperty('importScripts', 'readonly');
      expect(workerConfig.languageOptions.globals).toHaveProperty('self', 'readonly');
    });
  });

  test('should define configuration for Node scripts and Jest tests', () => {
    const scriptsConfig = config.find(c => c.files && c.files.includes('scripts/**/*.js') && c.files.includes('tests/**/*.test.js'));
    expect(scriptsConfig).toBeDefined();
    expect(scriptsConfig.languageOptions.sourceType).toBe('commonjs');

    const g = scriptsConfig.languageOptions.globals;
    // These should come from globals.node and globals.jest
    expect(g).toHaveProperty('process', 'readonly');
    expect(g).toHaveProperty('describe', 'readonly');
  });

  test('should define ignore patterns for node_modules and demo', () => {
    const ignoreConfig = config.find(c => c.ignores);
    expect(ignoreConfig).toBeDefined();
    expect(ignoreConfig.ignores).toContain('node_modules/**');
    expect(ignoreConfig.ignores).toContain('v19-demo/**');
  });

  test('should apply strict rules (no-undef) to browser files', () => {
    const browserFiles = ['public/app/app.js', 'public/app/dsp-processor.js', 'public/app/dsp-worker.js', 'public/app/ml-worker.js'];
    browserFiles.forEach(file => {
      const fileConfig = config.find(c => c.files && c.files.includes(file));
      expect(fileConfig.rules).toHaveProperty('no-undef', 'error');
    });
  });
});
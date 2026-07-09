/**
 * AudioWorklet packaging — web, Android (Capacitor), and desktop (Electron).
 * Ensures all three registered worklets ship on every platform.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { verifyWorklets, loadWorkletManifest, sha256File } = require('../scripts/verify-worklets.js');

const ROOT = path.join(__dirname, '..');

describe('AudioWorklet packaging (all platforms)', () => {
  const registry = loadWorkletManifest();

  test('worklet-manifest.json lists exactly 3 worklets', () => {
    expect(registry.worklets).toHaveLength(3);
    const ids = registry.worklets.map((w) => w.id);
    expect(ids).toEqual(['vip-gate', 'vip-deesser', 'dsp-processor']);
  });

  test('verify-worklets.js passes (source + manifest + APP_SHELL)', () => {
    const result = verifyWorklets({ quiet: true });
    expect(result.errors).toEqual([]);
  });

  test('each worklet source defines registerProcessor with the expected name', () => {
    for (const entry of registry.worklets) {
      const src = fs.readFileSync(path.join(ROOT, entry.source), 'utf8');
      expect(src).toContain(`registerProcessor('${entry.processorName}'`);
    }
  });

  test('build/ copies exist and match source hashes after pnpm build', () => {
    const missing = registry.worklets
      .map((w) => w.buildPath)
      .filter((p) => !fs.existsSync(path.join(ROOT, p)));
    if (missing.length) {
      // build/ is optional in CI validate-only runs; skip with guidance
      console.warn('[worklet-packaging] build/ absent — run pnpm build to verify desktop/android packaging');
      return;
    }
    for (const entry of registry.worklets) {
      const srcHash = sha256File(path.join(ROOT, entry.source));
      const buildHash = sha256File(path.join(ROOT, entry.buildPath));
      expect(buildHash).toBe(srcHash);
    }
  });

  test('models-manifest.json pins SHA-256 for every worklet', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/app/models-manifest.json'), 'utf8'));
    expect(doc.worklets.gate_processor).toBeDefined();
    expect(doc.worklets.deesser_processor).toBeDefined();
    expect(doc.worklets.dsp_processor).toBeDefined();
    for (const key of ['gate_processor', 'deesser_processor', 'dsp_processor']) {
      const sha = doc.worklets[key].sources[0].sha256;
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('public/app/sw.js APP_SHELL precaches all worklet URLs', () => {
    const sw = fs.readFileSync(path.join(ROOT, 'public/app/sw.js'), 'utf8');
    for (const entry of registry.worklets) {
      expect(sw).toContain(entry.url);
    }
  });

  test('public/app/sw.js APP_SHELL precaches WhisperHunter and dsp-bootstrap', () => {
    const sw = fs.readFileSync(path.join(ROOT, 'public/app/sw.js'), 'utf8');
    expect(sw).toContain("'/app/whisper-hunter.js'");
    expect(sw).toContain("'/app/dsp-bootstrap.js'");
    expect(sw).not.toContain("'/app/batch-orchestrator.js'");
    expect(sw).not.toContain("'/app/paywall.js'");
  });

  test('capacitor.config.json webDir is build (worklets flow through pnpm build)', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
    expect(cfg.webDir).toBe('build');
  });

  test('electron-builder.yml packs build/** (includes worklets)', () => {
    const yml = fs.readFileSync(path.join(ROOT, 'electron/electron-builder.yml'), 'utf8');
    expect(yml).toContain('build/**/*');
  });

  test('landing and engineer pages cross-link each other', () => {
    const landing = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const engineer = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
    expect(landing).toContain('href="/app/"');
    expect(engineer).toContain('href="/">Stem-Split</a>');
  });

  test('PlaybackMixer allowlists only Gate + DeEsser for addModule', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/pipeline/PlaybackMixer.js'), 'utf8');
    expect(src).toContain("addModule('/src/workers/GateProcessor.js')");
    expect(src).toContain("addModule('/src/workers/DeEsserProcessor.js')");
    const matches = [...src.matchAll(/addModule\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(matches).toEqual([
      '/src/workers/GateProcessor.js',
      '/src/workers/DeEsserProcessor.js',
    ]);
  });
});
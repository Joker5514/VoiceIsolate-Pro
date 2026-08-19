/**
 * Production DSP import-graph guard.
 *
 * Ensures the Electron/Engineer Process path never routes through deprecated
 * `dsp-stages.js` or legacy `offline-processor.js`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const FORBIDDEN = [
  'dsp-stages.js',
  'dsp-stages',
  'offline-processor.js',
  'offline-processor',
];

/** Seeds of the production Process graph (HTML → Process → stems → export). */
const PRODUCTION_SEEDS = [
  'public/app/index.html',
  'public/app/app.js',
  'public/landing.js',
  'public/app/dsp-bootstrap.js',
  'public/app/processing-overlay.js',
  'src/pipeline/StemSeparation.js',
  'src/pipeline/MLWorkerHost.js',
  'src/pipeline/MLStemCache.js',
  'src/pipeline/ui-yield.js',
  'src/pipeline/JobController.js',
  'src/pipeline/PlaybackMixer.js',
  'src/pipeline/ProcessingOrchestrator.js',
  'src/workers/MLWorker.js',
  'src/workers/USMWorker.js',
  'src/core/ml-defaults.js',
  'electron/main.cjs',
];

const IMPORT_RE = /(?:import\s*(?:[^'"\n]*from\s*)?|import\s*\(|require\s*\(|new\s+Worker\s*\(|script[^>]+src\s*=\s*)['"]([^'"]+)['"]/gi;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function mentionsForbidden(text) {
  const hits = [];
  for (const needle of FORBIDDEN) {
    const re = new RegExp(
      `(?:from\\s+|import\\s*\\(|require\\s*\\(|src\\s*=\\s*)['"][^'"]*${needle.replace('.', '\\.')}['"]`,
      'i',
    );
    if (re.test(text)) hits.push(needle);
    // Bare path references used as Worker/script URLs
    const bare = new RegExp(`['"\`][^'"\`]*${needle.replace('.', '\\.')}['"\`]`, 'i');
    if (bare.test(text) && /dsp-stages|offline-processor/.test(needle)) {
      // Allow quarantine comments that mention the filename without importing.
      const importish = new RegExp(
        `(import|require|from|src\\s*=|Worker\\s*\\().{0,80}${needle.replace('.', '\\.')}`,
        'i',
      );
      const quarantined = /DEPRECATED|QUARANTINED|NOT ON THE PRODUCTION|production-dsp-import-graph/.test(text);
      if (importish.test(text) && !quarantined) {
        if (!hits.includes(needle)) hits.push(needle);
      }
    }
  }
  return hits;
}

describe('production DSP import graph', () => {
  test('Engineer HTML does not load dsp-stages or offline-processor scripts', () => {
    const html = read('public/app/index.html');
    expect(html).toMatch(/dsp-core\.js/);
    expect(html).toMatch(/app\.js/);
    expect(html).not.toMatch(/dsp-stages\.js/);
    expect(html).not.toMatch(/offline-processor\.js/);
  });

  test('production seed modules do not import legacy DSP stages', () => {
    const offenders = [];
    for (const rel of PRODUCTION_SEEDS) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) {
        offenders.push(`${rel} (missing)`);
        continue;
      }
      const text = read(rel);
      const hits = mentionsForbidden(text);
      // Quarantine banners intentionally name the files — exclude comment-only hits
      // by requiring an actual import/require/script pattern.
      for (const hit of hits) {
        const importRe = new RegExp(
          `(?:import\\s*(?:[^'"\\n]*from\\s*)?|import\\s*\\(|require\\s*\\(|new\\s+Worker\\s*\\(|src\\s*=\\s*)['"][^'"]*${hit.replace('.', '\\.')}`,
          'i',
        );
        if (importRe.test(text)) offenders.push(`${rel} → ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('canonical Process path uses StemSeparation → MLWorker', () => {
    const app = read('public/app/app.js');
    const host = read('src/pipeline/MLWorkerHost.js');
    expect(app).toMatch(/StemSeparation\.js/);
    expect(app).toMatch(/separateStems/);
    expect(app).toMatch(/signal:\s*this\._processAbortSignal\(\)/);
    expect(host).toContain('/src/workers/MLWorker.js');
    expect(host).not.toMatch(/ml-worker\.js/);
  });

  test('dsp-stages.js and offline-processor.js are marked quarantined', () => {
    const stages = read('public/app/dsp-stages.js');
    const offline = read('public/app/offline-processor.js');
    expect(stages).toMatch(/DEPRECATED|QUARANTINED/);
    expect(stages).toMatch(/NOT ON THE PRODUCTION/);
    expect(offline).toMatch(/NOT ON THE PRODUCTION|LEGACY/);
  });

  test('no DSPChain module is required by production Process', () => {
    // Historical name from older blueprints — ensure it is not a live dependency.
    for (const rel of ['public/app/app.js', 'src/pipeline/StemSeparation.js', 'src/pipeline/MLWorkerHost.js']) {
      const text = read(rel);
      expect(text).not.toMatch(/DSPChain/);
      expect(text).not.toMatch(/dsp-chain/i);
    }
  });

  test('recursive script/import crawl from index.html stays clear of legacy stages', () => {
    const visited = new Set();
    const queue = ['public/app/index.html', 'public/app/app.js', 'public/landing.js'];
    const bad = [];

    while (queue.length) {
      const rel = queue.pop();
      if (visited.has(rel)) continue;
      visited.add(rel);
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      if (!/\.(js|mjs|cjs|html)$/i.test(rel)) continue;
      // Do not crawl into the quarantined modules themselves.
      if (/dsp-stages\.js$|offline-processor\.js$/i.test(rel)) {
        bad.push(`seed reached quarantined module: ${rel}`);
        continue;
      }
      const text = fs.readFileSync(abs, 'utf8');
      let m;
      IMPORT_RE.lastIndex = 0;
      while ((m = IMPORT_RE.exec(text))) {
        let ref = m[1];
        if (!ref || ref.startsWith('http') || ref.startsWith('data:')) continue;
        if (ref.startsWith('/')) ref = ref.slice(1);
        else if (ref.startsWith('./') || ref.startsWith('../')) {
          ref = path.posix.normalize(path.posix.join(path.posix.dirname(rel.replace(/\\/g, '/')), ref));
        } else if (ref.startsWith('src/') || ref.startsWith('public/')) {
          // absolute-from-root style
        } else {
          continue;
        }
        ref = ref.replace(/\\/g, '/');
        if (/dsp-stages|offline-processor/i.test(ref)) {
          bad.push(`${rel} imports ${ref}`);
          continue;
        }
        if (/\.(js|mjs|cjs|html)$/i.test(ref) && !visited.has(ref) && visited.size < 200) {
          // Only follow in-repo app/src paths
          if (/^(public\/|src\/|electron\/)/.test(ref)) queue.push(ref);
        }
      }
    }

    expect(bad).toEqual([]);
    expect(visited.size).toBeGreaterThan(5);
  });
});

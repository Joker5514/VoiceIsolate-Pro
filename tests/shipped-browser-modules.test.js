/**
 * VoiceIsolate Pro — shipped browser source guards.
 *
 * Every file under `src/` and `public/` is served straight to the browser, so a
 * single parse error takes the whole surface down: `public/app/app.js` imports
 * the `src/` layers, and one bad module means `VoiceIsolatePro` never registers,
 * `bindEvents()` never runs, and choosing a file does nothing at all. That is
 * exactly how a bad merge (duplicated lines from a superseded revision) shipped
 * a dead Engineer console while `pnpm lint`, `pnpm validate` and the Jest suites
 * all stayed green — ESLint only covers the entry points listed in the `lint`
 * script, and nothing else parsed the rest of the tree.
 *
 * These are static guards on purpose: they run in milliseconds without a
 * browser, so the class of defect is caught before the Chromium smokes.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// Vendored bundles (`public/lib/`) are third-party artifacts, and `public/src/`
// is the generated copy of `src/` written by scripts/sync-src.js.
const SKIP_DIRS = new Set(['node_modules', 'public/lib', 'public/src']);

function walkJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (SKIP_DIRS.has(entry.name) || SKIP_DIRS.has(rel)) continue;
    if (entry.isDirectory()) walkJs(abs, out);
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const jsFiles = [
  ...walkJs(path.join(ROOT, 'src')),
  ...walkJs(path.join(ROOT, 'public')),
].sort();

describe('shipped browser JavaScript parses', () => {
  test('SourceTextModule is available (run Jest with --experimental-vm-modules)', () => {
    expect(typeof vm.SourceTextModule).toBe('function');
  });

  test('the sweep reaches the production entry points', () => {
    expect(jsFiles).toEqual(expect.arrayContaining([
      'public/app/app.js',
      'public/app/premium-workspace.js',
      'public/app/lib/signal-canvas-integration.js',
      'public/landing.js',
      'src/state/audioSessionStore.js',
      'src/workers/MLWorker.js',
    ]));
  });

  test.each(jsFiles)('%s parses', (rel) => {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // Parses without evaluating: no imports resolve, no side effects run.
    expect(() => new vm.SourceTextModule(source, { identifier: rel })).not.toThrow();
  });
});

// Duplicate ids silently break `getElementById` — it returns whichever node
// comes first in document order, so a hidden compatibility shim can shadow the
// real canvas the app paints into.
const HTML_ENTRY_POINTS = ['public/index.html', 'public/app/index.html'];

describe('shipped HTML entry points have unique element ids', () => {
  test.each(HTML_ENTRY_POINTS)('%s', (rel) => {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const seen = new Map();
    const duplicates = [];
    for (const match of html.matchAll(/\sid=["']([^"']+)["']/g)) {
      const id = match[1];
      if (seen.has(id)) duplicates.push(id);
      else seen.set(id, true);
    }
    expect(duplicates).toEqual([]);
  });
});

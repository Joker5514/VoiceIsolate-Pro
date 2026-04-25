/**
 * tests/model-registry-consistency.test.js
 *
 * Cross-verifies the three model registries that must agree on canonical
 * .onnx filenames. Drift between them silently breaks the ML worker:
 *   - models-manifest.json says one set of files ships
 *   - ml-worker.js MODEL_FILES references files to load by inference key
 *   - ml-worker-fetch-cache.js MODEL_REGISTRY caches a third set
 *
 * If any canonical filename appears in one registry but not the others,
 * inference can request a file the cache does not know about, or the
 * manifest can advertise a file no code path uses. This test fails loudly
 * with a per-registry diff so the discrepancy is unambiguous.
 *
 * If a registry block cannot be parsed, the test fails with a clear
 * "registry unparseable" message rather than skipping.
 */

const fs   = require('fs');
const path = require('path');

const ROOT             = path.resolve(__dirname, '..');
const MANIFEST_PATH    = path.join(ROOT, 'public', 'app', 'models', 'models-manifest.json');
const ML_WORKER_PATH   = path.join(ROOT, 'public', 'app', 'ml-worker.js');
const FETCH_CACHE_PATH = path.join(ROOT, 'public', 'app', 'ml-worker-fetch-cache.js');

// ─── Parse manifest ──────────────────────────────────────────────────────────
function readManifestFilenames() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const json = JSON.parse(raw);
  if (!json || !Array.isArray(json.models)) {
    throw new Error(
      `models-manifest.json unparseable: expected top-level "models" array at ${MANIFEST_PATH}`
    );
  }
  const names = json.models.map((m, i) => {
    if (!m || typeof m.filename !== 'string' || !m.filename.endsWith('.onnx')) {
      throw new Error(
        `models-manifest.json entry ${i} has no .onnx "filename" field (got ${JSON.stringify(m && m.filename)})`
      );
    }
    return m.filename;
  });
  return new Set(names);
}

// ─── Parse ml-worker.js MODEL_FILES ──────────────────────────────────────────
function readMlWorkerFilenames() {
  const src = fs.readFileSync(ML_WORKER_PATH, 'utf8');
  const blockMatch = src.match(/const\s+MODEL_FILES\s*=\s*\{([\s\S]*?)\};/);
  if (!blockMatch) {
    throw new Error(
      `ml-worker.js MODEL_FILES registry unparseable at ${ML_WORKER_PATH}: ` +
      'expected "const MODEL_FILES = { ... };" block. Drift cannot be checked.'
    );
  }
  const body = blockMatch[1];
  const names = new Set();
  const lineRe = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]+\.onnx)['"]/g;
  let m;
  while ((m = lineRe.exec(body)) !== null) names.add(m[2]);
  if (names.size === 0) {
    throw new Error(
      `ml-worker.js MODEL_FILES contained no .onnx values — registry unparseable or empty`
    );
  }
  return names;
}

// ─── Parse ml-worker-fetch-cache.js MODEL_REGISTRY ───────────────────────────
function readFetchCacheFilenames() {
  const src = fs.readFileSync(FETCH_CACHE_PATH, 'utf8');
  const blockMatch = src.match(/const\s+MODEL_REGISTRY\s*=\s*\{([\s\S]*?)\n\};/);
  if (!blockMatch) {
    throw new Error(
      `ml-worker-fetch-cache.js MODEL_REGISTRY unparseable at ${FETCH_CACHE_PATH}: ` +
      'expected "const MODEL_REGISTRY = { ... };" block. Drift cannot be checked.'
    );
  }
  const body = blockMatch[1];
  const names = new Set();
  const pathRe = /path\s*:\s*['"]([^'"]+\.onnx)['"]/g;
  let m;
  while ((m = pathRe.exec(body)) !== null) {
    const p = m[1];
    const filename = path.basename(p);
    names.add(filename);
  }
  if (names.size === 0) {
    throw new Error(
      `ml-worker-fetch-cache.js MODEL_REGISTRY contained no .onnx paths — registry unparseable or empty`
    );
  }
  return names;
}

function diff(setA, setB) {
  return [...setA].filter(x => !setB.has(x)).sort();
}

describe('model registry consistency', () => {
  let manifest, mlWorker, fetchCache;

  beforeAll(() => {
    manifest   = readManifestFilenames();
    mlWorker   = readMlWorkerFilenames();
    fetchCache = readFetchCacheFilenames();
  });

  test('all three registries parse to non-empty filename sets', () => {
    expect(manifest.size).toBeGreaterThan(0);
    expect(mlWorker.size).toBeGreaterThan(0);
    expect(fetchCache.size).toBeGreaterThan(0);
  });

  test('canonical .onnx filenames are aligned across manifest, ml-worker, and fetch-cache', () => {
    const onlyInManifest    = diff(manifest,   new Set([...mlWorker, ...fetchCache]));
    const onlyInMlWorker    = diff(mlWorker,   new Set([...manifest, ...fetchCache]));
    const onlyInFetchCache  = diff(fetchCache, new Set([...manifest, ...mlWorker]));

    const missingFromManifest   = diff(new Set([...mlWorker, ...fetchCache]), manifest);
    const missingFromMlWorker   = diff(new Set([...manifest, ...fetchCache]), mlWorker);
    const missingFromFetchCache = diff(new Set([...manifest, ...mlWorker]),   fetchCache);

    const drift =
      missingFromManifest.length   > 0 ||
      missingFromMlWorker.length   > 0 ||
      missingFromFetchCache.length > 0;

    if (drift) {
      const lines = [
        'Model registry drift detected. Each canonical .onnx filename must appear in all three registries.',
        '',
        `manifest          (${MANIFEST_PATH.replace(ROOT + '/', '')}): ${[...manifest].sort().join(', ')}`,
        `ml-worker.js      MODEL_FILES values: ${[...mlWorker].sort().join(', ')}`,
        `fetch-cache       MODEL_REGISTRY paths: ${[...fetchCache].sort().join(', ')}`,
        '',
        `only in manifest:        ${onlyInManifest.join(', ')   || '(none)'}`,
        `only in ml-worker.js:    ${onlyInMlWorker.join(', ')   || '(none)'}`,
        `only in fetch-cache:     ${onlyInFetchCache.join(', ') || '(none)'}`,
        '',
        `missing from manifest:        ${missingFromManifest.join(', ')   || '(none)'}`,
        `missing from ml-worker.js:    ${missingFromMlWorker.join(', ')   || '(none)'}`,
        `missing from fetch-cache:     ${missingFromFetchCache.join(', ') || '(none)'}`,
      ];
      throw new Error(lines.join('\n'));
    }

    expect(drift).toBe(false);
  });
});

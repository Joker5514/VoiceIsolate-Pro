/**
 * tests/quality-corpus.test.js — VIP-006 corpus schema & loader gate.
 * Fixtures are synthetic bytes generated here (no copyrighted audio).
 */
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOADER = path.join(ROOT, 'scripts', 'quality', 'load-corpus.mjs');

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildCorpus({ clips, badHash = false, privateOnly = false, category = 'clean-speech' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-corpus-'));
  fs.mkdirSync(path.join(dir, 'audio'));
  const entries = [];
  const n = clips ?? 5;
  for (let i = 0; i < n; i++) {
    const id = `clip-${String(i).padStart(3, '0')}`;
    const bytes = Buffer.from(`${id}-audio-bytes-${i}`.repeat(10));
    fs.writeFileSync(path.join(dir, 'audio', `${id}.wav`), bytes);
    entries.push({
      id,
      path: `audio/${id}.wav`,
      sha256: badHash && i === 0 ? sha(Buffer.from('other')) : sha(bytes),
      source: 'synthetic test fixture',
      license: 'CC0-1.0',
      redistribution: privateOnly ? 'private-only' : 'allowed',
      category,
      language: 'en',
      sampleRate: 48_000,
      channels: 1,
      durationSec: 1.5,
    });
  }
  // Spread categories so the >= 4 classes bar is reachable when requested.
  if (clips === undefined) {
    const cats = ['clean-speech', 'quiet-speech', 'noisy-speech/white', 'noisy-speech/babble'];
    entries.forEach((e, i) => { e.category = cats[i % cats.length]; });
  }
  const manifest = {
    schema: 'vip-quality-corpus',
    schemaVersion: 1,
    datasetVersion: 'test-1',
    licensePolicy: 'CC0-1.0',
    clips: entries,
  };
  fs.writeFileSync(path.join(dir, 'corpus-manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

function runLoader(dir, extra = []) {
  try {
    const out = execFileSync(process.execPath, [LOADER, '--root', dir, ...extra], { encoding: 'utf8' });
    return { status: 0, out };
  } catch (err) {
    return { status: err.status ?? 1, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

describe('quality corpus loader (VIP-006)', () => {
  let tmpDirs = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  test('a licensed, checksummed, multi-class corpus passes and reports its version', () => {
    const dir = buildCorpus();
    tmpDirs.push(dir);
    const r = runLoader(dir, ['--min-clips', '5']);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/OK dataset test-1/);
    expect(r.out).toMatch(/5 clips, 4 classes/);
  });

  test('a corrupted/undocumented clip fails on sha256 mismatch', () => {
    const dir = buildCorpus({ badHash: true });
    tmpDirs.push(dir);
    const r = runLoader(dir, ['--min-clips', '5']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/sha256 mismatch/);
  });

  test('private-only clips are refused unless --allow-private', () => {
    const dir = buildCorpus({ privateOnly: true });
    tmpDirs.push(dir);
    expect(runLoader(dir, ['--min-clips', '5']).status).toBe(1);
    const r = runLoader(dir, ['--allow-private', '--min-clips', '5']);
    expect(r.status).toBe(0);
  });

  test('single-category corpora fail the >= 4 classes bar', () => {
    const dir = buildCorpus({ clips: 5, category: 'clean-speech' });
    tmpDirs.push(dir);
    const r = runLoader(dir, ['--min-clips', '5']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/noise\/content classes/);
  });

  test('missing license or redistribution fields fail', () => {
    const dir = buildCorpus();
    tmpDirs.push(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'corpus-manifest.json'), 'utf8'));
    delete manifest.clips[0].license;
    fs.writeFileSync(path.join(dir, 'corpus-manifest.json'), JSON.stringify(manifest));
    const r = runLoader(dir, ['--min-clips', '5']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/missing license/);
  });

  test('missing manifest or wrong schema fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-corpus-empty-'));
    tmpDirs.push(dir);
    expect(runLoader(dir).status).toBe(1);
    fs.writeFileSync(path.join(dir, 'corpus-manifest.json'), JSON.stringify({ schema: 'other', schemaVersion: 9, datasetVersion: 'x', clips: [] }));
    const r = runLoader(dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/unknown schema|clips/);
  });

  test('the schema document exists and states the honest corpus status', () => {
    // VIP-006 (PR #888): the corpus is no longer "not assembled" — the v1
    // manifest is committed and the provisioner is delivered, while binary
    // audio stays git-ignored/external. The pin now asserts that honest
    // status (manifest + provisioner + external audio), not the old one.
    const readme = fs.readFileSync(path.join(ROOT, 'scripts', 'quality', 'corpus', 'README.md'), 'utf8');
    expect(readme).toMatch(/manifest committed/);
    expect(readme).toMatch(/provisioner delivered/);
    expect(readme).toMatch(/git-ignored/);
    expect(readme).toMatch(/sha256/i);
    expect(readme).toMatch(/license/i);
  });
});

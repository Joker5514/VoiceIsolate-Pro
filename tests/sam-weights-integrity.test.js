/**
 * SAM-Audio weight pins (services/sam-audio/weights_integrity.py), driven
 * through python3 with a fake snapshot download. Nothing touches the network.
 * Skipped only when no python3 interpreter is installed.
 */
'use strict';

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SAM_DIR = path.join(ROOT, 'services', 'sam-audio');
const PYTHON = process.env.PYTHON || 'python3';
const hasPython = spawnSync(PYTHON, ['--version']).status === 0;
const describePy = hasPython ? describe : describe.skip;

const REV = 'a'.repeat(40);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Run resolve_weights() in python; the fake download returns `snapDir`. */
function resolve({ lock, snapDir, requirePin = true, model = 'facebook/sam-audio-small' }) {
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SAM_DIR)})
from weights_integrity import resolve_weights, WeightsIntegrityError
args = json.loads(sys.argv[1])
calls = []
def fake_download(**kw):
    calls.append(kw)
    return args["snap"]
try:
    src, report = resolve_weights(args["model"], token=None, require_pin=args["requirePin"], lock=args["lock"], download=fake_download)
    print(json.dumps({"ok": True, "src": src, "report": report, "calls": calls}))
except WeightsIntegrityError as e:
    print(json.dumps({"ok": False, "error": str(e), "calls": calls}))
`;
  const r = spawnSync(PYTHON, ['-I', '-B', '-c', code, JSON.stringify({ lock, snap: snapDir, requirePin, model })], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describePy('SAM weights.lock.json integrity', () => {
  let snap;
  const files = { 'config.json': Buffer.from('{"a":1}'), 'model.safetensors': crypto.randomBytes(4096) };
  const pins = () => Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha(b)]));
  const lockWith = (entry) => ({ schema: 1, models: { 'facebook/sam-audio-small': entry } });

  beforeEach(() => {
    snap = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-sam-snap-'));
    for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(snap, n), b);
  });
  afterEach(() => fs.rmSync(snap, { recursive: true, force: true }));

  test('shipped lock parses and pins nothing fabricated', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(SAM_DIR, 'weights.lock.json'), 'utf8'));
    expect(lock.schema).toBe(1);
    for (const entry of Object.values(lock.models)) {
      expect(entry.revision).toMatch(/^[0-9a-f]{40}$/);
      for (const d of Object.values(entry.files)) expect(d).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('matching pins: downloads the pinned revision/files and loads the local snapshot', () => {
    const r = resolve({ lock: lockWith({ revision: REV, files: pins() }), snapDir: snap });
    expect(r.ok).toBe(true);
    expect(r.src).toBe(snap);
    expect(r.report).toMatchObject({ pinned: true, verified: true, revision: REV, files: 2 });
    expect(r.calls[0]).toMatchObject({ repo_id: 'facebook/sam-audio-small', revision: REV });
    expect(r.calls[0].allow_patterns.sort()).toEqual(['config.json', 'model.safetensors']);
  });

  test('a changed weight file is refused', () => {
    fs.writeFileSync(path.join(snap, 'model.safetensors'), crypto.randomBytes(4096));
    const r = resolve({ lock: lockWith({ revision: REV, files: pins() }), snapDir: snap });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/model\.safetensors sha256 .* does not match pin/);
  });

  test('a missing pinned file is refused', () => {
    fs.rmSync(path.join(snap, 'config.json'));
    const r = resolve({ lock: lockWith({ revision: REV, files: pins() }), snapDir: snap });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/pinned file missing: config\.json/);
  });

  test('unpinned model: refused when pins are required, unverified otherwise', () => {
    const empty = { schema: 1, models: {} };
    const strict = resolve({ lock: empty, snapDir: snap, requirePin: true });
    expect(strict.ok).toBe(false);
    expect(strict.error).toMatch(/^weights-unpinned/);
    expect(strict.calls).toHaveLength(0);
    const dev = resolve({ lock: empty, snapDir: snap, requirePin: false });
    expect(dev).toMatchObject({ ok: true, src: 'facebook/sam-audio-small', report: { pinned: false, verified: false } });
  });

  test('malformed pins are refused before any download', () => {
    for (const entry of [
      { revision: 'main', files: pins() },
      { revision: REV, files: {} },
      { revision: REV, files: { 'model.safetensors': 'abc' } },
      { revision: REV, files: { '../evil.bin': 'a'.repeat(64) } },
    ]) {
      const r = resolve({ lock: lockWith(entry), snapDir: snap });
      expect(r.ok).toBe(false);
      expect(r.calls).toHaveLength(0);
    }
  });

  test('git blob id helper matches git hash-object', () => {
    const p = path.join(snap, 'config.json');
    const git = spawnSync('git', ['hash-object', p], { encoding: 'utf8' });
    if (git.status !== 0) return;
    const r = spawnSync(PYTHON, ['-I', '-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(SAM_DIR)}); from weights_integrity import git_blob_sha1; print(git_blob_sha1(sys.argv[1]))`, p], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe(git.stdout.trim());
  });

  test('server.py loads through resolve_weights and reports weight status', () => {
    const server = fs.readFileSync(path.join(SAM_DIR, 'server.py'), 'utf8');
    expect(server).toMatch(/resolve_weights\(\s*MODEL_ID/);
    expect(server).toMatch(/SAMAudio\.from_pretrained\(source/);
    expect(server).not.toMatch(/SAMAudio\.from_pretrained\(MODEL_ID/);
    expect(server).toMatch(/"weights": _WEIGHTS_STATUS/);
    expect(server).toMatch(/SAM_AUDIO_ALLOW_UNPINNED/);
  });
});

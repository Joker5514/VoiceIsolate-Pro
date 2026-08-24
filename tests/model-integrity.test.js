'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

let integrity;
let MODEL_MANIFEST;

beforeAll(async () => {
  integrity = await import('../scripts/validate-model-integrity.mjs');
  ({ MODEL_MANIFEST } = await import('../src/core/ModelManifest.js'));
});

function writeOnnx(dir, rel, contents) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  return abs;
}

function fixtureEntry(id, bytes) {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    id,
    name: id,
    url: `/app/models/${id}.onnx`,
    sizeBytes: bytes.length,
    sha256: hash,
    io: { input: 'input', output: 'output' },
  };
}

describe('model integrity validator', () => {
  test('uses ModelManifest.js shipped entries and passes the real source tree', () => {
    const result = integrity.validateModelIntegrity();
    expect(result.shippedIds.sort()).toEqual(
      ['bsrnn_vocals', 'rnnoise', 'vad', 'vad_int8'].sort(),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.notices.some((n) => /remote Blob hashes were not downloaded/.test(n))).toBe(true);
    expect(result.rewrites.hasAppModelsRewrite).toBe(true);
    expect(result.rewrites.usesBlobStorage).toBe(true);
    expect(result.rewrites.destinations.join(' ')).not.toMatch(/MUST_MATCH_PLACEHOLDER_HOST/);
  });

  test('does not treat optional/unshipped Demucs as required', () => {
    expect(integrity.isRequiredShippedModel(MODEL_MANIFEST.demucs)).toBe(false);
    expect(integrity.isRequiredShippedModel(MODEL_MANIFEST.bsrnn_complex)).toBe(false);
    expect(integrity.isRequiredShippedModel(MODEL_MANIFEST.ecapa_tdnn)).toBe(false);
    expect(integrity.shippedModelIds()).not.toContain('demucs');
  });

  test('rejects unpinned models that are not explicitly optional', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-models-unpinned-'));
    const result = integrity.validateModelIntegrity({
      root,
      manifest: {
        probe: {
          id: 'probe',
          name: 'probe',
          url: '/app/models/probe.onnx',
          sizeBytes: null,
          sha256: null,
          io: { input: 'input', output: 'output' },
        },
      },
      vercelJson: {
        rewrites: [
          { source: '/app/models/:filename', destination: 'https://x.blob.vercel-storage.com/:filename' },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/probe/);
  });

  test('negative: missing file reports id, expected size/hash, and delivery path', () => {
    const bytes = Buffer.from('ok-model');
    const entry = fixtureEntry('probe', bytes);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-models-missing-'));
    const result = integrity.validateModelIntegrity({
      root,
      manifest: { probe: entry },
      vercelJson: {
        rewrites: [
          {
            source: '/app/models/:filename',
            destination: 'https://example.blob.vercel-storage.com/:filename',
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
    const msg = result.errors.join('\n');
    expect(msg).toContain('model probe');
    expect(msg).toContain(`expected size ${entry.sizeBytes} hash ${entry.sha256}`);
    expect(msg).toContain('actual size missing');
    expect(msg).toContain(entry.url);
  });

  test('negative: truncated file fails size and hash', () => {
    const bytes = Buffer.alloc(64, 7);
    const entry = fixtureEntry('probe', bytes);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-models-trunc-'));
    writeOnnx(root, 'public/app/models/probe.onnx', bytes.subarray(0, 8));
    const result = integrity.validateModelIntegrity({
      root,
      manifest: { probe: entry },
      vercelJson: {
        rewrites: [
          { source: '/app/models/:filename', destination: 'https://x.blob.vercel-storage.com/:filename' },
        ],
      },
    });
    expect(result.ok).toBe(false);
    const msg = result.errors.join('\n');
    expect(msg).toContain('model probe');
    expect(msg).toContain('expected size 64');
    expect(msg).toContain('actual size 8');
  });

  test('negative: hash-mismatched file of the expected size', () => {
    const good = Buffer.alloc(32, 1);
    const bad = Buffer.alloc(32, 2);
    const entry = fixtureEntry('probe', good);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-models-hash-'));
    writeOnnx(root, 'public/app/models/probe.onnx', bad);
    const result = integrity.validateModelIntegrity({
      root,
      manifest: { probe: entry },
      vercelJson: {
        rewrites: [
          { source: '/app/models/:filename', destination: 'https://x.blob.vercel-storage.com/:filename' },
        ],
      },
    });
    expect(result.ok).toBe(false);
    const actualHash = crypto.createHash('sha256').update(bad).digest('hex');
    expect(result.errors.join('\n')).toContain(actualHash);
    expect(result.errors.join('\n')).toContain(entry.sha256);
  });

  test('--require-build checks build output independently of source', () => {
    const bytes = Buffer.from('build-model');
    const entry = fixtureEntry('probe', bytes);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-models-build-'));
    writeOnnx(root, 'public/app/models/probe.onnx', bytes);
    const result = integrity.validateModelIntegrity({
      root,
      manifest: { probe: entry },
      requireBuild: true,
      vercelJson: {
        rewrites: [
          { source: '/app/models/:filename', destination: 'https://x.blob.vercel-storage.com/:filename' },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/build/);
  });

  test('malformed vercel.json is a validation error, not a silent skip', () => {
    const bytes = Buffer.from('ok-model');
    const entry = fixtureEntry('probe', bytes);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-models-vercel-'));
    writeOnnx(root, 'public/app/models/probe.onnx', bytes);
    fs.writeFileSync(path.join(root, 'vercel.json'), '{ not json');
    const result = integrity.validateModelIntegrity({
      root,
      manifest: { probe: entry },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/vercel\.json exists but is unreadable/);
  });

  test('--download-remote fails closed instead of claiming remote hashes', () => {
    const result = integrity.validateModelIntegrity({ downloadRemote: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/download-remote is not implemented/);
  });

  test('rewrite ownership is logical, not a hardcoded blob host name', () => {
    const state = integrity.inspectVercelModelRewrites({
      rewrites: [
        {
          source: '/app/models/:filename',
          destination: 'https://another-store.blob.vercel-storage.com/:filename',
        },
      ],
    });
    expect(state.hasAppModelsRewrite).toBe(true);
    expect(state.usesBlobStorage).toBe(true);
  });
});

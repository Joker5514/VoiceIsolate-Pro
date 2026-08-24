'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let provenance;

beforeAll(async () => {
  provenance = await import('../scripts/validate-release-provenance.mjs');
});

function validDoc(overrides = {}) {
  return {
    schemaVersion: 1,
    productVersion: '25.0.2',
    generatedAt: '2026-08-24T10:00:00Z',
    reviewedMainSha: '3385ca3df7be5f49d1f2e22d5d45f4e17bd39f7c',
    tag: 'v25.0.2',
    platforms: [
      {
        platform: 'web',
        status: 'unknown',
        version: '25.0.2',
        sourceSha: null,
        builtAt: null,
        artifact: {
          kind: 'vercel-hosting',
          filename: null,
          url: 'https://voice-isolate-pro.vercel.app/',
          sha256: null,
          sizeBytes: null,
        },
        verification: {
          method: 'unknown',
          evidence: 'Production Vercel deployment SHA was not independently verified.',
        },
        notes: 'web unknown',
      },
      {
        platform: 'android',
        status: 'stale',
        version: '25.0.2',
        sourceSha: '17692f98e1023ea7b18b7bd8a5c374291ccb67f8',
        builtAt: '2026-08-21T10:04:08Z',
        artifact: {
          kind: 'github-release',
          filename: 'VoiceIsolate-Pro-android-debug.apk',
          url: 'https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.2/VoiceIsolate-Pro-android-debug.apk',
          sha256: '24f8bdf372630925eee764dee65b291a00fe722bd9033861afd7217b9206271f',
          sizeBytes: 101620559,
        },
        verification: {
          method: 'github-release-asset',
          evidence: 'GitHub Release v25.0.2 asset digest.',
        },
        notes: 'stale apk',
      },
      {
        platform: 'windows',
        status: 'stale',
        version: '25.0.2',
        sourceSha: '17692f98e1023ea7b18b7bd8a5c374291ccb67f8',
        builtAt: '2026-08-21T10:04:10Z',
        artifact: {
          kind: 'github-release',
          filename: 'VoiceIsolate-Pro-25.0.2-win-x64.exe',
          url: 'https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.2/VoiceIsolate-Pro-25.0.2-win-x64.exe',
          sha256: '9e40c03f5b365f0f0ccd88cc57850837e3933edb074b72151587b4512198903d',
          sizeBytes: 144646374,
        },
        verification: {
          method: 'github-release-asset',
          evidence: 'GitHub Release v25.0.2 asset digest.',
        },
        notes: 'stale exe',
      },
    ],
    claims: {
      sameBuildAcrossWebAndroidWindowsMainAndTag: false,
      synchronizedPublishedArtifacts: false,
      tagMoved: false,
    },
    ...overrides,
  };
}

describe('release provenance validator', () => {
  test('checked-in provenance file is schema-valid in default mode', () => {
    const file = path.join(__dirname, '../docs/releases/release-provenance.json');
    const result = provenance.validateProvenanceFile(file, { strict: false });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('strict mode fails on recorded stale/unknown platforms', () => {
    const result = provenance.validateProvenance(validDoc(), { strict: true });
    expect(result.ok).toBe(false);
    expect(result.strictFailures.length).toBeGreaterThan(0);
  });

  test('checked-in synchronized provenance passes strict mode', () => {
    const file = path.join(__dirname, '../docs/releases/release-provenance.json');
    const result = provenance.validateProvenanceFile(file, { strict: true });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('rejects duplicate platform records', () => {
    const doc = validDoc();
    doc.platforms.push({ ...doc.platforms[1] });
    const result = provenance.validateProvenance(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /duplicate platform/.test(e.message))).toBe(true);
  });

  test('rejects missing required platforms', () => {
    const doc = validDoc();
    doc.platforms = doc.platforms.filter((p) => p.platform !== 'windows');
    const result = provenance.validateProvenance(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /missing required platform record: windows/.test(e.message))).toBe(true);
  });

  test('rejects current records missing immutable fields', () => {
    const doc = validDoc();
    const android = doc.platforms.find((p) => p.platform === 'android');
    android.status = 'current';
    android.artifact.sha256 = null;
    android.builtAt = null;
    const result = provenance.validateProvenance(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /sha256/.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /builtAt/.test(e.message))).toBe(true);
  });

  test('rejects current records whose sourceSha is not reviewedMainSha', () => {
    const doc = validDoc();
    const android = doc.platforms.find((p) => p.platform === 'android');
    android.status = 'current';
    android.artifact.sha256 = '24f8bdf372630925eee764dee65b291a00fe722bd9033861afd7217b9206271f';
    android.builtAt = '2026-08-21T10:04:08Z';
    android.sourceSha = '17692f98e1023ea7b18b7bd8a5c374291ccb67f8';
    const result = provenance.validateProvenance(doc, { strict: true });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /reviewedMainSha/.test(e.message))).toBe(true);
  });

  test('rejects a tag that does not match productVersion or package.json', () => {
    const doc = validDoc();
    doc.tag = 'v99.0.0';
    const result = provenance.validateProvenance(doc, { packageVersion: '25.0.2' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === 'tag')).toBe(true);
    doc.tag = 'v25.0.2';
    doc.productVersion = '25.0.1';
    const result2 = provenance.validateProvenance(doc, { packageVersion: '25.0.2' });
    expect(result2.ok).toBe(false);
    expect(result2.errors.some((e) => /package.json/.test(e.message) || e.path === 'productVersion' || e.path === 'tag')).toBe(true);
  });

  test('rejects truncated SHA-256 and short git SHAs', () => {
    const doc = validDoc();
    const win = doc.platforms.find((p) => p.platform === 'windows');
    win.artifact.sha256 = 'abc123';
    win.sourceSha = '17692f9';
    const result = provenance.validateProvenance(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /sha256/.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /sourceSha/.test(e.message))).toBe(true);
  });

  test('rejects invalid timestamps and non-https URLs', () => {
    const doc = validDoc();
    doc.generatedAt = '2026-08-24';
    const android = doc.platforms.find((p) => p.platform === 'android');
    android.builtAt = 'not-a-date';
    android.artifact.url = 'http://example.com/app.apk';
    const result = provenance.validateProvenance(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === 'generatedAt')).toBe(true);
    expect(result.errors.some((e) => /builtAt/.test(e.path))).toBe(true);
    expect(result.errors.some((e) => /https URL/.test(e.message))).toBe(true);
  });

  test('rejects hostless https URLs and impossible calendar dates', () => {
    const doc = validDoc();
    doc.generatedAt = '2026-02-31T10:00:00Z';
    const android = doc.platforms.find((p) => p.platform === 'android');
    android.artifact.url = 'https://';
    const result = provenance.validateProvenance(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === 'generatedAt')).toBe(true);
    expect(result.errors.some((e) => /hostname/.test(e.message))).toBe(true);
  });

  test('treats varied markdown denials as not same-build claims', () => {
    const doc = validDoc();
    const result = provenance.validateProvenance(doc, {
      docs: {
        'CLAUDE.md': 'Web, Android, and Windows does **not** share the same build.',
        'docs/DOWNLOADS.md': 'Web, Android and Windows do not share the same build.',
      },
    });
    expect(result.errors.filter((e) => String(e.path).startsWith('docs:'))).toEqual([]);
  });

  test('still flags a same-build claim that contains an unrelated not', () => {
    const doc = validDoc();
    const result = provenance.validateProvenance(doc, {
      docs: {
        'CLAUDE.md': 'Web, Android, and Windows are not independent releases; each shipped the same build as main.',
      },
    });
    expect(result.errors.some((e) => String(e.path).startsWith('docs:'))).toBe(true);
  });

  test('rejects unsupported same-build claims', () => {
    const doc = validDoc();
    doc.claims.sameBuildAcrossWebAndroidWindowsMainAndTag = true;
    const result = provenance.validateProvenance(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /same build/.test(e.message))).toBe(true);
  });

  test('rejects inferring deployed web SHA from repository HEAD', () => {
    const doc = validDoc();
    const web = doc.platforms.find((p) => p.platform === 'web');
    web.sourceSha = doc.reviewedMainSha;
    web.verification.method = 'unknown';
    const result = provenance.validateProvenance(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /infer deployed Web/.test(e.message))).toBe(true);
  });

  test('mutation-style negative tests against malformed JSON records', () => {
    const mutations = [
      (doc) => { doc.schemaVersion = 2; },
      (doc) => { doc.productVersion = 'v25.0.2'; },
      (doc) => { doc.platforms[0].status = 'ready'; },
      (doc) => { doc.platforms[1].version = '25.0.1'; },
      (doc) => { doc.platforms[2].artifact.filename = 'wrong.exe'; },
      (doc) => { doc.claims.tagMoved = true; },
      (doc) => { doc.platforms[0].verification.method = 'repository-head'; },
    ];
    for (const mutate of mutations) {
      const doc = validDoc();
      mutate(doc);
      const result = provenance.validateProvenance(doc);
      expect(result.ok).toBe(false);
    }
  });

  test('CLI default mode exits 0 for the checked-in provenance file', async () => {
    const code = await provenance.main([]);
    expect(code).toBe(0);
  });

  test('CLI strict mode exits 0 for the checked-in synchronized file', async () => {
    const code = await provenance.main(['--strict']);
    expect(code).toBe(0);
  });

  test('CLI rejects invalid JSON files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-prov-'));
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{ not json');
    const code = await provenance.main(['--file', file]);
    expect(code).toBe(1);
  });
});

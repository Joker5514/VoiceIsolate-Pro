/**
 * VIP-032 — analysis routing regression test.
 *
 * Pins docs/guides/ANALYSIS_CONTRACTS.md to the code: the only production
 * callers of each analysis producer are the allowlisted ones, every
 * production path ends at a validated AnalysisSnapshot, and the contract
 * rejects malformed snapshots instead of passing them through.
 *
 * The static scan reads production sources as text (src/ + public/app/ +
 * public/*.js). Comments are stripped first so doc mentions (e.g. the
 * adapter's "Adapt runAutoAnalysis() output…" JSDoc) do not false-positive.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function collectProductionFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith('.js')) out.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'public', 'app'));
  for (const entry of fs.readdirSync(path.join(ROOT, 'public'), { withFileTypes: true })) {
    if (!entry.isDirectory() && entry.name.endsWith('.js')) out.push(path.join(ROOT, 'public', entry.name));
  }
  return out;
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function filesCalling(files, pattern) {
  return files
    .filter((file) => pattern.test(stripComments(fs.readFileSync(file, 'utf8'))))
    .map((file) => path.relative(ROOT, file));
}

describe('VIP-032 analysis routing', () => {
  const files = collectProductionFiles();

  test('runAutoAnalysis is only called through the AnalysisCoordinator', () => {
    const callers = filesCalling(files, /\brunAutoAnalysis\s*\(/);
    // AutoAnalysis.js itself defines it (export function runAutoAnalysis).
    expect(callers.sort()).toEqual([
      'src/core/audio/analysis/AutoAnalysis.js',
      'src/pipeline/AnalysisCoordinator.js',
    ]);
  });

  test('analyzeAudioCooperative is only called through FullAnalysisHost and its worker', () => {
    const callers = filesCalling(files, /\banalyzeAudioCooperative\s*\(/);
    expect(callers.sort()).toEqual([
      'src/core/FullAnalysis.js',
      'src/pipeline/FullAnalysisHost.js',
      'src/workers/FullAnalysisWorker.js',
    ]);
  });

  test('FullAnalysisHost is only constructed by the Analysis workspace and Landing insights', () => {
    const callers = filesCalling(files, /\bnew FullAnalysisHost\s*\(/);
    expect(callers.sort()).toEqual([
      'public/app/lib/analysis-workspace.js',
      'src/presentation/AnalysisInsightsUI.js',
    ]);
  });

  test('both adapters are the only snapshot producers outside the coordinator', () => {
    const fullAdapterCallers = filesCalling(files, /\badaptFullAnalysisToSnapshot\s*\(/);
    expect(fullAdapterCallers.sort()).toEqual([
      'public/app/lib/analysis-workspace.js',
      'src/core/AnalysisSnapshotAdapter.js',
      'src/presentation/AnalysisInsightsUI.js',
    ]);
    const autoAdapterCallers = filesCalling(files, /\badaptAutoAnalysisToSnapshot\s*\(/);
    expect(autoAdapterCallers.sort()).toEqual([
      'src/core/AnalysisSnapshotAdapter.js',
      'src/pipeline/AnalysisCoordinator.js',
    ]);
  });

  test('workspace path: FullAnalysisHost result adapts to a validated canonical snapshot', async () => {
    const { FullAnalysisHost } = await import('../src/pipeline/FullAnalysisHost.js');
    const { adaptFullAnalysisToSnapshot } = await import('../src/core/AnalysisSnapshotAdapter.js');
    const { validateAnalysisSnapshot } = await import('../src/core/IntelligenceContracts.js');
    const sr = 48000;
    const ch = new Float32Array(sr);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.3;
    const host = new FullAnalysisHost({ useWorker: false });
    const raw = await host.analyze([ch], sr, {});
    const snapshot = adaptFullAnalysisToSnapshot(
      { ...raw, sampleRate: raw.sampleRate || sr, channels: 1, duration: 1 },
      { contentFingerprint: 'test-routing-fingerprint' },
    );
    expect(() => validateAnalysisSnapshot(snapshot)).not.toThrow();
    expect(snapshot.freshness).toBe('fresh');
    expect(Array.isArray(snapshot.evidenceRegions)).toBe(true);
    expect(Array.isArray(snapshot.warnings)).toBe(true);
    expect(snapshot.capabilities.localAnalysis.status).toBe('ready');
  });

  test('contract rejects malformed snapshots instead of passing them through', async () => {
    const { validateAnalysisSnapshot } = await import('../src/core/IntelligenceContracts.js');
    const { adaptFullAnalysisToSnapshot } = await import('../src/core/AnalysisSnapshotAdapter.js');
    const good = adaptFullAnalysisToSnapshot(
      { sampleRate: 48000, channels: 1, duration: 1, detectedSources: [] },
      { contentFingerprint: 'test-contract-fingerprint' },
    );
    expect(() => validateAnalysisSnapshot({ ...good, freshness: 'bogus' })).toThrow();
    expect(() => validateAnalysisSnapshot({ ...good, warnings: undefined })).toThrow();
    expect(() => validateAnalysisSnapshot({ ...good, evidenceRegions: undefined })).toThrow();
  });

  test('coordinator cache identity changes with fingerprint and version', async () => {
    const { AnalysisCoordinator } = await import('../src/pipeline/AnalysisCoordinator.js');
    const base = {
      contentFingerprint: 'fp-1',
      analysisVersion: '1',
      analyzerVersions: { auto: 'auto-analysis-1' },
      configuration: {},
    };
    const otherFp = { ...base, contentFingerprint: 'fp-2' };
    const otherVersion = { ...base, analysisVersion: '2' };
    expect(AnalysisCoordinator.cacheKey(base)).toBe(AnalysisCoordinator.cacheKey({ ...base }));
    expect(AnalysisCoordinator.cacheKey(base)).not.toBe(AnalysisCoordinator.cacheKey(otherFp));
    expect(AnalysisCoordinator.cacheKey(base)).not.toBe(AnalysisCoordinator.cacheKey(otherVersion));
  });
});

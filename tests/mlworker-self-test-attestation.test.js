/**
 * ML-01/ML-02 — in-worker self-test + browser attestation (LOCAL 2026-11-25).
 *
 * The worker is the authority on its own model state; the browser only
 * validates schema / freshness / instance / manifest pins, and invalidates
 * on worker restart OR model change. This suite proves:
 * - the initial attestation is well-formed and validates (all shipped
 *   models present, none claimed ready before their self-test);
 * - the three pinned self-tests pass with exact hash matches and move
 *   their models to 'ready';
 * - a fresh attestation after self-test validates with all three ready;
 * - validation rejects tampered instance / stale / future / tampered sha /
 *   missing capability / wrong schema;
 * - applying an attestation from a different worker instance invalidates
 *   the previous snapshot (restart), and a rejected attestation never
 *   overwrites a good snapshot.
 *
 * Self-test pins live in ModelManifest.workerSelfTest (fixture
 * worker-selftest-noise-1s-v1, measured in Node from the worker's own
 * self-test path). The S3 pins (selfTest) are the independent external
 * check and are not touched here.
 */
'use strict';

const { createMlWorker } = require('../scripts/quality/lib/mlworker-node.cjs');

const TIMEOUT = 120000;

let workerA;
let workerB;
let Ort;
let Manifest;

beforeAll(async () => {
  workerA = await createMlWorker();
  Ort = await import('../src/core/OrtStatus.js');
  Manifest = await import('../src/core/ModelManifest.js');
}, TIMEOUT);

function shippedModelIds() {
  return Object.entries(Manifest.MODEL_MANIFEST)
    .filter(([, entry]) => entry.shipped !== false)
    .map(([id]) => id);
}

describe('initial attestation', () => {
  test('is well-formed and validates, with no model claimed ready yet', async () => {
    const att = workerA.getLastAttestation();
    expect(att).not.toBeNull();
    expect(att.schemaVersion).toBe(1);
    expect(typeof att.workerInstanceId).toBe('string');
    expect(att.workerInstanceId.length).toBeGreaterThan(0);
    expect(Number.isFinite(att.issuedAt)).toBe(true);
    expect(Date.now() - att.issuedAt).toBeLessThan(60 * 1000);
    expect(att.selfTest.testVersion).toBe('worker-selftest-v1');
    expect(att.selfTest.fixtureId).toBe('worker-selftest-noise-1s-v1');
    expect(typeof att.selfTest.passed).toBe('boolean');
    expect(typeof att.runtime.executionProvider).toBe('string');

    const result = Ort.validateWorkerAttestation(att);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    // Nothing has self-tested yet: no model may be claimed ready.
    expect(result.readyModels).toEqual([]);
    expect(result.pendingModels.sort()).toEqual(shippedModelIds().sort());
  }, TIMEOUT);
});

describe('in-worker self-test (ML-02)', () => {
  test('bsrnn, rnnoise, deepfilternet3 pass with exact hash matches', async () => {
    for (const id of ['bsrnn_vocals', 'rnnoise', 'deepfilternet3']) {
      const res = await workerA.selfTest(id);
      expect(res.passed).toBe(true);
      expect(res.state).toBe('ready');
      expect(res.modelId).toBe(id);
    }
  }, TIMEOUT);

  test('unknown model fails explicitly, never silently passes', async () => {
    const res = await workerA.selfTest('not-a-model');
    expect(res.passed).toBe(false);
    expect(String(res.reason)).toMatch(/Unknown model/);
  }, TIMEOUT);

  test('a fresh attestation after self-test validates with all three ready', async () => {
    workerA.send({ type: 'attestation' });
    await new Promise((r) => setTimeout(r, 250));
    const att = workerA.getLastAttestation();
    expect(att).not.toBeNull();
    const result = Ort.validateWorkerAttestation(att);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.readyModels.sort()).toEqual(
      ['bsrnn_vocals', 'deepfilternet3', 'rnnoise'].sort(),
    );
    expect(att.selfTest.passed).toBe(true);
    expect(att.selfTest.passedCount).toBe(3);
    expect(att.selfTest.failed).toEqual([]);
    expect(att.selfTest.pinned).toBe(3);
    // Capability pins match the manifest pins exactly — for models that
    // HAVE a file pin. deepfilternet3 is a composite with no file of its
    // own (no sha256 by design): its integrity evidence is the self-test
    // output hash, which must equal the manifest workerSelfTest pin.
    for (const id of ['bsrnn_vocals', 'rnnoise']) {
      expect(att.capabilities[id].sha256).toBe(Manifest.MODEL_MANIFEST[id].sha256);
      expect(att.capabilities[id].state).toBe('ready');
    }
    expect(att.capabilities.deepfilternet3.sha256).toBeNull();
    expect(att.capabilities.deepfilternet3.state).toBe('ready');
    expect(att.capabilities.deepfilternet3.selfTest.passed).toBe(true);
    expect(att.capabilities.deepfilternet3.selfTest.outputSha256).toBe(
      Manifest.MODEL_MANIFEST.deepfilternet3.workerSelfTest.expectedOutputSha256,
    );
  }, TIMEOUT);
});

describe('attestation validation (pure, browser side)', () => {
  let good;
  beforeAll(async () => {
    workerA.send({ type: 'attestation' });
    await new Promise((r) => setTimeout(r, 250));
    good = workerA.getLastAttestation();
    expect(Ort.validateWorkerAttestation(good).ok).toBe(true);
  }, TIMEOUT);

  test('rejects a tampered instance id', () => {
    const bad = { ...good, workerInstanceId: 'forged-instance' };
    const result = Ort.validateWorkerAttestation(bad, {
      expectedInstanceId: good.workerInstanceId,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/workerInstanceId/);
  });

  test('rejects an attestation from another instance (restart)', () => {
    const result = Ort.validateWorkerAttestation(good, {
      expectedInstanceId: 'some-other-worker-instance',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/restart/);
  });

  test('rejects a stale attestation', () => {
    const stale = { ...good, issuedAt: Date.now() - 10 * 60 * 1000 };
    const result = Ort.validateWorkerAttestation(stale);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/stale/);
  });

  test('rejects an attestation from the future', () => {
    const future = { ...good, issuedAt: Date.now() + 10 * 60 * 1000 };
    const result = Ort.validateWorkerAttestation(future);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/future/);
  });

  test('rejects a tampered model sha', () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.capabilities.bsrnn_vocals.sha256 = '0'.repeat(64);
    const result = Ort.validateWorkerAttestation(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sha256/);
  });

  test('rejects a missing capability for a shipped model', () => {
    const bad = JSON.parse(JSON.stringify(good));
    delete bad.capabilities.rnnoise;
    const result = Ort.validateWorkerAttestation(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/rnnoise/);
  });

  test('rejects a wrong schema version and a missing attestation', () => {
    const bad = { ...good, schemaVersion: 99 };
    expect(Ort.validateWorkerAttestation(bad).ok).toBe(false);
    expect(Ort.validateWorkerAttestation(null).ok).toBe(false);
    expect(Ort.validateWorkerAttestation(undefined).ok).toBe(false);
  });
});

describe('applyMlWorkerMessage (restart invalidation)', () => {
  test('a new worker instance invalidates the previous snapshot', async () => {
    workerB = await createMlWorker();
    const attA = workerA.getLastAttestation();
    const attB = workerB.getLastAttestation();
    expect(attB.workerInstanceId).not.toBe(attA.workerInstanceId);

    Ort.applyMlWorkerMessage({ type: 'model-attestation', attestation: attA });
    let status = Ort.getOrtStatus();
    expect(status.workerInstanceId).toBe(attA.workerInstanceId);
    expect(status.modelsReady.sort()).toEqual(
      ['bsrnn_vocals', 'deepfilternet3', 'rnnoise'].sort(),
    );

    // Worker B is a restart: its attestation must replace A's, not merge.
    Ort.applyMlWorkerMessage({ type: 'model-attestation', attestation: attB });
    status = Ort.getOrtStatus();
    expect(status.workerInstanceId).toBe(attB.workerInstanceId);
    expect(status.attestation).toBe(attB);
    // B has not self-tested: nothing ready after the restart.
    expect(status.modelsReady).toEqual([]);
  }, TIMEOUT);

  test('a rejected attestation never overwrites a good snapshot', async () => {
    const attA = workerA.getLastAttestation();
    Ort.applyMlWorkerMessage({ type: 'model-attestation', attestation: attA });
    expect(Ort.getOrtStatus().workerInstanceId).toBe(attA.workerInstanceId);

    const bad = JSON.parse(JSON.stringify(attA));
    bad.capabilities.bsrnn_vocals.sha256 = '0'.repeat(64);
    Ort.applyMlWorkerMessage({ type: 'model-attestation', attestation: bad });
    const status = Ort.getOrtStatus();
    expect(status.workerInstanceId).toBe(attA.workerInstanceId);
    expect(status.attestation).toBe(attA);
    expect(String(status.detail)).toMatch(/rejected/);
  }, TIMEOUT);
});

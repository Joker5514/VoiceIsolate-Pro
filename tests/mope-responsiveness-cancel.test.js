/**
 * Desktop MOPE / processing path — cancel + cache + overlay structural coverage.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const orch = fs.readFileSync(path.join(ROOT, 'src/pipeline/ProcessingOrchestrator.js'), 'utf8');
const host = fs.readFileSync(path.join(ROOT, 'src/pipeline/FullAnalysisHost.js'), 'utf8');
const prompt = fs.readFileSync(path.join(ROOT, 'src/pipeline/PromptedIsolation.js'), 'utf8');
const overlay = fs.readFileSync(path.join(ROOT, 'public/app/processing-overlay.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
const selectProv = fs.readFileSync(path.join(ROOT, 'src/core/providers/selectProvider.js'), 'utf8');
const mlWorker = fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8');
const faWorker = fs.readFileSync(path.join(ROOT, 'src/workers/FullAnalysisWorker.js'), 'utf8');

describe('MOPE responsiveness + cancel plumbing', () => {
  test('ProcessingOrchestrator accepts AbortSignal and cancels ML worker', () => {
    expect(orch).toMatch(/signal/);
    expect(orch).toMatch(/type:\s*['"]cancel['"]/);
    expect(orch).toMatch(/CancellationError/);
    expect(orch).toMatch(/_stemCache|fromCache/);
    expect(orch).toMatch(/_initPromise/);
  });

  test('FullAnalysisHost propagates cancel to worker', () => {
    expect(host).toMatch(/type:\s*['"]cancel['"]/);
    expect(host).toMatch(/signal/);
    expect(host).toMatch(/cancelActive/);
  });

  test('workers handle cancel messages', () => {
    expect(mlWorker).toMatch(/msg\.type === ['"]cancel['"]/);
    expect(faWorker).toMatch(/msg\.type === ['"]cancel['"]/);
  });

  test('PromptedIsolation passes signal into provider isolate', () => {
    expect(prompt).toMatch(/signal:\s*opts\.signal/);
    expect(prompt).toMatch(/throwIfAborted/);
  });

  test('selectProvider caches capability probes', () => {
    expect(selectProv).toMatch(/CAPS_TTL_MS|cachedCaps/);
  });

  test('overlay exposes Cancel and wires JobController', () => {
    expect(overlay).toMatch(/procCancelBtn|requestCancel/);
    expect(overlay).toMatch(/__VIP_JOBS__/);
    expect(overlay).toMatch(/beginJob|cancelCurrent/);
    expect(indexHtml).toMatch(/procCancelBtn/);
    expect(indexHtml).toMatch(/JobController\.js/);
  });
});

/**
 * Playback worklet loading hardening (gate + de-esser).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mixer = fs.readFileSync(path.join(ROOT, 'src/pipeline/PlaybackMixer.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const landing = fs.readFileSync(path.join(ROOT, 'public/landing.js'), 'utf8');
const gate = fs.readFileSync(path.join(ROOT, 'src/workers/GateProcessor.js'), 'utf8');
const deess = fs.readFileSync(path.join(ROOT, 'src/workers/DeEsserProcessor.js'), 'utf8');

describe('Worklet module registration', () => {
  test('gate registers vip-gate', () => {
    expect(gate).toContain("registerProcessor('vip-gate'");
  });

  test('de-esser registers vip-deesser', () => {
    expect(deess).toContain("registerProcessor('vip-deesser'");
  });
});

describe('PlaybackMixer load path', () => {
  test('exports ensureWorkletModule and resolveWorkletUrl', () => {
    expect(mixer).toContain('export async function ensureWorkletModule');
    expect(mixer).toContain('export function resolveWorkletUrl');
  });

  test('resumes suspended AudioContext before/around addModule', () => {
    expect(mixer).toMatch(/state === 'suspended'[\s\S]*resume/);
  });

  test('literal addModule paths remain for allowlist', () => {
    expect(mixer).toContain("addModule('/src/workers/GateProcessor.js')");
    expect(mixer).toContain("addModule('/src/workers/DeEsserProcessor.js')");
  });

  test('graph reconnects on load failure', () => {
    expect(mixer).toContain('gateInput.connect(this.highpass)');
    expect(mixer).toContain('deEsserInput.connect(this.limiter)');
  });
});

describe('Server worklet delivery', () => {
  test('serves /src workers with JS content-type', () => {
    expect(server).toContain("Content-Type', 'application/javascript");
    expect(server).toContain("app.use('/src'");
  });
});

describe('Landing worklet boot', () => {
  test('awaits workletsReady after PlaybackMixer create', () => {
    expect(landing).toContain('workletsReady');
    expect(landing).toContain('getWorkletStatus');
  });
});
